import * as d3 from 'd3';
import { CategoryNode, KnowledgePoint, KnowledgeStore } from '../types';

// ============================================================
// D3.js 径向思维导图 — 按需渲染 + 逐层展开 + 缩放平移
// ============================================================

/** 节点颜色方案 */
const LEVEL_COLORS: Record<string, string> = {
  root: '#8b5cf6',
  theme: '#6366f1',
  category: '#06b6d4',
  viewpoint: '#f59e0b',
};

/** 节点半径方案 */
const LEVEL_RADIUS: Record<string, number> = {
  root: 20,
  theme: 14,
  category: 10,
  viewpoint: 7,
};

/** 内部树节点（带 D3 hierarchy 兼容数据） */
interface TreeNodeData {
  id: string;
  name: string;
  level: string;
  children: TreeNodeData[];
  knowledgePointIds: string[];
  _collapsed?: boolean;
  _childrenBackup?: TreeNodeData[];
}

export interface MindMapOptions {
  /** 点击叶节点回调 */
  onNodeClick?: (nodeId: string, knowledgePointIds: string[]) => void;
  /** 点击来源链接回调 */
  onSourceClick?: (filePath: string) => void;
}

export class MindMapRenderer {
  private container: HTMLElement;
  private store: KnowledgeStore;
  private options: MindMapOptions;
  private svg!: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private g!: d3.Selection<SVGGElement, unknown, null, undefined>;
  private width = 0;
  private height = 0;

  constructor(container: HTMLElement, store: KnowledgeStore, options: MindMapOptions = {}) {
    this.container = container;
    this.store = store;
    this.options = options;
  }

