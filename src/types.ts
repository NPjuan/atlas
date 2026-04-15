// ============================================================
// 全局类型定义 — MECE Knowledge Mind Map
// ============================================================

// ---- 数据存储 ----

/** schema 版本号，用于数据迁移 */
export const STORE_VERSION = 2;

/** 知识库总数据结构 */
export interface KnowledgeStore {
  version: number;
  lastUpdated: string;
  documents: Record<string, DocumentRecord>;
  knowledgePoints: KnowledgePoint[];
  categoryTree: CategoryNode;
  /** 操作日志（append-only） */
  logs: LogEntry[];
  /** 节点摘要缓存（key 为 CategoryNode.id） */
  summaries: Record<string, NodeSummary>;
}

/** 已处理的文档记录 */
export interface DocumentRecord {
  hash: string;
  processedAt: string;
  status: 'completed' | 'partial';
  processedChunks?: number;
}

/** 知识点置信度 */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/** 单个知识点 */
export interface KnowledgePoint {
  id: string;
  content: string;
  sourceFile: string;
  sourceQuote: string;
  sourcePosition: { start: number; end: number };
  categoryIds: string[];
  classified: boolean;
  /** AI 提取时的置信度评估 */
  confidence: ConfidenceLevel;
  /** 提取时间戳（ISO 8601） */
  extractedAt: string;
  /** 交叉引用关联的知识点 ID 列表 */
  relatedIds: string[];
  /** 是否标记为常青（永不过期） */
  evergreen: boolean;
  /** 是否已过期 */
  stale: boolean;
  /** 来源文件的标签 */
  tags: string[];
}

/** 分类树节点（递归结构） */
export interface CategoryNode {
  id: string;
  name: string;
  level: 'root' | 'theme' | 'category' | 'viewpoint';
  children: CategoryNode[];
  knowledgePointIds: string[];
}

// ---- AI 相关 ----

/** AI 提供商类型 */
export type AIProviderType = 'claude' | 'openai' | 'ollama' | 'deepseek';

/** 插件设置 */
export interface MECESettings {
  aiProvider: AIProviderType;
  apiKey: string;
  model: string;
  ollamaHost: string;
  /** 扫描排除的目录列表 */
  excludeDirs: string[];
  /** 单文件最大字数警告阈值 */
  maxFileCharsWarn: number;
  /** 单文件最大字数跳过阈值 */
  maxFileCharsSkip: number;
  /** AI 请求最大并发数 */
  maxConcurrency: number;
  /** 自定义 OpenAI 兼容 API base URL（留空则用官方地址） */
  openaiBaseUrl: string;
  /** 知识点过期天数（超过此天数未更新则标记为 stale），默认 90 */
  staleDays: number;
  /** 是否启用 frontmatter 回写（将分类结果写入文件 frontmatter），默认 false */
  enableWriteBack: boolean;
  /** 扫描完成后是否自动执行 Lint 健康检查，默认 true */
  lintOnScan: boolean;
  /** 操作日志最大条目数，默认 500 */
  maxLogEntries: number;
}

/** 默认设置 */
export const DEFAULT_SETTINGS: MECESettings = {
  aiProvider: 'ollama',
  apiKey: '',
  model: '',
  ollamaHost: 'http://localhost:11434',
  excludeDirs: ['templates', 'daily', '.obsidian'],
  maxFileCharsWarn: 20000,
  maxFileCharsSkip: 50000,
  maxConcurrency: 3,
  openaiBaseUrl: '',
  staleDays: 90,
  enableWriteBack: false,
  lintOnScan: true,
  maxLogEntries: 500,
};

/** 空知识库 */
export function createEmptyStore(): KnowledgeStore {
  return {
    version: STORE_VERSION,
    lastUpdated: new Date().toISOString(),
    documents: {},
    knowledgePoints: [],
    categoryTree: {
      id: 'root',
      name: '知识库',
      level: 'root',
      children: [],
      knowledgePointIds: [],
    },
    logs: [],
    summaries: {},
  };
}

// ---- 操作日志 ----

/** 操作日志类型 */
export type LogType = 'scan' | 'classify' | 'lint' | 'query' | 'summary' | 'writeback';

/** 操作日志条目 */
export interface LogEntry {
  id: string;
  timestamp: string;
  type: LogType;
  message: string;
  details?: {
    filesProcessed?: number;
    pointsExtracted?: number;
    pointsClassified?: number;
    contradictions?: number;
    staleItems?: number;
    gaps?: number;
    orphans?: number;
    queryQuestion?: string;
    summaryNodeId?: string;
  };
}

// ---- 节点摘要 ----

/** 节点摘要缓存 */
export interface NodeSummary {
  nodeId: string;
  summary: string;
  generatedAt: string;
  /** 生成时的知识点数量，用于判断是否需要更新 */
  kpCount: number;
  /** 新增知识点后自动标记为 stale，需要重新生成 */
  stale: boolean;
}

// ---- Lint 健康检查 ----

/** 矛盾项 */
export interface ContradictionItem {
  kpId1: string;
  kpId2: string;
  reason: string;
}

/** 过期项 */
export interface StaleItem {
  kpId: string;
  extractedAt: string;
  daysSince: number;
}

/** 孤立项 */
export interface OrphanItem {
  kpId: string;
  content: string;
}

/** 知识缺口项 */
export interface GapItem {
  categoryId: string;
  categoryName: string;
  suggestion: string;
}

/** Lint 健康检查报告 */
export interface LintReport {
  timestamp: string;
  contradictions: ContradictionItem[];
  staleItems: StaleItem[];
  orphans: OrphanItem[];
  gaps: GapItem[];
  totalIssues: number;
}

// ---- 事件 / 进度 ----

export interface ScanProgress {
  phase: 'scanning' | 'extracting' | 'classifying' | 'linting' | 'querying' | 'summarizing';
  current: number;
  total: number;
  currentFile?: string;
  message?: string;
}
