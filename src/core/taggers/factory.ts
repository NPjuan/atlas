/**
 * 归类策略的工厂 / 选择器。
 *
 * 根据用户设置 + provider 能力 + 文件数量，挑一个合适的策略。
 */

import type { TaggingStrategy } from './types';
import type { AIProvider } from '../../ai/types';
import { SequentialStrategy } from './sequential';
import { BatchStrategy } from './batch';

export type TaggingStrategyId = 'auto' | 'sequential' | 'batch';

export interface PickOptions {
  strategy: TaggingStrategyId;
  provider: AIProvider;
  fileCount: number;
  /** batch 策略的 chunk 大小；默认 25 */
  batchChunkSize?: number;
}

export function pickStrategy(opts: PickOptions): TaggingStrategy {
  const { strategy, provider, fileCount, batchChunkSize } = opts;

  if (strategy === 'sequential') return new SequentialStrategy();
  if (strategy === 'batch') {
    return new BatchStrategy({ chunkSize: batchChunkSize });
  }

  // auto
  const providerSupportsBatch = typeof provider.suggestTagsConstrainedBatch === 'function';
  if (providerSupportsBatch && fileCount > 1) {
    return new BatchStrategy({ chunkSize: batchChunkSize });
  }
  return new SequentialStrategy();
}
