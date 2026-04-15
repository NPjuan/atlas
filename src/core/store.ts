import { Plugin } from 'obsidian';
import {
  KnowledgeStore,
  KnowledgePoint,
  STORE_VERSION,
  createEmptyStore,
  LogEntry,
  LogType,
  NodeSummary,
} from '../types';

/** 生成唯一 ID */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * knowledge-store.json 读写 + schema 版本迁移
 */
export class KnowledgeStoreManager {
  private plugin: Plugin;
  private store: KnowledgeStore | null = null;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  /** 加载知识库，不存在则创建空库 */
  async load(): Promise<KnowledgeStore> {
    if (this.store) return this.store;

    const raw = await this.plugin.loadData();
    if (!raw || !raw.version) {
      // 全新或损坏的数据 → 创建空库
      this.store = createEmptyStore();
      await this.save();
      return this.store;
    }

    // schema 版本迁移
    this.store = this.migrate(raw);
    return this.store;
  }

  /** 保存知识库 */
  async save(): Promise<void> {
    if (!this.store) return;
    this.store.lastUpdated = new Date().toISOString();
    await this.plugin.saveData(this.store);
  }

  /** 获取内存中的 store（须先 load） */
  get(): KnowledgeStore | null {
    return this.store;
  }

  /** 重置（清空）知识库 */
  async reset(): Promise<KnowledgeStore> {
    this.store = createEmptyStore();
    await this.save();
    return this.store;
  }

  // ---- 操作日志便捷方法 ----

  /** 追加一条操作日志（自动截断超限记录） */
  appendLog(
    type: LogType,
    message: string,
    details?: LogEntry['details'],
    maxEntries = 500,
  ): void {
    if (!this.store) return;
    const entry: LogEntry = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      type,
      message,
      details,
    };
    this.store.logs.push(entry);
    // 超出上限时截断最早的记录
    if (this.store.logs.length > maxEntries) {
      this.store.logs = this.store.logs.slice(-maxEntries);
    }
  }

  /** 获取指定分类节点的摘要缓存 */
  getSummary(nodeId: string): NodeSummary | null {
    if (!this.store) return null;
    return this.store.summaries[nodeId] || null;
  }

  /** 设置/更新指定分类节点的摘要缓存 */
  setSummary(nodeId: string, summary: string, kpCount: number): void {
    if (!this.store) return;
    this.store.summaries[nodeId] = {
      nodeId,
      summary,
      generatedAt: new Date().toISOString(),
      kpCount,
      stale: false,
    };
  }

  /** 将指定节点的摘要标记为过期（需重新生成） */
  markSummaryStale(nodeId: string): void {
    if (!this.store) return;
    const s = this.store.summaries[nodeId];
    if (s) {
      s.stale = true;
    }
  }

  /** 批量标记受影响的分类节点摘要为 stale */
  markSummariesStaleForCategories(categoryIds: string[]): void {
    if (!this.store) return;
    for (const id of categoryIds) {
      this.markSummaryStale(id);
    }
  }

  /** 更新知识点的过期状态（纯规则检测，不消耗 AI token） */
  refreshStaleStatus(staleDays: number): number {
    if (!this.store) return 0;
    const now = Date.now();
    const threshold = staleDays * 86400000; // 天 → 毫秒
    let count = 0;
    for (const kp of this.store.knowledgePoints) {
      if (kp.evergreen) {
        kp.stale = false;
        continue;
      }
      const elapsed = now - new Date(kp.extractedAt).getTime();
      const isStale = elapsed > threshold;
      if (isStale && !kp.stale) count++;
      kp.stale = isStale;
    }
    return count;
  }

  /** 切换知识点的常青状态 */
  toggleEvergreen(kpId: string): boolean {
    if (!this.store) return false;
    const kp = this.store.knowledgePoints.find(p => p.id === kpId);
    if (!kp) return false;
    kp.evergreen = !kp.evergreen;
    if (kp.evergreen) kp.stale = false;
    return kp.evergreen;
  }

  // ---- 版本迁移 ----

  private migrate(data: any): KnowledgeStore {
    let version = data.version || 0;

    // v0 → v1: 添加 classified 字段和 document status
    if (version < 1) {
      data = this.migrateV0ToV1(data);
      version = 1;
    }

    // v1 → v2: 新增 confidence/extractedAt/relatedIds/evergreen/stale/tags/logs/summaries
    if (version < 2) {
      data = this.migrateV1ToV2(data);
      version = 2;
    }

    // 未来的迁移在此链式添加：
    // if (version < 3) { data = this.migrateV2ToV3(data); version = 3; }

    data.version = STORE_VERSION;
    return data as KnowledgeStore;
  }

  private migrateV0ToV1(data: any): any {
    // 给知识点添加 classified 字段
    if (data.knowledgePoints) {
      for (const kp of data.knowledgePoints) {
        if (kp.classified === undefined) {
          kp.classified = kp.categoryIds && kp.categoryIds.length > 0;
        }
      }
    }

    // 给文档记录添加 status 字段
    if (data.documents) {
      for (const key of Object.keys(data.documents)) {
        if (!data.documents[key].status) {
          data.documents[key].status = 'completed';
        }
      }
    }

    // 确保 categoryTree 存在
    if (!data.categoryTree) {
      data.categoryTree = {
        id: 'root',
        name: '知识库',
        level: 'root',
        children: [],
        knowledgePointIds: [],
      };
    }

    data.version = 1;
    return data;
  }

  /**
   * v1 → v2 迁移：
   * - KnowledgePoint 新增 confidence/extractedAt/relatedIds/evergreen/stale/tags
   * - KnowledgeStore 新增 logs/summaries
   * 幂等设计：重复执行不会破坏数据（跳过已有字段）
   */
  private migrateV1ToV2(data: any): any {
    // 1. 迁移知识点 — 为每个知识点填充 v2 新字段的默认值
    if (data.knowledgePoints) {
      for (const kp of data.knowledgePoints) {
        // confidence: 默认 'medium'（无法回溯原始 AI 评估）
        if (kp.confidence === undefined) {
          kp.confidence = 'medium';
        }
        // extractedAt: 尝试从对应文档的 processedAt 推断，否则用 lastUpdated
        if (kp.extractedAt === undefined) {
          const doc = data.documents?.[kp.sourceFile];
          kp.extractedAt = doc?.processedAt || data.lastUpdated || new Date().toISOString();
        }
        // relatedIds: 空数组
        if (kp.relatedIds === undefined) {
          kp.relatedIds = [];
        }
        // evergreen: 默认 false
        if (kp.evergreen === undefined) {
          kp.evergreen = false;
        }
        // stale: 默认 false（后续由 linter 规则计算）
        if (kp.stale === undefined) {
          kp.stale = false;
        }
        // tags: 空数组（无法回溯原始 frontmatter）
        if (kp.tags === undefined) {
          kp.tags = [];
        }
      }
    }

    // 2. Store 级别新增字段
    if (!data.logs) {
      data.logs = [];
    }
    if (!data.summaries) {
      data.summaries = {};
    }

    // 3. 写入迁移日志
    data.logs.push({
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
      timestamp: new Date().toISOString(),
      type: 'scan',
      message: '数据迁移 v1 → v2：为知识点补充 confidence/extractedAt/relatedIds/evergreen/stale/tags 字段，新增 logs 和 summaries',
      details: {
        pointsExtracted: data.knowledgePoints?.length || 0,
      },
    });

    data.version = 2;
    return data;
  }
}
