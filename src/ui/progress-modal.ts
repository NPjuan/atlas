import { App, Modal } from 'obsidian';
import { ScanProgress } from '../types';

const PHASE_LABELS: Record<string, string> = {
  scanning: '扫描文件',
  'schema-gen': '生成分类体系',
  tagging: '归类中',
  writing: '写入分类',
};

export class ProgressModal extends Modal {
  private progressEl!: HTMLElement;
  private fileEl!: HTMLElement;
  private barContainerEl!: HTMLElement;
  private barEl!: HTMLElement;
  private messageEl!: HTMLElement;
  private elapsedEl!: HTMLElement;
  private cancelled = false;
  private onCancel?: () => void;
  private startTime = 0;
  private elapsedTimer: number | null = null;
  private indeterminateSince = 0;

  constructor(app: App, onCancel?: () => void) {
    super(app);
    this.onCancel = onCancel;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mece-progress-modal');

    contentEl.createEl('h3', { text: 'Atlas 知识处理' });

    this.fileEl = contentEl.createDiv({ cls: 'mece-progress-file' });
    this.fileEl.setText('准备中...');

    this.barContainerEl = contentEl.createDiv({ cls: 'mece-progress-bar-container' });
    this.barEl = this.barContainerEl.createDiv({ cls: 'mece-progress-bar' });
    this.barEl.style.width = '0%';

    this.progressEl = contentEl.createDiv({ cls: 'mece-progress-text' });
    this.progressEl.setText('');

    this.messageEl = contentEl.createDiv({ cls: 'mece-progress-message' });

    this.elapsedEl = contentEl.createDiv({ cls: 'mece-progress-elapsed' });
    this.elapsedEl.style.display = 'none';

    const btnContainer = contentEl.createDiv({ cls: 'mece-progress-buttons' });
    const cancelBtn = btnContainer.createEl('button', { text: '取消' });
    cancelBtn.addEventListener('click', () => {
      this.cancelled = true;
      this.onCancel?.();
      this.close();
    });

    this.startTime = Date.now();
  }

  update(progress: ScanProgress): void {
    if (this.cancelled) return;

    const phaseLabel = PHASE_LABELS[progress.phase] || progress.phase;
    this.fileEl.setText(progress.currentFile ? `${phaseLabel}：${progress.currentFile}` : phaseLabel);

    if (progress.indeterminate) {
      // 不定式：用 CSS 动画条 + 已耗时计数
      this.barContainerEl.classList.add('mece-progress-bar-indeterminate');
      this.barEl.style.width = '';
      this.progressEl.setText('');
      if (this.indeterminateSince === 0) this.indeterminateSince = Date.now();
      this.startElapsedTimer();
    } else {
      // 确定式：恢复真实百分比
      this.barContainerEl.classList.remove('mece-progress-bar-indeterminate');
      const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
      this.barEl.style.width = `${pct}%`;
      this.progressEl.setText(progress.total > 0 ? `${progress.current} / ${progress.total}  (${pct}%)` : '');
      this.indeterminateSince = 0;
      this.stopElapsedTimer();
      this.elapsedEl.style.display = 'none';
    }

    if (progress.message) {
      this.messageEl.setText(progress.message);
    }
  }

  private startElapsedTimer(): void {
    if (this.elapsedTimer != null) return;
    this.elapsedEl.style.display = '';
    const tick = () => {
      const sec = Math.floor((Date.now() - this.indeterminateSince) / 1000);
      this.elapsedEl.setText(`已等待 ${sec}s`);
    };
    tick();
    this.elapsedTimer = window.setInterval(tick, 1000);
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer != null) {
      window.clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  onClose(): void {
    this.stopElapsedTimer();
    this.contentEl.empty();
  }
}
