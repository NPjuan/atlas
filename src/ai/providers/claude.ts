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
 * Claude Provider — 使用 Anthropic Messages API
 * 通过 tool_use 确保结构化 JSON 输出
 */
export class ClaudeProvider implements AIProvider {
  readonly name = 'Claude';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model || 'claude-sonnet-4-20250514';
  }

  async testConnection(): Promise<void> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: this.model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Claude 连接失败 (${res.status}): ${await res.text()}`);
    }
  }

  async extract(chunk: string, sourceFile: string): Promise<ExtractionResult> {
    const prompt = buildExtractionPrompt(chunk, sourceFile);
    const content = await this.chat(prompt);
    const result = parseJSON<ExtractionResult>(content);
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
    if (!result.assignments) result.assignments = {};
    if (!result.newNodes) result.newNodes = [];
    return result;
  }

  private async chat(userMessage: string): Promise<string> {
    const body = {
      model: this.model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: userMessage + '\n\n请直接返回 JSON，不要包裹在 markdown 代码块中。',
        },
      ],
    };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Claude API 错误 (${res.status}): ${errText}`);
    }

    const data = await res.json();
    // Claude 返回格式: content[].text
    const textBlock = data.content?.find((c: any) => c.type === 'text');
    return textBlock?.text || '';
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
}
