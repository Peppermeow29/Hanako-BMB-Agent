import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readCss(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body || '';
}

function declarationValue(rule: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return rule.match(new RegExp(`${escaped}\\s*:\\s*(?<value>[^;]+);`))?.groups?.value.trim() || null;
}

describe('selection quote action surface layout', () => {
  it('copies the compact floating action chrome from editor preview actions while making the quote action readable', () => {
    const selectionCss = readCss('desktop/src/react/components/selection/SelectionQuoteActionSurface.module.css');
    const previewCss = readCss('desktop/src/react/components/preview/FloatingActions.module.css');
    const selectionSurface = cssRule(selectionCss, '.surface');
    const previewSurface = cssRule(previewCss, '.floatingActionsSurface');
    const selectionButton = cssRule(selectionCss, '.button');

    for (const property of ['display', 'gap', 'background', 'border-radius', 'padding', 'box-shadow']) {
      expect(declarationValue(selectionSurface, property)).toBe(declarationValue(previewSurface, property));
    }

    expect(declarationValue(selectionButton, 'min-width')).toBe('88px');
    expect(declarationValue(selectionButton, 'height')).toBe('28px');
    expect(declarationValue(selectionButton, 'gap')).toBe('var(--space-4)');
    expect(declarationValue(selectionButton, 'padding')).toBe('0 var(--space-8)');
    expect(declarationValue(selectionButton, 'white-space')).toBe('nowrap');
  });

  it('does not cover the quote action with a transparent hit layer', () => {
    const selectionCss = readCss('desktop/src/react/components/selection/SelectionQuoteActionSurface.module.css');
    const hitArea = cssRule(selectionCss, '.surface::before');

    expect(hitArea).toBe('');
  });

  it('keeps preview actions hidden until the expanded hover zone is active', () => {
    const previewCss = readCss('desktop/src/react/components/preview/FloatingActions.module.css');
    const hitZone = cssRule(previewCss, '.floatingActions');
    const surface = cssRule(previewCss, '.floatingActionsSurface');

    expect(declarationValue(hitZone, 'top')).toBe('-20px');
    expect(declarationValue(hitZone, 'right')).toBe('-20px');
    expect(declarationValue(hitZone, 'padding')).toBe('28px');
    expect(declarationValue(surface, 'opacity')).toBe('0');
    expect(declarationValue(surface, 'pointer-events')).toBe('none');
    expect(previewCss).toContain('.floatingActions:hover .floatingActionsSurface');
    expect(previewCss).toContain('.floatingActions:focus-within .floatingActionsSurface');
    expect(previewCss).toContain('.floatingActionsPinned .floatingActionsSurface');
  });
});
