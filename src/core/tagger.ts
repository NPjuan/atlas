import { App, TFile } from 'obsidian';
import {
  MECESettings,
  MECEStore,
  TaxonomySchema,
  ScanProgress,
  TagPatch,
  TagPatchList,
  SuggestedCategory,
} from '../types';
import { AIProvider } from '../ai/types';

// ============================================================
// V3 AI 打标签 — 两模式
//
// 有 Schema → 约束式（从 Schema 选标签，可建议新分类）
// 无 Schema → 开放式（自由选标签，V2 降级）
//
// Phase A: generatePatches() — AI 分析，生成 PatchList（不写入）
// Phase B: applyPatches()    — 将用户确认的 patch 写入 frontmatter
// ============================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000,
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

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

/** 从 metadataCache 收集 Vault 所有 tag */
export function collectVaultTags(app: App, folderFilter?: string): string[] {
  const tagSet = new Set<string>();
  const files = app.vault.getMarkdownFiles().filter(f => {
    if (folderFilter) {
      const prefix = folderFilter.endsWith('/') ? folderFilter : folderFilter + '/';
      return f.path.startsWith(prefix);
    }
    return true;
  });

  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;
    const fmTags = cache.frontmatter?.tags;
    if (Array.isArray(fmTags)) {
      for (const t of fmTags) {
        if (typeof t === 'string' && t.trim()) tagSet.add(t.trim());
      }
    } else if (typeof fmTags === 'string' && fmTags.trim()) {
      tagSet.add(fmTags.trim());
    }
  }

  return [...tagSet].sort();
}

