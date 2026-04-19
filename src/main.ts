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
import { ReorganizeModal } from './ui/components/ReorganizeModal';
import { FileMoveReviewModal } from './ui/components/FileMoveReviewModal';
import { ProgressModal } from './ui/progress-modal';
import { planFileMoves, collectFoldersToCreate, type FileMoveAction } from './core/file-organizer';
import { collectAllFullPaths } from './core/taxonomy-scope';
import { t, setLocale, resolveLocale, getLocale } from './i18n';

// ---- 文件夹选择器 ----

/**
 * Obsidian 原生 FuzzySuggestModal：扁平文件夹列表 + fuzzy 搜索。
 * schema 里有对应分类的文件夹排最前面（按路径字母序），其他文件夹按字母序在后。
 */
class FolderSuggestModal extends FuzzySuggestModal<TFolder | null> {
  private folders: (TFolder | null)[];
  private onChoose: (folder: TFolder | null) => void;

  constructor(
    app: any,
    folders: TFolder[],
    onChoose: (folder: TFolder | null) => void,
    markedPaths: Set<string> = new Set(),
  ) {
    super(app);
    const marked = folders.filter(f => markedPaths.has(f.path));
    const others = folders.filter(f => !markedPaths.has(f.path));
    const byPath = (a: TFolder, b: TFolder) => a.path.localeCompare(b.path);
    marked.sort(byPath);
    others.sort(byPath);
    this.folders = [null, ...marked, ...others];
    this.onChoose = onChoose;
    this.setPlaceholder(t('folder.placeholder'));
  }

  getItems(): (TFolder | null)[] { return this.folders; }
  getItemText(item: TFolder | null): string {
    return item ? item.path : t('folder.wholeVault');
  }
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
    console.log('Atlas: loading');

    this.storeManager = new StoreManager(this);
    const store = await this.storeManager.load();
    this.settings = store.settings;

    // i18n：按 settings.language 初始化 locale
    setLocale(resolveLocale(this.settings.language));

    this.registerView(TAG_MAP_VIEW_TYPE, (leaf) => new TagMapView(leaf, this));

    this.addRibbonIcon('wand-2', t('ribbon.openPanel'), () => this.activateTagMapView());

    // ---- 命令 ----

