import { describe, it, expect } from 'vitest';
import { normalizeBatchResult, mergeNewCategories, chunk } from './types';

describe('normalizeBatchResult', () => {
  it('null / undefined 返回空数组', () => {
    expect(normalizeBatchResult(null)).toEqual([]);
    expect(normalizeBatchResult(undefined)).toEqual([]);
  });

  it('非对象返回空', () => {
    expect(normalizeBatchResult('hello')).toEqual([]);
    expect(normalizeBatchResult(42)).toEqual([]);
  });

  it('直接返回数组', () => {
    const raw = [
      { file: 'a.md', tags: ['哲学'], newCategories: [] },
      { file: 'b.md', tags: ['前端/React'], newCategories: ['前端/性能'] },
    ];
    const out = normalizeBatchResult(raw);
    expect(out).toHaveLength(2);
    expect(out[0].file).toBe('a.md');
    expect(out[1].newCategories).toEqual(['前端/性能']);
  });

  it('包装对象 {items: [...]}', () => {
    const raw = { items: [{ file: 'a.md', tags: [] }] };
    expect(normalizeBatchResult(raw)).toHaveLength(1);
  });

  it('包装对象 {results: [...]}', () => {
    const raw = { results: [{ file: 'a.md', tags: ['x'] }] };
    expect(normalizeBatchResult(raw)[0].tags).toEqual(['x']);
  });

  it('包装对象 {data: [...]}', () => {
    const raw = { data: [{ file: 'a.md', tags: ['x'] }] };
    expect(normalizeBatchResult(raw)[0].file).toBe('a.md');
  });

  it('AI 偶尔返回单个对象而非数组', () => {
    const raw = { file: 'single.md', tags: ['x'] };
    const out = normalizeBatchResult(raw);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe('single.md');
  });

  it('缺 file 字段的条目被丢弃', () => {
    const raw = [
      { file: 'a.md', tags: ['x'] },
      { tags: ['y'] },  // 缺 file
      { file: '', tags: ['z'] },  // file 空
      { file: '   ', tags: ['z'] },  // file 空白
    ];
    const out = normalizeBatchResult(raw);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe('a.md');
  });

  it('tags 非数组时视为空', () => {
    const raw = [{ file: 'a.md', tags: 'not an array' }];
    expect(normalizeBatchResult(raw)[0].tags).toEqual([]);
  });

  it('tags 内非字符串/空字符串被过滤', () => {
    const raw = [{ file: 'a.md', tags: ['ok', '', '  ', null, 42, '有效'] }];
    expect(normalizeBatchResult(raw)[0].tags).toEqual(['ok', '有效']);
  });

  it('newCategories 缺省时返回空数组', () => {
    const raw = [{ file: 'a.md', tags: ['x'] }];
    expect(normalizeBatchResult(raw)[0].newCategories).toEqual([]);
  });

  it('file 两侧空白会被 trim', () => {
    const raw = [{ file: '  a.md  ', tags: [] }];
    expect(normalizeBatchResult(raw)[0].file).toBe('a.md');
  });

  it('tags 元素两侧空白会被 trim', () => {
    const raw = [{ file: 'a.md', tags: ['  x  '] }];
    expect(normalizeBatchResult(raw)[0].tags).toEqual(['x']);
  });

  it('混合一堆垃圾输入不炸', () => {
    const raw = [
      null,
      undefined,
      'string',
      42,
      { file: 'a.md', tags: ['x'] },
      { notfile: 'xx' },
    ];
    const out = normalizeBatchResult(raw);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe('a.md');
  });
});

describe('mergeNewCategories', () => {
  it('保持首次出现顺序', () => {
    expect(mergeNewCategories(['a', 'b'], ['c', 'a', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('空合并', () => {
    expect(mergeNewCategories([], [])).toEqual([]);
    expect(mergeNewCategories(['a'], [])).toEqual(['a']);
    expect(mergeNewCategories([], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('不修改原数组', () => {
    const prev = ['a'];
    mergeNewCategories(prev, ['b']);
    expect(prev).toEqual(['a']);
  });
});

describe('chunk', () => {
  it('常规切分', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('size >= length', () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it('空数组', () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it('size 非正数时返回整体一份', () => {
    expect(chunk([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
  });
});
