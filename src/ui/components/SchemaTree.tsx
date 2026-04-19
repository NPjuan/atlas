import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { TaxonomyNode, TaxonomySchema } from '../../types';
import { t, useLocale } from '../../i18n';

// ============================================================
// Schema 树形编辑器 — 核心 React 组件
// 功能：展开/折叠、内联重命名、增删节点、上下移动、深度限制
// ============================================================

interface SchemaTreeProps {
  nodes: TaxonomyNode[];
  maxDepth: number;
  /** tag → 笔记数映射（可选） */
  noteCountMap?: Record<string, number>;
  onChange: (nodes: TaxonomyNode[]) => void;
}

// ---- 工具函数 ----

function genId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function updatePaths(nodes: TaxonomyNode[], parentPath = ''): TaxonomyNode[] {
  return nodes.map(n => ({
    ...n,
    fullPath: parentPath ? `${parentPath}/${n.name}` : n.name,
    children: updatePaths(n.children || [], parentPath ? `${parentPath}/${n.name}` : n.name),
  }));
}

function findAndModify(nodes: TaxonomyNode[], id: string, modifier: (n: TaxonomyNode) => TaxonomyNode): TaxonomyNode[] {
  return nodes.map(n => {
    if (n.id === id) return modifier(n);
    return { ...n, children: findAndModify(n.children || [], id, modifier) };
  });
}

function findAndRemove(nodes: TaxonomyNode[], id: string): TaxonomyNode[] {
  return nodes.filter(n => n.id !== id).map(n => ({
    ...n, children: findAndRemove(n.children || [], id),
  }));
}

function insertChild(nodes: TaxonomyNode[], parentId: string, child: TaxonomyNode): TaxonomyNode[] {
  return nodes.map(n => {
    if (n.id === parentId) {
      return { ...n, children: [...(n.children || []), child] };
    }
    return { ...n, children: insertChild(n.children || [], parentId, child) };
  });
}

function moveInList(nodes: TaxonomyNode[], id: string, direction: number): TaxonomyNode[] {
  const idx = nodes.findIndex(n => n.id === id);
  if (idx >= 0) {
    const newIdx = idx + direction;
    if (newIdx >= 0 && newIdx < nodes.length) {
      const arr = [...nodes];
      [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
      return arr;
    }
    return nodes;
  }
  return nodes.map(n => ({
    ...n, children: moveInList(n.children || [], id, direction),
  }));
}

function countTotalNodes(nodes: TaxonomyNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countTotalNodes(n.children || []), 0);
}

// ---- 单个节点组件 ----

interface TreeNodeProps {
  node: TaxonomyNode;
  depth: number;
  maxDepth: number;
  noteCount: number;
  isFirst: boolean;
  isLast: boolean;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
}

