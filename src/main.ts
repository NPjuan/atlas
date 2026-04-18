import { Plugin, Notice, WorkspaceLeaf, TFile, TFolder, Modal, FuzzySuggestModal, debounce } from 'obsidian';
import { MECESettings, DEFAULT_SETTINGS, TagPatch, TaxonomySchema, SuggestedCategory } from './types';
import { MECESettingTab } from './settings';
import { TagMapView, TAG_MAP_VIEW_TYPE } from './views/TagMapView';
import { StoreManager } from './core/store';
import { createAIProvider } from './ai/factory';
import { generatePatches, applyPatches, collectVaultTags } from './core/tagger';
import { generateTaxonomySchema } from './core/schema-generator';
import { PatchReviewModal } from './ui/components/PatchReviewModal';
import { SchemaEditorModal } from './ui/components/SchemaEditorModal';
import { ProgressModal } from './ui/progress-modal';

// ---- 文件夹选择器 ----

class FolderSuggestModal extends FuzzySuggestModal<TFolder | null> {
  private folders: (TFolder | null)[];
  private onChoose: (folder: TFolder | null) => void;

  constructor(app: any, folders: TFolder[], onChoose: (folder: TFolder | null) => void) {
    super(app);
    this.folders = [null, ...folders];
    this.onChoose = onChoose;
    this.setPlaceholder('选择文件夹（或选择「整个 Vault」）');
  }

  getItems(): (TFolder | null)[] { return this.folders; }
  getItemText(item: TFolder | null): string { return item ? item.path : '📁 整个 Vault'; }
  onChooseItem(item: TFolder | null): void { this.onChoose(item); }
}

// ============================================================
// MECE V3 Plugin
// ============================================================

export default class MECEPlugin extends Plugin {
  settings!: MECESettings;
  storeManager!: StoreManager;
  private isProcessing = false;
  targetFolder: string | undefined;

