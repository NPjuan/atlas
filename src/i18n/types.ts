/**
 * i18n 字典键列表。
 *
 * 所有 UI 可见文案必须通过这里的 key 访问（而不是硬编码字符串）。
 * 添加新文案：同时在 zh.ts / en.ts 里补上同名 key。
 *
 * 命名规范：
 *   <area>.<element>[.<variant>]
 *   common.*       — 通用（按钮、动作）
 *   panel.*        — 主面板
 *   organizer.*    — 整理器
 *   schema.*       — Schema 编辑
 *   review.*       — Patch/FileMove Review
 *   empty.*        — EmptyState
 *   settings.*     — 设置页
 *   notice.*       — Notice 提示（轻量通知）
 *   command.*      — 命令面板
 *   modal.*        — Modal 标题
 *   progress.*     — 进度条
 *   folder.*       — 文件夹选择器
 */
export type LocaleKey = keyof typeof import('./zh').zh;

export type Locale = 'zh' | 'en';

export interface LanguageSetting {
  /** 'auto' 跟随 Obsidian 界面语言；否则强制指定 */
  mode: 'auto' | Locale;
}
