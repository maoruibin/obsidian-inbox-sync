import { CloudClient, CloudFileInfo } from "./cloud-client";
import { AtomicNote, SyncManifest } from "../types/inbox";
import { App, requestUrl } from "obsidian";

/**
 * WebDAV 客户端实现（使用 Obsidian requestUrl API，绕过 CORS）
 */
export class WebDAVNativeClient implements CloudClient {
  private app: App;
  private url: string;
  private username: string;
  private password: string;
  private rootPath: string;

  constructor(
    app: App,
    url: string,
    username: string,
    password: string,
    basePath: string
  ) {
    this.app = app;
    this.url = url.replace(/\/$/, "");
    this.username = username;
    this.password = password;
    this.rootPath = basePath.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  /**
   * 获取根路径前缀
   */
  getRootPath(): string {
    return this.rootPath;
  }

  /**
   * 获取完整的 URL
   * path 是相对于 rootPath 的子路径，rootPath 只加一次
   */
  private getFullUrl(path: string): string {
    const cleanPath = path.replace(/^\/+/, "");
    if (this.rootPath && cleanPath) {
      return `${this.url}/${this.rootPath}/${cleanPath}`;
    } else if (this.rootPath) {
      return `${this.url}/${this.rootPath}`;
    } else {
      return `${this.url}/${cleanPath}`;
    }
  }

  /**
   * 发送 WebDAV 请求
   */
  private async webdavRequest(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: string
  ): Promise<{ status: number; headers: Record<string, string>; text: string }> {
    const url = this.getFullUrl(path);

    // WebDAV 认证头
    const auth = btoa(`${this.username}:${this.password}`);

    console.log(`[WebDAV] ${method} ${url}`);
    console.log(`[WebDAV] 认证信息: username=${this.username}, auth=${auth.substring(0, 10)}...`);
    console.log(`[WebDAV] 完整参数: url=${this.url}, rootPath=${this.rootPath}, path=${path}`);

    const response = await requestUrl({
      url,
      method,
      headers: {
        ...headers,
        Authorization: `Basic ${auth}`,
      },
      body,
      throw: false, // 不自动抛异常，我们自己处理状态码
    });

    console.log(`[WebDAV] 响应: ${response.status}`);

    return {
      status: response.status,
      headers: response.headers,
      text: response.text,
    };
  }

  /**
   * 测试连接
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      console.log("[WebDAV] 测试连接...");
      console.log("[WebDAV] URL:", this.url);
      console.log("[WebDAV] RootPath:", this.rootPath);

      // 测试根目录（传空路径，getFullUrl 会自动拼接 rootPath）
      const result = await this.webdavRequest("PROPFIND", "", {
        Depth: "0",
      });

      if (result.status === 207 || result.status === 200) {
        console.log("[WebDAV] ✅ 连接成功");
        return { success: true };
      }

      // 404 可能是目录不存在，尝试根路径
      if (result.status === 404) {
        console.log("[WebDAV] 根目录不存在，尝试上级路径...");
        const rootResult = await this.webdavRequest("PROPFIND", "/", {
          Depth: "0",
        });
        if (rootResult.status === 207 || rootResult.status === 200) {
          return { success: false, error: `路径 "${this.rootPath}" 不存在，请检查 inBox path 设置` };
        }
      }

      return {
        success: false,
        error: `HTTP ${result.status}`,
      };
    } catch (error) {
      console.error("[WebDAV] ❌ 连接失败:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 下载 SYNC_MANIFEST.json
   */
  async downloadManifest(): Promise<SyncManifest | null> {
    try {
      const result = await this.webdavRequest("GET", "batch-backup/SYNC_MANIFEST.json");

      if (result.status === 200) {
        return JSON.parse(result.text) as SyncManifest;
      }

      console.warn("[WebDAV] SYNC_MANIFEST.json 不存在:", result.status);
      return null;
    } catch (error) {
      console.warn("[WebDAV] SYNC_MANIFEST.json 下载失败:", error);
      return null;
    }
  }

  /**
   * 下载 ZIP 批量包
   */
  async downloadZipBatch(fileName: string): Promise<ArrayBuffer | null> {
    try {
      const response = await requestUrl({
        url: this.getFullUrl(`batch-backup/${fileName}`),
        method: "GET",
        headers: {
          Authorization: `Basic ${btoa(`${this.username}:${this.password}`)}`,
        },
      });

      if (response.status === 200 && response.arrayBuffer) {
        return response.arrayBuffer;
      }

      // 如果没有 arrayBuffer，尝试从 text 转换
      if (response.status === 200 && response.text) {
        const binaryString = atob(response.text);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
      }

      return null;
    } catch (error) {
      console.error(`[WebDAV] 下载 ZIP 失败: ${fileName}`, error);
      return null;
    }
  }

  /**
   * 下载单个原子笔记
   */
  async downloadAtomicNote(path: string): Promise<AtomicNote | null> {
    // path 可能是完整路径（含 rootPath）或相对路径
    let relativePath: string;
    if (path.startsWith(this.rootPath + "/")) {
      relativePath = path.slice(this.rootPath.length + 1);
    } else if (path.startsWith("/")) {
      relativePath = path.slice(1);
    } else {
      relativePath = path;
    }

    try {
      const result = await this.webdavRequest("GET", relativePath);

      if (result.status === 200) {
        const data = JSON.parse(result.text);

        // 解析可能的包装格式
        if (data.data && typeof data.data === "object") {
          return data.data as AtomicNote;
        }

        return data as AtomicNote;
      }

      return null;
    } catch (error) {
      console.error(`[WebDAV] 下载原子笔记失败: ${relativePath}`, error);
      return null;
    }
  }

  /**
   * 列出所有笔记文件（用于没有 manifest 时的降级）
   */
  async listNotes(): Promise<CloudFileInfo[]> {
    // Android 原子笔记在 notes/ 目录下
    const files: CloudFileInfo[] = [];

    try {
      const result = await this.webdavRequest("PROPFIND", "notes/", {
        Depth: "1",
      });

      if (result.status === 207) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(result.text, "text/xml");
        const responses = xmlDoc.getElementsByTagNameNS("*", "response");

        for (let i = 1; i < responses.length; i++) {
          const response = responses[i];
          const href = response.getElementsByTagNameNS("*", "href")[0]?.textContent;
          const propStats = response.getElementsByTagNameNS("*", "propstat");

          if (href && propStats.length > 0) {
            const props = propStats[0].getElementsByTagNameNS("*", "prop")[0];
            const etag = props?.getElementsByTagNameNS("*", "getetag")[0]?.textContent;
            const lastmod = props?.getElementsByTagNameNS("*", "getlastmodified")[0]?.textContent;

            const filename = decodeURIComponent(href.split("/").filter(Boolean).pop() || "");

            if (!filename.endsWith(".json")) continue;

            const noteId = filename.replace(".json", "");

            files.push({
              id: noteId,
              etag: etag || undefined,
              path: `notes/${filename}`,
            });
          }
        }
      }
    } catch (error) {
      console.warn("[WebDAV] listNotes error:", error);
    }

    return files;
  }

