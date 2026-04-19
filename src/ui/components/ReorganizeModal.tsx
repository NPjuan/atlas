import { App, Modal } from 'obsidian';
import React, { useState, useEffect, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import type MECEPlugin from '../../main';
import type { ReorganizeIntensity } from '../../ai/prompts';

// ============================================================
// ReorganizeModal — 增量重新归类配置
// 让用户选择范围（文件夹）和调整强度，然后触发 AI 归类
// ============================================================

interface ReorganizeAppProps {
  plugin: MECEPlugin;
  defaultFolder?: string;
  onStart: (folderPath: string | undefined, intensity: ReorganizeIntensity) => void;
  onCancel: () => void;
}

const INTENSITY_LABELS: Record<ReorganizeIntensity, { label: string; desc: string }> = {
  conservative: {
    label: '保守',
    desc: '尽量保留现有标签，只改明显错位的笔记',
  },
  balanced: {
    label: '平衡',
    desc: '合理保留原有，适度调整到更精准分类',
  },
  aggressive: {
    label: '重构',
    desc: '忽略现有标签，按内容重新判断',
  },
};

function ReorganizeApp({ plugin, defaultFolder, onStart, onCancel }: ReorganizeAppProps) {
  const [folderPath, setFolderPath] = useState<string | undefined>(defaultFolder);
  const [intensity, setIntensity] = useState<ReorganizeIntensity>(
    (plugin.settings.defaultReorganizeIntensity as ReorganizeIntensity) || 'conservative',
  );

  const folders = plugin.app.vault.getAllLoadedFiles()
    .filter((f): f is import('obsidian').TFolder =>
      'children' in f && f.path !== '/' && f.path !== '')
    .map(f => f.path)
    .sort();

  return (
    <div className="mece-reorganize">
      <h3>AI 智能归类</h3>
      <p className="mece-reorganize-desc">
        基于当前分类体系，让 AI 分析笔记应归入哪个分类。<br />
        不会修改分类结构，只调整笔记的标签。
      </p>

      {/* 范围 */}
      <div className="mece-reorganize-field">
        <label>范围</label>
        <select
          value={folderPath ?? ''}
          onChange={(e) => setFolderPath(e.target.value || undefined)}
          className="mece-reorganize-select"
        >
          <option value="">整个 Vault</option>
          {folders.map(f => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </div>

      {/* 强度 */}
      <div className="mece-reorganize-field">
        <label>调整强度</label>
        <div className="mece-reorganize-intensity-group">
          {(['conservative', 'balanced', 'aggressive'] as ReorganizeIntensity[]).map(key => (
            <button
              key={key}
              className={`mece-reorganize-intensity-btn ${intensity === key ? 'mece-reorganize-intensity-btn-active' : ''}`}
              onClick={() => setIntensity(key)}
              type="button"
            >
              <div className="mece-reorganize-intensity-label">{INTENSITY_LABELS[key].label}</div>
              <div className="mece-reorganize-intensity-desc">{INTENSITY_LABELS[key].desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* 底部 */}
      <div className="mece-reorganize-footer">
        <button className="mece-btn" onClick={onCancel}>取消</button>
        <button
          className="mece-btn mece-btn-primary"
          onClick={() => onStart(folderPath, intensity)}
        >
          开始分析
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Obsidian Modal 包装
// ============================================================

export class ReorganizeModal extends Modal {
  private root: Root | null = null;
  private plugin: MECEPlugin;
  private defaultFolder?: string;
  private onStart: (folderPath: string | undefined, intensity: ReorganizeIntensity) => void;

  constructor(
    plugin: MECEPlugin,
    defaultFolder: string | undefined,
    onStart: (folderPath: string | undefined, intensity: ReorganizeIntensity) => void,
  ) {
    super(plugin.app);
    this.plugin = plugin;
    this.defaultFolder = defaultFolder;
    this.onStart = onStart;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mece-reorganize-modal');

    this.root = createRoot(contentEl);
    this.root.render(
      React.createElement(ReorganizeApp, {
        plugin: this.plugin,
        defaultFolder: this.defaultFolder,
        onStart: (folder, intensity) => {
          this.close();
          this.onStart(folder, intensity);
        },
        onCancel: () => this.close(),
      }),
    );
  }

  onClose() {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
    this.contentEl.empty();
  }
}
