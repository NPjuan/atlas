import { Vault, TFile } from 'obsidian';
import { KnowledgeStore, KnowledgePoint, MECESettings, ScanProgress } from '../types';
import { AIProvider } from '../ai/types';
import { chunkText, TextChunk } from '../ai/chunker';
import { KnowledgeStoreManager } from './store';

// ============================================================
// 知识点提取流水线 — 并发队列 + 指数退避重试 + 断点续传
// ============================================================

/** 生成唯一 ID */
function generateId(): string {
  return 'kp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** 指数退避延迟 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带重试的 AI 调用
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxRetries) {
        const waitMs = baseDelay * Math.pow(2, attempt);
        console.warn(`MECE: 重试 ${attempt + 1}/${maxRetries}，等待 ${waitMs}ms`, lastError.message);
        await delay(waitMs);
      }
    }
  }
  throw lastError;
}

/**
 * 并发控制队列
 */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  maxConcurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from(
    { length: Math.min(maxConcurrency, tasks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

export interface ExtractionOptions {
  /** 进度回调 */
  onProgress?: (progress: ScanProgress) => void;
  /** 取消信号 */
  isCancelled?: () => boolean;
}

/**
 * 对一批文件执行知识提取
 */
export async function extractKnowledge(
  vault: Vault,
  files: TFile[],
  store: KnowledgeStore,
  storeManager: KnowledgeStoreManager,
  provider: AIProvider,
  settings: MECESettings,
  options: ExtractionOptions = {}
): Promise<number> {
  const { onProgress, isCancelled } = options;
  let totalExtracted = 0;
  let processedFiles = 0;

  for (const file of files) {
    if (isCancelled?.()) break;

    const content = await vault.cachedRead(file);
    const chunks = chunkText(content);

    // 断点续传：检查已处理的 chunk 数
    const existing = store.documents[file.path];
    const startChunk = existing?.status === 'partial' ? (existing.processedChunks || 0) : 0;

    // 标记为处理中
    store.documents[file.path] = {
      hash: simpleHash(content),
      processedAt: new Date().toISOString(),
      status: 'partial',
      processedChunks: startChunk,
    };

    // 如果是重新处理（非断点续传），先清除旧知识点
    if (startChunk === 0) {
      store.knowledgePoints = store.knowledgePoints.filter(
        (kp) => kp.sourceFile !== file.path
      );
    }

    // 构建待处理的 chunk 任务
    const remainingChunks = chunks.slice(startChunk);
    let chunksDone = startChunk;

    // 逐个 chunk 处理（每个 chunk 之间支持中断和持久化）
    const chunkTasks = remainingChunks.map((chunk) => async () => {
      if (isCancelled?.()) return;

      const result = await withRetry(() =>
        provider.extract(chunk.text, file.path)
      );

      // 生成知识点
      for (const raw of result.knowledgePoints) {
        const kp: KnowledgePoint = {
          id: generateId(),
          content: raw.content,
          sourceFile: file.path,
          sourceQuote: raw.sourceQuote,
          sourcePosition: { start: chunk.start, end: chunk.end },
          categoryIds: [],
          classified: false,
        };
        store.knowledgePoints.push(kp);
        totalExtracted++;
      }

      // 每个 chunk 处理完就持久化进度（断点续传）
      chunksDone++;
      store.documents[file.path].processedChunks = chunksDone;
      await storeManager.save();
    });

    // 用并发队列执行 chunk 任务
    await runWithConcurrency(chunkTasks, settings.maxConcurrency);

    // 标记文件处理完成
    if (!isCancelled?.()) {
      store.documents[file.path].status = 'completed';
      await storeManager.save();
    }

    processedFiles++;
    onProgress?.({
      phase: 'extracting',
      current: processedFiles,
      total: files.length,
      currentFile: file.path,
      message: `已提取 ${totalExtracted} 个知识点`,
    });
  }

  return totalExtracted;
}

/** 内部 hash（与 scanner 一致） */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}
