import { describe, it, expect } from 'vitest';
import {
  rewritePaths,
  findScopeNode,
  replaceScopeNode,
  buildScopeViewSchema,
  collectAllFullPaths,
} from './taxonomy-scope';
import type { TaxonomyNode, TaxonomySchema } from '../types';

function makeNode(id: string, name: string, fullPath: string, children: TaxonomyNode[] = []): TaxonomyNode {
  return { id, name, fullPath, children };
}

function makeSchema(nodes: TaxonomyNode[], rootName = '全部'): TaxonomySchema {
  return {
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    maxDepth: 3,
    rootName,
    nodes,
  };
}

describe('rewritePaths', () => {
  it('给节点及子树加 parent 前缀', () => {
    const node = makeNode('a', 'A', 'A', [makeNode('b', 'B', 'A/B')]);
    const out = rewritePaths(node, 'Parent');
    expect(out.fullPath).toBe('Parent/A');
    expect(out.children[0].fullPath).toBe('Parent/A/B');
  });

  it('parentPath 为空时 fullPath = name', () => {
    const node = makeNode('a', 'A', 'anything', [makeNode('b', 'B', 'x/y')]);
    const out = rewritePaths(node, '');
    expect(out.fullPath).toBe('A');
    expect(out.children[0].fullPath).toBe('A/B');
  });
});

describe('findScopeNode', () => {
  it('taxonomy / folderPath 为空时返回 null', () => {
    expect(findScopeNode(null, '前端开发')).toBeNull();
    expect(findScopeNode(makeSchema([]), '')).toBeNull();
  });

  it('按 fullPath 严格匹配一级节点', () => {
    const tax = makeSchema([
      makeNode('a', '前端', '前端'),
      makeNode('b', '哲学', '哲学'),
    ]);
    expect(findScopeNode(tax, '前端')?.id).toBe('a');
    expect(findScopeNode(tax, '哲学')?.id).toBe('b');
  });

  it('按 fullPath 严格匹配任意层级节点（深度 >= 2）', () => {
    const tax = makeSchema([
      makeNode('p', '哲学', '哲学', [
        makeNode('c', '存在主义', '哲学/存在主义', [
          makeNode('g', '萨特', '哲学/存在主义/萨特'),
        ]),
      ]),
    ]);
    expect(findScopeNode(tax, '哲学/存在主义')?.id).toBe('c');
    expect(findScopeNode(tax, '哲学/存在主义/萨特')?.id).toBe('g');
  });

  it('严格匹配：大小写敏感', () => {
    const tax = makeSchema([makeNode('a', 'React', 'React')]);
    expect(findScopeNode(tax, 'react')).toBeNull();
    expect(findScopeNode(tax, 'React')?.id).toBe('a');
  });

  it('未命中返回 null', () => {
    const tax = makeSchema([makeNode('a', '前端', '前端')]);
    expect(findScopeNode(tax, '后端')).toBeNull();
    expect(findScopeNode(tax, '前端/React')).toBeNull();
  });

  it('同名节点：先遇到的先命中（深度优先左到右）', () => {
    const tax = makeSchema([
      makeNode('a', '前端', '前端', [makeNode('x', '前端', '前端/前端')]),
    ]);
    // "前端" 应该命中顶层，"前端/前端" 才命中深层
    expect(findScopeNode(tax, '前端')?.id).toBe('a');
    expect(findScopeNode(tax, '前端/前端')?.id).toBe('x');
  });
});