function TreeNodeRow({
  node, depth, maxDepth, noteCount, isFirst, isLast,
  onRename, onDelete, onAddChild, onMoveUp, onMoveDown,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(node.name);
  const [hover, setHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const hasChildren = node.children && node.children.length > 0;
  const canAddChild = depth < maxDepth - 1;

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== node.name) {
      onRename(node.id, trimmed);
    }
    setEditing(false);
  };

  return (
    <div style={{ marginLeft: depth > 0 ? 20 : 0 }}>
      <div
        className="mece-schema-tree-row"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {/* 展开/折叠 */}
        <span
          className="mece-schema-tree-arrow"
          onClick={(e) => { e.stopPropagation(); if (hasChildren) setExpanded(!expanded); }}
          style={{
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            visibility: hasChildren ? 'visible' : 'hidden',
          }}
        >▼</span>

        {/* 名称 */}
        {editing ? (
          <input
            ref={inputRef}
            className="mece-schema-tree-rename-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setEditing(false); setEditValue(node.name); }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="mece-schema-tree-name"
            style={{ fontWeight: depth === 0 ? 600 : 400 }}
            onDoubleClick={() => { setEditing(true); setEditValue(node.name); }}
          >
            {node.name}
          </span>
        )}

        {/* 描述 */}
        {node.description && !editing && (
          <span className="mece-schema-tree-desc">{node.description}</span>
        )}

        {/* 笔记数 */}
        {noteCount > 0 && (
          <span className="mece-schema-tree-count">{noteCount}</span>
        )}

        {/* 操作按钮 */}
        {hover && (
          <div className="mece-schema-tree-ops" onClick={(e) => e.stopPropagation()}>
            {!isFirst && <button className="mece-schema-tree-op" onClick={() => onMoveUp(node.id)} title={t('schema.tipMoveUp')}>↑</button>}
            {!isLast && <button className="mece-schema-tree-op" onClick={() => onMoveDown(node.id)} title={t('schema.tipMoveDown')}>↓</button>}
            <button className="mece-schema-tree-op" onClick={() => { setEditing(true); setEditValue(node.name); }} title={t('schema.tipRename')}>✏</button>
            {canAddChild && (
              <button
                className="mece-schema-tree-op"
                style={{ color: 'var(--text-success, #4caf50)' }}
                onClick={() => { onAddChild(node.id); setExpanded(true); }}
                title={t('schema.tipAddChild', { depth: depth + 1, max: maxDepth })}
              >+</button>
            )}
            <button
              className="mece-schema-tree-op"
              style={{ color: 'var(--text-error, #e55)' }}
              onClick={() => onDelete(node.id)}
              title={t('schema.tipDelete')}
            >×</button>
          </div>
        )}
      </div>

      {/* 子节点 */}
      {expanded && hasChildren && (
        <div>
          {node.children.map((child, i) => (
            <TreeNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              maxDepth={maxDepth}
              noteCount={0}
              isFirst={i === 0}
              isLast={i === node.children.length - 1}
              onRename={onRename}
              onDelete={onDelete}
              onAddChild={onAddChild}
              onMoveUp={onMoveUp}
              onMoveDown={onMoveDown}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- 主组件 ----

export function SchemaTree({ nodes, maxDepth, noteCountMap, onChange }: SchemaTreeProps) {
  useLocale();
  const emit = useCallback((newNodes: TaxonomyNode[]) => {
    onChange(updatePaths(newNodes));
  }, [onChange]);

  const handleRename = useCallback((id: string, newName: string) => {
    emit(findAndModify(nodes, id, n => ({ ...n, name: newName })));
  }, [nodes, emit]);

  const handleDelete = useCallback((id: string) => {
    emit(findAndRemove(nodes, id));
  }, [nodes, emit]);

  const handleAddChild = useCallback((parentId: string) => {
    const child: TaxonomyNode = { id: genId(), name: t('schema.newCategory'), fullPath: '', children: [] };
    emit(insertChild(nodes, parentId, child));
  }, [nodes, emit]);

  const handleMoveUp = useCallback((id: string) => {
    emit(moveInList(nodes, id, -1));
  }, [nodes, emit]);

  const handleMoveDown = useCallback((id: string) => {
    emit(moveInList(nodes, id, 1));
  }, [nodes, emit]);

  const handleAddRoot = useCallback(() => {
    const child: TaxonomyNode = { id: genId(), name: t('schema.newCategory'), fullPath: '', children: [] };
    emit([...nodes, child]);
  }, [nodes, emit]);

  const totalNodes = countTotalNodes(nodes);

  return (
    <div className="mece-schema-tree">
      {/* 统计 */}
      <div className="mece-schema-tree-stats">
        {t('schema.treeStats', { top: nodes.length, total: totalNodes, max: maxDepth })}
      </div>

      {/* 树 */}
      <div className="mece-schema-tree-body">
        {nodes.length === 0 ? (
          <div className="mece-schema-tree-empty">
            {t('schema.emptyHint')}
          </div>
        ) : (
          nodes.map((node, i) => (
            <TreeNodeRow
              key={node.id}
              node={node}
              depth={0}
              maxDepth={maxDepth}
              noteCount={noteCountMap?.[node.fullPath] || 0}
              isFirst={i === 0}
              isLast={i === nodes.length - 1}
              onRename={handleRename}
              onDelete={handleDelete}
              onAddChild={handleAddChild}
              onMoveUp={handleMoveUp}
              onMoveDown={handleMoveDown}
            />
          ))
        )}
      </div>

      {/* 添加按钮 */}
      <div className="mece-schema-tree-add-root">
        <button onClick={handleAddRoot}>{t('schema.addRootBtn')}</button>
      </div>
    </div>
  );
}
