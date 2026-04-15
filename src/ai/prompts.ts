// ============================================================
// Prompt 模板 — 知识提取 + MECE 分类
// ============================================================

/**
 * 知识点提取 Prompt
 * 输入: 一段文本 chunk
 * 输出: JSON 格式的知识点列表
 */
export function buildExtractionPrompt(chunk: string, sourceFile: string): string {
  return `你是一个知识提取专家。请从以下文本中提取核心知识点。

## 要求
1. 每个知识点必须是一个独立、完整的知识陈述
2. 保留原文中最相关的一句话作为引用（sourceQuote）
3. 过滤掉纯叙事、寒暄、目录索引等非知识性内容
4. 如果文本中没有有价值的知识点，返回空数组

## 输出格式（严格 JSON，不要包裹 markdown 代码块）
{
  "knowledgePoints": [
    {
      "content": "提炼后的知识点摘要",
      "sourceQuote": "原文中的相关引用"
    }
  ]
}

## 示例

输入文本："React 使用虚拟 DOM 来提高渲染性能。当状态变化时，React 会先在内存中计算出最小 diff，然后批量更新真实 DOM，避免了频繁的 DOM 操作带来的性能损耗。"

输出：
{
  "knowledgePoints": [
    {
      "content": "React 通过虚拟 DOM 和 diff 算法实现高效渲染：状态变化时先在内存计算最小变更集，再批量更新真实 DOM",
      "sourceQuote": "React 会先在内存中计算出最小 diff，然后批量更新真实 DOM"
    }
  ]
}

## 待处理文本

来源文件：${sourceFile}

${chunk}`;
}

/**
 * MECE 分类 Prompt
 * 输入: 待分类知识点 + 已有分类树骨架
 * 输出: 分类映射 + 新增节点
 */
export function buildClassificationPrompt(
  knowledgePoints: { id: string; content: string }[],
  treeSkeleton: any
): string {
  const kpList = knowledgePoints
    .map((kp) => `- [${kp.id}] ${kp.content}`)
    .join('\n');

  const treeJSON = JSON.stringify(treeSkeleton, null, 2);

  return `你是一个知识分类专家，精通 MECE（Mutually Exclusive, Collectively Exhaustive）原则。

## 任务
将给定的知识点分类到已有的三层 MECE 分类树中。如果现有分类不能覆盖某些知识点，请创建新的分类节点。

## MECE 三层结构
- **主题（theme）**：最高层，代表一个大的知识领域
- **类别（category）**：中间层，主题下的具体细分方向
- **观点类型（viewpoint）**：最低层，类别下的具体知识观点类型

## 规则
1. 每个知识点必须归入至少一个 viewpoint 节点（可以多个）
2. 尽量复用已有分类，避免过度创建新节点
3. 新建节点时确保与同层其他节点互斥（Mutually Exclusive）
4. 整体分类要穷尽（Collectively Exhaustive），不遗漏任何知识点
5. 新节点的 id 格式：theme_xxx / cat_xxx / vp_xxx
6. 新节点的 parentId 必须是已有节点的 id 或其他新节点的 id

## 输出格式（严格 JSON，不要包裹 markdown 代码块）
{
  "assignments": {
    "知识点id": ["viewpoint节点id", ...]
  },
  "newNodes": [
    {
      "id": "新节点id",
      "name": "节点名称",
      "level": "theme 或 category 或 viewpoint",
      "parentId": "父节点id"
    }
  ]
}

## 示例

已有分类树只有 root 节点，知识点：
- [kp_1] React 通过虚拟 DOM 提高渲染性能
- [kp_2] Python 的 GIL 限制了多线程并行

输出：
{
  "assignments": {
    "kp_1": ["vp_react_rendering"],
    "kp_2": ["vp_python_concurrency"]
  },
  "newNodes": [
    { "id": "theme_programming", "name": "编程技术", "level": "theme", "parentId": "root" },
    { "id": "cat_frontend", "name": "前端开发", "level": "category", "parentId": "theme_programming" },
    { "id": "vp_react_rendering", "name": "React 渲染机制", "level": "viewpoint", "parentId": "cat_frontend" },
    { "id": "cat_python", "name": "Python 语言特性", "level": "category", "parentId": "theme_programming" },
    { "id": "vp_python_concurrency", "name": "并发与多线程", "level": "viewpoint", "parentId": "cat_python" }
  ]
}

## 已有分类树骨架
${treeJSON}

## 待分类知识点
${kpList}`;
}
