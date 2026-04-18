import React from 'react';

// ============================================================
// 空状态引导组件 — 完整流程 checklist
// ============================================================

interface EmptyStateProps {
  isAIConfigured: boolean;
  hasSchema: boolean;
  providerLabel: string;
  folderLabel: string;
  onOpenSettings: () => void;
  onGenerateSchema: () => void;
}

type StepStatus = 'done' | 'current' | 'pending';

export function EmptyState({ isAIConfigured, hasSchema, providerLabel, folderLabel, onOpenSettings, onGenerateSchema }: EmptyStateProps) {
  const step1: StepStatus = isAIConfigured ? 'done' : 'current';
  const step2: StepStatus = !isAIConfigured ? 'pending' : 'current';

  return (
    <div className="mece-empty-state">
      <h3>MECE 知识分类</h3>
      <p>AI 分析你的笔记库，自动建立分类体系并打标签。</p>

      <div className="mece-empty-steps">
        <Step
          num={1}
          status={step1}
          text="配置 AI 服务"
          detail={isAIConfigured ? providerLabel : '接入 AI 服务并填写密钥'}
          actionLabel={isAIConfigured ? '修改' : '去配置'}
          onAction={onOpenSettings}
        />
        <Step
          num={2}
          status={step2}
          text={`为「${folderLabel}」生成分类`}
          detail="AI 扫描此范围的笔记 → 生成分类框架 → 为每篇笔记推荐标签并确认"
          actionLabel={step2 === 'current' ? '开始' : undefined}
          onAction={onGenerateSchema}
        />
      </div>
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
