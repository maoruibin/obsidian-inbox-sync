import { App } from "obsidian";
import { InboxSyncSettings, getCloudRootPath } from "../types/settings";
import { CloudClient, CloudFileInfo } from "./cloud-client";
import { WebDAVNativeClient } from "./webdav-native";
import { S3Client } from "./s3-client";
import { NoteParser } from "./note-parser";
import { MarkdownWriter } from "./markdown-writer";
import { AssetHandler } from "./asset-handler";
import {
  SyncMetadata,
  SyncStats,
  AtomicNote,
  ParsedNote,
} from "../types/inbox";
import { MetadataStorage } from "../storage/metadata-storage";

/**
 * 同步管理器 - 协调整个同步流程
 * 增量同步策略（参考 Android ThinkPlus）：
 * 1. listNotes() 拿到所有云端文件元数据（ETag, MTime）← 快，无内容下载
 * 2. 对比本地 lastSyncMeta → ETag 相同则跳过
 * 3. 只下载变化的文件
 * 4. 检测云端删除（本地有但云端不存在）
 */
export class SyncManager {
  private app: App;
  private settings: InboxSyncSettings;
  private cloudClient: CloudClient;
  private noteParser: NoteParser;
  private markdownWriter: MarkdownWriter;
  private assetHandler: AssetHandler;
  private metadataStorage: MetadataStorage;
  private abortController: AbortController | null = null;

  constructor(app: App, settings: InboxSyncSettings) {
    this.app = app;
    this.settings = settings;
    this.initializeClients();
    this.noteParser = new NoteParser();
    this.markdownWriter = new MarkdownWriter(app, settings);
    this.assetHandler = new AssetHandler(app, settings, this.cloudClient);
    this.metadataStorage = new MetadataStorage(app, settings);
  }

