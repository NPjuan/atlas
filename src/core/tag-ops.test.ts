import { describe, it, expect } from 'vitest';
import {
  tagAlreadyPrefixed,
  findScopeForFile,
  normalizeTagToFullPath,
  toViewTags,
  tagMatchesPath,
  tagIsUnderPath,
  updatePaths,
  findNodeById,
  collectFullPaths,
  collectAllFullPaths,
  collectAllIds,
  findAndModify,
  findAndRemove,
  insertChild,
  rewriteDiskTags,
} from './tag-ops';
import type { TaxonomyNode } from '../types';

// ============================================================
// 测试夹具
// ============================================================

const scopes = [
  { folderPath: '前端笔记', displayName: '前端笔记' },
  { folderPath: '哲学笔记', displayName: '哲学笔记' },
];

function makeNode(id: string, name: string, fullPath: string, children: TaxonomyNode[] = []): TaxonomyNode {
  return { id, name, fullPath, children };
}

// 一棵典型的 3 层测试树
//   哲学 (id=a)
//   └─ 西方哲学 (id=b)
//      ├─ 古典哲学 (id=c)
//      └─ 存在主义 (id=d)
//   伦理学 (id=e)
//   └─ 功利主义 (id=f)
const tree: TaxonomyNode[] = [
  makeNode('a', '哲学', '哲学', [
    makeNode('b', '西方哲学', '哲学/西方哲学', [
      makeNode('c', '古典哲学', '哲学/西方哲学/古典哲学'),
      makeNode('d', '存在主义', '哲学/西方哲学/存在主义'),
    ]),
  ]),
  makeNode('e', '伦理学', '伦理学', [
    makeNode('f', '功利主义', '伦理学/功利主义'),
  ]),
];

// ============================================================
// Scope 前缀辅助函数
// ============================================================

describe('tagAlreadyPrefixed', () => {
  it('完整匹配 displayName 本身', () => {
    expect(tagAlreadyPrefixed('前端笔记', scopes)).toBe(true);
  });
  it('tag 以 scope/ 开头', () => {
    expect(tagAlreadyPrefixed('前端笔记/React', scopes)).toBe(true);
    expect(tagAlreadyPrefixed('哲学笔记/哲学/西方哲学', scopes)).toBe(true);
  });
  it('tag 不带任何 scope 前缀', () => {
    expect(tagAlreadyPrefixed('哲学/西方哲学', scopes)).toBe(false);
    expect(tagAlreadyPrefixed('随便写个 tag', scopes)).toBe(false);
  });
  it('scope displayName 是 tag 某段的前缀但不是完整段', () => {
    // 「前端笔记xxx」不应误判为「前端笔记/xxx」
    expect(tagAlreadyPrefixed('前端笔记本', scopes)).toBe(false);
  });
});

describe('findScopeForFile', () => {
  it('笔记在某 scope 文件夹下', () => {
    expect(findScopeForFile('前端笔记/React.md', scopes)?.displayName).toBe('前端笔记');
  });
  it('笔记在 scope 子目录下', () => {
    expect(findScopeForFile('前端笔记/subfolder/React.md', scopes)?.displayName).toBe('前端笔记');
  });
  it('笔记在 vault 根目录（不属于任何 scope）', () => {
    expect(findScopeForFile('番茄工作法.md', scopes)).toBeNull();
  });
  it('同名前缀不应误匹配（前端笔记本.md）', () => {
    // file.path="前端笔记本/xxx.md" 不应该匹配到 "前端笔记" scope
    expect(findScopeForFile('前端笔记本/xxx.md', scopes)).toBeNull();
  });
  it('多个嵌套 scope 时选最具体的', () => {
    const nested = [
      { folderPath: '笔记', displayName: '笔记' },
      { folderPath: '笔记/前端', displayName: '前端' },
    ];
    expect(findScopeForFile('笔记/前端/React.md', nested)?.displayName).toBe('前端');
  });
});

// ============================================================
// normalizeTagToFullPath
// ============================================================