    this.addCommand({ id: 'open-tag-map', name: t('command.openPanel'), callback: () => this.activateTagMapView() });
    this.addCommand({ id: 'generate-schema', name: t('command.generateSchema'), callback: () => this.generateSchema() });
    this.addCommand({ id: 'edit-schema', name: t('command.editSchema'), callback: () => this.editSchema() });
    this.addCommand({ id: 'ai-tag-files', name: t('command.aiTagFiles'), callback: () => this.chooseFolderThenTag() });
    this.addCommand({
      id: 'reset-store',
      name: t('command.resetStore'),
      callback: async () => {
        const confirmed = await this.showConfirmDialog(t('modal.confirmResetTitle'), t('modal.confirmResetDesc'), t('common.reset'), t('common.cancel'));
        if (confirmed) {
          await this.storeManager.reset();
          new Notice(t('notice.dataReset'));
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
            item.setTitle(t('menu.aiTag')).setIcon('tags').onClick(async () => {
              await this.tagSingleFile(file);
            });
          });
        }
      })
    );

    console.log('Atlas: loaded');
  }

  onunload(): void { console.log('Atlas: unloaded'); }

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
      if (!ollamaHost?.trim()) { new Notice(t('notice.apiKeyMissing', { provider: 'Ollama' }), 8000); return false; }
      return true;
    }
    if (!apiKey?.trim()) {
      const names: Record<string, string> = { openai: 'OpenAI', claude: 'Claude', deepseek: 'DeepSeek' };
      new Notice(t('notice.apiKeyMissing', { provider: names[aiProvider] || aiProvider }), 8000);
      return false;
    }
    return true;
  }

  // ---- Schema 生成 ----

  async generateSchema(useCurrentFolder = false): Promise<void> {
    if (this.isProcessing) { new Notice(t('notice.processing')); return; }
    if (!this.checkAIConfig()) return;

    // 从 UI 触发时（useCurrentFolder=true），直接用当前选定的范围
    if (useCurrentFolder) {
      await this.doGenerateSchema();
      return;
    }

    // 从命令面板触发时，弹出文件夹选择器
    // 从命令面板触发时，弹出文件夹选择器
    new FolderSuggestModal(this.app, this.getAllFolders(), async (folder) => {
      this.targetFolder = folder?.path || undefined;
      await this.doGenerateSchema();
    }, this.getMarkedFolderPaths()).open();
  }

  private async doGenerateSchema(): Promise<void> {
    this.isProcessing = true;
    const modal = new ProgressModal(this.app, () => { this.isProcessing = false; });
    modal.open();

    // 判断是首次生成还是重新分类（已有 schema 时走 Patch Review 让用户确认）
    const isReorganize = this.storeManager.getTaxonomy() !== null;

    try {
      const files = this.getTargetFiles();
      if (files.length === 0) { new Notice(t('notice.noFilesFound')); modal.close(); this.isProcessing = false; return; }

      const provider = createAIProvider(this.settings);

      // Phase 1: 生成分类体系
      const rootName = this.targetFolder ? (this.targetFolder.split('/').pop() || this.targetFolder) : t('empty.wholeVault');
      const taxonomy = await generateTaxonomySchema(this.app, files, provider, this.settings, {
        onProgress: (p) => modal.update(p),
        isCancelled: () => modal.isCancelled(),
        rootName,
      });

      await this.storeManager.setTaxonomy(taxonomy);

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

      if (patchList.stats.filesWithChanges === 0 && patchList.suggestedCategories.length === 0) {
        new Notice(t('notice.allUpToDate'));
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
          new Notice(`${t('notice.tagsWritten', { count: result.applied })}${result.failed > 0 ? t('notice.tagsFailed', { count: result.failed }) : ''}`);
          this.refreshTagMapView();
          this.triggerAutoOrganize(this.targetFolder);
        }).open();
      } else {
        // 首次生成 → 直接写入
        const applyStore = await this.storeManager.load();
        const result = await applyPatches(this.app, patchList.patches, applyStore);
        await this.storeManager.save();
        new Notice(`${t('notice.tagsWritten', { count: result.applied })}${result.failed > 0 ? t('notice.tagsFailed', { count: result.failed }) : ''}`);
        this.refreshTagMapView();
        this.triggerAutoOrganize(this.targetFolder);
      }

    } catch (e) {
      modal.close();
      this.isProcessing = false;
      new Notice(t('notice.processError', { error: this.friendlyErrorMessage(e) }), 10000);
      console.error('Atlas error:', e);
    }
  }

  // ---- Schema 编辑 ----

  async editSchema(): Promise<void> {
    const taxonomy = this.storeManager.getTaxonomy();
    if (!taxonomy) {
      new Notice(t('notice.noSchemaToEdit'));
      return;
    }

    const noteCountMap = this.buildNoteCountMap();
    new SchemaEditorModal(
      this.app,
      taxonomy,
      noteCountMap,
      async (confirmed) => {
        await this.storeManager.setTaxonomy(confirmed);
        new Notice(t('notice.schemaUpdated'));
        this.refreshTagMapView();
      },
      () => this.doGenerateSchema(),
    ).open();
  }

  // ---- 打标签 ----

  /** 通用文件夹选择：供 UI 组件使用 */
  chooseFolderThen(onChoose: (folder: TFolder | null) => void): void {
    new FolderSuggestModal(this.app, this.getAllFolders(), onChoose, this.getMarkedFolderPaths()).open();
  }

  async chooseFolderThenTag(): Promise<void> {
    new FolderSuggestModal(this.app, this.getAllFolders(), async (folder) => {
      this.targetFolder = folder?.path || undefined;
      await this.startTagging();
    }, this.getMarkedFolderPaths()).open();
  }

  /** schema 里所有节点 fullPath 与 vault 里存在的文件夹路径的交集 */
  private getMarkedFolderPaths(): Set<string> {
    const taxonomy = this.storeManager.getTaxonomy();
    const schemaPaths = collectAllFullPaths(taxonomy);
    if (schemaPaths.size === 0) return new Set();
    const vaultFolderPaths = new Set(this.getAllFolders().map(f => f.path));
    const marked = new Set<string>();
    schemaPaths.forEach(p => { if (vaultFolderPaths.has(p)) marked.add(p); });
    return marked;
  }

  async startTagging(): Promise<void> {
    if (this.isProcessing) { new Notice(t('notice.processing')); return; }
    if (!this.checkAIConfig()) return;

    const store = await this.storeManager.load();
    const files = this.getTargetFiles();
    if (files.length === 0) { new Notice(t('notice.noFilesFound')); return; }

    const taxonomy = this.storeManager.getTaxonomy();
    let alreadyTagged = 0, newOrChanged = 0;
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      const hash = this.simpleHash(content);
      const existing = store.processedFiles[file.path];
      // 当前 frontmatter 真的有 tag 才算"已分类"；否则视作未归类（和 tagger.ts 的跳过逻辑保持一致）
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const rawTags = fm?.tags;
      const hasTags = Array.isArray(rawTags)
        ? rawTags.some((t: unknown) => typeof t === 'string' && !!t.trim())
        : typeof rawTags === 'string' && !!rawTags.trim();
      if (existing && existing.hash === hash && hasTags) alreadyTagged++;
      else newOrChanged++;
    }

    if (alreadyTagged > 0 && newOrChanged === 0) {
      const confirmed = await this.showConfirmDialog(t('modal.reorganizeTitle'), t('notice.confirmReorganize', { count: alreadyTagged }), t('modal.reorganizeConfirm'), t('common.cancel'));
      if (!confirmed) return;
      for (const file of files) delete store.processedFiles[file.path];
      await this.storeManager.save();
    } else if (alreadyTagged > 0 && newOrChanged > 0) {
      const confirmed = await this.showConfirmDialog(t('notice.partialTaggedTitle'), t('notice.partialTaggedDesc', { newCount: newOrChanged, oldCount: alreadyTagged }), t('notice.partialTaggedConfirmAll', { count: files.length }), t('notice.partialTaggedConfirmNewOnly', { count: newOrChanged }));
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
      new Notice(t('notice.analyzing', { count: files.length }));

      const patchList = await generatePatches(this.app, files, store, provider, this.settings, taxonomy, {
        onProgress: (p) => modal.update(p),
        isCancelled: () => modal.isCancelled(),
      });

      modal.close();
      this.isProcessing = false;

      if (patchList.stats.filesWithChanges === 0 && patchList.suggestedCategories.length === 0) {
        new Notice(t('notice.allCategorizedOk'));
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

        new Notice(`${t('notice.tagsWritten', { count: result.applied })}${result.failed > 0 ? t('notice.tagsFailed', { count: result.failed }) : ''}`);
        this.refreshTagMapView();
        this.triggerAutoOrganize(this.targetFolder);
      }).open();

    } catch (e) {
      modal.close();
      this.isProcessing = false;
      new Notice(t('notice.analysisError', { error: this.friendlyErrorMessage(e) }), 10000);
    }
  }

  /**
   * 打开「重新归类」配置弹窗
   * 用户选择范围 + 调整强度 → 走 tagFiles 流程
   */
  openReorganize(): void {
    if (!this.checkAIConfig()) return;
    const store = this.storeManager.get();
    if (!store || !store.taxonomy) {
      new Notice(t('notice.noSchema'));
      return;
    }

    new ReorganizeModal(this, this.targetFolder, (folderPath, intensity) => {
      // 按所选范围收集笔记
      const files = this.app.vault.getMarkdownFiles().filter(f => {
        if (!folderPath) return true;
        const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
        return f.path.startsWith(prefix);
      });
      if (files.length === 0) {
        new Notice(t('notice.noFilesInScope'));
        return;
      }
      this.tagFiles(files, intensity);
    }).open();
  }

  /**
   * 给指定的未分类笔记做 AI 归类（带二次确认弹窗）
   * 场景：UnifiedOrganizer 点击「AI 归类」按钮
   *
   * 策略：整个插件只有一份 root schema，所有笔记统一用它做约束式归类。
   * folderFilter 只决定"给哪些笔记归类"，不决定"用哪个 schema"。
   */
  async tagFiles(files: TFile[], intensity?: import('./ai/prompts').ReorganizeIntensity): Promise<void> {
    if (this.isProcessing) { new Notice(t('notice.processing')); return; }
    if (!this.checkAIConfig()) return;
    if (files.length === 0) { new Notice(t('notice.noFilesToProcess')); return; }

    // 未显式传 intensity 时，使用设置里的默认值
    const effectiveIntensity: import('./ai/prompts').ReorganizeIntensity =
      intensity
      || (this.settings.defaultReorganizeIntensity as import('./ai/prompts').ReorganizeIntensity)
      || 'conservative';

    const store = await this.storeManager.load();
    const taxonomy = this.storeManager.getTaxonomy();
    if (!taxonomy) {
      new Notice(t('notice.configureAIFirst'));
      return;
    }

    const provider = createAIProvider(this.settings);

    this.isProcessing = true;
    const modal = new ProgressModal(this.app, () => { this.isProcessing = false; });
    modal.open();

    try {
      modal.update({
        phase: 'tagging',
        current: 0,
        total: files.length,
        indeterminate: true,
        message: `正在分析 ${files.length} 篇笔记...`,
      });

      const patchList = await generatePatches(
        this.app, files, store, provider, this.settings, taxonomy,
        {
          onProgress: (p) => modal.update(p),
          isCancelled: () => modal.isCancelled(),
          intensity: effectiveIntensity,
        },
      );

      modal.close();
      this.isProcessing = false;

      const withChanges = patchList.patches.filter(p => p.hasChanges);
      if (withChanges.length === 0 && patchList.suggestedCategories.length === 0) {
        new Notice(t('notice.aiFailedToFindCategory'));
        return;
      }

      new PatchReviewModal(this.app, patchList, async (acceptedPatches, acceptedCategories) => {
        const result = await applyPatches(this.app, acceptedPatches, store);
        await this.storeManager.save();

        // 新分类直接加到全局 taxonomy
        if (acceptedCategories.length > 0) {
          await this.addCategoriesToSchema(taxonomy, acceptedCategories);
        }

        new Notice(`${t('notice.tagsWritten', { count: result.applied })}${result.failed > 0 ? t('notice.tagsFailed', { count: result.failed }) : ''}`);
        this.refreshTagMapView();
        // 分类 = 目录：归类写入后自动触发文件迁移（可在设置里关）
        this.triggerAutoOrganize(null);
      }).open();
    } catch (e) {
      modal.close();
      this.isProcessing = false;
      new Notice(t('notice.analysisError', { error: this.friendlyErrorMessage(e) }), 10000);
    }
  }

  // ============================================================
  // 文件夹整理：按 tag 把笔记移动到对应文件夹
  // ============================================================

  /**
   * 扫描范围内所有笔记，按它们 tag 规划文件迁移动作，弹 Review Modal 让用户确认。
   *
   * @param scopeFolderPath 只处理这个文件夹下的笔记；null = 整个 vault
   */
  async organizeFilesByCategory(scopeFolderPath?: string | null): Promise<void> {
    if (this.isProcessing) { new Notice(t('notice.processing')); return; }

    // 1. 收集 scope 下的笔记和它们的 tag
    const allFiles = this.app.vault.getMarkdownFiles();
    const scopedFiles = allFiles.filter(f => {
      if (!scopeFolderPath) return true;
      const prefix = scopeFolderPath.endsWith('/') ? scopeFolderPath : scopeFolderPath + '/';
      return f.path.startsWith(prefix) || f.path === scopeFolderPath;
    });

    const inputs = scopedFiles.map(f => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      const rawTags = fm?.tags;
      let tags: string[] = [];
      if (Array.isArray(rawTags)) {
        tags = rawTags.filter((t): t is string => typeof t === 'string' && !!t.trim()).map(t => t.trim());
      } else if (typeof rawTags === 'string' && rawTags.trim()) {
        tags = [rawTags.trim()];
      }
      return { currentPath: f.path, tags };
    });

    // 2. 规划迁移
    const existingFiles = new Set(allFiles.map(f => f.path));
    const actions = planFileMoves(inputs, existingFiles);

    const needsMove = actions.filter(a => !a.alreadyInPlace);
    if (needsMove.length === 0) {
      new Notice(t('notice.allInPlace'));
      return;
    }

    // 3. 弹 Review Modal
    new FileMoveReviewModal(this.app, actions, async (accepted) => {
      await this.executeFileMoves(accepted);
    }).open();
  }

  /**
   * 执行一批 FileMoveAction。
   * - 按需创建中间文件夹
   * - 处理 overwrite（先删旧文件再 rename）
   * - 失败累积报错但不中断后续
   */
  private async executeFileMoves(actions: FileMoveAction[]): Promise<void> {
    if (actions.length === 0) return;

    this.isProcessing = true;
    let moved = 0;
    let failed = 0;
    const errors: string[] = [];

    try {
      for (const action of actions) {
        try {
          // 先保证中间文件夹存在
          for (const dir of collectFoldersToCreate(action.toPath)) {
            const existing = this.app.vault.getAbstractFileByPath(dir);
            if (!existing) {
              await this.app.vault.createFolder(dir);
            }
          }

          const srcFile = this.app.vault.getAbstractFileByPath(action.fromPath);
          if (!(srcFile instanceof TFile)) {
            errors.push(`源文件不存在: ${action.fromPath}`);
            failed++;
            continue;
          }

          // 如果目标路径已有同名文件且用户选 overwrite，先删旧
          if (action.hasNameConflict) {
            const dest = this.app.vault.getAbstractFileByPath(action.toPath);
            if (dest instanceof TFile) {
              await this.app.vault.delete(dest);
            }
          }

          // rename 会自动处理链接更新（Obsidian 内建能力）
          await this.app.fileManager.renameFile(srcFile, action.toPath);
          moved++;
        } catch (e) {
          failed++;
          errors.push(`${action.fromPath}: ${(e as Error).message}`);
          console.error('Atlas: 文件迁移失败', action, e);
        }
      }

      if (failed === 0) {
        new Notice(t('notice.filesMovedOk', { moved }));
      } else {
        new Notice(`${t('notice.filesMovedOk', { moved })}${t('notice.filesMovedFailed', { failed })}`, 8000);
        console.warn('Atlas: 部分迁移失败\n' + errors.join('\n'));
      }
      this.refreshTagMapView();
    } finally {
      this.isProcessing = false;
    }
  }

  // ============================================================
  // 分类 = 文件夹：供 UnifiedOrganizer 在改 schema 时同步文件系统
  // ============================================================

  /**
   * AI 归类完成后可能要触发的"整理到文件夹"副作用。
   * 看 settings.autoOrganizeFilesAfterTagging；开启才跑。
   * 延迟 500ms 让 Obsidian 完成 frontmatter 写入 + metadataCache 解析。
   */
  triggerAutoOrganize(scopeFolderPath?: string | null): void {
    if (!this.settings.autoOrganizeFilesAfterTagging) return;
    setTimeout(() => this.organizeFilesByCategory(scopeFolderPath ?? null), 500);
  }

  /**
   * 确保指定路径的文件夹存在；父级不存在时递归建。
   */
  async ensureFolder(folderPath: string): Promise<void> {
    const parts = folderPath.split('/').filter(Boolean);
    let acc = '';
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(acc)) {
        try {
          await this.app.vault.createFolder(acc);
        } catch (e) {
          // 竞态：另一个地方先建好了，忽略
          if (!this.app.vault.getAbstractFileByPath(acc)) throw e;
        }
      }
    }
  }

  /**
   * 把 oldPath 文件夹重命名（或移动）为 newPath。
   * Obsidian 的 fileManager.renameFile 会自动更新内部链接。
   */
  async renameFolderPath(oldPath: string, newPath: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(oldPath);
    if (!(folder instanceof TFolder)) return;
    if (oldPath === newPath) return;
    // 目标父级确保存在
    const lastSlash = newPath.lastIndexOf('/');
    if (lastSlash > 0) {
      await this.ensureFolder(newPath.slice(0, lastSlash));
    }
    await this.app.fileManager.renameFile(folder, newPath);
  }

  /**
   * 把 folderPath 下所有 md 文件挪到 vault 根，然后删掉（连同空子目录）。
   * 用于"删分类 → 把笔记挪到根 → 清空文件夹"场景。
   */
  async deleteFolderMoveNotesToRoot(folderPath: string): Promise<number> {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return 0;

    // 递归收集所有 md 文件
    const collect = (f: TFolder, acc: TFile[]) => {
      for (const child of f.children) {
        if (child instanceof TFile && child.extension === 'md') acc.push(child);
        else if (child instanceof TFolder) collect(child, acc);
      }
    };
    const files: TFile[] = [];
    collect(folder, files);

    // 移动每个文件到 vault 根（处理同名冲突：加日期后缀）
    let moved = 0;
    for (const file of files) {
      try {
        let targetName = file.name;
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        if (this.app.vault.getAbstractFileByPath(targetName)) {
          const dot = file.name.lastIndexOf('.');
          const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
          const ext = dot > 0 ? file.name.slice(dot) : '';
          targetName = `${stem}-${stamp}${ext}`;
        }
        await this.app.fileManager.renameFile(file, targetName);
        moved++;
      } catch (e) {
        console.error('Atlas: 移动到根失败', file.path, e);
      }
    }

    // 删除空文件夹（递归，Obsidian 允许直接 delete 整个文件夹，现在里面只剩空目录）
    try {
      const stillExists = this.app.vault.getAbstractFileByPath(folderPath);
      if (stillExists instanceof TFolder) {
        await this.app.vault.delete(stillExists, true);  // 第二参force=true 允许非空（但这时应该空了）
      }
    } catch (e) {
      console.error('Atlas: 删除文件夹失败', folderPath, e);
    }

    return moved;
  }

  /**
   * 把 srcFile 移动到 targetFolder 下。targetFolder 不存在自动建。
   * 返回新路径。
   */
  async moveFileToFolder(srcFile: TFile, targetFolder: string): Promise<string> {
    await this.ensureFolder(targetFolder);
    const newPath = `${targetFolder}/${srcFile.name}`;
    if (newPath === srcFile.path) return srcFile.path;

    // 冲突：目标已存在同名 → 加日期后缀
    let finalPath = newPath;
    if (this.app.vault.getAbstractFileByPath(finalPath)) {
      const dot = srcFile.name.lastIndexOf('.');
      const stem = dot > 0 ? srcFile.name.slice(0, dot) : srcFile.name;
      const ext = dot > 0 ? srcFile.name.slice(dot) : '';
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      finalPath = `${targetFolder}/${stem}-${stamp}${ext}`;
    }
    await this.app.fileManager.renameFile(srcFile, finalPath);
    return finalPath;
  }

  async tagSingleFile(file: TFile): Promise<void> {
    if (this.isProcessing) { new Notice(t('notice.processing')); return; }
    if (!this.checkAIConfig()) return;

    this.isProcessing = true;
    try {
      const store = await this.storeManager.load();
      const provider = createAIProvider(this.settings);
      const taxonomy = this.storeManager.getTaxonomy();

      new Notice(t('notice.aiAnalyzing', { name: file.name }));
      const patchList = await generatePatches(this.app, [file], store, provider, this.settings, taxonomy);
      this.isProcessing = false;

      if (patchList.stats.filesWithChanges === 0) { new Notice(t('notice.noChangesForFile', { name: file.name })); return; }

      new PatchReviewModal(this.app, patchList, async (patches, cats) => {
        const result = await applyPatches(this.app, patches, store);
        await this.storeManager.save();
        if (cats.length > 0 && taxonomy) await this.addCategoriesToSchema(taxonomy, cats);
        new Notice(t('notice.fileRecategorized', { name: file.name }));
        this.refreshTagMapView();
        this.triggerAutoOrganize(this.targetFolder);
      }).open();
    } catch (e) {
      this.isProcessing = false;
      new Notice(t('notice.errorGeneric', { error: this.friendlyErrorMessage(e) }), 10000);
    }
  }

  async testAIConnection(): Promise<void> {
    if (!this.checkAIConfig()) throw new Error('AI 配置不完整');
    const provider = createAIProvider(this.settings);
    await provider.testConnection();
  }

  // ---- 辅助 ----

  private async addCategoriesToSchema(
    taxonomy: TaxonomySchema,
    categories: SuggestedCategory[],
  ): Promise<void> {
    const genId = () => Math.random().toString(36).substring(2, 10);

    /**
     * 递归找/建节点：在 children 里找名为 name 的，没有就创建。
     * 返回该节点，用于下一层继续深入。
     */
    const findOrCreate = (
      children: typeof taxonomy.nodes,
      name: string,
      fullPath: string,
    ) => {
      let node = children.find(n => n.name === name);
      if (!node) {
        node = {
          id: genId(),
          name,
          fullPath,
          children: [],
          description: '',
        };
        children.push(node);
      }
      return node;
    };

    // 按路径段逐级建节点：`前端开发/React` → 先建 `前端开发`，再在它 children 里建 `React`
    for (const cat of categories) {
      const parts = cat.path.split('/').filter(Boolean);
      if (parts.length === 0) continue;

      let cursor = taxonomy.nodes;
      let accumulated = '';
      for (const part of parts) {
        accumulated = accumulated ? `${accumulated}/${part}` : part;
        const node = findOrCreate(cursor, part, accumulated);
        cursor = node.children;
      }
    }

    taxonomy.updatedAt = new Date().toISOString();
    await this.storeManager.setTaxonomy(taxonomy);
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

  private showConfirmDialog(title: string, message: string, confirmText?: string, cancelText?: string): Promise<boolean> {
    const confirm = confirmText ?? t('common.confirm');
    const cancel = cancelText ?? t('common.cancel');
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.app, title, message, confirm, cancel, resolve);
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
