/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

function runPlatformScript(): void {
  const source = fs.readFileSync(path.join(process.cwd(), 'desktop/src/modules/platform.js'), 'utf-8');
  new Function(source)();
}

describe('Windows auto-hiding scrollbar contract', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.removeAttribute('data-platform');
    document.body.replaceChildren();
    Reflect.deleteProperty(window, 'platform');
    window.hana = {
      getPlatform: vi.fn(async () => 'win32'),
    } as unknown as Window['hana'];
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    Reflect.deleteProperty(window, 'hana');
    Reflect.deleteProperty(window, 'platform');
  });

  it('marks only the active Windows scroll target and clears it after inactivity', async () => {
    runPlatformScript();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.documentElement.getAttribute('data-platform')).toBe('win32');

    const scroller = document.createElement('div');
    document.body.appendChild(scroller);
    scroller.dispatchEvent(new Event('scroll'));

    expect(scroller.classList.contains('hana-scroll-active')).toBe(true);

    vi.advanceTimersByTime(799);
    expect(scroller.classList.contains('hana-scroll-active')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(scroller.classList.contains('hana-scroll-active')).toBe(false);

    document.documentElement.setAttribute('data-platform', 'darwin');
    scroller.dispatchEvent(new Event('scroll'));
    expect(scroller.classList.contains('hana-scroll-active')).toBe(false);
  });

  it('keeps the visual override scoped to Windows while preserving scrollbar width', () => {
    const globalCss = fs.readFileSync(path.join(process.cwd(), 'desktop/src/styles.css'), 'utf-8');
    const chatCss = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf-8',
    );

    expect(globalCss).toMatch(/html\[data-platform="win32"\][^{]*\*\s*\{[^}]*scrollbar-color:\s*transparent transparent/s);
    expect(globalCss).toMatch(/html\[data-platform="win32"\][^{]*\.hana-scroll-active\s*\{[^}]*scrollbar-color:\s*var\(--overlay-strong\) transparent/s);
    expect(globalCss).toMatch(/\.hana-scroll-active::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--overlay-strong\)/s);
    expect(globalCss).toMatch(/html\[data-platform="win32"\][^{]*::-webkit-scrollbar-button\s*\{[^}]*(?:display:\s*none|width:\s*0)[^}]*\}/s);
    expect(globalCss).not.toMatch(/html\[data-platform="win32"\][^{]*scrollbar-width:\s*none/s);
    expect(chatCss).toContain(':global(html:not([data-platform="win32"])) .sessionPanel:hover');
  });
});
