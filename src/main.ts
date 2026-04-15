import { Plugin, Notice, WorkspaceLeaf, TFile, debounce } from 'obsidian';
import { MECESettings, DEFAULT_SETTINGS, KnowledgeStore, CategoryNode } from './types';
import { MECESettingTab } from './settings';
import { MindMapView, MIND_MAP_VIEW_TYPE } from './views/MindMapView';
import { KnowledgeStoreManager } from './core/store';
import { createAIProvider } from './ai/factory';
import { scanVault, cleanOrphans } from './core/scanner';
import { extractKnowledge } from './core/extractor';
import { classifyKnowledge } from './core/categorizer';
import { ProgressModal } from './ui/progress-modal';

export default class MECEPlugin extends Plugin {
  settings!: MECESettings;
  storeManager!: KnowledgeStoreManager;
  private isProcessing = false;
  private fileChangeNotified = false;

  async onload(): Promise<void> {
    console.log('MECE Knowledge Mind Map: loading plugin');

    await this.loadSettings();
    this.storeManager = new KnowledgeStoreManager(this);

    // 注册视图
    this.registerView(MIND_MAP_VIEW_TYPE, (leaf) => new MindMapView(leaf, this));

    // Ribbon 图标
    this.addRibbonIcon('git-fork', '打开 MECE 知识导图', () => {
      this.activateMindMapView();
    });

    // 命令面板
    this.addCommand({
      id: 'open-mind-map',
      name: '打开知识导图',
      callback: () => this.activateMindMapView(),
    });

    this.addCommand({
      id: 'scan-vault',
      name: '扫描 Vault — 提取知识点',
      callback: () => this.startScan(),
    });

    this.addCommand({
      id: 'classify-knowledge',
      name: 'MECE 分类知识点',
      callback: () => this.startClassify(),
    });

    this.addCommand({
      id: 'full-pipeline',
      name: '完整处理（扫描 + 分类）',
      callback: () => this.startFullPipeline(),
    });

    this.addCommand({
      id: 'export-markdown',
      name: '导出分类结果为 Markdown',
      callback: () => this.exportToMarkdown(),
    });

    this.addCommand({
      id: 'reset-store',
      name: '重置知识库',
      callback: async () => {
        await this.storeManager.reset();
        new Notice('知识库已重置');
      },
    });

    this.addSettingTab(new MECESettingTab(this.app, this));

    // ---- 文件变化监听 ----
    const debouncedNotify = debounce(() => {
      if (!this.fileChangeNotified && !this.isProcessing) {
        this.fileChangeNotified = true;
        new Notice('📝 检测到文件变化，可执行「扫描 Vault」更新知识库', 5000);
        // 30 秒内不重复提示
        setTimeout(() => {
          this.fileChangeNotified = false;
        }, 30000);
      }
    }, 5000, true);

    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        debouncedNotify();
      }
    }));

    this.registerEvent(this.app.vault.on('create', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        debouncedNotify();
      }
    }));

    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        debouncedNotify();
      }
    }));

    this.registerEvent(this.app.vault.on('rename', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        debouncedNotify();
      }
    }));

    // ---- 右键菜单 ----
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && file.extension === 'md') {
          menu.addItem((item) => {
            item
              .setTitle('MECE：扫描此文件')
              .setIcon('git-fork')
              .onClick(async () => {
                await this.scanSingleFile(file);
              });
          });
        }
      })
    );

    console.log('MECE Knowledge Mind Map: plugin loaded');
  }

  onunload(): void {
    console.log('MECE Knowledge Mind Map: unloading plugin');
  }

  // ---- 设置读写 ----

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings || {});
  }

  async saveSettings(): Promise<void> {
    const store = this.storeManager?.get();
    if (store) {
      await this.saveData({ ...store, settings: this.settings });
    } else {
      const raw = (await this.loadData()) || {};
      raw.settings = this.settings;
      await this.saveData(raw);
    }
  }

  // ---- Store 快捷方法 ----

  async loadStore(): Promise<KnowledgeStore> {
    return await this.storeManager.load();
  }

  // ---- 视图管理 ----

  async activateMindMapView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(MIND_MAP_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: MIND_MAP_VIEW_TYPE, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  // ---- 核心流程 ----

  async startScan(): Promise<void> {
    if (this.isProcessing) {
      new Notice('正在处理中，请稍候...');
      return;
    }

    this.isProcessing = true;
    const modal = new ProgressModal(this.app, () => {
      this.isProcessing = false;
    });
    modal.open();

    try {
      const store = await this.storeManager.load();
      const provider = createAIProvider(this.settings);

      // 1. 扫描
      modal.update({ phase: 'scanning', current: 0, total: 0, message: '扫描文件中...' });
      const scanResult = await scanVault(this.app.vault, store, this.settings);

      // 处理孤儿
      if (scanResult.orphanPaths.length > 0) {
        const removed = cleanOrphans(store, scanResult.orphanPaths);
        new Notice(`🧹 清理了 ${scanResult.orphanPaths.length} 个已删除文件的 ${removed} 条孤儿知识点`);
      }

      // 处理跳过的大文件
      for (const skipped of scanResult.skippedFiles) {
        new Notice(`⚠️ ${skipped.reason}`);
      }

      const filesToProcess = [...scanResult.changedFiles, ...scanResult.partialFiles];
      if (filesToProcess.length === 0) {
        new Notice('✅ 无新增或修改的文件，知识库已是最新');
        modal.close();
        this.isProcessing = false;
        return;
      }

      new Notice(`📄 发现 ${filesToProcess.length} 个待处理文件`);

      // 2. 提取知识点
      const extracted = await extractKnowledge(
        this.app.vault,
        filesToProcess,
        store,
        this.storeManager,
        provider,
        this.settings,
        {
          onProgress: (p) => modal.update(p),
          isCancelled: () => modal.isCancelled(),
        }
      );

      await this.storeManager.save();
      modal.close();
      this.isProcessing = false;

      new Notice(`✅ 扫描完成！提取了 ${extracted} 个知识点`);
    } catch (e) {
      modal.close();
      this.isProcessing = false;
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`❌ 扫描出错：${msg}`);
      console.error('MECE scan error:', e);
    }
  }

  async startClassify(): Promise<void> {
    if (this.isProcessing) {
      new Notice('正在处理中，请稍候...');
      return;
    }

    this.isProcessing = true;
    const modal = new ProgressModal(this.app, () => {
      this.isProcessing = false;
    });
    modal.open();

    try {
      const store = await this.storeManager.load();
      const provider = createAIProvider(this.settings);

      const unclassifiedCount = store.knowledgePoints.filter((kp) => !kp.classified).length;
      if (unclassifiedCount === 0) {
        new Notice('✅ 所有知识点已完成分类');
        modal.close();
        this.isProcessing = false;
        return;
      }

      new Notice(`🏷️ 开始分类 ${unclassifiedCount} 个知识点`);

      const classified = await classifyKnowledge(store, this.storeManager, provider, {
        onProgress: (p) => modal.update(p),
        isCancelled: () => modal.isCancelled(),
      });

      await this.storeManager.save();
      modal.close();
      this.isProcessing = false;

      new Notice(`✅ 分类完成！${classified} 个知识点已归类`);

      // 刷新思维导图
      this.refreshMindMapView();
    } catch (e) {
      modal.close();
      this.isProcessing = false;
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`❌ 分类出错：${msg}`);
      console.error('MECE classify error:', e);
    }
  }

  async startFullPipeline(): Promise<void> {
    await this.startScan();
    if (!this.isProcessing) {
      await this.startClassify();
    }
  }

  /** 刷新思维导图视图 */
  private refreshMindMapView(): void {
    const leaves = this.app.workspace.getLeavesOfType(MIND_MAP_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MindMapView) {
        view.onOpen();
      }
    }
  }

  // ---- AI 测试 ----

  async testAIConnection(): Promise<void> {
    const provider = createAIProvider(this.settings);
    await provider.testConnection();
  }

  // ---- 单文件扫描 ----

  async scanSingleFile(file: TFile): Promise<void> {
    if (this.isProcessing) {
      new Notice('正在处理中，请稍候...');
      return;
    }

    this.isProcessing = true;
    try {
      const store = await this.storeManager.load();
      const provider = createAIProvider(this.settings);

      new Notice(`📄 开始处理：${file.path}`);

      const extracted = await extractKnowledge(
        this.app.vault,
        [file],
        store,
        this.storeManager,
        provider,
        this.settings,
      );

      await this.storeManager.save();
      new Notice(`✅ 完成！从 ${file.path} 提取了 ${extracted} 个知识点`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`❌ 处理出错：${msg}`);
    } finally {
      this.isProcessing = false;
    }
  }

  // ---- 导出 Markdown ----

  async exportToMarkdown(): Promise<void> {
    try {
      const store = await this.storeManager.load();
      if (store.knowledgePoints.length === 0) {
        new Notice('知识库为空，无法导出');
        return;
      }

      const md = this.buildExportMarkdown(store);
      const fileName = `MECE-知识分类导出.md`;

      // 写入 Vault 根目录
      const existing = this.app.vault.getAbstractFileByPath(fileName);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, md);
      } else {
        await this.app.vault.create(fileName, md);
      }

      new Notice(`✅ 已导出到 ${fileName}`);

      // 自动打开
      const file = this.app.vault.getAbstractFileByPath(fileName);
      if (file instanceof TFile) {
        await this.app.workspace.openLinkText(fileName, '', false);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`❌ 导出出错：${msg}`);
    }
  }

  private buildExportMarkdown(store: KnowledgeStore): string {
    const lines: string[] = [];
    lines.push('# MECE 知识分类导出');
    lines.push('');
    lines.push(`> 生成时间：${new Date().toLocaleString('zh-CN')}`);
    lines.push(`> 知识点总数：${store.knowledgePoints.length}`);
    lines.push('');

    const kpMap = new Map(store.knowledgePoints.map((kp) => [kp.id, kp]));

    const renderNode = (node: CategoryNode, depth: number) => {
      const prefix = '#'.repeat(Math.min(depth + 1, 6));
      lines.push(`${prefix} ${node.name}`);
      lines.push('');

      // 输出关联的知识点
      if (node.knowledgePointIds.length > 0) {
        for (const kpId of node.knowledgePointIds) {
          const kp = kpMap.get(kpId);
          if (kp) {
            lines.push(`- **${kp.content}**`);
            if (kp.sourceQuote) {
              lines.push(`  > ${kp.sourceQuote}`);
            }
            lines.push(`  - 来源：[[${kp.sourceFile}]]`);
            lines.push('');
          }
        }
      }

      // 递归子节点
      for (const child of node.children) {
        renderNode(child, depth + 1);
      }
    };

    for (const theme of store.categoryTree.children) {
      renderNode(theme, 1);
    }

    // 未分类的知识点
    const unclassified = store.knowledgePoints.filter((kp) => !kp.classified);
    if (unclassified.length > 0) {
      lines.push('## 未分类知识点');
      lines.push('');
      for (const kp of unclassified) {
        lines.push(`- ${kp.content}`);
        lines.push(`  - 来源：[[${kp.sourceFile}]]`);
        lines.push('');
      }
    }

    return lines.join('\n');
  }
}
