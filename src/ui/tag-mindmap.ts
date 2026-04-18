import { App, TFile } from 'obsidian';
import ForceGraph, { ForceGraphInstance } from 'force-graph';

// ============================================================
// Tag 脑图引擎 — 基于 force-graph
// 从 metadataCache 实时构建 tag 树 → 力导向图渲染
// 增量展开/折叠（不重建整图，避免闪烁）
// ============================================================

// ---- 数据结构 ----

/** 原始 tag 树节点 */
interface RawTreeNode {
  id: string;
  name: string;
  type: 'root' | 'tag' | 'file';
  fullTag?: string;
  filePath?: string;
  children?: RawTreeNode[];
  files?: string[];  // tag 直接关联的文件名
  filePaths?: string[];  // 对应的完整路径
}

/** force-graph 节点 */
interface GraphNode {
  id: string;
  name: string;
  type: 'root' | 'tag' | 'file';
  depth: number;
  fullTag?: string;
  filePath?: string;
  _src: RawTreeNode | null;
  _hasKids: boolean;
  _open: boolean;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

/** force-graph 连线 */
interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
}

// ---- 配色 ----

const PALETTE = {
  bg: '#202020',
  root: '#7f6df2',
  tagColors: ['#a88bfa', '#7c9cf5', '#6bb8c7', '#5dab80'],
  file: '#4e4e4e',
  link: '#3a3a3a',
  textNormal: '#b0b0b0',
  textFile: '#777',
  textHover: '#fff',
  hoverRing: '#fff',
  collapsedRing: (color: string) => color + '55',
  glow: (color: string) => color + '18',
};

function getNodeColor(node: GraphNode): string {
  if (node.type === 'root') return PALETTE.root;
  if (node.type === 'file') return PALETTE.file;
  const depth = node.depth || 1;
  return PALETTE.tagColors[Math.min(depth - 1, PALETTE.tagColors.length - 1)];
}

function getNodeSize(node: GraphNode): number {
  if (node.type === 'root') return 6;
  if (node.type === 'file') return 2;
  return 3.5;
}

// ---- Tag 树构建 ----

/** 从 metadataCache 构建 tag 树 */
export function buildTagTree(app: App, folderFilter?: string): RawTreeNode {
  const tagMap = new Map<string, Set<{ name: string; path: string }>>();

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

    const tags: string[] = [];

    // frontmatter tags
    const fmTags = cache.frontmatter?.tags;
    if (Array.isArray(fmTags)) {
      for (const t of fmTags) {
        if (typeof t === 'string' && t.trim()) tags.push(t.trim());
      }
    } else if (typeof fmTags === 'string' && fmTags.trim()) {
      tags.push(fmTags.trim());
    }

    // inline #tags
    if (cache.tags) {
      for (const t of cache.tags) {
        const clean = t.tag.replace(/^#/, '');
        if (clean) tags.push(clean);
      }
    }

    const fileName = file.basename;
    for (const tag of tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, new Set());
      tagMap.get(tag)!.add({ name: fileName, path: file.path });
    }
  }

  // 构建层级树
  const root: RawTreeNode = {
    id: 'root',
    name: folderFilter || '全部笔记',
    type: 'root',
    children: [],
  };

  // 按 tag 名构建嵌套结构
  const nodeIndex = new Map<string, RawTreeNode>();
  nodeIndex.set('root', root);

  // 排序 tag 确保父节点先创建
  const sortedTags = [...tagMap.keys()].sort();

  for (const fullTag of sortedTags) {
    const parts = fullTag.split('/');
    let parentId = 'root';

    for (let i = 0; i < parts.length; i++) {
      const partialTag = parts.slice(0, i + 1).join('/');
      const nodeId = 'tag:' + partialTag;

      if (!nodeIndex.has(nodeId)) {
        const node: RawTreeNode = {
          id: nodeId,
          name: parts[i],
          type: 'tag',
          fullTag: partialTag,
          children: [],
          files: [],
          filePaths: [],
        };
        nodeIndex.set(nodeId, node);

        const parent = nodeIndex.get(parentId)!;
        if (!parent.children) parent.children = [];
        parent.children.push(node);
      }

      parentId = nodeId;
    }

    // 将文件附加到最深层节点
    const leafNode = nodeIndex.get('tag:' + fullTag)!;
    const fileSet = tagMap.get(fullTag)!;
    for (const f of fileSet) {
      if (!leafNode.files!.includes(f.name)) {
        leafNode.files!.push(f.name);
        leafNode.filePaths!.push(f.path);
      }
    }
  }

  return root;
}

