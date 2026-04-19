import type { ClassificationMode, TaxonomySchema, NoteOverview } from '../types';

// ============================================================
// V3 Prompt 模板 — Schema 生成 + 约束式打标签 + 开放式打标签
// ============================================================

const MODE_DESCRIPTIONS: Record<ClassificationMode, string> = {
  mece: 'MECE（Mutually Exclusive, Collectively Exhaustive）互斥穷尽分类：每个分类代表一个独立维度，分类之间不重叠，整体覆盖全部内容',
  discipline: '学科分类：按照学术学科体系分类',
  custom: '',
};

// ============================================================
// 1. Schema 生成 Prompt（全量笔记概览 → 分类树）
// ============================================================

export function buildSchemaGenerationPrompt(
  notes: NoteOverview[],
  maxDepth: number,
  classificationMode: ClassificationMode,
  customPrompt?: string,
): string {
  const modeDesc = classificationMode === 'custom' && customPrompt
    ? customPrompt
    : MODE_DESCRIPTIONS[classificationMode];

  const notesSummary = notes.map((n, i) => {
    let entry = `### 笔记 ${i + 1}: ${n.fileName}`;
    if (n.existingTags.length > 0) {
      entry += `\n已有标签: ${n.existingTags.join(', ')}`;
    }
    if (n.content) {
      entry += `\n${n.content}`;
    }
    return entry;
  }).join('\n\n');

  return `你是一个知识分类架构师。

## 任务

分析以下 ${notes.length} 篇笔记的全部内容，设计一个完整的分类体系（Taxonomy）。

## 分类规则
${modeDesc}

## 要求

1. **全局视角**：通读所有笔记后再设计分类，确保覆盖全部内容
2. **层级结构**：最多 ${maxDepth} 层，格式为 "一级/二级/三级"
3. **一级分类**：3~8 个，每个代表一个主要知识领域
4. **精简原则**：宁少勿多，只在内容确实丰富时才创建子分类
5. **命名规范**：中文，简洁明确，2~6 个字
6. **每个分类至少对应 2 篇笔记**才值得独立存在
7. 可为分类添加简短 description（帮助后续 AI 选择）

## 输出格式（严格 JSON）

{"taxonomy": [{"name": "分类名", "description": "可选描述", "children": [{"name": "子分类", "children": []}]}]}

## 示例

对于一组编程笔记：
{"taxonomy": [{"name": "前端", "description": "浏览器端技术", "children": [{"name": "React", "children": []}, {"name": "CSS", "children": []}]}, {"name": "后端", "children": [{"name": "数据库", "children": []}, {"name": "API设计", "children": []}]}]}

## 笔记内容（共 ${notes.length} 篇）

${notesSummary}`;
}

// ============================================================
// 2. 约束式打标签 Prompt（有 Schema 时使用）
// ============================================================

/** 重新归类的调整强度。控制 AI 多大程度上遵循笔记原有标签 */
export type ReorganizeIntensity = 'conservative' | 'balanced' | 'aggressive';

const INTENSITY_RULES: Record<ReorganizeIntensity, string> = {
  conservative: `- **保守策略（针对已有标签的笔记）**：如果笔记**已经有标签**，尽量保留——只有当原标签**明显错位**（如"React" 被打到"人工智能"）或**不在分类体系里**时才修改；如果原标签和你认为的差异不大，就保留原标签。
   - **对于没有标签的笔记（existingTags=无），按内容选最精准的分类，不要因为"保守"就随便挑一个看起来沾边的**`,
  balanced: `- **平衡策略**：如果原标签仍然合理，保留；否则用更合适的替换。
   - 可以适度调整到更精准的子分类`,
  aggressive: `- **重构策略**：忽略笔记现有的标签，完全根据内容重新判断最合适的分类。
   - 原标签仅供参考，不要因为它存在而倾向保留`,
};

