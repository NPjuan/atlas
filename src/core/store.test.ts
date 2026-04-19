import { describe, it, expect } from 'vitest';
import { migrateRawStore } from './store';
import { STORE_VERSION, DEFAULT_SETTINGS } from '../types';
import type { TaxonomySchema } from '../types';

function makeSchema(rootName: string): TaxonomySchema {
  return {
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    maxDepth: 3,
    rootName,
    nodes: [],
  };
}

describe('migrateRawStore', () => {
  it('空 raw / 非对象 → 创建全新 Store', () => {
    const fresh = migrateRawStore(null);
    expect(fresh.version).toBe(STORE_VERSION);
    expect(fresh.taxonomy).toBeNull();
    expect(fresh.processedFiles).toEqual({});

    expect(migrateRawStore(undefined).taxonomy).toBeNull();
    expect(migrateRawStore('garbage').taxonomy).toBeNull();
  });

  it('v1 存量数据：taxonomies["root"] 提升为 taxonomy', () => {
    const root = makeSchema('全部');
    const migrated = migrateRawStore({
      version: 1,
      taxonomies: { root, '前端笔记': makeSchema('前端') },
      processedFiles: {},
      settings: { ...DEFAULT_SETTINGS },
    });
    expect(migrated.taxonomy).toEqual(root);
    expect((migrated as any).taxonomies).toBeUndefined();
    expect(migrated.version).toBe(STORE_VERSION);
  });

  it('v1 存量数据：root 不存在时回退到 __vault__', () => {
    const legacy = makeSchema('legacy');
    const migrated = migrateRawStore({
      version: 1,
      taxonomies: { '__vault__': legacy, '前端笔记': makeSchema('x') },
      processedFiles: {},
      settings: { ...DEFAULT_SETTINGS },
    });
    expect(migrated.taxonomy).toEqual(legacy);
  });

  it('v1 存量数据：root / __vault__ 都没有 → taxonomy=null（用户需重新生成）', () => {
    const migrated = migrateRawStore({
      version: 1,
      taxonomies: { '前端笔记': makeSchema('x'), '哲学笔记': makeSchema('y') },
      processedFiles: {},
      settings: { ...DEFAULT_SETTINGS },
    });
    expect(migrated.taxonomy).toBeNull();
  });

  it('v2 数据不被误改（幂等）', () => {
    const tax = makeSchema('全部');
    const migrated = migrateRawStore({
      version: 2,
      taxonomy: tax,
      processedFiles: { 'a.md': { hash: 'h', processedAt: 'now' } },
      settings: { ...DEFAULT_SETTINGS },
    });
    expect(migrated.taxonomy).toEqual(tax);
    expect(migrated.processedFiles['a.md']).toBeDefined();
  });

  it('settings 合并默认值（新字段用默认，已有字段保留）', () => {
    const migrated = migrateRawStore({
      version: 1,
      taxonomies: {},
      processedFiles: {},
      settings: { aiProvider: 'deepseek', apiKey: 'sk-test', model: 'deepseek-chat' },
    });
    expect(migrated.settings.aiProvider).toBe('deepseek');
    expect(migrated.settings.maxTagsPerFile).toBe(DEFAULT_SETTINGS.maxTagsPerFile);
  });

  it('settings 迁移：旧版 apiKey/model 单值搬到 apiKeys/models', () => {
    const migrated = migrateRawStore({
      version: 1,
      taxonomies: {},
      processedFiles: {},
      settings: { ...DEFAULT_SETTINGS, aiProvider: 'claude', apiKey: 'sk-claude', model: 'claude-sonnet-4-20250514' },
    });
    expect(migrated.settings.apiKeys!.claude).toBe('sk-claude');
    expect(migrated.settings.models!.claude).toBe('claude-sonnet-4-20250514');
    // 兼容字段保持与当前 provider 同步
    expect(migrated.settings.apiKey).toBe('sk-claude');
    expect(migrated.settings.model).toBe('claude-sonnet-4-20250514');
  });

  it('ollama provider 不搬 apiKey（不需要）', () => {
    const migrated = migrateRawStore({
      version: 1,
      taxonomies: {},
      processedFiles: {},
      settings: { ...DEFAULT_SETTINGS, aiProvider: 'ollama', apiKey: 'unused', model: 'llama3.1' },
    });
    expect(migrated.settings.apiKeys!.ollama).toBeUndefined();
    expect(migrated.settings.models!.ollama).toBe('llama3.1');
  });

  it('processedFiles / taxonomy 缺失时兜底为空', () => {
    const migrated = migrateRawStore({ version: 2, settings: { ...DEFAULT_SETTINGS } });
    expect(migrated.taxonomy).toBeNull();
    expect(migrated.processedFiles).toEqual({});
  });

  it('version 总是被写成当前 STORE_VERSION', () => {
    expect(migrateRawStore({ version: 1, taxonomies: {}, settings: { ...DEFAULT_SETTINGS } }).version).toBe(STORE_VERSION);
    expect(migrateRawStore({ version: 999, taxonomy: null, settings: { ...DEFAULT_SETTINGS } }).version).toBe(STORE_VERSION);
  });

  it('新用户（空 store）拿到 DEFAULT 预置的推荐模型', () => {
    const migrated = migrateRawStore(null);
    // aiProvider 默认 deepseek，应该自动拿到 deepseek-chat
    expect(migrated.settings.aiProvider).toBe('deepseek');
    expect(migrated.settings.model).toBe('deepseek-chat');
    expect(migrated.settings.models!.claude).toBe('claude-sonnet-4-20250514');
    expect(migrated.settings.models!.openai).toBe('gpt-4o');
  });

  it('老用户显式选择过的模型优先于 DEFAULT 预置', () => {
    // 模拟老存量数据：没有 models 字段，只有兼容字段 model='llama3.1'
    const migrated = migrateRawStore({
      version: 1,
      taxonomies: {},
      processedFiles: {},
      settings: { aiProvider: 'ollama', apiKey: '', model: 'llama3.1' },
    });
    // 用户显式选过 llama3.1，应该保留，不被 DEFAULT 的 qwen2.5 覆盖
    expect(migrated.settings.models!.ollama).toBe('llama3.1');
    expect(migrated.settings.model).toBe('llama3.1');
  });

  it('老用户切到没用过的 provider 时，能拿到 DEFAULT 预置', () => {
    const migrated = migrateRawStore({
      version: 1,
      taxonomies: {},
      processedFiles: {},
      settings: { aiProvider: 'ollama', apiKey: '', model: 'llama3.1' },
    });
    // 虽然当前 provider 是 ollama，claude 也会被补上 DEFAULT 预置
    expect(migrated.settings.models!.claude).toBe('claude-sonnet-4-20250514');
  });
});
