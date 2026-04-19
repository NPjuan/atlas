import { App, Modal, Notice, setIcon } from 'obsidian';
import React, { useState, useEffect, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import type { TagPatch, TagPatchList, SuggestedCategory } from '../../types';

// ============================================================
// Patch Review Modal — React 版 git-diff 风格审核
// ============================================================

/** 用 Obsidian setIcon 的脱管 DOM 小工具，避免 React 对账冲突 */
function Icon({ name, size = 14 }: { name: string; size?: number }) {
  const innerRef = useRef<HTMLSpanElement | null>(null);
  const applyIcon = () => {
    const inner = innerRef.current;
    if (!inner) return;
    inner.replaceChildren();
    setIcon(inner, name);
    // setIcon 注入的 SVG 默认 24x24，强制按 size 渲染
    const svg = inner.querySelector('svg');
    if (svg) {
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
      svg.style.width = `${size}px`;
      svg.style.height = `${size}px`;
    }
  };
  const setHost = (host: HTMLSpanElement | null) => {
    if (!host) return;
    if (!innerRef.current) {
      innerRef.current = document.createElement('span');
      innerRef.current.style.display = 'inline-flex';
      innerRef.current.style.alignItems = 'center';
      innerRef.current.style.justifyContent = 'center';
    }
    if (innerRef.current.parentNode !== host) {
      host.appendChild(innerRef.current);
    }
    applyIcon();
  };
  useEffect(() => {
    applyIcon();
  }, [name, size]);
  return (
    <span
      ref={setHost}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
      }}
    />
  );
}

interface PatchReviewAppProps {
  patchList: TagPatchList;
  onApply: (patches: TagPatch[], acceptedCategories: SuggestedCategory[]) => void;
  onCancel: () => void;
}

type ViewMode = 'by-category' | 'by-file';

