import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type MECEPlugin from './main';
import { AIProviderType, ClassificationMode, SchemaContextMode } from './types';

export class MECESettingTab extends PluginSettingTab {
  plugin: MECEPlugin;

  constructor(app: App, plugin: MECEPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'MECE 知识分类' });

    // ═══════════════════════════════════════════
    // AI 配置
    // ═══════════════════════════════════════════
    containerEl.createEl('h3', { text: 'AI 配置' });

    new Setting(containerEl)
      .setName('AI 提供商')
      .setDesc('选择用于分类和打标签的 AI 服务')
      .addDropdown((dd) =>
        dd
          .addOption('ollama', 'Ollama（本地免费）')
          .addOption('openai', 'OpenAI')
          .addOption('claude', 'Claude')
          .addOption('deepseek', 'DeepSeek')
          .setValue(this.plugin.settings.aiProvider)
          .onChange(async (v) => {
            const prev = this.plugin.settings.aiProvider;
            const next = v as AIProviderType;
            this.plugin.settings.aiProvider = next;
            if (prev !== next) {
              this.plugin.settings.apiKey = '';
              this.plugin.settings.model = '';
            }
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
            .onChange(async (v) => { this.plugin.settings.model = v; await this.plugin.saveSettings(); })
        );
    }

    // OpenAI / Claude / DeepSeek
    if (['openai', 'claude', 'deepseek'].includes(this.plugin.settings.aiProvider)) {
      new Setting(containerEl)
        .setName('API Key')
        .setDesc('填入对应服务的 API 密钥')
        .addText((t) =>
          t.setPlaceholder('sk-...')
            .setValue(this.plugin.settings.apiKey)
            .onChange(async (v) => { this.plugin.settings.apiKey = v; await this.plugin.saveSettings(); })
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
            .onChange(async (v) => { this.plugin.settings.model = v; await this.plugin.saveSettings(); })
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
      .setDesc('AI 打标签时的分类策略')
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
        .setDesc('描述你期望的分类方式，AI 会据此打标签')
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
      .setDesc('为 AI 生成的 tag 添加统一前缀（如 "mece/"），留空不加')
      .addText((t) =>
        t.setPlaceholder('如 mece/')
          .setValue(this.plugin.settings.tagPrefix)
          .onChange(async (v) => { this.plugin.settings.tagPrefix = v; await this.plugin.saveSettings(); })
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