export function buildConstrainedTaggingPrompt(
  content: string,
  sourceFile: string,
  existingTags: string[],
  taxonomy: TaxonomySchema,
  maxTags: number,
  intensity: ReorganizeIntensity = 'conservative',
  pendingNewCategories: string[] = [],
): string {
  // 将 taxonomy 扁平化为路径列表
  const paths: string[] = [];
  function collectPaths(nodes: typeof taxonomy.nodes, prefix: string) {
    for (const n of nodes) {
      const p = prefix ? `${prefix}/${n.name}` : n.name;
      paths.push(p);
      if (n.children) collectPaths(n.children, p);
    }
  }
  collectPaths(taxonomy.nodes, '');

  const existingStr = existingTags.length > 0
    ? existingTags.map(t => `"${t}"`).join(', ')
    : '（无）';

  const pendingBlock = pendingNewCategories.length > 0
    ? `\n本批次已建议过的新路径（能复用就复用，减少碎片化）：\n${pendingNewCategories.map(p => `- ${p}`).join('\n')}\n`
    : '';

  return `你在帮用户整理笔记库。请为这篇笔记选 1~${maxTags} 个分类路径。

## 可以选的现有分类

${paths.map(p => `- ${p}`).join('\n')}
${pendingBlock}
## 做法

1. 优先从现有分类里选到**具体层级**（选 "哲学/西方哲学/康德"，不要只选 "哲学"）。
2. 如果现有分类都不贴切，你可以新建路径。新路径格式：顶级/子级，两段。
3. 宁选一个精准的，不选三个泛的。不要硬塞——如果 React 笔记面前只有"人工智能"，那就新建"前端开发/React"，别硬塞进 AI。
4. 原标签：${existingStr}
${INTENSITY_RULES[intensity]}

## 输出

返回 JSON：\`{"paths": ["路径1", "路径2"]}\`

不管是现有路径还是新路径，都写在同一个 paths 数组里，后端会自动区分。

## 示例

正确：
- \`{"paths": ["哲学/西方哲学/康德"]}\` — 用现有精准路径
- \`{"paths": ["前端开发/React"]}\` — 新建两段路径
- \`{"paths": ["哲学/伦理学", "前端开发/工程化"]}\` — 两个不同领域都相关

错误：
- \`{"paths": ["哲学"]}\` — 只给顶层，太粗，没有归类价值
- \`{"paths": ["前端开发/React/Hooks/useState"]}\` — 路径太细，超过两段
- \`{"paths": []}\` — 空着不行，至少给一个

## 笔记

文件名：${sourceFile}

${content}`;
}

// ============================================================
// 批量约束式打标签 Prompt
// ============================================================

export interface BatchTaggingPromptInput {
  filePath: string;
  content: string;
  existingTags: string[];
  /** AI 预先生成的摘要；若提供则优先用摘要代替 content（省 token，更精准聚合） */
  summary?: string;
}

/**
 * 构造一次性给多篇笔记打标签的 prompt。
 * AI 返回 JSON 数组，每项包含 file / tags / newCategories。
 *
 * 相比逐篇调用，批量模式让 AI 看到所有笔记的全貌，能：
 * - 自动聚合新分类（不重复建议相近的）
 * - 对相似内容给出一致 tag
 * - 减少 API 调用次数
 */
