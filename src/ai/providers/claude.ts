import {
  AIProvider,
  TaggingResult,
  ConstrainedTaggingResult,
  RawTaxonomyResult,
  parseJSON,
} from '../types';
import {
  buildOpenTaggingPrompt,
  buildConstrainedTaggingPrompt,
  buildSchemaGenerationPrompt,
} from '../prompts';
import type { ClassificationMode, TaxonomySchema, NoteOverview } from '../../types';

/**
 * Claude Provider — Anthropic Messages API
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

  async suggestTags(
    content: string,
    sourceFile: string,
    existingTags: string[],
    vaultTags: string[],
    mode: ClassificationMode,
    maxTags: number,
    customPrompt?: string,
  ): Promise<TaggingResult> {
    const prompt = buildOpenTaggingPrompt(content, sourceFile, existingTags, vaultTags, mode, maxTags, customPrompt);
    const raw = await this.chat(prompt);
    const result = parseJSON<any>(raw);

    const tags = result.tags || result.newTags || [];
    if (!Array.isArray(tags)) return { tags: [] };

    return {
      tags: tags.filter((t: any) => typeof t === 'string' && t.trim().length > 0).map((t: string) => t.trim()),
    };
  }

  async suggestTagsConstrained(
    content: string,
    sourceFile: string,
    existingTags: string[],
    taxonomy: TaxonomySchema,
    maxTags: number,
  ): Promise<ConstrainedTaggingResult> {
    const prompt = buildConstrainedTaggingPrompt(content, sourceFile, existingTags, taxonomy, maxTags);
    const raw = await this.chat(prompt);
    const result = parseJSON<any>(raw);

    const tags = Array.isArray(result.tags) ? result.tags : [];
    const newCategories = Array.isArray(result.newCategories) ? result.newCategories : [];

    return {
      tags: tags.filter((t: any) => typeof t === 'string' && t.trim()).map((t: string) => t.trim()),
      newCategories: newCategories.filter((t: any) => typeof t === 'string' && t.trim()).map((t: string) => t.trim()),
    };
  }

  async generateTaxonomy(
    notes: NoteOverview[],
    maxDepth: number,
    classificationMode: ClassificationMode,
    customPrompt?: string,
  ): Promise<RawTaxonomyResult> {
    const prompt = buildSchemaGenerationPrompt(notes, maxDepth, classificationMode, customPrompt);
    const raw = await this.chat(prompt);
    const result = parseJSON<any>(raw);

    if (!result.taxonomy || !Array.isArray(result.taxonomy)) {
      throw new Error('AI 返回的分类体系格式不正确：缺少 taxonomy 数组');
    }

    return result as RawTaxonomyResult;
  }

  private async chat(userMessage: string): Promise<string> {
    const body = {
      model: this.model,
      max_tokens: 8192,
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
