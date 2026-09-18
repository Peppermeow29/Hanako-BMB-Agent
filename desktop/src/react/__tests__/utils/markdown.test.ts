/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderMarkdownPreview } from '../../utils/markdown';

describe('renderMarkdown', () => {
  it('renders inline and block KaTeX math', () => {
    const html = renderMarkdown('inline $x+1$\n\n$$\ny^2\n$$');

    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
  });

  it('renders LaTeX parenthesis and bracket math delimiters', () => {
    const html = renderMarkdown('inline \\(x+1\\)\n\n\\[\ny^2\n\\]');

    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
    expect(html).not.toContain('\\(x+1\\)');
    expect(html).not.toContain('\\[');
  });

  it('renders invalid KaTeX as inline error markup instead of throwing', () => {
    expect(() => renderMarkdown(String.raw`bad math $\notACommand{$ after`)).not.toThrow();
    const html = renderMarkdown(String.raw`bad math $\notACommand{$ after`);

    expect(html).toContain('katex-error');
    expect(html).toContain('after');
  });

  it('renders Obsidian ==highlight== syntax as mark', () => {
    const html = renderMarkdown('GDP ==平减指数==');

    expect(html).toContain('<mark>平减指数</mark>');
  });

  it('renders whitelisted Obsidian background span as a safe mark', () => {
    const html = renderMarkdown('<span style="background:#fff88f">GDP平减指数</span>');

    expect(html).toContain('<mark style="background-color:#fff88f">GDP平减指数</mark>');
  });

  it('keeps non-whitelisted span markup escaped', () => {
    const html = renderMarkdown('<span onclick="alert(1)">bad</span>');

    expect(html).toContain('&lt;span onclick=');
    expect(html).toContain('bad&lt;/span&gt;');
    expect(html).not.toContain('<span onclick=');
  });

  it('keeps default markdown rendering from rendering raw HTML', () => {
    const html = renderMarkdown('<div style="color:red">card</div>');

    expect(html).toContain('&lt;div');
    expect(html).not.toContain('<div style=');
  });

  it('marks mermaid fenced code blocks as renderable diagram placeholders', () => {
    const html = renderMarkdown([
      '```mermaid',
      'graph TD',
      '  A-->B',
      '```',
    ].join('\n'));

    expect(html).toContain('class="mermaid-diagram"');
    expect(html).toContain('class="mermaid-source"');
    expect(html).toContain('class="mermaid-rendered"');
    expect(html).toContain('graph TD');
    expect(html).not.toContain('<code class="language-mermaid"');
  });

  it('renders markdown footnotes with clickable refs and backrefs', () => {
    const html = renderMarkdown([
      '正文引用[^main]。',
      '',
      '[^main]: 脚注 **正文**。',
    ].join('\n'));

    const refMatch = html.match(
      /<sup class="footnote-ref"><a href="#(?<footnoteId>fn-hana-fn-[a-z0-9]+-1)" id="(?<refId>fnref-hana-fn-[a-z0-9]+-1)" role="doc-noteref">1<\/a><\/sup>/,
    );

    expect(refMatch?.groups?.footnoteId).toBeTruthy();
    expect(refMatch?.groups?.refId).toBeTruthy();
    expect(html).toContain(`<li id="${refMatch?.groups?.footnoteId}">`);
    expect(html).toContain('脚注 <strong>正文</strong>。');
    expect(html).toContain(
      `<a href="#${refMatch?.groups?.refId}" class="footnote-backref" role="doc-backlink" title="Jump back to reference">&#8617;</a>`,
    );
    expect(html).not.toContain('[^main]:');
  });

  it('uses stable but source-scoped footnote ids', () => {
    const first = renderMarkdown('引用[^1]\n\n[^1]: 第一条');
    const firstAgain = renderMarkdown('引用[^1]\n\n[^1]: 第一条');
    const second = renderMarkdown('引用[^1]\n\n[^1]: 第二条');

    const firstId = first.match(/id="(?<id>fn-hana-fn-[a-z0-9]+-1)"/)?.groups?.id;
    const firstAgainId = firstAgain.match(/id="(?<id>fn-hana-fn-[a-z0-9]+-1)"/)?.groups?.id;
    const secondId = second.match(/id="(?<id>fn-hana-fn-[a-z0-9]+-1)"/)?.groups?.id;

    expect(firstId).toBeTruthy();
    expect(firstAgainId).toBe(firstId);
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
  });

  it('trims CJK punctuation from auto-linkified URLs', () => {
    const html = renderMarkdown('看 https://example.com/path。再看 https://example.com/next，');

    expect(html).toContain('<a href="https://example.com/path">https://example.com/path</a>。');
    expect(html).toContain('<a href="https://example.com/next">https://example.com/next</a>，');
    expect(html).not.toContain('%E3%80%82');
    expect(html).not.toContain('%EF%BC%8C');
  });

  it('trims invisible suffix characters from auto-linkified URLs', () => {
    const html = renderMarkdown('看 https://example.com/path\u200b');

    expect(html).toContain('<a href="https://example.com/path">https://example.com/path</a>\u200b');
    expect(html).not.toContain('%E2%80%8B');
  });

  it('keeps punctuation inside explicit markdown link destinations', () => {
    const html = renderMarkdown('[链接](https://example.com/path。)');

    expect(html).toContain('<a href="https://example.com/path%E3%80%82">链接</a>');
  });

  it('keeps local file names from becoming auto-linkified domains', () => {
    const html = renderMarkdown('参考 README.md、笔记.md、package.json、./docs/ARCHITECTURE.md 和 C:\\work\\config.ts');
    const previewHtml = renderMarkdownPreview('参考 README.md、笔记.md、package.json、./docs/ARCHITECTURE.md');

    expect(html).toContain('README.md');
    expect(html).toContain('笔记.md');
    expect(html).toContain('package.json');
    expect(html).toContain('./docs/ARCHITECTURE.md');
    expect(html).toContain('C:\\work\\config.ts');
    expect(html).not.toContain('<a ');
    expect(previewHtml).not.toContain('<a ');
  });

  it('keeps normal fuzzy links and explicit markdown file labels clickable', () => {
    const html = renderMarkdown('访问 openai.com、www.example.com 和 [README.md](https://example.com/readme)');

    expect(html).toContain('<a href="http://openai.com">openai.com</a>');
    expect(html).toContain('<a href="http://www.example.com">www.example.com</a>');
    expect(html).toContain('<a href="https://example.com/readme">README.md</a>');
  });

  it('renders filtered HTML in markdown preview mode', () => {
    const html = renderMarkdownPreview([
      '<div style="background: #f0f7ff; border: 1px solid #bee1e6; border-radius: 8px; padding: 16px; margin: 12px 0;">',
      '<center>总结</center>',
      '',
      '### 会计基础 知识框架',
      '',
      '会计基础',
      '└─ 借贷记账法',
      '</div>',
    ].join('\n'));

    expect(html).toContain('<div style="background: #f0f7ff; border: 1px solid #bee1e6; border-radius: 8px; padding: 16px; margin: 12px 0">');
    expect(html).toContain('<center>总结</center>');
    expect(html).toContain('<h3 id="会计基础-知识框架">会计基础 知识框架</h3>');
    expect(html).toContain('└─ 借贷记账法');
  });

  it('adds stable heading ids in markdown preview mode', () => {
    const html = renderMarkdownPreview([
      '# 概览',
      '',
      '## Same Title',
      '',
      '## Same Title',
    ].join('\n'));

    expect(html).toContain('<h1 id="概览">概览</h1>');
    expect(html).toContain('<h2 id="same-title">Same Title</h2>');
    expect(html).toContain('<h2 id="same-title-1">Same Title</h2>');
  });

  it('wraps markdown tables in a constrained width container', () => {
    const html = renderMarkdown([
      '| 时间 | 处理方式 |',
      '| --- | --- |',
      '| 6~10s 连续叙事 | 合并成一个大分镜，内部分镜头一、镜头二 |',
    ].join('\n'));

    expect(html).toContain('<div class="markdown-table-scroll">');
    expect(html).toContain('<table>');
    expect(html).toContain('</table>\n</div>');
  });

  it('preserves markdown table containers in preview mode', () => {
    const html = renderMarkdownPreview([
      '| 时间 | 处理方式 |',
      '| --- | --- |',
      '| 6~10s 连续叙事 | 合并成一个大分镜，内部分镜头一、镜头二 |',
    ].join('\n'));

    expect(html).toContain('<div class="markdown-table-scroll">');
    expect(html).toContain('</table>\n</div>');
  });

  it('removes dangerous HTML from markdown preview output', () => {
    const html = renderMarkdownPreview([
      '<script>alert(1)</script>',
      '<div onclick="alert(1)" onload="alert(2)">safe text</div>',
      '<img src=x onerror="alert(3)">',
    ].join('\n'));

    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onload');
    expect(html).not.toContain('<img');
    expect(html).toContain('<div>safe text</div>');
  });

  it('resolves standard markdown image paths relative to the previewed markdown file', () => {
    const seenPaths: string[] = [];
    const html = renderMarkdownPreview(
      '![Cover](./assets/Cover%20Image.png)',
      {
        filePath: '/vault/notes/chapter.md',
        getFileUrl: (filePath) => {
          seenPaths.push(filePath);
          return `file://${filePath.replaceAll(' ', '%20')}`;
        },
      },
    );

    expect(seenPaths).toEqual(['/vault/notes/assets/Cover Image.png']);
    expect(html).toContain('<img src="file:///vault/notes/assets/Cover%20Image.png" alt="Cover"');
  });

  it('resolves markdown image paths from Windows-style previewed markdown paths', () => {
    const seenPaths: string[] = [];
    renderMarkdownPreview(
      '![Diagram](../images/diagram.png)',
      {
        filePath: 'C:\\vault\\notes\\chapter.md',
        getFileUrl: (filePath) => {
          seenPaths.push(filePath);
          return `file:///${filePath}`;
        },
      },
    );

    expect(seenPaths).toEqual(['C:/vault/images/diagram.png']);
  });

  it('renders Obsidian wikilink image embeds with width and height', () => {
    const html = renderMarkdownPreview(
      '![[attachments/diagram.png|320x180]]',
      {
        filePath: '/vault/notes/chapter.md',
        getFileUrl: (filePath) => `file://${filePath}`,
      },
    );

    expect(html).toContain('<img src="file:///vault/notes/attachments/diagram.png"');
    expect(html).toContain('alt="diagram.png"');
    expect(html).toContain('width="320"');
    expect(html).toContain('height="180"');
  });

  it('renders Obsidian external image width shorthand without leaking the size into alt text', () => {
    const html = renderMarkdownPreview('![250](https://example.com/image.jpg)');

    expect(html).toContain('<img src="https://example.com/image.jpg" alt="" width="250"');
    expect(html).not.toContain('alt="250"');
  });

  it('filters unsafe markdown preview links while preserving safe links', () => {
    const html = renderMarkdownPreview([
      '<a href="javascript:alert(1)">bad</a>',
      '<a href="https://example.com/path">good</a>',
    ].join('\n'));

    expect(html).toContain('<a>bad</a>');
    expect(html).toContain('<a href="https://example.com/path" rel="noopener noreferrer">good</a>');
    expect(html).not.toContain('javascript:');
  });

  it('filters unsafe preview styles while preserving safe presentation styles', () => {
    const html = renderMarkdownPreview('<div style="background: url(javascript:alert(1)); color: #333; position: fixed; padding: 8px; display: flex;">x</div>');

    expect(html).toContain('<div style="color: #333; padding: 8px; display: flex">x</div>');
    expect(html).not.toContain('url(');
    expect(html).not.toContain('position');
    expect(html).not.toContain('fixed');
  });

  it('preserves generated mermaid placeholder classes in markdown preview mode', () => {
    const html = renderMarkdownPreview([
      '```mermaid',
      'sequenceDiagram',
      '  A->>B: hello',
      '```',
    ].join('\n'));

    expect(html).toContain('class="mermaid-diagram"');
    expect(html).toContain('class="mermaid-source"');
    expect(html).toContain('class="mermaid-rendered"');
    expect(html).toContain('sequenceDiagram');
  });

  it('preserves safe generated footnote markup in markdown preview mode', () => {
    const html = renderMarkdownPreview([
      '正文引用[^safe]。',
      '',
      '[^safe]: 预览脚注。',
    ].join('\n'));

    expect(html).toMatch(/<section class="footnotes" role="doc-endnotes">/);
    expect(html).toMatch(/<sup class="footnote-ref"><a href="#fn-hana-fn-[a-z0-9]+-1" id="fnref-hana-fn-[a-z0-9]+-1" role="doc-noteref" rel="noopener noreferrer">1<\/a><\/sup>/);
    expect(html).toMatch(/<li id="fn-hana-fn-[a-z0-9]+-1">/);
    expect(html).toMatch(/<a href="#fnref-hana-fn-[a-z0-9]+-1" class="footnote-backref" role="doc-backlink" title="Jump back to reference" rel="noopener noreferrer">(?:↩|&#8617;)<\/a>/);
  });

  it('strips unsafe raw footnote ids classes and roles in markdown preview mode', () => {
    const html = renderMarkdownPreview([
      '<section class="footnotes evil" role="banner">',
      '<ol>',
      '<li id="evil" onclick="alert(1)">',
      '<a id="fnref-hana-fn-safe-1" class="footnote-backref evil" href="javascript:alert(2)" role="button">back</a>',
      '</li>',
      '</ol>',
      '</section>',
    ].join(''));

    expect(html).toContain('<section class="footnotes">');
    expect(html).toContain('<a id="fnref-hana-fn-safe-1" class="footnote-backref">back</a>');
    expect(html).not.toContain('evil');
    expect(html).not.toContain('role="banner"');
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('id="evil"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('onclick');
  });

  it('does not preserve raw non-footnote section tags in markdown preview mode', () => {
    const html = renderMarkdownPreview('<section id="plain"><p>正文</p></section>');

    expect(html).toBe('<p>正文</p>');
  });

  it('preserves generated KaTeX markup in markdown preview mode', () => {
    const html = renderMarkdownPreview('inline $x+1$\n\n$$\ny^2\n$$');

    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
    expect(html).toContain('<math');
    expect(html).toContain('<annotation encoding="application/x-tex">');
  });

  it('preserves complex generated KaTeX markup in markdown preview mode', () => {
    const html = renderMarkdownPreview(String.raw`$$\sqrt{\frac{a}{b}}+\overrightarrow{AB}$$`);

    expect(html).toMatch(/class="[^"]*\bsqrt\b[^"]*"/);
    expect(html).toMatch(/class="[^"]*\bmfrac\b[^"]*"/);
    expect(html).toContain('<svg');
    expect(html).toContain('<path');
    expect(html).toContain('aria-hidden="true"');
  });

  it('does not trust raw HTML just because it uses KaTeX classes', () => {
    const html = renderMarkdownPreview([
      '<span class="katex" display="block" onclick="alert(1)">',
      '<script>alert(2)</script>',
      '<span class="mord" onmouseover="alert(3)">x</span>',
      '</span>',
    ].join(''));

    expect(html).not.toContain('display=');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onmouseover');
    expect(html).not.toContain('<script');
    expect(html).toContain('<span class="katex"><span class="mord">x</span></span>');
  });

  it('preserves task list checkboxes in markdown preview mode', () => {
    const html = renderMarkdownPreview('- [ ] 未完成\n- [x] 已完成');

    expect(html).toContain('class="task-list-item"');
    expect(html).toContain('class="contains-task-list"');
    expect(html).toContain('<input type="checkbox" disabled="">');
    expect(html).toContain('<input type="checkbox" disabled="" checked="">');
  });

  it('strips non-checkbox inputs even in task list context', () => {
    const html = renderMarkdownPreview('<input type="text" value="xss"><input type="checkbox">');

    expect(html).not.toContain('type="text"');
    expect(html).toContain('<input type="checkbox" disabled="">');
  });

  it('forces disabled on checkbox inputs and strips unsafe attributes', () => {
    const html = renderMarkdownPreview('<input type="checkbox" onclick="alert(1)" data-evil="x" checked>');

    expect(html).not.toContain('onclick');
    expect(html).not.toContain('data-evil');
    expect(html).toContain('disabled=""');
    expect(html).toContain('checked=""');
  });

  it('does not allow raw SVG outside generated KaTeX markup', () => {
    const html = renderMarkdownPreview('<svg onload="alert(1)"><path d="M0 0"></path></svg><span>ok</span>');

    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<path');
    expect(html).not.toContain('onload');
    expect(html).toContain('<span>ok</span>');
  });

  it('renders Obsidian callouts from blockquote syntax', () => {
    const html = renderMarkdown([
      '> [!warning] 小心一点',
      '> 第一段 **内容**。',
    ].join('\n'));

    expect(html).toContain('class="markdown-callout markdown-callout-warning"');
    expect(html).toContain('<div class="markdown-callout-title">小心一点</div>');
    expect(html).toContain('<strong>内容</strong>');
    expect(html).not.toContain('[!warning]');
    expect(html).not.toContain('<blockquote>');
  });

  it('normalizes Obsidian callout aliases and supports fold markers', () => {
    const html = renderMarkdown([
      '> [!faq]- 能折叠吗',
      '> 可以。',
    ].join('\n'));

    expect(html).toContain('<details class="markdown-callout markdown-callout-question">');
    expect(html).toContain('<summary class="markdown-callout-title">能折叠吗</summary>');
    expect(html).toContain('<p>可以。</p>');
  });

  it('preserves callout classes in markdown preview mode', () => {
    const html = renderMarkdownPreview([
      '> [!tip]',
      '> preview callout',
    ].join('\n'));

    expect(html).toContain('class="markdown-callout markdown-callout-tip"');
    expect(html).toContain('<div class="markdown-callout-title">Tip</div>');
    expect(html).toContain('preview callout');
    expect(html).not.toContain('[!tip]');
  });
});
