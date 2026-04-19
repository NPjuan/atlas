/**
 * Batch 策略：一次把多篇笔记塞一个 prompt，AI 一次返回所有结果。
 *
 * 特点：
 *  - 按 chunkSize（默认 25）分块；块间共享 pendingNewCategories
 *  - 某块整体失败 → 本块文件走 fallback 策略（默认是 Sequential），不影响别块
 *  - 笔记数 ≤ 1 或 provider 没有批量能力时，外层会选别的策略，不会走到这里
 *
 * 依赖：provider.suggestTagsConstrainedBatch 必须可用。
 */

import type { TaggingStrategy, TaggerFile, TaggerContext, TaggingOutcome, TaggedResult } from './types';
import { chunk as chunkArr, mergeNewCategories, normalizeBatchResult } from './types';
import { SequentialStrategy } from './sequential';

export interface BatchStrategyOptions {
  /** 每批多少篇笔记；默认 25 */
  chunkSize?: number;
  /** 某批失败时降级策略；默认 SequentialStrategy */
  fallback?: TaggingStrategy;
}

export class BatchStrategy implements TaggingStrategy {
  readonly name = 'batch';
  private readonly chunkSize: number;
  private readonly fallback: TaggingStrategy;

  constructor(opts: BatchStrategyOptions = {}) {
    this.chunkSize = opts.chunkSize ?? 25;
    this.fallback = opts.fallback ?? new SequentialStrategy();
  }

  async tag(files: TaggerFile[], ctx: TaggerContext): Promise<TaggingOutcome> {
    if (typeof ctx.provider.suggestTagsConstrainedBatch !== 'function') {
      // Provider 不支持批量 → 完全走 fallback
      return this.fallback.tag(files, ctx);
    }

    const { provider, taxonomy, maxTags, intensity, onProgress, isCancelled, plannedTopics } = ctx;
    const chunks = chunkArr(files, this.chunkSize);
    const byFile = new Map<string, TaggedResult>();
    const failedPaths: string[] = [];
    let allNewCategories: string[] = [];

    for (let idx = 0; idx < chunks.length; idx++) {
      if (isCancelled?.()) break;
      const batch = chunks[idx];

      onProgress?.({
        phase: 'tagging',
        current: byFile.size,
        total: files.length,
        indeterminate: true,
        message: chunks.length > 1
          ? `正在分析 第 ${idx + 1}/${chunks.length} 批（${batch.length} 篇）...`
          : `正在分析 ${batch.length} 篇笔记...`,
      });

      try {
        const raw = await provider.suggestTagsConstrainedBatch!(
          batch.map(f => ({
            filePath: f.filePath,
            content: f.content,
            existingTags: f.oldTags,
            summary: f.summary,
          })),
          taxonomy,
          maxTags,
          intensity,
          [...allNewCategories],
          plannedTopics,
        );

        // 再走一次归一化（即使 provider 内部已经处理过，多一层防御）
        const normalized = normalizeBatchResult(raw);

        if (ctx.verbose) {
          console.debug(`[Atlas batch] 第 ${idx + 1} 批 输入=${batch.length} 返回=${normalized.length}`, {
            inputFiles: batch.map(f => f.filePath),
            resultFiles: normalized.map(it => it.file),
          });
        }

        // 写回 byFile 并累积 newCategories
        for (const it of normalized) {
          byFile.set(it.file, { tags: it.tags, newCategories: it.newCategories });
          allNewCategories = mergeNewCategories(allNewCategories, it.newCategories);
        }

        // 检查本批有没有文件没被 AI 返回（漏答）→ 对它们走 fallback
        const missed = batch.filter(f => !byFile.has(f.filePath));
        if (missed.length > 0) {
          console.warn(`[Atlas batch] 第 ${idx + 1} 批漏答 ${missed.length} 篇，走 fallback`);
          const subResult = await this.fallback.tag(missed, {
            ...ctx,
            // fallback 也能看到已累积的新分类（通过 ctx 传不太自然，fallback 自己会累积）
          });
          for (const [path, v] of subResult.byFile) byFile.set(path, v);
          allNewCategories = mergeNewCategories(allNewCategories, subResult.allNewCategories);
          failedPaths.push(...subResult.failedPaths);
        }
      } catch (e) {
        console.warn(`[Atlas batch] 第 ${idx + 1} 批失败，降级为 ${this.fallback.name}`, e);
        const subResult = await this.fallback.tag(batch, ctx);
        for (const [path, v] of subResult.byFile) byFile.set(path, v);
        allNewCategories = mergeNewCategories(allNewCategories, subResult.allNewCategories);
        failedPaths.push(...subResult.failedPaths);
      }
    }

    return {
      byFile,
      allNewCategories,
      successCount: byFile.size,
      failedPaths,
    };
  }
}
