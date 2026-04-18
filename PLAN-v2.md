# MECE 知识聚合插件 v2 — 方案设计

## 一、核心理念转变

### v1（已有）
```
AI 提取知识点 → 独立分类树 → 生成额外笔记文件 → Obsidian 图谱
```
问题：生成大量额外文件、知识点粒度太细、和原始笔记脱节。

### v2（新方案）
```
AI 给笔记打 Tag → 直接写入 frontmatter → 插件内 Tag 脑图交互式浏览
```
核心：**Tag 就是知识分类，笔记本身就是知识载体，不生成任何额外文件。**

---

## 二、用户工作流

```
1. 用户选择文件夹 + 分类方向（如 MECE）
2. AI 逐篇扫描笔记 → 读取已有 tag → 只补充缺失的 tag → 写入 frontmatter
3. 打开插件面板 → 选择查看的文件夹范围
4. Tag 脑图层层展开 → 最终点击到笔记链接
5. 用户手动改 tag → 面板实时更新
6. 以后新增笔记 → 再跑一次 AI 打标签（增量，只处理新/改的）
```

---

## 三、功能模块

### 3.1 AI 智能打标签（core/tagger.ts）

**输入**：
- 笔记内容
- 笔记已有的 tags
- 分类方向（MECE / 学科 / 自定义）
- Vault 中已有的所有 tag（供 AI 复用，避免近义重复）

**输出**：
- 需要新增的 tags 列表（不动已有的）

**策略**：
- 每篇笔记最终 1~5 个 tag
- 支持层级 tag：`哲学/认识论`、`哲学/伦理学`
- 已有 tag 能覆盖的维度不重复
- 复用 Vault 中已存在的 tag（避免"认识论"和"知识论"并存）
- tag 实事求是，不硬凑

**Prompt 策略**：
```
你是一个知识分类专家。

## 任务
给以下笔记打上分类标签（tag）。

## 分类方向
{classificationMode}（如：MECE 互斥穷尽分类）

## 规则
1. 每篇笔记 2~5 个 tag，宁少勿多
2. 使用层级 tag，格式如 "主题/细分"
3. 以下是笔记已有的 tag，不要生成含义重复的：{existingTags}
4. 以下是 Vault 中已存在的 tag，优先复用：{vaultTags}
5. 只输出需要**新增**的 tag，不要重复已有的
6. tag 要实事求是，能准确描述笔记内容

## 输出格式
{"newTags": ["主题/细分", "另一个tag"]}
```

### 3.2 Frontmatter 读写（core/frontmatter.ts）

**读取**：
- 解析笔记 frontmatter 中的 `tags` 字段
- 兼容 `tags: [a, b]` 和 `tags:\n  - a\n  - b` 两种格式

**写入**：
- 使用 Obsidian 的 `app.fileManager.processFrontMatter()` API
- 只追加新 tag，不修改/删除已有 tag
- 可选：添加 `mece-tagged: true` 标记已处理

### 3.3 Tag 脑图面板（views/TagMapView.ts + ui/tag-mindmap.ts）

**数据源**：
- 实时读取 Vault 中所有笔记的 tags（通过 `app.metadataCache`）
- 可筛选文件夹范围

**脑图结构**：
```
根节点（文件夹名 or "全部"）
├── 哲学
│   ├── 认识论
│   │   ├── 康德先验哲学.md    ← 点击打开笔记
│   │   └── 休谟因果论.md
│   └── 伦理学
│       ├── 功利主义.md
│       └── 义务论.md
├── 逻辑学
│   ├── 形式逻辑
│   │   └── 命题逻辑.md
│   └── 逻辑学基础.md
└── 未分类
    └── 随笔.md
```

**交互**：
- 默认只展示第一层 tag（主题级）
- 点击展开下一层
- 叶节点是笔记链接，点击跳转
- 支持搜索 tag
- 支持折叠/展开全部

**实时更新**：
- 监听 `metadataCache.on('changed')` 事件
- tag 变了就重建脑图数据（debounce）

### 3.4 插件面板（views/TagMapView.ts）

**布局**：
```
┌──────────────────────────────────────────────┐
│ [▶ AI 打标签] [🔄 刷新]    📂 哲学笔记 ▼   ⚙ │  ← 工具栏
├──────────────────────────────────────────────┤
│ ✅ DeepSeek · deepseek-chat                   │  ← AI 状态
├──────────────────────────────────────────────┤
│                                              │
│         Tag 脑图（D3.js 交互式）              │  ← 主区域
│                                              │
│   点击节点展开子分类 / 点击笔记名打开文件      │
│                                              │
├──────────────────────────────────────────────┤
│ 统计：42 篇笔记 · 15 个 tag · 3 篇未分类     │  ← 底部状态栏
└──────────────────────────────────────────────┘
```

