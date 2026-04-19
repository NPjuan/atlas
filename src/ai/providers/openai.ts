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
    intensity?: import('../prompts').ReorganizeIntensity,
    pendingNewCategories?: string[],
  ): Promise<ConstrainedTaggingResult> {
    const prompt = buildConstrainedTaggingPrompt(content, sourceFile, existingTags, taxonomy, maxTags, intensity, pendingNewCategories);
    const raw = await this.chat(prompt);
    const result = parseJSON<any>(raw);

    // 新 prompt 只让 AI 返回 paths 单字段；后端按 taxonomy 自动分流
    // 兼容旧格式：如果没有 paths 字段，回退读 tags + newCategories（向后兼容）
    const rawPaths: unknown = Array.isArray(result?.paths)
      ? result.paths
      : [
          ...(Array.isArray(result?.tags) ? result.tags : []),
          ...(Array.isArray(result?.newCategories) ? result.newCategories : []),
        ];
    const pathList = (rawPaths as unknown[])
      .filter((t): t is string => typeof t === 'string' && !!t.trim())
      .map(t => t.trim());

    const existingPaths = collectTaxonomyPathSet(taxonomy);
    return splitPaths(pathList, existingPaths);
  }

  // ---- 批量约束式打标签 ----

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
    console.debug('[Atlas openai batch] raw response:', raw.slice(0, 2000));
    const result = parseJSON<any>(raw);
    const rawArr: any[] = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];

    const existingPaths = collectTaxonomyPathSet(taxonomy);

    const items = rawArr
      .map((it: any) => {
        const file = typeof it?.file === 'string' ? it.file : '';
        // 优先读 paths；兼容旧格式（tags + newCategories 合并）
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

  // ---- 批量摘要 ----

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

  // ---- 顶层规划 ----

  async planTaxonomyTopics(
    inputs: PlanTopicsInputItem[],
    folderHints?: string[],
    existingTopics?: string[],
  ): Promise<PlanTopicsResult> {
    const prompt = buildPlanTopicsPrompt(inputs, folderHints, existingTopics);
    const raw = await this.chat(prompt);
    console.debug('[Atlas plan-topics] raw response:', raw.slice(0, 2000));
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
          content: '你是一个精确的知识分类助手。始终返回有效的 JSON 对象，不要包裹在 markdown 代码块中。',
        },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    };

    // 超时保护：单次调用 120s 还没返回就 abort，避免 DeepSeek/Ollama 卡死
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if ((e as any)?.name === 'AbortError') {
        throw new Error(`${this.name} API 超时（120s 未返回），请检查网络或减少批量大小`);
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }

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
