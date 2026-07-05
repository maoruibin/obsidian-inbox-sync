# Obsidian 按盒子组织文件夹 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Obsidian 插件同步笔记时按盒子组织 vault 文件夹结构,云端协议不动。

**Architecture:** 改动只限 `obsidian-inbox-sync` 项目。`MarkdownWriter` 负责按 box_id 算目标路径并移动文件;`SyncManager` 在每次同步开始时先对账盒子文件夹(rename / delete),再进入笔记循环;`SyncMetadata` 扩展 `boxFolders` 字段持久化 box_id → 文件夹名映射。

**Tech Stack:** TypeScript / Obsidian Plugin API / esbuild

**测试策略:** 项目无测试框架,采用 `npm run build` 编译检查 + 关键节点手工 Obsidian 验证(参考 spec 测试策略章节)。

**Spec:** [docs/superpowers/specs/2026-07-05-box-folders-design.md](../specs/2026-07-05-box-folders-design.md)

---

## 文件结构

| 文件 | 改动类型 | 责任 |
|------|---------|------|
| `src/types/inbox.ts` | 修改 | `SyncMetadata` 加 `boxFolders` 字段 |
| `src/storage/metadata-storage.ts` | 修改 | 旧元数据迁移,加载/保存时处理 `boxFolders` |
| `src/sync/markdown-writer.ts` | 修改 | 主要工作:目标路径计算、写入、文件夹对账、笔记移动 |
| `src/sync/sync-manager.ts` | 修改 | 同步开始时调用盒子对账,保存 boxFolders 状态 |
| `README.md` | 修改 | 描述新文件夹行为 |

---

## Task 1: SyncMetadata 扩展 boxFolders 字段

**Files:**
- Modify: `src/types/inbox.ts:245-249`
- Modify: `src/storage/metadata-storage.ts:30-95`

- [ ] **Step 1: 修改 SyncMetadata 类型,加 boxFolders 字段**

打开 `src/types/inbox.ts`,把现有的 `SyncMetadata` 改为:

```typescript
/**
 * 同步元数据(本地存储)
 */
export interface SyncMetadata {
  lastSyncTime: number;     // 最后同步时间(毫秒)
  lastSyncMeta: Record<string, NoteSyncMeta>;  // noteId -> {etag, mtime}
  version: string;          // 元数据格式版本
  boxFolders?: Record<string, string>;  // boxId -> 文件夹名(用于对账重命名/删除)
}
```

- [ ] **Step 2: 在 MetadataStorage.load() 加迁移逻辑**

打开 `src/storage/metadata-storage.ts`,在 `load()` 方法的 `// 验证格式` 注释之前,加一段:

```typescript
      // 迁移:旧元数据没有 boxFolders 字段,补空对象
      if (!data.boxFolders) {
        data.boxFolders = {};
        console.debug("[MetadataStorage] 迁移:补 boxFolders 空对象");
      }
```

完整上下文(参考):

```typescript
      // 迁移旧格式:lastSyncEtags → lastSyncMeta
      if (data.lastSyncEtags && !data.lastSyncMeta) {
        // ... 现有代码
      }

      // 迁移:旧元数据没有 boxFolders 字段,补空对象
      if (!data.boxFolders) {
        data.boxFolders = {};
        console.debug("[MetadataStorage] 迁移:补 boxFolders 空对象");
      }

      // 验证格式
      if (this.isValidMetadata(data)) {
        return data;
      }
```

- [ ] **Step 3: 验证编译通过**

Run: `cd /Users/gudong/code/workpace/ReProject/obsidian-inbox-sync && npm run build`
Expected: 编译通过,无 TS 错误

- [ ] **Step 4: Commit**

```bash
git add src/types/inbox.ts src/storage/metadata-storage.ts
git commit -m "feat(sync): SyncMetadata 加 boxFolders 字段持久化盒子文件夹映射"
```

---

## Task 2: 盒子名清洗 + 目标路径计算

**Files:**
- Modify: `src/sync/markdown-writer.ts` (新增私有方法)

