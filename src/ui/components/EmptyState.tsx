import React from 'react';
import { t } from '../../i18n';

// ============================================================
// 空状态引导组件 — 完整流程 checklist
// ============================================================

interface EmptyStateProps {
  isAIConfigured: boolean;
  hasSchema: boolean;
  providerLabel: string;
  folderLabel: string;
  /** 当前范围是否为空文件夹/Vault（无笔记），用于显示提示 */
  isEmptyFolder?: boolean;
  onOpenSettings: () => void;
  onGenerateSchema: () => void;
  /** 切换范围（点"换个范围"时调用） */
  onChooseFolder?: () => void;
}

type StepStatus = 'done' | 'current' | 'pending';

export function EmptyState({ isAIConfigured, hasSchema, providerLabel, folderLabel, isEmptyFolder, onOpenSettings, onGenerateSchema, onChooseFolder }: EmptyStateProps) {
  const step1: StepStatus = isAIConfigured ? 'done' : 'current';
  const step2: StepStatus = !isAIConfigured ? 'pending' : 'current';

  return (
    <div className="mece-empty-state">
      <h3>{t('empty.title')}</h3>
      <p>{t('empty.subtitle')}</p>

      <div className="mece-empty-steps">
        <Step
          num={1}
          status={step1}
          text={t('empty.step1')}
          detail={isAIConfigured
            ? t('empty.step1DescConfigured', { provider: providerLabel })
            : t('empty.step1DescNotConfigured')}
          actionLabel={isAIConfigured ? t('empty.step1ActionModify') : t('empty.step1ActionGo')}
          onAction={onOpenSettings}
        />
        <Step
          num={2}
          status={step2}
          text={t('empty.step2', { folder: folderLabel })}
          detail={isEmptyFolder
            ? t('empty.step2EmptyFolder')
            : t('empty.step2Desc')}
          actionLabel={step2 === 'current' && !isEmptyFolder ? t('empty.step2Start') : undefined}
          onAction={onGenerateSchema}
        />
      </div>

      {onChooseFolder && (
        <div className="mece-empty-footer">
          <button className="mece-btn mece-btn-subtle" onClick={onChooseFolder}>
            {t('empty.chooseFolder')}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- 单个步骤 ----

function Step({ num, status, text, detail, actionLabel, onAction }: {
  num: number;
  status: StepStatus;
  text: string;
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className={`mece-step mece-step-${status}`}>
      <div className="mece-step-indicator">
        {status === 'done' ? (
          <span className="mece-step-check">✓</span>
        ) : (
          <span className="mece-step-num">{num}</span>
        )}
      </div>
      <div className="mece-step-content">
        <div className="mece-step-title">{text}</div>
        <div className="mece-step-detail">{detail}</div>
        {actionLabel && (
          <button
            className={`mece-btn mece-step-action ${status === 'current' ? 'mece-btn-primary' : ''}`}
            onClick={onAction}
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
