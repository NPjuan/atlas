import { OpenAIProvider } from './openai';

/**
 * Ollama Provider — 继承 OpenAI Provider，使用 OpenAI 兼容格式
 * 仅覆写 baseUrl 和认证逻辑（无需 API Key）
 */
export class OllamaProvider extends OpenAIProvider {
  readonly name = 'Ollama';

  constructor(host: string, model: string) {
    // Ollama 的 OpenAI 兼容端点
    super(host, '', model);
  }

  async testConnection(): Promise<void> {
    // Ollama 特有的模型列表端点
    const res = await fetch(`${this.baseUrl}/v1/models`);
    if (!res.ok) {
      throw new Error(`Ollama 连接失败 (${res.status})`);
    }
    const data = await res.json();
    if (!data.data || data.data.length === 0) {
      throw new Error('Ollama 运行中，但未找到已下载的模型');
    }
  }

  protected getHeaders(): Record<string, string> {
    // Ollama 不需要 API Key
    return {
      'Content-Type': 'application/json',
    };
  }
}
