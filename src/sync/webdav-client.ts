import { createClient, WebDAVClient as WebDAV, WebDAVClientOptions } from "webdav";
import { CloudClient, CloudFileInfo } from "./cloud-client";
import { AtomicNote, SyncManifest } from "../types/inbox";

/**
 * WebDAV 客户端实现
 */
export class WebDAVClient implements CloudClient {
  private client: WebDAV;
  private rootPath: string;

  constructor(
    url: string,
    username: string,
    password: string,
    basePath: string
  ) {
    const options: WebDAVClientOptions = {
      username,
      password,
    };
    this.client = createClient(url.replace(/\/$/, ""), options);
    // 支持旧的和新的配置方式：basePath 可能是 "inBox" 或 "inBox/batch-backup"
    this.rootPath = basePath.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  /**
   * 获取根路径前缀
   */
  getRootPath(): string {
    return this.rootPath;
  }

  /**
   * 获取完整的云端路径
   */
  private getFullPath(path: string): string {
    const cleanPath = path.replace(/^\/+/, "").replace(/\/+$/, "");
    return this.rootPath ? `${this.rootPath}/${cleanPath}` : cleanPath;
  }

  /**
   * 测试连接
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      // 尝试获取根目录属性
      await this.client.getDirectoryContents(this.rootPath || "/");
      return { success: true };
    } catch (error) {
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
    const manifestPath = this.getFullPath("batch-backup/SYNC_MANIFEST.json");

    try {
      const content = await this.client.getFileContents(manifestPath, {
        format: "text",
      });
      return JSON.parse(content as string) as SyncManifest;
    } catch (error) {
      console.warn("[WebDAV] SYNC_MANIFEST.json 不存在:", error);
      return null;
    }
  }

  /**
   * 下载 ZIP 批量包
   */
  async downloadZipBatch(fileName: string): Promise<ArrayBuffer | null> {
    const zipPath = this.getFullPath(`batch-backup/${fileName}`);

    try {
      const buffer = await this.client.getFileContents(zipPath, {
        format: "binary",
      });

      if (buffer instanceof ArrayBuffer) {
        return buffer;
      } else if (Buffer.isBuffer(buffer)) {
        const arrayBuffer = new ArrayBuffer(buffer.length);
        const view = new Uint8Array(arrayBuffer);
        view.set(buffer);
        return arrayBuffer;
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
    const fullPath = path.startsWith("/")
      ? path
      : this.getFullPath(path);

    try {
      const content = await this.client.getFileContents(fullPath, {
        format: "text",
      });
      const data = JSON.parse(content as string);

      // 解析可能的包装格式
      if (data.data && typeof data.data === "object") {
        return data.data as AtomicNote;
      }

      return data as AtomicNote;
    } catch (error) {
      console.error(`[WebDAV] 下载原子笔记失败: ${fullPath}`, error);
      return null;
    }
  }

  /**
   * 列出所有笔记文件（用于没有 manifest 时的降级）
   */
  async listNotes(): Promise<CloudFileInfo[]> {
    const notesPath = this.getFullPath("batch-backup/notes/");
    const files: CloudFileInfo[] = [];

    try {
      const contents = await this.client.getDirectoryContents(notesPath, {
        deep: false,
      });

      for (const item of contents as Array<{
        filename: string;
        basename: string;
        etag?: string;
        lastmod?: string;
      }>) {
        // 只处理 JSON 笔记文件
        if (!item.basename.endsWith(".json")) continue;

        // 从文件名提取 noteId
        const noteId = item.basename.replace(".json", "");

        files.push({
          id: noteId,
          etag: item.etag,
          path: item.filename,
        });
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
    const fullPath = this.getFullPath(remotePath);

    try {
      const buffer = await this.client.getFileContents(fullPath, {
        format: "binary",
      });

      if (buffer instanceof ArrayBuffer) {
        return buffer;
      } else if (Buffer.isBuffer(buffer)) {
        const arrayBuffer = new ArrayBuffer(buffer.length);
        const view = new Uint8Array(arrayBuffer);
        view.set(buffer);
        return arrayBuffer;
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
