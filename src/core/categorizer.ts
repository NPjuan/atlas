import { KnowledgeStore, KnowledgePoint, CategoryNode, ScanProgress } from '../types';
import { AIProvider, CategoryTreeSkeleton, ClassificationResult } from '../ai/types';
import { KnowledgeStoreManager } from './store';

// ============================================================
// MECE 增量分类器 — 分批处理 + 骨架摘要
// ============================================================

const BATCH_SIZE = 40; // 每批处理的知识点数量

export interface ClassifyOptions {
  onProgress?: (progress: ScanProgress) => void;
  isCancelled?: () => boolean;
}

/**
 * 对未分类的知识点执行 MECE 分类
 */
export async function classifyKnowledge(
  store: KnowledgeStore,
  storeManager: KnowledgeStoreManager,
  provider: AIProvider,
  options: ClassifyOptions = {}
): Promise<number> {
  const { onProgress, isCancelled } = options;

  // 1. 筛选未分类的知识点
  const unclassified = store.knowledgePoints.filter((kp) => !kp.classified);
  if (unclassified.length === 0) return 0;

  // 2. 分批处理
  const batches = splitIntoBatches(unclassified, BATCH_SIZE);
  let totalClassified = 0;

  for (let i = 0; i < batches.length; i++) {
    if (isCancelled?.()) break;

    const batch = batches[i];
    onProgress?.({
      phase: 'classifying',
      current: i + 1,
      total: batches.length,
      message: `分类第 ${i + 1}/${batches.length} 批（${batch.length} 条）`,
    });

    // 3. 生成分类树骨架摘要（只传结构，不传知识点内容）
    const skeleton = buildTreeSkeleton(store.categoryTree);

    // 4. 调 AI 分类
    const kpInput = batch.map((kp) => ({ id: kp.id, content: kp.content }));

    let result: ClassificationResult;
    try {
      result = await retryClassify(provider, kpInput, skeleton);
    } catch (e) {
      console.error('MECE: 分类失败', e);
      continue; // 跳过这批，下次还是 unclassified
    }

    // 5. 应用新节点到分类树
    if (result.newNodes.length > 0) {
      applyNewNodes(store.categoryTree, result.newNodes);
    }

    // 6. 应用分类映射
    for (const kp of batch) {
      const assignedIds = result.assignments[kp.id];
      if (assignedIds && assignedIds.length > 0) {
        kp.categoryIds = assignedIds;
        kp.classified = true;
        totalClassified++;

        // 在分类树叶节点中也记录知识点 ID
        for (const catId of assignedIds) {
          const node = findNode(store.categoryTree, catId);
          if (node && !node.knowledgePointIds.includes(kp.id)) {
            node.knowledgePointIds.push(kp.id);
          }
        }
      }
    }

    // 7. 每批处理完持久化
    await storeManager.save();
  }

  return totalClassified;
}

// ---- 内部工具函数 ----

/** 分批 */
function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

/** 生成分类树骨架（只保留 id/name/level/children，不含 knowledgePointIds） */
function buildTreeSkeleton(node: CategoryNode): CategoryTreeSkeleton {
  return {
    id: node.id,
    name: node.name,
    level: node.level,
    children: node.children.map(buildTreeSkeleton),
  };
}

/** 在分类树中查找节点 */
function findNode(root: CategoryNode, id: string): CategoryNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** 将新节点添加到分类树中 */
function applyNewNodes(
  root: CategoryNode,
  newNodes: ClassificationResult['newNodes']
): void {
  // 按层级排序：先添加 theme，再 category，最后 viewpoint
  const levelOrder = { theme: 0, category: 1, viewpoint: 2 };
  const sorted = [...newNodes].sort(
    (a, b) => (levelOrder[a.level] || 0) - (levelOrder[b.level] || 0)
  );

  for (const nodeData of sorted) {
    // 检查是否已存在
    if (findNode(root, nodeData.id)) continue;

    const parent = findNode(root, nodeData.parentId);
    if (!parent) {
      console.warn(`MECE: 找不到父节点 ${nodeData.parentId}，跳过添加 ${nodeData.id}`);
      continue;
    }

    parent.children.push({
      id: nodeData.id,
      name: nodeData.name,
      level: nodeData.level,
      children: [],
      knowledgePointIds: [],
    });
  }
}

/** 带重试的分类调用 */
async function retryClassify(
  provider: AIProvider,
  kpInput: { id: string; content: string }[],
  skeleton: CategoryTreeSkeleton,
  maxRetries: number = 2
): Promise<ClassificationResult> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await provider.classify(kpInput, skeleton);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxRetries) {
        const waitMs = 1000 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
  throw lastError;
}