**工具栏按钮**：
- **AI 打标签**：选文件夹 + 分类方向 → 开始处理
- **刷新**：手动刷新面板
- **文件夹选择器**：切换查看范围
- **设置**：跳转设置页

### 3.5 标签管理 CRUD（core/tag-manager.ts + ui/tag-manager-modal.ts）

> 核心原则：**Obsidian frontmatter 是唯一数据源**，插件不维护额外的标签数据库。所有操作最终都是批量修改笔记的 frontmatter。

#### 操作清单

| 操作 | 说明 | 影响范围 |
|------|------|----------|
| 📋 查看 | 标签总览 + 每个标签下的笔记数 | 只读 |
| ✏️ 重命名 | `哲学/认知论` → `哲学/认识论` | 所有含该 tag 的笔记 |
| 🔗 合并 | `认识论` + `知识论` → `哲学/认识论` | 两个 tag 下所有笔记 |
| ✂️ 拆分 | `哲学` → `哲学/东方` + `哲学/西方` | 需要用户手动指派（Phase 2） |
| 🗑️ 删除 | 从所有笔记中移除某个 tag | 所有含该 tag 的笔记 |
| ➕ 手动加 | 给指定笔记添加标签 | 单篇/多篇 |
| ➖ 手动删 | 从指定笔记移除标签 | 单篇/多篇 |
| 📦 批量 | 选中多篇笔记统一操作 | 选中的笔记 |

#### UI：标签管理 Modal

入口：脑图面板工具栏「🏷️ 管理标签」按钮

```
┌───────────────────────────────────────────────┐
│  🏷️ 标签管理                            [×]   │
├───────────────────────────────────────────────┤
│  🔍 搜索标签...                               │
├───────────────────────────────────────────────┤
│                                               │
│  ▸ 哲学 (18)                    [✏️][🗑️]      │
│    ▸ 认识论 (7)                 [✏️][🗑️]      │
│      · 经验主义 (3)             [✏️][🗑️]      │
│      · 理性主义 (2)             [✏️][🗑️]      │
│      · 先验哲学 (2)             [✏️][🗑️]      │
│    ▸ 伦理学 (6)                 [✏️][🗑️]      │
│    · 形而上学 (2)               [✏️][🗑️]      │
│  ▸ 逻辑学 (5)                   [✏️][🗑️]      │
│  · 心灵哲学 (2)                 [✏️][🗑️]      │
│                                               │
├───────────────────────────────────────────────┤
│  选中: 0 个标签                               │
│  [合并选中标签]  [批量删除]                    │
└───────────────────────────────────────────────┘
```

**交互说明**：
- 树形展示所有层级标签，括号里是笔记数
- 点击标签名 → 展开显示笔记列表，点击笔记名 → 跳转
- ✏️ 重命名 → 标签名变为输入框，回车确认，弹确认对话框显示影响笔记数
- 🗑️ 删除 → 确认对话框（只删 tag，不删笔记）
- 勾选 2+ 个标签 → 「合并选中标签」→ 选择目标名称

#### 技术实现

**标签索引（只读，从 metadataCache 构建）**：
```typescript
interface TagIndex {
  tagToFiles: Map<string, Set<string>>;  // tag → 文件路径集合
  fileToTags: Map<string, string[]>;     // 文件 → tag 列表
  tree: TagTreeNode;                      // 层级树（用于树形展示）
}
```

**标签写入（唯一写入口）**：
```typescript
async function modifyTagsInFile(app, filePath, changes: {
  add?: string[];
  remove?: string[];
  replace?: [string, string][];  // [旧tag, 新tag]
}): Promise<void>
// 底层使用 app.fileManager.processFrontMatter()
```

**上层操作封装**：
```typescript
renameTag(oldTag, newTag)    // 遍历含该 tag 的笔记，替换
mergeTags(sources, target)   // 多 tag 合并为一个
deleteTag(tag)               // 从所有笔记中移除
batchModifyTags(files, changes, onProgress)  // 带进度条
```

#### 关键设计决策

| 决策 | 方案 |
|------|------|
| 重命名时影响子标签吗？ | **是**，前缀匹配替换。`哲学` → `Philosophy` 则 `哲学/认识论` → `Philosophy/认识论` |
| 合并时子标签怎么办？ | **同时迁移**。合并 `知识论` → `认识论`，则 `知识论/经验主义` → `认识论/经验主义` |
| AI vs 手动冲突 | 只追加策略已避免。可选：`mece-ignore-tags` 黑名单防止 AI 加回被删 tag |
| 脑图上直接操作 vs 管理面板 | Phase 1 走独立 Modal，Phase 2 再加脑图右键菜单 |

#### 安全机制