  private initializeClients() {
    const rootPath = getCloudRootPath(this.settings);

    console.debug(`[SyncManager] initializeClients: storageType=${this.settings.storageType}, rootPath=${rootPath}`);
    console.debug(`[SyncManager] S3 config: endpoint=${this.settings.s3Endpoint}, bucket=${this.settings.s3Bucket}, region=${this.settings.s3Region}`);

    if (this.settings.storageType === "webdav") {
      this.cloudClient = new WebDAVNativeClient(
        this.app,
        this.settings.webdavUrl,
        this.settings.webdavUsername,
        this.settings.webdavPassword,
        rootPath
      );
    } else {
      this.cloudClient = new S3Client(
        this.settings.s3Endpoint,
        this.settings.s3AccessKey,
        this.settings.s3SecretKey,
        this.settings.s3Bucket,
        this.settings.s3Region,
        rootPath
      );
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    return this.cloudClient.testConnection();
  }

  updateSettings(settings: InboxSyncSettings) {
    this.settings = settings;
    this.initializeClients();
    this.markdownWriter = new MarkdownWriter(this.app, settings);
    this.assetHandler = new AssetHandler(this.app, settings, this.cloudClient);
    this.metadataStorage = new MetadataStorage(this.app, settings);
  }

  abort() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * 执行增量同步
   */
  async sync(notify?: (message: string) => void): Promise<SyncStats> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const stats: SyncStats = {
      totalNotes: 0,
      newNotes: 0,
      updatedNotes: 0,
      skippedNotes: 0,
      deletedNotes: 0,
      failedNotes: 0,
      totalAssets: 0,
      downloadedAssets: 0,
      skippedAssets: 0,
      failedAssets: 0,
      startTime: Date.now(),
      endTime: 0,
      errors: [],
    };

    try {
      notify?.("开始同步...");
      console.debug("[SyncManager] ===== 开始增量同步 =====");

      // 1. 读取本地同步元数据
      const syncMetadata = await this.metadataStorage.load();
      console.debug(`[SyncManager] 本地元数据加载完成, 已有 ${Object.keys(syncMetadata.lastSyncMeta).length} 条记录`);

      // 2. 列出云端所有文件元数据（快速，只拿 ETag/MTime，不下载内容）
      notify?.("扫描云端文件列表...");
      const cloudFiles = await this.cloudClient.listNotes();
      console.debug(`[SyncManager] 云端文件列表获取完成, 共 ${cloudFiles.length} 个文件`);

      // 3. 增量对比：找出变化的文件
      const { toDownload, toDelete, unchanged } = this.diffCloudAndLocal(cloudFiles, syncMetadata);
      console.debug(`[SyncManager] 增量对比: 需下载 ${toDownload.length}, 需删除 ${toDelete.length}, 未变化 ${unchanged}`);

      // 4. 处理云端删除的笔记
      if (toDelete.length > 0) {
        notify?.(`处理云端删除 (${toDelete.length} 条)...`);
        for (const noteId of toDelete) {
          if (signal.aborted) throw new Error("同步已取消");
          try {
            await this.markdownWriter.deleteNote(noteId);
            delete syncMetadata.lastSyncMeta[noteId];
            stats.deletedNotes++;
          } catch (error) {
            console.warn(`[SyncManager] 删除笔记失败: ${noteId}`, error);
          }
        }
      }

      // 5. 下载变化的文件
      stats.totalNotes = toDownload.length + unchanged;
      const allNotes = new Map<string, AtomicNote>();

      if (toDownload.length > 0) {
        notify?.(`下载变化的笔记 (${toDownload.length} 条)...`);
        await this.downloadChangedNotes(toDownload, allNotes, signal, notify);
      }

      console.debug(`[SyncManager] 云端笔记收集完成, 变化 ${allNotes.size} 条, 跳过 ${unchanged} 条`);

      // 6. 第一轮：解析 + 写入所有笔记（不含 parent 信息）
      let processedCount = 0;
      // 收集父子关系：parentId -> childFileNames[]
      const parentChildMap = new Map<string, string[]>();
      // 内存索引：noteId -> { fileName, parsedNote }
      const noteIdFileMap = new Map<string, { fileName: string; parsedNote: ParsedNote }>();
      // blockId → fileName 映射（给 Card 格式链接转换用）
      const blockIdFileMap = new Map<number, string>();

      for (const [noteId, atomicNote] of allNotes) {
        if (signal.aborted) throw new Error("同步已取消");

        try {
          notify?.(`处理笔记 ${++processedCount}/${allNotes.size}...`);

          const parsedNote = this.noteParser.parse(atomicNote);

          // 检查是否已标记删除
          if (parsedNote.isRemoved) {
            await this.markdownWriter.deleteNote(parsedNote.noteId);
            stats.deletedNotes++;
            delete syncMetadata.lastSyncMeta[noteId];
            continue;
          }

          // 写入 Markdown（第一阶段不带 parent）
          const result = await this.markdownWriter.writeNote(parsedNote);

          // 记录 noteId -> { fileName, parsedNote } 映射
          noteIdFileMap.set(parsedNote.noteId, { fileName: result.fileName, parsedNote });

          // 记录 blockId -> fileName 映射
          if (parsedNote.blockId) {
            blockIdFileMap.set(parsedNote.blockId, result.fileName);
          }

          // 记录父子关系
          if (parsedNote.parentId) {
            if (!parentChildMap.has(parsedNote.parentId)) {
              parentChildMap.set(parsedNote.parentId, []);
            }
            parentChildMap.get(parsedNote.parentId)!.push(result.fileName);
          }

          // 处理资源
          const assetStats = await this.assetHandler.handleAssets(parsedNote);

          if (result.isNew) {
            stats.newNotes++;
          } else {
            stats.updatedNotes++;
          }
          stats.totalAssets += assetStats.total;
          stats.downloadedAssets += assetStats.downloaded;
          stats.skippedAssets += assetStats.skipped;
          stats.failedAssets += assetStats.failed;
        } catch (error: unknown) {
          stats.failedNotes++;
          const errorMsg = `处理笔记 ${noteId} 失败: ${error instanceof Error ? error.message : String(error)}`;
          stats.errors.push(errorMsg);
          console.error(errorMsg);
        }
      }

      // 6.5 第二轮：补全子笔记的 parent frontmatter + 父笔记嵌入引用
      if (parentChildMap.size > 0) {
        console.debug(`[SyncManager] 更新父子关系: ${parentChildMap.size} 个父笔记`);
        for (const [parentId, childFileNames] of parentChildMap) {
          try {
            // 更新父笔记：追加子笔记嵌入
            await this.markdownWriter.updateParentEmbeds(parentId, childFileNames);

            // 更新子笔记：补上 parent frontmatter
            const parentInfo = noteIdFileMap.get(parentId);
            if (parentInfo) {
              for (const childFileName of childFileNames) {
                await this.markdownWriter.addChildParentRef(childFileName, parentInfo.fileName);
              }
            }
          } catch (error) {
            console.warn(`[SyncManager] 更新父子关系失败: ${parentId}`, error);
          }
        }
      }

      // 6.7 第三轮：转换笔记内容中的 [[note-xxx]] / [[Card123]] 链接
      const linkConvertNoteIdMap = new Map<string, string>();
      for (const [id, info] of noteIdFileMap) {
        linkConvertNoteIdMap.set(id, info.fileName);
      }
      let linkConvertCount = 0;
      for (const [noteId, info] of noteIdFileMap) {
        try {
          await this.markdownWriter.convertLinks(info.fileName, linkConvertNoteIdMap, blockIdFileMap);
          linkConvertCount++;
        } catch (error) {
          console.warn(`[SyncManager] 链接转换失败: ${noteId}`, error);
        }
      }
      if (linkConvertCount > 0) {
        console.debug(`[SyncManager] 链接转换完成: ${linkConvertCount} 个笔记`);
      }

      // 7. 更新元数据：写入所有云端文件的 ETag/MTime（包括跳过的）
      // 参考 Android DownloadService.updateRemoteMetadata() — 即使跳过也要更新元数据
      for (const file of cloudFiles) {
        syncMetadata.lastSyncMeta[file.id] = {
          etag: file.etag || "",
          mtime: file.mtime || 0,
        };
      }
      syncMetadata.lastSyncTime = Date.now();
      await this.metadataStorage.save(syncMetadata);

      const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
      const efficiency = cloudFiles.length > 0
        ? ((unchanged / cloudFiles.length) * 100).toFixed(1)
        : "0";
      notify?.(`同步完成！新增 ${stats.newNotes}, 更新 ${stats.updatedNotes}, 删除 ${stats.deletedNotes}, 跳过 ${unchanged} (${elapsed}s)`);
      console.debug(`[SyncManager] ===== 同步完成 (${elapsed}s) =====`);
      console.debug(`[SyncManager] 增量效率: 跳过 ${unchanged}/${cloudFiles.length} (${efficiency}%)`);
      console.debug(`[SyncManager] 新增: ${stats.newNotes}, 更新: ${stats.updatedNotes}, 删除: ${stats.deletedNotes}, 失败: ${stats.failedNotes}`);
    } catch (error: unknown) {
      if (signal.aborted) {
        notify?.("同步已取消");
        console.debug("[SyncManager] 同步已取消");
      } else {
        stats.errors.push(`同步错误: ${error instanceof Error ? error.message : String(error)}`);
        console.error("[SyncManager] 同步错误:", error);
      }
    }

    stats.endTime = Date.now();
    this.abortController = null;
    return stats;
  }

