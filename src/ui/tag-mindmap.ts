import { App, TFile } from 'obsidian';
import ForceGraph, { ForceGraphInstance } from 'force-graph';
import { forceCollide } from 'd3-force';

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
// 从 Obsidian CSS 变量读取主题色，确保亮/暗主题一致
interface ThemePalette {
  bg: string;
  accent: string;           // interactive-accent
  accentHover: string;      // interactive-accent-hover
  textNormal: string;
  textMuted: string;
  textFaint: string;
  border: string;
  /** 生成 accent 色 alpha 变体 */
  accentAlpha: (alpha: number) => string;
  /** 层级衰减后的 accent 色（depth=1 最深，越深越浅） */
  tagColor: (depth: number) => string;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.trim().match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function readTheme(): ThemePalette {
  const css = getComputedStyle(document.body);
  const pick = (v: string, fallback: string) => (css.getPropertyValue(v).trim() || fallback);

  const bg = pick('--background-primary', '#202020');
  const accent = pick('--interactive-accent', '#7f6df2');
  const accentHover = pick('--interactive-accent-hover', accent);
  const textNormal = pick('--text-normal', '#dcddde');
  const textMuted = pick('--text-muted', '#999');
  const textFaint = pick('--text-faint', '#666');
  const border = pick('--background-modifier-border', '#3a3a3a');

  const rgb = hexToRgb(accent) || [127, 109, 242];

  const accentAlpha = (alpha: number) =>
    `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;

  // 层级色：accent 主色做饱和度 + 透明度梯度，而不是四种不同色相
  // depth 1: 100% 主色；depth 2: 85%；depth 3+: 65%
  const tagColor = (depth: number) => {
    const d = Math.max(1, Math.min(depth, 4));
    const alpha = [0, 0.95, 0.80, 0.65, 0.55][d];
    return accentAlpha(alpha);
  };

  return { bg, accent, accentHover, textNormal, textMuted, textFaint, border, accentAlpha, tagColor };
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
  private theme: ThemePalette = readTheme();

  constructor(container: HTMLElement, app: App, options: TagMindMapOptions = {}) {
    this.container = container;
    this.app = app;
    this.options = options;
  }

  /** 设置统计回调 */
  onStats(cb: (stats: { nodes: number; tags: number; files: number }) => void): void {
    this.statsCallback = cb;
  }

  /** 节点颜色 */
  private getNodeColor(node: GraphNode): string {
    if (node.type === 'root') return this.theme.accent;
    if (node.type === 'file') return this.theme.border;
    return this.theme.tagColor(node.depth || 1);
  }

  /** 节点半径 */
  private getNodeSize(node: GraphNode): number {
    if (node.type === 'root') return 10;
    if (node.type === 'file') return 2.5;
    const d = node.depth || 1;
    // 一级分类最大，逐层递减
    return [0, 6, 5, 4][Math.min(d, 3)];
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

    // 每次渲染重新读取主题（Obsidian 切主题时调用）
    this.theme = readTheme();

    const data = this.buildGraphData();

    this.graph = ForceGraph()(this.container)
      .graphData(data)
      .backgroundColor(this.theme.bg)
      .width(this.container.clientWidth)
      .height(this.container.clientHeight)
      .nodeId('id')
      .nodeRelSize(1)
      .nodeVal((n: any) => this.getNodeSize(n))
      .nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
        this.drawNode(node, ctx, globalScale);
      })
      .nodeCanvasObjectMode(() => 'replace')
      .linkColor((l: any) => {
        // hover 的节点相连的 link 用 accent 高亮
        if (this.hoverNode) {
          const s = typeof l.source === 'object' ? l.source : null;
          const t = typeof l.target === 'object' ? l.target : null;
          if (s === this.hoverNode || t === this.hoverNode) {
            return this.theme.accentAlpha(0.5);
          }
        }
        return this.theme.accentAlpha(0.15);
      })
      .linkWidth((l: any) => {
        if (this.hoverNode) {
          const s = typeof l.source === 'object' ? l.source : null;
          const t = typeof l.target === 'object' ? l.target : null;
          if (s === this.hoverNode || t === this.hoverNode) return 1.5;
        }
        return 0.8;
      })
      .onNodeHover((node: any) => {
        this.hoverNode = node;
        this.container.style.cursor = node ? 'pointer' : 'default';
      })
      .onNodeClick((node: any) => {
        this.handleClick(node);
      })
      .nodePointerAreaPaint((node: any, color: string, ctx: CanvasRenderingContext2D) => {
        const r = Math.max(this.getNodeSize(node) + 4, 10);
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
      })
      .warmupTicks(120)
      .cooldownTicks(250);

    // ---- 力参数：差异化，确保层级间距合理，叶子不飞 ----
    const charge = this.graph.d3Force('charge');
    if (charge && (charge as any).strength) {
      (charge as any).strength((node: GraphNode) => {
        if (node.type === 'root') return -800;
        if (node.type === 'file') return -60;
        const d = node.depth || 1;
        if (d === 1) return -350;   // 一级分类：强斥力，把分类推开
        if (d === 2) return -200;
        return -120;
      });
    }

    const link = this.graph.d3Force('link');
    if (link) {
      if ((link as any).distance) {
        (link as any).distance((l: GraphLink) => {
          const target = typeof l.target === 'object' ? (l.target as GraphNode) : null;
          if (!target) return 50;
          if (target.type === 'file') return 28;
          const d = target.depth || 1;
          if (d === 1) return 110;  // root → 一级：大
          if (d === 2) return 60;
          return 40;
        });
      }
      if ((link as any).strength) (link as any).strength(0.6);
    }

    // 防重叠：按节点大小做圆形碰撞
    this.graph.d3Force('collide', forceCollide((n: any) => {
      if (n.type === 'root') return 36;
      if (n.type === 'file') return 16;
      const d = n.depth || 1;
      return [0, 28, 22, 18][Math.min(d, 3)];
    }).strength(0.85).iterations(2));

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
    this.container.replaceChildren();
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
    const seenIds = new Set<string>();

    const walk = (src: RawTreeNode, parentId: string | null, depth: number) => {
      const hasKids = !!(
        (src.children && src.children.length > 0) ||
        (src.files && src.files.length > 0)
      );
      const isOpen = this.expanded.has(src.id);

      // tag / root 节点去重（同一 id 不重复 push，force-graph 否则会产生幽灵节点）
      if (!seenIds.has(src.id)) {
        seenIds.add(src.id);
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
      }

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
            // 笔记节点去重：同一文件即使被多个 tag 引用，也只建一个节点
            // 但保留所有 tag→file 的连线（视觉上表现为一个笔记连到多个分类）
            if (!seenIds.has(fid)) {
              seenIds.add(fid);
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
            }
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
    const existingIds = new Set(nodes.map(n => n.id));
    const px = parentNode.x || 0;
    const py = parentNode.y || 0;
    const depth = (parentNode.depth || 0) + 1;

    const toAdd: GraphNode[] = [];
    const newLinks: GraphLink[] = [];

    if (src.children) {
      for (const ch of src.children) {
        const hasKids = !!((ch.children && ch.children.length > 0) || (ch.files && ch.files.length > 0));
        if (!existingIds.has(ch.id)) {
          toAdd.push({
            id: ch.id, name: ch.name, type: ch.type, depth,
            fullTag: ch.fullTag, _src: ch, _hasKids: hasKids, _open: false,
            x: px + (Math.random() - 0.5) * 40,
            y: py + (Math.random() - 0.5) * 40,
            vx: 0, vy: 0,
          });
          existingIds.add(ch.id);
        }
        newLinks.push({ source: parentNode.id, target: ch.id });
      }
    }

    if (src.files && src.filePaths) {
      for (let i = 0; i < src.files.length; i++) {
        const fid = 'file:' + src.filePaths[i];
        if (!existingIds.has(fid)) {
          toAdd.push({
            id: fid, name: src.files[i], type: 'file', depth,
            filePath: src.filePaths[i], _src: null, _hasKids: false, _open: false,
            x: px + (Math.random() - 0.5) * 40,
            y: py + (Math.random() - 0.5) * 40,
            vx: 0, vy: 0,
          });
          existingIds.add(fid);
        }
        newLinks.push({ source: parentNode.id, target: fid });
      }
    }

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
    // 同时统计每个节点有多少入边（多 tag 节点会有 >1 入边）
    const inDegree: Record<string, number> = {};
    for (const link of links) {
      const sid = typeof link.source === 'object' ? (link.source as GraphNode).id : link.source;
      const tid = typeof link.target === 'object' ? (link.target as GraphNode).id : link.target;
      if (!childMap[sid]) childMap[sid] = [];
      childMap[sid].push(tid);
      inDegree[tid] = (inDegree[tid] || 0) + 1;
    }

    // BFS 收集要被"此次折叠"断开的边
    // 关键：被共享的 file 节点（入度 >1）不应删除整个节点，仅断开来自本分支的 link
    const removeIds = new Set<string>();
    const linksToCut = new Set<string>();  // 记录 sourceId::targetId
    const queue: string[] = [parentNode.id];

    while (queue.length > 0) {
      const pid = queue.shift()!;
      for (const kid of (childMap[pid] || [])) {
        if (kid === parentNode.id) continue;
        // 该节点被多个父节点引用 → 只切断本分支来的那条 link，节点本身保留
        if (inDegree[kid] > 1) {
          linksToCut.add(`${pid}::${kid}`);
          continue;
        }
        removeIds.add(kid);
        this.expanded.delete(kid);
        queue.push(kid);
      }
    }

    const newNodes = nodes.filter(n => !removeIds.has(n.id));
    const newLinks = links.filter(l => {
      const sid = typeof l.source === 'object' ? (l.source as GraphNode).id : l.source;
      const tid = typeof l.target === 'object' ? (l.target as GraphNode).id : l.target;
      if (removeIds.has(sid) || removeIds.has(tid)) return false;
      if (linksToCut.has(`${sid}::${tid}`)) return false;
      return true;
    });

    this.graph!.graphData({ nodes: newNodes, links: newLinks });
  }

  private drawNode(node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number): void {
    const r = this.getNodeSize(node);
    const color = this.getNodeColor(node);
    const isHover = node === this.hoverNode;
    const t = this.theme;

    // ---- 节点圆点 ----
    if (node.type === 'root') {
      // root：大实心圆 + 细边
      ctx.beginPath();
      ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      // 内环装饰
      ctx.beginPath();
      ctx.arc(node.x!, node.y!, r - 3, 0, 2 * Math.PI);
      ctx.strokeStyle = t.bg;
      ctx.lineWidth = 1.5 / globalScale;
      ctx.stroke();
    } else if (node.type === 'file') {
      // file：小淡灰点
      ctx.beginPath();
      ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
      ctx.fillStyle = isHover ? t.accent : color;
      ctx.fill();
    } else {
      // tag：实心圆，未展开时描边提示
      ctx.beginPath();
      ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      // 未展开：外围加一个淡虚圈，表示"还有内容"
      if (node._hasKids && !node._open) {
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, r + 3, 0, 2 * Math.PI);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 1 / globalScale;
        ctx.setLineDash([2 / globalScale, 2 / globalScale]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }

    // hover：高亮外圈（accent 色）
    if (isHover) {
      ctx.beginPath();
      ctx.arc(node.x!, node.y!, r + 2, 0, 2 * Math.PI);
      ctx.strokeStyle = t.accent;
      ctx.lineWidth = 2 / globalScale;
      ctx.stroke();
    }

    // ---- 文字标签 ----
    const isFile = node.type === 'file';
    const isRoot = node.type === 'root';

    // 视口距离很远时，隐藏 file 和深层 tag 的文字，避免重叠噪声
    if (!isRoot && globalScale < 0.6) {
      if (isFile || (node.depth || 0) >= 3) return;
    }

    const fontSize = isRoot
      ? Math.max(13, Math.min(18, 15 / globalScale))
      : isFile
        ? Math.max(9, 10 / globalScale)
        : Math.max(10, Math.min(14, 12 / globalScale));
    const fontWeight = isRoot ? '600 ' : (node.depth === 1 ? '500 ' : '');
    // 用系统字体栈，兼容所有平台
    ctx.font = `${fontWeight}${fontSize}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // 文字颜色按层级和状态
    let textColor: string;
    if (isHover) {
      textColor = t.accent;
    } else if (isRoot) {
      textColor = t.textNormal;
    } else if (isFile) {
      textColor = t.textFaint;
    } else {
      textColor = (node.depth || 1) === 1 ? t.textNormal : t.textMuted;
    }

    // 文字背景（描边）：让字在密集区可读
    const text = node.name;
    ctx.lineWidth = 3 / globalScale;
    ctx.strokeStyle = t.bg;
    ctx.strokeText(text, node.x!, node.y! + r + 4);
    ctx.fillStyle = textColor;
    ctx.fillText(text, node.x!, node.y! + r + 4);
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
