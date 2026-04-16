# inBox Sync for Obsidian

将 [inBox](https://inbox.gudong.site) 笔记同步到 Obsidian vault 的插件。

## 功能

- 支持从 inBox 云存储（WebDAV/S3）同步笔记
- 单向同步：inBox → Obsidian
- 智能增量同步：仅同步有变化的笔记
- 完整资源支持：图片、视频、录音、附件
- 自动标签提取：支持层级标签（`#tag/subtag`）
- 可配置同步间隔和文件夹结构

## 安装

### 方法1：手动安装

1. 下载最新版本的 `main.js` 和 `manifest.json`
2. 将文件放入 Obsidian vault 的插件目录：`.obsidian/plugins/obsidian-inbox-sync/`
3. 在 Obsidian 设置中启用插件

### 方法2：开发模式

```bash
cd obsidian-inbox-sync
npm install
npm run dev
```

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

同步后的目录结构：

```
inBox/
├── notes/           # 笔记文件
│   └── 2025/
│       └── 04/
│           └── 10/
│               └── note-title.md
├── assets/          # 资源文件
│   ├── images/
│   │   └── 2025/
│   │       └── 04/
│   │           └── photo.jpg
│   ├── videos/
│   │   └── video.mp4
│   ├── audios/
│   │   └── 2025-04-10/
│   │       └── recording.mp3
│   └── attachments/
│       └── file.pdf
└── .inbox-sync-meta.json  # 同步元数据
```

## Markdown 格式

同步后的笔记包含 YAML frontmatter：

```markdown
---
title: 今日记录
inbox_id: note-abc123
created: 2025-04-10T10:30:00.000Z
updated: 2025-04-10T10:30:00.000Z
tags:
  - 日记/生活
  - 心情/开心
---

#日记/生活
今天天气不错 #心情/开心

![[../assets/images/2025/04/photo.jpg]]
```

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
