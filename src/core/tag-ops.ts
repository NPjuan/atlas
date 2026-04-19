/**
 * 纯函数：与笔记 tag 相关的字符串/路径处理
 *
 * 此文件只依赖 types.ts，不引入 Obsidian API。
 * 所有函数都应该是可单测的纯函数。
 */

import type { TaxonomyNode } from '../types';

// ============================================================
// 基础类型
// ============================================================

export interface AggregateScope {
  /** vault 里的文件夹路径，如 "前端笔记" */
  folderPath: string;
  /** 聚合视图下一级节点的显示名（也是 tag 前缀），通常等于 folderPath 的最后一段 */
  displayName: string;
}

// ============================================================
// Scope 前缀补剥
// ============================================================

/**
 * 判断一个 tag 是否已经带了任一 scope 的前缀。
 * 例如 scopes=[{displayName:'前端笔记'}]，tag="前端笔记/React/Hooks" → true
 */
export function tagAlreadyPrefixed(tag: string, scopes: AggregateScope[]): boolean {
  for (const s of scopes) {
    if (tag === s.displayName) return true;
    if (tag.startsWith(s.displayName + '/')) return true;
  }
  return false;
}

/**
 * 按笔记 file 路径找它所属的 scope。找不到返回 null。
 * 多个 scope 匹配时取 folderPath 最长的（最具体的）。
 */
export function findScopeForFile(
  filePath: string,
  scopes: AggregateScope[],
): AggregateScope | null {
  const sorted = [...scopes].sort((a, b) => b.folderPath.length - a.folderPath.length);
  for (const s of sorted) {
    const p = s.folderPath.endsWith('/') ? s.folderPath : s.folderPath + '/';
    if (filePath.startsWith(p)) return s;
  }
  return null;
}

/**
 * 把一个 tag 归一化到 taxonomy 里存在的 fullPath：
 * 1) 直接等于某个 fullPath → 返回原值
 * 2) 某个 fullPath 以 "/${tag}" 结尾 → 返回最长匹配（避免歧义）
 * 3) 找不到 → 返回原 tag
 */
export function normalizeTagToFullPath(tag: string, fullPaths: string[]): string {
  if (fullPaths.length === 0) return tag;
  for (const fp of fullPaths) {
    if (fp === tag) return fp;
  }
  // 按长度降序找最长匹配的后缀
  const sorted = [...fullPaths].sort((a, b) => b.length - a.length);
  for (const fp of sorted) {
    if (fp.endsWith('/' + tag)) return fp;
  }
  return tag;
}

/**
 * 聚合视图下把笔记的磁盘 tags 变换为"视图 tags"：
 *  1. 如果笔记在某 scope 下、tag 不带任何 scope 前缀 → 给 tags[0] 补前缀
 *  2. 如果 taxonomy 中有完整 fullPath 能匹配 → 归一化为完整 fullPath
 *
 * @param diskTags    笔记 frontmatter 里真实存的 tag 列表
 * @param filePath    笔记相对 vault 根的路径
 * @param scopes      聚合视图的 scope 列表（null/空数组 = 非聚合视图）
 * @param fullPaths   taxonomy 里所有节点的 fullPath 集合（用于归一化，可空）
 * @returns 视图层展示用的 tag 列表
 */
export function toViewTags(
  diskTags: string[],
  filePath: string,
  scopes: AggregateScope[] | null,
  fullPaths: string[],
): string[] {
  if (diskTags.length === 0) return [];
  let tags = [...diskTags];

  // 第一步：聚合视图 scope 前缀补齐（仅对 tags[0]）
  if (scopes && scopes.length > 0) {
    const firstTag = tags[0];
    if (!tagAlreadyPrefixed(firstTag, scopes)) {
      const scope = findScopeForFile(filePath, scopes);
      if (scope) {
        tags = tags.map((t, i) => (i === 0 ? `${scope.displayName}/${t}` : t));
      }
    }
  }

  // 第二步：用 taxonomy fullPath 做后缀归一化
  if (fullPaths.length > 0) {
    tags = tags.map(t => normalizeTagToFullPath(t, fullPaths));
  }

  return tags;
}