- [ ] **Step 1: 加 sanitizeBoxFolderName 静态方法**

在 `MarkdownWriter` 类内(建议放在 `sanitizeFileName` 方法附近),加:

```typescript
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
```

- [ ] **Step 2: 加 computeNoteTargetPath 方法**

在 `MarkdownWriter` 类内加。这个方法决定一条笔记"应该在的"文件夹路径(不含文件名):

```typescript
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
```

- [ ] **Step 3: 加 getNoteFilePath 辅助方法**

为后续多次复用,加一个"给定 noteId 找现有 .md 文件路径"的辅助方法。已有的 `findNotePath(noteId)` 是私有方法,直接用即可,但需要确认它的扫描范围。

检查现有 `findNotePath`(markdown-writer.ts:352-375):它只扫 `basePath` 根目录,不扫子文件夹。**这会漏掉已经在盒子文件夹里的笔记**。需要改成递归扫描。

把 `findNotePath` 改成扫描 `basePath` 及所有子文件夹:

```typescript
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
```

- [ ] **Step 4: 验证编译通过**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 5: Commit**

```bash
git add src/sync/markdown-writer.ts
git commit -m "feat(writer): 加盒子名清洗、目标路径计算、递归扫描方法"
```

---

## Task 3: writeNote 用目标路径 + 懒迁移

**Files:**
- Modify: `src/sync/markdown-writer.ts:31-75` (`writeNote` 方法)

- [ ] **Step 1: 改 writeNote 方法签名,接收 boxFolders 参数**

把 `writeNote` 改成接收 boxFolders:

```typescript
  async writeNote(
    note: ParsedNote,
    boxFolders: Record<string, string>,
    parentFileName?: string
  ): Promise<WriteNoteResult> {
    const vault = this.app.vault;
    const folderPath = this.computeNoteFolderPath(note, boxFolders);

    // 确保文件夹存在(包括盒子子文件夹)
    await vault.adapter.mkdir(folderPath);

    // 检查笔记是否已在某个错误路径(懒迁移)
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
          // 同名但是不同笔记,追加短 ID 避免冲突
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
      await vault.modify(finalExisting, markdown);
      return { isNew: false, fileName };
    } else {
      await vault.create(filePath, markdown);
      return { isNew: true, fileName };
    }
  }
```

- [ ] **Step 2: 加 migrateNoteToTargetFolder 方法**

新方法,在 `MarkdownWriter` 类里:

```typescript
  /**
   * 懒迁移:如果笔记已经在某个路径,但不是目标文件夹,移动过去
   * 路径一致 / 笔记不存在 / 移动失败 都视为无操作
   */
  private async migrateNoteToTargetFolder(
    note: ParsedNote,
    targetFolderPath: string
  ): Promise<void> {
    const vault = this.app.vault;

    const existingPath = await this.findNotePath(note.noteId);
    if (!existingPath) return;  // 笔记不存在,新建,无需迁移

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
```

- [ ] **Step 3: 修复 updateParentEmbeds / addChildParentRef / convertLinks 的路径假设**

这些方法原本假设笔记在根目录,现在可能在子文件夹。需要用 `findNotePath` 替代硬编码路径。

**`updateParentEmbeds`** (markdown-writer.ts:278) — 已经用 `findNotePath`,不动。

**`addChildParentRef`** (markdown-writer.ts:323-347) — 当前用 `const filePath = ${basePath}/${childFileName}.md;`,改成先查路径:

```typescript
  async addChildParentRef(childFileName: string, parentFileName: string): Promise<void> {
    const vault = this.app.vault;
    const basePath = this.getBasePath();

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
   * 按文件名(不含扩展名)查找文件路径,递归扫描所有子文件夹
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
```

**`convertLinks`** (markdown-writer.ts:393-438) — 同样改成先查路径:

```typescript
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
```

- [ ] **Step 4: 修复 SyncManager 调用 writeNote 的签名**

打开 `src/sync/sync-manager.ts:186`,改:

```typescript
          const result = await this.markdownWriter.writeNote(parsedNote, syncMetadata.boxFolders || {});
```

