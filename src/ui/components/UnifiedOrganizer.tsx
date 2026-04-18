import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { setIcon } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type { TaxonomyNode, TaxonomySchema } from '../../types';

// ============================================================
// UnifiedOrganizer — 常驻笔记整理器
//
// - 主区：分类树 + 每个分类下的笔记 chips
// - 拖拽笔记 → 立即改 frontmatter tag（实时生效）
// - 整合了 Schema 编辑（重命名/增删分类）
// - 不再有"确认"按钮，所有操作立即生效
// ============================================================

interface UnifiedOrganizerProps {
  app: App;
  taxonomy: TaxonomySchema;
  folderFilter?: string;
  /** 只读模式：禁用分类编辑（聚合视图用） */
  readOnly?: boolean;
  /**
   * 聚合视图专用：把笔记按所在子目录前缀分组
   * 每项 { folderPath: '前端笔记', displayName: '前端笔记' }
   * 笔记 tags[0] 会被透明地加上 displayName 前缀，以匹配聚合后的 fullPath
   */
  aggregateScopes?: Array<{ folderPath: string; displayName: string }>;
  /** Schema 变更回调（重命名/增删分类时调用） */
  onSchemaChange: (newNodes: TaxonomyNode[]) => void;
  /** 重命名 root */
  onRootRename: (newName: string) => void;
  /** 触发 AI 重新分类（给所有笔记重新打标签） */
  onAIReorganize?: () => void;
  /** 打开笔记 */
  onFileOpen: (filePath: string) => void;
}

interface NoteRef {
  file: TFile;
  filePath: string;
  fileName: string;
  tags: string[];
}

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

// ---- 从 metadataCache 读取笔记 ----

function loadNotes(
  app: App,
  folderFilter?: string,
  aggregateScopes?: Array<{ folderPath: string; displayName: string }>,
): NoteRef[] {
  const files = app.vault.getMarkdownFiles().filter(f => {
    if (!folderFilter) return true;
    const prefix = folderFilter.endsWith('/') ? folderFilter : folderFilter + '/';
    return f.path.startsWith(prefix);
  });

  // 预构建 scope 前缀匹配表：按 folderPath 降序（最长优先），避免嵌套 scope 误匹配
  const scopes = aggregateScopes
    ? [...aggregateScopes].sort((a, b) => b.folderPath.length - a.folderPath.length)
    : null;

  const notes: NoteRef[] = [];
  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    const fmTags = cache?.frontmatter?.tags;
    let tags: string[] = [];
    if (Array.isArray(fmTags)) {
      tags = fmTags.filter((t): t is string => typeof t === 'string' && !!t.trim()).map(t => t.trim());
    } else if (typeof fmTags === 'string' && fmTags.trim()) {
      tags = [fmTags.trim()];
    }

    // 聚合视图：给 tags[0] 加上所在 scope 的 displayName 前缀
    if (scopes && tags.length > 0) {
      const scope = scopes.find(s => {
        const p = s.folderPath.endsWith('/') ? s.folderPath : s.folderPath + '/';
        return file.path.startsWith(p);
      });
      if (scope) {
        tags = tags.map((t, i) => (i === 0 ? `${scope.displayName}/${t}` : t));
      }
    }

    notes.push({
      file,
      filePath: file.path,
      fileName: file.basename,
      tags,
    });
  }
  return notes;
}

// ---- 主组件 ----

