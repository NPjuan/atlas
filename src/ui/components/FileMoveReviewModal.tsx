import { App, Modal, setIcon } from 'obsidian';
import React, { useState, useEffect, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import type { FileMoveAction, ConflictResolution } from '../../core/file-organizer';
import { resolveConflict, computeTargetPath, extractFileName } from '../../core/file-organizer';

/** setIcon 脱管 DOM 小工具 */
function Icon({ name, size = 14 }: { name: string; size?: number }) {
  const innerRef = useRef<HTMLSpanElement | null>(null);
  const apply = () => {
    const inner = innerRef.current;
    if (!inner) return;
    inner.replaceChildren();
    setIcon(inner, name);
    const svg = inner.querySelector('svg');
    if (svg) {
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
    }
  };
  const setHost = (host: HTMLSpanElement | null) => {
    if (!host) return;
    if (!innerRef.current) {
      innerRef.current = document.createElement('span');
      innerRef.current.style.display = 'inline-flex';
      innerRef.current.style.alignItems = 'center';
    }
    if (innerRef.current.parentNode !== host) host.appendChild(innerRef.current);
    apply();
  };
  useEffect(apply, [name, size]);
  return <span ref={setHost} style={{ display: 'inline-flex', width: size, height: size, flexShrink: 0 }} />;
}

// ============================================================
// App
// ============================================================

interface FileMoveReviewProps {
  actions: FileMoveAction[];
  onApply: (actions: FileMoveAction[]) => void;
  onCancel: () => void;
}

/** Modal 内部用的 item 状态：在 action 基础上加 UI 状态 */
interface ActionState extends FileMoveAction {
  accepted: boolean;
  /** 冲突处理：skip / overwrite / rename；无冲突时为 null */
  conflictResolution: ConflictResolution | null;
}

function FileMoveReviewApp({ actions, onApply, onCancel }: FileMoveReviewProps) {
  const [items, setItems] = useState<ActionState[]>(() =>
    actions.map(a => ({
      ...a,
      // 默认勾选：不需要迁移的（alreadyInPlace）不勾；其他都勾
      accepted: !a.alreadyInPlace,
      // 默认冲突策略：有冲突 → rename；否则 null
      conflictResolution: a.hasNameConflict ? 'rename' : null,
    })),
  );

  const toggle = (idx: number) => {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, accepted: !it.accepted } : it));
  };

  const pickTag = (idx: number, tag: string) => {
    setItems(prev => prev.map((it, i) => {
      if (i !== idx) return it;
      const fileName = extractFileName(it.fromPath);
      const newToPath = computeTargetPath(tag, fileName);
      return { ...it, chosenTag: tag, toPath: newToPath, alreadyInPlace: newToPath === it.fromPath };
    }));
  };

  const setConflictStrategy = (idx: number, strategy: ConflictResolution) => {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, conflictResolution: strategy } : it));
  };

  // 只保留接受的、未在位的、（如选 skip 则剔除）
  const effectiveActions = items
    .filter(it => it.accepted && !it.alreadyInPlace)
    .filter(it => !(it.hasNameConflict && it.conflictResolution === 'skip'))
    .map(it => {
      // 应用 rename 解决方案
      if (it.hasNameConflict && it.conflictResolution === 'rename') {
        return resolveConflict(it, 'rename');
      }
      return it;
    });

  // 分组统计
  const needsMove = items.filter(it => !it.alreadyInPlace).length;
  const alreadyOk = items.filter(it => it.alreadyInPlace).length;
  const conflictCount = items.filter(it => it.hasNameConflict).length;
  const multiTagCount = items.filter(it => it.needsUserPickTag).length;

  return (
    <div className="mece-file-move-review">
      <div className="mece-pr-header">
        <h3>
          <Icon name="folder-tree" size={16} />
          <span>按分类整理文件夹</span>
        </h3>
        <p className="mece-pr-desc">
          笔记将按照 tag 路径移动到对应文件夹。这个操作会移动文件本身，<strong>请仔细核对</strong>。
        </p>
      </div>

      <div className="mece-pr-stats-bar">
        <span className="mece-pr-stat mece-pr-stat-highlight">
          <Icon name="arrow-right" size={12} />
          <span>{needsMove} 个文件待迁移</span>
        </span>
        {alreadyOk > 0 && (
          <span className="mece-pr-stat mece-pr-stat-muted">
            <Icon name="check" size={12} />
            <span>{alreadyOk} 个已在正确位置</span>
          </span>
        )}
        {multiTagCount > 0 && (
          <span className="mece-pr-stat mece-pr-stat-new">
            <Icon name="split" size={12} />
            <span>{multiTagCount} 个多 tag 需选主路径</span>
          </span>
        )}
        {conflictCount > 0 && (
          <span className="mece-pr-stat mece-pr-stat-new">
            <Icon name="alert-triangle" size={12} />
            <span>{conflictCount} 个名称冲突</span>
          </span>
        )}
      </div>

      <div className="mece-fm-list">
        {items.map((it, idx) => {
          if (it.alreadyInPlace) {
            return (
              <div key={idx} className="mece-fm-item mece-fm-item-skip">
                <Icon name="check" size={12} />
                <span className="mece-fm-filename">{extractFileName(it.fromPath)}</span>
                <span className="mece-fm-in-place">已在 {it.fromPath}</span>
              </div>
            );
          }
          return (
            <div
              key={idx}
              className={`mece-fm-item ${it.accepted ? 'mece-fm-item-on' : 'mece-fm-item-off'}`}
            >
              <input
                type="checkbox"
                checked={it.accepted}
                onChange={() => toggle(idx)}
              />
              <div className="mece-fm-body">
                <div className="mece-fm-paths">
                  <span className="mece-fm-from">{it.fromPath}</span>
                  <Icon name="arrow-right" size={12} />
                  <span className="mece-fm-to">{it.toPath}</span>
                </div>

                {it.needsUserPickTag && (
                  <div className="mece-fm-multi-tag">
                    <span className="mece-fm-hint">多 tag，选主路径：</span>
                    {it.allTags.map(tag => (
                      <label key={tag} className="mece-fm-tag-option">
                        <input
                          type="radio"
                          name={`pick-tag-${idx}`}
                          checked={it.chosenTag === tag}
                          onChange={() => pickTag(idx, tag)}
                        />
                        <span>{tag}</span>
                      </label>
                    ))}
                  </div>
                )}

                {it.hasNameConflict && (
                  <div className="mece-fm-conflict">
                    <Icon name="alert-triangle" size={12} />
                    <span className="mece-fm-hint">目标已存在同名文件：</span>
                    {(['rename', 'overwrite', 'skip'] as ConflictResolution[]).map(s => (
                      <label key={s} className="mece-fm-conflict-option">
                        <input
                          type="radio"
                          name={`conflict-${idx}`}
                          checked={it.conflictResolution === s}
                          onChange={() => setConflictStrategy(idx, s)}
                        />
                        <span>{s === 'rename' ? '重命名加日期' : s === 'overwrite' ? '覆盖' : '跳过'}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mece-pr-footer">
        <button className="mece-btn" onClick={onCancel}>取消</button>
        <button
          className="mece-btn mece-btn-primary"
          onClick={() => onApply(effectiveActions)}
          disabled={effectiveActions.length === 0}
        >
          执行 {effectiveActions.length} 个迁移
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Obsidian Modal
// ============================================================

export class FileMoveReviewModal extends Modal {
  private root: Root | null = null;
  private actions: FileMoveAction[];
  private onApply: (actions: FileMoveAction[]) => Promise<void>;

  constructor(
    app: App,
    actions: FileMoveAction[],
    onApply: (actions: FileMoveAction[]) => Promise<void>,
  ) {
    super(app);
    this.actions = actions;
    this.onApply = onApply;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mece-file-move-modal');

    const container = contentEl.createDiv();
    this.root = createRoot(container);
    this.root.render(
      <FileMoveReviewApp
        actions={this.actions}
        onApply={async (acts) => {
          this.close();
          await this.onApply(acts);
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
