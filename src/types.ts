// ============================================================
// MECE V3 — 全局类型定义（全新，不兼容旧版本）
// ============================================================

// ---- Taxonomy Schema（分类体系） ----

/** 分类体系中的一个节点 */
export interface TaxonomyNode {
  /** 唯一标识 */
  id: string;
  /** 显示名称，如 "认识论" */
  name: string;
  /** 完整路径，如 "哲学/认识论" */
  fullPath: string;
  /** 可选描述，帮助 AI 更准确选择此分类 */
  description?: string;
  /** 子分类 */
  children: TaxonomyNode[];
}

/** 完整的分类体系 */
export interface TaxonomySchema {
  /** Schema 版本号 */
  version: number;
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
  /** 最大层级深度（默认 3） */
  maxDepth: number;
  /** 根节点显示名（可被用户重命名） */
  rootName: string;
  /** 分类树根节点列表（root 的一级子节点） */
  nodes: TaxonomyNode[];
}

// ---- 数据存储 ----

/** Store 版本号 */
export const STORE_VERSION = 2;

/** 存量 data.json 里可能存在的旧 scope key，load 时做迁移 */
export const LEGACY_ROOT_KEY = 'root';
export const LEGACY_VAULT_KEY = '__vault__';

/** 插件数据（存储在 data.json） */
export interface MECEStore {
  version: number;
  /**
   * 全局唯一的分类体系。
   * 整个插件只有一份 schema，UI 层按文件夹切换展示范围，不再按 scope 分裂。
   */
  taxonomy: TaxonomySchema | null;
  /** 已处理文件记录（增量检测用） */
  processedFiles: Record<string, ProcessedFileRecord>;
  /** 插件设置 */
  settings: MECESettings;
}

/** 已处理的文件记录 */
export interface ProcessedFileRecord {
  /** 内容 hash */
  hash: string;
  /** AI 打标签时间 */
  taggedAt: string;
  /** 打上的 tag 数量 */
  tagCount: number;
  /** AI 生成的笔记摘要（~100-150 字，用于归类时替代原文） */
  summary?: string;
  /** summary 对应的内容 hash；和 hash 不同表示摘要已过期需要重生成 */
  summaryHash?: string;
}

// ---- AI 相关 ----

/** AI 提供商类型 */
export type AIProviderType = 'claude' | 'openai' | 'ollama' | 'deepseek';

/** 读取指定 provider 的 API Key（不传 provider 则用当前的） */
export function getApiKey(settings: MECESettings, provider?: AIProviderType): string {
  const p = provider || settings.aiProvider;
  return settings.apiKeys?.[p] || '';
}

/** 读取指定 provider 的模型名 */
export function getModel(settings: MECESettings, provider?: AIProviderType): string {
  const p = provider || settings.aiProvider;
  return settings.models?.[p] || '';
}

/** 写入指定 provider 的 API Key，并同步 legacy 字段 */
export function setApiKey(settings: MECESettings, provider: AIProviderType, key: string): void {
  if (!settings.apiKeys) settings.apiKeys = {};
  settings.apiKeys[provider] = key;
  if (provider === settings.aiProvider) settings.apiKey = key;
}

/** 写入指定 provider 的模型名，并同步 legacy 字段 */
export function setModel(settings: MECESettings, provider: AIProviderType, model: string): void {
  if (!settings.models) settings.models = {};
  settings.models[provider] = model;
  if (provider === settings.aiProvider) settings.model = model;
}

/** 切换当前 provider，自动把 legacy apiKey/model 字段更新为新 provider 的值 */
export function switchProvider(settings: MECESettings, next: AIProviderType): void {
  settings.aiProvider = next;
  settings.apiKey = settings.apiKeys?.[next] || '';
  settings.model = settings.models?.[next] || '';
}

/** Schema 生成时读取笔记内容的模式 */
export type SchemaContextMode = 'title-only' | 'first-500' | 'full';

/** 分类规则 */
export type ClassificationMode = 'mece' | 'discipline' | 'custom';

/** 插件设置 */
export interface MECESettings {
  // -- AI 配置 --
  aiProvider: AIProviderType;
  /** 当前 provider 的 API Key（兼容字段，实际读写走 apiKeys[provider]） */
  apiKey: string;
  /** 当前 provider 的模型名（兼容字段，实际读写走 models[provider]） */
  model: string;
  /** 各 provider 独立保存的 API Key，切换 provider 不丢失 */
  apiKeys: Partial<Record<AIProviderType, string>>;
  /** 各 provider 独立保存的模型名 */
  models: Partial<Record<AIProviderType, string>>;
  ollamaHost: string;
  /** 自定义 OpenAI 兼容 API base URL */
  openaiBaseUrl: string;

  // -- Schema 配置 --
  /** Schema 生成时的内容读取模式 */
  schemaContextMode: SchemaContextMode;
  /** 分类规则 */
  classificationMode: ClassificationMode;
  /** 自定义分类 Prompt（classificationMode 为 custom 时使用） */
  customClassificationPrompt: string;

