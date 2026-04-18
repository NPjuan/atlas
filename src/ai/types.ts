import type { ClassificationMode, TaxonomySchema, NoteOverview } from '../types';

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
  ): Promise<ConstrainedTaggingResult>;

  /** 生成分类体系 Schema */
  generateTaxonomy(
    notes: NoteOverview[],
    maxDepth: number,
    classificationMode: ClassificationMode,
    customPrompt?: string,
  ): Promise<RawTaxonomyResult>;
}

// ============================================================
// JSON 安全解析
// ============================================================

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
