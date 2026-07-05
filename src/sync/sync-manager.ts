import { App, TFile } from "obsidian";
import { InboxSyncSettings, getCloudRootPath } from "../types/settings";
import { CloudClient, CloudFileInfo } from "./cloud-client";
import { WebDAVNativeClient } from "./webdav-native";
import { S3Client } from "./s3-client";
import { NoteParser, SerializeInput } from "./note-parser";
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
      uploadedNotes: 0,
      softDeletedNotes: 0,
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

      // 1.5 拉取盒子清单 boxes.json，构建 boxId→name 映射
      const boxNameMap = await this.buildBoxNameMap();
      this.noteParser.setBoxNameMap(boxNameMap);

	      // 1.6 对账盒子文件夹（rename / delete / 新增），把状态写回 metadata
	      try {
	        await this.reconcileBoxFolders(syncMetadata, boxNameMap);
	      } catch (error) {
	        console.warn("[SyncManager] 盒子文件夹对账失败,继续同步:", error);
	      }
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
          const result = await this.markdownWriter.writeNote(parsedNote, syncMetadata.boxFolders || {});

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

      // 7. 捕获下载/写入后的本地 mtime 基线
      // 关键：vault.modify 会改 mtime，必须以写入后的值为基线，否则下次同步会无限循环
      await this.capturePostDownloadBaselines(noteIdFileMap, syncMetadata);

      // 8. 上传本地变更（修改/软删除）到云端
      const uploadResult = await this.uploadLocalChanges(
        syncMetadata,
        allNotes,
        signal,
        notify
      );
      stats.uploadedNotes = uploadResult.uploaded;
      stats.softDeletedNotes = uploadResult.softDeleted;

      // 9. 更新元数据：写入所有云端文件的 ETag/MTime（包括跳过的）
      // 参考 Android DownloadService.updateRemoteMetadata() — 即使跳过也要更新元数据
      for (const file of cloudFiles) {
        const existing = syncMetadata.lastSyncMeta[file.id];
        syncMetadata.lastSyncMeta[file.id] = {
          etag: file.etag || "",
          mtime: file.mtime || 0,
          // 保留 capturePostDownloadBaselines / uploadLocalChanges 设置的基线
          lastLocalMtime: existing?.lastLocalMtime,
        };
      }
      syncMetadata.lastSyncTime = Date.now();
      await this.metadataStorage.save(syncMetadata);

      const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
      const efficiency = cloudFiles.length > 0
        ? ((unchanged / cloudFiles.length) * 100).toFixed(1)
        : "0";
      notify?.(
        `同步完成！新增 ${stats.newNotes}, 更新 ${stats.updatedNotes}, 删除 ${stats.deletedNotes}, 上传 ${stats.uploadedNotes}, 跳过 ${unchanged} (${elapsed}s)`
      );
      console.debug(`[SyncManager] ===== 同步完成 (${elapsed}s) =====`);
      console.debug(`[SyncManager] 增量效率: 跳过 ${unchanged}/${cloudFiles.length} (${efficiency}%)`);
      console.debug(
        `[SyncManager] 新增: ${stats.newNotes}, 更新: ${stats.updatedNotes}, 删除: ${stats.deletedNotes}, 上传: ${stats.uploadedNotes}, 软删: ${stats.softDeletedNotes}, 失败: ${stats.failedNotes}`
      );
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
   * 捕获下载/写入阶段的本地文件 mtime 基线
   * 必须在 writeNote / convertLinks / updateParentEmbeds 全部完成后调用，
   * 否则这些写入操作会改 mtime，导致下次同步误以为本地有改动而无限上传。
   */
  private async capturePostDownloadBaselines(
    noteIdFileMap: Map<string, { fileName: string; parsedNote: ParsedNote }>,
    metadata: SyncMetadata
  ): Promise<void> {
    const vault = this.app.vault;
    const basePath = this.settings.vaultFolderPath.replace(/^\/+|\/+$/g, "");

    let captured = 0;
    for (const [noteId, info] of noteIdFileMap) {
      const boxId = info.parsedNote.boxId;
      const boxFolder = boxId ? metadata.boxFolders?.[boxId] : undefined;
      const folder = boxFolder ? `${basePath}/${boxFolder}` : basePath;
      const path = `${folder}/${info.fileName}.md`;

      const file = vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const existing = metadata.lastSyncMeta[noteId];
        metadata.lastSyncMeta[noteId] = {
          etag: existing?.etag || "",
          mtime: existing?.mtime || 0,
          lastLocalMtime: file.stat.mtime,
        };
        captured++;
      }
    }
    console.debug(
      `[SyncManager] 已捕获 ${captured}/${noteIdFileMap.size} 条下载基线 (lastLocalMtime)`
    );
  }

  /**
   * 上传本地变更到云端
   * - toUpload: 用户修改过的笔记（mtime > 基线），序列化后 PUT 到云端
   * - toSoftDelete: 曾同步过但本地文件已不存在的 noteId，标记 is_removed=true 上传
   *
   * 冲突策略：Last-Write-Wins，云端优先。如果云端本次同步也更新了同一笔记，
   * download 阶段已覆盖本地修改，capturePostDownloadBaselines 已重置基线，
   * 此处 mtime 等于新基线，不会再上传。
   */
  private async uploadLocalChanges(
    metadata: SyncMetadata,
    downloadedNotes: Map<string, AtomicNote>,
    signal: AbortSignal,
    notify?: (msg: string) => void
  ): Promise<{ uploaded: number; softDeleted: number }> {
    const changes = await this.markdownWriter.findLocallyChangedFiles(metadata);
    const totalUpload = changes.toUpload.length;
    const totalSoftDelete = changes.toSoftDelete.length;

    if (totalUpload === 0 && totalSoftDelete === 0) {
      console.debug("[SyncManager] 无本地变更需要上传");
      return { uploaded: 0, softDeleted: 0 };
    }

    console.debug(
      `[SyncManager] 本地变更：${totalUpload} 条修改, ${totalSoftDelete} 条待软删除`
    );
    notify?.(`上传本地变更 (修改 ${totalUpload}, 软删 ${totalSoftDelete})...`);

    let uploaded = 0;
    let softDeleted = 0;

    for (const { noteId, file } of changes.toUpload) {
      if (signal.aborted) throw new Error("同步已取消");
      try {
        const original = await this.getOriginalNote(noteId, downloadedNotes);
        const input = await this.buildSerializeInput(noteId, file, original, false);
        if (!input) continue;
        const atomic = this.noteParser.serialize(input);
        const ok = await this.cloudClient.uploadAtomicNote(atomic);
        if (ok) {
          uploaded++;
          const existing = metadata.lastSyncMeta[noteId];
          metadata.lastSyncMeta[noteId] = {
            etag: existing?.etag || "",
            mtime: existing?.mtime || 0,
            lastLocalMtime: file.stat.mtime,
          };
        }
      } catch (error) {
        console.warn(`[SyncManager] 上传笔记失败: ${noteId}`, error);
      }
    }

    for (const { noteId } of changes.toSoftDelete) {
      if (signal.aborted) throw new Error("同步已取消");
      try {
        const original = await this.getOriginalNote(noteId, downloadedNotes);
        const input = await this.buildSerializeInput(noteId, null, original, true);
        if (!input) continue;
        const atomic = this.noteParser.serialize(input);
        const ok = await this.cloudClient.uploadAtomicNote(atomic);
        if (ok) {
          softDeleted++;
          // 软删除后清理 metadata，下次同步这条 note 会从云端重新拉取（带 is_removed=true）
          delete metadata.lastSyncMeta[noteId];
        }
      } catch (error) {
        console.warn(`[SyncManager] 软删除上传失败: ${noteId}`, error);
      }
    }

    console.debug(
      `[SyncManager] 上传完成：修改 ${uploaded}/${totalUpload}, 软删 ${softDeleted}/${totalSoftDelete}`
    );
    return { uploaded, softDeleted };
  }

  /**
   * 获取云端原始笔记（用于上传时保留 ver/imageJson/extra/annotations 等字段）
   * 优先用本同步已下载的缓存，缓存未命中时按 notes/{noteId}.json 路径回源拉取。
   */
  private async getOriginalNote(
    noteId: string,
    downloadedNotes: Map<string, AtomicNote>
  ): Promise<AtomicNote | undefined> {
    const cached = downloadedNotes.get(noteId);
    if (cached) return cached;
    try {
      const note = await this.cloudClient.downloadAtomicNote(`notes/${noteId}.json`);
      if (note) {
        downloadedNotes.set(noteId, note);
        return note;
      }
    } catch (error) {
      console.warn(`[SyncManager] 拉取原始笔记失败: ${noteId}`, error);
    }
    return undefined;
  }

  /**
   * 从本地文件构建 SerializeInput
   * - file 非 null：从文件读取 + 解析 frontmatter，用于修改上传
   * - file 为 null：软删除场景，使用 original 的内容兜底
   */
  private async buildSerializeInput(
    noteId: string,
    file: TFile | null,
    original: AtomicNote | undefined,
    isRemoved: boolean
  ): Promise<SerializeInput | null> {
    if (!file) {
      const createdIso = original?.meta?.created_at || new Date().toISOString();
      return {
        noteId,
        title: original?.content?.title || "Untitled",
        markdown: original?.content?.content || "",
        boxId: original?.content?.box_id,
        parentId: original?.parentId || original?.parent_id || undefined,
        createdAt: new Date(createdIso),
        updatedAt: new Date(),
        isRemoved: true,
        original,
      };
    }

    const content = await this.markdownWriter.readFileContent(file);
    const frontmatter = this.parseFrontmatter(content);

    const titleField = frontmatter.title;
    const title =
      typeof titleField === "string" && titleField.trim()
        ? titleField.trim()
        : file.basename;

    const createdAt = this.parseFrontmatterDate(
      frontmatter.created,
      original?.meta?.created_at
    );
    const updatedAt = new Date();

    // box 字段是名字，优先用 original.content.box_id 保证 ID 稳定；缺 original 时无法可靠反推
    const boxName = typeof frontmatter.box === "string" ? frontmatter.box : undefined;
    let boxId: string | undefined;
    if (original?.content?.box_id) {
      boxId = original.content.box_id;
    } else if (boxName) {
      console.warn(
        `[SyncManager] 缺 original，无法反推 boxId，box="${boxName}" 将丢失`
      );
    }

    const parentId = original?.parentId || original?.parent_id || undefined;
    const body = this.stripFrontmatter(content);

    return {
      noteId,
      title,
      markdown: body,
      boxId,
      parentId,
      createdAt,
      updatedAt,
      isRemoved,
      original,
    };
  }

  /**
   * 简易 frontmatter 解析（仅取顶层 key: value 行）
   * 复杂场景（多行 tags、嵌套）由 markdown-writer 用 metadataCache 处理，
   * 这里只需要 title/created/updated/box 这几个标量字段
   */
  private parseFrontmatter(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return result;

    for (const line of match[1].split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (!m) continue;
      let value: unknown = m[2].trim();
      if (typeof value === "string" && /^".*"$/.test(value)) {
        value = value.slice(1, -1);
      }
      result[m[1]] = value;
    }
    return result;
  }

  private parseFrontmatterDate(value: unknown, fallback?: string): Date {
    if (typeof value === "string" && value.trim()) {
      const t = new Date(value.trim()).getTime();
      if (Number.isFinite(t)) return new Date(t);
    }
    if (fallback) {
      const t = new Date(fallback).getTime();
      if (Number.isFinite(t)) return new Date(t);
    }
    return new Date();
  }

  private stripFrontmatter(content: string): string {
    return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
  }

  /**
   * 拉取云端 boxes.json，构建 boxId → name 映射
   * 跳过已删除（deleted_at 非空）的盒子
   * 文件不存在或解析失败时返回空 Map（不阻断同步）
   */
  private async buildBoxNameMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const manifest = await this.cloudClient.downloadBoxesManifest();
      if (!manifest || !Array.isArray(manifest.boxes)) {
        console.debug("[SyncManager] boxes.json 不存在或格式无效，跳过盒子名称解析");
        return map;
      }
      for (const box of manifest.boxes) {
        if (!box.box_id || !box.name) continue;
        if (box.deleted_at != null) continue;
        map.set(box.box_id, box.name);
      }
      console.debug(`[SyncManager] 盒子清单加载完成, 共 ${map.size} 个有效盒子`);
    } catch (error) {
      console.warn("[SyncManager] 拉取 boxes.json 失败，盒子名称将退回旧字段:", error);
    }
    return map;
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

  /**
   * 盒子文件夹对账:
   * - boxFolders 里有,boxNameMap 里没有 → 盒子被删了,dissolveBoxFolder
   * - 两边都有,但 name 不一样 → 盒子被重命名,renameBoxFolder
   * - boxNameMap 里有,boxFolders 里没有 → 新盒子,不预先建文件夹(等有笔记时再建)
   *
   * 这个方法会修改 metadata.boxFolders 和 boxNameMap,调用方负责保存 metadata。
   */
  private async reconcileBoxFolders(
    metadata: SyncMetadata,
    boxNameMap: Map<string, string>
  ): Promise<void> {
    if (!metadata.boxFolders) {
      metadata.boxFolders = {};
    }
    const boxFolders = metadata.boxFolders;

    // 1. 处理重命名 + 删除(遍历 boxFolders)
    const boxIds = Object.keys(boxFolders);
    for (const boxId of boxIds) {
      const oldFolderName = boxFolders[boxId];
      const newName = boxNameMap.get(boxId);

      if (!newName) {
        // boxes.json 里查不到 → 当作被删
        console.debug(`[SyncManager] 盒子 ${boxId} 在 boxes.json 中已删除,dissolve 文件夹 ${oldFolderName}`);
        await this.markdownWriter.dissolveBoxFolder(oldFolderName);
        delete boxFolders[boxId];
        continue;
      }

      // 计算清洗后的目标文件夹名(撞名检测在 ensureBoxFolder 阶段做)
      // 但 rename 时如果新名字清洗后跟旧名字清洗后一样(只是大小写差异等),跳过
      if (oldFolderName !== newName) {
        // 在 rename 之前先看新名字是否撞已有文件夹
        // 注意: renameBoxFolder 内部已经处理了"目标已存在"的撞名情况
        console.debug(
          `[SyncManager] 盒子 ${boxId} 重命名: ${oldFolderName} → ${newName}`
        );
        await this.markdownWriter.renameBoxFolder(boxId, oldFolderName, newName);
        boxFolders[boxId] = newName;
      }
    }

    // 2. 同步新增的盒子(只更新元数据,不预先建空文件夹)
    for (const [boxId, name] of boxNameMap.entries()) {
      if (!boxFolders[boxId]) {
        // 检查是否已有同名文件夹(撞名检测)
        const uniqueName = await this.markdownWriter.ensureUniqueBoxFolderName(name, boxId, boxFolders);
        boxFolders[boxId] = uniqueName;
        console.debug(
          `[SyncManager] 新增盒子映射: ${boxId} → ${uniqueName}（暂不建文件夹）`
        );
      }
    }
  }
}
