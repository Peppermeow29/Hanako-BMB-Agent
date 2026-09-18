import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS_PATH = 'desktop/src/react/components/SessionList.module.css';

function readCss(): string {
  return readFileSync(path.join(process.cwd(), CSS_PATH), 'utf8').replace(/\r\n/g, '\n');
}

/** Extract a top-level rule body for an exact selector (not nested @media). */
function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`);
  return css.match(re)?.[1] ?? '';
}

describe('SessionList streaming dot animation', () => {
  it('does not use infinite pulse on the running dot', () => {
    const css = readCss();

    const running = cssBlock(css, '.sessionStreamingDot[data-state="running"]');

    expect(running.length).toBeGreaterThan(0);
    expect(running).not.toMatch(/\binfinite\b/);
  });

  // 会话切换是本地毫秒级操作，任何加载态装饰都只会一闪而过。
  // 竖线和借来的状态点都已移除，这里守住不让它们回来。
  it('carries no loading decoration for a pending session switch', () => {
    const css = readCss();

    expect(css).not.toMatch(/\[data-state="pending"\]/);
    expect(css).not.toMatch(/\.sessionItemPending\b/);
  });

  it('keeps reduced-motion path disabling streaming-dot animation', () => {
    const css = readCss();
    const reduceBlock =
      css.match(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(reduceBlock).toMatch(/\.sessionStreamingDot\s*\{[^}]*animation:\s*none/);
  });
});
