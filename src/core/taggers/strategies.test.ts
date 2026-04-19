import { describe, it, expect, vi } from 'vitest';
import { SequentialStrategy } from './sequential';
import { BatchStrategy } from './batch';
import type { TaggerFile, TaggerContext } from './types';
import type { AIProvider, ConstrainedTaggingResult, BatchConstrainedTaggingResult } from '../../ai/types';
import type { TaxonomySchema } from '../../types';

// ============================================================
// Mock 工具
// ============================================================

function makeTaxonomy(): TaxonomySchema {
  return {
    version: 1,
    createdAt: '',
    updatedAt: '',
    maxDepth: 3,
    rootName: 'root',
    nodes: [],
  };
}

function makeFile(path: string, summary?: string, oldTags: string[] = []): TaggerFile {
  return {
    filePath: path,
    content: `content of ${path}`,
    oldTags,
    summary,
  };
}

function makeContext(provider: AIProvider): TaggerContext {
  return {
    provider,
    taxonomy: makeTaxonomy(),
    maxTags: 3,
    intensity: 'conservative',
    verbose: false,
  };
}

/** 最小 mock provider 骨架 */
function mockProvider(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    name: 'mock',
    testConnection: async () => {},
    suggestTags: async () => ({ tags: [] }),
    suggestTagsConstrained: async () => ({ tags: [], newCategories: [] }),
    generateTaxonomy: async () => ({ taxonomy: [] as any }),
    ...overrides,
  };
}

// ============================================================
// SequentialStrategy
// ============================================================

