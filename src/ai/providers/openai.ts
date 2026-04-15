import {
  AIProvider,
  ExtractionResult,
  ClassificationResult,
  CategoryTreeSkeleton,
  parseJSON,
} from '../types';
import { buildExtractionPrompt, buildClassificationPrompt } from '../prompts';
import { KnowledgePoint } from '../../types';

/**
 * OpenAI Provider — 使用 Chat Completions API + JSON mode
 * 也是 Ollama Provider 的基类
 */
export class OpenAIProvider implements AIProvider {
  readonly name = 'OpenAI';
  protected baseUrl: string;
  protected apiKey: string;
  protected model: string;

  constructor(baseUrl: string, apiKey: string, model: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
  }

  async testConnection(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      throw new Error(`连接失败 (${res.status}): ${await res.text()}`);
    }
  }

  async extract(chunk: string, sourceFile: string): Promise<ExtractionResult> {
    const prompt = buildExtractionPrompt(chunk, sourceFile);
    const content = await this.chat(prompt);
    const result = parseJSON<ExtractionResult>(content);

    // 校验必要字段
    if (!result.knowledgePoints || !Array.isArray(result.knowledgePoints)) {
      return { knowledgePoints: [] };
    }
    return result;
  }

  async classify(
    knowledgePoints: Pick<KnowledgePoint, 'id' | 'content'>[],
    treeSkeleton: CategoryTreeSkeleton
  ): Promise<ClassificationResult> {
    const prompt = buildClassificationPrompt(knowledgePoints, treeSkeleton);
    const content = await this.chat(prompt);
    const result = parseJSON<ClassificationResult>(content);

    // 校验必要字段
    if (!result.assignments) result.assignments = {};
    if (!result.newNodes) result.newNodes = [];
    return result;
  }

  // ---- 内部方法 ----

  protected async chat(userMessage: string): Promise<string> {
    const body: any = {
      model: this.model,
      messages: [
        {
          role: 'system',
          content: '你是一个精确的知识处理助手。始终返回有效的 JSON，不要包裹在 markdown 代码块中。',
        },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    };

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${this.name} API 错误 (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  protected getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}
