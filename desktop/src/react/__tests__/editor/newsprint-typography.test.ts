import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8');

describe('newsprint typography assets & tokens', () => {
  it('bundles PT Serif woff2 assets', () => {
    for (const f of ['pt-serif-v11-latin-regular.woff2', 'pt-serif-v11-latin-italic.woff2',
                     'pt-serif-v11-latin-700.woff2', 'pt-serif-v11-latin-700italic.woff2']) {
      expect(fs.existsSync(path.join(process.cwd(), 'desktop/src/themes/fonts', f)), f).toBe(true);
    }
  });

  it('declares PT Serif @font-face for 400/400i/700/700i', () => {
    const css = read('desktop/src/themes/new-warm-paper-fonts.css');
    const blocks = css.match(/@font-face\s*\{[^}]*'PT Serif'[^}]*\}/g) ?? [];
    expect(blocks.length).toBe(4);
    expect(css).toMatch(/pt-serif-v11-latin-regular\.woff2/);
    expect(css).toMatch(/pt-serif-v11-latin-700italic\.woff2/);
  });

  it('defines --font-serif-text (PT Serif first, CJK serif fallback) on desktop and mobile', () => {
    for (const p of ['desktop/src/styles.css', 'desktop/src/react/mobile/mobile-entry.css']) {
      const css = read(p);
      expect(css).toMatch(/--font-serif-text:\s*'PT Serif',\s*'Noto Serif SC'/);
    }
  });

  it('font-sans mode overrides --font-serif-text too', () => {
    const css = read('desktop/src/styles.css');
    expect(css).toMatch(/body\.font-sans\s*\{[^}]*--font-serif-text:\s*var\(--font-ui\)/s);
  });

  it('defines --radius-xs on desktop (3px) and mobile (4px)', () => {
    expect(read('desktop/src/styles.css')).toMatch(/--radius-xs:\s*3px/);
    expect(read('desktop/src/react/mobile/mobile-entry.css')).toMatch(/--radius-xs:\s*4px/);
  });
});
