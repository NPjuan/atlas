# ARCHITECTURE.md — Atlas 知识分类插件（技术说明）

给未来接手这个项目的 AI / 开发者看的。不是教程，是**地图**：告诉你模块在哪、职责是什么、数据怎么流、哪些决策已经拍板、哪些坑已经踩过。

---

## 1. 项目定位

Obsidian 插件，提供"AI 自动化分类体系建立 + 笔记归档到文件夹"一条龙能力。以**整理笔记**为核心（不是做思维导图展示），AI 只是辅助初始化和增量归类的工具。设计哲学：

- **零侵入**：只改笔记 frontmatter 的 `tags` 字段，不在笔记里插标记、不生成任何派生文件
- **单 schema**：整个插件只有一份全局分类体系（`TaxonomySchema`），UI 的"文件夹过滤"只决定展示/操作范围，不会产生独立的子 schema
- **分类 = 目录**：重命名/删除分类 → 同步 Vault 文件夹；AI 归类后自动把笔记迁移到 tag 对应的文件夹
- **拖拽立即生效**：不攒 Patch、不弹确认，改动直接 `processFrontMatter` 写回
- **纯函数优先**：`src/core/**` 下任何"算法、字符串、树变换"都写成纯函数并用 vitest 覆盖；Obsidian API 相关代码只做编排，不写算法

---

## 2. 目录结构

```
src/
├─ main.ts                     插件入口：注册命令、视图、监听器；编排 schema 生成 / AI 归类 / 文件迁移
├─ settings.ts                 设置页
├─ types.ts                    全局类型：TaxonomyNode/Schema, MECEStore, MECESettings, TagPatch…
├─ ai/
│  ├─ types.ts                 AIProvider 接口 + collectTaxonomyPathSet / splitPaths 等纯工具
│  ├─ factory.ts               按 settings.aiProvider 实例化 provider
│  ├─ prompts.ts               所有 Prompt 模板（Schema 生成 / 约束式归类 / 开放式 / PlanTopics）
│  └─ providers/
│     ├─ openai.ts             基类（JSON mode + AbortController 120s）
│     ├─ claude.ts             Anthropic /v1/messages
│     ├─ deepseek.ts           OpenAI 兼容
│     └─ ollama.ts             OpenAI 兼容（本地）
├─ core/
│  ├─ store.ts                 StoreManager + 纯函数 migrateRawStore（v1 多 scope → v2 单 schema）
│  ├─ schema-generator.ts      全量扫描 → token 估算 → 降级 → 调 AI 生成 TaxonomySchema
│  ├─ tagger.ts                generatePatches 编排；Phase 0/1.6/1 的调度
│  ├─ taggers/                 逐篇 / 批量打标签策略
│  │  ├─ types.ts              TaggerStrategy 接口 + normalize 兜底
│  │  ├─ sequential.ts         一篇一篇调 AI
│  │  ├─ batch.ts              一批篇 N 篇调 AI，失败降级到 sequential
│  │  └─ factory.ts            按 settings.taggingStrategy 选策略
│  ├─ tag-ops.ts               树操作纯函数：updatePaths / findNodeById / collectAllFullPaths / collectAllIds / rewriteDiskTags …
│  ├─ taxonomy-scope.ts        切片视图纯函数：findScopeNode / buildScopeViewSchema / replaceScopeNode / collectAllFullPaths(taxonomy)
│  ├─ file-organizer.ts        文件物理迁移规划：planFileMoves / computeTargetPath / 冲突策略
│  └─ *.test.ts                对应单测
├─ ui/
│  ├─ components/              React 组件（挂在 Obsidian Modal / ItemView 里）
│  │  ├─ TagMapPanel.tsx       主面板容器（整理视图 / 脑图视图 Tab 切换）
│  │  ├─ UnifiedOrganizer.tsx  核心：分类树 + 笔记 chips + 拖拽
│  │  ├─ SchemaTree.tsx        SchemaEditor 用的树形编辑器
│  │  ├─ SchemaEditorModal.tsx Schema 编辑弹窗（基于 SchemaTree）
│  │  ├─ PatchReviewModal.tsx  AI 归类 Review（Tab：按分类 / 按文件）
│  │  ├─ FileMoveReviewModal.tsx 文件迁移 Review（多 tag 选主路径、冲突 rename/overwrite/skip）
│  │  ├─ ReorganizeModal.tsx   重新归类配置弹窗
│  │  ├─ ForceGraphView.tsx    脑图视图（force-graph 引擎的 React 挂载点）
│  │  └─ EmptyState.tsx        未配置/无 schema 的引导空态
│  ├─ tag-mindmap.ts           force-graph 引擎封装（缩放/折叠/展开 API）
│  └─ progress-modal.ts        进度条 Modal（支持 indeterminate 模式）
├─ views/
│  └─ TagMapView.ts            Obsidian ItemView，挂载 TagMapPanel React root
└─ demo/                       独立 HTML，用 CDN React 预览关键 UI（开发调试用）
```

