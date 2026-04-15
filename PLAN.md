# MECE 知识聚合思维导图 — Obsidian 插件方案

## 一、项目背景

将过往积累的大量知识文档通过 AI 打散重组，按 MECE 原则（主题→类别→观点类型）分类，以交互式思维导图呈现，逐层下钻到源文件原文。做成 **Obsidian 插件**，直接在 Obsidian 内使用。

### 为什么选择 Obsidian 插件

| 优势 | 说明 |
|------|------|
| 零摩擦 | Vault 里的 .md 文件直接作为数据源，写完笔记即可分析，无需手动上传 |
| 无需部署 | 不需要服务器、数据库，插件本地运行 |
| 原生跳转 | 点击知识点来源 → 直接跳转到 Obsidian 中的源笔记 |
| 生态融合 | frontmatter、标签、[[双链]] 天然可用 |

---

## 二、技术选型详细说明

### 2.1 Obsidian Plugin API

| 技术 | 用途 | 说明 |
|------|------|------|
| **Obsidian Plugin API** | 插件框架 | Obsidian 官方提供的插件开发接口。插件用 TypeScript 编写，核心是继承 `Plugin` 类，在 `onload()` 中注册功能。提供文件读写、视图管理、设置页、命令面板等能力 |
| **ItemView** | 自定义视图 | Obsidian 的自定义标签页 API。继承 `ItemView` 类可以创建自己的视图面板（类似笔记编辑器那样的标签页），我们用它来承载思维导图 |
| **PluginSettingTab** | 设置页面 | Obsidian 的设置页 API。在「设置 → 第三方插件」中展示配置界面，用来配置 AI 提供商、API Key 等 |

### 2.2 构建工具

| 技术 | 用途 | 说明 |
|------|------|------|
| **TypeScript** | 开发语言 | JavaScript 的超集，增加了类型系统。Obsidian 插件官方推荐用 TS 开发，有完整的类型定义文件 |
| **esbuild** | 打包构建 | 极快的 JS/TS 打包工具（比 webpack 快 100 倍）。将所有 TS 源码和依赖打包成一个 `main.js` 文件，这是 Obsidian 插件的标准构建方式 |

### 2.3 可视化

| 技术 | 用途 | 说明 |
|------|------|------|
| **D3.js v7** | 思维导图渲染 | 最强大的数据可视化库。我们用它的 `d3.tree()` 布局算法 + SVG 渲染来画径向（放射状）思维导图。支持缩放、平移、动画等交互。类似 XMind 的中心发散式布局 |

**为什么选 D3.js 而不是其他：**
- ✅ 完全控制布局和样式，可实现精确的径向树布局
- ✅ 原生支持 SVG，渲染性能好
- ✅ 丰富的动画和交互 API（缩放、拖拽、过渡）
- ❌ 学习曲线较陡，但对于这个项目的需求是最合适的

其他备选：
- `markmap`：更简单但自定义能力弱
- `vis.js`：网络图更强但树形图不如 D3
- `reactflow`：依赖 React，在 Obsidian 插件中引入 React 过重

### 2.4 AI 集成

| 技术 | 用途 | 说明 |
|------|------|------|
| **fetch() API** | HTTP 请求 | 浏览器/Node.js 原生的网络请求 API。Obsidian 插件环境中全局可用。直接用 fetch 调用各家 AI 的 REST API，**不需要安装任何 AI SDK**，减少依赖体积 |
| **Claude API** | AI 提供商之一 | Anthropic 的 Claude 模型。通过 `https://api.anthropic.com/v1/messages` 接口调用。需要用户提供 API Key |
| **OpenAI API** | AI 提供商之一 | OpenAI 的 GPT 系列模型。通过 `https://api.openai.com/v1/chat/completions` 接口调用。支持 JSON mode 确保结构化输出 |
| **Ollama** | AI 提供商之一 | 本地大模型运行工具。在本机运行开源模型（如 Llama、Qwen 等），通过 `http://localhost:11434/v1/chat/completions`（OpenAI 兼容格式）调用。**完全免费、离线可用、数据不出本机** |
| **DeepSeek API** | AI 提供商之一 | DeepSeek 的大模型。通过 `https://api.deepseek.com/v1/chat/completions` 接口调用（OpenAI 兼容格式）。支持 deepseek-chat（通用对话）和 deepseek-reasoner（推理增强）两个主要模型。需要用户提供 API Key |

**Provider 工厂模式：** 定义统一的 `AIProvider` 接口，四个提供商各自实现。用户在设置页选择使用哪个，运行时通过工厂函数创建对应实例。切换 AI 只需改设置，不改代码。