  async onload(): Promise<void> {
    console.log('MECE V3: loading');

    this.storeManager = new StoreManager(this);
    const store = await this.storeManager.load();
    this.settings = store.settings;

    this.registerView(TAG_MAP_VIEW_TYPE, (leaf) => new TagMapView(leaf, this));

    this.addRibbonIcon('brain', '打开 MECE Tag 面板', () => this.activateTagMapView());

    // ---- 命令 ----

    this.addCommand({ id: 'open-tag-map', name: '打开 Tag 面板', callback: () => this.activateTagMapView() });
    this.addCommand({ id: 'generate-schema', name: '生成分类体系', callback: () => this.generateSchema() });
    this.addCommand({ id: 'edit-schema', name: '编辑分类体系', callback: () => this.editSchema() });
    this.addCommand({ id: 'ai-tag-files', name: 'AI 打标签（选择文件夹）', callback: () => this.chooseFolderThenTag() });
    this.addCommand({
      id: 'reset-store',
      name: '重置所有数据',
      callback: async () => {
        const confirmed = await this.showConfirmDialog('重置所有数据', '将清空分类体系和所有处理记录。\n\n已写入笔记的 tag 不会被删除。', '重置', '取消');
        if (confirmed) {
          await this.storeManager.reset();
          new Notice('✅ 数据已重置');
          this.refreshTagMapView();
        }
      },
    });

    this.addSettingTab(new MECESettingTab(this.app, this));

    // 文件变化监听（静默刷新脑图，不弹 toast）
    const debouncedRefresh = debounce(() => {
      if (!this.isProcessing) this.refreshTagMapView();
    }, 3000, true);

    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (file instanceof TFile && file.extension === 'md') debouncedRefresh();
    }));
    this.registerEvent(this.app.vault.on('create', (file) => {
      if (file instanceof TFile && file.extension === 'md') debouncedRefresh();
    }));

    // 右键菜单
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && file.extension === 'md') {
          menu.addItem((item) => {
            item.setTitle('MECE：AI 打标签').setIcon('tags').onClick(async () => {
              await this.tagSingleFile(file);
            });
          });
        }
      })
    );

    console.log('MECE V3: loaded');
  }

  onunload(): void { console.log('MECE V3: unloaded'); }

  // ---- 设置 ----

  async saveSettings(): Promise<void> {
    await this.storeManager.updateSettings(this.settings);
    this.refreshTagMapView();
  }

  // ---- 视图管理 ----

  async activateTagMapView(): Promise<void> {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(TAG_MAP_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = leaves.length > 0 ? leaves[0] : null;

    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: TAG_MAP_VIEW_TYPE, active: true });
    }

    if (leaf) workspace.revealLeaf(leaf);
  }

  refreshTagMapView(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(TAG_MAP_VIEW_TYPE)) {
      if (leaf.view instanceof TagMapView) leaf.view.refreshView();
    }
  }

  // ---- AI 配置校验 ----

  private checkAIConfig(): boolean {
    const { aiProvider, apiKey, ollamaHost } = this.settings;
    if (aiProvider === 'ollama') {
      if (!ollamaHost?.trim()) { new Notice('⚠️ 请先配置 Ollama 地址', 8000); return false; }
      return true;
    }
    if (!apiKey?.trim()) {
      const names: Record<string, string> = { openai: 'OpenAI', claude: 'Claude', deepseek: 'DeepSeek' };
      new Notice(`⚠️ 请先配置 ${names[aiProvider] || aiProvider} 的 API Key`, 8000);
      return false;
    }
    return true;
  }

  // ---- Schema 生成 ----

  async generateSchema(useCurrentFolder = false): Promise<void> {
    if (this.isProcessing) { new Notice('正在处理中...'); return; }
    if (!this.checkAIConfig()) return;

    // 从 UI 触发时（useCurrentFolder=true），直接用当前选定的范围
    if (useCurrentFolder) {
      await this.doGenerateSchema();
      return;
    }

    // 从命令面板触发时，弹出文件夹选择器
    const allFolders = this.getAllFolders();
    new FolderSuggestModal(this.app, allFolders, async (folder) => {
      this.targetFolder = folder?.path || undefined;
      await this.doGenerateSchema();
    }).open();
  }

  private async doGenerateSchema(): Promise<void> {
    this.isProcessing = true;
    const modal = new ProgressModal(this.app, () => { this.isProcessing = false; });
    modal.open();

    // 判断是首次生成还是重新分类（已有 schema 时走 Patch Review 让用户确认）
    const isReorganize = this.storeManager.getTaxonomy(this.targetFolder) !== null;

    try {
      const files = this.getTargetFiles();
      if (files.length === 0) { new Notice('未找到 .md 文件'); modal.close(); this.isProcessing = false; return; }

      const provider = createAIProvider(this.settings);

      // Phase 1: 生成分类体系
      const rootName = this.targetFolder ? (this.targetFolder.split('/').pop() || this.targetFolder) : '全部';
      const taxonomy = await generateTaxonomySchema(this.app, files, provider, this.settings, {
        onProgress: (p) => modal.update(p),
        isCancelled: () => modal.isCancelled(),
        rootName,
      });

      await this.storeManager.setTaxonomy(this.targetFolder, taxonomy);

      // Phase 2: 为每篇笔记分配标签（生成 Patch 预览）
      modal.update({ phase: 'tagging', current: 0, total: files.length, message: '为笔记分配分类...' });

      const store = await this.storeManager.load();
      for (const f of files) delete store.processedFiles[f.path];

      const patchList = await generatePatches(this.app, files, store, provider, this.settings, taxonomy, {
        onProgress: (p) => modal.update(p),
        isCancelled: () => modal.isCancelled(),
      });

      modal.close();
      this.isProcessing = false;

      if (patchList.stats.filesWithChanges === 0) {
        new Notice('所有笔记标签已是最新');
        this.refreshTagMapView();
        return;
      }

      if (isReorganize) {
        // 重新分类 → 弹 Patch Review 让用户选择
        new PatchReviewModal(this.app, patchList, async (acceptedPatches, acceptedCategories) => {
          const applyStore = await this.storeManager.load();
          const result = await applyPatches(this.app, acceptedPatches, applyStore);
          await this.storeManager.save();
          if (acceptedCategories.length > 0) {
            await this.addCategoriesToSchema(taxonomy, acceptedCategories);
          }
          new Notice(`${result.applied} 篇笔记已更新标签` + (result.failed > 0 ? `，${result.failed} 篇失败` : ''));
          this.refreshTagMapView();
        }).open();
      } else {
        // 首次生成 → 直接写入
        const applyStore = await this.storeManager.load();
        const result = await applyPatches(this.app, patchList.patches, applyStore);
        await this.storeManager.save();
        new Notice(`完成：${result.applied} 篇笔记已分类` + (result.failed > 0 ? `，${result.failed} 篇失败` : ''));
        this.refreshTagMapView();
      }

    } catch (e) {
      modal.close();
      this.isProcessing = false;
      new Notice(`处理失败：${this.friendlyErrorMessage(e)}`, 10000);
      console.error('MECE error:', e);
    }
  }

  // ---- Schema 编辑 ----

  async editSchema(): Promise<void> {
    const taxonomy = this.storeManager.getTaxonomy(this.targetFolder);
    if (!taxonomy) {
      new Notice('此范围尚未生成分类体系，请先执行「生成分类体系」');
      return;
    }

    const noteCountMap = this.buildNoteCountMap();
    new SchemaEditorModal(
      this.app,
      taxonomy,
      noteCountMap,
      async (confirmed) => {
        await this.storeManager.setTaxonomy(this.targetFolder, confirmed);
        new Notice('分类体系已更新');
        this.refreshTagMapView();
      },
      () => this.doGenerateSchema(),
    ).open();
  }

  // ---- 打标签 ----

  /** 通用文件夹选择：供 UI 组件使用 */
  chooseFolderThen(onChoose: (folder: TFolder | null) => void): void {
    const allFolders = this.getAllFolders();
    new FolderSuggestModal(this.app, allFolders, onChoose).open();
  }

  async chooseFolderThenTag(): Promise<void> {
    const allFolders = this.getAllFolders();
    new FolderSuggestModal(this.app, allFolders, async (folder) => {
      this.targetFolder = folder?.path || undefined;
      await this.startTagging();
    }).open();
  }

  async startTagging(): Promise<void> {
    if (this.isProcessing) { new Notice('正在处理中...'); return; }
    if (!this.checkAIConfig()) return;

    const store = await this.storeManager.load();
    const files = this.getTargetFiles();
    if (files.length === 0) { new Notice('未找到可处理的 .md 文件'); return; }

    const taxonomy = this.storeManager.getTaxonomy(this.targetFolder);

    // 增量检测
    let alreadyTagged = 0, newOrChanged = 0;
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      const hash = this.simpleHash(content);
      const existing = store.processedFiles[file.path];
      if (existing && existing.hash === hash) alreadyTagged++;
      else newOrChanged++;
    }

    if (alreadyTagged > 0 && newOrChanged === 0) {
      const confirmed = await this.showConfirmDialog('重新生成标签', `${alreadyTagged} 个文件已打过标签且无变化。\n\n重新分析？`, '重新生成', '取消');
      if (!confirmed) return;
      for (const file of files) delete store.processedFiles[file.path];
      await this.storeManager.save();
    } else if (alreadyTagged > 0 && newOrChanged > 0) {
      const confirmed = await this.showConfirmDialog('部分文件已有标签', `${newOrChanged} 个新文件 + ${alreadyTagged} 个已处理。\n\n全部重新处理？`, `全部（${files.length}）`, `仅新文件（${newOrChanged}）`);
      if (confirmed) {
        for (const file of files) {
          const content = await this.app.vault.cachedRead(file);
          const hash = this.simpleHash(content);
          if (store.processedFiles[file.path]?.hash === hash) delete store.processedFiles[file.path];
        }
        await this.storeManager.save();
      }
    }

    this.isProcessing = true;
    const modal = new ProgressModal(this.app, () => { this.isProcessing = false; });
    modal.open();

    try {
      const provider = createAIProvider(this.settings);
      modal.update({ phase: 'scanning', current: 0, total: 0, message: '扫描文件...' });
      new Notice(`📄 ${files.length} 个文件，AI 分析中...`);

      const patchList = await generatePatches(this.app, files, store, provider, this.settings, taxonomy, {
        onProgress: (p) => modal.update(p),
        isCancelled: () => modal.isCancelled(),
      });

      modal.close();
      this.isProcessing = false;

      if (patchList.stats.filesWithChanges === 0) {
        new Notice('✅ 所有文件标签已是最新');
        for (const patch of patchList.patches) {
          store.processedFiles[patch.filePath] = { hash: patch.hash, taggedAt: new Date().toISOString(), tagCount: patch.oldTags.length };
        }
        await this.storeManager.save();
        return;
      }

      // Patch Review
      new PatchReviewModal(this.app, patchList, async (acceptedPatches: TagPatch[], acceptedCategories: SuggestedCategory[]) => {
        const result = await applyPatches(this.app, acceptedPatches, store);
        await this.storeManager.save();

        // 将确认的新分类纳入 Schema
        if (acceptedCategories.length > 0 && taxonomy) {
          await this.addCategoriesToSchema(taxonomy, acceptedCategories);
        }

        new Notice(`✅ ${result.applied} 个文件写入成功` + (result.failed > 0 ? `，${result.failed} 个失败` : ''));
        this.refreshTagMapView();
      }).open();

    } catch (e) {
      modal.close();
      this.isProcessing = false;
      new Notice(`❌ 打标签出错：${this.friendlyErrorMessage(e)}`, 10000);
    }
  }

  async tagSingleFile(file: TFile): Promise<void> {
    if (this.isProcessing) { new Notice('正在处理中...'); return; }
    if (!this.checkAIConfig()) return;

    this.isProcessing = true;
    try {
      const store = await this.storeManager.load();
      const provider = createAIProvider(this.settings);
      const taxonomy = this.storeManager.getTaxonomy(this.targetFolder) || this.storeManager.getTaxonomy();

      new Notice(`🏷️ AI 分析 ${file.name}...`);
      const patchList = await generatePatches(this.app, [file], store, provider, this.settings, taxonomy);
      this.isProcessing = false;

      if (patchList.stats.filesWithChanges === 0) { new Notice(`✅ ${file.name} 无需变更`); return; }

      new PatchReviewModal(this.app, patchList, async (patches, cats) => {
        const result = await applyPatches(this.app, patches, store);
        await this.storeManager.save();
        if (cats.length > 0 && taxonomy) await this.addCategoriesToSchema(taxonomy, cats);
        new Notice(`✅ 为 ${file.name} 更新了标签`);
        this.refreshTagMapView();
      }).open();
    } catch (e) {
      this.isProcessing = false;
      new Notice(`❌ 出错：${this.friendlyErrorMessage(e)}`, 10000);
    }
  }

  async testAIConnection(): Promise<void> {
    if (!this.checkAIConfig()) throw new Error('AI 配置不完整');
    const provider = createAIProvider(this.settings);
    await provider.testConnection();
  }

  // ---- 辅助 ----

  private async addCategoriesToSchema(taxonomy: TaxonomySchema, categories: SuggestedCategory[]): Promise<void> {
    // 简单实现：将新分类作为一级分类添加
    for (const cat of categories) {
      const parts = cat.path.split('/');
      const genId = () => Math.random().toString(36).substring(2, 10);

      // 检查是否已存在
      const exists = taxonomy.nodes.some(n => n.name === parts[0]);
      if (!exists) {
        taxonomy.nodes.push({ id: genId(), name: parts[0], fullPath: parts[0], children: [], description: '' });
      }
      // TODO: 支持多层级新增
    }

    taxonomy.updatedAt = new Date().toISOString();
    await this.storeManager.setTaxonomy(this.targetFolder, taxonomy);
  }

  private buildNoteCountMap(): Record<string, number> {
    const map: Record<string, number> = {};
    const tags = collectVaultTags(this.app);
    for (const tag of tags) {
      map[tag] = (map[tag] || 0) + 1;
    }
    return map;
  }

  private getTargetFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((file) => {
      if (this.targetFolder) {
        const prefix = this.targetFolder.endsWith('/') ? this.targetFolder : this.targetFolder + '/';
        if (!file.path.startsWith(prefix)) return false;
      }
      return !this.settings.excludeDirs.some((dir) => {
        const normalized = dir.replace(/^\/+|\/+$/g, '');
        return file.path.startsWith(normalized + '/') || file.path === normalized;
      });
    });
  }

  private getAllFolders(): TFolder[] {
    const folders: TFolder[] = [];
    const recurse = (folder: TFolder) => {
      if (folder.path !== '/' && folder.path !== '' && !folder.name.startsWith('.')) {
        folders.push(folder);
      }
      for (const child of folder.children) {
        if (child instanceof TFolder) recurse(child);
      }
    };
    recurse(this.app.vault.getRoot());
    return folders.sort((a, b) => a.path.localeCompare(b.path));
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString(36);
  }

  private friendlyErrorMessage(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e);
    const lower = raw.toLowerCase();
    if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('econnrefused')) {
      return this.settings.aiProvider === 'ollama' ? `无法连接 Ollama（${this.settings.ollamaHost}）` : '网络连接失败';
    }
    if (lower.includes('401') || lower.includes('unauthorized')) return 'API Key 无效';
    if (lower.includes('429') || lower.includes('rate limit')) return 'API 频率限制';
    if (lower.includes('timeout')) return 'AI 请求超时';
    return raw;
  }

  private showConfirmDialog(title: string, message: string, confirmText = '确认', cancelText = '取消'): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.app, title, message, confirmText, cancelText, resolve);
      modal.open();
    });
  }
}

// ---- 确认对话框 ----

class ConfirmModal extends Modal {
  private title: string;
  private message: string;
  private confirmText: string;
  private cancelText: string;
  private resolve: (value: boolean) => void;

  constructor(app: import('obsidian').App, title: string, message: string, confirmText: string, cancelText: string, resolve: (value: boolean) => void) {
    super(app);
    this.title = title; this.message = message;
    this.confirmText = confirmText; this.cancelText = cancelText;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: this.title });
    for (const line of this.message.split('\n')) {
      if (line.trim() === '') contentEl.createEl('br');
      else contentEl.createEl('p', { text: line, cls: 'mece-confirm-text' });
    }
    const btns = contentEl.createDiv({ cls: 'mece-confirm-buttons' });
    const cancelBtn = btns.createEl('button', { text: this.cancelText });
    cancelBtn.addEventListener('click', () => { this.resolve(false); this.close(); });
    const confirmBtn = btns.createEl('button', { text: this.confirmText, cls: 'mod-warning' });
    confirmBtn.addEventListener('click', () => { this.resolve(true); this.close(); });
  }

  onClose(): void { this.resolve(false); this.contentEl.empty(); }
}