  /**
   * 增量对比：对比云端文件列表与本地元数据
   * 返回：需要下载的文件、需要删除的 noteId、未变化数量
   */
  private diffCloudAndLocal(
    cloudFiles: CloudFileInfo[],
    metadata: SyncMetadata
  ): { toDownload: CloudFileInfo[]; toDelete: string[]; unchanged: number } {
    const toDownload: CloudFileInfo[] = [];
    const _unchanged = 0;
    const cloudNoteIds = new Set<string>();

    for (const file of cloudFiles) {
      cloudNoteIds.add(file.id);
      const localMeta = metadata.lastSyncMeta[file.id];

      if (!localMeta) {
        // 本地无记录 → 新笔记，需要下载
        toDownload.push(file);
      } else if (localMeta.etag && file.etag && localMeta.etag === file.etag) {
        // ETag 相同 → 未变化，跳过
      } else if (localMeta.mtime && file.mtime && file.mtime <= localMeta.mtime) {
        // MTime 未更新 → 跳过
      } else {
        // ETag 不同或 MTime 更新 → 需要下载
        toDownload.push(file);
      }
    }

    // 检测云端删除：本地有记录但云端列表中不存在
    const toDelete: string[] = [];
    for (const noteId of Object.keys(metadata.lastSyncMeta)) {
      if (!cloudNoteIds.has(noteId)) {
        toDelete.push(noteId);
      }
    }

    const unchangedCount = cloudFiles.length - toDownload.length;
    return { toDownload, toDelete, unchanged: unchangedCount };
  }

  /**
   * 下载变化的笔记文件
   */
  private async downloadChangedNotes(
    files: CloudFileInfo[],
    allNotes: Map<string, AtomicNote>,
    signal: AbortSignal,
    notify?: (message: string) => void
  ): Promise<void> {
    let downloaded = 0;
    let failed = 0;
    const total = files.length;
    const logInterval = Math.max(10, Math.floor(total / 10));

    for (let i = 0; i < files.length; i++) {
      if (signal.aborted) throw new Error("同步已取消");

      const file = files[i];
      try {
        const atomicNote = await this.cloudClient.downloadAtomicNote(file.path);
        if (atomicNote) {
          allNotes.set(atomicNote.id, atomicNote);
          downloaded++;
        }
      } catch (error) {
        failed++;
        if (failed <= 5) {
          console.warn(`[SyncManager] 下载笔记失败: ${file.path}`, error);
        }
      }

      const processed = downloaded + failed;
      if (processed % logInterval === 0 || processed === total) {
        const msg = `下载笔记 ${processed}/${total} (成功: ${downloaded}, 失败: ${failed})`;
        console.debug(`[SyncManager] ${msg}`);
        notify?.(msg);
      }
    }

    console.debug(`[SyncManager] 笔记下载完成: 成功 ${downloaded}, 失败 ${failed}, 总计 ${total}`);
  }

  /**
   * 带重试的异步操作
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number,
    delay: number = 1000
  ): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (error) {
        if (i === maxRetries - 1) throw error;
        const waitTime = delay * Math.pow(2, i);
        console.warn(`[SyncManager] 操作失败，${waitTime}ms 后重试 (${i + 1}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
    throw new Error("重试次数耗尽");
  }
}
