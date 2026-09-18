// @vitest-environment jsdom
//
// 根因回归测试：流式追加新 token 时，已完成段落的 DOM 节点身份必须保持
// 稳定，用户在其中建立的原生文字选区不能被打断。
//
// 根因（修复前）：StreamBufferManager 每次 flush 都对累积全文重新跑
// renderMarkdown，产出全新 HTML 字符串写回同一个 `text` block
// (desktop/src/react/hooks/use-stream-buffer.ts:289-298)；MarkdownContent
// 用 dangerouslySetInnerHTML 整体重写 innerHTML
// (desktop/src/react/components/chat/MarkdownContent.tsx)，即使可见文字
// 没有变化，已完成段落的 DOM 节点也会被连根拔起重建，选区的 Range 端点
// 指向的旧文本节点被移出文档树，浏览器按 DOM 规范的边界点变更算法把
// Range 坍缩为空，导致用户复制不到内容。
//
// 修复：MarkdownContent 首次挂载用 dangerouslySetInnerHTML 整体写入，
// 此后每次更新改用 reconcileTopLevelChildren 做顶层子节点级 diff——
// 逐个顶层块比较新旧 HTML，未变的块保留原 DOM 节点不动，只替换真正
// 变化的块（通常只有正在流的最后一两个块）。

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingMarkdownContent } from '../../components/chat/StreamingMarkdownContent';

vi.mock('../../utils/mermaid-renderer', () => ({
  renderMermaidDiagrams: vi.fn(async () => undefined),
}));

describe('streaming selection preservation', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    cleanup();
    window.getSelection()?.removeAllRanges();
  });

  it('keeps the DOM node identity of an already-completed paragraph stable when a later flush appends new text', () => {
    const firstFlushSource = '第一段已经说完了。';
    const firstFlushHtml = '<p>第一段已经说完了。</p>';

    const { container, rerender } = render(
      <StreamingMarkdownContent source={firstFlushSource} html={firstFlushHtml} active />,
    );

    const firstParagraphBefore = container.querySelector('p');
    expect(firstParagraphBefore).not.toBeNull();
    const firstTextNodeBefore = firstParagraphBefore!.firstChild;
    expect(firstTextNodeBefore).not.toBeNull();

    // 第二批 flush：累积全文重新 renderMarkdown，第一段字面内容不变，
    // 但作为完整字符串的一部分被重新解析——顶层 HTML 片段本身与上一次
    // 完全相同，reconcile 应该识别出来并保留原节点。
    const secondFlushSource = `${firstFlushSource}\n\n第二段正在流式追加。`;
    const secondFlushHtml = '<p>第一段已经说完了。</p>\n<p>第二段正在流式追加。</p>';

    rerender(
      <StreamingMarkdownContent source={secondFlushSource} html={secondFlushHtml} active />,
    );

    const firstParagraphAfter = container.querySelectorAll('p')[0];
    const firstTextNodeAfter = firstParagraphAfter.firstChild;

    // 第一段的 <p> 和文本节点必须是原地保留的同一个 DOM 对象。
    expect(firstParagraphAfter).toBe(firstParagraphBefore);
    expect(firstTextNodeAfter).toBe(firstTextNodeBefore);

    // 第二段作为新内容被追加。
    expect(container.querySelectorAll('p')[1].textContent).toBe('第二段正在流式追加。');
  });

  it('keeps a live window Selection anchored inside an already-completed paragraph alive across the next flush', () => {
    const firstFlushSource = '这是可以被选中的第一段文字。';
    const firstFlushHtml = '<p>这是可以被选中的第一段文字。</p>';

    const { container, rerender } = render(
      <StreamingMarkdownContent source={firstFlushSource} html={firstFlushHtml} active />,
    );

    const paragraph = container.querySelector('p')!;
    const textNode = paragraph.firstChild!;

    // 用户在流式过程中选中了第一段的一部分文字。
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(selection.toString()).toBe('这是可以');

    // 下一批 flush 到达：累积全文被重新渲染，但第一段的顶层 HTML 片段
    // 没有变化。
    const secondFlushSource = `${firstFlushSource}\n\n后续内容持续追加中。`;
    const secondFlushHtml = '<p>这是可以被选中的第一段文字。</p>\n<p>后续内容持续追加中。</p>';

    rerender(
      <StreamingMarkdownContent source={secondFlushSource} html={secondFlushHtml} active />,
    );

    // 选区必须存活：第一段没有被连根拔起重建，Range 端点指向的文本节点
    // 仍在文档树中，用户仍然可以继续选中/复制。
    expect(selection.toString()).toBe('这是可以');
    expect(range.collapsed).toBe(false);
    expect(range.startContainer.isConnected).toBe(true);
  });

  it('still replaces only the block whose content actually changed (the streaming tail), not the whole tree', () => {
    const firstFlushSource = '稳定不变的开头段落。';
    const firstFlushHtml = '<p>稳定不变的开头段落。</p><p>尾部正在流式追</p>';

    const { container, rerender } = render(
      <StreamingMarkdownContent source={firstFlushSource} html={firstFlushHtml} active />,
    );

    const paragraphs = container.querySelectorAll('p');
    const stableParagraph = paragraphs[0];
    const changingParagraphBefore = paragraphs[1];

    const secondFlushSource = `${firstFlushSource.slice(0, -6)}\n\n尾部正在流式追加中。`;
    const secondFlushHtml = '<p>稳定不变的开头段落。</p><p>尾部正在流式追加中。</p>';

    rerender(
      <StreamingMarkdownContent source={secondFlushSource} html={secondFlushHtml} active />,
    );

    const paragraphsAfter = container.querySelectorAll('p');
    // 未变化的开头段落原地保留。
    expect(paragraphsAfter[0]).toBe(stableParagraph);
    // 内容变化的尾部段落被替换为新节点，且文字已更新。
    expect(paragraphsAfter[1]).not.toBe(changingParagraphBefore);
    expect(paragraphsAfter[1].textContent).toBe('尾部正在流式追加中。');
  });
});
