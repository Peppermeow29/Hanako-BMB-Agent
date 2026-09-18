import { describe, it, expect } from 'vitest';
import { resolvePreparingText } from '../desktop/src/react/splash/SplashApp';

describe('resolvePreparingText', () => {
  it('uses the named template with the agent name when configured', () => {
    expect(resolvePreparingText(null, 'zh', '小语')).toBe('小语 正在准备新家…');
    expect(resolvePreparingText(null, 'en', 'Yui')).toBe('Yui is preparing a new home…');
  });

  it('falls back to the anonymous template when agentName is null, never DEFAULT_NAME', () => {
    const zh = resolvePreparingText(null, 'zh', null);
    const en = resolvePreparingText(null, 'en', null);
    expect(zh).toBe('你的助手正在准备新家…');
    expect(en).toBe('Your assistant is preparing a new home…');
    expect(zh).not.toContain('Hanako');
    expect(zh).not.toContain('小花');
    expect(en).not.toContain('Hanako');
  });

  it('treats an empty-string agentName the same as null (no fallback to DEFAULT_NAME)', () => {
    expect(resolvePreparingText(null, 'zh', '')).toBe('你的助手正在准备新家…');
  });

  it('prefers the locale-pack template over the hardcoded fallback when present', () => {
    const data = { splash: { preparing: { named: '{name} 定制文案', anonymous: '匿名定制文案' } } };
    expect(resolvePreparingText(data, 'zh', '小语')).toBe('小语 定制文案');
    expect(resolvePreparingText(data, 'zh', null)).toBe('匿名定制文案');
  });
});