/** 单行 patch 渲染（文件视图和分类视图共用） */
function PatchItem({
  patch, idx, newCategoryPaths, onToggle, showAddedTags = true,
}: {
  patch: TagPatch;
  idx: number;
  newCategoryPaths: Set<string>;
  onToggle: (idx: number) => void;
  /** 分类视图下分组 header 已经标了分类，行内不需要再重复 + 新分类 */
  showAddedTags?: boolean;
}) {
  const keptTags = patch.newTags.filter(t => patch.oldTags.includes(t));
  // 在分类视图里：如果没有 removed、也没有 kept（即纯粹被归入一个新分类），diff 区整块不显示，让行简洁
  const hasDiffContent =
    patch.removed.length > 0 ||
    keptTags.length > 0 ||
    (showAddedTags && patch.added.length > 0);

  return (
    <div
      className={`mece-pr-item ${patch.accepted ? 'mece-pr-item-accepted' : 'mece-pr-item-rejected'}`}
    >
      <input
        type="checkbox"
        className="mece-pr-checkbox"
        checked={patch.accepted}
        onChange={() => onToggle(idx)}
      />
      <div className="mece-pr-file-info">
        <span className="mece-pr-filename">{patch.fileName}</span>
        {hasDiffContent && (
          <div className="mece-pr-diff">
            {patch.removed.length > 0 && (
              <div className="mece-pr-diff-removed">
                <span className="mece-pr-diff-prefix mece-pr-diff-minus">− </span>
                {patch.removed.map(t => <span key={t} className="mece-pr-tag mece-pr-tag-removed">{t}</span>)}
              </div>
            )}
            {keptTags.length > 0 && (
              <div className="mece-pr-diff-existing">
                <span className="mece-pr-diff-prefix">  </span>
                {keptTags.map(t =>
                  <span key={t} className="mece-pr-tag mece-pr-tag-existing">{t}</span>
                )}
              </div>
            )}
            {showAddedTags && patch.added.length > 0 && (
              <div className="mece-pr-diff-added">
                <span className="mece-pr-diff-prefix mece-pr-diff-plus">+ </span>
                {patch.added.map(t => (
                  <span
                    key={t}
                    className={`mece-pr-tag mece-pr-tag-added ${newCategoryPaths.has(t) ? 'mece-pr-tag-new-category' : ''}`}
                  >
                    {t}
                    {newCategoryPaths.has(t) && <span className="mece-pr-tag-new-badge">新</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PatchReviewApp({ patchList, onApply, onCancel }: PatchReviewAppProps) {
  // 默认全部勾选（AI 的建议默认接受，用户只需反选不认可的）
  const changesOnly = patchList.patches
    .filter(p => p.hasChanges)
    .map(p => ({ ...p, accepted: true }));
  const [patches, setPatches] = useState(changesOnly);
  const [viewMode, setViewMode] = useState<ViewMode>('by-category');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // 把新分类路径收成 Set
  const newCategoryPaths = new Set(patchList.suggestedCategories.map(c => c.path));

  const togglePatch = (idx: number) => {
    setPatches(prev => prev.map((p, i) => i === idx ? { ...p, accepted: !p.accepted } : p));
  };

  const selectAll = () => setPatches(prev => prev.map(p => ({ ...p, accepted: true })));
  const selectNone = () => setPatches(prev => prev.map(p => ({ ...p, accepted: false })));

  /** 按"主 tag（newTags[0]）"对 patches 分组 */
  const groups = React.useMemo(() => {
    const map = new Map<string, number[]>();  // path → patch indices
    patches.forEach((p, i) => {
      const key = p.newTags[0] || '(无分类)';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(i);
    });
    // 按组内数量倒序 + 分类名字典序（稳定）
    return [...map.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [patches]);

  const toggleGroupCollapse = (path: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  const selectGroup = (indices: number[], accepted: boolean) => {
    setPatches(prev => prev.map((p, i) =>
      indices.includes(i) ? { ...p, accepted } : p
    ));
  };

  const acceptedPatches = patches.filter(p => p.accepted);

  // 根据被接受的 patches 里实际用到的 tag，自动计算应该接受的新分类
  const acceptedCategories = React.useMemo(() => {
    const usedPaths = new Set<string>();
    for (const p of acceptedPatches) {
      for (const t of p.newTags) {
        if (newCategoryPaths.has(t)) usedPaths.add(t);
      }
    }
    return patchList.suggestedCategories
      .filter(c => usedPaths.has(c.path))
      .map(c => ({ ...c, accepted: true }));
  }, [acceptedPatches, patchList.suggestedCategories]);

  const newCategoriesCount = acceptedCategories.length;

  return (
    <div className="mece-patch-review">
      {/* 头部 */}
      <div className="mece-pr-header">
        <h3>
          <Icon name="clipboard-list" size={16} />
          <span>归类预览</span>
        </h3>
        <p className="mece-pr-desc">
          勾选你认可的归类。<strong className="mece-pr-new-hint">带「新」徽章</strong>的分类在当前 Schema 中尚不存在，接受时会自动纳入 Schema。
        </p>
      </div>

      {/* 统计 */}
      <div className="mece-pr-stats-bar">
        <span className="mece-pr-stat">
          <Icon name="file-text" size={12} />
          <span>{patchList.stats.totalFiles} 文件扫描</span>
        </span>
        <span className="mece-pr-stat mece-pr-stat-highlight">
          <Icon name="sparkles" size={12} />
          <span>{patchList.stats.filesWithChanges} 文件有变更</span>
        </span>
        {patchList.suggestedCategories.length > 0 && (
          <span className="mece-pr-stat mece-pr-stat-new">
            <Icon name="plus-circle" size={12} />
            <span>{patchList.suggestedCategories.length} 个新分类待纳入</span>
          </span>
        )}
        {patchList.stats.skippedFiles > 0 && (
          <span className="mece-pr-stat mece-pr-stat-muted">
            <Icon name="skip-forward" size={12} />
            <span>{patchList.stats.skippedFiles} 跳过</span>
          </span>
        )}
      </div>

      {/* 视图切换 Tab */}
      <div className="mece-pr-tabs">
        <button
          className={`mece-pr-tab ${viewMode === 'by-category' ? 'mece-pr-tab-active' : ''}`}
          onClick={() => setViewMode('by-category')}
        >
          <Icon name="folder-tree" size={12} />
          <span>按分类</span>
        </button>
        <button
          className={`mece-pr-tab ${viewMode === 'by-file' ? 'mece-pr-tab-active' : ''}`}
          onClick={() => setViewMode('by-file')}
        >
          <Icon name="file-text" size={12} />
          <span>按文件</span>
        </button>
        <div className="mece-pr-tabs-right">
          <button className="mece-btn-sm" onClick={selectAll}>全选</button>
          <button className="mece-btn-sm" onClick={selectNone}>全不选</button>
          <span className="mece-pr-summary">
            {acceptedPatches.length}/{patches.length} 文件
          </span>
        </div>
      </div>

      {/* 列表 */}
      <div className="mece-pr-list">
        {patches.length === 0 ? (
          <p className="mece-pr-empty">所有文件的标签已是最新</p>
        ) : viewMode === 'by-file' ? (
          patches.map((patch, idx) => (
            <PatchItem
              key={patch.filePath}
              patch={patch}
              idx={idx}
              newCategoryPaths={newCategoryPaths}
              onToggle={togglePatch}
            />
          ))
        ) : (
          groups.map(([path, indices]) => {
            const groupPatches = indices.map(i => patches[i]);
            const acceptedInGroup = groupPatches.filter(p => p.accepted).length;
            const total = groupPatches.length;
            const isNewCategory = newCategoryPaths.has(path);
            const collapsed = collapsedGroups.has(path);
            // group-level checkbox 三态
            const groupAllChecked = acceptedInGroup === total;
            const groupNoneChecked = acceptedInGroup === 0;
            return (
              <div key={path} className={`mece-pr-group ${collapsed ? 'mece-pr-group-collapsed' : ''}`}>
                <div className="mece-pr-group-header">
                  <input
                    type="checkbox"
                    className="mece-pr-checkbox"
                    checked={groupAllChecked}
                    ref={el => { if (el) el.indeterminate = !groupAllChecked && !groupNoneChecked; }}
                    onChange={() => selectGroup(indices, !groupAllChecked)}
                  />
                  <button
                    className="mece-pr-group-toggle"
                    onClick={() => toggleGroupCollapse(path)}
                    aria-label={collapsed ? '展开' : '折叠'}
                  >
                    <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
                  </button>
                  <span className={`mece-pr-group-path ${isNewCategory ? 'mece-pr-group-path-new' : ''}`}>
                    {path}
                    {isNewCategory && <span className="mece-pr-tag-new-badge">新</span>}
                  </span>
                  <span className="mece-pr-group-count">{acceptedInGroup}/{total} 篇</span>
                </div>
                {!collapsed && (
                  <div className="mece-pr-group-body">
                    {indices.map(i => (
                      <PatchItem
                        key={patches[i].filePath}
                        patch={patches[i]}
                        idx={i}
                        newCategoryPaths={newCategoryPaths}
                        onToggle={togglePatch}
                        showAddedTags={false}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 底部 */}
      <div className="mece-pr-footer">
        <button className="mece-btn" onClick={onCancel}>取消</button>
        <button
          className="mece-btn mece-btn-primary"
          onClick={() => onApply(acceptedPatches, acceptedCategories)}
          disabled={acceptedPatches.length === 0}
        >
          应用 {acceptedPatches.length} 项变更
          {newCategoriesCount > 0 && <span className="mece-btn-sublabel">（含 {newCategoriesCount} 个新分类）</span>}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Obsidian Modal 包装
// ============================================================

export class PatchReviewModal extends Modal {
  private root: Root | null = null;
  private patchList: TagPatchList;
  private onApply: (patches: TagPatch[], acceptedCategories: SuggestedCategory[]) => Promise<void>;

  constructor(
    app: App,
    patchList: TagPatchList,
    onApply: (patches: TagPatch[], acceptedCategories: SuggestedCategory[]) => Promise<void>,
  ) {
    super(app);
    this.patchList = patchList;
    this.onApply = onApply;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mece-patch-review-modal');

    const container = contentEl.createDiv();
    this.root = createRoot(container);

    this.root.render(
      <PatchReviewApp
        patchList={this.patchList}
        onApply={async (patches, cats) => {
          this.close();
          await this.onApply(patches, cats);
        }}
        onCancel={() => this.close()}
      />
    );
  }

  onClose(): void {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
    this.contentEl.empty();
  }
}
