import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { setIcon } from 'obsidian';
import type MECEPlugin from '../../main';
import type { TaxonomyNode, TaxonomySchema } from '../../types';
import { VAULT_SCOPE_KEY } from '../../types';
import { ForceGraphView } from './ForceGraphView';
import { EmptyState } from './EmptyState';
import { UnifiedOrganizer } from './UnifiedOrganizer';

// ============================================================
// TagMapPanel — Tag 面板主容器
// 整理笔记（默认视图） + 脑图浏览（切换视图）
// ============================================================

interface TagMapPanelProps {
  plugin: MECEPlugin;
}

type ViewMode = 'organize' | 'graph';

/**
 * 聚合 Vault scope 下所有子目录的 schema
 * 返回一个只读的虚拟 schema：root="全部"，每个子目录是一级分类
 * 同时返回 scopes 列表，供 UnifiedOrganizer 对笔记 tag 做前缀补齐
 */
function buildAggregatedTaxonomy(plugin: MECEPlugin): {
  taxonomy: TaxonomySchema;
  scopes: Array<{ folderPath: string; displayName: string }>;
} | null {
  const allScopes = plugin.storeManager.listScopes().filter(s => s !== VAULT_SCOPE_KEY);
  if (allScopes.length === 0) return null;

  const nodes: TaxonomyNode[] = [];
  const scopes: Array<{ folderPath: string; displayName: string }> = [];
  let latest = 0;
  for (const scope of allScopes) {
    const sub = plugin.storeManager.getTaxonomy(scope);
    if (!sub) continue;
    const subName = sub.rootName || scope.split('/').pop() || scope;

    // 把子 schema 的 nodes 搬到以 scope 命名的一级分类下
    // 重新计算 fullPath：从 subName 开始
    const rewrittenChildren = sub.nodes.map(n => rewritePaths(n, subName));

    nodes.push({
      id: `scope:${scope}`,
      name: subName,
      fullPath: subName,
      description: `来自「${scope}」的分类`,
      children: rewrittenChildren,
    });

    scopes.push({ folderPath: scope, displayName: subName });

    const ts = new Date(sub.updatedAt).getTime();
    if (ts > latest) latest = ts;
  }

  if (nodes.length === 0) return null;

  return {
    taxonomy: {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date(latest || Date.now()).toISOString(),
      maxDepth: 3,
      rootName: '全部',
      nodes,
    },
    scopes,
  };
}

function rewritePaths(node: TaxonomyNode, parentPath: string): TaxonomyNode {
  const fullPath = `${parentPath}/${node.name}`;
  return {
    ...node,
    fullPath,
    children: (node.children || []).map(c => rewritePaths(c, fullPath)),
  };
}