describe('SequentialStrategy', () => {
  it('对每个文件调用一次 suggestTagsConstrained', async () => {
    const stub = vi.fn<[any, any, any, any, any, any?, any?], Promise<ConstrainedTaggingResult>>(
      async () => ({ tags: ['x/y'], newCategories: [] }),
    );
    const provider = mockProvider({ suggestTagsConstrained: stub as any });
    const files = [makeFile('a.md'), makeFile('b.md'), makeFile('c.md')];

    const result = await new SequentialStrategy().tag(files, makeContext(provider));

    expect(stub).toHaveBeenCalledTimes(3);
    expect(result.byFile.size).toBe(3);
    expect(result.byFile.get('a.md')?.tags).toEqual(['x/y']);
    expect(result.failedPaths).toEqual([]);
  });

  it('pendingNewCategories 逐次累积', async () => {
    // 第 1 篇建议新分类 "A"，第 2 篇建议 "B"；第 3 次调用时 AI 应收到 ["A","B"]
    const pendingSeen: string[][] = [];
    const stub = vi.fn(async (
      _content: string, _file: string, _old: string[],
      _tax: any, _max: number, _int: any, pending?: string[],
    ): Promise<ConstrainedTaggingResult> => {
      pendingSeen.push(pending ?? []);
      const idx = pendingSeen.length;
      return { tags: [`t${idx}`], newCategories: idx === 1 ? ['A'] : idx === 2 ? ['B'] : [] };
    });
    const provider = mockProvider({ suggestTagsConstrained: stub as any });

    const result = await new SequentialStrategy().tag(
      [makeFile('a.md'), makeFile('b.md'), makeFile('c.md')],
      makeContext(provider),
    );

    expect(pendingSeen[0]).toEqual([]);
    expect(pendingSeen[1]).toEqual(['A']);
    expect(pendingSeen[2]).toEqual(['A', 'B']);
    expect(result.allNewCategories).toEqual(['A', 'B']);
  });

  it('有 summary 时传摘要而不是原文', async () => {
    const stub = vi.fn(async (content: string): Promise<ConstrainedTaggingResult> => {
      return { tags: [content], newCategories: [] };  // tag 返回 AI "收到的内容"
    });
    const provider = mockProvider({ suggestTagsConstrained: stub as any });

    const result = await new SequentialStrategy().tag(
      [makeFile('a.md', '这是摘要')],
      makeContext(provider),
    );
    expect(result.byFile.get('a.md')?.tags).toEqual(['这是摘要']);
  });

  it('无 summary 时 fallback 到原文', async () => {
    const stub = vi.fn(async (content: string): Promise<ConstrainedTaggingResult> => {
      return { tags: [content], newCategories: [] };
    });
    const provider = mockProvider({ suggestTagsConstrained: stub as any });

    const result = await new SequentialStrategy().tag(
      [makeFile('a.md')],  // summary=undefined
      makeContext(provider),
    );
    expect(result.byFile.get('a.md')?.tags).toEqual(['content of a.md']);
  });

  it('单篇失败不影响其他篇', async () => {
    let count = 0;
    const stub = vi.fn(async (): Promise<ConstrainedTaggingResult> => {
      count++;
      if (count === 2) throw new Error('boom');
      return { tags: [`t${count}`], newCategories: [] };
    });
    const provider = mockProvider({ suggestTagsConstrained: stub as any });

    const result = await new SequentialStrategy().tag(
      [makeFile('a.md'), makeFile('b.md'), makeFile('c.md')],
      makeContext(provider),
    );

    expect(result.successCount).toBe(2);
    expect(result.failedPaths).toEqual(['b.md']);
    expect(result.byFile.has('a.md')).toBe(true);
    expect(result.byFile.has('c.md')).toBe(true);
    expect(result.byFile.has('b.md')).toBe(false);
  });

  it('isCancelled 返回 true 时中止', async () => {
    const stub = vi.fn(async (): Promise<ConstrainedTaggingResult> => ({ tags: [], newCategories: [] }));
    const provider = mockProvider({ suggestTagsConstrained: stub as any });
    const ctx = makeContext(provider);
    let count = 0;
    ctx.isCancelled = () => ++count > 1;  // 第二轮返回 true

    await new SequentialStrategy().tag(
      [makeFile('a.md'), makeFile('b.md'), makeFile('c.md')],
      ctx,
    );
    expect(stub).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// BatchStrategy
// ============================================================

describe('BatchStrategy', () => {
  it('provider 不支持批量时完全走 fallback', async () => {
    const seqStub = vi.fn(async (): Promise<ConstrainedTaggingResult> => ({
      tags: ['fallback'], newCategories: [],
    }));
    const provider = mockProvider({
      suggestTagsConstrained: seqStub as any,
      // 没有 suggestTagsConstrainedBatch
    });

    const result = await new BatchStrategy().tag(
      [makeFile('a.md'), makeFile('b.md')],
      makeContext(provider),
    );

    expect(seqStub).toHaveBeenCalledTimes(2);
    expect(result.byFile.get('a.md')?.tags).toEqual(['fallback']);
  });

  it('一次批量：所有文件一次调用', async () => {
    const batchStub = vi.fn(async (inputs: any[]): Promise<BatchConstrainedTaggingResult> => {
      return {
        items: inputs.map((it: any) => ({
          file: it.filePath,
          tags: [`t:${it.filePath}`],
          newCategories: [],
        })),
      };
    });
    const provider = mockProvider({ suggestTagsConstrainedBatch: batchStub as any });

    const result = await new BatchStrategy({ chunkSize: 10 }).tag(
      [makeFile('a.md'), makeFile('b.md'), makeFile('c.md')],
      makeContext(provider),
    );

    expect(batchStub).toHaveBeenCalledTimes(1);
    expect(result.byFile.size).toBe(3);
    expect(result.byFile.get('b.md')?.tags).toEqual(['t:b.md']);
  });

  it('分块：按 chunkSize 切分调用', async () => {
    const batchStub = vi.fn(async (inputs: any[]): Promise<BatchConstrainedTaggingResult> => ({
      items: inputs.map((it: any) => ({ file: it.filePath, tags: ['x'], newCategories: [] })),
    }));
    const provider = mockProvider({ suggestTagsConstrainedBatch: batchStub as any });
    const files = Array.from({ length: 7 }, (_, i) => makeFile(`f${i}.md`));

    await new BatchStrategy({ chunkSize: 3 }).tag(files, makeContext(provider));

    // 7 篇 / 3 = 3 批（3, 3, 1）
    expect(batchStub).toHaveBeenCalledTimes(3);
    expect((batchStub.mock.calls[0][0] as any[]).length).toBe(3);
    expect((batchStub.mock.calls[1][0] as any[]).length).toBe(3);
    expect((batchStub.mock.calls[2][0] as any[]).length).toBe(1);
  });

  it('chunk 间共享 pendingNewCategories', async () => {
    const pendingSeen: string[][] = [];
    const batchStub = vi.fn(async (
      inputs: any[], _tax: any, _max: number, _int: any, pending?: string[],
    ): Promise<BatchConstrainedTaggingResult> => {
      pendingSeen.push(pending ?? []);
      // 第一批建议 "新分类A"
      const newCats = pendingSeen.length === 1 ? ['新分类A'] : [];
      return {
        items: inputs.map((it: any) => ({
          file: it.filePath, tags: ['x'], newCategories: newCats,
        })),
      };
    });
    const provider = mockProvider({ suggestTagsConstrainedBatch: batchStub as any });
    const files = Array.from({ length: 4 }, (_, i) => makeFile(`f${i}.md`));

    const result = await new BatchStrategy({ chunkSize: 2 }).tag(files, makeContext(provider));

    expect(pendingSeen[0]).toEqual([]);
    expect(pendingSeen[1]).toEqual(['新分类A']);  // 第二批收到第一批累积
    expect(result.allNewCategories).toEqual(['新分类A']);
  });

  it('某批失败 → 走 fallback', async () => {
    let call = 0;
    const batchStub = vi.fn(async (inputs: any[]): Promise<BatchConstrainedTaggingResult> => {
      call++;
      if (call === 2) throw new Error('batch failed');
      return {
        items: inputs.map((it: any) => ({ file: it.filePath, tags: ['batch'], newCategories: [] })),
      };
    });
    const seqStub = vi.fn(async (_content: string, file: string): Promise<ConstrainedTaggingResult> => ({
      tags: ['fallback'], newCategories: [],
    }));
    const provider = mockProvider({
      suggestTagsConstrained: seqStub as any,
      suggestTagsConstrainedBatch: batchStub as any,
    });
    const files = Array.from({ length: 4 }, (_, i) => makeFile(`f${i}.md`));

    const result = await new BatchStrategy({ chunkSize: 2 }).tag(files, makeContext(provider));

    expect(batchStub).toHaveBeenCalledTimes(2);
    // 第二批失败 → 2 篇走 fallback
    expect(seqStub).toHaveBeenCalledTimes(2);
    expect(result.byFile.get('f0.md')?.tags).toEqual(['batch']);
    expect(result.byFile.get('f2.md')?.tags).toEqual(['fallback']);
    expect(result.byFile.get('f3.md')?.tags).toEqual(['fallback']);
  });

  it('批量返回漏掉某些文件 → 漏答的走 fallback', async () => {
    const batchStub = vi.fn(async (inputs: any[]): Promise<BatchConstrainedTaggingResult> => ({
      items: [
        // 只返回 inputs[0]，inputs[1] 被漏掉
        { file: inputs[0].filePath, tags: ['batch'], newCategories: [] },
      ],
    }));
    const seqStub = vi.fn(async (): Promise<ConstrainedTaggingResult> => ({
      tags: ['fallback'], newCategories: [],
    }));
    const provider = mockProvider({
      suggestTagsConstrained: seqStub as any,
      suggestTagsConstrainedBatch: batchStub as any,
    });
    const files = [makeFile('a.md'), makeFile('b.md')];

    const result = await new BatchStrategy({ chunkSize: 10 }).tag(files, makeContext(provider));

    expect(result.byFile.get('a.md')?.tags).toEqual(['batch']);
    expect(result.byFile.get('b.md')?.tags).toEqual(['fallback']);
    expect(seqStub).toHaveBeenCalledTimes(1);  // 只漏答 1 篇
  });

  it('批量返回的 AI 数据不规范也不会炸（测 normalize 兜底）', async () => {
    const batchStub = vi.fn(async (): Promise<any> => {
      // 返回不规范形态
      return { results: [{ file: 'a.md', tags: 'should be array' }] };
    });
    const seqStub = vi.fn(async (): Promise<ConstrainedTaggingResult> => ({
      tags: ['fallback'], newCategories: [],
    }));
    const provider = mockProvider({
      suggestTagsConstrained: seqStub as any,
      suggestTagsConstrainedBatch: batchStub as any,
    });

    const result = await new BatchStrategy({ chunkSize: 10 }).tag(
      [makeFile('a.md'), makeFile('b.md')],
      makeContext(provider),
    );

    // a.md 被返回但 tags 非法 → normalize 后 tags=[]，仍认为"处理过"
    // b.md 没出现在结果里 → 漏答走 fallback
    expect(result.byFile.get('a.md')?.tags).toEqual([]);
    expect(result.byFile.get('b.md')?.tags).toEqual(['fallback']);
  });
});
