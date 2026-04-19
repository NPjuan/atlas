import type { ClassificationMode, TaxonomySchema, NoteOverview } from '../types';
import type { ReorganizeIntensity } from './prompts';

// ============================================================
// AI Provider 接口定义 — V3
// ============================================================

/** AI 打标签结果（开放式） */
export interface TaggingResult {
  tags: string[];
}

/** AI 约束式打标签结果 */
export interface ConstrainedTaggingResult {
  /** 从 Schema 中选择的标签路径 */
  tags: string[];
  /** AI 建议的新分类（Schema 中没有的） */
  newCategories: string[];
}

/** 批量约束式打标签的单条结果 */
export interface BatchTaggingItem {
  /** 原始文件路径（prompt 里用作 key） */
  file: string;
  tags: string[];
  newCategories: string[];
}

/** 批量约束式打标签结果 */
export interface BatchConstrainedTaggingResult {
  /** 按输入顺序返回，索引对应 */
  items: BatchTaggingItem[];
}

/** 批量打标签时传入的笔记条目 */
export interface BatchTaggingInput {
  filePath: string;
  content: string;
  existingTags: string[];
  /** 可选摘要；若提供则归类 prompt 会用摘要代替 content（省 token） */
  summary?: string;
}

/** 摘要批量结果单条 */
export interface SummaryItem {
  file: string;
  summary: string;
}

export interface SummaryBatchResult {
  items: SummaryItem[];
}

/** 摘要批量输入 */
export interface SummaryBatchInputItem {
  filePath: string;
  content: string;
}

/** 顶层规划单条输入（给 AI 一眼看清笔记概貌） */
export interface PlanTopicsInputItem {
  filePath: string;
  /** 一行描述：优先摘要，没有就截断原文 */
  summary: string;
}

/** 顶层规划返回的单个 topic */
export interface PlannedTopic {
  /** 顶层分类名（如「前端开发」「哲学」） */
  name: string;
  /** 简短描述，20-40 字 */
  description: string;
  /** 命中此 topic 的 filePath 列表（AI 给出的预分配，后续归类阶段可覆盖） */
  files: string[];
}

export interface PlanTopicsResult {
  topics: PlannedTopic[];
}

/** AI Schema 生成结果（原始格式，不含 id/fullPath） */
export interface RawTaxonomyResult {
  taxonomy: Array<{
    name: string;
    description?: string;
    children: Array<{
      name: string;
      description?: string;
      children: Array<{
        name: string;
        description?: string;
        children: never[];
      }>;
    }>;
  }>;
}

/** AI Provider 统一接口 */
export interface AIProvider {
  readonly name: string;

  /** 测试连接 */
  testConnection(): Promise<void>;

  /** 开放式打标签（无 Schema 时降级使用） */
  suggestTags(
    content: string,
    sourceFile: string,
    existingTags: string[],
    vaultTags: string[],
    mode: ClassificationMode,
    maxTags: number,
    customPrompt?: string,
  ): Promise<TaggingResult>;

  /** 约束式打标签（有 Schema 时使用） */
  suggestTagsConstrained(
    content: string,
    sourceFile: string,
    existingTags: string[],
    taxonomy: TaxonomySchema,
    maxTags: number,
    intensity?: ReorganizeIntensity,
    /** 同批次里已经被建议过的新分类路径，喂给 AI 避免碎片化重复建议 */
    pendingNewCategories?: string[],
  ): Promise<ConstrainedTaggingResult>;

  /**
   * 批量约束式打标签（一次调用处理多篇笔记）。
   * 可选实现：不实现时外层会降级为逐篇调用 suggestTagsConstrained。
   */
  suggestTagsConstrainedBatch?(
    inputs: BatchTaggingInput[],
    taxonomy: TaxonomySchema,
    maxTags: number,
    intensity?: ReorganizeIntensity,
    /** 前面 chunk 已经建议过的新分类，传给后续 chunk 优先复用 */
    pendingNewCategories?: string[],
    /** 顶层规划产物：整批笔记应该归到哪些顶层之下（name + description），AI 新建分类时必须从中选顶层 */
    plannedTopics?: Array<{ name: string; description?: string }>,
  ): Promise<BatchConstrainedTaggingResult>;