describe('normalizeTagToFullPath', () => {
  const fullPaths = ['哲学/西方哲学/古典哲学', '哲学/西方哲学/存在主义', '伦理学/功利主义'];

  it('直接相等时返回原值', () => {
    expect(normalizeTagToFullPath('哲学/西方哲学/古典哲学', fullPaths)).toBe('哲学/西方哲学/古典哲学');
  });
  it('用叶子名做后缀匹配返回完整 fullPath', () => {
    expect(normalizeTagToFullPath('古典哲学', fullPaths)).toBe('哲学/西方哲学/古典哲学');
    expect(normalizeTagToFullPath('功利主义', fullPaths)).toBe('伦理学/功利主义');
  });
  it('用中间段后缀匹配', () => {
    expect(normalizeTagToFullPath('西方哲学/古典哲学', fullPaths)).toBe('哲学/西方哲学/古典哲学');
  });
  it('多个 fullPath 都能匹配时选最长后缀（不存在完全相等时）', () => {
    const fps = ['B/A', 'C/B/A'];
    expect(normalizeTagToFullPath('A', fps)).toBe('C/B/A');
  });
  it('直接相等优先于后缀匹配', () => {
    // 如果 fullPaths 里同时存在 'A' 和更长的 'X/A'，应该优先返回 'A'（相等优先）
    const fps = ['A', 'X/A'];
    expect(normalizeTagToFullPath('A', fps)).toBe('A');
  });
  it('找不到匹配时原样返回', () => {
    expect(normalizeTagToFullPath('不存在的标签', fullPaths)).toBe('不存在的标签');
  });
  it('fullPaths 为空时原样返回', () => {
    expect(normalizeTagToFullPath('随便', [])).toBe('随便');
  });
});

// ============================================================
// toViewTags（集成测试）
// ============================================================

describe('toViewTags', () => {
  const allFullPaths = collectAllFullPaths(tree);

  it('非聚合视图：不补前缀，只做 normalize', () => {
    const result = toViewTags(['古典哲学'], '任意.md', null, allFullPaths);
    expect(result).toEqual(['哲学/西方哲学/古典哲学']);
  });

  it('聚合视图：笔记在 scope 下且 tag 不带前缀 → 补前缀', () => {
    const s = [{ folderPath: '哲学笔记', displayName: '哲学笔记' }];
    const fps = ['哲学笔记/哲学/西方哲学/古典哲学'];
    const result = toViewTags(['哲学/西方哲学/古典哲学'], '哲学笔记/柏拉图.md', s, fps);
    expect(result).toEqual(['哲学笔记/哲学/西方哲学/古典哲学']);
  });

  it('聚合视图：tag 已带前缀 → 不双重加前缀', () => {
    const s = [{ folderPath: '哲学笔记', displayName: '哲学笔记' }];
    const fps = ['哲学笔记/哲学/西方哲学'];
    const result = toViewTags(['哲学笔记/哲学/西方哲学'], '哲学笔记/柏拉图.md', s, fps);
    expect(result).toEqual(['哲学笔记/哲学/西方哲学']);
  });

  it('聚合视图：笔记在 vault 根 + tag 是叶子名 → 后缀归一化到带前缀 fullPath', () => {
    const s = [{ folderPath: '哲学笔记', displayName: '哲学笔记' }];
    const fps = ['哲学笔记/哲学/西方哲学/古典哲学'];
    const result = toViewTags(['古典哲学'], '番茄工作法.md', s, fps);
    expect(result).toEqual(['哲学笔记/哲学/西方哲学/古典哲学']);
  });

  it('空 tags 返回空数组', () => {
    expect(toViewTags([], 'a.md', scopes, [])).toEqual([]);
  });

  it('多 tag：只对 tags[0] 补前缀', () => {
    const s = [{ folderPath: '哲学笔记', displayName: '哲学笔记' }];
    const result = toViewTags(['哲学/A', '伦理学/B'], '哲学笔记/x.md', s, []);
    expect(result).toEqual(['哲学笔记/哲学/A', '伦理学/B']);
  });
});

// ============================================================
// tag 与 fullPath 匹配
// ============================================================