---

## 3. 数据模型

### 3.1 Store（持久化在 `data.json`）

```ts
interface MECEStore {
  version: 2;
  taxonomy: TaxonomySchema | null;          // 全局唯一的分类体系
  processedFiles: Record<string, {          // 增量检测用
    hash: string;
    processedAt: string;
  }>;
  settings: MECESettings;                   // 插件设置
}

interface TaxonomySchema {
  version: number;
  createdAt: string;
  updatedAt: string;
  maxDepth: number;                          // 默认 3
  rootName: string;                          // 如 "全部"
  nodes: TaxonomyNode[];
}

interface TaxonomyNode {
  id: string;                                // 随机生成，用于 UI 定位
  name: string;                              // 显示名，如 "认识论"
  fullPath: string;                          // 如 "哲学/认识论"
  description?: string;                      // AI 用来更准确选分类
  children: TaxonomyNode[];
}
```

**关键不变量**：
- `fullPath` 永远是从 schema root（不含 rootName）起算：顶层节点 fullPath = name；子节点 fullPath = parent.fullPath + "/" + name
- 改名/移动节点时必须同步重写整棵子树的 fullPath（见 `updatePaths` / `rewritePaths`）
- `id` 永不复用；删除节点后 id 丢弃

### 3.2 Settings（`types.ts:MECESettings`）

关键字段：
- `aiProvider`: `'claude' | 'openai' | 'deepseek' | 'ollama'`
- `apiKeys: Record<provider, string>` / `models: Record<provider, string>` — 按 provider 独立保存
- `apiKey / model` — 兼容字段，永远跟当前 provider 同步
- `schemaContextMode`: `'full' | 'first-500' | 'title-only'` — Schema 生成时每篇笔记送多少内容
- `classificationMode`: `'mece' | 'custom'`
- `maxTagsPerFile`: 默认 3
- `tagPrefix`: 全部写入的 tag 自动加前缀
- `defaultReorganizeIntensity`: `'conservative' | 'balanced' | 'aggressive'`
- `taggingStrategy`: `'sequential' | 'batch' | 'auto'`
- `autoOrganizeFilesAfterTagging`: 归类后自动迁移文件
- `excludeDirs`: 扫描时跳过的目录
- `maxFileCharsSkip`: 超长笔记 AI 只读开头

---

## 4. 关键流程

### 4.1 生成分类体系（Schema 生成）

入口：`MECEPlugin.generateSchema(useCurrentFolder)` → `doGenerateSchema`

```
1. 选范围（可选）→ getTargetFiles()
2. schema-generator.generateTaxonomySchema:
     - 读所有目标文件（按 schemaContextMode 裁剪内容）
     - 估算 token，超过阈值自动降级 content mode 并 Notice 提示
     - prompts.buildSchemaGenerationPrompt → provider.generateTaxonomy
     - 校验：如果 AI 返回空 nodes / 层级超 maxDepth，报错
3. storeManager.setTaxonomy(newSchema)
4. 是 reorganize（已有 schema）→ 继续走 tagFiles 做 Patch Review
   首次生成 → 直接进入归类流程
```

### 4.2 AI 归类（Tag Files）

入口：`MECEPlugin.tagFiles(files, intensity?)`

```
1. 拿 store.taxonomy；没有则 Notice 提示先生成
2. core/tagger.generatePatches(files, store, provider, settings, taxonomy, options):
     Phase 0 (batch 策略才有): 并行把每篇笔记摘要成 1-2 句
     Phase 1.6: provider.planTaxonomyTopics → 获取顶层主题规划（防 AI 偷懒只给顶层 tag）
     Phase 1: TaggerStrategy.tag(files, ...) → 返回 TagPatch[]
       防御 1: normalize 规范化所有 AI 返回的 paths（大小写、分隔符、修剪）
       防御 2: 路径必须在 taxonomy 或 AI 建议的新分类内，否则丢弃
       防御 3: 拒绝光秃顶层 tag（如只给 "前端开发"，它有子分类却没指定哪个）
3. PatchReviewModal：用户勾选接受
4. applyPatches → 写 frontmatter + 更新 processedFiles
5. 接受的新分类 → addCategoriesToSchema → setTaxonomy
6. 默认自动 triggerAutoOrganize → 进入 4.3 文件迁移
```