**Provider 复用策略：** 由于 Ollama 和 DeepSeek 均对齐 OpenAI Chat Completions 格式，两者的 Provider 可直接继承 OpenAI Provider，仅覆写 `baseUrl` 和认证逻辑，减少重复代码。

### 2.5 数据存储

| 技术 | 用途 | 说明 |
|------|------|------|
| **JSON 文件** | 持久化存储 | 不用任何数据库。知识点和分类树全部存在一个 `knowledge-store.json` 文件中，放在 `.obsidian/plugins/` 目录下。Obsidian 的 `loadData()`/`saveData()` API 原生支持 JSON 读写。**含 schema version 字段**，启动时做兼容性检查，必要时自动迁移旧版数据 |
| **内容 Hash** | 增量检测 | 对每个已处理的文件内容计算 hash 值。下次扫描时比对 hash，只重新处理内容有变化的文件，避免重复调用 AI 浪费 token。同时记录每个文件的处理状态和已处理 chunk 数，支持中断后断点续传 |

---

## 三、系统架构

```
┌─────────────────────────────────────────────┐
│                  Obsidian                     │
│                                               │
│  ┌─────────────┐    ┌──────────────────────┐ │
│  │ Settings Tab │    │   MindMap View (D3)  │ │
│  │             │    │                      │ │
│  │ • AI Provider│    │  中心 → 主题 → 类别   │ │
│  │ • API Key   │    │    → 观点 → 详情面板   │ │
│  │ • 扫描范围   │    │    → 跳转源文件       │ │
│  └─────────────┘    └──────────────────────┘ │
│                                               │
│  ┌───────────────────────────────────────┐   │
│  │            Plugin Core                 │   │
│  │                                       │   │
│  │  Vault Scanner ──→ Text Chunker       │   │
│  │       │                  │            │   │
│  │       ▼                  ▼            │   │
│  │  增量检测(hash)    AI 知识点提取       │   │
│  │  + 孤儿清理       (并发+重试+断点)    │   │
│  │                         │            │   │
│  │                         ▼            │   │
│  │                   MECE 增量分类器     │   │
│  │                   (分批+骨架摘要)     │   │
│  │                         │            │   │
│  │                         ▼            │   │
│  │              knowledge-store.json     │   │
│  └───────────────────────────────────────┘   │
│                      ↕ fetch()                │
└──────────────────────┬────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   Claude API     OpenAI API     Ollama(本地)
                       ▲
                       │
                  DeepSeek API
              (均走 OpenAI 兼容格式)
```

---

## 四、数据模型

```typescript
// 知识库总数据结构
interface KnowledgeStore {
  version: number;                          // schema 版本号，用于数据迁移兼容
  lastUpdated: string;
  documents: {                              // 已处理的文档记录
    [filePath: string]: {
      hash: string;                         // 内容hash，用于增量检测
      processedAt: string;
      status: 'completed' | 'partial';      // 支持断点续传：partial 表示未完整处理
      processedChunks?: number;             // 已处理的分块数（断点续传用）
    }
  };
  knowledgePoints: KnowledgePoint[];        // 所有提取的知识点
  categoryTree: CategoryNode;               // MECE 分类树根节点
}

// 单个知识点
interface KnowledgePoint {
  id: string;
  content: string;                        // AI 提炼的知识点摘要
  sourceFile: string;                     // 来源文件在 Vault 中的路径
  sourceQuote: string;                    // 原文引用
  sourcePosition: { start: number; end: number }; // 原文在文件中的位置
  categoryIds: string[];                  // 归属的分类节点ID
  classified: boolean;                    // 是否已完成分类（支持增量分类）
}

// 分类树节点（递归结构）
interface CategoryNode {
  id: string;
  name: string;                           // 节点关键词（导图上显示的文字）
  level: 'theme' | 'category' | 'viewpoint'; // 三层：主题/类别/观点类型
  children: CategoryNode[];               // 子节点
  knowledgePointIds: string[];            // 关联的知识点（叶节点才有）
}
```

---

## 五、插件项目结构

