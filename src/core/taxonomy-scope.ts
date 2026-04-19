/**
 * 纯函数：对全局 taxonomy 做"文件夹切片"视图。
 *
 * 场景：UI 层把文件夹过滤切到某个目录（如 "哲学/存在主义"）时，
 * 从全局 taxonomy 里找 fullPath 严格等于该路径的节点（任意层级），
 * 以它为视图根展示它的子树。编辑产生的改动透明写回全局 taxonomy。
 *
 * 不依赖 Obsidian API，纯数据变换。
 */

import type { TaxonomyNode, TaxonomySchema } from '../types';

/** 重写节点及子孙的 fullPath：以 parentPath/name 为新 path。 */
export function rewritePaths(node: TaxonomyNode, parentPath: string): TaxonomyNode {
  const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name;
  return {
    ...node,
    fullPath,
    children: (node.children || []).map(c => rewritePaths(c, fullPath)),
  };
}

/**
 * 递归在 taxonomy 里按 fullPath 严格匹配任意层级的节点。
 * 命中即返回，不继续深入。
 */
export function findScopeNode(
  taxonomy: TaxonomySchema | null,
  folderPath: string,
): TaxonomyNode | null {
  if (!taxonomy || !folderPath) return null;
  return findNodeByFullPath(taxonomy.nodes, folderPath);
}

function findNodeByFullPath(nodes: TaxonomyNode[], fullPath: string): TaxonomyNode | null {
  for (const n of nodes) {
    if (n.fullPath === fullPath) return n;
    const hit = findNodeByFullPath(n.children || [], fullPath);
    if (hit) return hit;
  }
  return null;
}

/**
 * 递归映射节点树：遇到 predicate 命中的节点就用 transform 替换它，
 * 否则 children 继续递归映射。未触及任何节点的子树原样复用（保留引用）。
 */
function mapTree(
  nodes: TaxonomyNode[],
  predicate: (n: TaxonomyNode) => boolean,
  transform: (n: TaxonomyNode) => TaxonomyNode,
): TaxonomyNode[] {
  let touched = false;
  const next = nodes.map(n => {
    if (predicate(n)) {
      touched = true;
      return transform(n);
    }
    const newChildren = mapTree(n.children || [], predicate, transform);
    if (newChildren === n.children) return n;  // 子树未触及 → 原节点复用
    touched = true;
    return { ...n, children: newChildren };
  });
  return touched ? next : nodes;  // 整棵未触及 → 返回原数组（引用不变）
}

/**
 * 把目标节点（任意层级，按 id 定位）的 name / children 替换掉。
 * - 改名会级联重写整棵子树的 fullPath（从目标节点自身的 parent 路径起算）
 * - 其它未触及节点保持引用不变
 *
 * @returns 新的 taxonomy；找不到 nodeId 返回 null
 */
export function replaceScopeNode(
  taxonomy: TaxonomySchema,
  nodeId: string,
  newName: string,
  newChildren: TaxonomyNode[],
): TaxonomySchema | null {
  // 先找到目标节点及其 parent 路径
  const path = locateNodePath(taxonomy.nodes, nodeId, '');
  if (!path) return null;

  const { parentPath, oldNode } = path;
  const finalName = newName || oldNode.name;
  const newFullPath = parentPath ? `${parentPath}/${finalName}` : finalName;

  const rewritten: TaxonomyNode = {
    ...oldNode,
    name: finalName,
    fullPath: newFullPath,
    children: newChildren.map(c => rewritePaths(c, newFullPath)),
  };

  const nodes = mapTree(
    taxonomy.nodes,
    n => n.id === nodeId,
    () => rewritten,
  );

  return {
    ...taxonomy,
    nodes,
    updatedAt: new Date().toISOString(),
  };
}

function locateNodePath(
  nodes: TaxonomyNode[],
  nodeId: string,
  parentPath: string,
): { parentPath: string; oldNode: TaxonomyNode } | null {
  for (const n of nodes) {
    if (n.id === nodeId) return { parentPath, oldNode: n };
    const childPath = parentPath ? `${parentPath}/${n.name}` : n.name;
    const hit = locateNodePath(n.children || [], nodeId, childPath);
    if (hit) return hit;
  }
  return null;
}

/**
 * 构建"视图 schema"：把命中的节点当作视图根，它的 children 作为视图一级节点。
 *
 * UI 层可以直接把视图 schema 交给现有的 UnifiedOrganizer 渲染，
 * UnifiedOrganizer 不需要感知"切片"这件事。
 */
export function buildScopeViewSchema(
  taxonomy: TaxonomySchema,
  scopeNode: TaxonomyNode,
): TaxonomySchema {
  return {
    version: taxonomy.version,
    createdAt: taxonomy.createdAt,
    updatedAt: taxonomy.updatedAt,
    maxDepth: taxonomy.maxDepth,
    rootName: scopeNode.name,
    // children 的 fullPath 已经是从 scopeNode 的完整路径起算的，直接用
    nodes: scopeNode.children || [],
  };
}

/**
 * 收集 taxonomy 里所有节点的 fullPath（含任意层级）。
 * 用于 UI 层判断哪些文件夹在 schema 里有对应分类。
 */
export function collectAllFullPaths(taxonomy: TaxonomySchema | null): Set<string> {
  const set = new Set<string>();
  if (!taxonomy) return set;
  const walk = (nodes: TaxonomyNode[]) => {
    for (const n of nodes) {
      set.add(n.fullPath);
      walk(n.children || []);
    }
  };
  walk(taxonomy.nodes);
  return set;
}