### 4.3 文件迁移（Organize by Category）

入口：`MECEPlugin.organizeFilesByCategory(scopeFolderPath?)`

```
1. 扫描 scope 下笔记 + 它们的 tags（含 frontmatter 原始值）
2. core/file-organizer.planFileMoves(inputs, existingFiles):
     - 多 tag 笔记：primaryTag 默认取第一个 tag（UI 让用户选）
     - computeTargetPath = primaryTag.replaceAll(':', '/') + '/' + fileName
     - 冲突检测：目标已存在 → action=rename（加 "-2"）/ overwrite / skip
3. FileMoveReviewModal 让用户确认
4. executeFileMoves:
     - 按需 vault.createFolder 建中间目录
     - TFile rename 到目标路径；overwrite 时先删旧文件
```

### 4.4 文件夹 = 目录 同步

三个联动：
- **分类重命名** → UnifiedOrganizer 调 `fileSystemSync.renameFolder(oldPath, newPath)` → `plugin.renameFolderPath` 用 `app.fileManager.renameFile` 递归改名（Obsidian 会同步更新笔记里对该路径的链接）
- **分类删除** → `deleteFolderMoveNotesToRoot` 把该文件夹下的笔记全移到 Vault 根，然后删空文件夹
- **新建分类** → `ensureFolder` 按 `fullPath` 递归建目录

### 4.5 切片视图（Scope Slice）

入口：`TagMapPanel` 监听 `folderFilter` 变化

```
rootTaxonomy = storeManager.getTaxonomy()
scopeNode = taxonomy-scope.findScopeNode(rootTaxonomy, folderFilter)
           （递归遍历，按 fullPath 严格匹配任意层级节点）

taxonomy = folderFilter
  ? (scopeNode ? buildScopeViewSchema(rootTaxonomy, scopeNode) : null)
  : rootTaxonomy

isSliceMode = !!folderFilter && !!rootTaxonomy
```

**写回**：`handleSchemaChange / handleRootRename` 在切片模式下调 `replaceScopeNode(rootTaxonomy, scopeNode.id, newName, newChildren)` 把视图改动透明写回全局 taxonomy。

**切片未命中**：`rootTaxonomy` 有值但 `scopeNode` 为 null → 渲染"此文件夹没有对应分类"提示 + "切回 Vault"按钮。

---

## 5. AI Provider 层

### 5.1 接口（`src/ai/types.ts`）

```ts
interface AIProvider {
  name: string;
  generateTaxonomy(files, settings, rootName): Promise<TaxonomySchema>;
  suggestTagsConstrained(file, taxonomy, settings, context?): Promise<{ paths: string[]; suggestedNewCategories?: SuggestedCategory[] }>;
  suggestTagsConstrainedBatch?(files, taxonomy, settings, context?): Promise<Map<string, { paths; suggestedNewCategories? }>>;
  suggestTags(file, settings): Promise<string[]>;     // 开放式（无 schema）
  summarizeFile?(file, settings): Promise<string>;     // Phase 0 摘要
  planTaxonomyTopics?(files, taxonomy, settings): Promise<PlanTopicsResult>;
}
```

### 5.2 铁律（调用 AI 必须遵守）

1. **JSON mode + 顶层数组 = 卡死**。OpenAI 兼容 API（含 DeepSeek / Ollama）在 `response_format: json_object` 下必须返回对象；数组要包进 `items` 之类的 key 里。parser 侧兼容 `result.items / result.results / result.data`。
2. **所有 fetch 必须带 AbortController timeout**（当前 120s）。DeepSeek / Ollama / 代理层卡死时这是唯一的逃生出口。
3. **Prompt 用 paths 单字段**（不分 tags / newCategories）。后端 `splitPaths(paths, taxonomy)` 按是否在 taxonomy 里判定是"选中的"还是"新建议的"。
4. **语气克制**：prompts 写"如果合适"、"宁缺毋滥"，避免 AI 强行打标签。

### 5.3 Prompt 主题

- `buildSchemaGenerationPrompt`: 全量笔记概览 → 产出 3 层 MECE 分类树
- `buildConstrainedTaggingPrompt`: 单篇 + schema → 选分类路径（可建议新分类）
- `buildBatchConstrainedTaggingPrompt`: 多篇 + schema → 批量选
- `buildPlanTopicsPrompt`: schema + 全部摘要 → 顶层主题分布规划（防偷懒）
- `buildOpenTaggingPrompt`: 单篇 → 开放式打 tag（无 schema 场景）