```
obsidian-mece-knowledge/
├── manifest.json                # Obsidian 插件元数据（名称、版本、最低Obsidian版本）
├── package.json                 # npm 依赖管理
├── tsconfig.json                # TypeScript 编译配置
├── esbuild.config.mjs           # esbuild 打包配置 → 输出 main.js
├── styles.css                   # 插件全局样式（导图、面板、设置页）
│
├── src/
│   ├── main.ts                  # 🔌 插件入口（extends Plugin）
│   │                            #    注册视图、命令、设置页、Ribbon图标
│   ├── settings.ts              # ⚙️ 设置页（extends PluginSettingTab）
│   │                            #    AI配置、扫描范围、测试连接
│   ├── types.ts                 # 📐 全局类型定义
│   │
│   ├── ai/                      # 🤖 AI 抽象层
│   │   ├── types.ts             #    AIProvider 接口定义 + parseJSON 输出保障
│   │   ├── factory.ts           #    根据设置创建对应 Provider
│   │   ├── providers/
│   │   │   ├── claude.ts        #    Claude 实现 (fetch → Anthropic API, tool_use)
│   │   │   ├── openai.ts        #    OpenAI 实现 (fetch → OpenAI API, JSON mode)
│   │   │   ├── ollama.ts        #    Ollama 实现 (继承 OpenAI, 覆写 baseUrl)
│   │   │   └── deepseek.ts      #    DeepSeek 实现 (继承 OpenAI, 覆写 baseUrl)
│   │   ├── prompts.ts           #    提取/分类的 Prompt 模板（含 few-shot 示例）
│   │   └── chunker.ts           #    文本分块器（~2000字/块，200字重叠）
│   │
│   ├── core/                    # ⚡ 核心处理逻辑
│   │   ├── scanner.ts           #    Vault 扫描器（增量检测 + 排除规则 + 孤儿清理）
│   │   ├── extractor.ts         #    知识点提取流水线（并发队列 + 重试 + 断点续传）
│   │   ├── categorizer.ts       #    MECE 增量分类器（分批 + 骨架摘要）
│   │   └── store.ts             #    knowledge-store.json 读写（含 schema 版本迁移）
│   │
│   └── ui/                      # 🎨 界面组件
│       ├── mindmap.ts           #    D3.js 径向思维导图
│       ├── detail-panel.ts      #    知识点详情面板
│       └── progress-modal.ts    #    处理进度弹窗
│
│── src/views/
│   └── MindMapView.ts           # 📊 思维导图标签页（extends ItemView）
```

**构建产物（安装到 Obsidian 的文件）：**
```
.obsidian/plugins/obsidian-mece-knowledge/
├── main.js              # esbuild 打包的单文件（所有代码+D3依赖）
├── manifest.json        # 插件元数据
├── styles.css           # 样式
├── data.json            # 设置数据（AI配置等，Obsidian自动管理）
└── knowledge-store.json # 知识库数据（运行时生成）
```

---

## 六、实施阶段

### 阶段一：插件脚手架 + 设置页
- 初始化项目、配置 esbuild 构建
- Plugin 入口：注册视图、命令、设置页
- 设置页：AI Provider 下拉选择、API Key 输入、扫描范围配置、测试连接按钮
- 注册命令面板命令：打开导图、扫描Vault、重建知识库

### 阶段二：AI 抽象层
- 定义 `AIProvider` 接口（提取 + 分类两个方法）
- 实现三个 Provider（Claude / OpenAI / Ollama），统一用 fetch 调用
  - Ollama Provider 继承 OpenAI Provider，仅覆写 baseUrl 和认证逻辑，减少重复代码
  - Claude 使用 `tool_use` 确保结构化输出，OpenAI/Ollama 使用 `response_format: { type: "json_object" }`
- 文本分块器：按段落分块，约2000字/块，200字重叠保持上下文连贯
- 编写提取和分类的 Prompt 模板（含 few-shot 示例稳定输出格式）
- **AI 输出保障**：Provider 层统一实现 `parseJSON()` 后处理——剥离 markdown 代码块包装、处理截断 JSON、校验必要字段，解析失败时自动重试一次

### 阶段三：Vault 扫描 + 知识提取
- Vault 扫描器：读取所有 .md 文件，计算 hash 做增量检测
  - 支持**可配置的排除规则**：排除指定目录（如 `templates/`、`daily/`）和 frontmatter 标记的文件
  - **孤儿数据清理**：对比磁盘文件 vs store 记录，已删除/已改名的文件对应的知识点自动标记为孤儿，提示用户清理
- 提取流水线：读文件 → 分块 → AI 逐块提取知识点 → 存入 store
  - **大文件保护**：单文件超过 2 万字时警告用户，建议拆分；超过 5 万字时自动跳过并记录
  - **并发控制**：使用任务队列，最多同时发 3 个 AI 请求，避免触发 rate limit
  - **指数退避重试**：请求失败后重试最多 3 次（间隔 1s → 2s → 4s）
  - **断点续传**：每个文件处理完一个 chunk 就持久化进度（`processedChunks`），中断后从上次位置继续
- 处理进度弹窗：显示当前处理文件名、进度百分比、已用 token 估算

### 阶段四：MECE 分类
- **增量分类策略**（避免全量重传导致 token 爆炸和上下文溢出）：
  1. 筛选 `classified: false` 的知识点作为本轮待分类集合
  2. 将分类树**骨架摘要**（每层仅传节点 id + name + description，不传关联知识点内容）+ 待分类知识点发送给 AI
  3. AI 先尝试将知识点归入已有分类，无法归入的再扩展新分类节点
  4. 返回：知识点 → 分类映射 + 新增分类节点列表
  5. 分类完成后将知识点 `classified` 标记为 `true`
