import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS_PATH = path.join(process.cwd(), 'desktop/src/react/quick-chat/QuickChatApp.module.css');
const APP_PATH = path.join(process.cwd(), 'desktop/src/react/quick-chat/QuickChatApp.tsx');

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\ /g, '\\s+');
  return css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body || '';
}

describe('QuickChatApp compact layout', () => {
  it('keeps compact Quick Chat sized to the composer while expanded chat fills the window', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const panelBlock = cssBlock(css, '.panel');
    const expandedPanelBlock = cssBlock(css, '.expanded .panel');
    const dragStripBlock = cssBlock(css, '.dragStrip');

    expect(panelBlock).not.toMatch(/height:\s*100%/);
    expect(expandedPanelBlock).toMatch(/height:\s*100%/);
    expect(dragStripBlock).toMatch(/display:\s*none/);
    expect(dragStripBlock).not.toMatch(/flex:\s*0 0 12px/);
    expect(dragStripBlock).not.toMatch(/-webkit-app-region:\s*drag/);
  });

  it('keeps the quick chat composer spellcheck disabled for Chinese text input', () => {
    const source = fs.readFileSync(APP_PATH, 'utf8');
    const textareaBlock = source.match(/<textarea[\s\S]*?\/>/)?.[0] ?? '';

    expect(textareaBlock).toContain('spellCheck={false}');
  });

  it('binds a forked child to Quick Chat local state before rendering its transcript', () => {
    const source = fs.readFileSync(APP_PATH, 'utf8');
    const handler = source.match(/const handleForkCreated[\s\S]*?\n {2}}, \[\]\);/)?.[0] ?? '';

    expect(handler).toContain('sessionPathRef.current = forked.sessionPath');
    expect(handler).toContain('setSessionPath(forked.sessionPath)');
    expect(handler).toContain('bindQuickChatDetachedSession({');
    expect(handler).toContain('await loadMessages(forked.sessionPath)');
    expect(source).toContain('onForkCreated={handleForkCreated}');
  });
});
