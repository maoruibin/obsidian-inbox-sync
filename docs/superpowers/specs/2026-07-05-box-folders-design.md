# Obsidian 笔记按盒子组织文件夹 — 设计文档

**日期**: 2026-07-05
**项目**: obsidian-inbox-sync
**作者**: 与 Claude 协作设计

---

## 背景

inBox Android 端有"盒子"机制(类似分类/空间),笔记可以归属到某个盒子。云同步协议里 `boxes.json` 记录盒子元数据,笔记 JSON 的 `content.box_id` 记录归属。

当前 Obsidian 插件把所有笔记平铺在 `inBox/` 根目录,用户看不到盒子结构,浏览不便。

## 动机

让 Obsidian 用户在 vault 里能按盒子组织笔记,与 Android 端的分类体验一致。

## 范围

**只改 Obsidian 插件**(`obsidian-inbox-sync` 项目)。云端协议、Android 端、其他客户端(thinkflutter / inBoxWeb / inbox-mini / gudong-inbox-cli)**完全不动**。

理由:Obsidian 插件不是直接挂载云存储,而是从云端读 JSON 后由插件自己写成 Markdown。vault 里的目录结构由 `MarkdownWriter.writeNote()` 决定,跟云端协议无关。

## 设计原则

1. **不破坏云端协议** — `boxes.json`、`notes/*.json` 结构、ETag、冲突解决等完全不变
2. **单笔记级判断** — 不区分"全局有盒子/无盒子",每条笔记独立决定路径
3. **状态显式** — 盒子文件夹 → box_id 的映射记在 `.inbox-sync-meta.json`,不靠文件夹名反推
4. **懒迁移** — 不做单独的迁移流程,在正常同步过程中按需移动文件
5. **不污染 vault** — 不在每个盒子文件夹里放点文件,所有状态集中在 `.inbox-sync-meta.json`

## 详细设计

### 1. 文件夹结构

每条笔记独立判断目标路径:

- 笔记 `content.box_id` 在 `boxes.json` 里查得到 → 进 `<盒子名>/` 子文件夹
- 否则(没写 `box_id` / 盒子已 `deleted_at` 墓碑) → 根目录平铺

```
inBox/
├── note-aaa.md          ← 笔记没 box_id,根目录
├── note-bbb.md          ← 笔记没 box_id,根目录
├── 工作/
│   └── note-ccc.md      ← box_id 对应"工作"盒子
└── 生活/
    └── note-ddd.md      ← box_id 对应"生活"盒子
```

特性:
- 用户没配盒子时,所有笔记自然都在根目录(老行为不变)
- 老用户升级无感
- 不需要"默认"文件夹这个特殊概念

### 2. 盒子名 → 文件夹名清洗

盒子名是用户在 App 里随手输的,清洗后才能当文件夹名。复用现有 `sanitizeFileName()` (markdown-writer.ts:232) 同款规则:

| 字符 | 处理 |
|------|------|
| `/ \ : * ? " < > \|` | 替换为 `-` |
| 首尾空格 | 去掉 |
| 空字符串 / 清洗后为空 | fallback 到 `box_id` 短码(如 `box-abc123`) |
| 清洗后两个盒子撞名(如"工作"和"工/作"都清洗成"工-作") | 第二个追加 `box_id` 短码: `工-作-abc123` |

### 3. 盒子重命名 / 删除处理

`.inbox-sync-meta.json` 扩展一个字段:

```json
{
  "lastSyncTime": 1234567890,
  "lastSyncMeta": { ... },
  "version": "2.0.0",
  "boxFolders": {
    "box-abc123": "工作",
    "box-def456": "生活"
  }
}
```

每次同步开始时,**先处理盒子文件夹,再处理笔记增删**:

| 情况 | 处理 |
|------|------|
| `boxes.json` 里 `box-abc123` 的 name 从"工作"→"职场" | (a) `vault.rename("inBox/工作", "inBox/职场")` (Obsidian 自动修 `[[工作/xxx]]` 类链接);(b) 遍历该文件夹下所有 `.md`,用 `vault.processFrontMatter()` 把 frontmatter 的 `box:` 字段值改为"职场";(c) 更新 `boxFolders["box-abc123"] = "职场"` |
| `boxes.json` 里 `box-abc123` 被 `deleted_at` 墓碑 | (a) 扫描 `inBox/工作/` 下所有 `.md`,根据 box_id 已失效,移动到根目录 `inBox/`;(b) 移动时 `vault.rename()` 自动修链接;(c) 移动后更新这些笔记的 frontmatter,删除 `box:` 字段;(d) 删空文件夹;(e) 从 `boxFolders` 删除 |
| `boxes.json` 里新增盒子但还没有笔记 | 不创建空文件夹(避免视觉污染);`boxFolders` 里先不记;等有笔记了再创建 |
| `boxFolders` 里有 `box-xxx`,但 `boxes.json` 里查不到 | 当作"被远端删除"处理(同墓碑逻辑) |

### 4. 资源文件

**保持现状不动**。资源统一放:

```
inBox/assets/
├── images/
├── videos/
├── audios/
└── attachments/
```

理由:
- Markdown 里的 `![[../assets/images/xxx.jpg]]` 路径永远不变
- 笔记在盒子间移动时只动 `.md` 一个文件
- 同一资源被多笔记引用不会重复(`asset-handler.ts:85` 的 `processedAssets` 去重机制本来就是为全局共享设计)
- Obsidian 社区标准做法

