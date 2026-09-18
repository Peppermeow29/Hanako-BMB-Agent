import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('screenshot markdown renderer helpers', () => {
  it('resolves relative markdown image paths from the source markdown file', () => {
    const { resolveScreenshotMarkdownImageSrc } = require('../desktop/src/shared/screenshot-markdown.cjs');

    expect(resolveScreenshotMarkdownImageSrc('文本附件/Cover Image.png', {
      sourceFilePath: '/vault/notes/day.md',
    })).toBe('file:///vault/notes/%E6%96%87%E6%9C%AC%E9%99%84%E4%BB%B6/Cover%20Image.png');
  });

  it('renders code articles as escaped preformatted code instead of markdown paragraphs', () => {
    const { renderScreenshotCodeArticle } = require('../desktop/src/shared/screenshot-markdown.cjs');

    expect(renderScreenshotCodeArticle('<div>x</div>', 'html')).toBe(
      '<pre><code class="language-html">&lt;div&gt;x&lt;/div&gt;</code></pre>',
    );
  });

  it('drops unsupported explicit image protocols in screenshot markdown', () => {
    const { resolveScreenshotMarkdownImageSrc } = require('../desktop/src/shared/screenshot-markdown.cjs');

    expect(resolveScreenshotMarkdownImageSrc('javascript:alert(1)', {
      sourceFilePath: '/vault/notes/day.md',
    })).toBe('');
  });

  it('renders markdown cover before article body for screenshots', () => {
    const { renderScreenshotMarkdownArticle } = require('../desktop/src/shared/screenshot-markdown.cjs');
    const md = { render: vi.fn(() => '<h1>Demo</h1>') };
    const html = renderScreenshotMarkdownArticle(md, [
      '---',
      'cover:',
      '  image: 文本附件/cover.png',
      '  displayWidth: 72',
      '  displayHeight: 280',
      '  positionY: 64',
      '---',
      '# Demo',
    ].join('\n'), { sourceFilePath: '/vault/notes/day.md' });

    expect(md.render).toHaveBeenCalledWith('# Demo', { sourceFilePath: '/vault/notes/day.md' });
    expect(html.startsWith('<figure class="screenshot-cover screenshot-cover-bleed-x screenshot-cover-top"')).toBe(true);
    expect(html).toContain('class="screenshot-cover screenshot-cover-bleed-x screenshot-cover-top"');
    expect(html).not.toContain('--screenshot-cover-display-width');
    expect(html).toContain('--screenshot-cover-height:280px');
    expect(html).toContain('class="screenshot-cover-frame"');
    expect(html).toContain('object-position:50% 64%');
    expect(html).toContain('file:///vault/notes/%E6%96%87%E6%9C%AC%E9%99%84%E4%BB%B6/cover.png');
  });

  it('wraps markdown tables for screenshot rendering', () => {
    const MarkdownIt = require('markdown-it');
    const { decorateScreenshotMarkdownIt } = require('../desktop/src/shared/screenshot-markdown.cjs');
    const md = new MarkdownIt();
    decorateScreenshotMarkdownIt(md);

    const html = md.render([
      '| 时间 | 处理方式 |',
      '| --- | --- |',
      '| 6~10s 连续叙事 | 合并成一个大分镜，内部分镜头一、镜头二 |',
    ].join('\n'));

    expect(html).toContain('<div class="markdown-table-scroll">');
    expect(html).toContain('<table>');
    expect(html).toContain('</table>\n</div>');
  });

  it('keeps screenshot cover bleed as an explicit layout contract', () => {
    const mainSource = fs.readFileSync(path.resolve(__dirname, '../desktop/main.cjs'), 'utf-8');

    expect(mainSource).toContain('.screenshot-cover.screenshot-cover-bleed-x');
    expect(mainSource).toContain('.screenshot-cover.screenshot-cover-top');
  });

  it('bleeds screenshot covers to the screenshot canvas edges, not theme padding edges', () => {
    const mainSource = fs.readFileSync(path.resolve(__dirname, '../desktop/main.cjs'), 'utf-8');

    expect(mainSource).not.toContain('const coverBleedX');
    expect(mainSource).not.toContain('--screenshot-cover-bleed-x');
    expect(mainSource).toContain('width: 100vw;');
    expect(mainSource).toContain('margin-left: calc((100% - 100vw) / 2);');
    expect(mainSource).toContain('margin-right: calc((100% - 100vw) / 2);');
  });
});
