import { OpenAIProvider } from './openai';

/**
 * DeepSeek Provider — 继承 OpenAI Provider，使用 OpenAI 兼容格式
 * DeepSeek API 完全兼容 OpenAI Chat Completions 接口
 * https://platform.deepseek.com/api-docs
 */
export class DeepSeekProvider extends OpenAIProvider {
  readonly name = 'DeepSeek';

  constructor(apiKey: string, model: string) {
    super('https://api.deepseek.com', apiKey, model);
  }

  async testConnection(): Promise<void> {
    // DeepSeek 兼容 OpenAI /v1/models 端点
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      throw new Error(`DeepSeek 连接失败 (${res.status}): ${await res.text()}`);
    }
  }
}
