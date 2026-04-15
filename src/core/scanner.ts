import { Vault, TFile, Notice } from 'obsidian';
import { KnowledgeStore, MECESettings, DocumentRecord } from '../types';

// ============================================================
// Vault Scanner — 增量检测 + 排除规则 + 孤儿清理
// ============================================================

export interface ScanResult {
  /** 新增或修改的文件（需要提取知识点） */
  changedFiles: TFile[];
  /** 未完成处理的文件（断点续传） */
  partialFiles: TFile[];
  /** 孤儿文件路径（已删除/已改名，store 中仍有记录） */
  orphanPaths: string[];
  /** 被跳过的大文件 */
  skippedFiles: { file: TFile; reason: string }[];
  /** 总扫描文件数 */
  totalScanned: number;
}

/**
 * 计算字符串的简易 hash（用于增量检测）
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // 转为 32 位整数
  }
  return hash.toString(36);
}

/**
 * 扫描 Vault 中的 .md 文件，做增量检测
 */
export async function scanVault(
  vault: Vault,
  store: KnowledgeStore,
  settings: MECESettings
): Promise<ScanResult> {
  const result: ScanResult = {
    changedFiles: [],
    partialFiles: [],
    orphanPaths: [],
    skippedFiles: [],
    totalScanned: 0,
  };

  // 获取所有 .md 文件
  const allFiles = vault.getMarkdownFiles();

  // 过滤排除目录
  const filteredFiles = allFiles.filter((file) => {
    return !settings.excludeDirs.some((dir) => {
      const normalizedDir = dir.replace(/^\/+|\/+$/g, '');
      return file.path.startsWith(normalizedDir + '/') || file.path === normalizedDir;
    });
  });

  result.totalScanned = filteredFiles.length;

  // 遍历文件，检测变化
  const currentPaths = new Set<string>();

  for (const file of filteredFiles) {
    currentPaths.add(file.path);

    const content = await vault.cachedRead(file);

    // 大文件检查
    if (content.length > settings.maxFileCharsSkip) {
      result.skippedFiles.push({
        file,
        reason: `文件过大（${content.length} 字符 > ${settings.maxFileCharsSkip}），已跳过`,
      });
      continue;
    }

    if (content.length > settings.maxFileCharsWarn) {
      new Notice(`⚠️ 大文件警告：${file.path}（${content.length} 字符）`);
    }

    const hash = simpleHash(content);
    const existing = store.documents[file.path];

    if (!existing) {
      // 新文件
      result.changedFiles.push(file);
    } else if (existing.hash !== hash) {
      // 内容变化
      result.changedFiles.push(file);
    } else if (existing.status === 'partial') {
      // 上次中断未完成
      result.partialFiles.push(file);
    }
    // else: 无变化，跳过
  }

  // 检测孤儿（store 中有记录但磁盘上已不存在）
  for (const storedPath of Object.keys(store.documents)) {
    if (!currentPaths.has(storedPath)) {
      result.orphanPaths.push(storedPath);
    }
  }

  return result;
}

/**
 * 清理孤儿数据：移除已删除文件关联的文档记录和知识点
 */
export function cleanOrphans(store: KnowledgeStore, orphanPaths: string[]): number {
  let removedCount = 0;

  for (const path of orphanPaths) {
    // 移除文档记录
    delete store.documents[path];

    // 移除关联的知识点
    const before = store.knowledgePoints.length;
    store.knowledgePoints = store.knowledgePoints.filter(
      (kp) => kp.sourceFile !== path
    );
    removedCount += before - store.knowledgePoints.length;
  }

  return removedCount;
}