describe('tagMatchesPath', () => {
  it('直接相等', () => {
    expect(tagMatchesPath('哲学/西方哲学', '哲学/西方哲学', null)).toBe(true);
  });
  it('scope 剥离后相等', () => {
    expect(tagMatchesPath('西方哲学', '哲学笔记/西方哲学', [{ folderPath: '哲学笔记', displayName: '哲学笔记' }])).toBe(true);
  });
  it('不匹配', () => {
    expect(tagMatchesPath('哲学/A', '哲学/B', null)).toBe(false);
  });
});

describe('tagIsUnderPath', () => {
  it('直接后代', () => {
    expect(tagIsUnderPath('哲学/西方哲学/古典', '哲学/西方哲学', null)).toBe(true);
  });
  it('scope 剥离形态的后代', () => {
    expect(tagIsUnderPath('西方哲学/古典', '哲学笔记/西方哲学', [{ folderPath: '哲学笔记', displayName: '哲学笔记' }])).toBe(true);
  });
  it('边界：同名但不是后代（哲学/西方哲学X）', () => {
    expect(tagIsUnderPath('哲学/西方哲学X', '哲学/西方哲学', null)).toBe(false);
  });
  it('自身不是后代', () => {
    expect(tagIsUnderPath('哲学/西方哲学', '哲学/西方哲学', null)).toBe(false);
  });
});

// ============================================================
// 树操作
// ============================================================

describe('updatePaths', () => {
  it('顶层节点 fullPath = name', () => {
    const t = [makeNode('a', 'A', 'WRONG')];
    expect(updatePaths(t)[0].fullPath).toBe('A');
  });
  it('递归重算嵌套 fullPath', () => {
    const t = [makeNode('a', 'A', 'X', [makeNode('b', 'B', 'X/Y')])];
    const out = updatePaths(t);
    expect(out[0].fullPath).toBe('A');
    expect(out[0].children[0].fullPath).toBe('A/B');
  });
  it('不变原引用', () => {
    const out = updatePaths(tree);
    expect(out).not.toBe(tree);
    expect(out[0]).not.toBe(tree[0]);
  });
});

describe('findNodeById', () => {
  it('找到顶层节点', () => {
    expect(findNodeById(tree, 'a')?.name).toBe('哲学');
  });
  it('找到嵌套节点', () => {
    expect(findNodeById(tree, 'c')?.name).toBe('古典哲学');
  });
  it('找不到返回 null', () => {
    expect(findNodeById(tree, 'not-exist')).toBeNull();
  });
});

describe('collectFullPaths / collectAllFullPaths', () => {
  it('collectFullPaths: 节点+所有后代', () => {
    const node = findNodeById(tree, 'b')!;
    expect(collectFullPaths(node)).toEqual([
      '哲学/西方哲学',
      '哲学/西方哲学/古典哲学',
      '哲学/西方哲学/存在主义',
    ]);
  });
  it('collectAllFullPaths: 整棵树', () => {
    const all = collectAllFullPaths(tree);
    expect(all).toContain('哲学');
    expect(all).toContain('哲学/西方哲学/古典哲学');
    expect(all).toContain('伦理学/功利主义');
    expect(all).toHaveLength(6);
  });
});

describe('findAndModify', () => {
  it('改名', () => {
    const out = findAndModify(tree, 'c', n => ({ ...n, name: '新名字' }));
    expect(findNodeById(out, 'c')?.name).toBe('新名字');
    // 原树不变
    expect(findNodeById(tree, 'c')?.name).toBe('古典哲学');
  });
});

describe('findAndRemove', () => {
  it('移除叶子节点', () => {
    const out = findAndRemove(tree, 'c');
    expect(findNodeById(out, 'c')).toBeNull();
    expect(findNodeById(out, 'd')?.name).toBe('存在主义');  // 兄弟还在
  });
  it('移除含子树的节点', () => {
    const out = findAndRemove(tree, 'b');
    expect(findNodeById(out, 'b')).toBeNull();
    expect(findNodeById(out, 'c')).toBeNull();  // 子树也没了
    expect(findNodeById(out, 'd')).toBeNull();
  });
  it('移除顶层节点', () => {
    const out = findAndRemove(tree, 'e');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
  });
});

describe('insertChild', () => {
  it('在叶子下添加子节点', () => {
    const child = makeNode('x', 'X', '');
    const out = insertChild(tree, 'c', child);
    expect(findNodeById(out, 'c')?.children).toHaveLength(1);
    expect(findNodeById(out, 'x')?.name).toBe('X');
  });
});

