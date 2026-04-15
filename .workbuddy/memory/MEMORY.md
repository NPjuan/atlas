# MEMORY.md — MECE 知识聚合思维导图项目

## 项目概述
Obsidian 插件，用 AI 提取知识点 → MECE 三层分类 → D3.js 径向思维导图可视化。

## 技术栈
- TypeScript + esbuild 打包
- D3.js v7 径向树布局
- AI: Claude / OpenAI / Ollama（OpenAI 兼容格式），纯 fetch 调用，无 SDK
- 数据: knowledge-store.json (含 schema version)

## 关键设计决策
- Ollama 使用 `/v1/chat/completions`（OpenAI 兼容），Provider 继承 OpenAI
- 分类器采用增量策略：只传未分类知识点 + 分类树骨架摘要，分批 40 条/批
- 提取器: 并发队列(最多 3 并发) + 指数退避重试(3次) + 断点续传(per-chunk 持久化)
- AI 输出: 统一 parseJSON() 后处理，处理 markdown 包装/截断 JSON
- 大文件保护: >2万字警告，>5万字跳过

## 项目结构
```
src/main.ts          — 插件入口
src/settings.ts      — 设置页
src/types.ts         — 全局类型
src/ai/              — AI 抽象层 (types, factory, prompts, chunker, providers/)
src/core/            — 核心逻辑 (scanner, extractor, categorizer, store)
src/ui/              — UI 组件 (mindmap, detail-panel, progress-modal)
src/views/           — Obsidian 视图 (MindMapView)
```

## 用户信息
- 用户: ekkopan
- 工作目录: /Users/ekkopan/Desktop/workspace/mece

---
_最后更新: 2025-04-15_
