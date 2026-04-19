import { App, Modal } from 'obsidian';
import React, { useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import type { TaxonomySchema, TaxonomyNode } from '../../types';
import { SchemaTree } from './SchemaTree';
import { t, useLocale } from '../../i18n';

// ============================================================
// Schema 编辑器 Modal — Obsidian Modal + React 组件
// ============================================================

interface SchemaEditorAppProps {
  initialNodes: TaxonomyNode[];
  maxDepth: number;
  noteCountMap: Record<string, number>;
  onConfirm: (nodes: TaxonomyNode[], maxDepth: number) => void;
  onCancel: () => void;
  onRegenerate: () => void;
}

function SchemaEditorApp({ initialNodes, maxDepth: initMaxDepth, noteCountMap, onConfirm, onCancel, onRegenerate }: SchemaEditorAppProps) {
  useLocale();
  const [nodes, setNodes] = useState<TaxonomyNode[]>(initialNodes);
  const [maxDepth, setMaxDepth] = useState(initMaxDepth);

  return (
    <div className="mece-schema-editor">
      <div className="mece-schema-editor-header">
        <h3>{t('schema.editTitle')}</h3>
        <div className="mece-schema-editor-config">
          <label>
            {t('schema.maxDepthLabel')}
            <select value={maxDepth} onChange={(e) => setMaxDepth(parseInt(e.target.value))}>
              <option value={2}>{t('schema.maxDepth2')}</option>
              <option value={3}>{t('schema.maxDepth3')}</option>
            </select>
          </label>
        </div>
      </div>

      <SchemaTree
        nodes={nodes}
        maxDepth={maxDepth}
        noteCountMap={noteCountMap}
        onChange={setNodes}
      />

      <div className="mece-schema-editor-footer">
        <button className="mece-btn" onClick={onCancel}>{t('schema.cancel')}</button>
        <button className="mece-btn" onClick={onRegenerate}>{t('schema.regenerate')}</button>
        <button className="mece-btn mece-btn-primary" onClick={() => onConfirm(nodes, maxDepth)}>
          {t('schema.confirm')}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Obsidian Modal 包装
// ============================================================

export class SchemaEditorModal extends Modal {
  private root: Root | null = null;
  private taxonomy: TaxonomySchema | null;
  private noteCountMap: Record<string, number>;
  private onConfirm: (taxonomy: TaxonomySchema) => void;
  private onRegenerate: () => void;

  constructor(
    app: App,
    taxonomy: TaxonomySchema | null,
    noteCountMap: Record<string, number>,
    onConfirm: (taxonomy: TaxonomySchema) => void,
    onRegenerate: () => void,
  ) {
    super(app);
    this.taxonomy = taxonomy;
    this.noteCountMap = noteCountMap;
    this.onConfirm = onConfirm;
    this.onRegenerate = onRegenerate;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mece-schema-editor-modal');

    const container = contentEl.createDiv();
    this.root = createRoot(container);

    const initialNodes = this.taxonomy?.nodes || [];
    const maxDepth = this.taxonomy?.maxDepth || 3;

    this.root.render(
      <SchemaEditorApp
        initialNodes={initialNodes}
        maxDepth={maxDepth}
        noteCountMap={this.noteCountMap}
        onConfirm={(nodes, md) => {
          const schema: TaxonomySchema = {
            version: 1,
            createdAt: this.taxonomy?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            maxDepth: md,
            nodes,
          };
          this.onConfirm(schema);
          this.close();
        }}
        onCancel={() => this.close()}
        onRegenerate={() => {
          this.close();
          this.onRegenerate();
        }}
      />
    );
  }

  onClose(): void {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
    this.contentEl.empty();
  }
}
