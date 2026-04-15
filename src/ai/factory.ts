import { MECESettings } from '../types';
import { AIProvider } from './types';
import { OpenAIProvider } from './providers/openai';
import { OllamaProvider } from './providers/ollama';
import { ClaudeProvider } from './providers/claude';
import { DeepSeekProvider } from './providers/deepseek';

/**
 * 根据设置创建对应的 AI Provider 实例
 */
export function createAIProvider(settings: MECESettings): AIProvider {
  switch (settings.aiProvider) {
    case 'openai': {
      const baseUrl = settings.openaiBaseUrl || 'https://api.openai.com';
      const model = settings.model || 'gpt-4o-mini';
      return new OpenAIProvider(baseUrl, settings.apiKey, model);
    }

    case 'ollama': {
      const host = settings.ollamaHost || 'http://localhost:11434';
      const model = settings.model || 'qwen2.5';
      return new OllamaProvider(host, model);
    }

    case 'claude': {
      const model = settings.model || 'claude-sonnet-4-20250514';
      return new ClaudeProvider(settings.apiKey, model);
    }

    case 'deepseek': {
      const model = settings.model || 'deepseek-chat';
      return new DeepSeekProvider(settings.apiKey, model);
    }

    default:
      throw new Error(`未知的 AI 提供商: ${settings.aiProvider}`);
  }
}
