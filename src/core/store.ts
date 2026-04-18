import { Plugin } from 'obsidian';
import {
  MECEStore,
  MECESettings,
  TaxonomySchema,
  STORE_VERSION,
  VAULT_SCOPE_KEY,
  createEmptyStore,
  DEFAULT_SETTINGS,
} from '../types';

/**
 * V3 Store 管理（全新设计，不兼容旧版本）
 *
 * 存储：
 * - taxonomies: 按文件夹隔离的分类体系（key 为文件夹路径或 __vault__）
 * - processedFiles: 增量检测用的 hash + 打标签时间
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

  /** 加载 store */
  async load(): Promise<MECEStore> {
    if (this.store) return this.store;

    const raw = await this.plugin.loadData();

    if (!raw || typeof raw !== 'object' || raw.version !== STORE_VERSION) {
      console.log('MECE V3: 创建全新 Store');
      this.store = createEmptyStore();
      await this.save();
      return this.store;
    }

    this.store = raw as MECEStore;
    this.store.settings = { ...DEFAULT_SETTINGS, ...this.store.settings };
    if (!this.store.taxonomies) this.store.taxonomies = {};

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

  // ---- Taxonomy（按文件夹） ----

  /** folderPath: undefined 或空字符串表示整个 Vault */
  private folderKey(folderPath: string | undefined): string {
    return folderPath && folderPath.trim() ? folderPath : VAULT_SCOPE_KEY;
  }

  getTaxonomy(folderPath?: string): TaxonomySchema | null {
    if (!this.store) return null;
    const key = this.folderKey(folderPath);
    return this.store.taxonomies[key] || null;
  }

  async setTaxonomy(folderPath: string | undefined, taxonomy: TaxonomySchema): Promise<void> {
    if (!this.store) await this.load();
    if (!this.store) return;
    const key = this.folderKey(folderPath);
    this.store.taxonomies[key] = taxonomy;
    await this.save();
  }

  async clearTaxonomy(folderPath?: string): Promise<void> {
    if (!this.store) await this.load();
    if (!this.store) return;
    const key = this.folderKey(folderPath);
    delete this.store.taxonomies[key];
    await this.save();
  }

  /** 列出所有已有 taxonomy 的 scope */
  listScopes(): string[] {
    return this.store ? Object.keys(this.store.taxonomies) : [];
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
