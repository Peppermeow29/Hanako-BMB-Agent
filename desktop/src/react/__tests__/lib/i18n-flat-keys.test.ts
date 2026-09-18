/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('renderer i18n flat dotted keys', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'i18n');
    Reflect.deleteProperty(window, 't');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('resolves exact flat dotted keys before nested dot-path fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      'preview.markdownPreview': '预览',
      preview: { markdownPreview: 'nested preview' },
      common: { screenshot: '截图' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    // @ts-expect-error i18n.js is a browser side-effect script without module declarations.
    await import('../../../lib/i18n.js');
    await window.i18n.load('zh-CN');

    expect(window.t('preview.markdownPreview')).toBe('预览');
    expect(window.t('common.screenshot')).toBe('截图');
  });
});
