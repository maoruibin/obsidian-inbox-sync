/**
 * inBox 笔记数据结构定义
 * 兼容 Android/PC 的原子笔记格式 (camelCase + snake_case)
 */

/**
 * 单个资源（图片/录音/附件）
 * 兼容 Android 原子笔记格式（camelCase + snake_case）
 */
export interface XResourceInfo {
  src?: string;               // 本地路径或网络URL
  remoteUrl?: string;         // 云端URL（camelCase）
  cloudUrl?: string;          // 云端URL（Android atomicNote 格式）
  path?: string;              // 本地相对路径（Android atomicNote 格式）
  mimeType?: string;          // 类型（camelCase）
  mime_type?: string;         // 类型（snake_case，Android）
  location?: number;          // 存储位置标识
  width?: number;             // 图片宽度
  height?: number;            // 图片高度
  size?: number;              // 文件大小
  length?: number;            // 文件大小（Android字段名）
  duration?: number;          // 音视频时长（毫秒）
  resourceType?: string;      // 资源类型: image, video, attach
  type?: string;              // 资源类型（Android atomicNote 格式）
  storageType?: string;       // 存储类型: webdav, s3
  id?: string;                // 资源ID（Android）
}

/**
 * 笔记额外信息（录音等）
 */
export interface BlockExtra {
  voice?: VoiceInfo;        // 录音信息
  [key: string]: unknown;
}

/**
 * 录音信息
 */
export interface VoiceInfo {
  path: string;             // 本地路径
  remoteUrl?: string;       // 云端URL
  duration: number;         // 时长（毫秒）
  size?: number;            // 文件大小
}

/**
 * 原子笔记元数据（兼容 camelCase 和 snake_case）
 * Android 实际使用 snake_case
 */
export interface AtomicNoteMeta {
  createdAt?: string;       // camelCase (Web/PC)
  created_at?: string;      // snake_case (Android)
  updatedAt?: string;       // camelCase
  updated_at?: string;      // snake_case (Android)
  deviceId?: string;        // camelCase
  device_id?: string;       // snake_case
}

/**
 * 原子笔记标记（兼容 camelCase 和 snake_case）
 */
export interface AtomicNoteFlags {
  isRemoved?: boolean;      // camelCase
  is_removed?: boolean;     // snake_case (Android)
  isTop?: boolean;          // camelCase
  is_top?: boolean;         // snake_case
  favorite?: boolean;
}

/**
 * 笔记间链接（云端格式）
 */
export interface NoteLink {
  targetId: string;  // "note-xxx" 或 "Card123"
  text?: string;     // 显示文本
}

/**
 * 原子笔记内容
 */
export interface AtomicNoteContent {
  title: string;
  content: string;
  assets?: XResourceInfo[];
  links?: NoteLink[];
}

/**
 * 原子笔记格式（Android/PC 云端存储格式）
 */
export interface AtomicNote {
  id: string;               // noteId, 格式: "note-{20位短ID}"
  ver?: number;
  content: AtomicNoteContent;
  meta: AtomicNoteMeta;
  flags: AtomicNoteFlags;
  parentId: string | null;
  parent_id?: string;       // Android snake_case
  imageJson: string;
  extra: string;
  blockId: number;
}

/**
 * SYNC_MANIFEST.json 结构 - 云端同步索引
 */
export interface SyncManifest {
  version: string;
  format: string;           // "inbox-batch-backup"
  deviceId: string;
  deviceName: string;
  createdAt: string;
  /** ZIP 批量包列表（Android/PC 生成的） */
  batches: BatchInfo[];
  /** 单独的原子笔记文件路径列表 */
  atomicNotes: string[];
}

/** ZIP 批量包信息 */
export interface BatchInfo {
  batchIndex: number;
  fileName: string;         // "backup-batch-001.zip"
  noteCount: number;
  startNote: number;
  endNote: number;
  status: 'pending' | 'uploaded' | 'processed';
  uploadedAt: string | null;
  size: number;
}

/**
 * 解析后的笔记数据（内部使用）
 */