  render(): void {
    this.container.empty();

    this.width = this.container.clientWidth || 800;
    this.height = this.container.clientHeight || 600;

    // 创建 SVG
    this.svg = d3
      .select(this.container)
      .append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', `${-this.width / 2} ${-this.height / 2} ${this.width} ${this.height}`);

    // 缩放/平移组
    this.g = this.svg.append('g');

    // 添加缩放行为
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 5])
      .on('zoom', (event) => {
        this.g.attr('transform', event.transform);
      });

    this.svg.call(zoom);

    // 双击重置视角
    this.svg.on('dblclick.zoom', () => {
      this.svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
    });

    // 准备树数据（初始只展开第一层）
    const treeData = this.prepareTreeData(this.store.categoryTree);
    this.collapseAll(treeData, 1); // 只展开到 theme 层

    this.update(treeData);
  }

  private prepareTreeData(node: CategoryNode): TreeNodeData {
    return {
      id: node.id,
      name: node.name,
      level: node.level,
      children: node.children.map((c) => this.prepareTreeData(c)),
      knowledgePointIds: node.knowledgePointIds,
    };
  }

  /** 递归折叠：保留 depth 层展开 */
  private collapseAll(node: TreeNodeData, keepDepth: number): void {
    if (keepDepth <= 0 && node.children.length > 0) {
      node._childrenBackup = node.children;
      node.children = [];
      node._collapsed = true;
    } else {
      node._collapsed = false;
      for (const child of node.children) {
        this.collapseAll(child, keepDepth - 1);
      }
    }
  }

  /** 切换节点展开/折叠 */
  private toggle(node: TreeNodeData): void {
    if (node._collapsed && node._childrenBackup) {
      node.children = node._childrenBackup;
      node._childrenBackup = undefined;
      node._collapsed = false;
    } else if (node.children.length > 0) {
      node._childrenBackup = node.children;
      node.children = [];
      node._collapsed = true;
    }
  }

  /** 更新渲染 */
  private update(rootData: TreeNodeData): void {
    const radius = Math.min(this.width, this.height) / 2 - 80;

    // 创建 D3 树布局（径向）
    const treeLayout = d3.tree<TreeNodeData>()
      .size([2 * Math.PI, radius])
      .separation((a, b) => (a.parent === b.parent ? 1 : 2) / a.depth);

    const root = d3.hierarchy(rootData);
    treeLayout(root);

    // 清空现有内容
    this.g.selectAll('*').remove();

    // 绘制连线
    this.g
      .selectAll('.mece-link')
      .data(root.links())
      .join('path')
      .attr('class', 'mece-link')
      .attr('d', (d: any) =>
        d3.linkRadial<any, any>()
          .angle((d: any) => d.x)
          .radius((d: any) => d.y)(d)
      )
      .attr('fill', 'none')
      .attr('stroke', '#e2e8f0')
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.6);

    // 绘制节点
    const nodeGroups = this.g
      .selectAll('.mece-node')
      .data(root.descendants())
      .join('g')
      .attr('class', (d: any) => `mece-node mece-node-${d.data.level}`)
      .attr('transform', (d: any) => `rotate(${(d.x * 180) / Math.PI - 90}) translate(${d.y}, 0)`)
      .style('cursor', 'pointer')
      .on('click', (_event: any, d: any) => {
        const nodeData = d.data as TreeNodeData;

        // 叶节点 → 触发详情面板
        if (nodeData.level === 'viewpoint' && nodeData.knowledgePointIds.length > 0) {
          this.options.onNodeClick?.(nodeData.id, nodeData.knowledgePointIds);
          return;
        }

        // 非叶节点 → 展开/折叠
        if (nodeData._collapsed || nodeData.children.length > 0 || nodeData._childrenBackup) {
          this.toggle(nodeData);
          this.update(rootData);
        }
      });

    // 节点圆圈
    nodeGroups
      .append('circle')
      .attr('r', (d: any) => LEVEL_RADIUS[d.data.level] || 8)
      .attr('fill', (d: any) => LEVEL_COLORS[d.data.level] || '#94a3b8')
      .attr('stroke', 'white')
      .attr('stroke-width', 2)
      .attr('opacity', (d: any) => (d.data._collapsed ? 0.7 : 1));

    // 折叠指示器（有子节点但已折叠时显示 +）
    nodeGroups
      .filter((d: any) => d.data._collapsed)
      .append('text')
      .attr('class', 'mece-badge')
      .attr('dy', '0.35em')
      .attr('text-anchor', 'middle')
      .attr('fill', 'white')
      .attr('font-size', '10px')
      .attr('pointer-events', 'none')
      .text((d: any) => {
        const backup = d.data._childrenBackup;
        return backup ? `+${backup.length}` : '+';
      });

    // 知识点数量 badge（viewpoint 叶节点）
    nodeGroups
      .filter((d: any) => d.data.level === 'viewpoint' && d.data.knowledgePointIds.length > 0)
      .append('text')
      .attr('class', 'mece-badge')
      .attr('dy', '0.35em')
      .attr('text-anchor', 'middle')
      .attr('fill', 'white')
      .attr('font-size', '8px')
      .attr('pointer-events', 'none')
      .text((d: any) => d.data.knowledgePointIds.length);

    // 节点文字标签
    nodeGroups
      .append('text')
      .attr('dy', '0.31em')
      .attr('x', (d: any) => ((d.x < Math.PI) === !d.children ? 6 : -6) + (LEVEL_RADIUS[d.data.level] || 8))
      .attr('text-anchor', (d: any) => ((d.x < Math.PI) === !d.children ? 'start' : 'end'))
      .attr('transform', (d: any) => (d.x >= Math.PI ? 'rotate(180)' : null))
      .attr('fill', 'var(--text-normal)')
      .attr('font-size', (d: any) => {
        if (d.data.level === 'root') return '14px';
        if (d.data.level === 'theme') return '12px';
        return '11px';
      })
      .attr('font-weight', (d: any) => (d.data.level === 'root' || d.data.level === 'theme' ? 'bold' : 'normal'))
      .text((d: any) => {
        const name = d.data.name;
        return name.length > 15 ? name.slice(0, 15) + '...' : name;
      })
      .append('title')
      .text((d: any) => d.data.name);
  }

  /** 销毁 */
  destroy(): void {
    this.container.empty();
  }
}
