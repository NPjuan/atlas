import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { setIcon, Menu } from 'obsidian';
import type MECEPlugin from '../../main';
import type { TaxonomyNode, AIProviderType } from '../../types';
import { getApiKey, setModel, switchProvider } from '../../types';
import { findScopeNode, buildScopeViewSchema, replaceScopeNode } from '../../core/taxonomy-scope';
import { t, useLocale } from '../../i18n';
import { ForceGraphView } from './ForceGraphView';
import { EmptyState } from './EmptyState';
import { UnifiedOrganizer } from './UnifiedOrganizer';

// ============================================================
// TagMapPanel — Tag 面板主容器
// 整理（默认视图：分类树 + 拖拽归类） + 探索（切换视图：脑图可视化）
//
// 架构：全局只有一份 taxonomy，folderFilter 只决定"展示/操作哪些笔记"
// ============================================================

interface TagMapPanelProps {
  plugin: MECEPlugin;
  /** 外部触发刷新的版本号（每次递增会导致组件重新计算 store 数据） */
  refreshKey?: number;
}

type ViewMode = 'organize' | 'graph';

export function TagMapPanel({ plugin, refreshKey = 0 }: TagMapPanelProps) {
  useLocale();  // 订阅语言变化，切换时强制重渲染
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

  // refreshKey 变化（外部 refreshView 调用）→ 触发 memo 重算
  const effectiveTick = tick + refreshKey;

  const settings = plugin.settings;

  // 全局唯一 taxonomy（useMemo 带 effectiveTick，外部刷新能重读 store）
  const rootTaxonomy = useMemo(
    () => plugin.storeManager.getTaxonomy(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plugin, effectiveTick],
  );

  // 子文件夹 scope 下：从全局 taxonomy 里找一个 fullPath 严格等于文件夹路径的一级节点，
  // 以它为视图根展示切片。未命中则 scopeNode=null（走"此文件夹无对应分类"空态）。
  const scopeNode = useMemo(() => {
    if (!folderFilter || !rootTaxonomy) return null;
    return findScopeNode(rootTaxonomy, folderFilter);
  }, [folderFilter, rootTaxonomy]);

  const isSliceMode = !!folderFilter && !!rootTaxonomy;

  // 实际传给 UnifiedOrganizer 的 schema：
  // - 无 folderFilter：直接用全局
  // - 有 folderFilter 且命中：切片视图
  // - 有 folderFilter 但未命中：null（下面会走提示空态）
  const taxonomy = useMemo(() => {
    if (!rootTaxonomy) return null;
    if (!isSliceMode) return rootTaxonomy;
    if (!scopeNode) return null;
    return buildScopeViewSchema(rootTaxonomy, scopeNode);
  }, [rootTaxonomy, isSliceMode, scopeNode]);

  const hasSchema = taxonomy !== null;

  const isAIConfigured = settings.aiProvider === 'ollama'
    ? !!(settings.ollamaHost && settings.ollamaHost.trim())
    : !!getApiKey(settings);

  const providerNames: Record<string, string> = { ollama: 'Ollama', openai: 'OpenAI', claude: 'Claude', deepseek: 'DeepSeek' };
  const providerName = providerNames[settings.aiProvider] || settings.aiProvider;
  // 模型友好名映射（只在 UI 展示；真实 id 保存在 settings.model）
  const modelFriendlyName = (id: string): string => {
    const map: Record<string, string> = {
      'claude-sonnet-4-20250514': 'Sonnet 4',
      'claude-3-5-sonnet-20241022': 'Sonnet 3.5',
      'claude-3-5-haiku-20241022': 'Haiku 3.5',
      'claude-opus-4-20250514': 'Opus 4',
      'gpt-4o': 'GPT-4o',
      'gpt-4o-mini': 'GPT-4o mini',
      'gpt-4-turbo': 'GPT-4 Turbo',
      'o1-mini': 'o1-mini',
      'deepseek-chat': 'DeepSeek Chat',
      'deepseek-reasoner': 'DeepSeek Reasoner',
    };
    return map[id] || id;
  };
  const providerLabel = `${providerName} · ${settings.model ? modelFriendlyName(settings.model) : t('panel.openDefaultModel')}`;

  const openSettings = useCallback(() => {
    (app as any).setting?.open();
    setTimeout(() => {
      (app as any).setting?.openTabById?.('atlas-knowledge');
    }, 100);
  }, [app]);

  // 点击 provider pill 弹出菜单：切换模型 / 切换 provider / 打开设置
  const openProviderMenu = useCallback((evt: React.MouseEvent) => {
    const menu = new Menu();
    const curProvider = plugin.settings.aiProvider;
    const curModel = plugin.settings.model || '';

    // ---- 当前 provider 的常用模型（label = 友好名；id = 真实模型名）----
    const modelsByProvider: Record<AIProviderType, Array<{ id: string; label: string }>> = {
      claude: [
        { id: 'claude-sonnet-4-20250514',    label: 'Sonnet 4' },
        { id: 'claude-3-5-sonnet-20241022',  label: 'Sonnet 3.5' },
        { id: 'claude-3-5-haiku-20241022',   label: 'Haiku 3.5' },
        { id: 'claude-opus-4-20250514',      label: 'Opus 4' },
      ],
      openai: [
        { id: 'gpt-4o',       label: 'GPT-4o' },
        { id: 'gpt-4o-mini',  label: 'GPT-4o mini' },
        { id: 'gpt-4-turbo',  label: 'GPT-4 Turbo' },
        { id: 'o1-mini',      label: 'o1-mini' },
      ],
      deepseek: [
        { id: 'deepseek-chat',      label: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner',  label: 'DeepSeek Reasoner' },
      ],
      ollama: [
        { id: 'qwen2.5',     label: 'Qwen 2.5' },
        { id: 'qwen2.5:14b', label: 'Qwen 2.5 (14B)' },
        { id: 'llama3.1',    label: 'Llama 3.1' },
        { id: 'llama3.2',    label: 'Llama 3.2' },
        { id: 'mistral',     label: 'Mistral' },
      ],
    };
    const models = modelsByProvider[curProvider] || [];

    menu.addItem((item) => {
      item.setTitle(t('panel.modelMenuTitle', { provider: providerNames[curProvider] || curProvider })).setIsLabel(true);
    });
    for (const m of models) {
      menu.addItem((item) => {
        item.setTitle(m.label).setChecked(m.id === curModel).onClick(async () => {
          setModel(plugin.settings, curProvider, m.id);
          await plugin.saveSettings();
        });
      });
    }

    menu.addSeparator();

    // ---- 切换 Provider（未配 key 的 provider 置灰，点击跳转到设置）----
    menu.addItem((item) => item.setTitle(t('panel.switchProvider')).setIsLabel(true));
    const providerKeys: AIProviderType[] = ['claude', 'openai', 'deepseek', 'ollama'];
    for (const p of providerKeys) {
      const needsKey = p !== 'ollama';
      const hasKey = !needsKey || !!getApiKey(plugin.settings, p);
      const label = providerNames[p] || p;
      const title = hasKey ? label : t('panel.providerNoKey', { name: label });
      menu.addItem((item) => {
        item.setTitle(title).setChecked(p === curProvider);
        if (!hasKey) item.setDisabled(true);
        item.onClick(async () => {
          if (p === curProvider) return;
          if (!hasKey) { openSettings(); return; }
          switchProvider(plugin.settings, p);
          await plugin.saveSettings();
        });
      });
    }

    menu.addSeparator();
    menu.addItem((item) => {
      item.setTitle(t('panel.openSettingsMenu')).setIcon('settings').onClick(() => openSettings());
    });

    menu.showAtMouseEvent(evt.nativeEvent);
  }, [plugin, openSettings]);

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
    if (!rootTaxonomy || !taxonomy) return;

    // 切片模式：把视图根节点（scopeNode）的 children 替换回全局 taxonomy
    if (isSliceMode && scopeNode) {
      const updated = replaceScopeNode(rootTaxonomy, scopeNode.id, taxonomy.rootName, newNodes);
      if (updated) await plugin.storeManager.setTaxonomy(updated);
      setTick(t => t + 1);
      return;
    }

    // 非切片：直接替换全局 taxonomy 的 nodes
    const updated = {
      ...rootTaxonomy,
      nodes: newNodes,
      updatedAt: new Date().toISOString(),
    };
    await plugin.storeManager.setTaxonomy(updated);
    setTick(t => t + 1);
  }, [rootTaxonomy, taxonomy, isSliceMode, scopeNode, plugin]);

  const handleRootRename = useCallback(async (newName: string) => {
    if (!rootTaxonomy || !taxonomy) return;

    // 切片模式：重命名 = 改对应一级节点的 name（并级联重写子树 fullPath）
    if (isSliceMode && scopeNode) {
      const updated = replaceScopeNode(rootTaxonomy, scopeNode.id, newName, taxonomy.nodes);
      if (updated) await plugin.storeManager.setTaxonomy(updated);
      setTick(t => t + 1);
      return;
    }

    // 非切片：改全局 taxonomy 的 rootName
    const updated = {
      ...rootTaxonomy,
      rootName: newName,
      updatedAt: new Date().toISOString(),
    };
    await plugin.storeManager.setTaxonomy(updated);
    setTick(t => t + 1);
  }, [rootTaxonomy, taxonomy, isSliceMode, scopeNode, plugin]);

  // ---- 切片未命中（全局有 schema 但当前文件夹没对应一级节点） ----
  if (isAIConfigured && rootTaxonomy && isSliceMode && !scopeNode) {
    const folderLabel = folderFilter!.split('/').pop() || folderFilter!;
    return (
      <div className="mece-panel-root">
        <TopBar
          isAIConfigured={isAIConfigured}
          providerLabel={providerLabel}
          onPickProvider={openProviderMenu}
          onOpenSettings={openSettings}
        />
        <div className="mece-empty-state">
          <h3>{t('empty.noScopeTitle')}</h3>
          <p>{t('empty.noScopeDesc', { path: folderFilter! })}</p>
          <p style={{ opacity: 0.75 }}>{t('empty.noScopeHint')}</p>
          <div className="mece-empty-footer">
            <button className="mece-btn mece-btn-primary" onClick={() => handleFolderChange(undefined)}>
              {t('empty.backToVault')}
            </button>
            <button className="mece-btn mece-btn-subtle" onClick={chooseFolder} style={{ marginLeft: 8 }}>
              {t('empty.chooseFolder')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- 没配 AI 或没 Schema → 空状态 ----
  if (!isAIConfigured || !hasSchema) {
    // 判断当前范围是否没有笔记（空文件夹 / 空 Vault）
    const filesInScope = app.vault.getMarkdownFiles().filter(f => {
      if (!folderFilter) return true;
      const prefix = folderFilter.endsWith('/') ? folderFilter : folderFilter + '/';
      return f.path.startsWith(prefix);
    });
    const isEmptyFolder = isAIConfigured && filesInScope.length === 0;

    return (
      <div className="mece-panel-root">
        <TopBar
          isAIConfigured={isAIConfigured}
          providerLabel={providerLabel}
          onPickProvider={openProviderMenu}
          onOpenSettings={openSettings}
        />
        <EmptyState
          isAIConfigured={isAIConfigured}
          hasSchema={hasSchema}
          providerLabel={providerLabel}
          folderLabel={folderFilter ? folderFilter.split('/').pop() || folderFilter : t('empty.wholeVault')}
          isEmptyFolder={isEmptyFolder}
          onOpenSettings={openSettings}
          onGenerateSchema={() => plugin.generateSchema(true)}
          onChooseFolder={chooseFolder}
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
        onPickProvider={openProviderMenu}
        onAIReorganize={() => plugin.openReorganize()}
        onOrganizeFiles={() => plugin.organizeFilesByCategory(folderFilter || null)}
        onOpenSettings={openSettings}
      />
      <div className="mece-view-tabs">
        <button
          className={`mece-view-tab ${view === 'organize' ? 'mece-view-tab-active' : ''}`}
          onClick={() => setView('organize')}
        >
          {t('panel.viewOrganize')}
        </button>
        <button
          className={`mece-view-tab ${view === 'graph' ? 'mece-view-tab-active' : ''}`}
          onClick={() => setView('graph')}
        >
          {t('panel.viewGraph')}
        </button>
      </div>

      {view === 'organize' ? (
        <UnifiedOrganizer
          app={app}
          taxonomy={taxonomy}
          folderFilter={folderFilter}
          readOnly={false}
          onSchemaChange={handleSchemaChange}
          onRootRename={handleRootRename}
          onTagUntagged={(files) => plugin.tagFiles(files)}
          onChooseFolder={chooseFolder}
          onFileOpen={handleFileOpen}
          refreshKey={effectiveTick}
          fileSystemSync={{
            renameFolder: (a, b) => plugin.renameFolderPath(a, b),
            deleteFolderMoveNotesToRoot: (p) => plugin.deleteFolderMoveNotesToRoot(p),
            ensureFolder: (p) => plugin.ensureFolder(p),
            moveFileToFolder: (f, target) => plugin.moveFileToFolder(f, target),
          }}
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
    innerRef.current.replaceChildren();
    setIcon(innerRef.current, icon);
  };

  useEffect(() => {
    if (innerRef.current) {
      innerRef.current.replaceChildren();
      setIcon(innerRef.current, icon);
    }
  }, [icon]);

  return <span ref={setHost} className={className} style={style} />;
}

function TopBar({ isAIConfigured, providerLabel, onPickProvider, onAIReorganize, onOrganizeFiles, onOpenSettings }: {
  isAIConfigured: boolean;
  providerLabel: string;
  /** 点击 provider pill 时弹出模型/提供商切换菜单 */
  onPickProvider?: (evt: React.MouseEvent) => void;
  /** AI 重新归类；传 undefined 则不渲染按钮（聚合视图下不允许） */
  onAIReorganize?: () => void;
  /** 按分类整理文件夹；传 undefined 则不渲染 */
  onOrganizeFiles?: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className={`mece-ai-status ${isAIConfigured ? 'mece-ai-status-ok' : 'mece-ai-status-warn'}`}>
      {isAIConfigured && onPickProvider ? (
        <button
          className="mece-ai-status-pill"
          onClick={onPickProvider}
          aria-label={t('panel.switchModelOrProvider')}
        >
          <span className="mece-ai-status-pill-text">{providerLabel}</span>
          <IconHost icon="chevron-down" className="mece-ai-status-pill-caret" />
        </button>
      ) : (
        <span className="mece-ai-status-text">
          {isAIConfigured ? providerLabel : t('panel.notConfiguredAI')}
        </span>
      )}
      <div className="mece-ai-status-actions">
        {onAIReorganize && (
          <button
            className="mece-ai-status-action"
            onClick={onAIReorganize}
            aria-label={t('panel.aiReorganize')}
          >
            <IconHost icon="wand-sparkles" />
          </button>
        )}
        {onOrganizeFiles && (
          <button
            className="mece-ai-status-action"
            onClick={onOrganizeFiles}
            aria-label={t('panel.organizeFiles')}
          >
            <IconHost icon="folder-tree" />
          </button>
        )}
        <button className="mece-ai-status-action" onClick={onOpenSettings} aria-label={t('panel.openSettings')}>
          <IconHost icon="settings" />
        </button>
      </div>
    </div>
  );
}