- **分批处理**：待分类知识点过多时（> 50 条），分批发送，每批 30~50 条，逐批合并结果
- 更新 knowledge-store.json

### 阶段五：思维导图可视化
- MindMapView 作为 Obsidian 标签页
- D3.js 径向树：中心 → 主题 → 类别 → 观点类型，逐层点击展开
- 叶节点详情面板：知识点摘要、原文引用（高亮）、点击跳转源笔记
- 缩放/平移、主题颜色区分、节点大小反映知识量
- **按需渲染**：只渲染当前展开层级的节点，未展开层级不生成 DOM，避免节点过多导致 SVG 卡顿
- **叶节点聚合**：当某个分类下知识点过多（> 20 条）时，显示数量 badge，点击后展开虚拟滚动列表

### 阶段六：体验优化
- 监听文件变化提示重新扫描
- Ribbon 快捷图标、右键菜单
- 导图内搜索关键词
- 导出分类结果为 Markdown（带 [[双链]]）

---

## 七、关键依赖

```json
{
  "devDependencies": {
    "obsidian": "latest",          // Obsidian API 类型定义（仅开发时用）
    "@types/node": "^22",          // Node.js 类型
    "typescript": "^5.6",          // TypeScript 编译器
    "esbuild": "^0.24",           // 打包工具
    "builtin-modules": "^4"       // esbuild 排除 Node 内置模块
  },
  "dependencies": {
    "d3": "^7"                    // 数据可视化（会被打包进 main.js）
  }
}
```

> **说明：** AI SDK（@anthropic-ai/sdk、openai 等）**不需要安装**。插件中直接用全局 `fetch()` 调 REST API，这样打包体积更小，也避免了 Node.js 特有依赖在 Obsidian 环境中的兼容问题。

---

## 八、核心数据流

```
用户写笔记/导入文档到 Vault
        │
        ▼
  ① Vault Scanner 扫描
     ├── 获取所有 .md 文件（排除配置中的忽略目录）
     ├── 计算内容 hash
     ├── 过滤出「新增/修改」的文件
     └── 检测已删除文件 → 标记孤儿知识点
        │
        ▼
  ② Text Chunker 分块
     ├── ~2000字/块，200字重叠
     └── 大文件保护（>2万字警告，>5万字跳过）
        │
        ▼
  ③ AI Provider 提取知识点（带并发控制 + 重试 + 断点续传）
     ├── 每个块 → AI → 返回多个知识点
     ├── 保留原文引用和位置信息
     ├── 输出 JSON 经 parseJSON() 校验和兜底
     └── 每个 chunk 完成后立即持久化进度
        │
        ▼
  ④ MECE Categorizer 增量分类
     ├── 输入：未分类知识点 + 分类树骨架摘要
     ├── AI 先匹配已有分类，匹配不上再扩展
     ├── 分批处理（每批 30~50 条）
     └── 输出：更新后的三层 MECE 树
        │
        ▼
  ⑤ 保存到 knowledge-store.json（含 schema version）
        │
        ▼
  ⑥ MindMap View 渲染
     ├── D3.js 径向思维导图（按需渲染，只渲染展开层）
     ├── 点击展开子层
     └── 叶节点 → 详情面板 → 跳转源文件
```

---

## 九、验证方式

1. **插件加载**：构建后复制到 `.obsidian/plugins/`，启用插件，确认设置页正常
2. **AI 连接**：配置 API Key → 点击「测试连接」→ 三个 Provider 均返回成功
3. **知识提取**：执行扫描命令 → knowledge-store.json 中出现知识点数据
4. **断点续传**：扫描过程中手动中断 → 重新扫描 → 从上次中断位置继续而非重头开始
5. **重试机制**：模拟网络超时 → 观察日志中出现重试记录 → 最终成功完成
6. **MECE 分类**：触发分类 → 生成三层树，知识点正确归类；新增知识点后再次分类 → 树增量扩展而非重建
7. **思维导图**：打开导图标签页 → 径向布局正确 → 逐层点击可展开 → 节点过多时按需渲染不卡顿
8. **源文件跳转**：点击来源链接 → 在 Obsidian 中打开对应笔记
9. **增量测试**：新建笔记后重新扫描 → 只处理新文件
10. **孤儿清理**：删除已处理过的笔记 → 重新扫描 → 提示存在孤儿知识点
11. **数据迁移**：手动降低 knowledge-store.json 的 version → 重启插件 → 自动完成迁移
