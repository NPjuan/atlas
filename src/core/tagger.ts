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
import { pickStrategy } from './taggers/factory';
import type { TaggerFile, TaggingOutcome } from './taggers/types';

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
        console.warn(`Atlas: 重试 ${attempt + 1}/${maxRetries}，等待 ${waitMs}ms`, lastError.message);
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
  /** 重新归类时的调整强度（保守/平衡/激进） */
  intensity?: import('../ai/prompts').ReorganizeIntensity;
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
  const { onProgress, isCancelled, intensity } = options;

  const vaultTags = collectVaultTags(app);
  const patches: TagPatch[] = [];
  const allSuggestedCategories: SuggestedCategory[] = [];
  let processed = 0;
  let skippedFiles = 0;
  let totalNewTags = 0;

  // ---- Phase 1: 预处理所有文件（hash / 跳过 / 读内容 / 读缓存摘要） ----
  interface PreparedFile {
    file: TFile;
    content: string;
    hash: string;
    oldTags: string[];
    /** 从 store 读出来的有效摘要（hash 一致才用）；后面 Summary 阶段可能会填 */
    summary?: string;
  }
  const prepared: PreparedFile[] = [];
  for (const file of files) {
    if (isCancelled?.()) break;
    const content = await app.vault.cachedRead(file);

    if (content.length > settings.maxFileCharsSkip || content.length < 50) {
      skippedFiles++;
      processed++;
      continue;
    }

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

    // 读缓存里的有效摘要（summaryHash === 当前内容 hash 才能复用）
    const cachedSummary = existing?.summaryHash === hash ? existing.summary : undefined;

    prepared.push({
      file, content, hash,
      oldTags: getFileTagsFromContent(content),
      summary: cachedSummary,
    });
  }

  // ---- Phase 1.5: 批量生成缺失的摘要 ----
  if (taxonomy && typeof provider.summarizeBatch === 'function' && prepared.length > 0) {
    const needSummary = prepared.filter(p => !p.summary);
    if (needSummary.length > 0) {
      const SUMMARY_CHUNK = 25;
      const chunks: typeof needSummary[] = [];
      for (let i = 0; i < needSummary.length; i += SUMMARY_CHUNK) {
        chunks.push(needSummary.slice(i, i + SUMMARY_CHUNK));
      }
      for (let idx = 0; idx < chunks.length; idx++) {
        if (isCancelled?.()) break;
        const chunk = chunks[idx];
        onProgress?.({
          phase: 'tagging',
          current: processed,
          total: files.length,
          indeterminate: true,
          message: chunks.length > 1
            ? `生成笔记摘要 第 ${idx + 1}/${chunks.length} 批（${chunk.length} 篇）...`
            : `生成笔记摘要（${chunk.length} 篇）...`,
        });
        try {
          const result = await withRetry(() =>
            provider.summarizeBatch!(
              chunk.map(p => ({ filePath: p.file.path, content: p.content })),
            ),
          );
          const byFile = new Map(result.items.map(it => [it.file, it.summary]));
          for (const p of chunk) {
            const s = byFile.get(p.file.path);
            if (s) {
              p.summary = s;
              // 立即写入 store 缓存
              const prev = store.processedFiles[p.file.path];
              store.processedFiles[p.file.path] = {
                hash: prev?.hash || p.hash,
                taggedAt: prev?.taggedAt || '',
                tagCount: prev?.tagCount || 0,
                summary: s,
                summaryHash: p.hash,
              };
            }
          }
        } catch (e) {
          console.warn(`Atlas: 第 ${idx + 1} 批摘要生成失败，使用原文前 500 字降级`, e);
          for (const p of chunk) {
            if (!p.summary) p.summary = p.content.slice(0, 500);
          }
        }
      }
    }
  }

  // ---- Phase 1.6: 顶层规划（可选）----
  // 让 AI 先审视所有笔记，产出 3-5 个统一顶层分类，归类阶段以此为约束
  // 只在"有摘要 + provider 支持 + 笔记数 >= 3"时启用（数量太少规划没意义）
  let plannedTopics: Array<{ name: string; description?: string }> | undefined;
  if (
    taxonomy
    && typeof provider.planTaxonomyTopics === 'function'
    && prepared.length >= 3
  ) {
    const withSummary = prepared.filter(p => p.summary && p.summary.trim());
    if (withSummary.length === prepared.length) {  // 确保都有摘要
      onProgress?.({
        phase: 'tagging',
        current: processed,
        total: files.length,
        indeterminate: true,
        message: `规划顶层分类（${prepared.length} 篇）...`,
      });

      // 统计文件夹 hint：按文件数排序取前 5 个
      const folderCount = new Map<string, number>();
      for (const p of prepared) {
        const dir = p.file.path.includes('/')
          ? p.file.path.slice(0, p.file.path.lastIndexOf('/'))
          : '';
        if (dir) folderCount.set(dir, (folderCount.get(dir) || 0) + 1);
      }
      const folderHints = [...folderCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([f]) => f);

      // 已有顶层（归类阶段有 taxonomy 时复用）
      const existingTopics = taxonomy.nodes.map(n => n.name);

      try {
        const planResult = await withRetry(() =>
          provider.planTaxonomyTopics!(
            prepared.map(p => ({ filePath: p.file.path, summary: p.summary! })),
            folderHints,
            existingTopics,
          ),
        );
        plannedTopics = planResult.topics.map(t => ({
          name: t.name,
          description: t.description,
        }));
        console.debug(`[Atlas tagger] 顶层规划：${plannedTopics.length} 个`,
          plannedTopics.map(t => t.name));
      } catch (e) {
        console.warn('[Atlas tagger] 顶层规划失败，跳过此阶段', e);
      }
    }
  }

  // ---- Phase 2: 归类（走策略，有 taxonomy 时用 Sequential/Batch；无 taxonomy 走开放式兜底）----
  let outcome: TaggingOutcome | null = null;
  if (taxonomy && prepared.length > 0) {
    const strategy = pickStrategy({
      strategy: settings.taggingStrategy || 'auto',
      provider,
      fileCount: prepared.length,
    });
    console.debug(`[Atlas tagger] 使用策略: ${strategy.name}（${prepared.length} 篇）`);

    const taggerFiles: TaggerFile[] = prepared.map(p => ({
      filePath: p.file.path,
      content: p.content,
      oldTags: p.oldTags,
      summary: p.summary,
    }));

    outcome = await strategy.tag(taggerFiles, {
      provider,
      taxonomy,
      maxTags: settings.maxTagsPerFile,
      intensity,
      onProgress,
      isCancelled,
      verbose: true,
      plannedTopics,
    });
  }

  // ---- Phase 3: 整合结果 → patches ----
  // 预先收集现有 taxonomy 的所有路径（用于判断 AI 返回的 tag 是不是新分类）
  const existingTaxonomyPaths = new Set<string>();
  if (taxonomy) {
    const walk = (nodes: typeof taxonomy.nodes, prefix: string) => {
      for (const n of nodes) {
        const p = prefix ? `${prefix}/${n.name}` : n.name;
        existingTaxonomyPaths.add(p);
        if (n.children) walk(n.children, p);
      }
    };
    walk(taxonomy.nodes, '');
  }
  // 规划阶段产生的顶层名集合，用于防御 3：AI 只给顶层时拒绝该 tag
  const plannedTopicNames = new Set((plannedTopics || []).map(t => t.name));

  for (const { file, content, hash, oldTags } of prepared) {
    if (isCancelled?.()) break;

    let aiTags: string[] = [];
    let newCategories: string[] = [];

    try {
      if (outcome) {
        const hit = outcome.byFile.get(file.path);
        if (hit) {
          aiTags = [...hit.tags];
          newCategories = [...hit.newCategories];
          // 防御：AI 偷懒只给光秃秃顶层（如 tags=["前端开发"]），过滤掉
          // Provider 层已经通过 splitPaths 自动把 path 分流到 tags/newCategories，
          // 所以这里只需防"顶层 tag"这一种 AI 偷懒模式。
          const rejected = aiTags.filter(t => plannedTopicNames.has(t) && !t.includes('/'));
          if (rejected.length > 0) {
            console.warn(`[Atlas tagger] 拒绝 AI 偷懒返回的顶层 tag（${file.path}）:`, rejected);
            aiTags = aiTags.filter(t => !(plannedTopicNames.has(t) && !t.includes('/')));
            newCategories = newCategories.filter(t => !(plannedTopicNames.has(t) && !t.includes('/')));
          }
        } else {
          // 策略层已经失败的（比如 AI 没返回这篇）：打个警告，aiTags 保持空
          // 最终 patch 会被判为 hasChanges=false（如果 oldTags 也空）
          console.warn(`[Atlas tagger] 策略未返回 ${file.path}，该文件无标签变更`);
        }
      } else if (!taxonomy) {
        // 开放式：无 schema 兜底
        const result = await provider.suggestTags(
          content,
          file.path,
          oldTags,
          vaultTags,
          settings.classificationMode,
          settings.maxTagsPerFile,
          settings.classificationMode === 'custom' ? settings.customClassificationPrompt : undefined,
        );
        aiTags = result.tags;
      }
    } catch (e) {
      console.error(`Atlas: AI 分析失败 ${file.path}`, e);
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
      });
      applied++;
    } catch (e) {
      console.error(`Atlas: 写入失败 ${patch.filePath}`, e);
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
