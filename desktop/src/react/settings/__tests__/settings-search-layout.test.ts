import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readProjectFile(pathFromRoot: string) {
  return readFileSync(join(process.cwd(), pathFromRoot), 'utf8');
}

function cssRule(source: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('settings search sidebar layout', () => {
  it('uses a 180px settings navigation rail', () => {
    const css = readProjectFile('desktop/src/react/settings/Settings.module.css');

    expect(css).toContain('--settings-nav-width: 180px;');
  });

  it('keeps the modal shell at the single 884px width token', () => {
    const css = readProjectFile('desktop/src/react/components/SettingsModalShell.module.css');

    expect(css).toContain('--settings-shell-width: 884px;');
    expect(css).toContain('width: min(var(--settings-shell-width), calc(100vw - 2 * var(--space-24)));');
    expect(css).not.toContain('1200px');
  });
});

describe('settings page width contract', () => {
  it('derives the header content track from the remaining shell width', () => {
    const css = readProjectFile('desktop/src/react/settings/Settings.module.css');
    const header = cssRule(css, '.settings-header-modal');

    expect(header).toMatch(/minmax\(0,\s*1fr\)/);
    expect(header).toMatch(/padding:[^;]*var\(--settings-main-x-padding/);
    expect(header).not.toMatch(/640px|960px/);
  });

  it('keeps every tab on the full derived content track', () => {
    const css = readProjectFile('desktop/src/react/settings/Settings.module.css');

    expect(css).toMatch(
      /\.settings-main\s*>\s*\[data-settings-page\]\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow-x:\s*hidden;/s,
    );
    expect(css).not.toMatch(/settings-main-wide|settings-panel-wide/);
  });

  it('does not allow any tab to widen the shell', () => {
    const source = readProjectFile('desktop/src/react/settings/SettingsContent.tsx');
    const shell = readProjectFile('desktop/src/react/components/SettingsModalShell.tsx');

    expect(source).not.toMatch(/isWideTab|settings-panel-wide|settings-main-wide/);
    expect(shell).not.toMatch(/isWideSettingsPage|data-wide/);
  });

  it('closes the shell-to-content flex sizing chain', () => {
    const shellCss = readProjectFile('desktop/src/react/components/SettingsModalShell.module.css');
    const settingsCss = readProjectFile('desktop/src/react/settings/Settings.module.css');
    const source = readProjectFile('desktop/src/react/settings/SettingsContent.tsx');
    const card = cssRule(shellCss, '.card');
    const root = cssRule(settingsCss, '.settings-content-root');

    expect(card).not.toMatch(/min-width:\s*0;/);
    expect(card).toMatch(/max-width:\s*min\(var\(--settings-shell-width\),/);
    expect(root).toMatch(/width:\s*100%/);
    expect(root).toMatch(/flex:\s*1 1 auto/);
    expect(root).toMatch(/min-width:\s*0/);
    expect(source).toContain("className={styles['settings-content-root']}");
  });
});
