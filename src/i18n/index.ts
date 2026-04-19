/**
 * i18n 运行时：懒初始化 + t(key, params) + 监听语言切换
 *
 * 用法：
 *   import { t, setLocale, resolveLocale } from '../i18n';
 *   new Notice(t('notice.tagsWritten', { count: 3 }));
 *
 *   // 应用启动时（main.ts onload）：
 *   setLocale(resolveLocale(settings.language));
 *
 *   // 用户切换语言时（settings.ts）：
 *   setLocale(resolveLocale(newLangSetting));
 */

import { zh } from './zh';
import { en } from './en';
import type { Locale, LanguageSetting } from './types';

export type { Locale, LanguageSetting } from './types';
export type LocaleKey = keyof typeof zh;

const dicts = { zh, en };
let currentLocale: Locale = 'zh';
const listeners = new Set<() => void>();

/** 获取当前激活的 locale */
export function getLocale(): Locale {
  return currentLocale;
}

/** 设置 locale。无变化不触发监听器。 */
export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  listeners.forEach(fn => fn());
}

/** 订阅 locale 变化（如 React 组件 force re-render） */
export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 根据 LanguageSetting 决定实际使用的 Locale。
 *
 * - 'auto'：从 Obsidian / 浏览器环境推断
 * - 'zh' / 'en'：强制
 *
 * 检测顺序（纯函数，不依赖 Obsidian API；用 globalThis 访问环境）：
 *   1. `document.body.lang`（Obsidian 给 <body> 设了 lang）
 *   2. `window.moment.locale()`（Obsidian 暴露的 moment 实例）
 *   3. `navigator.language`
 *   4. 兜底 'en'
 */
export function resolveLocale(setting?: LanguageSetting['mode']): Locale {
  if (setting === 'zh' || setting === 'en') return setting;
  return detectLocaleFromEnv();
}

/** 从环境探测语言（仅暴露给测试 / resolveLocale 内部用） */
export function detectLocaleFromEnv(env?: {
  bodyLang?: string;
  momentLocale?: string;
  navigatorLanguage?: string;
}): Locale {
  const g = globalThis as any;
  const bodyLang = env?.bodyLang ?? g.document?.body?.lang ?? '';
  const momentLocale = env?.momentLocale ?? g.window?.moment?.locale?.() ?? '';
  const navigatorLanguage = env?.navigatorLanguage ?? g.navigator?.language ?? '';

  const tag = (bodyLang || momentLocale || navigatorLanguage || '').toLowerCase();
  if (tag.startsWith('zh')) return 'zh';
  if (tag.startsWith('en')) return 'en';
  return 'en';
}

/**
 * 翻译函数。key 找不到时 fallback 到 zh 字典，zh 也没有就返回 key 原文（便于开发期快速发现漏翻）。
 * 占位符替换：`{name}` → params.name
 */
export function t(key: LocaleKey, params?: Record<string, string | number>): string {
  const dict = dicts[currentLocale];
  const text = dict[key] ?? zh[key] ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (_, k) => {
    const v = params[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** React hook：订阅 locale 变化触发重渲染 */
export function useLocale(): Locale {
  // 惰性 require：避免 node 端（单测）引入 React
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react');
  const [locale, setLocaleState] = React.useState(currentLocale);
  React.useEffect(() => onLocaleChange(() => setLocaleState(currentLocale)), []);
  return locale;
}
