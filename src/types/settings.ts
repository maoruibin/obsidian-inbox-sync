/**
 * 插件设置类型定义
 */

export interface InboxSyncSettings {
  // 云存储配置
  storageType: "webdav" | "s3";

  // WebDAV 配置
  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;

  // S3 配置
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Bucket: string;
  s3Region: string;

  // 同步设置
  syncInterval: number;         // 自动同步间隔（分钟），0 表示禁用
  enableAutoSync: boolean;      // 是否启用自动同步
  vaultFolderPath: string;      // Obsidian Vault 中的目标文件夹

  // 高级选项
  enableFrontmatterTags: boolean;  // 是否在 frontmatter 中添加标签
  preserveContentTags: boolean;    // 是否保留内容中的 #tag
  conflictResolution: "skip" | "overwrite" | "rename";  // 冲突处理策略

  // 开发者选项（不在 UI 显示）
  debugRootPath: string;        // 空=生产模式用"inBox"，否则用指定值如"inBoxDebug"
}

export const DEFAULT_SETTINGS: InboxSyncSettings = {
  storageType: "webdav",

  // WebDAV 默认值
  webdavUrl: "",
  webdavUsername: "",
  webdavPassword: "",

  // S3 默认值
  s3Endpoint: "",
  s3AccessKey: "",
  s3SecretKey: "",
  s3Bucket: "",
  s3Region: "us-east-1",

  // 同步设置默认值
  syncInterval: 30,
  enableAutoSync: false,
  vaultFolderPath: "inBox",

  // 高级选项默认值
  enableFrontmatterTags: true,
  preserveContentTags: true,
  conflictResolution: "skip",

  // 开发者选项（不在 UI 显示，开发时手动在 data.json 中修改）
  debugRootPath: "",
};

/**
 * 获取实际的云端根路径
 * 生产模式: "inBox"
 * 开发模式: 由 debugRootPath 指定 (如 "inBoxDebug")
 */
export function getCloudRootPath(settings: InboxSyncSettings): string {
  return settings.debugRootPath || "inBox";
}