---

## 6. 纯函数约定

**强制**：`src/core/**` 下任何算法/字符串/树操作必须是纯函数，文件末尾或同目录放 `*.test.ts` 用 vitest 覆盖。

**当前覆盖的纯函数**（~150 单测）：
- `core/tag-ops.ts`: tagAlreadyPrefixed / findScopeForFile / normalizeTagToFullPath / toViewTags / tagMatchesPath / tagIsUnderPath / updatePaths / findNodeById / findAndModify / findAndRemove / insertChild / collectFullPaths / collectAllFullPaths / collectAllIds / rewriteDiskTags
- `core/taxonomy-scope.ts`: rewritePaths / findScopeNode / replaceScopeNode / buildScopeViewSchema / collectAllFullPaths(taxonomy)
- `core/file-organizer.ts`: planFileMoves / computeTargetPath / collectFoldersToCreate / 冲突处理
- `core/store.ts`: migrateRawStore（v1 → v2 迁移）
- `core/taggers/types.ts`: normalizeTagPathResponse 兜底
- `core/taggers/factory.ts`: chooseStrategy
- `core/taggers/batch.ts`, `sequential.ts`: 策略行为（含漏答降级、批失败降级）
- `ai/types.ts`: collectTaxonomyPathSet / splitPaths

**测试命令**：`npm test`（一次过）/ `npm run test:watch`（挂着开发用）。

**不测**：Obsidian API 相关代码（`app.fileManager.*` / Notice / Modal）。那是集成路径，靠手动回归。

---

## 7. UI 层约定

### 7.1 Obsidian ItemView + React 铁律

**绝不在 refresh 时 unmount React root**。反模式：`refreshView() { this.onOpen(); }` → 触发 container.empty() + root.unmount() → Obsidian 硬删 React 管的 DOM → React removeChild 失败抛 NotFoundError。

**正确做法**：React root 只首次 onOpen 创建；refresh 用 props 变化驱动重渲染（维护 `version` 计数器，`refreshView` 只递增并重 render）。根组件接收 `refreshKey` prop 驱动内部 useMemo 重算。

### 7.2 按钮 tooltip

Obsidian 会给有 `aria-label` 的按钮自动出原生 tooltip。若同时设 HTML `title`，浏览器会再出一个 → 两个 pop 重叠。**按钮只用 `aria-label`，不要叠 `title`**。

### 7.3 Icon 脱管 DOM 模式

`UnifiedOrganizer` 里的 `<Icon>` 组件用两层结构：React 管一个空 span（永远无子节点），通过 ref callback 在里面挂一个脱管 DOM，`setIcon` 操作这个脱管 DOM。React 卸载时只会删外层 span，脱管 DOM 随之被浏览器 GC，不会触发 removeChild 对账。—— 避免 React 19 strict mode 下和 Obsidian setIcon 冲突。

### 7.4 文件夹选择器

用 Obsidian 原生 `FuzzySuggestModal`（`FolderSuggestModal` 在 `main.ts`）。曾经尝试过自绘 React Tree 选择器，最终回退：自绘样式难跟主题完美融合，用户体感"丑"。**能用原生 Modal 就用原生**。

### 7.5 UnifiedOrganizer 树形连接线

`.mece-organizer-category` padding-left=8, `.mece-organizer-arrow` width=16 → **父级箭头中心 = 16px**。嵌套节点 class `.mece-organizer-node-nested`, padding-left: 20。竖线（::before）left: 16px 对齐父箭头中心；横线（::after）left: 16px, top: 15px, width: 12px 贴齐子 category 行中线。:last-child 时竖线高度限制为 14px。

---

## 8. 存储与迁移

### 8.1 v1 → v2 迁移（已完成）

旧：`taxonomies: Record<scope, TaxonomySchema>`，按文件夹 scope 存独立 schema。
新：`taxonomy: TaxonomySchema | null`，全局单一 schema。

迁移逻辑（`core/store.ts:migrateRawStore`）：
- 优先取 `taxonomies['root']`（老常量 ROOT_SCOPE_KEY）
- 回退取 `taxonomies['__vault__']`（更老的常量 LEGACY_VAULT_KEY）
- 其他子 scope 数据丢弃（用户可重新生成）

### 8.2 Settings 迁移

