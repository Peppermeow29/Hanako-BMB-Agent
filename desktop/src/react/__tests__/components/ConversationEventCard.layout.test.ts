import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readChatCss(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
    'utf8',
  );
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body || '';
}

describe('ConversationEventCard interaction styling', () => {
  it('deepens the card background on hover without shadow or pointer cursor', () => {
    const css = readChatCss();
    const clickable = cssRule(css, '.conversationEventCardClickable');
    const hover = cssRule(css, '.conversationEventCardClickable:hover');

    expect(clickable).toMatch(/cursor:\s*default/);
    expect(clickable).not.toMatch(/cursor:\s*pointer/);
    expect(hover).toMatch(/background:\s*color-mix\(in srgb,\s*var\(--tool-bg\),\s*var\(--text\) 6%\)/);
    expect(hover).not.toMatch(/box-shadow/);
  });
});
