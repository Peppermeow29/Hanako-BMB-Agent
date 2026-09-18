/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDir, '../../../../..');

function readProjectFile(pathFromRoot: string): string {
  return readFileSync(resolve(projectRoot, pathFromRoot), 'utf8');
}

function ruleBody(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'm'));
  if (!match) throw new Error(`Missing CSS rule: ${selector}`);
  return match[1];
}

describe('skill scroll CSS contract', () => {
  it('keeps the settings skill page and long skill lists scrollable inside fixed panels', () => {
    const css = readProjectFile('desktop/src/react/settings/Settings.module.css');

    expect(ruleBody(css, '.settings-body')).toContain('overflow: hidden');
    expect(ruleBody(css, '.settings-main')).toContain('min-height: 0');
    expect(ruleBody(css, '.settings-main')).toContain('min-width: 0');

    const skillListRule = ruleBody(css, '.skill-bundle-tree .skills-list-block');
    expect(skillListRule).toContain('max-height:');
    expect(skillListRule).toContain('overflow-y: auto');
  });

  it('keeps the skill viewer file tree and markdown preview scrollable', () => {
    const css = readProjectFile('desktop/src/styles.css');

    expect(ruleBody(css, '.sv-body')).toContain('min-height: 0');
    expect(ruleBody(css, '.sv-sidebar')).toContain('min-height: 0');
    expect(ruleBody(css, '.sv-content')).toContain('min-height: 0');
  });
});