export function TagMapPanel({ plugin }: TagMapPanelProps) {
  const [stats, setStats] = useState({ nodes: 0, tags: 0, files: 0 });
  const [view, setView] = useState<ViewMode>('organize');
  const [folderFilter, setFolderFilter] = useState<string | undefined>(plugin.targetFolder);
  const [tick, setTick] = useState(0);
  const app = plugin.app;

  useEffect(() => {
    const onChange = () => setTick(t => t + 1);
    app.workspace.on('layout-change', onChange);
    return () => { app.workspace.off('layout-change', onChange); };
  }, [app]);

  const settings = plugin.settings;

  // 尝试拿直接的 schema
  const directTaxonomy = plugin.storeManager.getTaxonomy(folderFilter);

  // Vault scope 下没有直接 schema，尝试聚合子目录的
  const aggregated = useMemo(() => {
    if (folderFilter) return null;  // 只有 Vault scope 才聚合
    if (directTaxonomy) return null;
    return buildAggregatedTaxonomy(plugin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderFilter, directTaxonomy, tick]);

  const taxonomy = directTaxonomy || aggregated?.taxonomy || null;
  const isAggregated = !directTaxonomy && !!aggregated;
  const hasSchema = taxonomy !== null;

  const isAIConfigured = settings.aiProvider === 'ollama'
    ? !!(settings.ollamaHost && settings.ollamaHost.trim())
    : !!(settings.apiKey && settings.apiKey.trim());

  const providerNames: Record<string, string> = { ollama: 'Ollama', openai: 'OpenAI', claude: 'Claude', deepseek: 'DeepSeek' };
  const providerName = providerNames[settings.aiProvider] || settings.aiProvider;
  const providerLabel = `${providerName} · ${settings.model || '默认模型'}`;

  const openSettings = useCallback(() => {
    (app as any).setting?.open();
    setTimeout(() => {
      (app as any).setting?.openTabById?.('obsidian-mece-knowledge');
    }, 100);
  }, [app]);

  const handleFileOpen = useCallback((filePath: string) => {
    app.workspace.openLinkText(filePath, '', false);
  }, [app]);

  const handleFolderChange = useCallback((folder: string | undefined) => {
    setFolderFilter(folder);
    plugin.targetFolder = folder;
  }, [plugin]);

  const chooseFolder = useCallback(() => {
    plugin.chooseFolderThen((folder) => {
      handleFolderChange(folder?.path || undefined);
    });
  }, [plugin, handleFolderChange]);

  const handleSchemaChange = useCallback(async (newNodes: TaxonomyNode[]) => {
    if (!taxonomy || isAggregated) return;  // 聚合视图只读
    const updated = {
      ...taxonomy,
      nodes: newNodes,
      updatedAt: new Date().toISOString(),
    };
    await plugin.storeManager.setTaxonomy(folderFilter, updated);
    setTick(t => t + 1);
  }, [taxonomy, plugin, folderFilter, isAggregated]);

  const handleRootRename = useCallback(async (newName: string) => {
    if (!taxonomy || isAggregated) return;
    const updated = {
      ...taxonomy,
      rootName: newName,
      updatedAt: new Date().toISOString(),
    };
    await plugin.storeManager.setTaxonomy(folderFilter, updated);
    setTick(t => t + 1);
  }, [taxonomy, plugin, folderFilter, isAggregated]);

  // ---- 没配 AI 或没 Schema → 空状态 ----
  if (!isAIConfigured || !hasSchema) {
    return (
      <div className="mece-panel-root">
        <TopBar
          isAIConfigured={isAIConfigured}
          providerLabel={providerLabel}
          folderFilter={folderFilter}
          onChooseFolder={chooseFolder}
          onOpenSettings={openSettings}
        />
        <EmptyState
          isAIConfigured={isAIConfigured}
          hasSchema={hasSchema}
          providerLabel={providerLabel}
          folderLabel={folderFilter ? folderFilter.split('/').pop() || folderFilter : '整个 Vault'}
          onOpenSettings={openSettings}
          onGenerateSchema={() => plugin.generateSchema(true)}
        />
      </div>
    );
  }

  // ---- 有 Schema → 主整理器 + 视图切换 ----
  return (
    <div className="mece-panel-root">
      <TopBar
        isAIConfigured={isAIConfigured}
        providerLabel={providerLabel}
        folderFilter={folderFilter}
        onChooseFolder={chooseFolder}
        onOpenSettings={openSettings}
      />
      <div className="mece-view-tabs">
        <button
          className={`mece-view-tab ${view === 'organize' ? 'mece-view-tab-active' : ''}`}
          onClick={() => setView('organize')}
        >
          大纲
        </button>
        <button
          className={`mece-view-tab ${view === 'graph' ? 'mece-view-tab-active' : ''}`}
          onClick={() => setView('graph')}
        >
          脑图
        </button>
      </div>

      {isAggregated && (
        <div className="mece-aggregated-hint">
          聚合视图：汇总所有子目录的分类。若要编辑分类，请切换到对应子目录。
        </div>
      )}

      {view === 'organize' ? (
        <UnifiedOrganizer
          app={app}
          taxonomy={taxonomy}
          folderFilter={folderFilter}
          readOnly={isAggregated}
          aggregateScopes={aggregated?.scopes}
          onSchemaChange={handleSchemaChange}
          onRootRename={handleRootRename}
          onAIReorganize={isAggregated ? undefined : () => plugin.generateSchema(true)}
          onFileOpen={handleFileOpen}
        />
      ) : (
        <ForceGraphView
          app={app}
          folderFilter={folderFilter}
          onFileClick={handleFileOpen}
          onStats={setStats}
        />
      )}
    </div>
  );
}

// ---- 顶部状态栏 ----

// ---- 小工具：脱管 DOM 承载 Obsidian SVG icon，避开 React 对账问题 ----

function IconHost({ icon, className, style }: { icon: string; className?: string; style?: React.CSSProperties }) {
  const innerRef = useRef<HTMLSpanElement | null>(null);

  const setHost = (host: HTMLSpanElement | null) => {
    if (!host) return;
    if (!innerRef.current) {
      innerRef.current = document.createElement('span');
      innerRef.current.style.display = 'inline-flex';
    }
    if (innerRef.current.parentNode !== host) {
      host.appendChild(innerRef.current);
    }
    innerRef.current.innerHTML = '';
    setIcon(innerRef.current, icon);
  };

  useEffect(() => {
    if (innerRef.current) {
      innerRef.current.innerHTML = '';
      setIcon(innerRef.current, icon);
    }
  }, [icon]);

  return <span ref={setHost} className={className} style={style} />;
}

function TopBar({ isAIConfigured, providerLabel, folderFilter, onChooseFolder, onOpenSettings }: {
  isAIConfigured: boolean;
  providerLabel: string;
  folderFilter: string | undefined;
  onChooseFolder: () => void;
  onOpenSettings: () => void;
}) {
  const folderLabel = folderFilter
    ? folderFilter.split('/').pop() || folderFilter
    : '整个 Vault';

  return (
    <div className={`mece-ai-status ${isAIConfigured ? 'mece-ai-status-ok' : 'mece-ai-status-warn'}`}>
      <span className="mece-ai-status-text">
        {isAIConfigured ? providerLabel : '未配置 AI'}
      </span>
      <button
        className="mece-topbar-folder"
        onClick={onChooseFolder}
        title={folderFilter || '选择范围：整个 Vault'}
        aria-label="选择文件夹范围"
      >
        <IconHost icon="folder" className="mece-topbar-folder-icon" />
        <span className="mece-topbar-folder-label">{folderLabel}</span>
      </button>
      <button className="mece-ai-status-action" onClick={onOpenSettings} title="插件设置" aria-label="设置">
        <IconHost icon="settings" />
      </button>
    </div>
  );
}