  /**
   * 批量生成笔记摘要（用于归类前的特征提取）。
   * 可选实现：不实现时外层跳过摘要、直接用原文。
   */
  summarizeBatch?(
    inputs: SummaryBatchInputItem[],
  ): Promise<SummaryBatchResult>;

  /**
   * 顶层分类规划：先把所有笔记喂给 AI，让它只回 3-5 个顶层分类。
   * 之后归类阶段会以这些顶层为强约束，避免碎片化顶层（前端工程/前端框架/前端开发 并存）。
   * 可选实现：不实现时外层跳过规划，直接走开放的批量归类。
   */
  planTaxonomyTopics?(
    inputs: PlanTopicsInputItem[],
    /** 文件夹 hint：按文件数排序的主要文件夹名，AI 优先考虑这些作为顶层名 */
    folderHints?: string[],
    /** 已有 taxonomy 的顶层（存在时 AI 必须复用，不得新建） */
    existingTopics?: string[],
  ): Promise<PlanTopicsResult>;

  /** 生成分类体系 Schema */
  generateTaxonomy(
    notes: NoteOverview[],
    maxDepth: number,
    classificationMode: ClassificationMode,
    customPrompt?: string,
  ): Promise<RawTaxonomyResult>;
}

// ============================================================
// JSON 安全解析 + path 分流
// ============================================================

/**
 * 扁平化 taxonomy 为所有路径的集合。
 * 供 provider 在解析 AI 返回时判断"哪些 path 是现有的、哪些是新的"。
 */
export function collectTaxonomyPathSet(taxonomy: TaxonomySchema): Set<string> {
  const set = new Set<string>();
  const walk = (nodes: TaxonomySchema['nodes'], prefix: string) => {
    for (const n of nodes) {
      const p = prefix ? `${prefix}/${n.name}` : n.name;
      set.add(p);
      if (n.children) walk(n.children, p);
    }
  };
  walk(taxonomy.nodes, '');
  return set;
}

/**
 * 把 AI 返回的 paths（单字段）拆成 {tags, newCategories} 两字段。
 *
 * 规则：
 * - 所有 paths 都进 tags（笔记最终的归属）
 * - 不在 existingPaths 里的额外进 newCategories（让用户批准扩 Schema）
 *
 * 这是"AI 只写 paths，后端自动分流"的核心转换。
 */
export function splitPaths(
  paths: string[],
  existingPaths: Set<string>,
): { tags: string[]; newCategories: string[] } {
  const tags: string[] = [];
  const newCategories: string[] = [];
  const seenTags = new Set<string>();
  const seenNew = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== 'string') continue;
    const p = raw.trim();
    if (!p || seenTags.has(p)) continue;
    tags.push(p);
    seenTags.add(p);
    if (!existingPaths.has(p) && !seenNew.has(p)) {
      newCategories.push(p);
      seenNew.add(p);
    }
  }
  return { tags, newCategories };
}

export function parseJSON<T>(raw: string): T {
  let cleaned = raw.trim();

  // 去除 markdown 代码块
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  // 找到第一个 { 或 [
  const jsonStart = cleaned.search(/[{\[]/);
  if (jsonStart > 0) {
    cleaned = cleaned.slice(jsonStart);
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // 尝试修复截断 JSON
    const repaired = repairTruncatedJSON(cleaned);
    try {
      return JSON.parse(repaired) as T;
    } catch {
      throw new Error(`AI 返回的内容无法解析为 JSON:\n${raw.slice(0, 500)}`);
    }
  }
}

function repairTruncatedJSON(s: string): string {
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  if (inString) s += '"';
  while (stack.length > 0) {
    s += stack.pop();
  }

  return s;
}