- [ ] **Step 5: 验证编译通过**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 6: Commit**

```bash
git add src/sync/markdown-writer.ts src/sync/sync-manager.ts
git commit -m "feat(writer): writeNote 按 box_id 算路径,懒迁移老笔记到盒子文件夹"
```

---

## Task 4: 盒子文件夹对账 — 重命名

**Files:**
- Modify: `src/sync/markdown-writer.ts` (新方法)

- [ ] **Step 1: 加 renameBoxFolder 方法**

在 `MarkdownWriter` 类里加。这个方法负责把整个文件夹改名 + 更新里面所有 .md 的 frontmatter `box:` 字段:

```typescript
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

    // 如果新路径已存在(用户手动建了同名文件夹),改名时撞车
    const newFolder = vault.getAbstractFileByPath(newPath);
    if (newFolder instanceof TFolder) {
      console.warn(
        `[MarkdownWriter] renameBoxFolder: 目标 ${newPath} 已存在,改为追加 box_id 后缀`
      );
      const safeNewPath = `${basePath}/${newFolderName}-${boxId.slice(0, 8)}`;
      await vault.rename(oldFolder, safeNewPath);
    } else {
      await vault.rename(oldFolder, newPath);
      console.debug(`[MarkdownWriter] 文件夹重命名: ${oldPath} → ${newPath}`);
    }

    // 遍历新文件夹下所有 .md,更新 frontmatter box 字段
    const targetPath = newFolder instanceof TFolder
      ? newPath
      : `${basePath}/${newFolderName}-${boxId.slice(0, 8)}`;
    const mdFiles = await this.findAllMdFilesRecursive(targetPath);
    for (const filePath of mdFiles) {
      await this.updateFrontmatterBoxField(filePath, newFolderName);
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

    await vault.processFrontMatter(file, (frontmatter) => {
      frontmatter["box"] = newBoxName;
    });
  }
```

需要在文件顶部 import `TFolder`:

```typescript
import { App, TFile, TFolder } from "obsidian";
```

