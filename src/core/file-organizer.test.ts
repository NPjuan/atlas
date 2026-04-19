import { describe, it, expect } from 'vitest';
import {
  computeTargetPath,
  extractFileName,
  planFileMoves,
  resolveConflict,
  collectFoldersToCreate,
} from './file-organizer';

describe('computeTargetPath', () => {
  it('基础：tag + 文件名拼接', () => {
    expect(computeTargetPath('前端开发/React', 'Hooks.md')).toBe('前端开发/React/Hooks.md');
  });

  it('tag 首尾空白清掉', () => {
    expect(computeTargetPath('  前端开发/React  ', 'Hooks.md')).toBe('前端开发/React/Hooks.md');
  });

  it('tag 尾部斜杠清掉', () => {
    expect(computeTargetPath('前端开发/', 'x.md')).toBe('前端开发/x.md');
  });

  it('空 tag → 直接文件名', () => {
    expect(computeTargetPath('', 'x.md')).toBe('x.md');
  });
});

describe('extractFileName', () => {
  it('基础', () => {
    expect(extractFileName('a/b/c.md')).toBe('c.md');
  });
  it('无 / → 原样', () => {
    expect(extractFileName('c.md')).toBe('c.md');
  });
});

describe('planFileMoves', () => {
  it('单 tag：规划到 tag 路径', () => {
    const actions = planFileMoves(
      [{ currentPath: '前端笔记/Hooks.md', tags: ['前端开发/React'] }],
      new Set(['前端笔记/Hooks.md']),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].fromPath).toBe('前端笔记/Hooks.md');
    expect(actions[0].toPath).toBe('前端开发/React/Hooks.md');
    expect(actions[0].chosenTag).toBe('前端开发/React');
    expect(actions[0].alreadyInPlace).toBe(false);
    expect(actions[0].hasNameConflict).toBe(false);
    expect(actions[0].needsUserPickTag).toBe(false);
  });

  it('已在正确位置 → alreadyInPlace=true', () => {
    const actions = planFileMoves(
      [{ currentPath: '前端开发/React/Hooks.md', tags: ['前端开发/React'] }],
      new Set(['前端开发/React/Hooks.md']),
    );
    expect(actions[0].alreadyInPlace).toBe(true);
  });

  it('空 tag → alreadyInPlace + 不动', () => {
    const actions = planFileMoves(
      [{ currentPath: 'a.md', tags: [] }],
      new Set(['a.md']),
    );
    expect(actions[0].alreadyInPlace).toBe(true);
    expect(actions[0].toPath).toBe('a.md');
  });

  it('冲突：目标已存在同名文件', () => {
    const actions = planFileMoves(
      [{ currentPath: '前端笔记/Hooks.md', tags: ['前端开发/React'] }],
      new Set(['前端笔记/Hooks.md', '前端开发/React/Hooks.md']),  // 目标已有
    );
    expect(actions[0].hasNameConflict).toBe(true);
  });

  it('多 tag 且目标路径不同 → needsUserPickTag=true', () => {
    const actions = planFileMoves(
      [{ currentPath: 'x.md', tags: ['前端开发/React', '哲学/康德'] }],
      new Set(['x.md']),
    );
    expect(actions[0].needsUserPickTag).toBe(true);
    expect(actions[0].chosenTag).toBe('前端开发/React');  // 默认 tags[0]
  });

  it('多 tag 但目标路径一致（同 tag） → 不需要用户选', () => {
    const actions = planFileMoves(
      [{ currentPath: 'x.md', tags: ['前端开发/React', '前端开发/React'] }],
      new Set(['x.md']),
    );
    expect(actions[0].needsUserPickTag).toBe(false);
  });

  it('两篇同名笔记规划到同一目标 → 后者检测到冲突', () => {
    const actions = planFileMoves(
      [
        { currentPath: 'A/Hooks.md', tags: ['X'] },
        { currentPath: 'B/Hooks.md', tags: ['X'] },
      ],
      new Set(['A/Hooks.md', 'B/Hooks.md']),
    );
    expect(actions[0].toPath).toBe('X/Hooks.md');
    expect(actions[0].hasNameConflict).toBe(false);
    // 第二条：第一条已占用 X/Hooks.md
    expect(actions[1].hasNameConflict).toBe(true);
  });

  it('过滤非字符串/空白 tag', () => {
    const actions = planFileMoves(
      [{ currentPath: 'x.md', tags: ['  ', '' as any, null as any, '前端开发/React'] }],
      new Set(['x.md']),
    );
    expect(actions[0].chosenTag).toBe('前端开发/React');
    expect(actions[0].allTags).toEqual(['前端开发/React']);
  });
});

describe('resolveConflict', () => {
  const action = {
    fromPath: 'a/Hooks.md',
    toPath: '前端开发/React/Hooks.md',
    chosenTag: '前端开发/React',
    allTags: ['前端开发/React'],
    needsUserPickTag: false,
    hasNameConflict: true,
    alreadyInPlace: false,
  };

  it('skip：原样返回', () => {
    expect(resolveConflict(action, 'skip')).toEqual(action);
  });

  it('overwrite：原样返回', () => {
    expect(resolveConflict(action, 'overwrite')).toEqual(action);
  });

  it('rename：加时间戳且清掉 conflict 标记', () => {
    const next = resolveConflict(action, 'rename');
    expect(next.hasNameConflict).toBe(false);
    expect(next.toPath).toMatch(/^前端开发\/React\/Hooks-\d{8}\.md$/);
  });

  it('rename：无扩展名也能处理', () => {
    const a = { ...action, toPath: 'a/b/c' };
    const next = resolveConflict(a, 'rename');
    expect(next.toPath).toMatch(/^a\/b\/c-\d{8}$/);
  });

  it('非冲突态：不动', () => {
    const a = { ...action, hasNameConflict: false };
    expect(resolveConflict(a, 'rename')).toEqual(a);
  });
});

describe('collectFoldersToCreate', () => {
  it('多级目录', () => {
    expect(collectFoldersToCreate('前端开发/React/Hooks.md'))
      .toEqual(['前端开发', '前端开发/React']);
  });

  it('单层', () => {
    expect(collectFoldersToCreate('前端开发/x.md')).toEqual(['前端开发']);
  });

  it('根目录无文件夹', () => {
    expect(collectFoldersToCreate('x.md')).toEqual([]);
  });
});
