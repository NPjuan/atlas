import { App, Modal } from 'obsidian';
import { ScanProgress } from '../types';

const PHASE_LABELS: Record<string, string> = {
  scanning: '扫描文件',
  'schema-gen': '生成分类体系',
  tagging: 'AI 打标签',
  writing: '写入 frontmatter',
};

export class ProgressModal extends Modal {
  private progressEl!: HTMLElement;
  private fileEl!: HTMLElement;
  private barEl!: HTMLElement;
  private messageEl!: HTMLElement;
  private cancelled = false;
  private onCancel?: () => void;

  constructor(app: App, onCancel?: () => void) {
    super(app);
    this.onCancel = onCancel;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mece-progress-modal');

    contentEl.createEl('h3', { text: 'MECE 知识处理' });

    this.fileEl = contentEl.createDiv({ cls: 'mece-progress-file' });
    this.fileEl.setText('准备中...');

    const barContainer = contentEl.createDiv({ cls: 'mece-progress-bar-container' });
    this.barEl = barContainer.createDiv({ cls: 'mece-progress-bar' });
    this.barEl.style.width = '0%';

    this.progressEl = contentEl.createDiv({ cls: 'mece-progress-text' });
    this.progressEl.setText('0 / 0');

    this.messageEl = contentEl.createDiv({ cls: 'mece-progress-message' });

    const btnContainer = contentEl.createDiv({ cls: 'mece-progress-buttons' });
    const cancelBtn = btnContainer.createEl('button', { text: '取消' });
    cancelBtn.addEventListener('click', () => {
      this.cancelled = true;
      this.onCancel?.();
      this.close();
    });
  }

  update(progress: ScanProgress): void {
    if (this.cancelled) return;

    const phaseLabel = PHASE_LABELS[progress.phase] || progress.phase;
    const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

    this.fileEl.setText(progress.currentFile ? `${phaseLabel}：${progress.currentFile}` : phaseLabel);
    this.barEl.style.width = `${pct}%`;
    this.progressEl.setText(`${progress.current} / ${progress.total}  (${pct}%)`);

    if (progress.message) {
      this.messageEl.setText(progress.message);
    }
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
