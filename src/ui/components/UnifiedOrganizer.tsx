import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { setIcon, Notice } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type { TaxonomyNode, TaxonomySchema } from '../../types';
import {
  toViewTags,
  updatePaths,
  findNodeById,
  collectFullPaths,
  collectAllFullPaths,
  collectAllIds,
  findAndModify,
  findAndRemove,
  insertChild,
  rewriteDiskTags,
  tagMatchesPath,
  tagIsUnderPath,
} from '../../core/tag-ops';
import { t, useLocale } from '../../i18n';

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
  /** 只读模式：禁用分类编辑 */
  readOnly?: boolean;
  /** Schema 变更回调（重命名/增删分类时调用） */
  onSchemaChange: (newNodes: TaxonomyNode[]) => void;
  /** 重命名 root */
  onRootRename: (newName: string) => void;
  /** 触发 AI 重新分类（给所有笔记重新打标签） */
  onAIReorganize?: () => void;
  /** 触发 AI 给指定文件（通常是未分类的）做归类（走 PatchReviewModal 二次确认） */
  onTagUntagged?: (files: TFile[]) => void;
  /** 打开文件夹选择器 */
  onChooseFolder?: () => void;
  /** 打开笔记 */
  onFileOpen: (filePath: string) => void;
  /** 外部递增的 refresh 计数器，用于触发 notes 重新从磁盘读取 */
  refreshKey?: number;
  /**
   * 文件夹同步钩子：开启"分类树 = 目录树"时，schema 改动需要同步到文件系统。
   * 可选——不传时 UnifiedOrganizer 只改 schema 和 tag，不动文件位置。
   */
  fileSystemSync?: {
    /** 重命名分类时，把 oldFullPath 文件夹重命名为 newFullPath */
    renameFolder: (oldPath: string, newPath: string) => Promise<void>;
    /** 删除分类时，把文件夹里的笔记挪到根、然后删空文件夹 */
    deleteFolderMoveNotesToRoot: (folderPath: string) => Promise<number>;
    /** 新建分类时，建空文件夹 */
    ensureFolder: (folderPath: string) => Promise<void>;
    /** 拖笔记到新分类时，把笔记文件移到目标文件夹 */
    moveFileToFolder: (file: TFile, targetFolder: string) => Promise<string>;
  };
}

interface NoteRef {
  file: TFile;
  filePath: string;
  fileName: string;
  tags: string[];
}

/** 分类节点下的笔记条目：可能是主位（实 chip）或次位幽灵（引用） */
interface NoteEntry {
  note: NoteRef;
  /** true 表示这是次位幽灵：笔记主位在别处，只是因为也被打了这个 tag 而显示 */
  isGhost: boolean;
  /** 主位 tag 路径（就是 note.tags[0]），点击幽灵时跳过去 */
  primaryPath: string;
}

function genId(): string {
  return Math.random().toString(36).substring(2, 10);
}

// ---- 从 metadataCache 读取笔记 ----

