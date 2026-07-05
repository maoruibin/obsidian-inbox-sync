import { App, TFile, TFolder } from "obsidian";
import { InboxSyncSettings } from "../types/settings";
import { ParsedAnnotation, ParsedNote } from "../types/inbox";

/** 批注嵌入块的标记，用于识别和替换 */
const ANNOTATION_BLOCK_START = "\n\n---\n\n> **批注**\n";

/** writeNote 的返回结果 */
export interface WriteNoteResult {
  isNew: boolean;
  fileName: string;  // 不含扩展名的文件名，供嵌入引用用
}

/**
 * Markdown 写入器
 */
export class MarkdownWriter {
  private app: App;
  private settings: InboxSyncSettings;

  constructor(app: App, settings: InboxSyncSettings) {
    this.app = app;
    this.settings = settings;
  }

  /**
   * 写入笔记到 Vault
   * 所有笔记平铺在 inBox/ 目录下
   * @returns WriteNoteResult 包含是否新建和文件名
   */
  async writeNote(
    note: ParsedNote,
    boxFolders: Record<string, string>,
    parentFileName?: string
  ): Promise<WriteNoteResult> {
    const vault = this.app.vault;
    const folderPath = this.computeNoteFolderPath(note, boxFolders);

    // 确保文件夹存在（包括盒子子文件夹）
    await vault.adapter.mkdir(folderPath);

    // 检查笔记是否已在某个错误路径（懒迁移）
    await this.migrateNoteToTargetFolder(note, folderPath);

    // 确定标题
    const displayTitle = this.getDisplayTitle(note);
    let fileName = this.sanitizeFileName(displayTitle);
    let filePath = `${folderPath}/${fileName}.md`;

    // 检查同名文件是否已存在但属于不同笔记
    const existing = vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      try {
        const content = await vault.read(existing);
        const match = content.match(/inbox_id:\s*(\S+)/);
        if (match && match[1] !== note.noteId) {
          // 同名但是不同笔记，追加短 ID 避免冲突
          const shortId = note.noteId.replace(/^note-/, "").slice(0, 8);
          fileName = this.sanitizeFileName(`${displayTitle}-${shortId}`);
          filePath = `${folderPath}/${fileName}.md`;
        }
      } catch {
        // 忽略读取错误
      }
    }

    // 生成 Markdown 内容
    const markdown = this.generateMarkdown(note, displayTitle, parentFileName);

    // 检查文件是否存在
    const finalExisting = vault.getAbstractFileByPath(filePath);

