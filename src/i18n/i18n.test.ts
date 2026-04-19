import { describe, it, expect, beforeEach } from 'vitest';
import { t, setLocale, getLocale, resolveLocale, detectLocaleFromEnv } from './index';

describe('i18n core', () => {
  beforeEach(() => {
    setLocale('zh'); // 每个 test 前重置
  });

  describe('t()', () => {
    it('返回中文字典的翻译', () => {
      setLocale('zh');
      expect(t('common.ok')).toBe('确定');
    });

    it('切到 en 返回英文翻译', () => {
      setLocale('en');
      expect(t('common.ok')).toBe('OK');
    });

    it('替换 {param} 占位符', () => {
      setLocale('zh');
      expect(t('notice.tagsWritten', { count: 5 })).toBe('✅ 5 篇笔记已归类');
      setLocale('en');
      expect(t('notice.tagsWritten', { count: 5 })).toBe('✅ 5 notes categorized');
    });

    it('多个占位符都替换', () => {
      setLocale('zh');
      expect(t('panel.providerNoKey', { name: 'Claude' })).toBe('Claude · 未配置 Key');
    });

    it('未定义的 param 替换为空字符串', () => {
      setLocale('zh');
      expect(t('notice.tagsWritten', {} as any)).toBe('✅  篇笔记已归类');
    });

    it('不传 params 时原文返回（含占位符）', () => {
      setLocale('zh');
      expect(t('notice.tagsWritten')).toBe('✅ {count} 篇笔记已归类');
    });
  });

  describe('setLocale / getLocale', () => {
    it('setLocale 改变 getLocale 返回值', () => {
      setLocale('en');
      expect(getLocale()).toBe('en');
      setLocale('zh');
      expect(getLocale()).toBe('zh');
    });
  });

  describe('detectLocaleFromEnv', () => {
    it('bodyLang=zh* 返回 zh', () => {
      expect(detectLocaleFromEnv({ bodyLang: 'zh-CN' })).toBe('zh');
      expect(detectLocaleFromEnv({ bodyLang: 'zh' })).toBe('zh');
    });

    it('bodyLang=en* 返回 en', () => {
      expect(detectLocaleFromEnv({ bodyLang: 'en-US' })).toBe('en');
    });

    it('优先级：bodyLang > momentLocale > navigatorLanguage', () => {
      expect(detectLocaleFromEnv({
        bodyLang: 'zh',
        momentLocale: 'en',
        navigatorLanguage: 'en-US',
      })).toBe('zh');
      expect(detectLocaleFromEnv({
        bodyLang: '',
        momentLocale: 'en-GB',
        navigatorLanguage: 'zh-CN',
      })).toBe('en');
    });

    it('都没给时兜底 en', () => {
      expect(detectLocaleFromEnv({})).toBe('en');
    });

    it('识别其它语言 tag 时兜底 en（只认中英）', () => {
      expect(detectLocaleFromEnv({ bodyLang: 'fr-FR' })).toBe('en');
      expect(detectLocaleFromEnv({ bodyLang: 'ja-JP' })).toBe('en');
    });
  });

  describe('resolveLocale', () => {
    it('"zh" / "en" 强制返回对应 locale', () => {
      expect(resolveLocale('zh')).toBe('zh');
      expect(resolveLocale('en')).toBe('en');
    });

    it('"auto" / undefined 走 detectLocaleFromEnv', () => {
      // 这里只验证不抛错；实际 detectLocaleFromEnv 的行为上面已覆盖
      const r1 = resolveLocale('auto');
      const r2 = resolveLocale();
      expect(r1 === 'zh' || r1 === 'en').toBe(true);
      expect(r2 === 'zh' || r2 === 'en').toBe(true);
    });
  });
});
