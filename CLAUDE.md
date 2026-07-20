# CLAUDE.md

## AI 日志与验证规范（必读）

本项目属于 ReProject。AI 修改代码前必须先读并遵守 [`../docs/ai-logging-verification.md`](../docs/ai-logging-verification.md)。写代码时同步补关键日志，交付前说明使用了哪些日志、命令、测试、文件或同步结果完成验证。

## 📚 inBox 生态 Wiki

这是 inBox 笔记生态的 Obsidian 同步插件（单向只读）。改同步逻辑前先读生态 Wiki：

**入口**：[`../inbox-wiki/INDEX.md`](../inbox-wiki/INDEX.md)

本插件的 `src/sync/note-parser.ts` 的 `resolveBox()` 实现是盒子归属解析的参考实现（5 条兜底规则最完整），详见 [跨端差异矩阵](../inbox-wiki/protocols/cross-platform-matrix.md) 分叉点 1。

## 项目概述

Obsidian 插件，将 inBox 笔记单向同步到 Obsidian vault。支持增量同步、完整资源（图片/视频/录音/附件）、层级标签提取。

## 技术栈

- **语言**: TypeScript
- **构建**: esbuild
- **平台**: Obsidian API

## 架构

```
src/            # 源码
main.js         # 构建产物（发布用）
manifest.json   # 插件元信息
styles.css      # 样式
```

## 核心功能

- 单向同步：inBox → Obsidian
- 支持数据源：WebDAV / S3 云存储
- 增量同步：仅同步有变化的笔记
- 资源同步：图片、视频、录音、附件
- 标签提取：支持层级标签（`#tag/subtag`）

## 同步契约

本插件属于 inBox 多端同步体系。同步协议权威文档是 `/Users/gudong/code/workpace/ReProject/ThinkPlus/docs/inbox-tech/sync/README.md`。

只要修改数据同步行为，必须同步检查并更新该 README，包括云端 JSON 字段、noteId、批注/子笔记、删除传播、冲突处理、ETag/mtime、资源路径和跨端兼容性。

## 开发命令

```bash
# 安装依赖
npm install

# 开发模式（watch）
npm run dev

# 生产构建
npm run build
```

## 安装方式

将 `main.js` + `manifest.json` 放入 `.obsidian/plugins/obsidian-inbox-sync/`，在 Obsidian 设置中启用。