/** 从文件内容直接解析 frontmatter tags */
function getFileTagsFromContent(content: string): string[] {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const fm = fmMatch[1];
  const tags: string[] = [];

  const inlineMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    inlineMatch[1].split(',').forEach(t => {
      const clean = t.trim().replace(/^["']|["']$/g, '');
      if (clean) tags.push(clean);
    });
    return tags;
  }

  const listMatch = fm.match(/^tags:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (listMatch) {
    listMatch[1].match(/^\s+-\s+(.+)/gm)?.forEach(line => {
      const t = line.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, '');
      if (t) tags.push(t);
    });
    return tags;
  }

  const singleMatch = fm.match(/^tags:\s+(.+)$/m);
  if (singleMatch) {
    const t = singleMatch[1].trim().replace(/^["']|["']$/g, '');
    if (t && !t.startsWith('[')) tags.push(t);
  }

  return tags;
}

export interface TaggingOptions {
  onProgress?: (progress: ScanProgress) => void;
  isCancelled?: () => boolean;
}

// ============================================================
// Phase A: AI 分析 → 生成 PatchList
// ============================================================

export async function generatePatches(
  app: App,
  files: TFile[],
  store: MECEStore,
  provider: AIProvider,
  settings: MECESettings,
  taxonomy: TaxonomySchema | null,
  options: TaggingOptions = {},
): Promise<TagPatchList> {
  const { onProgress, isCancelled } = options;

  const vaultTags = collectVaultTags(app);
  const patches: TagPatch[] = [];
  const allSuggestedCategories: SuggestedCategory[] = [];
  let processed = 0;
  let skippedFiles = 0;
  let totalNewTags = 0;

  for (const file of files) {
    if (isCancelled?.()) break;

    const content = await app.vault.cachedRead(file);

    if (content.length > settings.maxFileCharsSkip || content.length < 50) {
      skippedFiles++;
      processed++;
      continue;
    }

    // 增量检测
    const hash = simpleHash(content);
    const existing = store.processedFiles[file.path];
    if (existing && existing.hash === hash) {
      skippedFiles++;
      processed++;
      onProgress?.({
        phase: 'tagging',
        current: processed,
        total: files.length,
        currentFile: file.path,
        message: '跳过（无变化）',
      });
      continue;
    }

    const oldTags = getFileTagsFromContent(content);

    onProgress?.({
      phase: 'tagging',
      current: processed,
      total: files.length,
      currentFile: file.path,
      message: 'AI 分析中...',
    });

    // ---- 根据有无 Schema 选择打标签模式 ----
    let aiTags: string[];
    let newCategories: string[] = [];

    try {
      if (taxonomy) {
        // 约束式：从 Schema 中选
        const result = await withRetry(() =>
          provider.suggestTagsConstrained(
            content,
            file.path,
            oldTags,
            taxonomy,
            settings.maxTagsPerFile,
          )
        );
        aiTags = result.tags;
        newCategories = result.newCategories;
      } else {
        // 开放式：自由选
        const result = await withRetry(() =>
          provider.suggestTags(
            content,
            file.path,
            oldTags,
            vaultTags,
            settings.classificationMode,
            settings.maxTagsPerFile,
            settings.classificationMode === 'custom' ? settings.customClassificationPrompt : undefined,
          )
        );
        aiTags = result.tags;
      }
    } catch (e) {
      console.error(`MECE: AI 分析失败 ${file.path}`, e);
      processed++;
      continue;
    }

    // 加前缀
    if (settings.tagPrefix) {
      const prefix = settings.tagPrefix.replace(/\/+$/, '') + '/';
      aiTags = aiTags.map(t => t.startsWith(prefix) ? t : prefix + t);
    }

    // 限制上限
    if (aiTags.length > settings.maxTagsPerFile) {
      aiTags = aiTags.slice(0, settings.maxTagsPerFile);
    }

    // 计算 diff
    const oldSet = new Set(oldTags);
    const newSet = new Set(aiTags);
    const added = aiTags.filter(t => !oldSet.has(t));
    const removed = oldTags.filter(t => !newSet.has(t));
    const hasChanges = added.length > 0 || removed.length > 0;

    patches.push({
      filePath: file.path,
      fileName: file.name,
      oldTags,
      newTags: aiTags,
      added,
      removed,
      accepted: hasChanges,
      hash,
      hasChanges,
    });

    if (hasChanges) totalNewTags += added.length;

    // 收集新分类建议
    for (const nc of newCategories) {
      if (!allSuggestedCategories.some(s => s.path === nc)) {
        allSuggestedCategories.push({
          path: nc,
          sourceFile: file.path,
          accepted: false,
        });
      }
    }

    // 新 tag 加入 vaultTags 供后续文件复用
    for (const t of aiTags) {
      if (!vaultTags.includes(t)) vaultTags.push(t);
    }

    processed++;
    onProgress?.({
      phase: 'tagging',
      current: processed,
      total: files.length,
      currentFile: file.path,
      message: hasChanges
        ? `${added.length > 0 ? '+' + added.length : ''}${removed.length > 0 ? ' -' + removed.length : ''}: ${aiTags.join(', ')}`
        : '标签无变化',
    });
  }

  return {
    createdAt: new Date().toISOString(),
    patches,
    suggestedCategories: allSuggestedCategories,
    stats: {
      totalFiles: files.length,
      filesWithChanges: patches.filter(p => p.hasChanges).length,
      totalNewTags,
      skippedFiles,
    },
  };
}

// ============================================================
// Phase B: 写入 frontmatter（替换模式）
// ============================================================

export async function applyPatches(
  app: App,
  patches: TagPatch[],
  store: MECEStore,
): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;

  for (const patch of patches) {
    if (!patch.hasChanges) {
      store.processedFiles[patch.filePath] = {
        hash: patch.hash,
        taggedAt: new Date().toISOString(),
        tagCount: patch.oldTags.length,
      };
      continue;
    }

    const file = app.vault.getAbstractFileByPath(patch.filePath);
    if (!(file instanceof TFile)) {
      failed++;
      continue;
    }

    try {
      await app.fileManager.processFrontMatter(file, (fm) => {
        fm.tags = [...patch.newTags];
        fm['mece-tagged'] = true;
        fm['mece-tagged-at'] = new Date().toISOString();
      });
      applied++;
    } catch (e) {
      console.error(`MECE: 写入失败 ${patch.filePath}`, e);
      failed++;
    }

    store.processedFiles[patch.filePath] = {
      hash: patch.hash,
      taggedAt: new Date().toISOString(),
      tagCount: patch.newTags.length,
    };
  }

  return { applied, failed };
}
