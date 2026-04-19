import React, { useRef, useEffect, useCallback } from 'react';
import { setIcon, type App } from 'obsidian';

// ============================================================
// ForceGraphView — force-graph 的 React 包装
// 用 useRef 获取 DOM，useEffect 初始化/销毁
// 右上角浮层控制：放大/缩小/适应/展开全部/折叠全部
// ============================================================

interface ForceGraphViewProps {
  app: App;
  folderFilter?: string;
  onFileClick?: (filePath: string) => void;
  onStats?: (stats: { nodes: number; tags: number; files: number }) => void;
}

interface ToolbarButtonProps {
  icon: string;
  label: string;
  onClick: () => void;
}

function ToolbarButton({ icon, label, onClick }: ToolbarButtonProps) {
  // button 内部放一个脱管 span 承载 SVG，React 的 JSX 永不渲染子节点
  const innerRef = useRef<HTMLSpanElement | null>(null);

  const setHost = (btn: HTMLButtonElement | null) => {
    if (!btn) return;
    if (!innerRef.current) {
      const inner = document.createElement('span');
      inner.style.display = 'inline-flex';
      innerRef.current = inner;
    }
    if (innerRef.current.parentNode !== btn) {
      btn.appendChild(innerRef.current);
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

  return (
    <button
      ref={setHost}
      className="mece-graph-toolbar-btn"
      aria-label={label}
      onClick={onClick}
    />
  );
}

export function ForceGraphView({ app, folderFilter, onFileClick, onStats }: ForceGraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphHostRef = useRef<HTMLDivElement>(null);
  const mindmapRef = useRef<any>(null);

  useEffect(() => {
    if (!graphHostRef.current) return;

    // 动态 import tag-mindmap 引擎（避免 SSR 问题）
    import('../tag-mindmap').then(({ TagMindMap }) => {
      if (!graphHostRef.current) return;

      const mindmap = new TagMindMap(graphHostRef.current, app, {
        onFileClick: (filePath: string) => {
          onFileClick?.(filePath);
        },
      });

      mindmap.onStats((stats: { nodes: number; tags: number; files: number }) => {
        onStats?.(stats);
      });

      mindmap.render(folderFilter);
      mindmapRef.current = mindmap;
    });

    return () => {
      if (mindmapRef.current) {
        mindmapRef.current.destroy();
        mindmapRef.current = null;
      }
    };
  }, [app, folderFilter]);

  const handleZoomIn = useCallback(() => mindmapRef.current?.zoomIn?.(), []);
  const handleZoomOut = useCallback(() => mindmapRef.current?.zoomOut?.(), []);
  const handleFit = useCallback(() => mindmapRef.current?.zoomToFit?.(), []);
  const handleExpand = useCallback(() => mindmapRef.current?.expandAll?.(), []);
  const handleCollapse = useCallback(() => mindmapRef.current?.collapseAll?.(), []);

  return (
    <div
      ref={containerRef}
      className="mece-graph-area"
      style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}
    >
      <div
        ref={graphHostRef}
        style={{ position: 'absolute', inset: 0 }}
      />
      <div className="mece-graph-toolbar">
        <ToolbarButton icon="zoom-in" label="放大" onClick={handleZoomIn} />
        <ToolbarButton icon="zoom-out" label="缩小" onClick={handleZoomOut} />
        <ToolbarButton icon="maximize" label="适应视口" onClick={handleFit} />
        <div className="mece-graph-toolbar-divider" />
        <ToolbarButton icon="chevrons-down-up" label="折叠全部" onClick={handleCollapse} />
        <ToolbarButton icon="chevrons-up-down" label="展开全部" onClick={handleExpand} />
      </div>
    </div>
  );
}
