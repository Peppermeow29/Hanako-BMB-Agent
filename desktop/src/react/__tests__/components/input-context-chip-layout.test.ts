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

describe('input context chip layout', () => {
  it('keeps file and text quote chips in one horizontal wrapping row', () => {
    const css = readCss('desktop/src/react/components/input/InputArea.module.css');
    const row = cssRule(css, '.input-context-left');
    const attachedFiles = cssRule(css, '.attached-files');

    expect(row).toMatch(/flex-direction:\s*row/);
    expect(row).toMatch(/flex-wrap:\s*wrap/);
    expect(attachedFiles).toMatch(/display:\s*contents/);
  });

  it('uses the same shorter chip width for file and text quote references', () => {
    const css = readCss('desktop/src/react/components/shared/AttachmentChip.module.css');
    const chip = cssRule(css, '.chip');

    expect(chip).toMatch(/max-width:\s*140px/);
  });

  it('keeps inline file badges compact with ellipsis instead of wrapping long names', () => {
    const css = readCss('desktop/src/react/components/input/FileBadgeView.module.css');
    const badge = cssRule(css, '.badge');
    const name = cssRule(css, '.name');

    expect(badge).toMatch(/max-width:\s*min\(8rem,\s*100%\)/);
    expect(badge).toMatch(/overflow:\s*hidden/);
    expect(name).toMatch(/min-width:\s*0/);
    expect(name).toMatch(/overflow:\s*hidden/);
    expect(name).toMatch(/text-overflow:\s*ellipsis/);
    expect(name).toMatch(/white-space:\s*nowrap/);
  });
});
