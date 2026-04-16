import { App, TFile } from "obsidian";
import { InboxSyncSettings } from "../types/settings";
import { ParsedNote } from "../types/inbox";

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
  async writeNote(note: ParsedNote, parentFileName?: string): Promise<WriteNoteResult> {
    const vault = this.app.vault;
    const folderPath = this.getBasePath();

    // 确保文件夹存在
    await vault.adapter.mkdir(folderPath);

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

    return lines.join("\n");
  }

  /**
   * 处理内容（暂不修改，保持原始内容）
   */
  private processContent(note: ParsedNote): string {
    return note.content;
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
    const basePath = this.getBasePath();
    const filePath = `${basePath}/${childFileName}.md`;

    try {
      const file = vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) return;

      let content = await vault.read(file);

      // 在 frontmatter 结束标记 --- 之前插入 parent 字段
      const frontmatterEnd = content.indexOf("\n---", 4); // 跳过第一个 ---
      if (frontmatterEnd !== -1) {
        const parentLine = `parent: "[[${parentFileName}]]"`;
        // 检查是否已有 parent 字段
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
   * 通过 noteId 查找笔记的文件路径
   */
  private async findNotePath(noteId: string): Promise<string | null> {
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
    const basePath = this.getBasePath();
    const filePath = `${basePath}/${fileName}.md`;

    try {
      const file = vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) return;

      let content = await vault.read(file);
      let modified = false;

      // 匹配所有 [[...]] 链接（不匹配 ![[...]] 嵌入引用）
      content = content.replace(/(?<!!)\[\[([^\]]+)\]\]/g, (match, linkTarget: string) => {
        let replacement: string | null = null;

        if (linkTarget.startsWith("note-")) {
          // [[note-xxx]] → noteId 格式
          replacement = noteIdFileMap.get(linkTarget) ?? null;
        } else if (/^Card\d+$/.test(linkTarget)) {
          // [[Card123]] → blockId 老格式
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
}
