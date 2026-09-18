import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readResourceCss(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/components/chat/ChatResourceCard.module.css'),
    'utf8',
  );
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body || '';
}

describe('ChatResourceCard layout', () => {
  it('owns the shared chat resource-card width and clipping contract', () => {
    const css = readResourceCss();
    const card = cssRule(css, '.card');
    const title = cssRule(css, '.title');
    const subtitle = cssRule(css, '.subtitle');
    const actions = cssRule(css, '.actions');

    expect(card).toMatch(/--chat-resource-card-width:\s*var\(--chat-task-block-width,\s*348px\)/);
    expect(card).toMatch(/width:\s*var\(--chat-resource-card-width\)/);
    expect(card).toMatch(/max-width:\s*100%/);
    expect(title).toMatch(/text-overflow:\s*ellipsis/);
    expect(subtitle).toMatch(/text-overflow:\s*ellipsis/);
    expect(actions).toMatch(/max-width:\s*36%/);
  });

  it('keeps resource icons bare instead of adding an inner gray tile', () => {
    const css = readResourceCss();
    const icon = cssRule(css, '.icon');

    expect(icon).not.toMatch(/background:/);
    expect(icon).toMatch(/width:\s*32px/);
    expect(icon).toMatch(/height:\s*32px/);
  });

  it('marks interactive resource cards with pointer cursor affordance', () => {
    const css = readResourceCss();
    const interactiveButton = cssRule(css, '.interactive button.main');

    expect(interactiveButton).toMatch(/cursor:\s*pointer/);
  });

  it('gives the task variant the task-family container language', () => {
    const css = readResourceCss();
    const task = cssRule(css, '.task');

    expect(task).toMatch(/background:\s*var\(--tool-bg\)/);
    expect(task).toMatch(/border:\s*none/);
    expect(task).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    expect(task).toMatch(/box-shadow:\s*none/);
  });

  it('keeps the running tone neutral inside the task variant', () => {
    const css = readResourceCss();
    expect(css).toMatch(/\.task\s+\.status-accent\s*\{[^}]*color:\s*var\(--tool-text\)/);
  });
});
