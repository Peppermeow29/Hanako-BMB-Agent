import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../settings/Settings.module.css', import.meta.url), 'utf8');
const modalCss = readFileSync(new URL('../../components/SettingsModalShell.module.css', import.meta.url), 'utf8');
const overlayCss = readFileSync(new URL('../../ui/Overlay.module.css', import.meta.url), 'utf8');

function cssRule(source: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('memory viewer layout contract', () => {
  it('keeps long memory content inside a scrollable body', () => {
    expect(cssRule(css, ':global(.settings-panel)')).toMatch(/position:\s*relative;/);

    expect(cssRule(css, '.memory-viewer-backdrop')).toMatch(/padding:\s*var\(--space-16\);/);
    expect(cssRule(css, '.compiled-memory-viewer-backdrop')).toMatch(/padding:\s*var\(--space-40\) var\(--space-24\);/);
    expect(cssRule(css, '.compiled-memory-viewer')).toMatch(/max-height:\s*100%;/);
    expect(cssRule(css, '.memory-viewer')).toMatch(/min-height:\s*0;/);
    expect(cssRule(css, '.memory-viewer')).toMatch(/overflow:\s*hidden;/);

    expect(cssRule(overlayCss, '.contained-backdrop')).toMatch(/position:\s*absolute;/);
    expect(cssRule(overlayCss, '.contained-container')).toMatch(/max-height:\s*100%;/);
    expect(cssRule(overlayCss, '.contained-container')).toMatch(/min-height:\s*0;/);

    expect(cssRule(css, '.compiled-edit-toggle-btn')).toMatch(/background:\s*none;/);
    expect(cssRule(css, '.compiled-edit-toggle-btn')).toMatch(/border:\s*1px solid var\(--overlay-light\);/);
    expect(cssRule(css, '.compiled-edit-save-btn')).toBe('');

    expect(cssRule(css, '.memory-viewer-body')).toMatch(/flex:\s*1 1 auto;/);
    expect(cssRule(css, '.memory-viewer-body')).toMatch(/min-height:\s*0;/);
    expect(cssRule(css, '.memory-viewer-body')).toMatch(/overflow-y:\s*auto;/);

    expect(cssRule(css, '.compiled-memory-body')).toMatch(/min-height:\s*0;/);
    expect(cssRule(css, '.compiled-memory-editable')).toMatch(/min-height:\s*0;/);

    expect(cssRule(css, '.compiled-memory-facts-editor')).toMatch(/height:\s*150px;/);
    expect(cssRule(css, '.compiled-memory-facts-editor')).toMatch(/max-height:\s*220px;/);
    expect(cssRule(css, '.compiled-memory-facts-editor')).toMatch(/resize:\s*none;/);
    expect(cssRule(css, '.compiled-memory-facts-editor')).toMatch(/overflow-y:\s*auto;/);

    expect(cssRule(css, '.compiled-memory-week-day-editor')).toMatch(/height:\s*96px;/);
    expect(cssRule(css, '.compiled-memory-week-day-editor')).toMatch(/max-height:\s*140px;/);
    expect(cssRule(css, '.compiled-memory-week-day-editor')).toMatch(/resize:\s*none;/);
    expect(cssRule(css, '.compiled-memory-week-day-editor')).toMatch(/overflow-y:\s*auto;/);
  });

  it('uses the taller, wider default settings modal size', () => {
    expect(cssRule(modalCss, '.card')).toMatch(/--settings-shell-width:\s*884px;/);
    expect(cssRule(modalCss, '.card')).toMatch(/width:\s*min\(var\(--settings-shell-width\),\s*calc\(100vw - 2 \* var\(--space-24\)\)\);/);
    expect(cssRule(modalCss, '.card')).toMatch(/height:\s*min\(840px,\s*calc\(100vh - var\(--space-24\) - var\(--space-24\)\)\);/);
  });
});
