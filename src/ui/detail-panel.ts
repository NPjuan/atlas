import { KnowledgePoint } from '../types';

// ============================================================
// 知识点详情面板 — 显示知识点列表、原文引用、来源链接
// ============================================================

export interface DetailPanelOptions {
  /** 点击来源链接回调 */
  onSourceClick?: (filePath: string, position?: { start: number; end: number }) => void;
}

export class DetailPanel {
  private container: HTMLElement;
  private panelEl: HTMLElement | null = null;
  private options: DetailPanelOptions;

  constructor(container: HTMLElement, options: DetailPanelOptions = {}) {
    this.container = container;
    this.options = options;
  }

  /** 显示指定知识点列表 */
  show(categoryName: string, knowledgePoints: KnowledgePoint[]): void {
    this.hide();

    this.panelEl = this.container.createDiv({ cls: 'mece-detail-panel' });

    // 标题
    this.panelEl.createEl('h4', { text: categoryName });
    this.panelEl.createEl('p', {
      text: `共 ${knowledgePoints.length} 条知识点`,
      cls: 'mece-detail-count',
    });

    // 知识点列表（超过 20 条时虚拟滚动）
    const listEl = this.panelEl.createDiv({ cls: 'mece-detail-list' });

    const displayLimit = 50;
    const displayPoints = knowledgePoints.slice(0, displayLimit);

    for (const kp of displayPoints) {
      const itemEl = listEl.createDiv({ cls: 'mece-detail-item' });

      // 知识点摘要
      itemEl.createEl('p', {
        text: kp.content,
        cls: 'mece-detail-content',
      });

      // 原文引用
      if (kp.sourceQuote) {
        itemEl.createDiv({
          cls: 'mece-detail-quote',
          text: `"${kp.sourceQuote}"`,
        });
      }

      // 来源链接
      const sourceLink = itemEl.createEl('a', {
        text: `📄 ${kp.sourceFile}`,
        cls: 'mece-detail-source',
      });
      sourceLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.options.onSourceClick?.(kp.sourceFile, kp.sourcePosition);
      });
    }

    if (knowledgePoints.length > displayLimit) {
      listEl.createEl('p', {
        text: `... 还有 ${knowledgePoints.length - displayLimit} 条未显示`,
        cls: 'mece-detail-more',
      });
    }

    // 关闭按钮
    const closeBtn = this.panelEl.createEl('button', {
      text: '关闭',
      cls: 'mece-detail-close',
    });
    closeBtn.addEventListener('click', () => this.hide());
  }

  /** 隐藏面板 */
  hide(): void {
    if (this.panelEl) {
      this.panelEl.remove();
      this.panelEl = null;
    }
  }
}
