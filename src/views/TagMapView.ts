import { ItemView, WorkspaceLeaf } from 'obsidian';
import { createRoot, Root } from 'react-dom/client';
import { createElement } from 'react';
import type MECEPlugin from '../main';
import { TagMapPanel } from '../ui/components/TagMapPanel';
import { t } from '../i18n';

export const TAG_MAP_VIEW_TYPE = 'mece-tag-map-view';

/**
 * V3 Tag 面板 — React 挂载点
 *
 * 注意：React root 只创建一次。后续「刷新」通过改 props(version) 触发 React 重渲染，
 * 不要 unmount + remount，否则会和 Obsidian setIcon 操纵的 DOM 产生对账冲突
 * （NotFoundError: removeChild on Node）。
 */
export class TagMapView extends ItemView {
  plugin: MECEPlugin;
  private root: Root | null = null;
  private version = 0;

  constructor(leaf: WorkspaceLeaf, plugin: MECEPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return TAG_MAP_VIEW_TYPE; }
  getDisplayText(): string { return t('view.displayName'); }
  getIcon(): string { return 'wand-2'; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;

    // 只在首次挂载时清空容器并创建 root
    if (!this.root) {
      container.empty();
      this.root = createRoot(container);
    }

    this.renderPanel();
  }

  async onClose(): Promise<void> {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
  }

  /** 外部触发的刷新：只递增 version，让 React 重渲染，不重建 root */
  refreshView(): void {
    this.version++;
    this.renderPanel();
  }

  private renderPanel(): void {
    if (!this.root) return;
    this.root.render(
      createElement(TagMapPanel, {
        plugin: this.plugin,
        refreshKey: this.version,
      }),
    );
  }
}
