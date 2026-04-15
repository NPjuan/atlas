import { ItemView, WorkspaceLeaf } from 'obsidian';
import type MECEPlugin from '../main';
import { KnowledgeStore } from '../types';
import { MindMapRenderer } from '../ui/mindmap';
import { DetailPanel } from '../ui/detail-panel';

export const MIND_MAP_VIEW_TYPE = 'mece-mind-map-view';

export class MindMapView extends ItemView {
  plugin: MECEPlugin;
  private renderer: MindMapRenderer | null = null;
  private detailPanel: DetailPanel | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: MECEPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return MIND_MAP_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'MECE 知识导图';
  }

  getIcon(): string {
    return 'git-fork';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();

    // 主布局：导图 + 详情面板
    const wrapper = container.createDiv({ cls: 'mece-view-wrapper' });
    const mapContainer = wrapper.createDiv({ cls: 'mece-mindmap-container' });
    const detailContainer = wrapper.createDiv({ cls: 'mece-detail-container' });

    // 加载数据
    const store = await this.plugin.loadStore();
    if (!store || store.knowledgePoints.length === 0) {
      this.renderEmptyState(mapContainer);
      return;
    }

    // 初始化详情面板
    this.detailPanel = new DetailPanel(detailContainer, {
      onSourceClick: (filePath, position) => {
        // 跳转到 Obsidian 中的源笔记
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file) {
          this.app.workspace.openLinkText(filePath, '', false);
        }
      },
    });

    // 初始化思维导图渲染器
    this.renderer = new MindMapRenderer(mapContainer, store, {
      onNodeClick: (nodeId, kpIds) => {
        // 查找关联的知识点
        const kps = store.knowledgePoints.filter((kp) => kpIds.includes(kp.id));
        const node = this.findNodeById(store.categoryTree, nodeId);
        this.detailPanel?.show(node?.name || '知识点', kps);
      },
    });
    this.renderer.render();
  }

  async onClose(): Promise<void> {
    this.renderer?.destroy();
    this.renderer = null;
    this.detailPanel?.hide();
    this.detailPanel = null;
  }

  private renderEmptyState(container: HTMLElement): void {
    const empty = container.createDiv({ cls: 'mece-empty-state' });
    empty.createEl('h3', { text: '暂无知识数据' });
    empty.createEl('p', {
      text: '请先执行「扫描 Vault」命令来提取和分类知识点。',
    });
    const btn = empty.createEl('button', { text: '开始扫描', cls: 'mod-cta' });
    btn.addEventListener('click', () => {
      this.plugin.startScan();
    });
  }

  private findNodeById(node: any, id: string): any {
    if (node.id === id) return node;
    if (node.children) {
      for (const child of node.children) {
        const found = this.findNodeById(child, id);
        if (found) return found;
      }
    }
    return null;
  }
}
