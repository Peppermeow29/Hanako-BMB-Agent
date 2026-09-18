import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readCss(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function cssRule(css: string, selector: string): string {
  const index = css.indexOf(selector);
  if (index < 0) return '';
  const start = css.indexOf('{', index);
  if (start < 0) return '';
  const end = css.indexOf('}', start);
  return end < 0 ? '' : css.slice(start + 1, end);
}

describe('markdown editor selection style', () => {
  it('keeps browser selection styling scoped to Markdown CodeMirror editors', () => {
    const css = readCss('desktop/src/react/components/Preview.module.css');
    const tokenRule = cssRule(css, ':global(.preview-editor.mode-markdown .cm-editor)');
    const selectionRule = cssRule(css, ':global(.preview-editor.mode-markdown .cm-content::selection)');
    const drawSelectionRule = cssRule(css, ':global(.preview-editor.mode-markdown .cm-selectionBackground)');

    expect(tokenRule).toContain('--editor-markdown-selection-bg: color-mix(in srgb, var(--accent) 20%, transparent);');
    expect(selectionRule).toContain('background: var(--editor-markdown-selection-bg);');
    expect(selectionRule).toContain('color: var(--text);');
    expect(selectionRule).toContain('text-shadow: none;');
    expect(drawSelectionRule).toContain('background: var(--editor-markdown-selection-bg) !important;');
    expect(css).not.toContain(':global(.cm-content::selection)');
  });
});
