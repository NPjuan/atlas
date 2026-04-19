import { describe, it, expect } from 'vitest';
import { splitPaths, collectTaxonomyPathSet } from './types';
import type { TaxonomySchema } from '../types';

describe('splitPaths', () => {
  const existing = new Set(['哲学', '哲学/西方哲学', '哲学/西方哲学/康德']);

  it('全部命中现有分类 → tags 有值、newCategories 空', () => {
    const { tags, newCategories } = splitPaths(['哲学/西方哲学/康德'], existing);
    expect(tags).toEqual(['哲学/西方哲学/康德']);
    expect(newCategories).toEqual([]);
  });

  it('全部不在现有 → tags 和 newCategories 同内容', () => {
    const { tags, newCategories } = splitPaths(['前端开发/React'], existing);
    expect(tags).toEqual(['前端开发/React']);
    expect(newCategories).toEqual(['前端开发/React']);
  });

  it('混合现有 + 新 → 各自进正确字段', () => {
    const { tags, newCategories } = splitPaths(
      ['哲学/西方哲学', '前端开发/React', '前端开发/CSS'],
      existing,
    );
    expect(tags).toEqual(['哲学/西方哲学', '前端开发/React', '前端开发/CSS']);
    expect(newCategories).toEqual(['前端开发/React', '前端开发/CSS']);
  });

  it('去重：输入重复路径 → 只保留一次', () => {
    const { tags, newCategories } = splitPaths(
      ['前端开发/React', '前端开发/React', '哲学/西方哲学', '哲学/西方哲学'],
      existing,
    );
    expect(tags).toEqual(['前端开发/React', '哲学/西方哲学']);
    expect(newCategories).toEqual(['前端开发/React']);
  });

  it('过滤非字符串、空串、首尾空白', () => {
    const { tags, newCategories } = splitPaths(
      ['  前端开发/React  ', '', '   ', null as any, 42 as any, '哲学'],
      existing,
    );
    expect(tags).toEqual(['前端开发/React', '哲学']);
    expect(newCategories).toEqual(['前端开发/React']);
  });

  it('空输入', () => {
    const { tags, newCategories } = splitPaths([], existing);
    expect(tags).toEqual([]);
    expect(newCategories).toEqual([]);
  });

  it('顺序保持输入顺序', () => {
    const { tags } = splitPaths(['b/x', 'a/y', 'c/z'], new Set());
    expect(tags).toEqual(['b/x', 'a/y', 'c/z']);
  });
});

describe('collectTaxonomyPathSet', () => {
  it('扁平化多层树', () => {
    const tx: TaxonomySchema = {
      version: 1,
      rootName: '全部',
      createdAt: '',
      updatedAt: '',
      nodes: [
        {
          id: 'a', name: '哲学', fullPath: '哲学', description: '',
          children: [
            {
              id: 'b', name: '西方哲学', fullPath: '哲学/西方哲学', description: '',
              children: [
                { id: 'c', name: '康德', fullPath: '哲学/西方哲学/康德', description: '', children: [] },
              ],
            },
            { id: 'd', name: '东方哲学', fullPath: '哲学/东方哲学', description: '', children: [] },
          ],
        },
      ],
    };
    const set = collectTaxonomyPathSet(tx);
    expect(set).toEqual(new Set([
      '哲学',
      '哲学/西方哲学',
      '哲学/西方哲学/康德',
      '哲学/东方哲学',
    ]));
  });

  it('空 taxonomy → 空集合', () => {
    const tx: TaxonomySchema = {
      version: 1,
      rootName: '全部',
      createdAt: '',
      updatedAt: '',
      nodes: [],
    };
    expect(collectTaxonomyPathSet(tx).size).toBe(0);
  });
});
