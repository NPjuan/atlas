import { App, Modal, Notice } from 'obsidian';
import React, { useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import type { TagPatch, TagPatchList, SuggestedCategory } from '../../types';

// ============================================================
// Patch Review Modal — React 版 git-diff 风格审核
// ============================================================

interface PatchReviewAppProps {
  patchList: TagPatchList;
  onApply: (patches: TagPatch[], acceptedCategories: SuggestedCategory[]) => void;
  onCancel: () => void;
}

function PatchReviewApp({ patchList, onApply, onCancel }: PatchReviewAppProps) {
  const changesOnly = patchList.patches.filter(p => p.hasChanges);
  const [patches, setPatches] = useState(changesOnly);
  const [categories, setCategories] = useState(patchList.suggestedCategories);

  const togglePatch = (idx: number) => {
    setPatches(prev => prev.map((p, i) => i === idx ? { ...p, accepted: !p.accepted } : p));
  };

  const selectAll = () => setPatches(prev => prev.map(p => ({ ...p, accepted: true })));
  const selectNone = () => setPatches(prev => prev.map(p => ({ ...p, accepted: false })));

  const toggleCategory = (idx: number) => {
    setCategories(prev => prev.map((c, i) => i === idx ? { ...c, accepted: !c.accepted } : c));
  };

  const acceptedPatches = patches.filter(p => p.accepted);
  const acceptedCategories = categories.filter(c => c.accepted);

  return (
    <div className="mece-patch-review">
      {/* 头部 */}
      <div className="mece-pr-header">
        <h3>📋 标签变更预览</h3>
        <p className="mece-pr-desc">AI 建议以下标签变更，请审核后确认应用。</p>
      </div>

      {/* 统计 */}
      <div className="mece-pr-stats-bar">
        <span className="mece-pr-stat">📄 {patchList.stats.totalFiles} 文件扫描</span>
        <span className="mece-pr-stat mece-pr-stat-highlight">✨ {patchList.stats.filesWithChanges} 文件有变更</span>
        <span className="mece-pr-stat">🏷️ {patchList.stats.totalNewTags} 个新标签</span>
        {patchList.stats.skippedFiles > 0 && (
          <span className="mece-pr-stat mece-pr-stat-muted">⏭️ {patchList.stats.skippedFiles} 跳过</span>
        )}
      </div>

      {/* 操作栏 */}
      <div className="mece-pr-action-bar">
        <button className="mece-btn-sm" onClick={selectAll}>✓ 全选</button>
        <button className="mece-btn-sm" onClick={selectNone}>✗ 全不选</button>
        <span className="mece-pr-summary">
          {acceptedPatches.length}/{patches.length} 文件
        </span>
      </div>

      {/* Patch 列表 */}
      <div className="mece-pr-list">
        {patches.length === 0 ? (
          <p className="mece-pr-empty">所有文件的标签已是最新 🎉</p>
        ) : (
          patches.map((patch, idx) => (
            <div
              key={patch.filePath}
              className={`mece-pr-item ${patch.accepted ? 'mece-pr-item-accepted' : 'mece-pr-item-rejected'}`}
            >
              <input
                type="checkbox"
                className="mece-pr-checkbox"
                checked={patch.accepted}
                onChange={() => togglePatch(idx)}
              />
              <div className="mece-pr-file-info">
                <span className="mece-pr-filename">{patch.fileName}</span>
                <div className="mece-pr-diff">
                  {patch.removed.length > 0 && (
                    <div className="mece-pr-diff-removed">
                      <span className="mece-pr-diff-prefix mece-pr-diff-minus">− </span>
                      {patch.removed.map(t => <span key={t} className="mece-pr-tag mece-pr-tag-removed">{t}</span>)}
                    </div>
                  )}
                  {patch.newTags.filter(t => patch.oldTags.includes(t)).length > 0 && (
                    <div className="mece-pr-diff-existing">
                      <span className="mece-pr-diff-prefix">  </span>
                      {patch.newTags.filter(t => patch.oldTags.includes(t)).map(t =>
                        <span key={t} className="mece-pr-tag mece-pr-tag-existing">{t}</span>
                      )}
                    </div>
                  )}
                  {patch.added.length > 0 && (
                    <div className="mece-pr-diff-added">
                      <span className="mece-pr-diff-prefix mece-pr-diff-plus">+ </span>
                      {patch.added.map(t => <span key={t} className="mece-pr-tag mece-pr-tag-added">{t}</span>)}
                    </div>
                  )}
                  <div className="mece-pr-result-hint">→ 最终 {patch.newTags.length} 个标签</div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 新分类确认区 */}
      {categories.length > 0 && (
        <div className="mece-pr-new-categories">
          <h4>🆕 AI 建议的新分类（勾选后纳入 Schema）</h4>
          {categories.map((cat, idx) => (
            <label key={cat.path} className="mece-pr-category-item">
              <input
                type="checkbox"
                checked={cat.accepted}
                onChange={() => toggleCategory(idx)}
              />
              <span className="mece-pr-category-path">{cat.path}</span>
              <span className="mece-pr-category-source">来自 {cat.sourceFile.split('/').pop()}</span>
            </label>
          ))}
        </div>
      )}

      {/* 底部 */}
      <div className="mece-pr-footer">
        <button className="mece-btn" onClick={onCancel}>取消</button>
        <button
          className="mece-btn mece-btn-primary"
          onClick={() => onApply(acceptedPatches, acceptedCategories)}
          disabled={acceptedPatches.length === 0}
        >
          ✅ 应用 {acceptedPatches.length} 个变更
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
