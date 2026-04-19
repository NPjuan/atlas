# Atlas — 给你的笔记做一张地图

AI 把你散乱的 Obsidian 笔记自动整理成清晰的分类体系，并把文件按分类归档到对应文件夹。

> 名字源自希腊神话里扛天空的巨神，也是"地图集 / 图谱"的词源。
> 你的笔记就是大陆，Atlas 帮你绘制它们的地图。

## 它能干什么

**从混乱到秩序**——对着一堆没组织过的笔记，一次点击让 AI 分析全部内容、提出分类框架、给每篇笔记打上标签，再把文件本体迁移到对应分类目录下。

**常驻整理面板**——像文件管理器一样展示"分类树 + 每个分类下的笔记"，可以直接拖拽笔记在分类间移动，改动立即写回 Obsidian 的 frontmatter。

**脑图视图**——切到力导向图看全局，按 tag 聚合，点击节点跳转到对应笔记。

**零侵入**——只修改笔记 frontmatter 里的 `tags` 字段，不在笔记里插入任何标记、不生成额外文件。你随时可以停用或卸载插件，笔记和 tag 原封不动。

> 📦 **想把插件分享给朋友？** 看 [SHARING.md](./SHARING.md)——有现成的 zip 包、安装流程和发给朋友的一键复制说明。

## 核心概念

### 分类体系（Schema）

一棵树，最多 3 层，比如：

```
全部
├── 前端开发
│   ├── React
│   ├── CSS
│   └── TypeScript
├── 哲学
│   ├── 存在主义
│   └── 认识论
└── 产品
```

整个插件**只有一份全局分类体系**。你可以在 Vault 根上查看完整的树，也可以切到某个子文件夹（如"哲学/存在主义"）只看那一片。

### 文件夹作为视图范围

顶部面板的"范围"按钮决定：
- **看哪些笔记**（chips 只显示该文件夹下的笔记）
- **看哪一片分类**（如果选中的文件夹路径恰好等于某个一级节点的 fullPath，就切片展示）

切换范围不会新建独立的 schema；所有分类改动都作用在全局唯一的那份 schema 上。

### 分类 = 目录

插件把"分类"和"文件夹"视为同一件事：
- 重命名分类 → 对应的 Vault 文件夹跟着改名
- 删除分类 → 该分类下的笔记移到 Vault 根目录
- AI 归类完成后 → 自动把笔记文件按 tag 迁移到对应文件夹

这个行为可以在设置里关掉。

## 快速上手

### 1. 配置 AI

设置 → MECE 知识分类 → AI Provider。支持：

| Provider | 说明 |
|---|---|
| Claude | Anthropic 官方 API |
| OpenAI | OpenAI Chat Completions（JSON mode） |
| DeepSeek | OpenAI 兼容，性价比高 |
| Ollama | 本地模型，免费离线 |

不同 provider 的 API Key 和模型选择都独立保存，切换时不会丢。

### 2. 生成分类体系

打开命令面板（`Cmd+P`）→ **生成分类体系** → 选范围。AI 扫描所选范围的全部笔记内容，产出一份 3 层 MECE 分类树。

### 3. AI 归类

**命令面板 → AI 归类（选择文件夹）**，或者面板顶栏的 🪄 按钮。AI 分析每篇笔记，基于分类体系给它打 tag。

弹出的 Review 面板支持两种视图：
- **按分类看**：每个分类下有哪些笔记要被加进来
- **按文件看**：每篇笔记被加了什么 tag

可以组级全选、单独勾/取消、接受部分改动。

### 4. 整理文件夹

归类确认后，插件会自动按 tag 把笔记移动到对应分类文件夹（分类 = 目录）。多 tag 笔记会让你选"归属主分类"。

也可以手动触发：面板顶栏的 📁 树按钮。

### 5. 日常整理

- 在**整理面板**里拖笔记在分类间移动，立即生效
- 双击分类名字重命名
- 点 `+` 加子分类、点笔刀删除分类
- root 头的 `▼▲` 按钮展开/折叠全部

## 命令一览

- 打开知识整理面板
- 生成分类体系
- 编辑分类体系
- AI 归类（选择文件夹）
- 重置所有数据

## 设置项

- **AI Provider / API Key / 模型**：按 provider 独立保存
- **Schema 生成时笔记内容输入长度**：full / first-500 / title-only（用来控制 token 成本）
- **分类策略**：MECE / 自定义 prompt
- **每篇笔记最多 tag 数**：默认 3
- **Tag 前缀**：全部 tag 自动加指定前缀
- **默认 reorganize 强度**：conservative / balanced / aggressive
- **打标签策略**：sequential（逐篇）/ batch（批量）/ auto（按数量自动选）
- **归类后自动整理文件夹**：默认开
- **排除目录**：templates、daily 等目录默认不参与
- **最大文件字符数**：超过此长度的笔记 AI 只读开头部分

## 数据存在哪

- **插件状态** → `.obsidian/plugins/atlas-knowledge/data.json`
  包含全局 taxonomy、已处理笔记的 hash + 归类时间、插件设置
- **笔记 tag** → 笔记自身的 frontmatter `tags` 字段

卸载插件也不影响笔记 tag（frontmatter 是标准 YAML）。

## 安全与隐私

- 笔记内容会发送给你选的 AI Provider（Claude/OpenAI/DeepSeek）
- 用 Ollama 则完全本地，不出网
- API Key 存在 data.json 里明文（Obsidian 插件规范）
- 插件不会把 Vault 数据上传到任何非 AI Provider 的服务器

## 技术栈

TypeScript · esbuild · React 18 · Obsidian API · force-graph（脑图）· vitest（150+ 纯函数单测）

## 开发

```bash
npm install
npm run dev        # watch 模式，自动同步到 test-vault
npm run build      # 生产构建
npm test           # 跑测试
```

---

更多技术细节见 [ARCHITECTURE.md](./ARCHITECTURE.md)。
