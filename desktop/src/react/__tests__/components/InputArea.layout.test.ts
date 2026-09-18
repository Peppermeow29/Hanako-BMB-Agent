import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { calculateInputCardBottomInset } from '../../utils/input-card-layout';

function cssBlock(css: string, selector: string): string {
  const exactSelector = new RegExp(`^${selector}$`);
  for (const match of css.matchAll(/([^{}]+)\{(?<body>[^}]*)\}/g)) {
    const selectorText = match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (exactSelector.test(selectorText)) return match.groups?.body || '';
  }
  return '';
}

function readOptionalCss(relativePath: string): string | null {
  const fullPath = path.join(process.cwd(), relativePath);
  return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : null;
}

describe('InputArea layout', () => {
  it('keeps chat, composer, welcome, and bridge widths in their intended lanes', () => {
    const globalCss = fs.readFileSync(path.join(process.cwd(), 'desktop/src/styles.css'), 'utf8');
    const chatCss = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf8',
    );
    const workbenchCss = readOptionalCss('desktop/src/react/workbench/workbench.module.css');
    const floatingCss = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/FloatingPanels.module.css'),
      'utf8',
    );

    const inputAreaBlock = cssBlock(globalCss, String.raw`\.input-area > \*`);
    const welcomeInputAreaBlock = cssBlock(globalCss, String.raw`\.main-content\.welcome-mode \.input-area > \*`);
    const sessionMessagesBlock = cssBlock(chatCss, String.raw`\.sessionMessages`);
    const userMessageBlock = cssBlock(chatCss, String.raw`\.messageUser`);
    const assistantMessageBlock = cssBlock(chatCss, String.raw`\.messageAssistant`);

    expect(globalCss).toMatch(/--editor-markdown-content-width:\s*720px/);
    expect(globalCss).toMatch(/--chat-column-width:\s*720px/);
    expect(globalCss).toMatch(/--chat-message-font-size:\s*15px/);
    expect(globalCss).toMatch(/--chat-input-column-extra:\s*1\.25rem/);
    expect(globalCss).toMatch(/--chat-input-column-width:\s*calc\(var\(--chat-column-width\) \+ var\(--chat-input-column-extra\)\)/);
    expect(globalCss).toMatch(/--welcome-chat-input-column-width:\s*40rem/);
    expect(inputAreaBlock).toMatch(/max-width:\s*var\(--chat-input-column-width\)/);
    expect(welcomeInputAreaBlock).toMatch(/max-width:\s*var\(--welcome-chat-input-column-width\)/);
    expect(sessionMessagesBlock).toMatch(/max-width:\s*var\(--chat-column-width\)/);
    expect(userMessageBlock).toMatch(/font-size:\s*var\(--chat-message-font-size\)/);
    expect(assistantMessageBlock).toMatch(/font-size:\s*var\(--chat-message-font-size\)/);
    if (workbenchCss) {
      const parallelChatSurfaceBlock = cssBlock(workbenchCss, String.raw`\.parallelChatSurface`);
      expect(parallelChatSurfaceBlock).not.toMatch(/--chat-column-width/);
      expect(parallelChatSurfaceBlock).not.toMatch(/760px/);
    }
    expect(floatingCss).not.toMatch(/--chat-column-width:\s*var\(--bridge-chat-column-width\)/);
  });

  it('keeps composer horizontal padding symmetric with the left inset', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/input/InputArea.module.css'),
      'utf8',
    );
    const inputWrapperBlock = cssBlock(css, String.raw`\.input-wrapper`);

    expect(inputWrapperBlock).toMatch(/padding:\s*var\(--space-16\)\s+var\(--space-16\)\s+var\(--space-8\)/);
  });

  it('keeps mobile drawers out of the flex layout while they close', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/mobile/MobileApp.css'),
      'utf8',
    );

    expect(css).toMatch(/\.mobile-desktop-root\s*\{[^}]*font-size:\s*var\(--fs-title\)/s);
    expect(css).toMatch(/\.mobile-desktop-root \.sidebar,\s*\.mobile-desktop-root \.jian-sidebar\s*\{[^}]*position:\s*fixed/s);
    expect(css).toMatch(/\.mobile-desktop-root \.sidebar,\s*\.mobile-desktop-root \.jian-sidebar\s*\{[^}]*box-shadow:\s*none/s);
    expect(css).toMatch(/\.mobile-desktop-root \.jian-sidebar-inner\s*\{[^}]*box-shadow:\s*none/s);
  });

  it('keeps the mobile model selector content-sized and aligned with icon buttons', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/input/InputArea.module.css'),
      'utf8',
    );
    const selectorBlock = cssBlock(css, String.raw`\.input-surface-mobile \.model-selector`);
    const pillBlock = cssBlock(css, String.raw`\.input-surface-mobile \.model-pill`);

    expect(selectorBlock).toMatch(/flex:\s*0 1 auto/);
    expect(pillBlock).toMatch(/width:\s*auto/);
    expect(pillBlock).toMatch(/height:\s*30px/);
  });

  it('keeps the mention menu as compact as the Skill menu and gives primary names display priority', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/input/InputArea.module.css'),
      'utf8',
    );
    const slashMenuBlock = cssBlock(css, String.raw`\.slash-menu`);
    const mentionMenuBlock = cssBlock(css, String.raw`\.mention-menu`);
    const mentionNameBlock = cssBlock(css, String.raw`\.mention-name`);
    const mentionDetailBlock = cssBlock(css, String.raw`\.mention-detail`);

    expect(slashMenuBlock).toMatch(/max-width:\s*360px/);
    expect(slashMenuBlock).toMatch(/max-height:\s*308px/);
    expect(mentionMenuBlock).toMatch(/width:\s*min\(360px,\s*calc\(100vw - 2rem\)\)/);
    expect(mentionMenuBlock).toMatch(/max-height:\s*308px/);
    expect(mentionNameBlock).toMatch(/flex:\s*0 0 auto/);
    expect(mentionNameBlock).toMatch(/max-width:\s*100%/);
    expect(mentionDetailBlock).toMatch(/flex:\s*1 1 auto/);
  });

  it('keeps one transient row free, then pushes chat when the whole input surface reaches another row', () => {
    expect(calculateInputCardBottomInset({
      cardHeight: 80,
      editorHeight: 24,
      editorLineHeight: 24,
    })).toBe(40);

    expect(calculateInputCardBottomInset({
      cardHeight: 104,
      editorHeight: 48,
      editorLineHeight: 24,
    })).toBe(40);

    expect(calculateInputCardBottomInset({
      cardHeight: 128,
      editorHeight: 72,
      editorLineHeight: 24,
    })).toBe(64);

    expect(calculateInputCardBottomInset({
      cardHeight: 80,
      editorHeight: 24,
      editorLineHeight: 24,
      upperChromeHeight: 60,
    })).toBe(40);

    expect(calculateInputCardBottomInset({
      cardHeight: 104,
      editorHeight: 48,
      editorLineHeight: 24,
      upperChromeHeight: 60,
    })).toBe(64);

    expect(calculateInputCardBottomInset({
      cardHeight: 128,
      editorHeight: 72,
      editorLineHeight: 24,
      upperChromeHeight: 60,
    })).toBe(88);
  });

  it('uses the measured input bottom inset as the chat panel and footer cut point', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf8',
    );
    const shellBlock = cssBlock(css, String.raw`\.sessionShell`);
    const footerBlock = cssBlock(css, String.raw`\.sessionFooter`);

    expect(shellBlock).toMatch(/--chat-scrollbar-bottom-inset:\s*var\(--input-card-bottom-inset,\s*calc\(var\(--input-card-h,\s*0px\) \/ 2\)\)/);
    expect(shellBlock).toMatch(/bottom:\s*calc\(var\(--chat-scrollbar-bottom-inset\) \+ var\(--space-24\)\)/);
    expect(footerBlock).toMatch(/height:\s*calc\(var\(--chat-scrollbar-bottom-inset\) \+ var\(--space-24\) \+ 5rem\)/);
  });

  it('floats the scroll-to-bottom FAB above the measured input card instead of a fixed offset (#1297)', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/Chat.module.css'),
      'utf8',
    );
    const fabBlock = cssBlock(css, String.raw`\.scrollToBottomFab`);

    // FAB 必须跟随输入卡片实时高度（--input-card-h），不能写死固定 bottom，
    // 否则多行输入时输入框升高会盖住 FAB（#1297）。
    expect(fabBlock).toMatch(/bottom:\s*calc\(var\(--input-card-h[^)]*\)\s*\+\s*var\(--space-16\)\)/);
  });
});
