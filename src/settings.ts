import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type MECEPlugin from './main';
import { AIProviderType } from './types';

export class MECESettingTab extends PluginSettingTab {
  plugin: MECEPlugin;

  constructor(app: App, plugin: MECEPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'MECE 知识聚合思维导图' });

    // ---- AI 提供商 ----
    containerEl.createEl('h3', { text: 'AI 配置' });

    new Setting(containerEl)
      .setName('AI 提供商')
      .setDesc('选择用于知识提取和分类的 AI 服务')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('ollama', 'Ollama（本地免费）')
          .addOption('openai', 'OpenAI')
          .addOption('claude', 'Claude')
          .addOption('deepseek', 'DeepSeek')
          .setValue(this.plugin.settings.aiProvider)
          .onChange(async (value) => {
            this.plugin.settings.aiProvider = value as AIProviderType;
            await this.plugin.saveSettings();
            // 重绘以显示/隐藏对应字段
            this.display();
          })
      );

    // Ollama 专属设置
    if (this.plugin.settings.aiProvider === 'ollama') {
      new Setting(containerEl)
        .setName('Ollama 地址')
        .setDesc('本地 Ollama 服务地址')
        .addText((text) =>
          text
            .setPlaceholder('http://localhost:11434')
            .setValue(this.plugin.settings.ollamaHost)
            .onChange(async (value) => {
              this.plugin.settings.ollamaHost = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName('模型名称')
        .setDesc('Ollama 中已下载的模型名，如 qwen2.5、llama3.1')
        .addText((text) =>
          text
            .setPlaceholder('qwen2.5')
            .setValue(this.plugin.settings.model)
            .onChange(async (value) => {
              this.plugin.settings.model = value;
              await this.plugin.saveSettings();
            })
        );
    }

    // OpenAI / Claude / DeepSeek 通用设置
    if (
      this.plugin.settings.aiProvider === 'openai' ||
      this.plugin.settings.aiProvider === 'claude' ||
      this.plugin.settings.aiProvider === 'deepseek'
    ) {
      new Setting(containerEl)
        .setName('API Key')
        .setDesc('填入对应服务的 API 密钥')
        .addText((text) =>
          text
            .setPlaceholder('sk-...')
            .setValue(this.plugin.settings.apiKey)
            .onChange(async (value) => {
              this.plugin.settings.apiKey = value;
              await this.plugin.saveSettings();
            })
        );

      const modelHints: Record<string, { desc: string; placeholder: string }> = {
        openai: { desc: '如 gpt-4o、gpt-4o-mini', placeholder: 'gpt-4o-mini' },
        claude: { desc: '如 claude-sonnet-4-20250514', placeholder: 'claude-sonnet-4-20250514' },
        deepseek: { desc: '如 deepseek-chat、deepseek-reasoner', placeholder: 'deepseek-chat' },
      };
      const hint = modelHints[this.plugin.settings.aiProvider];

      new Setting(containerEl)
        .setName('模型名称')
        .setDesc(hint.desc)
        .addText((text) =>
          text
            .setPlaceholder(hint.placeholder)
            .setValue(this.plugin.settings.model)
            .onChange(async (value) => {
              this.plugin.settings.model = value;
              await this.plugin.saveSettings();
            })
        );
    }

    // OpenAI 自定义 base URL
    if (this.plugin.settings.aiProvider === 'openai') {
      new Setting(containerEl)
        .setName('自定义 API 地址')
        .setDesc('如使用 OpenAI 兼容的第三方服务，填入其 base URL（留空使用官方地址）')
        .addText((text) =>
          text
            .setPlaceholder('https://api.openai.com')
            .setValue(this.plugin.settings.openaiBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.openaiBaseUrl = value;
              await this.plugin.saveSettings();
            })
        );
    }

    // 测试连接按钮
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

    // ---- 扫描设置 ----
    containerEl.createEl('h3', { text: '扫描配置' });

    new Setting(containerEl)
      .setName('排除目录')
      .setDesc('不扫描的目录，逗号分隔（如 templates, daily, .obsidian）')
      .addText((text) =>
        text
          .setPlaceholder('templates, daily, .obsidian')
          .setValue(this.plugin.settings.excludeDirs.join(', '))
          .onChange(async (value) => {
            this.plugin.settings.excludeDirs = value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('大文件警告阈值（字符数）')
      .setDesc('超过此字数的文件会在扫描时警告')
      .addText((text) =>
        text
          .setPlaceholder('20000')
          .setValue(String(this.plugin.settings.maxFileCharsWarn))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.maxFileCharsWarn = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName('大文件跳过阈值（字符数）')
      .setDesc('超过此字数的文件会自动跳过处理')
      .addText((text) =>
        text
          .setPlaceholder('50000')
          .setValue(String(this.plugin.settings.maxFileCharsSkip))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.maxFileCharsSkip = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName('最大并发请求数')
      .setDesc('同时向 AI 发送的最大请求数（建议 1~5）')
      .addSlider((slider) =>
        slider
          .setLimits(1, 5, 1)
          .setValue(this.plugin.settings.maxConcurrency)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxConcurrency = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