- **确认对话框**：任何写操作先弹确认，显示影响笔记数
- **只改 tags 字段**：`processFrontMatter` 只动 `tags`，不碰其他字段
- **不删笔记**：删标签只删 tag，不删文件
- **去重保护**：写入前自动去重
- **Undo 支持**：Obsidian 的 `processFrontMatter` 支持撤销

#### 右键菜单集成（Phase 2）

- 脑图 tag 节点右键 → 重命名 / 删除 / 查看笔记列表
- 文件列表右键笔记 → 「MECE: 管理标签」→ 查看/添加/移除 tag

---

## 四、设置页（settings.ts）

### AI 配置（保留现有）
- AI 提供商 / API Key / 模型 / Ollama 地址

### 标签配置（新增）
| 设置项 | 说明 | 默认值 |
|---|---|---|
| 分类方向 | MECE / 学科分类 / 自定义 prompt | MECE |
| 每篇最多 tag 数 | AI 打 tag 的上限 | 5 |
| Tag 前缀 | 如 `mece/`，为空则不加前缀 | （空） |
| 排除目录 | 不处理的目录 | templates, daily, .obsidian |
| 自定义分类 prompt | 分类方向选"自定义"时使用 | （空） |

---

## 五、数据模型（极简）

### Store（plugin data.json）
```typescript
interface MECEStore {
  version: number;
  // 已处理文件的 hash（增量检测用）
  processedFiles: Record<string, {
    hash: string;
    taggedAt: string;
    tagCount: number;
  }>;
  // 设置
  settings: MECESettings;
}
```

不再需要：knowledgePoints、categoryTree、logs、summaries。

### 笔记侧（frontmatter）
```yaml
---
tags: [哲学/认识论, 批判性思维]
mece-tagged: true
mece-tagged-at: 2025-04-16T18:00:00Z
---
```

---

## 六、与 v1 的关系

| v1 模块 | v2 处置 |
|---|---|
| core/extractor.ts（知识点提取） | **删除**，改为 tagger |
| core/categorizer.ts（MECE 分类器） | **删除**，分类通过 tag 实现 |
| core/note-generator.ts（笔记生成） | **删除**，不再生成额外文件 |
| core/store.ts（知识库存储） | **大幅简化** |
| core/scanner.ts（文件扫描） | **保留**，复用增量检测逻辑 |
| ai/prompts.ts | **重写**，改为打标签 prompt |
| ai/factory.ts + providers/* | **保留**，AI 调用层不变 |
| views/MindMapView.ts | **重写**为 TagMapView |
| ui/mindmap.ts（D3 径向树） | **重写**为 tag 脑图 |
| ui/detail-panel.ts | **删除** |
| settings.ts | **扩展**，增加标签配置 |
| main.ts | **重构**，简化命令和流程 |
| types.ts | **简化** |

---

## 七、实施步骤

### Phase 1：核心管线（AI 打标签 → 写入 frontmatter）
1. 重写 `types.ts` — 简化数据模型
2. 新建 `core/tagger.ts` — AI 打标签逻辑
3. 新建 `core/frontmatter.ts` — frontmatter 读写
4. 重写 `ai/prompts.ts` — 打标签 prompt
5. 重构 `core/store.ts` — 极简化
6. 重构 `main.ts` — 新的命令和流程

### Phase 2：Tag 脑图面板
7. 新建 `ui/tag-mindmap.ts` — force-graph tag 脑图（增量展开/折叠）
8. 重写 `views/TagMapView.ts` — 新面板布局
9. 更新 `styles.css` — tag 脑图样式（Obsidian 暗色主题配色）

### Phase 3：标签管理 CRUD
10. 新建 `core/tag-manager.ts` — 标签索引构建 + 批量写入操作
11. 新建 `ui/tag-manager-modal.ts` — 标签管理 Modal（树形展示 + 搜索）
12. 实现 重命名 / 删除 / 合并 操作（带确认对话框 + 进度条）
13. 工具栏集成「🏷️ 管理标签」按钮

### Phase 4：体验打磨
14. 文件夹筛选器
15. 实时监听 tag 变化（metadataCache）
16. 设置页扩展（分类方向、排除目录等）
17. 脑图节点右键菜单（重命名/删除/查看笔记）
18. 笔记右键菜单（MECE: 管理标签）

### Phase 5：清理
19. 删除 v1 废弃代码（extractor/categorizer/note-generator/detail-panel）
20. 更新 PLAN.md / README

---

## 八、技术选型不变
- TypeScript + esbuild
- force-graph（vasturiano/force-graph，基于 D3-force 的力导向图，脑图渲染）
- AI: Claude / OpenAI / Ollama / DeepSeek（纯 fetch）
- Obsidian Plugin API（frontmatter 读写、metadataCache 监听）
