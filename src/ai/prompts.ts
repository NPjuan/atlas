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

export function buildConstrainedTaggingPrompt(
  content: string,
  sourceFile: string,
  existingTags: string[],
  taxonomy: TaxonomySchema,
  maxTags: number,
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

  return `你是一个知识分类专家。

## 任务

为以下笔记从**已有分类体系**中选择最合适的标签。

## 可用分类（必须从中选择）

${paths.map(p => `- ${p}`).join('\n')}

## 规则

1. 从上面的分类中选择 1~${maxTags} 个最匹配的标签路径
2. **选择到具体层级**（如 "伦理学/功利主义"，不要只选 "伦理学"）
3. 宁选一个精准的，不选三个泛的
4. 笔记目前的标签：${existingStr}
   - 如果已有标签在分类体系中且合理，保留
   - 如果已有标签不在体系中或不准确，可替换
5. 如果笔记内容**确实不属于任何现有分类**，在 newCategories 中建议新分类
6. newCategories 格式同标签路径，如 "语言哲学/维特根斯坦"

## 输出格式（严格 JSON）

{"tags": ["分类路径1", "分类路径2"], "newCategories": []}

## 笔记信息

文件名：${sourceFile}

## 笔记内容

${content}`;
}

// ============================================================
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
