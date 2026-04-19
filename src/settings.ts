import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type MECEPlugin from './main';
import { AIProviderType, ClassificationMode, SchemaContextMode, setApiKey, setModel, switchProvider } from './types';

export class MECESettingTab extends PluginSettingTab {
  plugin: MECEPlugin;

  constructor(app: App, plugin: MECEPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Atlas — AI 知识分类' });

    // ═══════════════════════════════════════════
    // AI 配置
    // ═══════════════════════════════════════════
    containerEl.createEl('h3', { text: 'AI 配置' });

    new Setting(containerEl)
      .setName('AI 提供商')
      .setDesc('选择用于分析和归类的 AI 服务')
      .addDropdown((dd) =>
        dd
          .addOption('ollama', 'Ollama（本地免费）')
          .addOption('openai', 'OpenAI')
          .addOption('claude', 'Claude')
          .addOption('deepseek', 'DeepSeek')
          .setValue(this.plugin.settings.aiProvider)
          .onChange(async (v) => {
            const next = v as AIProviderType;
            // 切 provider 时保留各 provider 的 key/model，只切换"当前选中"
            switchProvider(this.plugin.settings, next);
            await this.plugin.saveSettings();
            this.display();
          })
      );

    // Ollama 专属
    if (this.plugin.settings.aiProvider === 'ollama') {
      new Setting(containerEl)
        .setName('Ollama 地址')
        .setDesc('本地 Ollama 服务地址')
        .addText((t) =>
          t.setPlaceholder('http://localhost:11434')
            .setValue(this.plugin.settings.ollamaHost)
            .onChange(async (v) => { this.plugin.settings.ollamaHost = v; await this.plugin.saveSettings(); })
        );

      new Setting(containerEl)
        .setName('模型名称')
        .setDesc('如 qwen2.5、llama3.1')
        .addText((t) =>
          t.setPlaceholder('qwen2.5')
            .setValue(this.plugin.settings.model)
            .onChange(async (v) => {
              setModel(this.plugin.settings, 'ollama', v);
              await this.plugin.saveSettings();
            })
        );
    }

    // OpenAI / Claude / DeepSeek
    if (['openai', 'claude', 'deepseek'].includes(this.plugin.settings.aiProvider)) {
      const curProvider = this.plugin.settings.aiProvider;
      new Setting(containerEl)
        .setName('API Key')
        .setDesc('填入对应服务的 API 密钥')
        .addText((t) =>
          t.setPlaceholder('sk-...')
            .setValue(this.plugin.settings.apiKey)
            .onChange(async (v) => {
              setApiKey(this.plugin.settings, curProvider, v);
              await this.plugin.saveSettings();
            })
        );

      const hints: Record<string, { desc: string; ph: string }> = {
        openai: { desc: '如 gpt-4o、gpt-4o-mini', ph: 'gpt-4o-mini' },
        claude: { desc: '如 claude-sonnet-4-20250514', ph: 'claude-sonnet-4-20250514' },
        deepseek: { desc: '如 deepseek-chat', ph: 'deepseek-chat' },
      };
      const h = hints[this.plugin.settings.aiProvider];

      new Setting(containerEl)
        .setName('模型名称')
        .setDesc(h?.desc || '')
        .addText((t) =>
          t.setPlaceholder(h?.ph || '')
            .setValue(this.plugin.settings.model)
            .onChange(async (v) => {
              setModel(this.plugin.settings, curProvider, v);
              await this.plugin.saveSettings();
            })
        );
    }

    // OpenAI 自定义 base URL
    if (this.plugin.settings.aiProvider === 'openai') {
      new Setting(containerEl)
        .setName('自定义 API 地址')
        .setDesc('第三方 OpenAI 兼容服务的 base URL（留空使用官方地址）')
        .addText((t) =>
          t.setPlaceholder('https://api.openai.com')
            .setValue(this.plugin.settings.openaiBaseUrl)
            .onChange(async (v) => { this.plugin.settings.openaiBaseUrl = v; await this.plugin.saveSettings(); })
        );
    }

    // 测试连接
    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('验证当前 AI 配置是否可用')
      .addButton((btn) =>
        btn.setButtonText('测试').setCta().onClick(async () => {
          btn.setButtonText('测试中...');
          btn.setDisabled(true);
          try {
            await this.plugin.testAIConnection();
            new Notice('✅ AI 连接成功！');
          } catch (e) {
            new Notice(`❌ 连接失败：${e instanceof Error ? e.message : String(e)}`);
          } finally {
            btn.setButtonText('测试');
            btn.setDisabled(false);
          }
        })
      );

    // ═══════════════════════════════════════════
    // Schema 配置（V3 新增）
    // ═══════════════════════════════════════════
    containerEl.createEl('h3', { text: '分类体系（Schema）' });

    new Setting(containerEl)
      .setName('笔记内容读取模式')
      .setDesc('生成分类体系时，读取每篇笔记的内容范围。「全文」效果最好但消耗更多 token')
      .addDropdown((dd) =>
        dd
          .addOption('full', '全文（推荐）')
          .addOption('first-500', '前 500 字')
          .addOption('title-only', '仅标题')
          .setValue(this.plugin.settings.schemaContextMode)
          .onChange(async (v) => {
            this.plugin.settings.schemaContextMode = v as SchemaContextMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('分类规则')
      .setDesc('AI 归类时采用的分类策略')
      .addDropdown((dd) =>
        dd
          .addOption('mece', 'MECE（互斥穷尽）')
          .addOption('discipline', '学科分类')
          .addOption('custom', '自定义 Prompt')
          .setValue(this.plugin.settings.classificationMode)
          .onChange(async (v) => {
            this.plugin.settings.classificationMode = v as ClassificationMode;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.classificationMode === 'custom') {
      new Setting(containerEl)
        .setName('自定义分类 Prompt')
        .setDesc('描述你期望的分类方式，AI 会据此归类')
        .addTextArea((t) =>
          t.setPlaceholder('例如：按照前端/后端/DevOps 分类...')
            .setValue(this.plugin.settings.customClassificationPrompt)
            .onChange(async (v) => { this.plugin.settings.customClassificationPrompt = v; await this.plugin.saveSettings(); })
        );
    }

    // ═══════════════════════════════════════════
    // 标签配置
    // ═══════════════════════════════════════════
    containerEl.createEl('h3', { text: '标签配置' });

    new Setting(containerEl)
      .setName('每篇笔记最多 Tag 数')
      .setDesc('AI 每次最多为一篇笔记添加的 tag 数量')
      .addSlider((s) =>
        s.setLimits(1, 10, 1)
          .setValue(this.plugin.settings.maxTagsPerFile)
          .setDynamicTooltip()
          .onChange(async (v) => { this.plugin.settings.maxTagsPerFile = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName('Tag 前缀')
      .setDesc('为 AI 生成的 tag 添加统一前缀（如 "atlas/"），留空不加')
      .addText((t) =>
        t.setPlaceholder('如 atlas/')
          .setValue(this.plugin.settings.tagPrefix)
          .onChange(async (v) => { this.plugin.settings.tagPrefix = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName('AI 归类默认强度')
      .setDesc('未分类区「AI 归类」按钮以及重新归类弹窗默认选中的强度')
      .addDropdown((dd) =>
        dd
          .addOption('conservative', '保守 — 尽量保留现有标签')
          .addOption('balanced', '平衡 — 适度调整到更精准分类')
          .addOption('aggressive', '重构 — 忽略现有标签按内容重判')
          .setValue(this.plugin.settings.defaultReorganizeIntensity || 'conservative')
          .onChange(async (v) => {
            this.plugin.settings.defaultReorganizeIntensity = v as any;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('归类策略')
      .setDesc('auto：按能力自动选；sequential：逐篇调用（慢但精准）；batch：批量一次调用（快）')
      .addDropdown((dd) =>
        dd
          .addOption('auto', 'Auto — 自动选择（推荐）')
          .addOption('sequential', 'Sequential — 逐篇')
          .addOption('batch', 'Batch — 批量')
          .setValue(this.plugin.settings.taggingStrategy || 'auto')
          .onChange(async (v) => {
            this.plugin.settings.taggingStrategy = v as any;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('AI 归类后自动整理文件夹')
      .setDesc('归类完成写入 frontmatter 后，自动把笔记文件移动到以 tag 命名的文件夹下（仍有确认弹窗）。关闭则只改 tag，文件保持原位。')
      .addToggle((tg) =>
        tg.setValue(!!this.plugin.settings.autoOrganizeFilesAfterTagging)
          .onChange(async (v) => {
            this.plugin.settings.autoOrganizeFilesAfterTagging = v;
            await this.plugin.saveSettings();
          })
      );

    // ═══════════════════════════════════════════
    // 扫描配置
    // ═══════════════════════════════════════════
    containerEl.createEl('h3', { text: '扫描配置' });

    new Setting(containerEl)
      .setName('排除目录')
      .setDesc('不处理的目录，逗号分隔')
      .addText((t) =>
        t.setPlaceholder('templates, daily, .obsidian')
          .setValue(this.plugin.settings.excludeDirs.join(', '))
          .onChange(async (v) => {
            this.plugin.settings.excludeDirs = v.split(',').map(s => s.trim()).filter(s => s.length > 0);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('大文件跳过阈值（字符数）')
      .setDesc('超过此字数的文件自动跳过')
      .addText((t) =>
        t.setPlaceholder('50000')
          .setValue(String(this.plugin.settings.maxFileCharsSkip))
          .onChange(async (v) => {
            const num = parseInt(v, 10);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.maxFileCharsSkip = num;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}
