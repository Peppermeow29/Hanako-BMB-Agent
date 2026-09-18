/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openInternalLink, resolveLinkTarget } from '../../utils/link-open';

afterEach(() => {
  document.documentElement.removeAttribute('data-platform');
  delete (window as Partial<Window>).platform;
});

describe('resolveLinkTarget', () => {
  it('routes http links to the internal browser preview target', () => {
    expect(resolveLinkTarget('https://example.com/a?b=1#top')).toEqual({
      kind: 'web',
      url: 'https://example.com/a?b=1#top',
    });
  });

  it('resolves relative markdown links against the previewed file path', () => {
    expect(resolveLinkTarget('./assets/Cover%20Image.png#fig-1', {
      baseFilePath: '/vault/notes/chapter.md',
    })).toEqual({
      kind: 'file',
      filePath: '/vault/notes/assets/Cover Image.png',
      ext: 'png',
      label: 'Cover Image.png',
    });
  });

  it('decodes file URLs into local file targets', () => {
    expect(resolveLinkTarget('file:///tmp/hana-link-fixture/demo.md')).toEqual({
      kind: 'file',
      filePath: '/tmp/hana-link-fixture/demo.md',
      ext: 'md',
      label: 'demo.md',
    });
  });

  it('leaves in-document anchors to the browser default behavior', () => {
    expect(resolveLinkTarget('#section-2', {
      baseFilePath: '/vault/notes/chapter.md',
    })).toEqual({ kind: 'anchor', href: '#section-2' });
  });

  it('falls back to a normal browser tab when the internal browser viewer is unavailable on web clients', async () => {
    const openBrowserViewer = vi.fn();
    const openExternal = vi.fn();
    document.documentElement.setAttribute('data-platform', 'web');
    window.platform = {
      openBrowserViewer,
      openExternal,
    } as unknown as typeof window.platform;

    await openInternalLink('https://example.com/');

    expect(openBrowserViewer).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('passes the current session path to the internal browser viewer on desktop', async () => {
    const openBrowserViewer = vi.fn();
    const openExternal = vi.fn();
    window.platform = {
      openBrowserViewer,
      openExternal,
    } as unknown as typeof window.platform;

    await openInternalLink('https://example.com/', {
      sessionPath: '/tmp/hana-session.jsonl',
    });

    expect(openBrowserViewer).toHaveBeenCalledWith({
      url: 'https://example.com/',
      sessionPath: '/tmp/hana-session.jsonl',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });
});