  /**
   * 下载资源文件
   */
  async downloadAsset(remotePath: string): Promise<ArrayBuffer | null> {
    // remotePath 可能是完整 URL（cloudUrl）或相对路径
    const url = remotePath.startsWith("http") ? remotePath : this.getFullUrl(remotePath);
    const auth = `Basic ${btoa(`${this.username}:${this.password}`)}`;

    try {
      console.log(`[WebDAV] downloadAsset: ${url.substring(0, 80)}...`);
      const response = await requestUrl({
        url,
        method: "GET",
        headers: {
          Authorization: auth,
        },
        throw: false,
      });

      console.log(`[WebDAV] downloadAsset 响应: status=${response.status}, hasBuffer=${!!response.arrayBuffer}`);

      if (response.status === 200 && response.arrayBuffer) {
        return response.arrayBuffer;
      }

      // 如果没有 arrayBuffer，尝试从 text 转换（base64 编码的图片）
      if (response.status === 200 && response.text) {
        const binaryString = atob(response.text);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
      }

      return null;
    } catch (error) {
      console.error(`[WebDAV] 下载资源失败: ${remotePath}`, error);
      return null;
    }
  }

  /**
   * 检查资源文件是否存在（本地）
   * 由 AssetHandler 使用 Obsidian API 实现
   */
  async assetExistsLocally(_localPath: string): Promise<boolean> {
    return false;
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