// ============================================================
// Tag 与 fullPath 的匹配（删除/重命名时用）
// ============================================================

/**
 * 判断一个磁盘 tag 是否匹配某个 fullPath：
 *  - tag 直接等于 fullPath
 *  - 或 tag 等于 fullPath 剥掉任一 scope 前缀后的值
 */
export function tagMatchesPath(
  tag: string,
  fullPath: string,
  scopes: AggregateScope[] | null,
): boolean {
  if (tag === fullPath) return true;
  if (!scopes) return false;
  for (const s of scopes) {
    const prefix = s.displayName + '/';
    if (fullPath.startsWith(prefix) && tag === fullPath.slice(prefix.length)) return true;
  }
  return false;
}

/**
 * 判断一个 tag 是否是 fullPath 的后代（位于 fullPath 子树下）：
 *  - tag 以 "fullPath/" 开头
 *  - 或 tag 以 "fullPath 剥离 scope 前缀/" 开头
 */
export function tagIsUnderPath(
  tag: string,
  fullPath: string,
  scopes: AggregateScope[] | null,
): boolean {
  if (tag.startsWith(fullPath + '/')) return true;
  if (!scopes) return false;
  for (const s of scopes) {
    const prefix = s.displayName + '/';
    if (fullPath.startsWith(prefix)) {
      const stripped = fullPath.slice(prefix.length);
      if (tag.startsWith(stripped + '/')) return true;
    }
  }
  return false;
}

// ============================================================
// TaxonomyNode 树操作（纯函数）
// ============================================================

/** 重新计算整棵树的 fullPath。用于 name 变化或结构变化后保持一致。 */
export function updatePaths(nodes: TaxonomyNode[], parentPath = ''): TaxonomyNode[] {
  return nodes.map(n => {
    const next = parentPath ? `${parentPath}/${n.name}` : n.name;
    return {
      ...n,
      fullPath: next,
      children: updatePaths(n.children || [], next),
    };
  });
}

/** 深度查找某个 id 对应的节点。找不到返回 null。 */
export function findNodeById(nodes: TaxonomyNode[], id: string): TaxonomyNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const got = findNodeById(n.children, id);
      if (got) return got;
    }
  }
  return null;
}

/** 收集节点及其所有后代的 fullPath（先序） */
export function collectFullPaths(node: TaxonomyNode): string[] {
  const out: string[] = [node.fullPath];
  if (node.children) {
    for (const c of node.children) out.push(...collectFullPaths(c));
  }
  return out;
}

/** 收集整棵树里所有节点的 fullPath（先序） */
export function collectAllFullPaths(nodes: TaxonomyNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    out.push(n.fullPath);
    if (n.children) out.push(...collectAllFullPaths(n.children));
  }
  return out;
}

/** 收集树中所有节点的 id（含深层） */
export function collectAllIds(nodes: TaxonomyNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    out.push(n.id);
    if (n.children) out.push(...collectAllIds(n.children));
  }
  return out;
}

/** 对某个 id 的节点应用 modifier，返回新树。 */
export function findAndModify(
  nodes: TaxonomyNode[],
  id: string,
  modifier: (n: TaxonomyNode) => TaxonomyNode,
): TaxonomyNode[] {
  return nodes.map(n => {
    if (n.id === id) return modifier(n);
    return { ...n, children: findAndModify(n.children || [], id, modifier) };
  });
}

/** 移除指定 id 的节点（及其子树），返回新树。 */
export function findAndRemove(nodes: TaxonomyNode[], id: string): TaxonomyNode[] {
  return nodes.filter(n => n.id !== id).map(n => ({
    ...n, children: findAndRemove(n.children || [], id),
  }));
}

/** 在指定 parent 下追加一个 child。 */
export function insertChild(
  nodes: TaxonomyNode[],
  parentId: string,
  child: TaxonomyNode,
): TaxonomyNode[] {
  return nodes.map(n => {
    if (n.id === parentId) {
      return { ...n, children: [...(n.children || []), child] };
    }
    return { ...n, children: insertChild(n.children || [], parentId, child) };
  });
}

