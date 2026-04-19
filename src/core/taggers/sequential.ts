/**
 * Sequential 策略：一篇一篇地调 AI。
 *
 * 优点：
 *  - 每篇都拿到完整原文（或摘要），结果精度最高
 *  - 单点失败只影响一篇，不会带崩整批
 *  - 累积的 pendingNewCategories 传给下一次，让后续笔记复用已建议的新分类
 *
 * 缺点：
 *  - N 次 API 调用，慢且贵
 *  - 首篇没有全局视角，可能和后续判断不一致
 */

import type { TaggingStrategy, TaggerFile, TaggerContext, TaggingOutcome, TaggedResult } from './types';
import { mergeNewCategories } from './types';

export class SequentialStrategy implements TaggingStrategy {
  readonly name = 'sequential';

  async tag(files: TaggerFile[], ctx: TaggerContext): Promise<TaggingOutcome> {
    const { provider, taxonomy, maxTags, intensity, onProgress, isCancelled } = ctx;
    const byFile = new Map<string, TaggedResult>();
    const failedPaths: string[] = [];
    let allNewCategories: string[] = [];
    let processed = 0;

    for (const f of files) {
      if (isCancelled?.()) break;

      onProgress?.({
        phase: 'tagging',
        current: processed,
        total: files.length,
        currentFile: f.filePath,
        message: `正在分析第 ${processed + 1}/${files.length} 篇...`,
      });

      try {
        // 若有 summary，把它作为"主要内容"喂给 AI（节省 token + 归类更准）
        const effectiveContent = f.summary && f.summary.trim() ? f.summary : f.content;
        const result = await provider.suggestTagsConstrained(
          effectiveContent,
          f.filePath,
          f.oldTags,
          taxonomy,
          maxTags,
          intensity,
          [...allNewCategories],  // 当前累积的新分类，传给 AI 复用
        );
        byFile.set(f.filePath, {
          tags: result.tags,
          newCategories: result.newCategories,
        });
        allNewCategories = mergeNewCategories(allNewCategories, result.newCategories);
      } catch (e) {
        console.warn(`[Atlas sequential] 分析失败 ${f.filePath}`, e);
        failedPaths.push(f.filePath);
      }

      processed++;
    }

    return {
      byFile,
      allNewCategories,
      successCount: byFile.size,
      failedPaths,
    };
  }
}