  // -- 标签配置 --
  /** 每篇笔记最多 tag 数 */
  maxTagsPerFile: number;
  /** Tag 前缀（如 'mece/'），为空则不加 */
  tagPrefix: string;
  /** AI 归类默认强度：保守/平衡/重构 */
  defaultReorganizeIntensity: 'conservative' | 'balanced' | 'aggressive';
  /** 归类策略：auto=按能力自动选，sequential=逐篇，batch=批量 */
  taggingStrategy: 'auto' | 'sequential' | 'batch';
  /** AI 归类完成并 apply 后自动把笔记迁移到对应分类文件夹（默认关） */
  autoOrganizeFilesAfterTagging: boolean;

  // -- 扫描配置 --
  /** 排除的目录列表 */
  excludeDirs: string[];
  /** 单文件最大字数跳过阈值 */
  maxFileCharsSkip: number;
}

/** 默认设置 */
export const DEFAULT_SETTINGS: MECESettings = {
  aiProvider: 'deepseek',
  apiKey: '',
  model: '',
  apiKeys: {},
  // 每个 provider 的推荐默认模型：切到某个 provider 时，如果用户没显式选过模型，
  // 就用这里预置的值，避免 model 为空字符串导致 API 调用失败
  models: {
    claude: 'claude-sonnet-4-20250514',
    openai: 'gpt-4o',
    deepseek: 'deepseek-chat',
    ollama: 'qwen2.5',
  },
  ollamaHost: 'http://localhost:11434',
  openaiBaseUrl: '',
  // Schema 生成时每篇笔记送给 AI 的内容长度：
  // first-500 在绝大多数场景下质量与 full 接近，token 消耗低 5-10 倍
  // 想追求更准可手动改成 'full'
  schemaContextMode: 'first-500',
  classificationMode: 'mece',
  customClassificationPrompt: '',
  maxTagsPerFile: 3,
  tagPrefix: '',
  defaultReorganizeIntensity: 'conservative',
  taggingStrategy: 'auto',
  autoOrganizeFilesAfterTagging: true,
  excludeDirs: ['templates', 'daily', '.obsidian', 'attachments'],
  maxFileCharsSkip: 50000,
};

/** 创建空 Store */
export function createEmptyStore(): MECEStore {
  const settings = { ...DEFAULT_SETTINGS };
  // 兼容字段 apiKey/model 跟当前 provider 的 apiKeys/models 同步（默认空）
  settings.apiKey = (settings.apiKeys && settings.apiKeys[settings.aiProvider]) || '';
  settings.model = (settings.models && settings.models[settings.aiProvider]) || '';
  return {
    version: STORE_VERSION,
    taxonomy: null,
    processedFiles: {},
    settings,
  };
}

// ---- 标签索引（运行时，不持久化） ----

/** 标签树节点 */
export interface TagTreeNode {
  name: string;
  fullTag: string;
  files: Set<string>;
  fileCount: number;
  children: Map<string, TagTreeNode>;
}

/** 标签索引 */
export interface TagIndex {
  tagToFiles: Map<string, Set<string>>;
  fileToTags: Map<string, string[]>;
  tree: TagTreeNode;
  stats: {
    totalFiles: number;
    totalTags: number;
    untaggedFiles: number;
  };
}

// ---- Patch 预览 ----

/** 单个文件的标签变更 */
export interface TagPatch {
  filePath: string;
  fileName: string;
  /** 原有 tags */
  oldTags: string[];
  /** AI 建议的完整最终 tags */
  newTags: string[];
  /** 新增的 tag */
  added: string[];
  /** 删除的 tag */
  removed: string[];
  /** 用户是否接受（默认 true） */
  accepted: boolean;
  /** 文件内容 hash */
  hash: string;
  /** 是否有变更 */
  hasChanges: boolean;
}

/** AI 建议的新分类（Schema 中没有的） */
export interface SuggestedCategory {
  /** AI 建议的分类路径，如 "语言哲学/维特根斯坦" */
  path: string;
  /** 建议的来源文件 */
  sourceFile: string;
  /** 用户是否确认纳入 Schema */
  accepted: boolean;
}

/** 一次 AI 打标签的完整 Patch */
export interface TagPatchList {
  createdAt: string;
  patches: TagPatch[];
  /** AI 建议的新分类列表 */
  suggestedCategories: SuggestedCategory[];
  stats: {
    totalFiles: number;
    filesWithChanges: number;
    totalNewTags: number;
    skippedFiles: number;
  };
}

// ---- 进度 ----

export interface ScanProgress {
  phase: 'scanning' | 'schema-gen' | 'tagging' | 'writing';
  current: number;
  total: number;
  currentFile?: string;
  message?: string;
  /** true 时进度条显示不定式动画（current/total 无意义，比如整批一次性 AI 调用中） */
  indeterminate?: boolean;
}

// ---- Schema 生成相关 ----

/** 笔记概览（用于 Schema 生成） */
export interface NoteOverview {
  fileName: string;
  existingTags: string[];
  content: string;
}

/** AI Schema 生成结果 */
export interface TaxonomyResult {
  /** AI 生成的分类树（不含 id/fullPath，需后处理补充） */
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

/** 约束式打标签的 AI 返回 */
export interface ConstrainedTaggingResult {
  /** 从 Schema 中选择的标签路径 */
  tags: string[];
  /** AI 建议的新分类（Schema 中没有的） */
  newCategories: string[];
}
