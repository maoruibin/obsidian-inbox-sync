import { CloudClient, CloudFileInfo } from "./cloud-client";
import { AtomicNote, SyncManifest } from "../types/inbox";
import { ObsidianRequestHandler } from "./obsidian-request-handler";
import type {
  S3Client as S3ClientType,
  ListObjectsV2Command as ListObjectsV2CommandCtor,
  GetObjectCommand as GetObjectCommandCtor,
  ListObjectsV2CommandInput,
  ListObjectsV2CommandOutput,
  GetObjectCommandInput,
  GetObjectCommandOutput,
  _Object as S3Object,
} from "@aws-sdk/client-s3";

// 动态导入 AWS SDK v3，避免 esbuild 打包问题
let S3ClientClass: typeof S3ClientType | undefined;
let ListObjectsV2Command: typeof ListObjectsV2CommandCtor | undefined;
let GetObjectCommand: typeof GetObjectCommandCtor | undefined;

interface AWSSDK {
  S3ClientClass: typeof S3ClientType;
  ListObjectsV2Command: typeof ListObjectsV2CommandCtor;
  GetObjectCommand: typeof GetObjectCommandCtor;
}

async function getAWSSDK(): Promise<AWSSDK> {
  if (!S3ClientClass || !ListObjectsV2Command || !GetObjectCommand) {
    const sdk = await import("@aws-sdk/client-s3");
    S3ClientClass = sdk.S3Client;
    ListObjectsV2Command = sdk.ListObjectsV2Command;
    GetObjectCommand = sdk.GetObjectCommand;
  }
  return { S3ClientClass, ListObjectsV2Command, GetObjectCommand };
}

/**
 * S3 客户端实现 - 使用 AWS SDK v3
 */
export class S3Client implements CloudClient {
  private client: InstanceType<typeof S3ClientType> | null = null;
  private bucket: string;
  private rootPath: string;
  private config: {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
  };

