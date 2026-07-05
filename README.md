# inBox Sync for Obsidian

将 [inBox](https://inbox.gudong.site) 笔记同步到 Obsidian vault 的插件。

## 功能

- 支持从 inBox 云存储（WebDAV/S3）同步笔记
- 双向同步：云端 ↔ Obsidian（修改/软删除双向传播，不支持在 Obsidian 新建笔记）
- 智能增量同步：仅同步有变化的笔记
- 完整资源支持：图片、视频、录音、附件
- 自动标签提取：支持层级标签（`#tag/subtag`）
- 可配置同步间隔和文件夹结构

## 安装

> 插件尚未进入 Obsidian 官方社区目录（审核排队中），目前推荐用 BRAT 安装。

### 方法 1：BRAT 安装（推荐）

[BRAT](https://github.com/TfTHacker/obsidian42-brat) 可以从 GitHub 仓库直接安装插件，并自动接收更新。适合尚未进入官方目录的插件。

1. 在 Obsidian 中安装并启用 **BRAT** 插件（社区目录可搜到）
2. 打开 BRAT 设置 → **Add Beta plugin** → 输入仓库地址：
   ```
   maoruibin/obsidian-inbox-sync
   ```
3. 回到 Obsidian 设置 → 社区插件，启用 **inBox Sync**

之后本仓库发版，BRAT 会自动拉取更新。

### 方法 2：手动安装

1. 从 [Releases](https://github.com/maoruibin/obsidian-inbox-sync/releases) 下载 `main.js`、`manifest.json`、`styles.css`
2. 把文件放到 Obsidian vault 的插件目录：`.obsidian/plugins/inbox-sync/`
3. 在 Obsidian 设置中启用 **inBox Sync**

> 升级时需要重复上述步骤手动替换文件，所以非开发者推荐用 BRAT。

### 方法 3：开发模式（贡献者）

```bash
git clone https://github.com/maoruibin/obsidian-inbox-sync.git
cd obsidian-inbox-sync
npm install
npm run dev
```

`npm run dev` 会监听文件变化自动重新构建，并把产物复制到配置的 Vault 插件目录。

## 配置

### WebDAV 配置

1. 在设置中选择存储类型为 "WebDAV"
2. 填写 WebDAV 服务器地址、用户名、密码
3. 设置 inBox 数据路径（默认：`/inbox/`）

### S3 配置

1. 在设置中选择存储类型为 "S3 Compatible"
2. 填写 S3 端点、Access Key、Secret Key、Bucket
3. 设置 Region 和路径前缀

### 同步设置

- **Vault 文件夹路径**：笔记在 vault 中的存储位置（默认：`inBox`）
- **自动同步间隔**：自动同步的时间间隔（分钟）
- **冲突处理策略**：遇到已存在文件时的处理方式

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

## Markdown 格式

同步后的笔记包含 YAML frontmatter：

```markdown
---
title: 今日记录
inbox_id: note-abc123
created: 2025-04-10T10:30:00.000Z
updated: 2025-04-10T10:30:00.000Z
box: 工作
tags:
  - 日记/生活
  - 心情/开心
---

#日记/生活
今天天气不错 #心情/开心

![[../assets/images/2025/04/photo.jpg]]
```

> `box` 字段表示笔记所属的盒子（来自云端 `boxes.json`），无盒子的笔记不会写这一行。

## 双向同步

本插件支持云端与 Obsidian 之间的双向同步：

- **下载**：云端有变化 → 覆盖本地笔记（按 ETag/mtime 增量）
- **上传**：本地修改 → 序列化为 atomicNote PUT 到云端 `notes/{noteId}.json`
- **软删除传播**：本地删除同步过的笔记 → 上传 `flags.is_removed=true`（与 inBox App 行为一致，不直接删云端文件）

### 上传触发条件

每次同步结束时扫描本地变更：

| 场景 | 行为 |
|---|---|
| 笔记的 `file.stat.mtime > lastLocalMtime` 基线 | 上传修改 |
| 本地文件不存在（已删除/移出 inBox 文件夹）但 metadata 有记录 | 上传软删除 |
| 笔记本次同步刚被下载/写入 | 不上传（基线已重置为新 mtime） |

### 冲突处理（Last-Write-Wins，云端优先）

如果同一笔记在云端和本地都改了：

1. 下载阶段先发生 → 本地修改被覆盖
2. 基线重置为覆盖后的 mtime
3. 上传阶段比对发现无变化 → 不上传

结果：云端版本胜出，本地修改丢失。这是有意为之的简单策略，避免双向合并的复杂性。

### 不支持的场景

- **新建笔记**：在 Obsidian 中新建的 `.md` 文件没有 `inbox_id` frontmatter，不会被上传。同步只针对云端已有的笔记。
- **资源上传**：本地新增的图片/录音不会推到云端，仅云端→本地方向同步资源。
- **盒子归属变更**：移动笔记到不同盒子文件夹不会上传新的 `box_id`（保留 original 的 box_id）。这个限制后续会移除。

### 关键字段

`lastLocalMtime`（存在 `.inbox-sync-meta.json`）：每条笔记上次同步完成后的本地文件 mtime 基线。`vault.modify` 写 frontmatter 会改 mtime，所以必须用这个基线而不是 `lastSyncTime`，否则会无限循环（自己写自己读，永远以为本地有改动）。

## 开发

```bash
# 安装依赖
npm install

# 开发模式（监听文件变化）
npm run dev

# 构建生产版本
npm run build
```

## 数据格式兼容性

本插件与 inBox Android/Flutter 版本共享数据格式：
- `XBlock`：笔记数据结构
- `XTag`：标签数据结构
- `XResourceInfo`：资源信息结构

## 许可证

MIT

## 相关链接

- [inBox Web 版](https://inbox.gudong.site)
- [inBox 文档](https://doc.gudong.site)
