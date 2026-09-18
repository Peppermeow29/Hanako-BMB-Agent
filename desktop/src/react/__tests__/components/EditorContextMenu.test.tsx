/**
 * @vitest-environment jsdom
 */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorContextMenu } from '../../components/preview/EditorContextMenu';
import { collectMarkdownBlocks } from '../../editor/markdown-blocks';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function renderBlockMenu(doc: string, options: {
  allBlocks?: boolean;
  onQuoteRange?: (view: EditorView, range: { from: number; to: number }) => void;
} = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = new EditorView({
    parent: container,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage })],
    }),
  });
  const blocks = collectMarkdownBlocks(view.state);
  const targetBlocks = options.allBlocks ? blocks : blocks.slice(0, 1);
  const first = targetBlocks[0];
  const last = targetBlocks[targetBlocks.length - 1];
  const target = {
    ...first,
    to: last.to,
    type: targetBlocks.length === 1 ? first.type : 'BlockRange',
    endLine: last.endLine,
    source: view.state.sliceDoc(first.from, last.to),
    blocks: targetBlocks,
  };
  const onBlockMenuClose = vi.fn();

  render(
    <EditorContextMenu
      getView={() => view}
      containerRef={{ current: container }}
      mode="markdown"
      blockMenuRequest={{ id: 1, position: { x: 20, y: 20 }, target }}
      onBlockMenuClose={onBlockMenuClose}
      onQuoteRange={options.onQuoteRange}
    />,
  );
  return { container, view, onBlockMenuClose };
}

describe('EditorContextMenu block target', () => {
  it('reuses the complete format menu for block targets', async () => {
    const { view, onBlockMenuClose } = renderBlockMenu('Paragraph');

    expect(await screen.findByTitle('标题 1')).toBeTruthy();
    fireEvent.click(screen.getByTitle('粗体'));

    expect(view.state.doc.toString()).toBe('**Paragraph**');
    expect(onBlockMenuClose).toHaveBeenCalled();
    view.destroy();
  });

  it('applies multi-line block commands to the complete parser block', async () => {
    const { view } = renderBlockMenu('line one\nline two');

    fireEvent.click(await screen.findByTitle('引用'));

    expect(view.state.doc.toString()).toBe('> line one\n> line two');
    view.destroy();
  });

  it('quotes the complete highlighted block range from the first menu item', async () => {
    const onQuoteRange = vi.fn();
    const doc = 'Alpha\n\nBeta';
    const { view } = renderBlockMenu(doc, { allBlocks: true, onQuoteRange });

    fireEvent.click(await screen.findByText('引用到对话'));

    expect(onQuoteRange).toHaveBeenCalledWith(view, { from: 0, to: doc.length });
    view.destroy();
  });

  it('copies the exact raw Markdown source for a highlighted block range', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const doc = [
      '# Heading',
      '',
      '> quoted text',
      '',
      '```ts',
      'const value = 1;',
      '```',
    ].join('\n');
    const { view } = renderBlockMenu(doc, { allBlocks: true });

    fireEvent.click(await screen.findByText('复制'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(doc));
    view.destroy();
  });

  it('leaves a Grabber click to the trigger instead of pre-closing its open block menu', () => {
    vi.useFakeTimers();
    const { container, view, onBlockMenuClose } = renderBlockMenu('Paragraph');
    const handle = document.createElement('button');
    handle.className = 'cm-markdown-block-handle';
    container.appendChild(handle);
    act(() => vi.runOnlyPendingTimers());

    fireEvent.click(handle);

    expect(onBlockMenuClose).not.toHaveBeenCalled();
    view.destroy();
  });
});
