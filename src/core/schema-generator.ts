import { App, TFile } from 'obsidian';
import {
  MECESettings,
  TaxonomySchema,
  TaxonomyNode,
  NoteOverview,
  SchemaContextMode,
  ScanProgress,
} from '../types';
import { AIProvider, RawTaxonomyResult } from '../ai/types';

// ============================================================
// Schema 生成引擎
//
// 全量扫描目录 → 构建笔记概览 → token 估算/降级 → 调 AI → 解析结果
// ============================================================

/** 简单 ID 生成 */
function genId(): string {
  return Math.random().toString(36).substring(2, 10);
}

/** 估算文本的 token 数（粗略） */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) tokens += 1.5;
    else if (/[a-zA-Z]/.test(ch)) tokens += 0.25;
    else tokens += 0.5;
  }
  return Math.round(tokens);
}

/** 从文件内容中解析 frontmatter tags */
function getTagsFromContent(content: string): string[] {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];

  const fm = fmMatch[1];
  const tags: string[] = [];

  // tags: [a, b] 行内格式
  const inlineMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    inlineMatch[1].split(',').forEach(t => {
      const clean = t.trim().replace(/^["']|["']$/g, '');
      if (clean) tags.push(clean);
    });
    return tags;
  }

  // tags:\n  - a\n  - b 列表格式
  const listMatch = fm.match(/^tags:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (listMatch) {
    listMatch[1].match(/^\s+-\s+(.+)/gm)?.forEach(line => {
      const t = line.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, '');
      if (t) tags.push(t);
    });
    return tags;
  }

  // tags: 单个值
  const singleMatch = fm.match(/^tags:\s+(.+)$/m);
  if (singleMatch) {
    const t = singleMatch[1].trim().replace(/^["']|["']$/g, '');
    if (t && !t.startsWith('[')) tags.push(t);
  }

  return tags;
}

/** 去除 frontmatter 获取纯内容 */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
}

/** 按 contextMode 处理笔记内容 */
function applyContextMode(content: string, mode: SchemaContextMode): string {
  const body = stripFrontmatter(content);
  switch (mode) {
    case 'title-only':
      // 只提取 # 标题行
      const h1 = body.match(/^#\s+(.+)$/m);
      return h1 ? h1[1] : '';
    case 'first-500':
      return body.substring(0, 500);
    case 'full':
    default:
      return body;
  }
}

export interface SchemaGenerationOptions {
  onProgress?: (progress: ScanProgress) => void;
  isCancelled?: () => boolean;
  rootName?: string;
}

/**
 * 全量扫描目录下的笔记，调 AI 生成分类体系
 */
export async function generateTaxonomySchema(
  app: App,
  files: TFile[],
  provider: AIProvider,
  settings: MECESettings,
  options: SchemaGenerationOptions = {},
): Promise<TaxonomySchema> {
  const { onProgress, isCancelled } = options;

  // 1. 构建笔记概览
  onProgress?.({ phase: 'scanning', current: 0, total: files.length, message: '读取笔记内容...' });

  const notes: NoteOverview[] = [];
  for (let i = 0; i < files.length; i++) {
    if (isCancelled?.()) throw new Error('用户取消');

    const file = files[i];
    const raw = await app.vault.cachedRead(file);

    // 跳过太短的文件
    if (raw.length < 50) continue;

    const existingTags = getTagsFromContent(raw);
    const content = applyContextMode(raw, settings.schemaContextMode);

    notes.push({
      fileName: file.name,
      existingTags,
      content,
    });

    onProgress?.({
      phase: 'scanning',
      current: i + 1,
      total: files.length,
      currentFile: file.path,
      message: `读取 ${i + 1}/${files.length}`,
    });
  }

  if (notes.length === 0) {
    throw new Error('没有找到可分析的笔记');
  }

  // 2. Token 估算 + 自动降级
  const allText = notes.map(n => `${n.fileName}\n${n.existingTags.join(',')}\n${n.content}`).join('\n');
  let totalTokens = estimateTokens(allText);

  if (totalTokens > 120000 && settings.schemaContextMode === 'full') {
    console.warn(`Atlas: 全文模式 token 过多 (~${totalTokens})，自动降级为 first-500`);
    // 降级：只保留前 500 字
    for (const n of notes) {
      n.content = stripFrontmatter(n.content).substring(0, 500);
    }
    totalTokens = estimateTokens(notes.map(n => `${n.fileName}\n${n.content}`).join('\n'));
  }

  // 3. 调 AI 生成 Schema
  onProgress?.({
    phase: 'schema-gen',
    current: 0,
    total: 1,
    indeterminate: true,
    message: `正在分析 ${notes.length} 篇笔记（~${totalTokens.toLocaleString()} tokens）...`,
  });

  const maxDepth = 3; // 固定最大 3 层
  const rawResult = await provider.generateTaxonomy(
    notes,
    maxDepth,
    settings.classificationMode,
    settings.classificationMode === 'custom' ? settings.customClassificationPrompt : undefined,
  );

  // 4. 后处理：补充 id 和 fullPath
  const taxonomy = postProcessTaxonomy(rawResult, maxDepth, options.rootName);

  onProgress?.({
    phase: 'schema-gen',
    current: 1,
    total: 1,
    message: '分类体系生成完成',
  });

  return taxonomy;
}

/** 将 AI 返回的原始结构转为完整的 TaxonomySchema */
function postProcessTaxonomy(raw: RawTaxonomyResult, maxDepth: number, rootName = '全部'): TaxonomySchema {
  function processNodes(rawNodes: any[], parentPath: string, depth: number): TaxonomyNode[] {
    if (depth >= maxDepth) return [];

    return (rawNodes || []).map(n => {
      const name = (n.name || '').trim();
      if (!name) return null;

      const fullPath = parentPath ? `${parentPath}/${name}` : name;

      return {
        id: genId(),
        name,
        fullPath,
        description: n.description || undefined,
        children: processNodes(n.children || [], fullPath, depth + 1),
      };
    }).filter((n): n is TaxonomyNode => n !== null);
  }

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    maxDepth,
    rootName,
    nodes: processNodes(raw.taxonomy, '', 0),
  };
}