- [ ] **Step 2: 验证编译通过**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add src/sync/markdown-writer.ts
git commit -m "feat(writer): 加 renameBoxFolder 处理盒子重命名 + frontmatter 同步"
```

---

## Task 5: 盒子文件夹对账 — 删除

**Files:**
- Modify: `src/sync/markdown-writer.ts` (新方法)

- [ ] **Step 1: 加 dissolveBoxFolder 方法**

盒子被删墓碑时,把文件夹里所有笔记移回根目录,清掉 frontmatter 的 box 字段,删空文件夹:

```typescript
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
          await vault.processFrontMatter(movedFile, (frontmatter) => {
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
```

- [ ] **Step 2: 验证编译通过**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add src/sync/markdown-writer.ts
git commit -m "feat(writer): 加 dissolveBoxFolder 处理盒子删除墓碑"
```

---

## Task 6: SyncManager 集成盒子对账

**Files:**
- Modify: `src/sync/sync-manager.ts:121-128` (buildBoxNameMap 调用之后)

- [ ] **Step 1: 加 reconcileBoxFolders 私有方法**

在 `SyncManager` 类里加。这个方法对比 boxNameMap(来自 boxes.json) 和 boxFolders(本地元数据),处理 rename / delete / 新增:

```typescript
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
          `[SyncManager] 新增盒子映射: ${boxId} → ${uniqueName}(暂不建文件夹)`
        );
      }
    }
  }
```

需要在 sync-manager.ts 顶部 import `SyncMetadata`(已经在 import 里)。

- [ ] **Step 2: 在 sync() 里调用 reconcileBoxFolders**

打开 `src/sync/sync-manager.ts`,在 `buildBoxNameMap()` 调用之后(约 122 行)加对账:

```typescript
      // 1.5 拉取盒子清单 boxes.json,构建 boxId→name 映射
      const boxNameMap = await this.buildBoxNameMap();
      this.noteParser.setBoxNameMap(boxNameMap);

      // 1.6 对账盒子文件夹(rename / delete / 新增),把状态写回 metadata
      await this.reconcileBoxFolders(syncMetadata, boxNameMap);
```

- [ ] **Step 3: 验证编译通过(此时 ensureUniqueBoxFolderName 还未实现,会报错)**

Run: `npm run build`
Expected: TS 报错 `Property 'ensureUniqueBoxFolderName' does not exist on type 'MarkdownWriter'`

下一步会加上。

- [ ] **Step 4: Commit(分两步,先写 reconcile 再加 ensureUnique)**

暂不 commit,等下一步加上 ensureUniqueBoxFolderName 一起 commit。

---

## Task 7: ensureUniqueBoxFolderName 撞名检测

**Files:**
- Modify: `src/sync/markdown-writer.ts`

- [ ] **Step 1: 加 ensureUniqueBoxFolderName 方法**

在 `MarkdownWriter` 类里加。两个盒子清洗后撞名时,第二个追加 box_id 短码:

```typescript
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
```

- [ ] **Step 2: 在 writeNote 创建文件夹前也用 ensureUniqueBoxFolderName**

Task 3 里 `writeNote` 用 `computeNoteFolderPath` 算路径,这个路径来自 `boxFolders[boxId]`。reconcileBoxFolders 已经在写 boxFolders 时调过 ensureUnique,所以正常情况下 boxFolders[boxId] 已经是清洗后的唯一名。

但有一个边缘情况:**老用户首次升级,boxFolders 是空的,没走过 reconcile 就直接处理笔记**。这种情况在 Task 6 设计里不会发生(reconcile 在 sync 开始时就跑了)。所以 `computeNoteFolderPath` 直接信任 boxFolders[boxId] 即可,不再二次清洗。

不过为了防御性,在 `computeNoteFolderPath` 里加个清洗(只做字符替换,不做撞名检测,因为撞名检测需要 IO 和 boxFolders 全局):

```typescript
  private computeNoteFolderPath(
    note: ParsedNote,
    boxFolders: Record<string, string>
  ): string {
    const basePath = this.getBasePath();

    if (note.boxId && boxFolders[note.boxId]) {
      // boxFolders[boxId] 在 reconcileBoxFolders 阶段已经清洗过,这里直接用
      return `${basePath}/${boxFolders[note.boxId]}`;
    }
    return basePath;
  }
```

(这个方法在 Task 2 里已经写过,这里只是确认它仍然合理,不需要改动。)

- [ ] **Step 3: 验证编译通过**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 4: Commit**

```bash
git add src/sync/sync-manager.ts src/sync/markdown-writer.ts
git commit -m "feat(sync): SyncManager 同步开始时对账盒子文件夹 + 撞名检测"
```

---

## Task 8: 删除笔记时清理空文件夹

**Files:**
- Modify: `src/sync/markdown-writer.ts:244-271` (`deleteNote` 方法)

- [ ] **Step 1: 改 deleteNote 方法**

现在的 `deleteNote` 只扫根目录(markdown-writer.ts:249),改成递归扫所有子文件夹,删完后检查所在文件夹是否变空:

```typescript
  /**
   * 删除笔记(通过 noteId 查找并删除)
   * 笔记可能在根目录或盒子子文件夹,递归扫描
   */
  async deleteNote(noteId: string): Promise<boolean> {
    const vault = this.app.vault;
    const basePath = this.getBasePath();

    try {
      const allFiles = await this.findAllMdFilesRecursive(basePath);

      for (const filePath of allFiles) {
        if (!filePath.endsWith(".md")) continue;

        try {
          const content = await vault.adapter.read(filePath);
          const match = content.match(/inbox_id:\s*(\S+)/);
          if (match && match[1] === noteId) {
            // 记住所在文件夹,删完后检查
            const parentFolder = filePath.substring(0, filePath.lastIndexOf("/"));
            await vault.adapter.remove(filePath);
            console.debug(`[MarkdownWriter] 已删除笔记: ${filePath}`);

            // 清理空文件夹(只在 parentFolder 不是根目录时)
            if (parentFolder !== basePath) {
              await this.cleanupEmptyFolder(parentFolder);
            }
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
   * 如果文件夹为空,删除它(盒子文件夹没有笔记了就清掉)
   */
  private async cleanupEmptyFolder(folderPath: string): Promise<void> {
    const vault = this.app.vault;
    try {
      const listing = await vault.adapter.list(folderPath);
      if (listing.files.length === 0 && listing.folders.length === 0) {
        const folder = vault.getAbstractFileByPath(folderPath);
        if (folder instanceof TFolder) {
          await vault.delete(folder, true);
          console.debug(`[MarkdownWriter] 已清理空文件夹: ${folderPath}`);
        }
      }
    } catch (error) {
      // 忽略
    }
  }
```

- [ ] **Step 2: 验证编译通过**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add src/sync/markdown-writer.ts
git commit -m "feat(writer): deleteNote 递归扫描 + 清理空文件夹"
```

---

## Task 9: SyncManager 在笔记处理失败时记录 box_id → 文件夹映射变化

**Files:**
- Modify: `src/sync/sync-manager.ts:264-272` (元数据保存)

- [ ] **Step 1: 确认 metadata.boxFolders 会被保存**

打开 `src/sync/sync-manager.ts:264-272`,看现有的元数据保存:

```typescript
      // 7. 更新元数据:写入所有云端文件的 ETag/MTime(包括跳过的)
      for (const file of cloudFiles) {
        syncMetadata.lastSyncMeta[file.id] = {
          etag: file.etag || "",
          mtime: file.mtime || 0,
        };
      }
      syncMetadata.lastSyncTime = Date.now();
      await this.metadataStorage.save(syncMetadata);
```

`syncMetadata.boxFolders` 已经在 `reconcileBoxFolders` 阶段被修改过,这里直接 `save(syncMetadata)` 就会一起写入文件。**不需要额外改动**。

但要确认:如果 `reconcileBoxFolders` 阶段对账失败(异常),后面还继续同步,boxFolders 可能没初始化。在 sync() 的 try 块里加保险:

把 `await this.reconcileBoxFolders(syncMetadata, boxNameMap);` 这行之后,加一个保险:

```typescript
      // 1.6 对账盒子文件夹(rename / delete / 新增),把状态写回 metadata
      try {
        await this.reconcileBoxFolders(syncMetadata, boxNameMap);
      } catch (error) {
        console.warn("[SyncManager] 盒子文件夹对账失败,继续同步:", error);
      }
```

这样即使对账阶段挂了,同步主体还能继续(只是文件夹可能不对,不会阻断笔记下载)。

- [ ] **Step 2: 验证编译通过**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add src/sync/sync-manager.ts
git commit -m "fix(sync): 盒子对账失败不阻断主同步流程"
```

---

## Task 10: 文档更新

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-05-box-folders-design.md` (链接到此 plan)

- [ ] **Step 1: 更新 README.md 的"目录结构"章节**

打开 `README.md`,把"目录结构"章节(72-94 行)替换为:

````markdown
## 目录结构

同步后的目录结构会按盒子组织:

```
inBox/
├── notes/                          # 无盒子笔记(根目录平铺)
│   ├── 2025-04-10 note-title.md
│   └── 2025-04-11 another.md
├── 工作/                            # "工作"盒子下的笔记
│   └── project-xxx.md
├── 生活/                            # "生活"盒子下的笔记
│   └── shopping-list.md
├── assets/                          # 资源文件(所有盒子共享)
│   ├── images/
│   │   └── photo.jpg
│   ├── videos/
│   │   └── video.mp4
│   ├── audios/
│   │   └── recording.mp3
│   └── attachments/
│       └── file.pdf
└── .inbox-sync-meta.json          # 同步元数据(含盒子文件夹映射)
```

**盒子文件夹规则**:

- 笔记的 `content.box_id` 在云端 `boxes.json` 里查得到 → 进 `<盒子名>/` 子文件夹
- 否则(无盒子 / 盒子被删墓碑) → 根目录 `inBox/` 平铺
- 用户没配盒子时,所有笔记自然都在根目录
- 盒子重命名时,文件夹自动 rename,frontmatter `box:` 字段同步更新
- 盒子删除时,文件夹内笔记移回根目录,文件夹清空
- 资源文件统一放 `assets/`,不按盒子分

盒子名清洗规则: `/ \ : * ? " < > |` 替换为 `-`,空名 fallback 到 box_id 短码,撞名追加 box_id 后缀。
````

- [ ] **Step 2: 在 spec 文档末尾加链接到本 plan**

打开 `docs/superpowers/specs/2026-07-05-box-folders-design.md`,在末尾加:

```markdown

---

## 实施计划

详细任务清单见 [实施计划](../plans/2026-07-05-box-folders-implementation.md)。
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/specs/2026-07-05-box-folders-design.md
git commit -m "docs: 更新 README 描述按盒子组织文件夹的新行为"
```

---

## 手工集成测试清单

完成所有任务后,在 Obsidian 里手工验证下列场景(spec 测试策略章节):

| # | 场景 | 验证 |
|---|------|------|
| 1 | 新用户: boxes.json 有盒子,同步 | vault 出现对应盒子文件夹,笔记按 box_id 分布正确 |
| 2 | 老用户升级,无盒子 | 所有笔记还在根目录,行为不变 |
| 3 | 老用户升级,有盒子 | 首次同步后笔记自动从根目录迁移到盒子文件夹 |
| 4 | 盒子重命名 | 文件夹被 rename,frontmatter box 字段更新,`[[链接]]` 仍能跳转 |
| 5 | 盒子被远端删除墓碑 | 文件夹内笔记移回根目录,文件夹消失,frontmatter box 字段被删 |
| 6 | 同名冲突(用户手动建同名文件夹) | 自动追加 box_id 后缀,不丢数据 |
| 7 | 笔记删除导致空文件夹 | 空文件夹被清理 |
| 8 | 资源引用 | 笔记移动后 `![[...]]` 仍能显示资源 |

每条通过后再发版。

---

## Self-Review

**1. Spec coverage:**

- 段 1 文件夹结构 → Task 2 (computeNoteFolderPath) + Task 3 (writeNote 整合)
- 段 2 盒子名清洗 → Task 2 (sanitizeBoxFolderName) + Task 7 (ensureUniqueBoxFolderName)
- 段 3 重命名/删除 → Task 4 (renameBoxFolder) + Task 5 (dissolveBoxFolder) + Task 6 (reconcileBoxFolders)
- 段 4 资源保持现状 → 不需要改动,Task 8 备注里说明
- 段 5 懒迁移 + frontmatter → Task 3 (migrateNoteToTargetFolder) + Task 4 (updateFrontmatterBoxField)
- 段 6 不加开关 → 不需要改动
- 边缘情况 A (用户手动建同名文件夹) → Task 4 (renameBoxFolder 撞车处理) + Task 7 (撞名检测)
- 边缘情况 B (空文件夹清理) → Task 8 (cleanupEmptyFolder)
- 边缘情况 C (用户改了文件夹名) → 兜底逻辑通过 findNotePath 递归扫描覆盖(Task 2 Step 3)
- 边缘情况 D (首次初始化 boxFolders) → Task 6 reconcileBoxFolders 第二阶段处理新增

**2. Placeholder scan:** 无 TBD / TODO / "类似 Task N" 等。

**3. Type consistency:**

- `boxFolders: Record<string, string>` 在 types/inbox.ts、metadata-storage.ts、markdown-writer.ts、sync-manager.ts 一致使用
- `ensureUniqueBoxFolderName(rawName, boxId, boxFolders)` 在 sync-manager Task 6 调用,Task 7 实现 — 签名一致
- `computeNoteFolderPath(note, boxFolders)` 在 Task 2 实现,Task 3 调用 — 签名一致
- `writeNote(note, boxFolders, parentFileName?)` 在 Task 3 改签名,Task 6 sync-manager 调用一致
- `findNotePath` 改成递归后,所有调用点(addChildParentRef、convertLinks、updateParentEmbeds)行为更宽松,不破坏现有调用
