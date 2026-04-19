import { describe, it, expect } from 'vitest';
import { pickStrategy } from './factory';
import { SequentialStrategy } from './sequential';
import { BatchStrategy } from './batch';
import type { AIProvider } from '../../ai/types';

function makeProvider(supportBatch: boolean): AIProvider {
  return {
    name: 'mock',
    testConnection: async () => {},
    suggestTags: async () => ({ tags: [] }),
    suggestTagsConstrained: async () => ({ tags: [], newCategories: [] }),
    generateTaxonomy: async () => ({ taxonomy: [] as any }),
    ...(supportBatch ? { suggestTagsConstrainedBatch: async () => ({ items: [] }) } : {}),
  };
}

describe('pickStrategy', () => {
  it('用户指定 sequential', () => {
    const s = pickStrategy({ strategy: 'sequential', provider: makeProvider(true), fileCount: 10 });
    expect(s).toBeInstanceOf(SequentialStrategy);
  });

  it('用户指定 batch', () => {
    const s = pickStrategy({ strategy: 'batch', provider: makeProvider(true), fileCount: 10 });
    expect(s).toBeInstanceOf(BatchStrategy);
  });

  it('auto + provider 支持批量 + 多文件 → batch', () => {
    const s = pickStrategy({ strategy: 'auto', provider: makeProvider(true), fileCount: 10 });
    expect(s).toBeInstanceOf(BatchStrategy);
  });

  it('auto + provider 不支持批量 → sequential', () => {
    const s = pickStrategy({ strategy: 'auto', provider: makeProvider(false), fileCount: 10 });
    expect(s).toBeInstanceOf(SequentialStrategy);
  });

  it('auto + 只有 1 篇 → sequential', () => {
    const s = pickStrategy({ strategy: 'auto', provider: makeProvider(true), fileCount: 1 });
    expect(s).toBeInstanceOf(SequentialStrategy);
  });

  it('auto + 0 篇 → sequential', () => {
    const s = pickStrategy({ strategy: 'auto', provider: makeProvider(true), fileCount: 0 });
    expect(s).toBeInstanceOf(SequentialStrategy);
  });
});
