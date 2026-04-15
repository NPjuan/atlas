import { KnowledgePoint, CategoryNode } from '../types';

// ============================================================
// AI Provider 接口定义
// ============================================================

/** AI 提取结果：从一个文本 chunk 中提取出的知识点 */
export interface ExtractionResult {
  knowledgePoints: {
    content: string;
    sourceQuote: string;
  }[];
}

/** AI 分类结果 */
export interface ClassificationResult {
  /** 知识点 ID → 分类节点 ID 映射 */
  assignments: Record<string, string[]>;
  /** 新增的分类节点 */
  newNodes: {
    id: string;
    name: string;
    level: 'theme' | 'category' | 'viewpoint';
    parentId: string;
  }[];
}

/** AI Provider 统一接口 */
export interface AIProvider {
  /** 提供商名称 */
  readonly name: string;

  /** 测试连接 */
  testConnection(): Promise<void>;

  /** 从文本块中提取知识点 */
  extract(chunk: string, sourceFile: string): Promise<ExtractionResult>;

  /** 对知识点进行 MECE 分类 */
  classify(
    knowledgePoints: Pick<KnowledgePoint, 'id' | 'content'>[],
    treeSkeleton: CategoryTreeSkeleton
  ): Promise<ClassificationResult>;
}

/** 分类树骨架（只传 id + name + level，不传关联知识点） */
export interface CategoryTreeSkeleton {
  id: string;
  name: string;
  level: string;
  children: CategoryTreeSkeleton[];
}

// ============================================================
// JSON 解析保障
// ============================================================

/**
 * 从 AI 原始响应中安全提取 JSON。
 * 处理：markdown 代码块包装、前后缀杂文、截断 JSON。
 */
export function parseJSON<T>(raw: string): T {
  let cleaned = raw.trim();

  // 1. 去除 markdown 代码块包装
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  // 2. 尝试找到第一个 { 或 [ 开始的 JSON
  const jsonStart = cleaned.search(/[{\[]/);
  if (jsonStart > 0) {
    cleaned = cleaned.slice(jsonStart);
  }

  // 3. 尝试直接解析
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // 4. 尝试修复截断的 JSON（补全尾部括号）
    const repaired = repairTruncatedJSON(cleaned);
    try {
      return JSON.parse(repaired) as T;
    } catch {
      throw new Error(`AI 返回的内容无法解析为 JSON:\n${raw.slice(0, 500)}`);
    }
  }
}

/** 尝试修复截断的 JSON：补全缺失的 }, ] */
function repairTruncatedJSON(s: string): string {
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (const ch of s) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  // 如果在字符串中截断，先关闭字符串
  if (inString) s += '"';

  // 补全缺失的闭合括号
  while (stack.length > 0) {
    s += stack.pop();
  }

  return s;
}