// ============================================================
// rewriteDiskTags
// ============================================================

describe('rewriteDiskTags', () => {
  const agScopes = [{ folderPath: '哲学笔记', displayName: '哲学笔记' }];

  describe('删除模式（newPath=null）', () => {
    it('非聚合视图：完全匹配时删除', () => {
      const { changed, nextTags } = rewriteDiskTags(['哲学/西方哲学'], ['哲学/西方哲学'], null, null);
      expect(changed).toBe(true);
      expect(nextTags).toEqual([]);
    });

    it('后代匹配时也删除', () => {
      const { changed, nextTags } = rewriteDiskTags(
        ['哲学/西方哲学/古典哲学'],
        ['哲学/西方哲学'],
        null,
        null,
      );
      expect(changed).toBe(true);
      expect(nextTags).toEqual([]);
    });

    it('不匹配的保留', () => {
      const { changed, nextTags } = rewriteDiskTags(['伦理学/功利主义'], ['哲学/西方哲学'], null, null);
      expect(changed).toBe(false);
      expect(nextTags).toEqual(['伦理学/功利主义']);
    });

    it('聚合视图：磁盘 tag 是 scope 剥离形态也能匹配', () => {
      const { changed, nextTags } = rewriteDiskTags(
        ['西方哲学/古典哲学'],              // 磁盘 tag（scope 已剥离）
        ['哲学笔记/西方哲学/古典哲学'],      // oldPath（聚合 fullPath）
        null,
        agScopes,
      );
      expect(changed).toBe(true);
      expect(nextTags).toEqual([]);
    });
  });

  describe('重命名模式（newPath=string）', () => {
    it('非聚合视图：完全相等的 tag 被替换', () => {
      const { changed, nextTags } = rewriteDiskTags(
        ['哲学/西方哲学'],
        ['哲学/西方哲学'],
        '哲学/欧陆哲学',
        null,
      );
      expect(changed).toBe(true);
      expect(nextTags).toEqual(['哲学/欧陆哲学']);
    });

    it('后代 tag 前缀替换', () => {
      const { changed, nextTags } = rewriteDiskTags(
        ['哲学/西方哲学/古典'],
        ['哲学/西方哲学'],
        '哲学/欧陆哲学',
        null,
      );
      expect(changed).toBe(true);
      expect(nextTags).toEqual(['哲学/欧陆哲学/古典']);
    });

    it('聚合视图：磁盘是剥离形态 → 新 path 也剥离写回', () => {
      const { changed, nextTags } = rewriteDiskTags(
        ['西方哲学/古典'],
        ['哲学笔记/西方哲学'],
        '哲学笔记/欧陆',
        agScopes,
      );
      expect(changed).toBe(true);
      // 保持磁盘原本的 scope-stripped 形态
      expect(nextTags).toEqual(['欧陆/古典']);
    });

    it('不匹配的 tag 不变，changed=false', () => {
      const { changed, nextTags } = rewriteDiskTags(
        ['伦理学/A'],
        ['哲学/B'],
        '哲学/C',
        null,
      );
      expect(changed).toBe(false);
      expect(nextTags).toEqual(['伦理学/A']);
    });

    it('多个 oldPaths 任一命中即替换', () => {
      const { changed, nextTags } = rewriteDiskTags(
        ['A', 'B', 'C'],
        ['A', 'C'],
        null,
        null,
      );
      expect(changed).toBe(true);
      expect(nextTags).toEqual(['B']);
    });
  });
});

describe('collectAllIds', () => {
  it('递归收集所有节点 id', () => {
    const nodes = [
      { id: 'a', name: 'A', fullPath: 'A', children: [
        { id: 'b', name: 'B', fullPath: 'A/B', children: [
          { id: 'c', name: 'C', fullPath: 'A/B/C', children: [] },
        ] },
      ] },
      { id: 'd', name: 'D', fullPath: 'D', children: [] },
    ];
    expect(collectAllIds(nodes)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('空数组返回空数组', () => {
    expect(collectAllIds([])).toEqual([]);
  });
});
