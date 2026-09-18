import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SETTINGS_DIR = join(ROOT, 'desktop/src/react/settings');
const TABS_DIR = join(SETTINGS_DIR, 'tabs');

function read(pathFromRoot: string) {
  return readFileSync(join(ROOT, pathFromRoot), 'utf8');
}

function walkTsx(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walkTsx(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('settings primitive discipline', () => {
  it('wraps every built-in and plugin settings page in the same page primitive', () => {
    const source = read('desktop/src/react/settings/SettingsContent.tsx');

    expect(source).toContain("import { SettingsPage } from './components/SettingsPrimitives';");
    expect(source).toMatch(/<SettingsPage tab=\{effectiveActiveTab\}>\s*<ActiveTab \/>\s*<\/SettingsPage>/s);
  });

  it('has no layout-bypassing flush variant or tab-specific wide shell', () => {
    const sources = [
      ...walkTsx(SETTINGS_DIR).map(path => readFileSync(path, 'utf8')),
      read('desktop/src/react/settings/components/settings-components.module.css'),
      read('desktop/src/react/settings/Settings.module.css'),
      read('desktop/src/react/components/SettingsModalShell.tsx'),
      read('desktop/src/react/components/SettingsModalShell.module.css'),
    ].join('\n');

    expect(sources).not.toMatch(/variant=["']flush["']|sectionFlush|data-wide|settings-(?:panel|main)-wide|1200px|960px/);
  });

  it('routes shared controls directly through the ui layer', () => {
    const violations = walkTsx(TABS_DIR)
      .map(path => ({ path, source: readFileSync(path, 'utf8') }))
      .filter(({ source }) => /widgets\/(?:Toggle|SelectWidget)/.test(source))
      .map(({ path }) => relative(ROOT, path));

    expect(violations).toEqual([]);
  });

  it('keeps inline styles on a ratchet while dynamic values migrate to css variables', () => {
    const files = walkTsx(TABS_DIR);
    const count = files.reduce((total, path) => {
      const matches = readFileSync(path, 'utf8').match(/style=\{\{/g);
      return total + (matches?.length ?? 0);
    }, 0);

    // Primitive migration reduced the count from 81 to 48. This ceiling may only move down.
    expect(count).toBeLessThanOrEqual(48);
  });

  it('keeps raw page sections out of AgentTab', () => {
    const source = read('desktop/src/react/settings/tabs/AgentTab.tsx');

    expect(source).not.toMatch(/<(?:section|h2)\b/);
    expect(source).toContain('<SettingsSection');
  });
});