/** 从树中构建 id → node 索引 */
function indexTree(node: RawTreeNode, index: Map<string, RawTreeNode>): void {
  index.set(node.id, node);
  if (node.children) node.children.forEach(ch => indexTree(ch, index));
}

// ---- 脑图引擎类 ----

export interface TagMindMapOptions {
  /** 点击文件节点 */
  onFileClick?: (filePath: string) => void;
}

export class TagMindMap {
  private container: HTMLElement;
  private app: App;
  private options: TagMindMapOptions;
  private graph: ForceGraphInstance | null = null;
  private rawTree: RawTreeNode | null = null;
  private treeIndex = new Map<string, RawTreeNode>();
  private expanded = new Set<string>();
  private hoverNode: GraphNode | null = null;
  private statsCallback?: (stats: { nodes: number; tags: number; files: number }) => void;

  constructor(container: HTMLElement, app: App, options: TagMindMapOptions = {}) {
    this.container = container;
    this.app = app;
    this.options = options;
  }

  /** 设置统计回调 */
  onStats(cb: (stats: { nodes: number; tags: number; files: number }) => void): void {
    this.statsCallback = cb;
  }

  /** 渲染脑图 */
  render(folderFilter?: string): void {
    this.rawTree = buildTagTree(this.app, folderFilter);
    this.treeIndex.clear();
    indexTree(this.rawTree, this.treeIndex);

    // 初始展开 root + 一级 tag
    this.expanded.clear();
    this.expanded.add('root');
    if (this.rawTree.children) {
      for (const ch of this.rawTree.children) {
        this.expanded.add(ch.id);
      }
    }

    const data = this.buildGraphData();

    this.graph = ForceGraph()(this.container)
      .graphData(data)
      .backgroundColor(PALETTE.bg)
      .width(this.container.clientWidth)
      .height(this.container.clientHeight)
      .nodeId('id')
      .nodeRelSize(1)
      .nodeVal((n: any) => getNodeSize(n))
      .nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
        this.drawNode(node, ctx, globalScale);
      })
      .nodeCanvasObjectMode(() => 'replace')
      .linkColor(() => PALETTE.link)
      .linkWidth(0.6)
      .onNodeHover((node: any) => {
        this.hoverNode = node;
        this.container.style.cursor = node ? 'pointer' : 'default';
      })
      .onNodeClick((node: any) => {
        this.handleClick(node);
      })
      .nodePointerAreaPaint((node: any, color: string, ctx: CanvasRenderingContext2D) => {
        const r = Math.max(getNodeSize(node) + 4, 8);
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
      })
      .warmupTicks(100)
      .cooldownTicks(200);

    // 力参数
    const charge = this.graph.d3Force('charge');
    if (charge && (charge as any).strength) (charge as any).strength(-120);

    const link = this.graph.d3Force('link');
    if (link) {
      if ((link as any).distance) (link as any).distance(50);
      if ((link as any).strength) (link as any).strength(0.8);
    }

    // 延迟 zoomToFit
    setTimeout(() => { if (this.graph) this.graph.zoomToFit(400, 60); }, 1500);
    setTimeout(() => { if (this.graph) this.graph.zoomToFit(400, 60); }, 3000);

    // 响应式
    const resizeObs = new ResizeObserver(() => {
      if (this.graph) {
        this.graph.width(this.container.clientWidth).height(this.container.clientHeight);
      }
    });
    resizeObs.observe(this.container);

    this.updateStats();
  }

  /** 销毁 */
  destroy(): void {
    if (this.graph) {
      this.graph._destructor?.();
      this.graph = null;
    }
    this.container.innerHTML = '';
  }

  /** 展开全部 */
  expandAll(): void {
    if (!this.rawTree) return;
    const markAll = (node: RawTreeNode) => {
      if (node.type !== 'file') this.expanded.add(node.id);
      if (node.children) node.children.forEach(markAll);
    };
    markAll(this.rawTree);
    if (this.graph) {
      this.graph.graphData(this.buildGraphData());
      this.updateStats();
      setTimeout(() => this.graph?.zoomToFit(400, 40), 800);
    }
  }

  /** 折叠全部 */
  collapseAll(): void {
    this.expanded.clear();
    this.expanded.add('root');
    if (this.graph) {
      this.graph.graphData(this.buildGraphData());
      this.updateStats();
      setTimeout(() => this.graph?.zoomToFit(400, 60), 800);
    }
  }

  /** 适应视口 */
  zoomToFit(): void {
    if (this.graph) this.graph.zoomToFit(400, 40);
  }

  /** 放大 */
  zoomIn(factor = 1.4): void {
    if (!this.graph) return;
    const z = this.graph.zoom();
    this.graph.zoom(z * factor, 250);
  }

  /** 缩小 */
  zoomOut(factor = 1.4): void {
    if (!this.graph) return;
    const z = this.graph.zoom();
    this.graph.zoom(z / factor, 250);
  }

  // ---- 内部方法 ----

  private buildGraphData(): { nodes: GraphNode[]; links: GraphLink[] } {
    const nodes: GraphNode[] = [];
    const links: GraphLink[] = [];

    const walk = (src: RawTreeNode, parentId: string | null, depth: number) => {
      const hasKids = !!(
        (src.children && src.children.length > 0) ||
        (src.files && src.files.length > 0)
      );
      const isOpen = this.expanded.has(src.id);

      nodes.push({
        id: src.id,
        name: src.name,
        type: src.type,
        depth,
        fullTag: src.fullTag,
        _src: src,
        _hasKids: hasKids,
        _open: isOpen,
      });

      if (parentId != null) {
        links.push({ source: parentId, target: src.id });
      }

      if (isOpen) {
        if (src.children) {
          for (const ch of src.children) walk(ch, src.id, depth + 1);
        }
        if (src.files && src.filePaths) {
          for (let i = 0; i < src.files.length; i++) {
            const fid = 'file:' + src.filePaths[i];
            nodes.push({
              id: fid,
              name: src.files[i],
              type: 'file',
              depth: depth + 1,
              filePath: src.filePaths[i],
              _src: null,
              _hasKids: false,
              _open: false,
            });
            links.push({ source: src.id, target: fid });
          }
        }
      }
    };

    if (this.rawTree) walk(this.rawTree, null, 0);
    return { nodes, links };
  }

  private handleClick(node: GraphNode): void {
    if (node.type === 'file') {
      if (node.filePath) {
        this.options.onFileClick?.(node.filePath);
      }
      return;
    }
    if (!node._hasKids) return;

    if (node._open) {
      this.collapseNode(node);
    } else {
      this.expandNode(node);
    }
    this.updateStats();
  }

  private expandNode(parentNode: GraphNode): void {
    const src = parentNode._src || this.treeIndex.get(parentNode.id);
    if (!src) return;

    this.expanded.add(parentNode.id);
    parentNode._open = true;

    const { nodes, links } = this.graph!.graphData() as { nodes: GraphNode[]; links: GraphLink[] };
    const px = parentNode.x || 0;
    const py = parentNode.y || 0;
    const depth = (parentNode.depth || 0) + 1;

    const toAdd: GraphNode[] = [];

    if (src.children) {
      for (const ch of src.children) {
        const hasKids = !!((ch.children && ch.children.length > 0) || (ch.files && ch.files.length > 0));
        toAdd.push({
          id: ch.id, name: ch.name, type: ch.type, depth,
          fullTag: ch.fullTag, _src: ch, _hasKids: hasKids, _open: false,
          x: px + (Math.random() - 0.5) * 40,
          y: py + (Math.random() - 0.5) * 40,
          vx: 0, vy: 0,
        });
      }
    }

    if (src.files && src.filePaths) {
      for (let i = 0; i < src.files.length; i++) {
        toAdd.push({
          id: 'file:' + src.filePaths[i], name: src.files[i], type: 'file', depth,
          filePath: src.filePaths[i], _src: null, _hasKids: false, _open: false,
          x: px + (Math.random() - 0.5) * 40,
          y: py + (Math.random() - 0.5) * 40,
          vx: 0, vy: 0,
        });
      }
    }

    const newLinks = toAdd.map(n => ({ source: parentNode.id, target: n.id }));
    nodes.push(...toAdd);
    links.push(...newLinks);
    this.graph!.graphData({ nodes, links });
  }

  private collapseNode(parentNode: GraphNode): void {
    this.expanded.delete(parentNode.id);
    parentNode._open = false;

    const { nodes, links } = this.graph!.graphData() as { nodes: GraphNode[]; links: GraphLink[] };

    // 构建 parent→children 索引
    const childMap: Record<string, string[]> = {};
    for (const link of links) {
      const sid = typeof link.source === 'object' ? (link.source as GraphNode).id : link.source;
      const tid = typeof link.target === 'object' ? (link.target as GraphNode).id : link.target;
      if (!childMap[sid]) childMap[sid] = [];
      childMap[sid].push(tid);
    }

    // BFS 收集后代
    const removeIds = new Set<string>();
    const queue = [parentNode.id];
    while (queue.length > 0) {
      const pid = queue.shift()!;
      for (const kid of (childMap[pid] || [])) {
        if (kid !== parentNode.id) {
          removeIds.add(kid);
          this.expanded.delete(kid);
          queue.push(kid);
        }
      }
    }

    const newNodes = nodes.filter(n => !removeIds.has(n.id));
    const newLinks = links.filter(l => {
      const sid = typeof l.source === 'object' ? (l.source as GraphNode).id : l.source;
      const tid = typeof l.target === 'object' ? (l.target as GraphNode).id : l.target;
      return !removeIds.has(sid) && !removeIds.has(tid);
    });

    this.graph!.graphData({ nodes: newNodes, links: newLinks });
  }

  private drawNode(node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number): void {
    const r = getNodeSize(node);
    const color = getNodeColor(node);
    const isHover = node === this.hoverNode;

    // 光晕
    if (node.type !== 'file') {
      ctx.beginPath();
      ctx.arc(node.x!, node.y!, r + 2, 0, 2 * Math.PI);
      ctx.fillStyle = PALETTE.glow(color);
      ctx.fill();
    }

    // 圆点
    ctx.beginPath();
    ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();

    // hover 高亮
    if (isHover) {
      ctx.beginPath();
      ctx.arc(node.x!, node.y!, r + 1.5, 0, 2 * Math.PI);
      ctx.strokeStyle = PALETTE.hoverRing;
      ctx.lineWidth = 1.2 / globalScale;
      ctx.stroke();
    }

    // 未展开的可展开节点 — 虚线外圈
    if (node._hasKids && !node._open) {
      ctx.beginPath();
      ctx.arc(node.x!, node.y!, r + 3.5, 0, 2 * Math.PI);
      ctx.strokeStyle = PALETTE.collapsedRing(color);
      ctx.lineWidth = 0.8 / globalScale;
      ctx.setLineDash([2 / globalScale, 2 / globalScale]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 文字
    const isFile = node.type === 'file';
    const fontSize = isFile
      ? Math.max(8, 10 / globalScale)
      : Math.max(9, Math.min(14, 12 / globalScale));
    const fontWeight = node.type === 'root' ? 'bold ' : '';
    ctx.font = `${fontWeight}${fontSize}px -apple-system, BlinkMacSystemFont, 'Inter', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = isFile
      ? PALETTE.textFile
      : (isHover ? PALETTE.textHover : PALETTE.textNormal);
    ctx.fillText(node.name, node.x!, node.y! + r + 3);
  }

  private updateStats(): void {
    if (!this.statsCallback || !this.graph) return;
    const { nodes } = this.graph.graphData() as { nodes: GraphNode[] };
    let tags = 0, files = 0;
    for (const n of nodes) {
      if (n.type === 'tag') tags++;
      if (n.type === 'file') files++;
    }
    this.statsCallback({ nodes: nodes.length, tags, files });
  }
}