export function UnifiedOrganizer({ app, taxonomy, folderFilter, readOnly = false, aggregateScopes, onSchemaChange, onRootRename, onAIReorganize, onFileOpen }: UnifiedOrganizerProps) {
  const [notes, setNotes] = useState<NoteRef[]>(() => loadNotes(app, folderFilter, aggregateScopes));
  const [draggingFile, setDraggingFile] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const n of taxonomy.nodes) s.add(n.id);
    return s;
  });
  const [query, setQuery] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef<number | null>(null);
  const autoExpandTimerRef = useRef<{ id: string; timer: number } | null>(null);

  // 监听 metadataCache 变化，同步更新
  useEffect(() => {
    const onChanged = () => setNotes(loadNotes(app, folderFilter, aggregateScopes));
    app.metadataCache.on('changed', onChanged);
    app.metadataCache.on('resolved', onChanged);
    return () => {
      app.metadataCache.off('changed', onChanged);
      app.metadataCache.off('resolved', onChanged);
    };
  }, [app, folderFilter, aggregateScopes]);

  // aggregateScopes 变化时主动刷一次笔记（避免首次渲染后新传入才生效）
  useEffect(() => {
    setNotes(loadNotes(app, folderFilter, aggregateScopes));
  }, [app, folderFilter, aggregateScopes]);

  // 自动滚动：拖拽时鼠标靠近容器顶/底边缘时滚动
  const handleBodyDragOver = useCallback((e: React.DragEvent) => {
    if (!draggingFile || !bodyRef.current) return;
    const body = bodyRef.current;
    const rect = body.getBoundingClientRect();
    const y = e.clientY;
    const threshold = 60;
    const maxSpeed = 12;

    let speed = 0;
    if (y < rect.top + threshold) {
      const intensity = 1 - (y - rect.top) / threshold;
      speed = -Math.max(2, maxSpeed * intensity);
    } else if (y > rect.bottom - threshold) {
      const intensity = 1 - (rect.bottom - y) / threshold;
      speed = Math.max(2, maxSpeed * intensity);
    }

    if (autoScrollRef.current !== null) {
      cancelAnimationFrame(autoScrollRef.current);
      autoScrollRef.current = null;
    }

    if (speed !== 0) {
      const scroll = () => {
        body.scrollTop += speed;
        autoScrollRef.current = requestAnimationFrame(scroll);
      };
      autoScrollRef.current = requestAnimationFrame(scroll);
    }

    // ---- 自动展开：用 elementFromPoint 找悬停的节点 ----
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const categoryEl = el?.closest('[data-mece-node-id]') as HTMLElement | null;
    if (categoryEl) {
      const nodeId = categoryEl.dataset.meceNodeId!;
      const isCollapsed = categoryEl.dataset.meceCollapsed === '1';
      if (isCollapsed) {
        scheduleAutoExpand(nodeId);
      } else {
        cancelAutoExpand();
      }
    } else {
      cancelAutoExpand();
    }
  }, [draggingFile]);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRef.current !== null) {
      cancelAnimationFrame(autoScrollRef.current);
      autoScrollRef.current = null;
    }
  }, []);

  // 拖拽悬停在折叠的分类上时，延时自动展开
  const scheduleAutoExpand = useCallback((nodeId: string) => {
    if (autoExpandTimerRef.current?.id === nodeId) return;
    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current.timer);
    }
    const timer = window.setTimeout(() => {
      setExpanded(prev => new Set([...prev, nodeId]));
      autoExpandTimerRef.current = null;
    }, 500);
    autoExpandTimerRef.current = { id: nodeId, timer };
  }, []);

  const cancelAutoExpand = useCallback(() => {
    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current.timer);
      autoExpandTimerRef.current = null;
    }
  }, []);

  const nodes = taxonomy.nodes;
  const maxDepth = taxonomy.maxDepth || 3;

  // 搜索过滤
  const filteredNotes = useMemo(() => {
    if (!query.trim()) return notes;
    const q = query.toLowerCase();
    return notes.filter(n => n.fileName.toLowerCase().includes(q));
  }, [notes, query]);

  // 按分类路径分组笔记（取第一个 tag 作为主分类）
  const { byPath, unassigned } = useMemo(() => {
    const map = new Map<string, NoteRef[]>();
    const noCat: NoteRef[] = [];
    for (const n of filteredNotes) {
      if (n.tags.length === 0) {
        noCat.push(n);
        continue;
      }
      const path = n.tags[0];
      if (!map.has(path)) map.set(path, []);
      map.get(path)!.push(n);
    }

    // 调试：聚合模式下打印笔记分组
    if (aggregateScopes) {
      // eslint-disable-next-line no-console
      console.log('[MECE] aggregateScopes:', aggregateScopes);
      // eslint-disable-next-line no-console
      console.log('[MECE] byPath keys:', [...map.keys()]);
      // eslint-disable-next-line no-console
      console.log('[MECE] taxonomy nodes:', JSON.parse(JSON.stringify(taxonomy.nodes)));
    }

    return { byPath: map, unassigned: noCat };
  }, [filteredNotes, aggregateScopes, taxonomy]);

  // 统计（当前分类及子孙）总笔记数
  const totalCountMap = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [path, list] of byPath) {
      counts.set(path, (counts.get(path) || 0) + list.length);
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join('/');
        counts.set(ancestor, (counts.get(ancestor) || 0) + list.length);
      }
    }
    return counts;
  }, [byPath]);

  const totalClassified = notes.length - notes.filter(n => n.tags.length === 0).length;

  // ---- 分类编辑（通过 onSchemaChange 向外传递） ----
  const emitNodes = useCallback((newNodes: TaxonomyNode[]) => {
    onSchemaChange(updatePaths(newNodes));
  }, [onSchemaChange]);

  const handleRename = (id: string, newName: string) => emitNodes(findAndModify(nodes, id, n => ({ ...n, name: newName })));
  const handleDelete = (id: string) => emitNodes(findAndRemove(nodes, id));
  const handleAddChild = (parentId: string) => {
    const child: TaxonomyNode = { id: genId(), name: '新分类', fullPath: '', children: [] };
    emitNodes(insertChild(nodes, parentId, child));
    setExpanded(prev => new Set([...prev, parentId]));
  };
  const handleAddRoot = () => {
    const child: TaxonomyNode = { id: genId(), name: '新分类', fullPath: '', children: [] };
    emitNodes([...nodes, child]);
  };
  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  };

  // ---- 拖拽：立即写 frontmatter ----
  const assignNoteToPath = async (filePath: string, targetPath: string | null) => {
    stopAutoScroll();
    cancelAutoExpand();
    const note = notes.find(n => n.filePath === filePath);
    if (!note) return;

    // 聚合视图：写入磁盘前剥掉 scope 前缀（笔记 tag 本身不带 scope）
    let writeTag = targetPath;
    if (writeTag && aggregateScopes) {
      for (const scope of aggregateScopes) {
        const prefix = scope.displayName + '/';
        if (writeTag === scope.displayName) {
          // 拖到聚合一级节点（scope 本身）没有实际 tag 对应，视为未分类
          writeTag = null;
          break;
        }
        if (writeTag.startsWith(prefix)) {
          writeTag = writeTag.slice(prefix.length);
          break;
        }
      }
    }

    const newTags = writeTag ? [writeTag] : [];

    try {
      await app.fileManager.processFrontMatter(note.file, (fm) => {
        fm.tags = newTags;
      });
      // 乐观更新本地 state
      setNotes(prev => prev.map(n => n.filePath === filePath ? { ...n, tags: newTags } : n));
    } catch (e) {
      console.error('MECE: 写入 frontmatter 失败', e);
    }
    setDraggingFile(null);
    setDragOverPath(null);
  };

  const handleDragEnd = useCallback(() => {
    stopAutoScroll();
    cancelAutoExpand();
    setDraggingFile(null);
    setDragOverPath(null);
  }, [stopAutoScroll, cancelAutoExpand]);

  return (
    <div className="mece-organizer-panel">
      {/* 工具栏 */}
      <div className="mece-organizer-toolbar">
        <input
          type="text"
          className="mece-organizer-search"
          placeholder="搜索笔记..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="mece-organizer-stats">
          {totalClassified} / {notes.length} 已分类
        </span>
        {onAIReorganize && (
          <button className="mece-toolbar-btn" onClick={onAIReorganize} title="AI 重新分析所有笔记并分类">
            重新分类
          </button>
        )}
      </div>

      {/* 主区 */}
      <div
        className="mece-organizer-body"
        ref={bodyRef}
        onDragOver={handleBodyDragOver}
        onDragLeave={stopAutoScroll}
      >
        {/* 分类树 */}
        <div className="mece-organizer-tree">
          <RootNode
            rootName={taxonomy.rootName || '全部'}
            totalNotes={notes.length}
            readOnly={readOnly}
            draggingFile={draggingFile}
            dragOverPath={dragOverPath}
            setDragOverPath={setDragOverPath}
            onRename={onRootRename}
            onAddChild={handleAddRoot}
          >
            {nodes.length === 0 ? (
              <div className="mece-organizer-empty">暂无分类，点击「+」添加</div>
            ) : (
              nodes.map(node => (
                <CategoryNode
                  key={node.id}
                  node={node}
                  depth={1}
                  maxDepth={maxDepth}
                  expanded={expanded}
                  readOnly={readOnly}
                  toggleExpand={toggleExpand}
                  byPath={byPath}
                  totalCountMap={totalCountMap}
                  draggingFile={draggingFile}
                  dragOverPath={dragOverPath}
                  setDragOverPath={setDragOverPath}
                  onRename={handleRename}
                  onDelete={handleDelete}
                  onAddChild={handleAddChild}
                  onDragStartFile={setDraggingFile}
                  onDropToCategory={(p) => assignNoteToPath(draggingFile!, p)}
                  onFileOpen={onFileOpen}
                  onDragEnd={handleDragEnd}
                />
              ))
            )}
          </RootNode>
        </div>

        {/* 未分类区 */}
        <div
          className={`mece-organizer-unassigned ${dragOverPath === '__unassigned__' ? 'mece-organizer-dropzone-active' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOverPath('__unassigned__'); }}
          onDragLeave={() => setDragOverPath(null)}
          onDrop={() => assignNoteToPath(draggingFile!, null)}
        >
          <div className="mece-organizer-unassigned-title">
            未分类 <span className="mece-organizer-count">{unassigned.length}</span>
          </div>
          {unassigned.length > 0 ? (
            <div className="mece-organizer-unassigned-list">
              {unassigned.map(n => (
                <FileChip
                  key={n.filePath}
                  note={n}
                  onDragStart={() => setDraggingFile(n.filePath)}
                  onDragEnd={handleDragEnd}
                  onClick={() => onFileOpen(n.filePath)}
                />
              ))}
            </div>
          ) : (
            <div className="mece-organizer-unassigned-empty">所有笔记已分类</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- 分类节点（递归） ----

interface CategoryNodeProps {
  node: TaxonomyNode;
  depth: number;
  maxDepth: number;
  expanded: Set<string>;
  readOnly?: boolean;
  toggleExpand: (id: string) => void;
  byPath: Map<string, NoteRef[]>;
  totalCountMap: Map<string, number>;
  draggingFile: string | null;
  dragOverPath: string | null;
  setDragOverPath: (p: string | null) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onDragStartFile: (filePath: string) => void;
  onDropToCategory: (targetPath: string) => void;
  onFileOpen: (filePath: string) => void;
  onDragEnd: () => void;
}

function CategoryNode(props: CategoryNodeProps) {
  const { node, depth, maxDepth, expanded, readOnly = false, toggleExpand, byPath, totalCountMap,
    dragOverPath, setDragOverPath, onRename, onDelete, onAddChild,
    onDragStartFile, onDropToCategory, onFileOpen, onDragEnd } = props;

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(node.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const isExpanded = expanded.has(node.id);
  const hasChildren = node.children && node.children.length > 0;
  const canAddChild = depth < maxDepth;
  const filesHere = byPath.get(node.fullPath) || [];
  const totalCount = totalCountMap.get(node.fullPath) || 0;
  const isDropTarget = dragOverPath === node.fullPath;

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== node.name) onRename(node.id, trimmed);
    setEditing(false);
  };

  const handleCategoryDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(node.fullPath);
  };

  return (
    <div className={`mece-organizer-node ${depth > 1 ? 'mece-organizer-node-nested' : ''}`}>
      <div
        className={`mece-organizer-category ${isDropTarget ? 'mece-organizer-dropzone-active' : ''}`}
        data-mece-node-id={node.id}
        data-mece-collapsed={hasChildren && !isExpanded ? '1' : '0'}
        onDragOver={handleCategoryDragOver}
        onDrop={(e) => { e.stopPropagation(); onDropToCategory(node.fullPath); }}
      >
        <span
          className="mece-organizer-arrow"
          onClick={() => (hasChildren || filesHere.length > 0) && toggleExpand(node.id)}
          style={{
            transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            visibility: hasChildren || filesHere.length > 0 ? 'visible' : 'hidden',
          }}
        >
          <Icon name="chevron-down" size={12} />
        </span>

        {editing ? (
          <input
            ref={inputRef}
            className="mece-organizer-rename-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setEditing(false); setEditValue(node.name); }
            }}
          />
        ) : (
          <span
            className="mece-organizer-category-name"
            style={{ fontWeight: depth === 1 ? 600 : 400 }}
            onDoubleClick={() => { if (!readOnly) { setEditing(true); setEditValue(node.name); } }}
          >
            {node.name}
          </span>
        )}

        {totalCount > 0 && (
          <span className="mece-organizer-count">{totalCount}</span>
        )}

        {!readOnly && (
          <div className="mece-organizer-ops">
            <button className="mece-organizer-op" onClick={() => { setEditing(true); setEditValue(node.name); }} title="重命名">
              <Icon name="pencil" size={12} />
            </button>
            {canAddChild && (
              <button
                className="mece-organizer-op mece-organizer-op-add"
                onClick={() => onAddChild(node.id)}
                title="添加子分类"
              >
                <Icon name="plus" size={12} />
              </button>
            )}
            <button
              className="mece-organizer-op mece-organizer-op-del"
              onClick={() => onDelete(node.id)}
              title="删除"
            >
              <Icon name="trash-2" size={12} />
            </button>
          </div>
        )}
      </div>

      {isExpanded && (
        <div className="mece-organizer-children">
          {filesHere.length > 0 && (
            <div className="mece-organizer-file-list">
              {filesHere.map(n => (
                <FileChip
                  key={n.filePath}
                  note={n}
                  onDragStart={() => onDragStartFile(n.filePath)}
                  onDragEnd={onDragEnd}
                  onClick={() => onFileOpen(n.filePath)}
                />
              ))}
            </div>
          )}
          {hasChildren && node.children.map(child => (
            <CategoryNode key={child.id} {...props} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Root 节点 ----

function RootNode({ rootName, totalNotes, readOnly = false, draggingFile, dragOverPath, setDragOverPath, onRename, onAddChild, children }: {
  rootName: string;
  totalNotes: number;
  readOnly?: boolean;
  draggingFile: string | null;
  dragOverPath: string | null;
  setDragOverPath: (p: string | null) => void;
  onRename: (newName: string) => void;
  onAddChild: () => void;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(rootName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== rootName) onRename(trimmed);
    setEditing(false);
  };

  return (
    <div className="mece-organizer-root">
      <div className="mece-organizer-root-header">
        <span className="mece-organizer-root-icon">
          <Icon name="home" size={14} />
        </span>
        {editing ? (
          <input
            ref={inputRef}
            className="mece-organizer-rename-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setEditing(false); setEditValue(rootName); }
            }}
          />
        ) : (
          <span
            className="mece-organizer-root-name"
            onDoubleClick={() => { if (!readOnly) { setEditing(true); setEditValue(rootName); } }}
            title={readOnly ? rootName : '双击重命名'}
          >
            {rootName}
          </span>
        )}
        <span className="mece-organizer-count">{totalNotes}</span>
        {!readOnly && (
          <div className="mece-organizer-ops mece-organizer-root-ops">
            <button className="mece-organizer-op" onClick={() => { setEditing(true); setEditValue(rootName); }} title="重命名">
              <Icon name="pencil" size={12} />
            </button>
            <button
              className="mece-organizer-op mece-organizer-op-add"
              onClick={onAddChild}
              title="添加一级分类"
            >
              <Icon name="plus" size={12} />
            </button>
          </div>
        )}
      </div>
      <div className="mece-organizer-root-children">
        {children}
      </div>
    </div>
  );
}

// ---- 文件 Chip ----

function Icon({ name, size = 14 }: { name: string; size?: number }) {
  // 用两层结构：外层是 React 管理的空 span（永远无子节点），
  // 通过 ref callback 在其中挂载一个脱管 DOM（by appendChild），
  // setIcon 操作的是这个脱管 DOM。React 卸载时只会删外层 span，
  // 脱管 DOM 随之被浏览器 GC，不会触发 removeChild 对账。
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const innerRef = useRef<HTMLSpanElement | null>(null);

  const setHost = (el: HTMLSpanElement | null) => {
    if (el === hostRef.current) return;
    hostRef.current = el;
    if (el) {
      // 首次挂载：创建脱管子元素
      if (!innerRef.current) {
        const inner = document.createElement('span');
        inner.style.display = 'inline-flex';
        inner.style.width = `${size}px`;
        inner.style.height = `${size}px`;
        innerRef.current = inner;
      }
      if (innerRef.current.parentNode !== el) {
        el.appendChild(innerRef.current);
      }
      innerRef.current.innerHTML = '';
      setIcon(innerRef.current, name);
    }
  };

  useEffect(() => {
    if (innerRef.current) {
      innerRef.current.innerHTML = '';
      setIcon(innerRef.current, name);
    }
  }, [name]);

  return <span ref={setHost} style={{ display: 'inline-flex' }} />;
}

function FileChip({ note, onDragStart, onDragEnd, onClick }: {
  note: NoteRef;
  onDragStart: () => void;
  onDragEnd: () => void;
  onClick: () => void;
}) {
  return (
    <div
      className="mece-organizer-file"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onClick}
      title={`${note.filePath}${note.tags.length > 0 ? '\n标签：' + note.tags.join(', ') : ''}`}
    >
      <span className="mece-organizer-file-name">{note.fileName}</span>
    </div>
  );
}
