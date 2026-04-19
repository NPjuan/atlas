import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type MECEPlugin from './main';
import { AIProviderType, ClassificationMode, SchemaContextMode, setApiKey, setModel, switchProvider } from './types';
import { t, setLocale, resolveLocale } from './i18n';

export class MECESettingTab extends PluginSettingTab {
  plugin: MECEPlugin;

  constructor(app: App, plugin: MECEPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: t('settings.title') });

    // ═══════════════════════════════════════════
    // 界面语言（放最前，改完立刻影响下面其他字段的文案）
    // ═══════════════════════════════════════════
    new Setting(containerEl)
      .setName(t('settings.language'))
      .addDropdown((dd) =>
        dd
          .addOption('auto', t('settings.languageAuto'))
          .addOption('zh', t('settings.languageZh'))
          .addOption('en', t('settings.languageEn'))
          .setValue(this.plugin.settings.language)
          .onChange(async (v) => {
            this.plugin.settings.language = v as 'auto' | 'zh' | 'en';
            await this.plugin.saveSettings();
            setLocale(resolveLocale(this.plugin.settings.language));
            this.display();
          }),
      );

    // ═══════════════════════════════════════════
    // AI 配置
    // ═══════════════════════════════════════════
    containerEl.createEl('h3', { text: t('settings.sectionAI') });

    new Setting(containerEl)
      .setName(t('settings.aiProvider'))
      .setDesc(t('settings.aiProviderDesc'))
      .addDropdown((dd) =>
        dd
          .addOption('ollama', t('settings.providerOllama'))
          .addOption('openai', t('settings.providerOpenAI'))
          .addOption('claude', t('settings.providerClaude'))
          .addOption('deepseek', t('settings.providerDeepSeek'))
          .setValue(this.plugin.settings.aiProvider)
          .onChange(async (v) => {
            const next = v as AIProviderType;
            switchProvider(this.plugin.settings, next);
            await this.plugin.saveSettings();
            this.display();
          })
      );

    // Ollama 专属
    if (this.plugin.settings.aiProvider === 'ollama') {
      new Setting(containerEl)
        .setName(t('settings.ollamaHost'))
        .setDesc(t('settings.ollamaHostDesc'))
        .addText((input) =>
          input.setPlaceholder('http://localhost:11434')
            .setValue(this.plugin.settings.ollamaHost)
            .onChange(async (v) => { this.plugin.settings.ollamaHost = v; await this.plugin.saveSettings(); })
        );

      new Setting(containerEl)
        .setName(t('settings.model'))
        .setDesc(t('settings.modelDesc'))
        .addText((input) =>
          input.setPlaceholder('qwen2.5')
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
        .setName(t('settings.apiKey'))
        .setDesc(t('settings.apiKeyDesc'))
        .addText((input) =>
          input.setPlaceholder(t('settings.apiKeyPlaceholder'))
            .setValue(this.plugin.settings.apiKey)
            .onChange(async (v) => {
              setApiKey(this.plugin.settings, curProvider, v);
              await this.plugin.saveSettings();
            })
        );

      const placeholders: Record<string, string> = {
        openai: 'gpt-4o-mini',
        claude: 'claude-sonnet-4-20250514',
        deepseek: 'deepseek-chat',
      };

      new Setting(containerEl)
        .setName(t('settings.model'))
        .setDesc(t('settings.modelDesc'))
        .addText((input) =>
          input.setPlaceholder(placeholders[this.plugin.settings.aiProvider] || '')
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
        .setName(t('settings.openaiBaseUrl'))
        .setDesc(t('settings.openaiBaseUrlDesc'))
        .addText((input) =>
          input.setPlaceholder('https://api.openai.com')
            .setValue(this.plugin.settings.openaiBaseUrl)
            .onChange(async (v) => { this.plugin.settings.openaiBaseUrl = v; await this.plugin.saveSettings(); })
        );
    }

    // 测试连接
    new Setting(containerEl)
      .setName(t('settings.testConnection'))
      .addButton((btn) =>
        btn.setButtonText(t('settings.testConnection')).setCta().onClick(async () => {
          btn.setButtonText(t('settings.testing'));
          btn.setDisabled(true);
          try {
            await this.plugin.testAIConnection();
            new Notice(t('settings.testSuccess'));
          } catch (e) {
            new Notice(t('settings.testFailed', { error: e instanceof Error ? e.message : String(e) }));
          } finally {
            btn.setButtonText(t('settings.testConnection'));
            btn.setDisabled(false);
          }
        })
      );

    // ═══════════════════════════════════════════
    // 分类体系
    // ═══════════════════════════════════════════
    containerEl.createEl('h3', { text: t('settings.sectionSchema') });

    new Setting(containerEl)
      .setName(t('settings.schemaContext'))
      .setDesc(t('settings.schemaContextDesc'))
      .addDropdown((dd) =>
        dd
          .addOption('full', t('settings.schemaContextFull'))
          .addOption('first-500', t('settings.schemaContextFirst500'))
          .addOption('title-only', t('settings.schemaContextTitleOnly'))
          .setValue(this.plugin.settings.schemaContextMode)
          .onChange(async (v) => {
            this.plugin.settings.schemaContextMode = v as SchemaContextMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.classificationMode'))
      .setDesc(t('settings.classificationModeDesc'))
      .addDropdown((dd) =>
        dd
          .addOption('mece', t('settings.modeMECE'))
          .addOption('discipline', t('settings.modeDiscipline'))
          .addOption('custom', t('settings.modeCustom'))
          .setValue(this.plugin.settings.classificationMode)
          .onChange(async (v) => {
            this.plugin.settings.classificationMode = v as ClassificationMode;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.classificationMode === 'custom') {
      new Setting(containerEl)
        .setName(t('settings.customPrompt'))
        .addTextArea((input) =>
          input.setPlaceholder(t('settings.customPromptPlaceholder'))
            .setValue(this.plugin.settings.customClassificationPrompt)
            .onChange(async (v) => { this.plugin.settings.customClassificationPrompt = v; await this.plugin.saveSettings(); })
        );
    }

    // ═══════════════════════════════════════════
    // 标签
    // ═══════════════════════════════════════════
    containerEl.createEl('h3', { text: t('settings.sectionTagging') });

    new Setting(containerEl)
      .setName(t('settings.maxTagsPerFile'))
      .setDesc(t('settings.maxTagsPerFileDesc'))
      .addSlider((s) =>
        s.setLimits(1, 10, 1)
          .setValue(this.plugin.settings.maxTagsPerFile)
          .setDynamicTooltip()
          .onChange(async (v) => { this.plugin.settings.maxTagsPerFile = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName(t('settings.tagPrefixName'))
      .setDesc(t('settings.tagPrefixDesc'))
      .addText((input) =>
        input.setPlaceholder(t('settings.tagPrefixPlaceholder'))
          .setValue(this.plugin.settings.tagPrefix)
          .onChange(async (v) => { this.plugin.settings.tagPrefix = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName(t('settings.defaultIntensity'))
      .setDesc(t('settings.defaultIntensityDesc'))
      .addDropdown((dd) =>
        dd
          .addOption('conservative', t('settings.intensityConservative'))
          .addOption('balanced', t('settings.intensityBalanced'))
          .addOption('aggressive', t('settings.intensityAggressive'))
          .setValue(this.plugin.settings.defaultReorganizeIntensity || 'conservative')
          .onChange(async (v) => {
            this.plugin.settings.defaultReorganizeIntensity = v as any;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.taggingStrategy'))
      .setDesc(t('settings.taggingStrategyDesc'))
      .addDropdown((dd) =>
        dd
          .addOption('auto', t('settings.strategyAuto'))
          .addOption('sequential', t('settings.strategySequential'))
          .addOption('batch', t('settings.strategyBatch'))
          .setValue(this.plugin.settings.taggingStrategy || 'auto')
          .onChange(async (v) => {
            this.plugin.settings.taggingStrategy = v as any;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.autoOrganize'))
      .setDesc(t('settings.autoOrganizeDesc'))
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
    containerEl.createEl('h3', { text: t('settings.sectionScan') });

    new Setting(containerEl)
      .setName(t('settings.excludeDirs'))
      .setDesc(t('settings.excludeDirsDesc'))
      .addText((input) =>
        input.setPlaceholder('templates, daily, .obsidian, attachments')
          .setValue(this.plugin.settings.excludeDirs.join(', '))
          .onChange(async (v) => {
            this.plugin.settings.excludeDirs = v.split(',').map(s => s.trim()).filter(s => s.length > 0);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.maxFileChars'))
      .setDesc(t('settings.maxFileCharsDesc'))
      .addText((input) =>
        input.setPlaceholder('50000')
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
