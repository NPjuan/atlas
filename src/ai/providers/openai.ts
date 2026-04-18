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
 * OpenAI Provider — 也是 Ollama/DeepSeek 的基类
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

  // ---- 开放式打标签（无 Schema） ----

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

  // ---- 约束式打标签（有 Schema） ----

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

  // ---- 生成分类体系 Schema ----

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

  // ---- 底层 Chat ----

  protected async chat(userMessage: string): Promise<string> {
    const body: any = {
      model: this.model,
      messages: [
        {
          role: 'system',
          content: '你是一个精确的知识分类助手。始终返回有效的 JSON，不要包裹在 markdown 代码块中。',
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