describe('replaceScopeNode', () => {
  it('nodeId 找不到返回 null', () => {
    const tax = makeSchema([makeNode('a', 'A', 'A')]);
    expect(replaceScopeNode(tax, 'nope', 'X', [])).toBeNull();
  });

  it('替换顶层节点的 children', () => {
    const tax = makeSchema([
      makeNode('a', '前端', '前端', [makeNode('x', 'X', '前端/X')]),
      makeNode('b', '哲学', '哲学', [makeNode('y', 'Y', '哲学/Y')]),
    ]);
    const updated = replaceScopeNode(tax, 'a', '前端', [makeNode('z', 'React', 'anything')]);
    expect(updated!.nodes[0].children).toHaveLength(1);
    expect(updated!.nodes[0].children[0].fullPath).toBe('前端/React');
    expect(updated!.nodes[1].children[0].id).toBe('y');
  });

  it('替换深层节点的 children（深度 2 及以上）', () => {
    const tax = makeSchema([
      makeNode('p', '哲学', '哲学', [
        makeNode('c', '存在主义', '哲学/存在主义', [makeNode('x', '旧子节点', '哲学/存在主义/旧子节点')]),
        makeNode('o', '认识论', '哲学/认识论'),
      ]),
    ]);
    const updated = replaceScopeNode(tax, 'c', '存在主义', [makeNode('n', '萨特', 'anything')]);
    const parent = updated!.nodes[0];
    // 父级未变
    expect(parent.name).toBe('哲学');
    expect(parent.fullPath).toBe('哲学');
    // 目标节点 children 被替换，fullPath 正确
    expect(parent.children[0].id).toBe('c');
    expect(parent.children[0].children).toHaveLength(1);
    expect(parent.children[0].children[0].fullPath).toBe('哲学/存在主义/萨特');
    // 兄弟节点未受影响
    expect(parent.children[1].id).toBe('o');
  });

  it('深层节点改名会级联重写子树的 fullPath', () => {
    const tax = makeSchema([
      makeNode('p', '哲学', '哲学', [
        makeNode('c', '存在主义', '哲学/存在主义', [
          makeNode('g', '萨特', '哲学/存在主义/萨特'),
        ]),
      ]),
    ]);
    const updated = replaceScopeNode(tax, 'c', 'Existentialism', tax.nodes[0].children[0].children);
    const renamed = updated!.nodes[0].children[0];
    expect(renamed.name).toBe('Existentialism');
    expect(renamed.fullPath).toBe('哲学/Existentialism');
    expect(renamed.children[0].fullPath).toBe('哲学/Existentialism/萨特');
    // 父级 fullPath 不受影响
    expect(updated!.nodes[0].fullPath).toBe('哲学');
  });

  it('updatedAt 被刷新', () => {
    const tax = { ...makeSchema([makeNode('a', 'A', 'A')]), updatedAt: '2026-01-01T00:00:00.000Z' };
    const updated = replaceScopeNode(tax, 'a', 'A', []);
    expect(updated!.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('未触及的节点引用不变', () => {
    const sibling = makeNode('b', '哲学', '哲学');
    const tax = makeSchema([makeNode('a', 'A', 'A'), sibling]);
    const updated = replaceScopeNode(tax, 'a', 'A', []);
    expect(updated!.nodes[1]).toBe(sibling);
  });
});

describe('buildScopeViewSchema', () => {
  it('把一级节点包成视图 schema', () => {
    const scopeNode = makeNode('a', '前端', '前端', [
      makeNode('b', 'React', '前端/React'),
    ]);
    const tax = makeSchema([scopeNode]);
    const view = buildScopeViewSchema(tax, scopeNode);
    expect(view.rootName).toBe('前端');
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0].fullPath).toBe('前端/React');
  });

  it('把深层节点包成视图 schema', () => {
    const deep = makeNode('c', '存在主义', '哲学/存在主义', [
      makeNode('g', '萨特', '哲学/存在主义/萨特'),
    ]);
    const view = buildScopeViewSchema(makeSchema([makeNode('p', '哲学', '哲学', [deep])]), deep);
    expect(view.rootName).toBe('存在主义');
    expect(view.nodes[0].fullPath).toBe('哲学/存在主义/萨特');
  });

  it('没有 children 时 nodes 为空数组', () => {
    const n = makeNode('a', '前端', '前端');
    expect(buildScopeViewSchema(makeSchema([n]), n).nodes).toEqual([]);
  });
});

describe('collectAllFullPaths', () => {
  it('收集所有层级的 fullPath', () => {
    const tax = makeSchema([
      makeNode('a', '前端', '前端', [
        makeNode('b', 'React', '前端/React', [makeNode('c', 'Hooks', '前端/React/Hooks')]),
      ]),
      makeNode('d', '哲学', '哲学'),
    ]);
    const paths = collectAllFullPaths(tax);
    expect(paths.has('前端')).toBe(true);
    expect(paths.has('前端/React')).toBe(true);
    expect(paths.has('前端/React/Hooks')).toBe(true);
    expect(paths.has('哲学')).toBe(true);
    expect(paths.size).toBe(4);
  });

  it('taxonomy 为 null 返回空 Set', () => {
    expect(collectAllFullPaths(null).size).toBe(0);
  });
});

describe('切片 → 改动 → 回写 全链路', () => {
  it('深层节点场景：选中哲学/存在主义、加子分类，写回后全局 taxonomy 对应更新', () => {
    const tax = makeSchema([
      makeNode('p', '哲学', '哲学', [
        makeNode('c', '存在主义', '哲学/存在主义', [makeNode('g', '萨特', '哲学/存在主义/萨特')]),
      ]),
    ]);

    const scope = findScopeNode(tax, '哲学/存在主义')!;
    const view = buildScopeViewSchema(tax, scope);
    // 模拟用户新增一个子分类
    const next: TaxonomyNode[] = [
      ...view.nodes,
      makeNode('n', '加缪', 'anything'),
    ];
    const updated = replaceScopeNode(tax, scope.id, view.rootName, next);

    const deepNode = updated!.nodes[0].children[0];
    expect(deepNode.children).toHaveLength(2);
    expect(deepNode.children[1].name).toBe('加缪');
    expect(deepNode.children[1].fullPath).toBe('哲学/存在主义/加缪');
  });
});
