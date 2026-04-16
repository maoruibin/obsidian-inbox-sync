/**
 * Obsidian Request Handler for AWS SDK v3
 *
 * 基于 remotely-save 插件的 ObsHttpHandler 实现
 * https://github.com/remotely-save/remotely-save/blob/main/src/fsS3.ts
 *
 * 关键：继承 FetchHttpHandler，确保与 AWS SDK v3 内部接口兼容
 * 只替换最终的 HTTP 传输层：fetch → Obsidian requestUrl
 */

import { requestUrl } from "obsidian";
import type { HttpHandlerOptions } from "@aws-sdk/types";
import {
	FetchHttpHandler,
	type FetchHttpHandlerOptions,
} from "@smithy/fetch-http-handler";
import { type HttpRequest, HttpResponse } from "@smithy/protocol-http";
import { buildQueryString } from "@smithy/querystring-builder";

/**
 * 请求超时 Promise
 * 参考 @smithy/fetch-http-handler 的 requestTimeout 实现
 */
function requestTimeout(timeoutInMs: number | undefined): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (timeoutInMs) {
			setTimeout(() => {
				const timeoutError = new Error(
					`Request did not complete within ${timeoutInMs} ms`
				);
				timeoutError.name = "TimeoutError";
				reject(timeoutError);
			}, timeoutInMs);
		}
	});
}

/**
 * 将 Buffer/Uint8Array 转换为 ArrayBuffer
 * Obsidian requestUrl 需要 ArrayBuffer 作为 body
 */
function bufferToArrayBuffer(b: Uint8Array | ArrayBufferView): ArrayBuffer {
	if (b instanceof Uint8Array) {
		// 优化：如果是完整的底层 buffer，直接使用
		if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength) {
			return b.buffer as ArrayBuffer;
		}
	}
	const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
	return buf as ArrayBuffer;
}

/**
 * Obsidian HTTP 请求处理器
 *
 * 继承 FetchHttpHandler，覆盖 handle() 方法，
 * 用 Obsidian 的 requestUrl 替换原生的 fetch 调用。
 * AWS SDK 处理所有签名（SigV4）、序列化和反序列化，
 * 我们只需要替换传输层来绕过 CORS 限制。
 */
export class ObsidianRequestHandler extends FetchHttpHandler {
	requestTimeoutInMs: number | undefined;

	constructor(options?: FetchHttpHandlerOptions) {
		super(options);
		this.requestTimeoutInMs =
			options === undefined ? undefined : options.requestTimeout;
	}

	async handle(
		request: HttpRequest,
		{ abortSignal }: HttpHandlerOptions = {}
	): Promise<{ response: HttpResponse }> {
		// 检查 abort signal
		if (abortSignal?.aborted) {
			const abortError = new Error("Request aborted");
			abortError.name = "AbortError";
			return Promise.reject(abortError);
		}

		// ---- 构建 URL（与 FetchHttpHandler 原始实现一致）----
		let path = request.path;
		if (request.query) {
			const queryString = buildQueryString(request.query);
			if (queryString) {
				path += `?${queryString}`;
			}
		}

		const { port, method } = request;
		const url = `${request.protocol}//${request.hostname}${
			port ? `:${port}` : ""
		}${path}`;

		// ---- 处理请求体 ----
		const body = method === "GET" || method === "HEAD" ? undefined : request.body;

		// ---- 转换请求头（跳过 host 和 content-length）----
		// Obsidian requestUrl 会自动设置这些
		const transformedHeaders: Record<string, string> = {};
		for (const key of Object.keys(request.headers)) {
			const keyLower = key.toLowerCase();
			if (keyLower === "host" || keyLower === "content-length") {
				continue;
			}
			transformedHeaders[keyLower] = request.headers[key];
		}

		// 提取 content-type（Obsidian requestUrl 需要 contentType 参数）
		let contentType: string | undefined = undefined;
		if (transformedHeaders["content-type"] !== undefined) {
			contentType = transformedHeaders["content-type"];
		}

		// ---- 转换请求体格式 ----
		let transformedBody: ArrayBuffer | string | undefined = body;
		if (ArrayBuffer.isView(body)) {
			transformedBody = bufferToArrayBuffer(body as Uint8Array);
		}

		// ---- 发送请求 ----
		const raceOfPromises = [
			requestUrl({
				url: url,
				method: method,
				headers: transformedHeaders,
				body: transformedBody,
				contentType: contentType,
			}).then((rsp) => {
				// ---- 转换响应头为小写 ----
				const headers = rsp.headers;
				const headersLower: Record<string, string> = {};
				for (const key of Object.keys(headers)) {
					headersLower[key.toLowerCase()] = headers[key];
				}

				// ---- 创建 ReadableStream 包装响应体 ----
				// AWS SDK v3 期望 body 是 ReadableStream
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(rsp.arrayBuffer));
						controller.close();
					},
				});

				return {
					response: new HttpResponse({
						headers: headersLower,
						statusCode: rsp.status,
						body: stream,
					}),
				};
			}),
			requestTimeout(this.requestTimeoutInMs),
		];

		if (abortSignal) {
			raceOfPromises.push(
				new Promise<never>((_resolve, reject) => {
					abortSignal.onabort = () => {
						const abortError = new Error("Request aborted");
						abortError.name = "AbortError";
						reject(abortError);
					};
				})
			);
		}

		return Promise.race(raceOfPromises);
	}
}

export default ObsidianRequestHandler;