export interface ParsedNote {
  blockId: number;
  noteId: string;
  title: string;
  content: string;
  tags: string[];
  images: ParsedAsset[];
  videos: ParsedAsset[];
  audios: ParsedAsset[];
  attachments: ParsedAsset[];
  createdAt: Date;
  updatedAt: Date;
  published: number;        // 毫秒时间戳（兼容旧字段）
  isRemoved: boolean;       // 是否已删除
  parentId?: string;        // 父笔记 noteId（批注笔记）
}

/**
 * 解析后的资源
 */
export interface ParsedAsset {
  remoteUrl: string;
  remotePath: string;
  localPath: string;
  mimeType: string;
  type: ResourceType;
  width?: number;
  height?: number;
  size?: number;
  duration?: number;
}

/**
 * 云端笔记条目（用于列表展示）
 */
export interface CloudNoteEntry {
  id: string;               // noteId
  etag?: string;
  mtime?: number;           // 毫秒时间戳
  size?: number;
  title?: string;
}

/**
 * 单条笔记的同步元数据
 */
export interface NoteSyncMeta {
  etag: string;             // S3 ETag
  mtime: number;            // 云端最后修改时间（毫秒）
}

/**
 * 同步元数据（本地存储）
 */
export interface SyncMetadata {
  lastSyncTime: number;     // 最后同步时间（毫秒）
  lastSyncMeta: Record<string, NoteSyncMeta>;  // noteId -> {etag, mtime}
  version: string;          // 元数据格式版本
}

/**
 * 同步统计
 */
export interface SyncStats {
  totalNotes: number;
  newNotes: number;
  updatedNotes: number;
  skippedNotes: number;
  deletedNotes: number;     // 删除的笔记数
  failedNotes: number;
  totalAssets: number;
  downloadedAssets: number;
  skippedAssets: number;
  failedAssets: number;
  startTime: number;
  endTime: number;
  errors: string[];
}

/**
 * 资源类型
 */
export enum ResourceType {
  IMAGE = "image",
  VIDEO = "video",
  AUDIO = "audio",
  ATTACHMENT = "attachment",
}

/**
 * 获取资源类型
 */
/**
 * 获取资源类型（兼容 mimeType 和 mime_type）
 */
export function getResourceType(mimeType: string | undefined, resourceType?: string): ResourceType {
  // 优先用 mimeType，兼容 snake_case
  const mime = mimeType;
  if (!mime) {
    // 从 type 字段推断
    if (resourceType === "image") return ResourceType.IMAGE;
    if (resourceType === "video") return ResourceType.VIDEO;
    if (resourceType === "audio") return ResourceType.AUDIO;
    return ResourceType.ATTACHMENT;
  }
  if (mimeType.startsWith("image/")) return ResourceType.IMAGE;
  if (mimeType.startsWith("video/")) return ResourceType.VIDEO;
  if (mimeType.startsWith("audio/")) return ResourceType.AUDIO;
  return ResourceType.ATTACHMENT;
}

/**
 * 日期工具函数
 */
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatMonth(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString();
}

/**
 * 从原子笔记元数据获取创建时间（兼容 camelCase/snake_case）
 */
export function getCreatedAt(meta: AtomicNoteMeta): number {
  const timeStr = meta.createdAt || meta.created_at || '';
  if (!timeStr) return Date.now();
  return new Date(timeStr).getTime();
}

/**
 * 从原子笔记元数据获取更新时间（兼容 camelCase/snake_case）
 */
export function getUpdatedAt(meta: AtomicNoteMeta): number {
  const timeStr = meta.updatedAt || meta.updated_at || '';
  if (!timeStr) return Date.now();
  return new Date(timeStr).getTime();
}

/**
 * 从原子笔记标记获取删除标记（兼容 camelCase/snake_case）
 */
export function getIsRemoved(flags: AtomicNoteFlags): boolean {
  return flags.isRemoved ?? flags.is_removed ?? false;
}

/**
 * 从原子笔记获取父ID（兼容 camelCase/snake_case）
 */
export function getParentId(note: AtomicNote): string | null {
  return note.parentId || note.parent_id || null;
}