function loadNotes(
  app: App,
  folderFilter?: string,
  taxonomyFullPaths?: string[],
): NoteRef[] {
  const files = app.vault.getMarkdownFiles().filter(f => {
    if (!folderFilter) return true;
    const prefix = folderFilter.endsWith('/') ? folderFilter : folderFilter + '/';
    return f.path.startsWith(prefix);
  });

  const fullPaths = taxonomyFullPaths || [];

  const notes: NoteRef[] = [];
  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    const fmTags = cache?.frontmatter?.tags;
    let diskTags: string[] = [];
    if (Array.isArray(fmTags)) {
      diskTags = fmTags.filter((t): t is string => typeof t === 'string' && !!t.trim()).map(t => t.trim());
    } else if (typeof fmTags === 'string' && fmTags.trim()) {
      diskTags = [fmTags.trim()];
    }

    const tags = toViewTags(diskTags, file.path, null, fullPaths);

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

export function UnifiedOrganizer({ app, taxonomy, folderFilter, readOnly = false, onSchemaChange, onRootRename, onAIReorganize, onTagUntagged, onChooseFolder, onFileOpen, refreshKey = 0, fileSystemSync }: UnifiedOrganizerProps) {
  useLocale();  // 订阅语言变化
  // 预先把 taxonomy 里所有节点的 fullPath 收集起来，供 loadNotes 做 tag 归一化
  const taxonomyFullPaths = useMemo(() => collectAllFullPaths(taxonomy.nodes), [taxonomy]);

  const [notes, setNotes] = useState<NoteRef[]>(() => loadNotes(app, folderFilter, taxonomyFullPaths));
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

  // 监听 metadataCache 变化，同步更新。
  // 注意：不要用 vault.on('modify')，它比 metadataCache 'changed' 触发更早，
  // 此时 metadataCache 还是旧的 frontmatter → loadNotes 读到旧 tag → 覆盖拖拽的乐观更新，
  // 让笔记视觉上"回到"原位置。只监听 metadataCache 事件（frontmatter 解析完成时才触发）。
  useEffect(() => {
    let rafId: number | null = null;
    const scheduleReload = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setNotes(loadNotes(app, folderFilter, taxonomyFullPaths));
      });
    };
    const onMetaChanged = () => scheduleReload();
    const onVaultRename = () => scheduleReload();
    const onVaultDelete = () => scheduleReload();

    app.metadataCache.on('changed', onMetaChanged);
    app.metadataCache.on('resolved', onMetaChanged);
    app.vault.on('rename', onVaultRename);
    app.vault.on('delete', onVaultDelete);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      app.metadataCache.off('changed', onMetaChanged);
      app.metadataCache.off('resolved', onMetaChanged);
      app.vault.off('rename', onVaultRename);
      app.vault.off('delete', onVaultDelete);
    };
  }, [app, folderFilter, taxonomyFullPaths]);

  // folderFilter 或 taxonomy 变化时主动刷一次笔记
  useEffect(() => {
    setNotes(loadNotes(app, folderFilter, taxonomyFullPaths));
  }, [app, folderFilter, taxonomyFullPaths]);

  // 外部 refreshKey 递增（AI 归类完成、schema 变更等）→ 延迟 reload，
  // 给 Obsidian metadataCache 足够时间解析完新的 frontmatter
  useEffect(() => {
    if (refreshKey === 0) return;
    const timers = [150, 400, 1000].map(delay =>
      window.setTimeout(() => {
        setNotes(loadNotes(app, folderFilter, taxonomyFullPaths));
      }, delay),
    );
    return () => timers.forEach(t => window.clearTimeout(t));
  }, [refreshKey, app, folderFilter, taxonomyFullPaths]);

  // 自动滚动：拖拽时鼠标靠近容器顶/底边缘时滚动
  const handleBodyDragOver = useCallback((e: React.DragEvent) => {
    if (!draggingFile || !bodyRef.current) return;
    e.preventDefault();  // 允许 drop
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

    // ---- 找鼠标下的节点：用 elementFromPoint 获取最精确的叶子节点 ----
    // 注意：拖拽时 .file 子元素（.mece-organizer-file）本身在 category 里，
    // 但 category 的 data-mece-node-id 标记会被 closest 找到，所以没问题
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const categoryEl = el?.closest('[data-mece-node-id]') as HTMLElement | null;

    if (categoryEl) {
      const nodeId = categoryEl.dataset.meceNodeId!;
      const fullPath = categoryEl.dataset.meceFullPath || '';
      const isCollapsed = categoryEl.dataset.meceCollapsed === '1';

      // 统一在这里设置 dragOverPath（category 自己不再 setDragOverPath）
      if (fullPath && dragOverPath !== fullPath) {
        setDragOverPath(fullPath);
      }

      // 折叠的分类 → 悬停 500ms 自动展开
      if (isCollapsed) {
        scheduleAutoExpand(nodeId);
      } else {
        cancelAutoExpand();
      }
    } else {
      cancelAutoExpand();
      // 不清空 dragOverPath，避免鼠标短暂移到空白处时高亮抖动
    }
  }, [draggingFile, dragOverPath]);

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
    return notes.filter(n => {
      // 笔记名命中
      if (n.fileName.toLowerCase().includes(q)) return true;
      // 任一祖先分类名命中
      if (n.tags.length > 0) {
        const parts = n.tags[0].split('/');
        if (parts.some(p => p.toLowerCase().includes(q))) return true;
      }
      return false;
    });
  }, [notes, query]);

  // 按分类路径分组笔记
  // - tags[0] → 主位条目（实 chip，可拖）
  // - tags[1..N] → 次位幽灵条目（半透明，不可拖，指向主位）
  const { byPath, unassigned } = useMemo(() => {
    const map = new Map<string, NoteEntry[]>();
    const noCat: NoteRef[] = [];
    for (const n of filteredNotes) {
      if (n.tags.length === 0) {
        noCat.push(n);
        continue;
      }
      const primaryPath = n.tags[0];
      // 主位
      if (!map.has(primaryPath)) map.set(primaryPath, []);
      map.get(primaryPath)!.push({ note: n, isGhost: false, primaryPath });
      // 次位：其他 tag 每个都放一个幽灵条目
      for (let i = 1; i < n.tags.length; i++) {
        const ghostPath = n.tags[i];
        if (ghostPath === primaryPath) continue;  // 防重复 tag
        if (!map.has(ghostPath)) map.set(ghostPath, []);
        map.get(ghostPath)!.push({ note: n, isGhost: true, primaryPath });
      }
    }
    return { byPath: map, unassigned: noCat };
  }, [filteredNotes]);

  // 搜索可见性：有搜索词时，只展示命中（笔记或分类名）分支
  // - 命中节点本身、其所有祖先、其所有后代 都可见
  const visiblePaths = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;  // null 表示"全部可见"

    const visible = new Set<string>();
    // 1. 有匹配笔记的分类路径 → 自己 + 祖先可见
    for (const path of byPath.keys()) {
      visible.add(path);
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        visible.add(parts.slice(0, i).join('/'));
      }
    }
    // 2. 分类名自身命中 → 自己 + 祖先 + 所有后代可见
    const walk = (nodes: TaxonomyNode[], nameHit: boolean) => {
      for (const n of nodes) {
        const selfHit = nameHit || n.name.toLowerCase().includes(q);
        if (selfHit) {
          visible.add(n.fullPath);
          // 祖先
          const parts = n.fullPath.split('/');
          for (let i = 1; i < parts.length; i++) {
            visible.add(parts.slice(0, i).join('/'));
          }
        }
        walk(n.children || [], selfHit);
      }
    };
    walk(taxonomy.nodes, false);
    return visible;
  }, [query, byPath, taxonomy]);

  // 搜索态自动展开：搜索时所有可见节点都展开
  const effectiveExpanded = useMemo(() => {
    if (!visiblePaths) return expanded;
    // 把所有可见 path 对应的节点 id 都加入展开集合
    const s = new Set(expanded);
    const addIds = (nodes: TaxonomyNode[]) => {
      for (const n of nodes) {
        if (visiblePaths.has(n.fullPath)) s.add(n.id);
        addIds(n.children || []);
      }
    };
    addIds(taxonomy.nodes);
    return s;
  }, [visiblePaths, expanded, taxonomy]);

  // 统计（当前分类及子孙）总笔记数
  const totalCountMap = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [path, list] of byPath) {
      // 只统计主位笔记（幽灵不计，避免一篇多 tag 的笔记被重复计数）
      const primaryCount = list.filter(e => !e.isGhost).length;
      if (primaryCount === 0) continue;
      counts.set(path, (counts.get(path) || 0) + primaryCount);
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join('/');
        counts.set(ancestor, (counts.get(ancestor) || 0) + primaryCount);
      }
    }
    return counts;
  }, [byPath]);


  // ---- 分类编辑（通过 onSchemaChange 向外传递） ----
  const emitNodes = useCallback((newNodes: TaxonomyNode[]) => {
    onSchemaChange(updatePaths(newNodes));
  }, [onSchemaChange]);

  // 统计会被影响的笔记数（含给定 fullPath 或其后代的 tag）
  const countAffectedNotes = useCallback((fullPaths: string[]): number => {
    let count = 0;
    for (const note of notes) {
      const hit = note.tags.some(t =>
        fullPaths.some(fp => tagMatchesPath(t, fp, null) || tagIsUnderPath(t, fp, null)),
      );
      if (hit) count++;
    }
    return count;
  }, [notes]);

  /**
   * 批量改写笔记磁盘 tag：
   * - oldPath 可以是单个 fullPath 或一组 fullPath（数组）
   * - newPath = null → 删除匹配的 tag
   * - newPath = string → 把以 oldPath 开头的 tag 前缀替换为 newPath（只接受单个 oldPath）
   *
   * 核心匹配/替换逻辑在 core/tag-ops.ts 里的纯函数 rewriteDiskTags，单独测试。
   */
  const rewriteNotesTags = useCallback(async (
    oldPathOrPaths: string | string[],
    newPath: string | null,
  ): Promise<void> => {
    const oldPaths = Array.isArray(oldPathOrPaths) ? oldPathOrPaths : [oldPathOrPaths];

    for (const note of notes) {
      const fm = app.metadataCache.getFileCache(note.file)?.frontmatter;
      const rawTags = fm?.tags;
      let diskTags: string[] = [];
      if (Array.isArray(rawTags)) {
        diskTags = rawTags.filter((t): t is string => typeof t === 'string' && !!t.trim()).map(t => t.trim());
      } else if (typeof rawTags === 'string' && rawTags.trim()) {
        diskTags = [rawTags.trim()];
      }
      if (diskTags.length === 0) continue;

      const { changed, nextTags } = rewriteDiskTags(diskTags, oldPaths, newPath, null);

      if (changed) {
        try {
          await app.fileManager.processFrontMatter(note.file, (fm: any) => {
            fm.tags = nextTags;
          });
        } catch (e) {
          console.error('Atlas: 批量改写 tag 失败', note.file.path, e);
        }
      }
    }
  }, [app, notes]);

  const handleRename = async (id: string, newName: string) => {
    const oldNode = findNodeById(nodes, id);
    if (!oldNode) return;
    const oldPath = oldNode.fullPath;
    // 先更新 schema
    emitNodes(findAndModify(nodes, id, n => ({ ...n, name: newName })));
    // 再同步笔记 tag：把以 oldPath 开头的 tag 替换前缀成 newPath
    // 新 path 是 oldPath 的兄弟替换（同一 parent），所以构造 newPath 很简单：
    // oldPath 的最后一段换成 newName
    const parts = oldPath.split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');
    if (oldPath !== newPath) {
      await rewriteNotesTags(oldPath, newPath);
      // 同步 rename 对应文件夹（如果存在）
      if (fileSystemSync) {
        try {
          await fileSystemSync.renameFolder(oldPath, newPath);
        } catch (e) {
          console.warn('Atlas: 重命名文件夹失败（分类已更新，但文件夹保持原名）', e);
        }
      }
    }
  };

  const handleDelete = async (id: string) => {
    const oldNode = findNodeById(nodes, id);
    if (!oldNode) return;
    // 收集该节点及子树所有 fullPath，用于匹配笔记 tag
    const pathsToRemove = collectFullPaths(oldNode);
    // 扫描磁盘上有多少笔记受影响
    const affected = countAffectedNotes(pathsToRemove);
    const hasChildren = (oldNode.children?.length || 0) > 0;

    // affected > 0：说明会改笔记 tag，必须让用户知情确认
    // affected = 0：仅删分类结构，用一句轻量确认避免误操作（这种场景很多：
    //   空分类、聚合视图里刚建的空壳、schema 和笔记不对齐的老数据）
    if (affected > 0) {
      const extra = fileSystemSync ? '\n\n笔记将被挪到 Vault 根目录，对应文件夹会被清空。' : '';
      const ok = window.confirm(
        `删除「${oldNode.name}」分类${hasChildren ? `（含 ${oldNode.children!.length} 个子分类）` : ''}？\n\n` +
        `这会同时移除 ${affected} 篇笔记的相关标签（笔记文件本身不会删除）。${extra}`,
      );
      if (!ok) return;
    } else {
      const ok = window.confirm(
        `删除「${oldNode.name}」${hasChildren ? `（含 ${oldNode.children!.length} 个子分类）` : ''}？`,
      );
      if (!ok) return;
    }

    // 先更新 schema
    emitNodes(findAndRemove(nodes, id));
    // 同步清理笔记 tag
    if (affected > 0) {
      await rewriteNotesTags(pathsToRemove, null);
      new Notice(`已清理 ${affected} 篇笔记的标签`);
    }
    // 同步清理文件夹：把该分类及子孙对应的文件夹里的文件挪到根、删空文件夹
    if (fileSystemSync) {
      for (const p of pathsToRemove) {
        try {
          await fileSystemSync.deleteFolderMoveNotesToRoot(p);
        } catch (e) {
          console.warn('Atlas: 清理文件夹失败', p, e);
        }
      }
    }
  };
  const handleAddChild = (parentId: string) => {
    const child: TaxonomyNode = { id: genId(), name: t('schema.newCategory'), fullPath: '', children: [] };
    emitNodes(insertChild(nodes, parentId, child));
    setExpanded(prev => new Set([...prev, parentId]));
  };
  const handleAddRoot = () => {
    const child: TaxonomyNode = { id: genId(), name: t('schema.newCategory'), fullPath: '', children: [] };
    emitNodes([...nodes, child]);
  };
  const handleExpandAll = () => {
    setExpanded(new Set(collectAllIds(nodes)));
  };
  const handleCollapseAll = () => {
    setExpanded(new Set());
  };
  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  };

  // 根据 fullPath 找到路径上所有节点 id（用于拖放后展开整条路径）
  const findIdsByPath = useCallback((fullPath: string): string[] => {
    const ids: string[] = [];
    const walk = (arr: TaxonomyNode[]): boolean => {
      for (const n of arr) {
        if (n.fullPath === fullPath) {
          ids.push(n.id);
          return true;
        }
        if (fullPath.startsWith(n.fullPath + '/')) {
          ids.push(n.id);
          if (n.children && walk(n.children)) return true;
          ids.pop();
        }
      }
      return false;
    };
    walk(taxonomy.nodes);
    return ids;
  }, [taxonomy]);

  const [flashFilePath, setFlashFilePath] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  // 跳转到主位：展开主位路径 + 滚到 chip + 闪烁高亮
  const handleJumpToPrimary = useCallback((primaryPath: string, filePath: string) => {
    const idsOnPath = findIdsByPath(primaryPath);
    if (idsOnPath.length > 0) {
      setExpanded(prev => {
        const s = new Set(prev);
        idsOnPath.forEach(id => s.add(id));
        return s;
      });
    }
    setFlashFilePath(filePath);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      setFlashFilePath(null);
      flashTimerRef.current = null;
    }, 1200);
    requestAnimationFrame(() => {
      // 只定位主位 chip（不是幽灵）
      const el = bodyRef.current?.querySelector(
        `[data-mece-file-path="${CSS.escape(filePath)}"][data-mece-primary="1"]`,
      );
      if (el) (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [findIdsByPath]);

  // ---- 拖拽：立即写 frontmatter ----
  const assignNoteToPath = async (filePath: string, targetPath: string | null) => {
    stopAutoScroll();
    cancelAutoExpand();
    const note = notes.find(n => n.filePath === filePath);
    if (!note) return;

    const writeTag = targetPath;
    const diskTags = writeTag ? [writeTag] : [];
    const localTags = diskTags;

    try {
      await app.fileManager.processFrontMatter(note.file, (fm) => {
        fm.tags = diskTags;
      });
      // 乐观更新本地 state（用带前缀版本，确保聚合视图分组正确）
      setNotes(prev => prev.map(n => n.filePath === filePath ? { ...n, tags: localTags } : n));

      // 同步移动文件到目标文件夹（分类 = 目录模式）
      // writeTag 是"应该写进 frontmatter 的 tag"，也是它期望的文件夹路径。
      // 拖到根（writeTag=null）时不移（文件留在原处，挪动无意义）。
      let newFilePath = filePath;
      if (fileSystemSync && writeTag) {
        try {
          newFilePath = await fileSystemSync.moveFileToFolder(note.file, writeTag);
          // 本地 state 同步更新 filePath（file 对象同一个，但 path 已变）
          if (newFilePath !== filePath) {
            setNotes(prev => prev.map(n =>
              n.filePath === filePath
                ? { ...n, filePath: newFilePath, fileName: note.file.name }
                : n,
            ));
          }
        } catch (e) {
          console.warn('Atlas: 移动文件失败（tag 已更新，但文件保持原位）', e);
        }
      }

      // 展开目标路径上所有祖先 + 目标本身，确保笔记立即可见
      if (targetPath) {
        const idsOnPath = findIdsByPath(targetPath);
        if (idsOnPath.length > 0) {
          setExpanded(prev => {
            const s = new Set(prev);
            idsOnPath.forEach(id => s.add(id));
            return s;
          });
        }
      }

      // 笔记闪烁高亮一下，告诉用户"落在这里"
      setFlashFilePath(newFilePath);
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => {
        setFlashFilePath(null);
        flashTimerRef.current = null;
      }, 1200);

      // 滚动到笔记可见位置（下一帧 DOM 更新后）——只定位主位 chip
      requestAnimationFrame(() => {
        const el = bodyRef.current?.querySelector(
          `[data-mece-file-path="${CSS.escape(newFilePath)}"][data-mece-primary="1"]`,
        );
        if (el && 'scrollIntoView' in el) {
          (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    } catch (e) {
      console.error('Atlas: 写入 frontmatter 失败', e);
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
          placeholder={t('organizer.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {onChooseFolder && (
          <button
            className="mece-organizer-folder-btn"
            onClick={onChooseFolder}
            aria-label={folderFilter ? folderFilter : t('organizer.chooseFolderScope')}
          >
            <Icon name="folder" size={13} />
            <span className="mece-organizer-folder-btn-label">
              {folderFilter ? (folderFilter.split('/').pop() || folderFilter) : t('organizer.folderRoot')}
            </span>
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
            rootName={taxonomy.rootName || t('organizer.folderRoot')}
            totalNotes={notes.length}
            readOnly={readOnly}
            draggingFile={draggingFile}
            dragOverPath={dragOverPath}
            setDragOverPath={setDragOverPath}
            onRename={onRootRename}
            onAddChild={handleAddRoot}
            onExpandAll={handleExpandAll}
            onCollapseAll={handleCollapseAll}
          >
            {nodes.length === 0 ? (
              <div className="mece-organizer-empty">{t('organizer.emptyTree')}</div>
            ) : (
              nodes.map(node => (
                <CategoryNode
                  key={node.id}
                  node={node}
                  depth={1}
                  maxDepth={maxDepth}
                  expanded={effectiveExpanded}
                  visiblePaths={visiblePaths}
                  readOnly={readOnly}
                  toggleExpand={toggleExpand}
                  byPath={byPath}
                  totalCountMap={totalCountMap}
                  draggingFile={draggingFile}
                  dragOverPath={dragOverPath}
                  flashFilePath={flashFilePath}
                  setDragOverPath={setDragOverPath}
                  onRename={handleRename}
                  onDelete={handleDelete}
                  onAddChild={handleAddChild}
                  onDragStartFile={setDraggingFile}
                  onDropToCategory={(p) => assignNoteToPath(draggingFile!, p)}
                  onFileOpen={onFileOpen}
                  onJumpToPrimary={handleJumpToPrimary}
                  onDragEnd={handleDragEnd}
                />
              ))
            )}
          </RootNode>
        </div>
      </div>

      {/* 未分类区（固定在底部） */}
      <div
        className={`mece-organizer-unassigned ${dragOverPath === '__unassigned__' ? 'mece-organizer-dropzone-active' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOverPath('__unassigned__'); }}
        onDragLeave={() => setDragOverPath(null)}
        onDrop={() => assignNoteToPath(draggingFile!, null)}
      >
        <div className="mece-organizer-unassigned-title">
          <span className="mece-organizer-unassigned-label">
            {t('organizer.unassigned')} <span className="mece-organizer-count">{unassigned.length}</span>
          </span>
          {onTagUntagged && unassigned.length > 0 && (
            <button
              className="mece-toolbar-btn mece-organizer-unassigned-tag-btn"
              onClick={() => onTagUntagged(unassigned.map(n => n.file))}
              title={t('organizer.aiTagUnassigned')}
            >
              <Icon name="wand-sparkles" size={12} />
              <span>{t('organizer.aiTag')}</span>
            </button>
          )}
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
          <div className="mece-organizer-unassigned-empty">{t('organizer.allCategorized')}</div>
        )}
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
  /** 搜索过滤：null 表示全部可见；Set 表示仅这些 fullPath 可见 */
  visiblePaths: Set<string> | null;
  readOnly?: boolean;
  toggleExpand: (id: string) => void;
  byPath: Map<string, NoteEntry[]>;
  totalCountMap: Map<string, number>;
  draggingFile: string | null;
  dragOverPath: string | null;
  /** 刚被拖放进来的笔记路径，用于闪烁高亮提示 */
  flashFilePath: string | null;
  setDragOverPath: (p: string | null) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onDragStartFile: (filePath: string) => void;
  onDropToCategory: (targetPath: string) => void;
  onFileOpen: (filePath: string) => void;
  /** 点击次位幽灵时跳转到主位分类（展开 + 滚动 + 闪烁） */
  onJumpToPrimary?: (primaryPath: string, filePath: string) => void;
  onDragEnd: () => void;
}

function CategoryNode(props: CategoryNodeProps) {
  const { node, depth, maxDepth, expanded, visiblePaths, readOnly = false, toggleExpand, byPath, totalCountMap,
    dragOverPath, flashFilePath, setDragOverPath, onRename, onDelete, onAddChild,
    onDragStartFile, onDropToCategory, onFileOpen, onJumpToPrimary, onDragEnd } = props;

  // 搜索过滤：不在可见集合则整个节点不渲染
  if (visiblePaths && !visiblePaths.has(node.fullPath)) return null;

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
    // 只 preventDefault 让 drop 事件能触发；dragOverPath 由 body 层统一处理
    e.preventDefault();
  };

  return (
    <div className={`mece-organizer-node ${depth > 1 ? 'mece-organizer-node-nested' : ''}`}>
      <div
        className={`mece-organizer-category ${isDropTarget ? 'mece-organizer-dropzone-active' : ''}`}
        data-mece-node-id={node.id}
        data-mece-full-path={node.fullPath}
        data-mece-collapsed={hasChildren && !isExpanded ? '1' : '0'}
        onDragOver={handleCategoryDragOver}
        onDrop={(e) => { e.stopPropagation(); onDropToCategory(node.fullPath); }}
      >
        <span
          className="mece-organizer-arrow"
          onClick={() => hasChildren && toggleExpand(node.id)}
          style={{
            transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            // 只有子分类节点显示箭头；叶子（无子分类）即使有笔记也不显示，
            // 因为笔记默认展开，箭头在叶子上无意义
            visibility: hasChildren ? 'visible' : 'hidden',
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

        {!readOnly && (
          <div className="mece-organizer-ops">
            <button className="mece-organizer-op" onClick={(e) => { e.stopPropagation(); setEditing(true); setEditValue(node.name); }} title={t('common.rename')}>
              <Icon name="pencil" size={12} />
            </button>
            {canAddChild && (
              <button
                className="mece-organizer-op mece-organizer-op-add"
                onClick={(e) => { e.stopPropagation(); onAddChild(node.id); }}
                title={t('organizer.addChild')}
              >
                <Icon name="plus" size={12} />
              </button>
            )}
            <button
              className="mece-organizer-op mece-organizer-op-del"
              onClick={(e) => { e.stopPropagation(); onDelete(node.id); }}
              title={t('common.delete')}
            >
              <Icon name="trash-2" size={12} />
            </button>
          </div>
        )}
      </div>

      {/*
        子内容显示逻辑：
        - 叶子节点（无子分类）：笔记 chips 始终显示，不依赖 expanded
        - 有子分类的节点：expanded 控制整个子内容的显示
      */}
      {!hasChildren && filesHere.length > 0 && (
        <div className="mece-organizer-children">
          <div className="mece-organizer-file-list">
            {filesHere.map(entry => (
              <FileChip
                key={entry.note.filePath + (entry.isGhost ? ':ghost' : '')}
                note={entry.note}
                isGhost={entry.isGhost}
                primaryPath={entry.primaryPath}
                flash={entry.note.filePath === flashFilePath && !entry.isGhost}
                onDragStart={() => onDragStartFile(entry.note.filePath)}
                onDragEnd={onDragEnd}
                onClick={() => {
                  if (entry.isGhost) onJumpToPrimary?.(entry.primaryPath, entry.note.filePath);
                  else onFileOpen(entry.note.filePath);
                }}
              />
            ))}
          </div>
        </div>
      )}
      {hasChildren && isExpanded && (
        <div className="mece-organizer-children">
          {filesHere.length > 0 && (
            <div className="mece-organizer-file-list">
              {filesHere.map(entry => (
                <FileChip
                  key={entry.note.filePath + (entry.isGhost ? ':ghost' : '')}
                  note={entry.note}
                  isGhost={entry.isGhost}
                  primaryPath={entry.primaryPath}
                  flash={entry.note.filePath === flashFilePath && !entry.isGhost}
                  onDragStart={() => onDragStartFile(entry.note.filePath)}
                  onDragEnd={onDragEnd}
                  onClick={() => {
                    if (entry.isGhost) onJumpToPrimary?.(entry.primaryPath, entry.note.filePath);
                    else onFileOpen(entry.note.filePath);
                  }}
                />
              ))}
            </div>
          )}
          {node.children.map(child => (
            <CategoryNode key={child.id} {...props} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Root 节点 ----

function RootNode({ rootName, totalNotes, readOnly = false, draggingFile, dragOverPath, setDragOverPath, onRename, onAddChild, onExpandAll, onCollapseAll, children }: {
  rootName: string;
  totalNotes: number;
  readOnly?: boolean;
  draggingFile: string | null;
  dragOverPath: string | null;
  setDragOverPath: (p: string | null) => void;
  onRename: (newName: string) => void;
  onAddChild: () => void;
  onExpandAll?: () => void;
  onCollapseAll?: () => void;
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
            title={readOnly ? rootName : t('organizer.renameDoubleClick')}
          >
            {rootName}
          </span>
        )}
        {!readOnly && (
          <div className="mece-organizer-ops mece-organizer-root-ops">
            {onExpandAll && (
              <button className="mece-organizer-op" onClick={(e) => { e.stopPropagation(); onExpandAll(); }} title={t('organizer.expandAll')}>
                <Icon name="chevrons-up-down" size={12} />
              </button>
            )}
            {onCollapseAll && (
              <button className="mece-organizer-op" onClick={(e) => { e.stopPropagation(); onCollapseAll(); }} title={t('organizer.collapseAll')}>
                <Icon name="chevrons-down-up" size={12} />
              </button>
            )}
            <button className="mece-organizer-op" onClick={(e) => { e.stopPropagation(); setEditing(true); setEditValue(rootName); }} title={t('common.rename')}>
              <Icon name="pencil" size={12} />
            </button>
            <button
              className="mece-organizer-op mece-organizer-op-add"
              onClick={(e) => { e.stopPropagation(); onAddChild(); }}
              title={t('organizer.addSubcategory')}
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
        inner.style.alignItems = 'center';
        inner.style.justifyContent = 'center';
        inner.style.width = `${size}px`;
        inner.style.height = `${size}px`;
        inner.style.flexShrink = '0';
        innerRef.current = inner;
      }
      if (innerRef.current.parentNode !== el) {
        el.appendChild(innerRef.current);
      }
      innerRef.current.replaceChildren();
      setIcon(innerRef.current, name);
      // 强制 Obsidian 注入的 SVG 尺寸与容器一致
      const svg = innerRef.current.querySelector('svg');
      if (svg) {
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
      }
    }
  };

  useEffect(() => {
    if (innerRef.current) {
      innerRef.current.replaceChildren();
      setIcon(innerRef.current, name);
      const svg = innerRef.current.querySelector('svg');
      if (svg) {
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
      }
    }
  }, [name, size]);

  return <span ref={setHost} style={{ display: 'inline-flex', alignItems: 'center' }} />;
}

function FileChip({ note, isGhost = false, primaryPath, flash, onDragStart, onDragEnd, onClick }: {
  note: NoteRef;
  isGhost?: boolean;
  primaryPath?: string;
  flash?: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onClick: () => void;
}) {
  const tooltip = isGhost
    ? `${note.filePath}\n\n（次位引用：主位在 ${primaryPath}）\n点击跳转到主位`
    : `${note.filePath}${note.tags.length > 0 ? '\n标签：' + note.tags.join(', ') : ''}`;

  return (
    <div
      className={`mece-organizer-file ${isGhost ? 'mece-organizer-file-ghost' : ''} ${flash ? 'mece-organizer-file-flash' : ''}`}
      data-mece-file-path={note.filePath}
      data-mece-primary={isGhost ? '0' : '1'}
      draggable={!isGhost}
      onDragStart={isGhost ? undefined : (e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={isGhost ? undefined : onDragEnd}
      onClick={onClick}
      title={tooltip}
    >
      <span className="mece-organizer-file-name">{note.fileName}</span>
      {isGhost && <span className="mece-organizer-file-ghost-mark">↗</span>}
    </div>
  );
}
