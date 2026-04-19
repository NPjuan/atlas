import { App, Modal } from 'obsidian';
import React, { useState, useEffect, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import type MECEPlugin from '../../main';
import type { ReorganizeIntensity } from '../../ai/prompts';
import { t, useLocale } from '../../i18n';

// ============================================================
// ReorganizeModal — 增量重新归类配置
// 让用户选择范围（文件夹）和调整强度，然后触发归类
// ============================================================

interface ReorganizeAppProps {
  plugin: MECEPlugin;
  defaultFolder?: string;
  onStart: (folderPath: string | undefined, intensity: ReorganizeIntensity) => void;
  onCancel: () => void;
}

function ReorganizeApp({ plugin, defaultFolder, onStart, onCancel }: ReorganizeAppProps) {
  useLocale();
  const [folderPath, setFolderPath] = useState<string | undefined>(defaultFolder);
  const [intensity, setIntensity] = useState<ReorganizeIntensity>(
    (plugin.settings.defaultReorganizeIntensity as ReorganizeIntensity) || 'conservative',
  );

  const folders = plugin.app.vault.getAllLoadedFiles()
    .filter((f): f is import('obsidian').TFolder =>
      'children' in f && f.path !== '/' && f.path !== '')
    .map(f => f.path)
    .sort();

  const intensityLabels: Record<ReorganizeIntensity, { label: string; desc: string }> = {
    conservative: { label: t('reorganize.intensityConservative'), desc: t('reorganize.intensityConservativeDesc') },
    balanced:     { label: t('reorganize.intensityBalanced'),     desc: t('reorganize.intensityBalancedDesc') },
    aggressive:   { label: t('reorganize.intensityAggressive'),   desc: t('reorganize.intensityAggressiveDesc') },
  };

  return (
    <div className="mece-reorganize">
      <h3>{t('reorganize.title')}</h3>
      <p className="mece-reorganize-desc">
        {t('reorganize.desc')}
      </p>

      {/* 范围 */}
      <div className="mece-reorganize-field">
        <label>{t('reorganize.scopeLabel')}</label>
        <select
          value={folderPath ?? ''}
          onChange={(e) => setFolderPath(e.target.value || undefined)}
          className="mece-reorganize-select"
        >
          <option value="">{t('empty.wholeVault')}</option>
          {folders.map(f => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </div>

      {/* 强度 */}
      <div className="mece-reorganize-field">
        <label>{t('reorganize.intensityLabel')}</label>
        <div className="mece-reorganize-intensity-group">
          {(['conservative', 'balanced', 'aggressive'] as ReorganizeIntensity[]).map(key => (
            <button
              key={key}
              className={`mece-reorganize-intensity-btn ${intensity === key ? 'mece-reorganize-intensity-btn-active' : ''}`}
              onClick={() => setIntensity(key)}
              type="button"
            >
              <div className="mece-reorganize-intensity-label">{intensityLabels[key].label}</div>
              <div className="mece-reorganize-intensity-desc">{intensityLabels[key].desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* 底部 */}
      <div className="mece-reorganize-footer">
        <button className="mece-btn" onClick={onCancel}>{t('reorganize.cancel')}</button>
        <button
          className="mece-btn mece-btn-primary"
          onClick={() => onStart(folderPath, intensity)}
        >
          {t('reorganize.start')}
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