旧：`apiKey / model` 单值。
新：`apiKeys[provider] / models[provider]`，兼容字段 `apiKey / model` 永远跟当前 provider 同步。

---

## 9. 开发调试流程

- **测试 vault**：`test-vault/.obsidian/plugins/atlas-knowledge/` — Obsidian 直接加载这里。
- **自动同步**：`esbuild.config.mjs` watch 模式下每次编译完自动 cp `main.js / main.js.map / styles.css / manifest.json` 到上面的目录；`fs.watch` 同时监听 `styles.css / manifest.json`，改 CSS 也会立刻同步（不用手动触发）。
- **流程**：`npm run dev`（后台 watch）→ 改代码 → Obsidian `Cmd+P` → `Reload app`。
- **调试 Obsidian 控制台**：DevTools `Cmd+Option+I`，栈帧通过 main.js.map 反解到 `.tsx:行号`。
- **生产构建**：`npm run build`（压缩，不同步到 test-vault）。
- **Debug 构建**：`npm run build:debug`（未压缩 + sourcemap，也不同步）。

---

## 10. 已知约束 & 历史坑

### 10.1 AbortController timeout

所有 AI fetch 都必须带 120s timeout。DeepSeek / Ollama 偶尔会 hang，不 timeout 的话 UI 永远转圈。

### 10.2 JSON mode 和数组

OpenAI 兼容 API 的 `response_format: json_object` **不接受顶层数组**。违反会导致 DeepSeek 无限生成 / 后端 hang。Prompt 必须要求返回 `{items: [...]}` 这类包装对象。

### 10.3 React root 生命周期

Obsidian ItemView 的 `onOpen / onClose` 生命周期要和 React root 对应。refresh 绝不 unmount；只用 props + useMemo 驱动。

### 10.4 metadataCache vs vault.modify

监听笔记 tag 变化用 `metadataCache.on('changed'/'resolved')`，**不要**用 `vault.on('modify')`。`modify` 触发更早，此时 metadataCache 还是旧 frontmatter → loadNotes 会读到旧 tag → 覆盖掉刚才拖拽产生的乐观更新 → 笔记"跳回"原位置。

### 10.5 分类树 vs 目录树

当前策略：**重命名/删除/新建分类 都会同步改文件夹**。若用户关掉 `autoOrganizeFilesAfterTagging`，只是关掉"归类后的批量迁移"，不会关掉分类/目录同步。如果要做"只改 tag 不改文件"的模式，需要在 `UnifiedOrganizer` 的 `fileSystemSync` 调用处加开关。

---

## 11. 扩展指南

### 11.1 加新 AI Provider

1. `src/ai/providers/<name>.ts`：继承 `OpenAIProvider`（如果是 OpenAI 兼容）或从头实现 `AIProvider`
2. `src/ai/factory.ts` 加分支
3. `src/types.ts` 加 `AIProviderType`
4. `src/settings.ts` 加设置页选项（API Key 输入、模型 dropdown）
5. 测试用 `npm test` 跑一下 `ai/types.test.ts`，确保新 provider 的 splitPaths / normalize 行为和基类一致

### 11.2 加新纯函数

1. 放在 `src/core/<相关模块>.ts`
2. 同目录写 `<模块>.test.ts`，先写测试再写实现
3. `npm test` 全绿再 commit

### 11.3 加新命令 / 菜单项

`main.ts:onload()` 里 `this.addCommand({...})`。需要 targetFolder 范围的走 `chooseFolderThenTag` 模式。

### 11.4 改 Schema 结构

1. `src/types.ts` 改 `TaxonomyNode / TaxonomySchema`
2. `src/core/store.ts:migrateRawStore` 加 v2 → v3 迁移逻辑
3. `STORE_VERSION` 升到 3
4. 补迁移单测

---

## 12. 常用文件速查

| 想改 X | 去改 |
|---|---|
| 加命令 | `main.ts:onload` |
| AI Provider | `src/ai/providers/` + `src/ai/factory.ts` |
| Prompt | `src/ai/prompts.ts` |
| 分类树纯逻辑 | `src/core/tag-ops.ts` |
| 切片视图 | `src/core/taxonomy-scope.ts` |
| 文件迁移 | `src/core/file-organizer.ts` |
| 主面板 UI | `src/ui/components/TagMapPanel.tsx` |
| 整理器 UI | `src/ui/components/UnifiedOrganizer.tsx` |
| 样式 | `styles.css`（命名空间 `.mece-*`） |
| 设置页 | `src/settings.ts` |

---

_最后更新：2026-04-19。后续大改动请同步更新本文件。_
