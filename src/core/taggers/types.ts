/**
 * 归类策略（TaggingStrategy）公共类型与数据归一化
 *
 * 目标：把"如何编排 AI 调用"和"如何处理返回数据"拆出来，便于单测、替换、组合。
 */

import type { TaxonomySchema, ScanProgress } from '../../types';
import type { AIProvider } from '../../ai/types';
import type { ReorganizeIntensity } from '../../ai/prompts';

// ============================================================
// 策略输入 / 输出
// ============================================================

/** 供策略使用的笔记载体（摘要可能有可能无） */
export interface TaggerFile {
  filePath: string;
  /** 全文（可能很长）；当 summary 为空时 fallback 用 */
  content: string;
  /** 原 tags（用于保守策略判断） */
  oldTags: string[];
  /** AI 预先生成的摘要（~100-150 字），有则优先用 */
  summary?: string;
}

/** 策略返回：每篇笔记对应的 tags / newCategories */
export interface TaggedResult {
  tags: string[];
  newCategories: string[];
}

/** 策略总输出 */
export interface TaggingOutcome {
  /** filePath → 打标结果 */
  byFile: Map<string, TaggedResult>;
  /** 整批去重后的所有新分类建议（按首次出现顺序） */
  allNewCategories: string[];
  /** 成功处理的文件数（用于诊断） */
  successCount: number;
  /** 失败的 filePath 列表（调用出错或返回没包含它） */
  failedPaths: string[];
}

/** 策略公共依赖 */
export interface TaggerContext {
  provider: AIProvider;
  taxonomy: TaxonomySchema;
  maxTags: number;
  intensity?: ReorganizeIntensity;
  onProgress?: (p: ScanProgress) => void;
  isCancelled?: () => boolean;
  /** 诊断日志开关（settings.verboseLog 之类） */
  verbose?: boolean;
  /** 顶层规划产物（可选）：传给 provider 的 batch 方法，用于强约束顶层统一 */
  plannedTopics?: Array<{ name: string; description?: string }>;
}

// ============================================================
// 策略接口
// ============================================================

export interface TaggingStrategy {
  /** 策略名，用于日志和 settings 识别 */
  readonly name: string;
  tag(files: TaggerFile[], ctx: TaggerContext): Promise<TaggingOutcome>;
}

// ============================================================
// AI 返回数据归一化（纯函数）
// ============================================================

/** 归一化后的单条结果 */
export interface NormalizedItem {
  file: string;
  tags: string[];
  newCategories: string[];
}

/**
 * 把 AI 批量调用的原始 JSON 结果归一化为规整的数组。
 *
 * 兼容多种不规范形态：
 * - 直接返回数组：`[{file, tags, ...}, ...]`
 * - 包装对象：`{items: [...]}` / `{results: [...]}` / `{data: [...]}`
 * - 只返回一个对象而非数组（AI 偶尔会这样）
 *
 * 对每条做字段校验：
 * - 缺 file 或 file 为空 → 丢弃
 * - tags 非数组 → 视为空数组
 * - 元素必须是非空字符串，trim 后入列
 *
 * 永远不会抛异常；解析失败返回空数组。
 */
export function normalizeBatchResult(raw: unknown): NormalizedItem[] {
  if (raw == null) return [];

  // 展开成数组
  let arr: unknown[];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.items)) arr = obj.items;
    else if (Array.isArray(obj.results)) arr = obj.results;
    else if (Array.isArray(obj.data)) arr = obj.data;
    else if (typeof obj.file === 'string') arr = [obj];  // 单对象
    else return [];
  } else {
    return [];
  }

  const out: NormalizedItem[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const file = typeof o.file === 'string' ? o.file.trim() : '';
    if (!file) continue;
    const tags = cleanStringArray(o.tags);
    const newCategories = cleanStringArray(o.newCategories);
    out.push({ file, tags, newCategories });
  }
  return out;
}

function cleanStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const result: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      const t = item.trim();
      if (t) result.push(t);
    }
  }
  return result;
}

/**
 * 合并两个新分类列表，保持首次出现顺序、去重。
 */
export function mergeNewCategories(prev: string[], incoming: string[]): string[] {
  const seen = new Set(prev);
  const out = [...prev];
  for (const c of incoming) {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/**
 * 把 TaggerFile[] 切成固定大小的 chunk。
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
