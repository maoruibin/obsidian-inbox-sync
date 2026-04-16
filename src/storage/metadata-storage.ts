import { App } from "obsidian";
import { InboxSyncSettings } from "../types/settings";
import { SyncMetadata } from "../types/inbox";

/**
 * 同步元数据存储
 */
export class MetadataStorage {
  private app: App;
  private settings: InboxSyncSettings;
  private metadataFilePath: string;

  constructor(app: App, settings: InboxSyncSettings) {
    this.app = app;
    this.settings = settings;
    this.metadataFilePath = this.getMetadataFilePath();
  }

  /**
   * 获取元数据文件路径
   */
  private getMetadataFilePath(): string {
    const basePath = this.settings.vaultFolderPath.replace(/^\/+|\/+$/g, "");
    return `${basePath}/.inbox-sync-meta.json`;
  }

  /**
   * 加载同步元数据（自动迁移旧格式）
   */
  async load(): Promise<SyncMetadata> {
    const vault = this.app.vault;
    const normalized = this.metadataFilePath.replace(/^\/+/, "");

    try {
      // 直接用 adapter 读取，不依赖 Obsidian 文件缓存
      // （点文件 .xxx 可能不在 Obsidian 索引中）
      const content = await vault.adapter.read(normalized);
      const data = JSON.parse(content);

      // 迁移旧格式：lastSyncEtags → lastSyncMeta
      if (data.lastSyncEtags && !data.lastSyncMeta) {
        data.lastSyncMeta = {};
        for (const [noteId, timestamp] of Object.entries(data.lastSyncEtags as Record<string, string>)) {
          data.lastSyncMeta[noteId] = {
            etag: "",
            mtime: Number(timestamp) || 0,
          };
        }
        delete data.lastSyncEtags;
        console.debug("[MetadataStorage] 迁移旧格式元数据完成");
      }

      // 验证格式
      if (this.isValidMetadata(data)) {
        return data;
      }
    } catch (error) {
      console.warn("Failed to load sync metadata, creating new:", error);
    }

    return this.createDefaultMetadata();
  }

  /**
   * 保存同步元数据
   */
  async save(metadata: SyncMetadata): Promise<void> {
    const vault = this.app.vault;
    const normalized = this.metadataFilePath.replace(/^\/+/, "");

    // 确保目录存在（用 adapter 直接检查，避免 Obsidian 缓存问题）
    const dirPath = normalized.substring(0, normalized.lastIndexOf("/"));
    if (dirPath) {
      try {
        await vault.adapter.mkdir(dirPath);
      } catch {
        // 目录已存在，忽略错误
      }
    }

    // 写入文件
    const content = JSON.stringify(metadata, null, 2);
    await vault.adapter.write(normalized, content);
  }

  /**
   * 创建默认元数据
   */
  private createDefaultMetadata(): SyncMetadata {
    return {
      lastSyncTime: 0,
      lastSyncMeta: {},
      version: "2.0.0",
    };
  }

  /**
   * 验证元数据格式
   */
  private isValidMetadata(data: unknown): data is SyncMetadata {
    if (!data || typeof data !== "object") return false;

    const metadata = data as Record<string, unknown>;

    return (
      typeof metadata.lastSyncTime === "number" &&
      typeof metadata.lastSyncMeta === "object" &&
      typeof metadata.version === "string"
    );
  }

  /**
   * 清空元数据（用于重置同步）
   */
  async clear(): Promise<void> {
    await this.save(this.createDefaultMetadata());
  }
}
