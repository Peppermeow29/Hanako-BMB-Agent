import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('MessageActions layout', () => {
  function readChatCss(): string {
    return fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf8',
    );
  }

  it('uses inline footer actions instead of the old hover card action rail', () => {
    const css = readChatCss();

    expect(css).not.toMatch(/\.msgActions\s*\{/);
    expect(css).not.toMatch(/\.msgActionsPopover/);
    expect(css).not.toMatch(/--msg-actions/);
    expect(css).not.toMatch(/--msg-actions-popover-width/);
  });

  it('keeps active footer action styling when the button is hovered', () => {
    const css = readChatCss();
    const block = css.match(/\.messageFooterBtnActive:hover\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(block).toMatch(/color:\s*var\(--accent\)\s*!important/);
    expect(block).toMatch(/background:\s*rgba\(var\(--accent-rgb\),\s*0\.16\)/);
  });

  it('keeps the left footer timestamp flush with the assistant message body', () => {
    const css = readChatCss();
    const block = css.match(/\.messageFooterActionsLeft\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(block).toMatch(/align-self:\s*flex-start/);
    expect(block).toMatch(/justify-content:\s*flex-start/);
    expect(block).not.toMatch(/padding-left/);
  });

  it('right-aligns the whole user footer action row with the user message body', () => {
    const css = readChatCss();
    const block = css.match(/\.messageFooterActionsRight\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(block).toMatch(/align-self:\s*flex-end/);
    expect(block).toMatch(/justify-content:\s*flex-end/);
    expect(block).not.toMatch(/padding-right/);
  });

  it('keeps persistent footer time visible without making footer buttons permanent', () => {
    const css = readChatCss();
    const timeBlock = css.match(/\.messageFooterActionsTimePersistent\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const buttonBlock = css.match(/\.messageFooterActionsTimePersistent \.messageFooterBtn\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const hoverRule = css.match(/\.messageGroupUser:hover \.messageFooterActionsTimePersistent \.messageFooterBtn,\s*\.messageGroupAssistant:hover \.messageFooterActionsTimePersistent \.messageFooterBtn,\s*\.messageFooterActionsTimePersistent:focus-within \.messageFooterBtn,\s*\.messageFooterActionsTimePersistent:hover \.messageFooterBtn\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(timeBlock).toMatch(/opacity:\s*0\.72/);
    expect(buttonBlock).toMatch(/opacity:\s*0/);
    expect(buttonBlock).toMatch(/pointer-events:\s*none/);
    expect(hoverRule).toMatch(/opacity:\s*1/);
    expect(hoverRule).toMatch(/pointer-events:\s*auto/);
  });
});
