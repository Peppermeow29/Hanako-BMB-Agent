import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EDITOR_TYPOGRAPHY,
  applyEditorTypography,
  normalizeEditorTypography,
} from '../../editor/typography';

function readPreviewStyles(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/components/Preview.module.css'),
    'utf8',
  );
}

function readGlobalStyles(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/styles.css'),
    'utf8',
  );
}

function readMobileStyles(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/mobile/mobile-entry.css'),
    'utf8',
  );
}

function readScreenshotThemeStyles(): string[] {
  return [
    'solarized-light.css',
    'solarized-light-desktop.css',
    'solarized-dark.css',
    'solarized-dark-desktop.css',
    'sakura-light.css',
    'sakura-light-desktop.css',
  ].map((fileName) => fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/screenshot-themes', fileName),
    'utf8',
  ));
}

function readEditorTheme(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/editor/theme.ts'),
    'utf8',
  );
}

function readEditorCoverField(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/editor/cover-field.ts'),
    'utf8',
  );
}

function readEditorHighlight(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/react/editor/highlight.ts'),
    'utf8',
  );
}

describe('editor typography settings', () => {
  it('uses markdown defaults and preserves future heading controls', () => {
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.fontPreset).toBe('follow');
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.bodyFontSize).toBe(16);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.heading1FontSize).toBe(28);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.heading2FontSize).toBe(21);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.heading3FontSize).toBe(18);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.heading4FontSize).toBe(16);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.heading5FontSize).toBe(15);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.heading6FontSize).toBe(14);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.lineHeight).toBe(1.5);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.contentPadding).toBe(24);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.contentWidth).toBe(720);
  });

  it('normalizes partial and invalid values without mutating the defaults', () => {
    const normalized = normalizeEditorTypography({
      markdown: {
        bodyFontSize: 99,
        heading1FontSize: 10,
        heading6FontSize: 80,
        lineHeight: 'wide',
        contentPadding: -12,
        contentWidth: 960,
        fontPreset: 'comic',
      },
    });

    expect(normalized.markdown.fontPreset).toBe('follow');
    expect(normalized.markdown.bodyFontSize).toBe(24);
    expect(normalized.markdown.heading1FontSize).toBe(16);
    expect(normalized.markdown.heading2FontSize).toBe(21);
    expect(normalized.markdown.heading6FontSize).toBe(24);
    expect(normalized.markdown.lineHeight).toBe(1.5);
    expect(normalized.markdown.contentPadding).toBe(0);
    expect(normalized.markdown.contentWidth).toBe(720);
    expect(DEFAULT_EDITOR_TYPOGRAPHY.markdown.contentPadding).toBe(24);

    const selected = normalizeEditorTypography({ markdown: { fontPreset: 'sans', contentWidth: 'unlimited' } });
    expect(selected.markdown.fontPreset).toBe('sans');
    expect(selected.markdown.contentWidth).toBe('unlimited');
  });

  it('maps the follow preset to the text-face token with display-face fallback', () => {
    const values = new Map<string, string>();
    const root = {
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        getPropertyValue: (name: string) => values.get(name) || '',
      },
    } as unknown as HTMLElement;

    applyEditorTypography({ markdown: { fontPreset: 'follow' } }, root);

    expect(root.style.getPropertyValue('--editor-markdown-font-family')).toBe(
      'var(--font-serif-text, var(--font-serif))',
    );
  });

  it('applies normalized typography as document-level CSS variables', () => {
    const values = new Map<string, string>();
    const root = {
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        getPropertyValue: (name: string) => values.get(name) || '',
      },
    } as unknown as HTMLElement;

    applyEditorTypography({
      markdown: {
        bodyFontSize: 17,
        heading1FontSize: 26,
        heading2FontSize: 21,
        heading3FontSize: 19,
        heading4FontSize: 18,
        heading5FontSize: 17,
        heading6FontSize: 16,
        lineHeight: 1.8,
        contentPadding: 28,
        contentWidth: 800,
        fontPreset: 'sans',
      },
    }, root);

    const style = root.style;
    expect(style.getPropertyValue('--editor-markdown-font-family')).toBe('var(--font-ui)');
    expect(style.getPropertyValue('--editor-markdown-font-size')).toBe('17px');
    expect(style.getPropertyValue('--chat-message-font-size')).toBe('');
    expect(style.getPropertyValue('--editor-markdown-h1-font-size')).toBe('26px');
    expect(style.getPropertyValue('--editor-markdown-h2-font-size')).toBe('21px');
    expect(style.getPropertyValue('--editor-markdown-h3-font-size')).toBe('19px');
    expect(style.getPropertyValue('--editor-markdown-h4-font-size')).toBe('18px');
    expect(style.getPropertyValue('--editor-markdown-h5-font-size')).toBe('17px');
    expect(style.getPropertyValue('--editor-markdown-h6-font-size')).toBe('16px');
    expect(style.getPropertyValue('--editor-markdown-line-height')).toBe('1.8');
    expect(style.getPropertyValue('--editor-markdown-content-padding-x')).toBe('28px');
    expect(style.getPropertyValue('--editor-markdown-content-width')).toBe('800px');
    expect(style.getPropertyValue('--chat-column-width')).toBe('');
    expect(style.getPropertyValue('--chat-input-column-width')).toBe('');
  });

  it('maps unlimited reading width to unrestricted CSS max-width values', () => {
    const values = new Map<string, string>();
    const root = {
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        getPropertyValue: (name: string) => values.get(name) || '',
      },
    } as unknown as HTMLElement;

    applyEditorTypography({ markdown: { contentWidth: 'unlimited' } }, root);

    const style = root.style;
    expect(style.getPropertyValue('--editor-markdown-content-width')).toBe('none');
    expect(style.getPropertyValue('--chat-column-width')).toBe('');
    expect(style.getPropertyValue('--chat-input-column-width')).toBe('');
  });

  it('uses the editor typography variables for markdown preview font size and weight', () => {
    const css = readPreviewStyles();

    expect(css).toMatch(/:global\(\.preview-markdown\)\s*\{[\s\S]*padding:\s*var\(--space-24\)\s+var\(--editor-markdown-content-padding-x\)\s+var\(--space-16\)/);
    expect(css).toMatch(/:global\(\.preview-markdown\)\s*\{[\s\S]*font-size:\s*var\(--editor-markdown-font-size\)/);
    expect(css).toMatch(/:global\(\.preview-markdown\)\s*\{[\s\S]*font-family:\s*var\(--editor-markdown-font-family,\s*var\(--font-serif-text\)\)/);
    expect(css).toMatch(/:global\(\.preview-markdown\)\s*\{[\s\S]*font-weight:\s*400/);
    expect(css).toMatch(/:global\(\.preview-markdown\) h1\s*\{[\s\S]*font-size:\s*var\(--editor-markdown-h1-font-size\)[\s\S]*font-weight:\s*400/);
    expect(css).toMatch(/:global\(\.preview-markdown\.markdown-has-cover\) h1\s*\{[\s\S]*text-align:\s*left/);

    for (const level of [2, 3]) {
      expect(css).toMatch(new RegExp(
        `:global\\(\\.preview-markdown\\) h${level}\\s*\\{[\\s\\S]*font-size:\\s*var\\(--editor-markdown-h${level}-font-size\\)[\\s\\S]*font-weight:\\s*500`,
      ));
    }
    for (const level of [4, 5, 6]) {
      expect(css).toMatch(new RegExp(
        `:global\\(\\.preview-markdown\\) h${level}\\s*\\{[\\s\\S]*font-size:\\s*var\\(--editor-markdown-h${level}-font-size\\)[\\s\\S]*font-weight:\\s*600`,
      ));
    }

    expect(css).toMatch(/:global\(\.preview-markdown\) strong\s*\{[\s\S]*font-weight:\s*700/);
  });

  it('preview markdown enforces the baseline rhythm contract', () => {
    const css = readPreviewStyles();
    expect(css).toMatch(/--md-rhythm:\s*calc\(var\(--editor-markdown-font-size\)\s*\*\s*var\(--editor-markdown-line-height\)\)/);
    expect(css).toMatch(/:global\(\.preview-markdown\)\s*>\s*h1:first-child[\s\S]*?text-align:\s*center/);
    expect(css).toMatch(/:global\(\.preview-markdown\) h1\s*\{[\s\S]*?border-bottom:\s*1px solid var\(--border\)[\s\S]*?padding-bottom:\s*calc\(var\(--md-rhythm\) - 1px\)/);
    expect(css).toMatch(/:global\(\.preview-markdown\) hr\s*\{[\s\S]*?height:\s*var\(--md-rhythm\)/);
    expect(css).toMatch(/:global\(\.preview-markdown\) table\s*\{[\s\S]*?border-collapse:\s*separate[\s\S]*?border-radius:\s*var\(--radius-xs\)/);
    expect(css).toMatch(/thead th\)?\s*\{[\s\S]*?color-mix\(in srgb, var\(--text\) 9%, transparent\)/);
  });

  it('adds page-header space to markdown previews without a cover', () => {
    const css = readPreviewStyles();

    expect(css).toMatch(
      /:global\(\.markdown-cover-drop-host \.preview-markdown\)\s*\{[\s\S]*padding-top:\s*calc\(var\(--space-40\)\s*\+\s*var\(--space-24\)\)/,
    );
  });

  it('uses the same page-header spacing in the markdown editor', () => {
    const theme = readEditorTheme();

    expect(theme).toMatch(/padding:\s*'calc\(var\(--space-40\) \+ var\(--space-24\)\) 0 var\(--preview-markdown-editor-bottom-space, var\(--space-16\)\)'/);
    expect(theme).toMatch(/'&\.cm-markdown-has-top-cover \.cm-scroller':\s*\{[\s\S]*paddingTop:\s*'0'/);
    expect(theme).toMatch(/'\.cm-markdown-cover':\s*\{[\s\S]*margin:\s*'0 auto'/);
    expect(theme).toMatch(/'\.cm-markdown-cover':\s*\{[\s\S]*paddingBottom:\s*'var\(--space-24\)'/);
    expect(theme).toMatch(/'\.cm-markdown-cover':\s*\{[\s\S]*boxSizing:\s*'content-box'/);
    expect(theme).toMatch(/'\.cm-markdown-cover-resize':\s*\{[\s\S]*bottom:\s*'var\(--space-24\)'/);
  });

  it('keeps markdown editor and preview bottoms away from the card edge', () => {
    const css = readPreviewStyles();
    const theme = readEditorTheme();

    expect(css).toMatch(/\.previewPanelBody\s*\{[\s\S]*--preview-markdown-bottom-space:\s*calc\(var\(--space-40\)\s*\+\s*var\(--space-40\)\s*\+\s*var\(--space-24\)\s*\+\s*var\(--space-24\)\)/);
    expect(css).toMatch(/\.markdownPreviewDocument\s*\{[\s\S]*padding-bottom:\s*var\(--preview-markdown-bottom-space\)/);
    expect(css).toMatch(/:global\(\.preview-editor\.mode-markdown\)\s*\{[\s\S]*--preview-markdown-editor-bottom-space:\s*var\(--preview-markdown-bottom-space,\s*calc\(var\(--space-40\)\s*\+\s*var\(--space-40\)\s*\+\s*var\(--space-24\)\s*\+\s*var\(--space-24\)\)\)/);
    expect(theme).toMatch(/var\(--preview-markdown-editor-bottom-space,\s*var\(--space-16\)\)/);
  });

  it('constrains markdown tables while allowing cell wrapping', () => {
    for (const css of [readGlobalStyles(), readMobileStyles()]) {
      expect(css).toMatch(/\.md-content \.markdown-table-scroll\s*\{[^}]*max-width:\s*100%/);
      expect(css).not.toMatch(/\.md-content \.markdown-table-scroll\s*\{[^}]*overflow-x:\s*auto/);
      expect(css).toMatch(/\.md-content \.markdown-table-scroll > table\s*\{[^}]*width:\s*100%/);
      expect(css).toMatch(/\.md-content \.markdown-table-scroll > table\s*\{[^}]*table-layout:\s*fixed/);
      expect(css).toMatch(/\.md-content \.markdown-table-scroll > table\s*\{[^}]*margin:\s*0/);
      expect(css).not.toMatch(/\.md-content \.markdown-table-scroll > table\s*\{[^}]*min-width:\s*max-content/);
      expect(css).toMatch(/\.md-content th,\s*\.md-content td\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/);
    }

    const previewCss = readPreviewStyles();
    expect(previewCss).toMatch(/:global\(\.preview-markdown > \*\)\s*\{[\s\S]*max-width:\s*var\(--editor-markdown-content-width\)[\s\S]*margin-left:\s*auto[\s\S]*margin-right:\s*auto/);
    expect(previewCss).toMatch(/:global\(\.preview-markdown > \.markdown-table-scroll\)\s*\{[\s\S]*width:\s*100%[\s\S]*max-width:\s*var\(--editor-markdown-content-width\)[\s\S]*margin-left:\s*auto[\s\S]*margin-right:\s*auto/);
    expect(previewCss).toMatch(/:global\(\.preview-markdown\) table\s*\{[^}]*width:\s*fit-content[^}]*max-width:\s*100%[^}]*table-layout:\s*auto/);
    // Preview 表格文字必须能在容器内断行，否则不可断行的长 token（无空格的英文/数字/哈希）
    // 会撑破 table-layout:auto 的 shrink-to-fit 算法，让 table 实际渲染宽度超出
    // markdown-table-scroll 的 max-width（运行时用 getBoundingClientRect 复现过：
    // 缺这条时 table 901px vs 容器 720px，补上后精确收敛到 720px）。
    expect(previewCss).toMatch(/:global\(\.preview-markdown\) td\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/);

    // Editor 内嵌表格 widget 是 CodeMirror 的 block:true 替换 widget，DOM 上是
    // .cm-content 的直接子节点、不在 .cm-line 里，因此 .cm-line 的
    // max-width:var(--editor-markdown-content-width) 约束不到它。历史上这里被写成
    // max-width:100%（相对 .cm-content 计算，等于不限宽），必须精确断言用的是
    // 变量而不是百分比字面量，否则测试抓不住"值写错成 100%"这种回归。
    expect(previewCss).toMatch(/:global\(\.cm-table-widget\)\s*\{[^}]*max-width:\s*var\(--editor-markdown-content-width\)/);
    expect(previewCss).not.toMatch(/:global\(\.cm-table-widget\)\s*\{[^}]*max-width:\s*100%/);
    // 表格左右边界要和 .cm-line 的文字列同一套居中机制（margin auto），否则宽度对了但没居中对齐
    expect(previewCss).toMatch(/:global\(\.cm-table-widget\)\s*\{[^}]*margin:\s*var\(--space-4\)\s+auto/);
    expect(previewCss).not.toMatch(/:global\(\.cm-table-widget\)\s*\{[^}]*overflow-x:\s*auto/);
    expect(previewCss).toMatch(/:global\(\.cm-table-widget table\)\s*\{[^}]*width:\s*100%[^}]*table-layout:\s*fixed/);
    expect(previewCss).not.toMatch(/:global\(\.cm-table-widget table\)\s*\{[^}]*min-width:\s*max-content/);
    expect(previewCss).toMatch(/:global\(\.cm-table-widget th\),\s*:global\(\.cm-table-widget td\)\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/);

    for (const css of readScreenshotThemeStyles()) {
      expect(css).toMatch(/\.markdown-table-scroll\s*\{[^}]*max-width:\s*100%/);
      expect(css).not.toMatch(/\.markdown-table-scroll\s*\{[^}]*overflow-x:\s*auto/);
      expect(css).toMatch(/table\s*\{[^}]*width:\s*100%[^}]*table-layout:\s*fixed/);
      expect(css).toMatch(/\.markdown-table-scroll > table\s*\{[^}]*table-layout:\s*fixed/);
      expect(css).toMatch(/\.markdown-table-scroll > table\s*\{[^}]*margin:\s*0/);
      expect(css).not.toMatch(/\.markdown-table-scroll > table\s*\{[^}]*min-width:\s*max-content/);
      expect(css).toMatch(/th,\s*td\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/);
    }
  });

  it('uses the same typography variables in markdown editor and preview rendering', () => {
    const theme = readEditorTheme();
    const coverField = readEditorCoverField();
    const highlight = readEditorHighlight();
    const previewCss = readPreviewStyles();
    const cmContentBlocks = [...theme.matchAll(/'\.cm-content':\s*\{(?<body>[^}]*)\}/g)];
    const markdownContentRule = cmContentBlocks.at(-1)?.groups?.body ?? '';

    expect(theme).toMatch(/'&':\s*\{\s*fontSize:\s*'var\(--editor-markdown-font-size\)'/);
    expect(theme).toMatch(/lineHeight:\s*'var\(--editor-markdown-line-height\)'/);
    expect(theme).toMatch(/'\.cm-line':\s*\{[\s\S]*maxWidth:\s*'var\(--editor-markdown-content-width\)'/);
    expect(theme).toMatch(/'\.cm-line':\s*\{[\s\S]*margin:\s*'0 auto'/);
    expect(markdownContentRule).not.toMatch(/maxWidth/);
    expect(coverField).toMatch(/Decoration\.line\(\{\s*class:\s*'cm-markdown-cover-line'\s*\}\)/);
    expect(theme).toMatch(/'\.cm-line\.cm-markdown-cover-line':\s*\{[\s\S]*maxWidth:\s*'none'/);
    expect(theme).toMatch(/'\.cm-markdown-cover':\s*\{[\s\S]*width:\s*'100%'/);
    expect(theme).toMatch(/'\.cm-markdown-cover':\s*\{[\s\S]*maxWidth:\s*'none'/);
    expect(theme).toMatch(/'--editor-markdown-content-inset-x':\s*'max\(var\(--editor-markdown-content-padding-x\), var\(--editor-markdown-block-rail-space, 0px\)\)'/);
    expect(theme).toMatch(/padding:\s*'0 var\(--editor-markdown-content-inset-x\)'/);
    expect(theme).toMatch(/'\.cm-markdown-cover\.cm-markdown-cover-bleed-x':\s*\{[\s\S]*marginLeft:\s*'calc\(0px - var\(--editor-markdown-content-inset-x\)\)'/);
    expect(theme).toMatch(/width:\s*'calc\(100% \+ var\(--editor-markdown-content-inset-x\) \+ var\(--editor-markdown-content-inset-x\)\)'/);
    expect(previewCss).toMatch(/--editor-markdown-block-rail-space:\s*36px/);
    expect(highlight).toMatch(/tags\.heading1,\s*fontSize:\s*'var\(--editor-markdown-h1-font-size\)'/);
    expect(highlight).toMatch(/tags\.heading6,\s*fontSize:\s*'var\(--editor-markdown-h6-font-size\)'/);
    expect(theme).toMatch(/'\.cm-line\.cm-unconfirmed-heading-line \*':\s*\{[\s\S]*fontSize:\s*'var\(--editor-markdown-font-size\)'[\s\S]*fontWeight:\s*'inherit'/);
    expect(previewCss).toMatch(/font-size:\s*var\(--editor-markdown-font-size\)/);
    expect(previewCss).toMatch(/max-width:\s*var\(--editor-markdown-content-width\)/);
    expect(previewCss).toMatch(/margin-left:\s*auto/);
    expect(previewCss).toMatch(/:global\(\.markdown-cover\)\s*\{[\s\S]*width:\s*100%/);
    expect(previewCss).toMatch(/font-size:\s*var\(--editor-markdown-h1-font-size\)/);
    expect(previewCss).toMatch(/font-size:\s*var\(--editor-markdown-h6-font-size\)/);
  });

  it('leaves CodeMirror editor layout to the editor themes', () => {
    const css = readPreviewStyles();
    const contentRule = css.match(/:global\(\.preview-editor \.cm-content\)\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? '';

    expect(contentRule).not.toMatch(/max-width/);
    expect(contentRule).not.toMatch(/margin:\s*0 auto/);
    expect(css).not.toMatch(/:global\(\.preview-editor \.cm-scroller\)\s*\{/);
    expect(css).not.toMatch(/:global\(\.preview-editor \.cm-content\)\s*\{/);
  });

  it('uses the original quote geometry while rounding code block outer edges', () => {
    const css = readPreviewStyles();

    expect(css).toMatch(/:global\(\.cm-blockquote-line\)\s*\{[^}]*border-left:\s*3px solid var\(--accent\)[^}]*padding-left:\s*1em[^}]*background:\s*var\(--overlay-subtle\)/);
    expect(css).not.toMatch(/:global\(\.cm-blockquote-line\)::before/);
    expect(css).not.toMatch(/:global\(\.cm-blockquote-line-(?:first|last)\)::before/);
    expect(css).toMatch(/:global\(\.cm-blockquote-line-first\)\s*\{[^}]*border-radius:\s*2px 2px 0 0/);
    expect(css).toMatch(/:global\(\.cm-blockquote-line-last\)\s*\{[^}]*border-radius:\s*0 0 2px 2px/);
    expect(css).toMatch(/:global\(\.cm-codeblock-line-first\)\s*\{[^}]*border-radius:\s*2px 2px 0 0/);
    expect(css).toMatch(/:global\(\.cm-codeblock-line-last\)\s*\{[^}]*border-radius:\s*0 0 2px 2px/);
    expect(css).toMatch(/:global\(\.cm-codeblock-line-first\)\s*\{[^}]*min-height:\s*24px[^}]*line-height:\s*24px[^}]*cursor:\s*default/);
    expect(css).toMatch(/:global\(\.cm-codeblock-line-last\)\s*\{[^}]*min-height:\s*var\(--space-4\)[^}]*line-height:\s*var\(--space-4\)[^}]*cursor:\s*default/);
  });

  it('sizes the block drop indicator from the markdown document column', () => {
    const css = readPreviewStyles();

    expect(css).toMatch(/:global\(\.preview-editor\.mode-markdown \.cm-markdown-block-drop-indicator\)\s*\{[^}]*position:\s*relative[^}]*width:\s*100%[^}]*max-width:\s*var\(--editor-markdown-content-width\)[^}]*height:\s*0[^}]*margin:\s*0 auto/);
    expect(css).toMatch(/:global\(\.preview-editor\.mode-markdown \.cm-markdown-block-drop-indicator\)::after\s*\{[^}]*left:\s*var\(--space-8\)[^}]*right:\s*var\(--space-8\)[^}]*height:\s*2px/);
  });

  it('keeps the Markdown block Grabber two pixels clear of the content', () => {
    const css = readPreviewStyles();

    expect(css).toMatch(/:global\(\.preview-editor\.mode-markdown \.cm-markdown-block-handle\)\s*\{[^}]*left:\s*-2px/);
  });

  it('shows only the focused caret block Grabber on coarse touch surfaces', () => {
    const css = readPreviewStyles();

    expect(css).toContain('@media (hover: none) and (pointer: coarse)');
    expect(css).toMatch(/\.cm-markdown-block-rail-item\)\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.cm-editor\.cm-focused \.cm-markdown-block-rail-item\.is-caret-block\)\s*\{[^}]*pointer-events:\s*auto/);
    expect(css).toMatch(/\.cm-markdown-block-handle\)\s*\{[^}]*opacity:\s*0[^}]*visibility:\s*hidden/);
    expect(css).toMatch(/\.cm-markdown-block-rail-item\.is-caret-block \.cm-markdown-block-handle\)\s*\{[^}]*opacity:\s*0\.55[^}]*visibility:\s*visible/);
  });
});