export function buildBatchConstrainedTaggingPrompt(
  inputs: BatchTaggingPromptInput[],
  taxonomy: TaxonomySchema,
  maxTags: number,
  intensity: ReorganizeIntensity = 'conservative',
  /** 单篇笔记内容截断长度，防止 prompt 过长；默认 1500 字符 */
  maxContentChars: number = 1500,
  /** 前面 chunk 已建议的新分类，让当前 chunk 优先复用 */
  pendingNewCategories: string[] = [],
  /** 顶层规划产物：已规划好的顶层分类列表（name + description），AI 必须从中选顶层 */
  plannedTopics: Array<{ name: string; description?: string }> = [],
): string {
  // 扁平化 taxonomy 路径
  const paths: string[] = [];
  function collectPaths(nodes: typeof taxonomy.nodes, prefix: string) {
    for (const n of nodes) {
      const p = prefix ? `${prefix}/${n.name}` : n.name;
      paths.push(p);
      if (n.children) collectPaths(n.children, p);
    }
  }
  collectPaths(taxonomy.nodes, '');

  // 序列化每篇笔记（文件名 + 原标签 + 摘要或截断内容）
  const notesBlock = inputs.map((inp, idx) => {
    const existingStr = inp.existingTags.length > 0
      ? inp.existingTags.map(t => `"${t}"`).join(', ')
      : '（无）';
    // 有摘要就只用摘要，不带原文（省 token）
    if (inp.summary && inp.summary.trim()) {
      return `### 笔记 ${idx + 1}

- file: ${inp.filePath}
- 原标签: ${existingStr}
- 摘要: ${inp.summary.trim()}`;
    }
    // 无摘要退回原文截断
    const truncated = inp.content.length > maxContentChars
      ? inp.content.slice(0, maxContentChars) + '\n...（后续内容省略）'
      : inp.content;
    return `### 笔记 ${idx + 1}

- file: ${inp.filePath}
- 原标签: ${existingStr}
- 内容:

${truncated}`;
  }).join('\n\n---\n\n');

  const pendingBlock = pendingNewCategories.length > 0
    ? `\n前面批次已建议过的新路径（能复用就复用）：\n${pendingNewCategories.map(p => `- ${p}`).join('\n')}\n`
    : '';

  const plannedBlock = plannedTopics.length > 0
    ? `\n## 适合这批笔记的顶层（由你组织子级）

${plannedTopics.map(t => `- ${t.name}${t.description ? `（${t.description}）` : ''}`).join('\n')}

请在这些顶层下新建合适的二级分类。主题相同的笔记要用同一个子级——
比如所有 React 笔记都用 \`前端开发/React\`，所有 CSS 笔记都用 \`前端开发/CSS\`。

`
    : '';

  return `你在帮用户整理笔记库。请为下面 ${inputs.length} 篇笔记分别选 1~${maxTags} 个分类路径。

## 可以选的现有分类

${paths.map(p => `- ${p}`).join('\n')}
${plannedBlock}${pendingBlock}
## 做法

1. 每篇给至少一个**包含两段的完整路径**（\`顶层/子级\`），不要只写顶层。
2. 同主题笔记共用同一个子级（比如 6 篇 React 笔记都写 \`前端开发/React\`，不要一篇 \`React\` 一篇 \`React框架\`）。
3. 不要硬塞。如果某篇笔记和所有候选都不贴切，可以新建路径，但不要勉强挂到最接近的那个。
4. 新路径**最多两段**（\`顶级/子级\`），不要三段以上。
${INTENSITY_RULES[intensity]}

## 输出

返回 JSON：

\`\`\`
{
  "items": [
    {"file": "xxx.md", "paths": ["路径1"]},
    {"file": "yyy.md", "paths": ["路径2", "路径3"]}
  ]
}
\`\`\`

不管是现有路径还是新路径，都写在同一个 paths 数组里，后端会自动区分。

## 示例

正确：
\`\`\`
{"file": "React-Hooks.md", "paths": ["前端开发/React"]}
{"file": "CSS-Grid.md", "paths": ["前端开发/CSS"]}
{"file": "番茄工作法.md", "paths": ["个人效率/时间管理"]}
\`\`\`

错误：
\`\`\`
{"file": "React-Hooks.md", "paths": ["前端开发"]}          ← 只给顶层，没归类价值
{"file": "React-Hooks.md", "paths": []}                    ← 空着不行
{"file": "React-Hooks.md", "paths": ["前端/React/Hooks/useState"]}  ← 层级太深
{"file": "React-Hooks.md", "paths": ["前端开发/React"]}
{"file": "React-性能优化.md", "paths": ["前端开发/React性能"]}   ← 同主题不同子级，应都用"前端开发/React"
\`\`\`

## 笔记清单

${notesBlock}`;
}
// 3. 开放式打标签 Prompt（无 Schema 时降级使用，V2 兼容）
// ============================================================

export function buildOpenTaggingPrompt(
  content: string,
  sourceFile: string,
  existingTags: string[],
  vaultTags: string[],
  mode: ClassificationMode,
  maxTags: number,
  customPrompt?: string,
): string {
  const modeDesc = mode === 'custom' && customPrompt
    ? customPrompt
    : MODE_DESCRIPTIONS[mode];

  const existingStr = existingTags.length > 0
    ? existingTags.map(t => `"${t}"`).join(', ')
    : '（无）';

  const vaultSample = vaultTags.slice(0, 100);
  const vaultStr = vaultSample.length > 0
    ? vaultSample.map(t => `"${t}"`).join(', ')
    : '（无）';

  return `你是一个知识分类专家。

## 任务
为以下笔记确定最合适的分类标签。输出**最终应该拥有的完整标签列表**。

## 分类方向
${modeDesc}

## 规则
1. 输出 1~${maxTags} 个 tag
2. 使用层级 tag，格式如 "主题/细分"
3. 宁少勿多，1~3 个精准标签优于 5 个泛标签
4. Vault 已有 tag，**优先复用**：${vaultStr}
5. 笔记目前的 tag：${existingStr}
   - 合理则保留，不准确则替换
6. tag 要准确描述笔记核心主题

## 输出格式（严格 JSON）
{"tags": ["tag1", "tag2"]}

## 笔记信息
文件名：${sourceFile}

## 笔记内容
${content}`;
}

// ============================================================
// 批量摘要 Prompt（为归类准备特征描述）
// ============================================================
export interface SummaryBatchInput {
  filePath: string;
  content: string;
}

/**
 * 一次性让 AI 给多篇笔记生成"分类线索型摘要"。
 *
 * 这不是 TL;DR，而是面向"归类 taxonomy"的特征描述：
 * - 笔记讲的是什么（2-3 个核心概念/关键词）
 * - 所属知识领域
 * - 100-150 字，精炼足够让下游 AI 判断该归哪个分类
 *
 * 返回 JSON 数组 [{file, summary}]，按输入 filePath 对齐。
 */
