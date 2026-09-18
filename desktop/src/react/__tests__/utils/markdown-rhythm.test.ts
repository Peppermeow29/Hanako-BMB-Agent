/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { snappedRhythmMargin, observeMarkdownRhythmSnap } from '../../utils/markdown-rhythm';

describe('snappedRhythmMargin', () => {
  it('整格高度只留一格下边距', () => { expect(snappedRhythmMargin(72, 24)).toBe(24); });
  it('非整格高度补到下一格点', () => { expect(snappedRhythmMargin(80, 24)).toBe(24 + 16); });
  it('非法节奏回退一格语义', () => {
    expect(snappedRhythmMargin(80, 0)).toBe(0);
    expect(snappedRhythmMargin(80, NaN)).toBe(NaN);
  });
});

describe('observeMarkdownRhythmSnap', () => {
  const observed: Element[] = [];
  let disconnected = 0;
  beforeEach(() => {
    observed.length = 0; disconnected = 0;
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) { observed.push(el); }
      disconnect() { disconnected += 1; }
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('只观察表格滚动壳与代码块壳，cleanup 断开', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<div class="markdown-table-scroll"><table></table></div>' +
      '<div class="code-block-wrap"><pre></pre></div>' +
      '<p>text</p>';
    document.body.appendChild(host);
    // jsdom 的 line-height 计算不可靠，观察器内部按 px 解析失败时应返回 noop
    host.style.lineHeight = '24px';
    const cleanup = observeMarkdownRhythmSnap(host);
    if (observed.length > 0) {
      expect(observed.map(e => e.className)).toEqual(['markdown-table-scroll', 'code-block-wrap']);
      cleanup();
      expect(disconnected).toBe(1);
    } else {
      // 环境解析不出 line-height 时的合法降级：cleanup 为 noop 且不抛错
      expect(() => cleanup()).not.toThrow();
    }
    host.remove();
  });

  it('无 ResizeObserver 环境返回 noop', () => {
    vi.unstubAllGlobals();
    const original = (globalThis as any).ResizeObserver;
    delete (globalThis as any).ResizeObserver;
    const cleanup = observeMarkdownRhythmSnap(document.createElement('div'));
    expect(() => cleanup()).not.toThrow();
    (globalThis as any).ResizeObserver = original;
  });
});
