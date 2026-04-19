import { Plugin } from 'obsidian';
import {
  MECEStore,
  MECESettings,
  TaxonomySchema,
  STORE_VERSION,
  LEGACY_ROOT_KEY,
  LEGACY_VAULT_KEY,
  createEmptyStore,
  DEFAULT_SETTINGS,
} from '../types';

/**
 * 纯函数：把 data.json 里的原始数据迁移成当前版本的 Store。
 *
 * 负责：
 * - v1 `taxonomies: Record<scope, schema>` → v2 单 `taxonomy`（优先取 root/__vault__）
 * - 旧版 settings.apiKey/model 单值 → apiKeys/models 按 provider 独立
 * - 字段兜底（taxonomy=null、processedFiles={}、settings 合并默认值）
 *
 * 不依赖 Obsidian / 文件系统，便于单测覆盖。
 */
export function migrateRawStore(raw: unknown): MECEStore {
  if (!raw || typeof raw !== 'object') {
    return createEmptyStore();
  }
  const rawAny = raw as any;

  // v1 → v2: 多 scope → 单 schema
  if (rawAny.taxonomies && !rawAny.taxonomy) {
    const map: Record<string, TaxonomySchema> = rawAny.taxonomies || {};
    const picked =
      map[LEGACY_ROOT_KEY]
      || map[LEGACY_VAULT_KEY]
      || null;
    rawAny.taxonomy = picked;
    delete rawAny.taxonomies;
  }

  if (rawAny.version !== STORE_VERSION) {
    rawAny.version = STORE_VERSION;
  }

  const store = rawAny as MECEStore;
  if (!store.taxonomy) store.taxonomy = null;
  if (!store.processedFiles) store.processedFiles = {};
  store.settings = { ...DEFAULT_SETTINGS, ...store.settings };

  const s = store.settings;
  if (!s.apiKeys) s.apiKeys = {};
  if (!s.models) s.models = {};
  // 老存量数据兼容：apiKey/model 单值 → 优先写入 apiKeys[provider]/models[provider]
  // （旧数据的显式选择必须被保留，不能被 DEFAULT 预置覆盖）
  if (s.aiProvider && s.aiProvider !== 'ollama' && s.apiKey) {
    s.apiKeys[s.aiProvider] = s.apiKey;
  }
  if (s.aiProvider && s.model) {
    s.models[s.aiProvider] = s.model;
  }
  // 把 DEFAULT_SETTINGS 里预置的推荐模型/apiKey 补进现有 settings
  // （只补没有显式设置过的 provider，老用户升级能拿到新预置而不被覆盖）
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS.apiKeys || {})) {
    if (v && !s.apiKeys[k as keyof typeof s.apiKeys]) s.apiKeys[k as keyof typeof s.apiKeys] = v;
  }
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS.models || {})) {
    if (v && !s.models[k as keyof typeof s.models]) s.models[k as keyof typeof s.models] = v;
  }
  s.apiKey = s.apiKeys[s.aiProvider] || '';
  s.model = s.models[s.aiProvider] || '';

  return store;
}

/**
 * Store 管理（单 schema 架构）
 *
 * 设计决策：整个插件只维护一份全局分类体系（`taxonomy`），
 * UI 层的「文件夹过滤」只影响展示范围和处理范围，不再按 scope 存独立 schema。
 *
 * 存储：
 * - taxonomy: 全局唯一的分类体系（可以为 null，表示还没生成）
 * - processedFiles: 增量检测用的 hash + 归类时间
 * - settings: 插件设置
 *
 * 标签数据来自笔记 frontmatter（metadataCache），不在 store 中维护。
 */
export class StoreManager {
  private plugin: Plugin;
  private store: MECEStore | null = null;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  /** 加载 store（含 v1 → v2 单 schema 迁移） */
  async load(): Promise<MECEStore> {
    if (this.store) return this.store;

    const raw = await this.plugin.loadData();

    if (!raw || typeof raw !== 'object') {
      console.log('Atlas: 创建全新 Store');
      this.store = createEmptyStore();
      await this.save();
      return this.store;
    }

    const hadOldShape = !!(raw as any).taxonomies;
    this.store = migrateRawStore(raw);
    if (hadOldShape) {
      console.log('Atlas: 迁移 v1 → v2（多 scope schema → 单 schema）');
    }

    await this.save();
    return this.store;
  }

  async save(): Promise<void> {
    if (!this.store) return;
    await this.plugin.saveData(this.store);
  }

  get(): MECEStore | null {
    return this.store;
  }

  // ---- Settings ----

  getSettings(): MECESettings {
    return this.store?.settings || { ...DEFAULT_SETTINGS };
  }

  async updateSettings(partial: Partial<MECESettings>): Promise<void> {
    if (!this.store) await this.load();
    if (!this.store) return;
    Object.assign(this.store.settings, partial);
    await this.save();
  }

  // ---- Taxonomy（全局唯一） ----

  /** 取全局分类体系（可能为 null） */
  getTaxonomy(): TaxonomySchema | null {
    return this.store?.taxonomy || null;
  }

  /** 写入/替换全局分类体系 */
  async setTaxonomy(taxonomy: TaxonomySchema): Promise<void> {
    if (!this.store) await this.load();
    if (!this.store) return;
    this.store.taxonomy = taxonomy;
    await this.save();
  }

  /** 清空分类体系 */
  async clearTaxonomy(): Promise<void> {
    if (!this.store) await this.load();
    if (!this.store) return;
    this.store.taxonomy = null;
    await this.save();
  }

  // ---- Reset ----

  async reset(): Promise<MECEStore> {
    const settings = this.store?.settings || { ...DEFAULT_SETTINGS };
    this.store = createEmptyStore();
    this.store.settings = settings;
    await this.save();
    return this.store;
  }

  async fullReset(): Promise<MECEStore> {
    this.store = createEmptyStore();
    await this.save();
    return this.store;
  }
}