  constructor(
    endpoint: string,
    accessKey: string,
    secretKey: string,
    bucket: string,
    region: string,
    pathPrefix: string
  ) {
    // 处理 endpoint
    let cleanEndpoint = endpoint.trim();
    if (!/^https?:\/\//.test(cleanEndpoint)) {
      cleanEndpoint = `https://${cleanEndpoint}`;
    }

    // 自动去除 endpoint 中重复的 bucket 前缀
    // 如腾讯云文档要求 <BucketName>.cos.ap-beijing.myqcloud.com
    try {
      const uri = new URL(cleanEndpoint);
      if (uri.hostname.startsWith(`${bucket}.`)) {
        uri.hostname = uri.hostname.substring(bucket.length + 1);
        cleanEndpoint = uri.toString();
      }
    } catch { /* URL 解析失败则不处理 */ }

    this.config = {
      endpoint: cleanEndpoint,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      region: region || "us-east-1",
    };
    this.bucket = bucket;
    this.rootPath = pathPrefix.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  /**
   * 延迟初始化 S3 客户端
   */
  private async getClient(): Promise<InstanceType<typeof S3ClientType>> {
    if (!this.client) {
      const { S3ClientClass } = await getAWSSDK();

      // 使用 Obsidian requestUrl handler 绕过 CORS 限制
      const obsidianHandler = new ObsidianRequestHandler({
        requestTimeout: 30000,
      });

      this.client = new S3ClientClass({
        endpoint: this.config.endpoint,
        region: this.config.region,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        },
        // 使用虚拟主机风格 (bucket.endpoint)，Bitiful/S3 兼容
        // forcePathStyle: false (默认)
        requestHandler: obsidianHandler,
      });

      // 添加 cache-control 中间件（参考 remotely-save）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.client.middlewareStack.add(
        (next: any) => (args: any) => {
          args.request.headers["cache-control"] = "no-cache";
          return next(args);
        },
        { step: "build" }
      );
    }
    return this.client;
  }

  /**
   * 获取根路径前缀
   */
  getRootPath(): string {
    return this.rootPath;
  }

  /**
   * 获取完整的对象 Key
   */
  private getObjectKey(key: string): string {
    const cleanKey = key.replace(/^\/+/, "");
    return this.rootPath ? `${this.rootPath}/${cleanKey}` : cleanKey;
  }

  /**
   * 测试连接
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      console.debug("[S3] 开始测试连接...");
      console.debug("[S3] Endpoint:", this.config.endpoint);
      console.debug("[S3] Region:", this.config.region);
      console.debug("[S3] Bucket:", this.bucket);
      console.debug("[S3] RootPath:", this.rootPath);
      console.debug("[S3] AccessKey (前4位):", this.config.accessKeyId.substring(0, 4) + "****");

      const client = await this.getClient();
      const { ListObjectsV2Command } = await getAWSSDK();

      console.debug("[S3] S3Client 已创建，开始发送 ListObjectsV2 请求...");

      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.rootPath ? `${this.rootPath}/` : "",
        MaxKeys: 1,
      });

      console.debug("[S3] 请求参数:", {
        Bucket: this.bucket,
        Prefix: this.rootPath ? `${this.rootPath}/` : "",
        MaxKeys: 1,
      });

      const result = await client.send(command);

      console.debug("[S3] ✅ 连接成功!");
      console.debug("[S3] 响应:", result);

      return { success: true };
    } catch (error: unknown) {
      const err = error as Error & { name?: string; details?: string; $metadata?: unknown };
      console.error("[S3] ❌ 测试连接失败!");
      console.error("[S3] 错误类型:", err.constructor.name);
      console.error("[S3] 错误名称:", err.name);
      console.error("[S3] 错误消息:", err.message);
      console.error("[S3] 错误详情:", err.details || err.$metadata || "无");
      console.error("[S3] 完整错误:", err);

      // 提取更友好的错误信息
      let friendlyError = err.message || String(err);

      if (err.name === "NetworkFailure") {
        friendlyError = "网络连接失败 - 可能原因:\n1. Endpoint 地址错误\n2. 网络不可达\n3. SSL 证书问题\n4. CORS 限制(如果是浏览器环境)";
      } else if (err.name === "NoSuchBucket") {
        friendlyError = `Bucket "${this.bucket}" 不存在或无权访问`;
      } else if (err.name === "InvalidAccessKeyId") {
        friendlyError = "Access Key ID 无效";
      } else if (err.name === "SignatureDoesNotMatch") {
        friendlyError = "Secret Key 错误";
      } else if (err.name === "AccessDenied") {
        friendlyError = "访问被拒绝 - 请检查权限配置";
      }

      return {
        success: false,
        error: friendlyError,
      };
    }
  }

  /**
   * 下载 SYNC_MANIFEST.json
   */
  async downloadManifest(): Promise<SyncManifest | null> {
    const manifestKey = this.getObjectKey("batch-backup/SYNC_MANIFEST.json");

    try {
      const client = await this.getClient();
      const { GetObjectCommand } = await getAWSSDK();

      const response = await client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: manifestKey,
        })
      );

      // Body 是 ReadableStream，需要转换为字符串
      const bodyStr = typeof response.Body === "string"
        ? response.Body
        : await new Response(response.Body as ReadableStream).text();
      return JSON.parse(bodyStr) as SyncManifest;
    } catch (error) {
      console.warn("[S3] SYNC_MANIFEST.json 不存在:", error);
      return null;
    }
  }

  /**
   * 下载 ZIP 批量包
   */
  async downloadZipBatch(fileName: string): Promise<ArrayBuffer | null> {
    const zipKey = this.getObjectKey(`batch-backup/${fileName}`);

    try {
      const client = await this.getClient();
      const { GetObjectCommand } = await getAWSSDK();

      const response = await client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: zipKey,
        })
      );

      const bytes = await new Response(response.Body as ReadableStream).arrayBuffer();
      return bytes;
    } catch (error) {
      console.error(`[S3] 下载 ZIP 失败: ${fileName}`, error);
      return null;
    }
  }

  /**
   * 下载单个原子笔记
   */
  async downloadAtomicNote(path: string): Promise<AtomicNote | null> {
    // path 可能已经包含 rootPath 前缀（来自 listNotes 的 object.Key）
    // 也可能是相对路径（来自 manifest.atomicNotes）
    let objectKey: string;
    if (path.startsWith("/") ) {
      objectKey = path.slice(1);
    } else if (this.rootPath && path.startsWith(this.rootPath + "/")) {
      objectKey = path; // 已经是完整路径，直接用
    } else {
      objectKey = this.getObjectKey(path);
    }

    try {
      const client = await this.getClient();
      const { GetObjectCommand } = await getAWSSDK();

      const response = await client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
        })
      );

      // Body 是 ReadableStream，需要转换为字符串
      const content = await new Response(response.Body as ReadableStream).text();
      const data = JSON.parse(content);

      // 解析可能的包装格式
      if (data.data && typeof data.data === "object") {
        return data.data as AtomicNote;
      }

      return data as AtomicNote;
    } catch (error) {
      console.error(`[S3] 下载原子笔记失败: ${objectKey}`, error);
      return null;
    }
  }

  /**
   * 列出所有笔记文件（用于没有 manifest 时的降级）
   * Android 端存储路径: inBox/notes/note-xxx.json
   */
  async listNotes(): Promise<CloudFileInfo[]> {
    // Android 原子笔记在 notes/ 目录下，不是 batch-backup/notes/
    const notesPrefix = this.getObjectKey("notes/");
    const files: CloudFileInfo[] = [];

    try {
      const client = await this.getClient();
      const { ListObjectsV2Command } = await getAWSSDK();

      let continuationToken: string | undefined;

      do {
        console.debug(`[S3] listNotes 查询前缀: ${notesPrefix}`);
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: notesPrefix,
            ContinuationToken: continuationToken,
          })
        );

        console.debug(`[S3] listNotes 响应: IsTruncated=${response.IsTruncated}, KeyCount=${response.KeyCount}, Contents=${response.Contents?.length || 0}`);
        if (response.Contents) {
          // 打印前3个文件的 Key 帮助调试
          response.Contents.slice(0, 3).forEach((obj: S3Object) => {
            console.debug(`[S3] listNotes 文件: ${obj.Key} (${obj.Size} bytes)`);
          });
        }

        if (response.Contents) {
          for (const object of response.Contents) {
            if (!object.Key) continue;

            // 只处理 JSON 笔记文件
            if (!object.Key.endsWith(".json")) continue;

            // 从路径提取 noteId
            const fileName = object.Key.split("/").pop() || "";
            const noteId = fileName.replace(".json", "");

            files.push({
              id: noteId,
              etag: object.ETag?.replace(/"/g, "") || "",
              mtime: object.LastModified?.getTime() || 0,
              size: object.Size || 0,
              path: object.Key,
            });
          }
        }

        continuationToken = response.NextContinuationToken;
      } while (continuationToken);
    } catch (error) {
      console.warn("[S3] listNotes error:", error);
    }

    return files;
  }

  /**
   * 下载资源文件
   * remotePath 可能是：
   * - 完整 URL（cloudUrl）：直接从 URL pathname 提取 S3 key
   * - 相对路径：需要拼接 rootPath
   * - 已含 rootPath 的路径：直接使用
   */
  async downloadAsset(remotePath: string): Promise<ArrayBuffer | null> {
    let objectKey: string;

    if (remotePath.startsWith("http")) {
      // 完整 URL：从 pathname 提取 S3 key
      // path-style URL: s3.bitiful.net/gudong/inBox/... → pathname 包含 bucket 名，需要去掉
      try {
        const url = new URL(remotePath);
        let key = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        // path-style URL 的 pathname 以 bucket 名开头，需要剥离
        if (key.startsWith(this.bucket + "/")) {
          key = key.substring(this.bucket.length + 1);
        }
        objectKey = key;
      } catch {
        return null;
      }
    } else {
      // 相对路径：检查是否已含 rootPath
      const cleanPath = remotePath.replace(/^\/+/, "");
      if (this.rootPath && cleanPath.startsWith(this.rootPath + "/")) {
        objectKey = cleanPath;
      } else {
        objectKey = this.getObjectKey(remotePath);
      }
    }

    try {
      const client = await this.getClient();
      const { GetObjectCommand } = await getAWSSDK();

      const response = await client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
        })
      );

      const bytes = await new Response(response.Body as ReadableStream).arrayBuffer();
      return bytes;
    } catch (error) {
      console.error(`[S3] 下载资源失败: ${remotePath}`, error);
      return null;
    }
  }

  /**
   * 检查资源文件是否存在（本地）
   * 由 AssetHandler 使用 Obsidian API 实现
   */
  assetExistsLocally(_localPath: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * 保存资源文件到本地
   * 由 AssetHandler 使用 Obsidian API 实现
   */
  async saveAssetToLocal(
    _buffer: ArrayBuffer,
    _localPath: string
  ): Promise<void> {
    // 由 AssetHandler 实现
  }
}
