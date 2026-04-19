import {
  AIProvider,
  TaggingResult,
  ConstrainedTaggingResult,
  BatchConstrainedTaggingResult,
  BatchTaggingInput,
  SummaryBatchInputItem,
  SummaryBatchResult,
  PlanTopicsInputItem,
  PlanTopicsResult,
  RawTaxonomyResult,
  parseJSON,
  collectTaxonomyPathSet,
  splitPaths,
} from '../types';
import {
  buildOpenTaggingPrompt,
  buildConstrainedTaggingPrompt,
  buildBatchConstrainedTaggingPrompt,
  buildSummaryBatchPrompt,
  buildPlanTopicsPrompt,
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
    intensity?: import('../prompts').ReorganizeIntensity,
    pendingNewCategories?: string[],
  ): Promise<ConstrainedTaggingResult> {
    const prompt = buildConstrainedTaggingPrompt(content, sourceFile, existingTags, taxonomy, maxTags, intensity, pendingNewCategories);
    const raw = await this.chat(prompt);
    const result = parseJSON<any>(raw);

    const rawPaths: unknown[] = Array.isArray(result?.paths)
      ? result.paths
      : [
          ...(Array.isArray(result?.tags) ? result.tags : []),
          ...(Array.isArray(result?.newCategories) ? result.newCategories : []),
        ];
    const pathList = rawPaths
      .filter((t): t is string => typeof t === 'string' && !!t.trim())
      .map(t => t.trim());

    const existingPaths = collectTaxonomyPathSet(taxonomy);
    return splitPaths(pathList, existingPaths);
  }

  async suggestTagsConstrainedBatch(
    inputs: BatchTaggingInput[],
    taxonomy: TaxonomySchema,
    maxTags: number,
    intensity?: import('../prompts').ReorganizeIntensity,
    pendingNewCategories?: string[],
    plannedTopics?: Array<{ name: string; description?: string }>,
  ): Promise<BatchConstrainedTaggingResult> {
    const prompt = buildBatchConstrainedTaggingPrompt(
      inputs, taxonomy, maxTags, intensity, 1500, pendingNewCategories, plannedTopics,
    );
    const raw = await this.chat(prompt);
    const result = parseJSON<any>(raw);
    const rawArr: any[] = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];

    const existingPaths = collectTaxonomyPathSet(taxonomy);

    const items = rawArr
      .map((it: any) => {
        const file = typeof it?.file === 'string' ? it.file : '';
        const rawPaths: unknown[] = Array.isArray(it?.paths)
          ? it.paths
          : [
              ...(Array.isArray(it?.tags) ? it.tags : []),
              ...(Array.isArray(it?.newCategories) ? it.newCategories : []),
            ];
        const pathList = rawPaths
          .filter((t): t is string => typeof t === 'string' && !!t.trim())
          .map(t => t.trim());
        const { tags, newCategories } = splitPaths(pathList, existingPaths);
        return { file, tags, newCategories };
      })
      .filter(it => it.file);

    return { items };
  }

  async summarizeBatch(inputs: SummaryBatchInputItem[]): Promise<SummaryBatchResult> {
    const prompt = buildSummaryBatchPrompt(inputs);
    const raw = await this.chat(prompt);
    const result = parseJSON<any>(raw);
    const rawArr: any[] = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];
    const items = rawArr
      .map((it: any) => ({
        file: typeof it?.file === 'string' ? it.file : '',
        summary: typeof it?.summary === 'string' ? it.summary.trim() : '',
      }))
      .filter(it => it.file && it.summary);
    return { items };
  }

  async planTaxonomyTopics(
    inputs: PlanTopicsInputItem[],
    folderHints?: string[],
    existingTopics?: string[],
  ): Promise<PlanTopicsResult> {
    const prompt = buildPlanTopicsPrompt(inputs, folderHints, existingTopics);
    const raw = await this.chat(prompt);
    const result = parseJSON<any>(raw);
    const rawArr: any[] = Array.isArray(result?.topics) ? result.topics : [];
    const topics = rawArr
      .map((it: any) => ({
        name: typeof it?.name === 'string' ? it.name.trim() : '',
        description: typeof it?.description === 'string' ? it.description.trim() : '',
        files: Array.isArray(it?.files)
          ? it.files.filter((f: any) => typeof f === 'string' && f.trim()).map((f: string) => f.trim())
          : [],
      }))
      .filter((t: { name: string }) => t.name);
    return { topics };
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    let res: Response;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if ((e as any)?.name === 'AbortError') {
        throw new Error('Claude API 超时（120s 未返回），请检查网络或减少批量大小');
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }

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
