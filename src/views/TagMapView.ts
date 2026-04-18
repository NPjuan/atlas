import { ItemView, WorkspaceLeaf } from 'obsidian';
import { createRoot, Root } from 'react-dom/client';
import { createElement } from 'react';
import type MECEPlugin from '../main';
import { TagMapPanel } from '../ui/components/TagMapPanel';

export const TAG_MAP_VIEW_TYPE = 'mece-tag-map-view';

/**
 * V3 Tag 面板 — React 挂载点
 */
export class TagMapView extends ItemView {
  plugin: MECEPlugin;
  private root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: MECEPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return TAG_MAP_VIEW_TYPE; }
  getDisplayText(): string { return 'MECE Tag 面板'; }
  getIcon(): string { return 'brain'; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();

    if (this.root) {
      this.root.unmount();
      this.root = null;
    }

    this.root = createRoot(container);
    this.root.render(createElement(TagMapPanel, { plugin: this.plugin }));
  }

  async onClose(): Promise<void> {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
  }

  refreshView(): void {
    this.onOpen();
  }
}