// ============================================================
// 批量改写笔记 tag（准备写入磁盘时使用）
// ============================================================

/**
 * 对一个笔记的磁盘 tags 做一次"重命名/删除"变换。
 *
 * @param diskTags      笔记当前磁盘 tags
 * @param oldPaths      要匹配的 fullPath 列表（自己或后代都算命中）
 * @param newPath       替换为新 path；null 表示删除命中 tag
 * @param scopes        聚合视图 scope 列表（允许 tag 以剥离 scope 前缀的形态存在）
 * @returns { changed, nextTags } — changed 表示和原 tags 不同
 */
export function rewriteDiskTags(
  diskTags: string[],
  oldPaths: string[],
  newPath: string | null,
  scopes: AggregateScope[] | null,
): { changed: boolean; nextTags: string[] } {
  const stripScope = (tag: string): string => {
    if (!scopes) return tag;
    for (const s of scopes) {
      const prefix = s.displayName + '/';
      if (tag.startsWith(prefix)) return tag.slice(prefix.length);
    }
    return tag;
  };

  let changed = false;
  const nextTags: string[] = [];

  for (const tag of diskTags) {
    const stripped = stripScope(tag);
    const matchOld = findMatchingOld(tag, stripped, oldPaths, scopes);

    if (!matchOld) {
      nextTags.push(tag);
      continue;
    }

    if (newPath === null) {
      // 删除
      changed = true;
      continue;
    }

    // 重命名：替换 tag 里对应 matchOld 的那段为 newPath
    const replaced = replaceTagPrefix(tag, matchOld, newPath, scopes);
    if (replaced !== tag) {
      changed = true;
      nextTags.push(replaced);
    } else {
      nextTags.push(tag);
    }
  }

  return { changed, nextTags };
}

/** 内部：找出磁盘 tag 匹配到 oldPaths 中的哪一条（考虑 scope 前缀两种形态）。 */
function findMatchingOld(
  tag: string,
  stripped: string,
  oldPaths: string[],
  scopes: AggregateScope[] | null,
): string | null {
  for (const oldPath of oldPaths) {
    // 完全匹配
    if (tag === oldPath || stripped === oldPath) return oldPath;
    // oldPath 剥 scope 后再比较
    if (scopes) {
      for (const s of scopes) {
        const pfx = s.displayName + '/';
        if (oldPath.startsWith(pfx)) {
          const oldStripped = oldPath.slice(pfx.length);
          if (tag === oldStripped || stripped === oldStripped) return oldPath;
        }
      }
    }
    // 后代匹配
    if (tag.startsWith(oldPath + '/') || stripped.startsWith(oldPath + '/')) return oldPath;
    if (scopes) {
      for (const s of scopes) {
        const pfx = s.displayName + '/';
        if (oldPath.startsWith(pfx)) {
          const oldStripped = oldPath.slice(pfx.length);
          if (tag.startsWith(oldStripped + '/') || stripped.startsWith(oldStripped + '/')) {
            return oldPath;
          }
        }
      }
    }
  }
  return null;
}

/** 内部：把 tag 中 oldPath 部分替换成 newPath，保持磁盘 tag 原本的 scope 前缀形态。 */
function replaceTagPrefix(
  tag: string,
  oldPath: string,
  newPath: string,
  scopes: AggregateScope[] | null,
): string {
  // 形态 1：tag 直接带 oldPath
  if (tag === oldPath) return newPath;
  if (tag.startsWith(oldPath + '/')) return newPath + tag.slice(oldPath.length);

  // 形态 2：tag 是 scope 剥离形态
  if (scopes) {
    for (const s of scopes) {
      const pfx = s.displayName + '/';
      if (oldPath.startsWith(pfx)) {
        const oldStripped = oldPath.slice(pfx.length);
        const newStripped = newPath.startsWith(pfx) ? newPath.slice(pfx.length) : newPath;
        if (tag === oldStripped) return newStripped;
        if (tag.startsWith(oldStripped + '/')) return newStripped + tag.slice(oldStripped.length);
      }
    }
  }
  return tag;
}