### 5. 老用户笔记迁移(懒迁移)

不做单独的迁移流程。在 `MarkdownWriter.writeNote()` 里多一步:

1. 算笔记目标路径(根目录 or 盒子文件夹)
2. 检查 vault 里现有路径(通过 `.inbox-sync-meta.json` 的 `lastSyncMeta` 查 noteId 对应的旧路径)
3. 路径不一致 → `vault.rename()` 移动到目标位置

老用户原本所有笔记平铺在 `inBox/` 根,升级后第一次同步会自动按需移动到盒子文件夹。逻辑统一,没有"迁移模式"分支。

### 6. frontmatter 处理

现状保留:
- 笔记有盒子 → 写 `box: <盒子名>`(markdown-writer.ts:113-115)
- 笔记没盒子 → 不写 `box` 字段

盒子重命名时除了 `vault.rename()` 文件夹,还要遍历该文件夹下所有 `.md`,用 `vault.processFrontMatter()` 改 frontmatter 的 `box:` 值。

### 7. 不加配置开关

默认开,不提供关闭选项。理由:
- YAGNI,不确定有需求
- 老用户没盒子时行为完全不变(平铺)
- 老用户有盒子时自动按盒子组织,是改进不是破坏

## 边缘情况

### A. 用户手动建了同名文件夹

例如用户在 Obsidian 里手动建了 `inBox/工作/`,放了一些非 inBox 笔记。

处理:
- 同步时发现 `inBox/工作/` 文件夹存在,但 `boxFolders` 里没记录这个文件夹
- 扫描该文件夹下的 `.md`,看 frontmatter 是否有 `inbox_id`
  - 有合法 `inbox_id` → 当作已同步笔记(可能是上次同步留下的)
  - 没有 → 用户手动放的文件,**不能删**,把整个文件夹改名(如 `inBox/工作-用户手动-20260705/`),再创建同步用的 `inBox/工作/`

### B. 删除笔记导致空文件夹

某盒子下所有笔记都被删除 → 文件夹变空。
- `boxes.json` 里盒子还存在 → 删空文件夹(下次有笔记自动重建)
- `boxes.json` 里盒子被删了 → 更要删

### C. 用户手动改了文件夹名

例如用户把 `inBox/工作/` 改成 `inBox/MyWork/`。

处理:
- 下次同步时,通过 `boxFolders` 知道 `box-abc123` 应该叫"工作"
- vault 里找不到 `inBox/工作/`
- 兜底逻辑:扫描 `inBox/*/` 下所有 `.md` 的 frontmatter `inbox_id`,反查云端 note JSON 确认 box_id
- 找到 `inBox/MyWork/note-xxx.md` 的 `inbox_id` 对应 `box-abc123` → 把 `MyWork` rename 回 `工作`

### D. 首次同步时初始化 `boxFolders`

新用户或清空元数据后的首次同步:
1. 拉取 `boxes.json`
2. 不预先创建任何文件夹(等有笔记了再创建)
3. 处理每条笔记时,如果发现 `boxFolders` 没有这个 box_id → 计算文件夹名(清洗 + 撞名处理) → 写入 `boxFolders`

## 实施影响

### 代码改动文件

| 文件 | 改动 |
|------|------|
| `src/types/inbox.ts` | `SyncMetadata` 加 `boxFolders: Record<string, string>` 字段 |
| `src/storage/metadata-storage.ts` | 旧元数据无 `boxFolders` 时迁移为空对象 |
| `src/sync/markdown-writer.ts` | `writeNote()` 加路径计算 + 懒迁移;新增 `ensureBoxFolder()`、`renameBoxFolder()`、`moveNoteToFolder()` 等方法 |
| `src/sync/sync-manager.ts` | 同步开始时调用盒子文件夹对账(对比 boxes.json 跟 boxFolders,处理 rename/delete),再进入笔记循环 |

### 不影响

- 云端协议 (`ThinkPlus-box-optimization/docs/inbox-tech/sync/README.md` 不动)
- Android 端同步代码
- 其他客户端

## 测试策略

### 单元测试

- `sanitizeBoxFolderName()`: 各种特殊字符、空、撞名 case
- 算目标路径:有盒子/无盒子/盒子被删
- `boxFolders` 状态更新逻辑

### 集成测试(手工)

准备 vault + 模拟云端数据,验证:

1. **新用户场景**: boxes.json 有盒子,同步后正确建文件夹
2. **老用户升级 — 无盒子**: 行为不变,所有笔记还在根目录
3. **老用户升级 — 有盒子**: 笔记自动从根目录迁移到对应文件夹
4. **盒子重命名**: vault 文件夹被 rename,frontmatter 同步更新,链接自动修复
5. **盒子删除**: 文件夹里笔记回退到根目录,文件夹消失
6. **同名文件夹冲突**: 用户手动建的文件夹被妥善处理,不丢数据
7. **资源引用**: 笔记移动后 `![[...]]` 仍能正确显示资源

### MCP 验证

借助现有 rclone + claude-in-mobile MCP 工具,在真机同步一次后,用 rclone 检查云端不变,用 Obsidian 截图看 vault 结构。