    if (finalExisting instanceof TFile) {
      // 文件存在，更新内容
      await vault.modify(finalExisting, markdown);
      return { isNew: false, fileName };
    } else {
      // 文件不存在，创建新文件
      await vault.create(filePath, markdown);
      return { isNew: true, fileName };
    }
  }

  /**
   * 懒迁移：如果笔记已经在某个路径，但不是目标文件夹，移动过去
   * 路径一致 / 笔记不存在 / 移动失败 都视为无操作
   */
  private async migrateNoteToTargetFolder(
    note: ParsedNote,
    targetFolderPath: string
  ): Promise<void> {
    const vault = this.app.vault;

    const existingPath = await this.findNotePath(note.noteId);
    if (!existingPath) return;  // 笔记不存在，新建，无需迁移

    const targetFileName = existingPath.split("/").pop()!;
    const expectedPath = `${targetFolderPath}/${targetFileName}`;

    if (existingPath === expectedPath) return;  // 已在正确位置

    // 目标文件夹可能没创建
    await vault.adapter.mkdir(targetFolderPath);

    // 用 vault.rename 让 Obsidian 自动修 [[link]] 引用
    const file = vault.getAbstractFileByPath(existingPath);
    if (!(file instanceof TFile)) return;

    try {
      await vault.rename(file, expectedPath);
      console.debug(
        `[MarkdownWriter] 笔记迁移: ${existingPath} → ${expectedPath}`
      );
    } catch (error) {
      console.error(`[MarkdownWriter] 笔记迁移失败: ${existingPath}`, error);
    }
  }

  /**
   * 确定笔记的显示标题
   * 1. 有标题（非 "Untitled"）→ 用原标题
   * 2. 无标题或 "Untitled" → 用创建时间 "2026-04-11 14:30"
   */
  private getDisplayTitle(note: ParsedNote): string {
    const title = note.title?.trim();
    if (title && title !== "Untitled") {
      return title;
    }
    return this.formatTimeTitle(note.createdAt.getTime());
  }

  /**
   * 将时间戳格式化为标题 "2026-04-14 20.48.32"
   */
  private formatTimeTitle(timestamp: number): string {
    const d = new Date(timestamp);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  }

  /**
   * 生成 Markdown 内容
   */
  private generateMarkdown(note: ParsedNote, displayTitle: string, parentFileName?: string): string {
    const lines: string[] = [];

    // Frontmatter
    lines.push("---");
    lines.push(`title: ${this.escapeYaml(displayTitle)}`);
    lines.push(`inbox_id: ${note.noteId}`);
    lines.push(`created: ${note.createdAt.toISOString()}`);
    lines.push(`updated: ${note.updatedAt.toISOString()}`);

    // 盒子归属（来自云端 boxes.json，无盒子不写）
    if (note.boxName) {
      lines.push(`box: ${this.escapeYaml(note.boxName)}`);
    }

    // 标签
    if (note.tags.length > 0 && this.settings.enableFrontmatterTags) {
      lines.push("tags:");
      for (const tag of note.tags) {
        const obsidianTag = this.convertTagToObsidian(tag);
        lines.push(`  - ${obsidianTag}`);
      }
    }

    // 父笔记引用（批注笔记）
    if (parentFileName) {
      lines.push(`parent: "[[${parentFileName}]]"`);
    }

    lines.push("---");
    lines.push("");

    // 正文内容
    lines.push(this.processContent(note));

    const annotationBlock = this.generateInlineAnnotations(note.annotations);
    if (annotationBlock) {
      lines.push(annotationBlock);
    }

    return lines.join("\n");
  }

  /**
   * 处理内容（暂不修改，保持原始内容）
   */
  private processContent(note: ParsedNote): string {
    return note.content;
  }

  /**
   * 渲染 ver=2 内联批注到父笔记末尾
   */
  private generateInlineAnnotations(annotations: ParsedAnnotation[]): string | null {
    const visibleAnnotations = annotations.filter((annotation) => !annotation.isRemoved);
    if (visibleAnnotations.length === 0) return null;

    const lines: string[] = ["", "---", "", "> **批注**"];

    for (const annotation of visibleAnnotations) {
      lines.push(">");
      lines.push(`> [!note] ${this.getAnnotationTitle(annotation)}`);

      const contentLines = annotation.content.split(/\r?\n/);
      if (contentLines.length === 0 || (contentLines.length === 1 && contentLines[0].trim() === "")) {
        lines.push("> ");
      } else {
        for (const line of contentLines) {
          lines.push(line ? `> ${line}` : ">");
        }
      }

      if (annotation.tags.length > 0) {
        lines.push(">");
        lines.push(`> ${annotation.tags.map((tag) => this.formatAnnotationTag(tag)).join(" ")}`);
      }
    }

    return lines.join("\n");
  }

  private getAnnotationTitle(annotation: ParsedAnnotation): string {
    const title = annotation.title?.trim();
    const time = this.formatAnnotationTime(annotation.createdAt.getTime());
    if (title && title !== "Untitled") {
      return `${title} - ${time}`;
    }
    return time;
  }

  private formatAnnotationTime(timestamp: number): string {
    const d = new Date(timestamp);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private formatAnnotationTag(tag: string): string {
    return tag.startsWith("#") ? tag : `#${tag}`;
  }

  /**
   * 转换标签为 Obsidian 格式
   */
  private convertTagToObsidian(tag: string): string {
    return tag;
  }

  /**
   * 转义 YAML 特殊字符
   */
  private escapeYaml(text: string): string {
    if (!text) return "";

    if (/[:{}\[\],&*#?|<>=!%@`]/.test(text)) {
      return `"${text.replace(/"/g, '\\"')}"`;
    }

    return text;
  }

  /**
   * 获取基础路径（扁平结构）
   */
  private getBasePath(): string {
    return this.settings.vaultFolderPath.replace(/^\/+|\/+$/g, "");
  }

  /**
   * 清理文件名
   */
  private sanitizeFileName(name: string): string {
    if (!name) return "untitled";

    return name
      .replace(/[<>:"/\\|?*]/g, "-")
      .substring(0, 100);
  }

  /**
   * 清洗盒子名作为文件夹名
   * 规则(参考 spec 段 2):
   * - 替换 / \ : * ? " < > | 为 -
   * - 去首尾空格
   * - 清洗后为空 → fallback 到 box_id 短码 (如 box-abc123)
   * - 撞名检测在 ensureBoxFolder 里做(需要全局视角)
   */
  private sanitizeBoxFolderName(name: string, boxId: string): string {
    const sanitized = name
      .replace(/[<>:"/\\|?*]/g, "-")
      .trim();

    if (!sanitized) {
      // fallback 到 box_id 本身(已经是 box-xxx 格式)
      return boxId;
    }
    return sanitized;
  }

  /**
   * 撞名检测:计算清洗后的文件夹名,如果跟现有 boxFolders 值撞了,追加 box_id 短码
   * 这个方法只算名字,不创建文件夹
   */
  async ensureUniqueBoxFolderName(
    rawName: string,
    boxId: string,
    boxFolders: Record<string, string>
  ): Promise<string> {
    const sanitized = this.sanitizeBoxFolderName(rawName, boxId);

    // 检查是否跟其他 box_id 的文件夹名撞
    const existingNames = new Set(
      Object.entries(boxFolders)
        .filter(([id]) => id !== boxId)
        .map(([, name]) => name)
    );

    if (existingNames.has(sanitized)) {
      const shortId = boxId.replace(/^box-/, "").slice(0, 8);
      const unique = `${sanitized}-${shortId}`;
      console.warn(
        `[MarkdownWriter] 盒子名 "${rawName}" 撞名,改为 "${unique}"`
      );
      return unique;
    }

    return sanitized;
  }

  /**
   * 算笔记目标文件夹路径
   * - 有 boxId 且在 boxFolders 里能查到 → inBox/<盒子名>
   * - 否则 → inBox/(根目录)
   *
   * 注意:这个方法只看 boxFolders 元数据,不直接读 boxes.json。
   * SyncManager 会先调 reconcileBoxFolders() 保证 boxFolders 跟 boxes.json 一致。
   */
  private computeNoteFolderPath(
    note: ParsedNote,
    boxFolders: Record<string, string>
  ): string {
    const basePath = this.getBasePath();

    if (note.boxId && boxFolders[note.boxId]) {
      return `${basePath}/${boxFolders[note.boxId]}`;
    }
    return basePath;
  }

  /**
   * 删除笔记（通过 noteId 查找并删除）
   * 笔记平铺在 inBox/ 目录，直接扫描该目录下的 .md 文件
   */
  async deleteNote(noteId: string): Promise<boolean> {
    const vault = this.app.vault;
    const basePath = this.getBasePath();

    try {
      const files = await vault.adapter.list(basePath);

      for (const filePath of files.files) {
        if (!filePath.endsWith(".md")) continue;

        try {
          const content = await vault.adapter.read(filePath);
          const match = content.match(/inbox_id:\s*(\S+)/);
          if (match && match[1] === noteId) {
            await vault.adapter.remove(filePath);
            console.debug(`[MarkdownWriter] 已删除笔记: ${filePath}`);
            return true;
          }
        } catch {
          // 忽略读取错误
        }
      }
    } catch {
      // 文件夹可能不存在
    }

    return false;
  }

  /**
   * 更新父笔记，追加子笔记的嵌入引用
   * @param parentNoteId 父笔记的 noteId
   * @param childFileNames 子笔记的文件名列表（不含扩展名）
   */
  async updateParentEmbeds(parentNoteId: string, childFileNames: string[]): Promise<void> {
    if (childFileNames.length === 0) return;

    const vault = this.app.vault;
    const parentFilePath = await this.findNotePath(parentNoteId);
    if (!parentFilePath) {
      console.warn(`[MarkdownWriter] 父笔记未找到: ${parentNoteId}`);
      return;
    }

    try {
      const file = vault.getAbstractFileByPath(parentFilePath);
      if (!(file instanceof TFile)) return;

      let content = await vault.read(file);

      // 移除旧的批注块
      const blockIndex = content.indexOf(ANNOTATION_BLOCK_START);
      if (blockIndex !== -1) {
        content = content.substring(0, blockIndex);
      }

      // 生成新的批注块
      const embedLines: string[] = [ANNOTATION_BLOCK_START];
      for (const childName of childFileNames) {
        embedLines.push(`> ![[${childName}]]`);
        embedLines.push(">");
        if (childName !== childFileNames[childFileNames.length - 1]) {
          embedLines.push(">");
        }
      }

      content += embedLines.join("\n");

      await vault.modify(file, content);
      console.debug(`[MarkdownWriter] 已更新父笔记嵌入: ${parentFilePath}, ${childFileNames.length} 个子笔记`);
    } catch (error) {
      console.error(`[MarkdownWriter] 更新父笔记嵌入失败: ${parentFilePath}`, error);
    }
  }

  /**
   * 给子笔记的 frontmatter 补上 parent 引用
   * 在现有的 frontmatter 中（---之前）插入 parent 字段
   */
  async addChildParentRef(childFileName: string, parentFileName: string): Promise<void> {
    const vault = this.app.vault;

    // 先按文件名在所有位置查找
    const filePath = await this.findFileByName(childFileName);
    if (!filePath) {
      console.warn(`[MarkdownWriter] addChildParentRef: 找不到文件 ${childFileName}.md`);
      return;
    }

    try {
      const file = vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) return;

      let content = await vault.read(file);
      const frontmatterEnd = content.indexOf("\n---", 4);
      if (frontmatterEnd !== -1) {
        const parentLine = `parent: "[[${parentFileName}]]"`;
        if (!content.includes("parent:")) {
          content = content.substring(0, frontmatterEnd) + "\n" + parentLine + content.substring(frontmatterEnd);
          await vault.modify(file, content);
        }
      }
    } catch (error) {
      console.error(`[MarkdownWriter] 添加 parent 引用失败: ${filePath}`, error);
    }
  }

  /**
   * 按文件名（不含扩展名）查找文件路径，递归扫描所有子文件夹
   */
  private async findFileByName(fileNameWithoutExt: string): Promise<string | null> {
    const basePath = this.getBasePath();
    try {
      const allFiles = await this.findAllMdFilesRecursive(basePath);
      const target = `${fileNameWithoutExt}.md`;
      for (const fp of allFiles) {
        if (fp.endsWith(`/${target}`)) return fp;
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * 通过 noteId 查找笔记的文件路径(递归扫描所有子文件夹)
   */
  private async findNotePath(noteId: string): Promise<string | null> {
    const vault = this.app.vault;
    const basePath = this.getBasePath();

    try {
      const result = await this.findAllMdFilesRecursive(basePath);
      for (const filePath of result) {
        try {
          const content = await vault.adapter.read(filePath);
          const match = content.match(/inbox_id:\s*(\S+)/);
          if (match && match[1] === noteId) {
            return filePath;
          }
        } catch {
          // 忽略
        }
      }
    } catch {
      // 文件夹可能不存在
    }

    return null;
  }

  /**
   * 递归收集 basePath 下所有 .md 文件路径
   */
  private async findAllMdFilesRecursive(dirPath: string): Promise<string[]> {
    const vault = this.app.vault;
    const result: string[] = [];

    try {
      const listing = await vault.adapter.list(dirPath);
      for (const file of listing.files) {
        if (file.endsWith(".md")) {
          result.push(file);
        }
      }
      for (const folder of listing.folders) {
        const subFiles = await this.findAllMdFilesRecursive(folder);
        result.push(...subFiles);
      }
    } catch {
      // 文件夹不存在
    }

    return result;
  }

  /**
   * 通过 noteId 查找笔记的文件名（不含扩展名）
   */
  async findNoteFileName(noteId: string): Promise<string | null> {
    const filePath = await this.findNotePath(noteId);
    if (!filePath) return null;
    const fileName = filePath.split("/").pop() || "";
    return fileName.replace(/\.md$/, "");
  }

  /**
   * 转换笔记内容中的 [[...]] 链接为 Obsidian 文件名
   * - [[note-xxx]] → [[文件名]]
   * - [[Card123]]  → [[文件名]]
   * - [[标题]]     → 保持不变
   */
  async convertLinks(
    fileName: string,
    noteIdFileMap: Map<string, string>,
    blockIdFileMap: Map<number, string>
  ): Promise<void> {
    const vault = this.app.vault;
    const filePath = await this.findFileByName(fileName);
    if (!filePath) {
      console.warn(`[MarkdownWriter] convertLinks: 找不到文件 ${fileName}.md`);
      return;
    }

    try {
      const file = vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) return;

      let content = await vault.read(file);
      let modified = false;

      content = content.replace(/(?<!!)\[\[([^\]]+)\]\]/g, (match, linkTarget: string) => {
        let replacement: string | null = null;

        if (linkTarget.startsWith("note-")) {
          replacement = noteIdFileMap.get(linkTarget) ?? null;
        } else if (/^Card\d+$/.test(linkTarget)) {
          const blockId = parseInt(linkTarget.replace("Card", ""), 10);
          if (!isNaN(blockId)) {
            replacement = blockIdFileMap.get(blockId) ?? null;
          }
        }

        if (replacement) {
          modified = true;
          return `[[${replacement}]]`;
        }
        return match;
      });

      if (modified) {
        await vault.modify(file, content);
        console.debug(`[MarkdownWriter] 已转换链接: ${fileName}`);
      }
    } catch (error) {
      console.error(`[MarkdownWriter] 转换链接失败: ${filePath}`, error);
    }
  }

  /**
   * 重命名盒子文件夹 + 更新内部笔记的 frontmatter box 字段
   * Obsidian 的 vault.rename 会自动修复 [[link]] 引用
   */
  async renameBoxFolder(
    boxId: string,
    oldFolderName: string,
    newFolderName: string
  ): Promise<void> {
    const vault = this.app.vault;
    const basePath = this.getBasePath();
    const oldPath = `${basePath}/${oldFolderName}`;
    const newPath = `${basePath}/${newFolderName}`;

    // 检查旧文件夹是否存在
    const oldFolder = vault.getAbstractFileByPath(oldPath);
    if (!(oldFolder instanceof TFolder)) {
      console.debug(`[MarkdownWriter] renameBoxFolder: ${oldPath} 不存在,跳过`);
      return;
    }

    // 决定最终重命名目标路径(处理目标已存在的撞名情况)
    const collidingFolder = vault.getAbstractFileByPath(newPath);
    let actualTargetPath: string;
    if (collidingFolder instanceof TFolder) {
      actualTargetPath = `${basePath}/${newFolderName}-${boxId.slice(0, 8)}`;
      console.warn(
        `[MarkdownWriter] renameBoxFolder: 目标 ${newPath} 已存在,改为 ${actualTargetPath}`
      );
    } else {
      actualTargetPath = newPath;
    }

    await vault.rename(oldFolder, actualTargetPath);
    console.debug(`[MarkdownWriter] 文件夹重命名: ${oldPath} → ${actualTargetPath}`);

    // 遍历最终文件夹下所有 .md,更新 frontmatter box 字段
    const mdFiles = await this.findAllMdFilesRecursive(actualTargetPath);
    for (const filePath of mdFiles) {
      try {
        await this.updateFrontmatterBoxField(filePath, newFolderName);
      } catch (error) {
        console.error(`[MarkdownWriter] 更新 frontmatter 失败: ${filePath}`, error);
      }
    }
  }

  /**
   * 用 Obsidian 的 processFrontMatter 更新某文件的 box 字段
   */
  private async updateFrontmatterBoxField(
    filePath: string,
    newBoxName: string
  ): Promise<void> {
    const vault = this.app.vault;
    const file = vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;

    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter["box"] = newBoxName;
    });
  }

  /**
   * 解散盒子文件夹:所有笔记移回根目录,删 box frontmatter 字段,删空文件夹
   * 用于盒子被 deleted_at 墓碑 / boxes.json 里查不到的情况
   */
  async dissolveBoxFolder(folderName: string): Promise<void> {
    const vault = this.app.vault;
    const basePath = this.getBasePath();
    const folderPath = `${basePath}/${folderName}`;

    const folder = vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) {
      console.debug(`[MarkdownWriter] dissolveBoxFolder: ${folderPath} 不存在`);
      return;
    }

    // 收集文件夹下所有 .md(直接子文件,不递归 — 盒子文件夹不嵌套)
    const mdFiles = await this.findAllMdFilesRecursive(folderPath);

    for (const filePath of mdFiles) {
      const file = vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) continue;

      // 移到根目录
      const fileName = filePath.split("/").pop()!;
      const newPath = `${basePath}/${fileName}`;

      // 处理同名冲突(根目录已有同名文件)
      let safeNewPath = newPath;
      let counter = 1;
      while (vault.getAbstractFileByPath(safeNewPath) instanceof TFile) {
        const dotIdx = fileName.lastIndexOf(".");
        const base = dotIdx > 0 ? fileName.substring(0, dotIdx) : fileName;
        const ext = dotIdx > 0 ? fileName.substring(dotIdx) : "";
        safeNewPath = `${basePath}/${base}-${counter}${ext}`;
        counter++;
      }

      try {
        await vault.rename(file, safeNewPath);
        // 删 box frontmatter 字段
        const movedFile = vault.getAbstractFileByPath(safeNewPath);
        if (movedFile instanceof TFile) {
          await this.app.fileManager.processFrontMatter(movedFile, (frontmatter) => {
            delete frontmatter["box"];
          });
        }
      } catch (error) {
        console.error(`[MarkdownWriter] dissolveBoxFolder: 移动失败 ${filePath}`, error);
      }
    }

    // 删空文件夹
    const folderAfterMove = vault.getAbstractFileByPath(folderPath);
    if (folderAfterMove instanceof TFolder) {
      try {
        // 检查文件夹是否真的空(list 看下)
        const listing = await vault.adapter.list(folderPath);
        if (listing.files.length === 0 && listing.folders.length === 0) {
          await vault.delete(folderAfterMove, true);
          console.debug(`[MarkdownWriter] 已删除空文件夹: ${folderPath}`);
        } else {
          console.warn(
            `[MarkdownWriter] 文件夹非空,未删除: ${folderPath}, files=${listing.files.length}, folders=${listing.folders.length}`
          );
        }
      } catch (error) {
        console.error(`[MarkdownWriter] 删除空文件夹失败: ${folderPath}`, error);
      }
    }
  }
}