export function buildSummaryBatchPrompt(
  inputs: SummaryBatchInput[],
  /** 单篇笔记内容截断长度，防止 prompt 过长；默认 2000 字 */
  maxContentChars: number = 2000,
): string {
  const notesBlock = inputs.map((inp, idx) => {
    const truncated = inp.content.length > maxContentChars
      ? inp.content.slice(0, maxContentChars) + '\n...（后续内容省略）'
      : inp.content;
    return `### 笔记 ${idx + 1}

- file: ${inp.filePath}
- 内容:

${truncated}`;
  }).join('\n\n---\n\n');

  return `你是一个知识库管理专家。

## 任务

为下面 ${inputs.length} 篇笔记分别生成一段**用于分类的特征摘要**。

## 摘要要求

- **100-150 字中文**
- 突出 2-3 个核心概念/关键词
- 指出笔记所属的知识领域（如"前端工程/React 框架"、"西方哲学/存在主义"）
- 不是事实复述，是"如果要把它归类，最重要的判断依据是什么"
- 语言精炼，避免"这篇笔记讲的是..."这类冗词

## 返回格式（严格 JSON，顶层必须是对象，包含 items 数组）

{
  "items": [
    {"file": "xxx.md", "summary": "React Hooks 核心机制，涵盖 useState/useEffect 等常用 hook 的使用..."},
    {"file": "yyy.md", "summary": "..."}
  ]
}

每项 file 字段必须与输入的 filePath **完全一致**。

## 笔记清单

${notesBlock}`;
}

// ============================================================
// 顶层规划 Prompt（两阶段归类的第一步）
// ============================================================

export interface PlanTopicsPromptInput {
  filePath: string;
  summary: string;
}

/**
 * 构造"顶层分类规划"的 prompt。
 *
 * 让 AI 浏览所有笔记摘要，**只**回答：这批笔记应该分成哪 3-5 个顶层分类？每个顶层大致包括哪些笔记？
 * 之后的批量归类会以这些顶层为强约束，避免"前端工程/前端框架/前端开发"这种同义顶层碎片化。
 *
 * 约束：
 * - 顶层数量 3-5（批次太大时可以 6-7，但不准超 8）
 * - 命名统一：优先复用 folderHints 里的文件夹名（只传了几个有代表性的）
 * - 如果 existingTopics 非空，**必须复用它们**，不准新造（场景：增量归类）
 */
export function buildPlanTopicsPrompt(
  inputs: PlanTopicsPromptInput[],
  folderHints: string[] = [],
  existingTopics: string[] = [],
): string {
  const notesBlock = inputs
    .map((inp, idx) => `${idx + 1}. \`${inp.filePath}\` — ${inp.summary}`)
    .join('\n');

  const folderHintBlock = folderHints.length > 0
    ? `\n这批笔记主要来自这些文件夹（文件数从多到少）：\n${folderHints.map(f => `- ${f}`).join('\n')}\n\n可以考虑借用文件夹名当顶层（比如"前端笔记"→"前端开发"），和用户的组织方式保持一致。\n`
    : '';

  const existingBlock = existingTopics.length > 0
    ? `\n已有的顶层分类：${existingTopics.map(t => `"${t}"`).join('、')}\n\n如果某些笔记本来就属于这些主题，复用它们；如果这批笔记和已有顶层完全不相关，新建就好。\n`
    : '';

  return `帮我给 ${inputs.length} 篇笔记规划 ${inputs.length > 30 ? '3-7' : '2-5'} 个顶层分类。

这是两阶段归类的第一步：先统一顶层名字，避免后续出现"前端工程"/"前端框架"/"前端开发"这种同义不同名的情况。
${folderHintBlock}${existingBlock}
## 做法

1. 通读笔记摘要，找出 ${inputs.length > 30 ? '3-7' : '2-5'} 个大主题。
2. 顶层要**大颗粒**：比如"前端开发"、"哲学"、"个人效率"；"React"、"CSS"这种是二级，不是顶层。
3. 同类主题**合并到一个顶层**：React/CSS/JS 都属于"前端开发"；存在主义/分析哲学都属于"哲学"。
4. 每个顶层配一句 20-40 字的描述，说明它覆盖什么。
5. 标出每篇笔记属于哪个顶层（files 字段列全 filePath，一篇不漏）。
6. 如果某篇笔记和主流话题完全不同（比如一堆前端里混了篇"番茄工作法"），宁可单独开一个顶层给它，也别硬塞到不相关的顶层下。

## 输出

返回 JSON：

\`\`\`
{
  "topics": [
    {
      "name": "前端开发",
      "description": "浏览器端技术，含框架、样式、语言、工程化工具",
      "files": ["前端笔记/React-Hooks.md", "前端笔记/CSS-Grid.md", ...]
    },
    {
      "name": "个人效率",
      "description": "时间管理、工作方法等自我提升主题",
      "files": ["番茄工作法心得.md"]
    }
  ]
}
\`\`\`

## 笔记摘要

${notesBlock}`;
}
