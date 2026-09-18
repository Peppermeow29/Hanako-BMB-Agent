// @vitest-environment jsdom

import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureChatSelection,
  captureSelection,
  clearSelection,
  initQuotedSelectionLifecycle,
  quotePreviewRangeToChat,
  scheduleCaptureSelection,
} from '../../stores/selection-actions';
import { useStore } from '../../stores';
import type { PreviewItem } from '../../types';

const previewItem: PreviewItem = {
  id: 'preview-1',
  title: 'note.md',
  type: 'markdown',
  content: '',
  filePath: '/notes/note.md',
};

describe('captureSelection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.getSelection()?.removeAllRanges();
    useStore.getState().clearQuoteCandidate();
    useStore.getState().clearQuotedSelections();
    useStore.setState({ selectedIdsBySession: {}, chatSessions: {} } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the trimmed quoted text range for lineEnd when selection includes a trailing newline', () => {
    const doc = 'alpha\nbeta\ngamma';
    const state = EditorState.create({
      doc,
      selection: { anchor: 6, head: 11 },
    });

    captureSelection(previewItem, { state } as EditorView);

    expect(useStore.getState().quoteCandidate).toMatchObject({
      text: 'beta',
      sourceTitle: 'note.md',
      sourceKind: 'preview',
      sourceFilePath: '/notes/note.md',
      lineStart: 2,
      lineEnd: 2,
      selectionAnchorKind: 'codemirror',
      charCount: 4,
    });
  });

  it('commits an explicit multi-block CodeMirror range directly to the composer', () => {
    const state = EditorState.create({ doc: 'Alpha\n\nBeta\n\nGamma' });
    const beforeFocusTrigger = useStore.getState().inputFocusTrigger;

    expect(quotePreviewRangeToChat(
      previewItem,
      { state } as EditorView,
      { from: 0, to: 11 },
    )).toBe(true);

    expect(useStore.getState().quotedSelections).toEqual([
      expect.objectContaining({
        text: 'Alpha\n\nBeta',
        sourceTitle: 'note.md',
        sourceKind: 'preview',
        sourceFilePath: '/notes/note.md',
        lineStart: 1,
        lineEnd: 3,
        selectionAnchorKind: 'codemirror',
      }),
    ]);
    expect(useStore.getState().quoteCandidate).toBeNull();
    expect(useStore.getState().inputFocusTrigger).toBe(beforeFocusTrigger + 1);
  });

  it('sets explicit message selection per session and removes empty session entries', () => {
    const state = useStore.getState();

    state.setMessageSelection('/session/a.jsonl', ['m2', 'm1', 'm2']);

    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toEqual(['m2', 'm1']);

    useStore.getState().setMessageSelection('/session/a.jsonl', []);

    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toBeUndefined();
  });

  it('captures selected assistant chat text as a quote candidate with explicit message ownership', () => {
    useStore.setState({
      chatSessions: {
        '/session/a.jsonl': {
          items: [
            {
              type: 'message',
              data: {
                id: 'assistant-1',
                role: 'assistant',
                blocks: [{ type: 'text', html: '<p>这段文字值得引用</p>', source: '这段文字值得引用' }],
              },
            },
          ],
          hasMore: false,
          loadingMore: false,
        },
      },
    } as never);
    document.body.innerHTML = `
      <article data-message-id="assistant-1">
        <p><span id="selected-text">这段文字值得引用</span></p>
      </article>
    `;
    selectElementText(document.getElementById('selected-text')!);

    captureChatSelection('/session/a.jsonl');

    expect(useStore.getState().quoteCandidate).toMatchObject({
      text: '这段文字值得引用',
      sourceKind: 'chat',
      sourceSessionPath: '/session/a.jsonl',
      sourceMessageId: 'assistant-1',
      sourceRole: 'assistant',
      selectionAnchorKind: 'native',
      charCount: 8,
    });
    expect(useStore.getState().quotedSelections).toEqual([]);
  });

  it('captures document-level chat quote immediately after mouseup commit', () => {
    const dispose = initQuotedSelectionLifecycle(document);
    try {
      seedChatFixture();
      document.body.innerHTML = `
        <section data-chat-selection-root="" data-session-path="/session/a.jsonl">
          <article data-message-id="assistant-1">
            <p><span id="selected-text">document mouseup quote</span></p>
          </article>
        </section>
        <aside id="outside-chat">outside</aside>
      `;
      selectElementText(document.getElementById('selected-text')!);

      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      expect(useStore.getState().quoteCandidate).toMatchObject({
        text: 'document mouseup quote',
        sourceKind: 'chat',
        sourceSessionPath: '/session/a.jsonl',
        sourceMessageId: 'assistant-1',
      });
    } finally {
      dispose();
    }
  });

  it('does not create a document-level chat candidate when mouseup commits an empty selection', () => {
    const dispose = initQuotedSelectionLifecycle(document);
    try {
      seedChatFixture();
      document.body.innerHTML = `
        <section data-chat-selection-root="" data-session-path="/session/a.jsonl">
          <article data-message-id="assistant-1">
            <p><span id="selected-text">document mouseup quote</span></p>
          </article>
        </section>
      `;
      window.getSelection()?.removeAllRanges();
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      expect(useStore.getState().quoteCandidate).toBeNull();
    } finally {
      dispose();
    }
  });

  it('does not create a chat candidate when the mouseup is a right-click (button 2)', () => {
    const dispose = initQuotedSelectionLifecycle(document);
    try {
      seedChatFixture();
      document.body.innerHTML = `
        <section data-chat-selection-root="" data-session-path="/session/a.jsonl">
          <article data-message-id="assistant-1">
            <p><span id="selected-text">right click should not quote</span></p>
          </article>
        </section>
      `;
      selectElementText(document.getElementById('selected-text')!);

      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 2 }));

      expect(useStore.getState().quoteCandidate).toBeNull();
    } finally {
      dispose();
    }
  });

  it('captures preview quote immediately when the preview selection is committed', () => {
    document.body.innerHTML = '<main><span id="selected-text">preview quote</span></main>';
    selectElementText(document.getElementById('selected-text')!);

    scheduleCaptureSelection(previewItem);

    expect(useStore.getState().quoteCandidate).toMatchObject({
      text: 'preview quote',
      sourceKind: 'preview',
      sourceFilePath: '/notes/note.md',
      selectionAnchorKind: 'native',
    });

    clearSelection({ sourceKind: 'preview', sourceFilePath: '/notes/note.md' });

    expect(useStore.getState().quoteCandidate).toBeNull();
  });

  it('keeps CodeMirror preview capture independent from an empty native selection', () => {
    const dispose = initQuotedSelectionLifecycle(document);
    try {
      useStore.getState().setQuoteCandidate({
        text: 'old native quote',
        sourceTitle: 'Assistant message',
        sourceKind: 'chat',
        sourceSessionPath: '/session/a.jsonl',
        sourceMessageId: 'assistant-1',
        sourceRole: 'assistant',
        charCount: 16,
      });
      const state = EditorState.create({
        doc: 'alpha\nbeta',
        selection: { anchor: 0, head: 5 },
      });

      scheduleCaptureSelection(previewItem, { state } as EditorView);
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));

      expect(useStore.getState().quoteCandidate).toMatchObject({
        text: 'alpha',
        sourceKind: 'preview',
        sourceFilePath: '/notes/note.md',
        selectionAnchorKind: 'codemirror',
      });
    } finally {
      dispose();
    }
  });

  it('falls back to the message element bounds when the native selection range has no usable rects', () => {
    seedChatFixture();
    document.body.innerHTML = `
      <section data-chat-selection-root="" data-session-path="/session/a.jsonl">
        <article id="message" data-message-id="assistant-1">
          <p><span id="selected-text">fallback bounds quote</span></p>
        </article>
      </section>
    `;
    const message = document.getElementById('message')!;
    Object.defineProperty(message, 'getBoundingClientRect', {
      value: () => domRect({ left: 24, right: 224, top: 80, bottom: 128, width: 200, height: 48 }),
    });
    const range = selectElementText(document.getElementById('selected-text')!);
    Object.defineProperty(range, 'getClientRects', {
      configurable: true,
      value: () => [] as unknown as DOMRectList,
    });
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => domRect({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      width: 0,
      height: 0,
      }),
    });

    captureChatSelection('/session/a.jsonl');

    expect(useStore.getState().quoteCandidate?.anchorRect).toEqual({
      left: 24,
      right: 224,
      top: 80,
      bottom: 128,
      width: 200,
      height: 48,
    });
  });

  it('anchors a forward multi-line chat quote to the focus edge instead of the whole selection bounds', () => {
    seedChatFixture();
    document.body.innerHTML = `
      <section data-chat-selection-root="" data-session-path="/session/a.jsonl">
        <article data-message-id="assistant-1">
          <p><span id="start-text">first selected line</span></p>
          <p><span id="end-text">second selected line</span></p>
        </article>
      </section>
    `;
    const range = selectAcrossElements(
      document.getElementById('start-text')!,
      document.getElementById('end-text')!,
    );
    Object.defineProperty(range, 'getClientRects', {
      configurable: true,
      value: () => [
        domRect({ left: 96, right: 420, top: 100, bottom: 128, width: 324, height: 28 }),
        domRect({ left: 96, right: 260, top: 140, bottom: 168, width: 164, height: 28 }),
      ] as unknown as DOMRectList,
    });
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => domRect({
        left: 96,
        right: 420,
        top: 100,
        bottom: 168,
        width: 324,
        height: 68,
      }),
    });

    captureChatSelection('/session/a.jsonl');

    expect(useStore.getState().quoteCandidate?.anchorRect).toEqual({
      left: 260,
      right: 261,
      top: 140,
      bottom: 141,
      width: 1,
      height: 1,
    });
  });

  it('uses the mouseup point when the browser cannot expose a selection endpoint rect', () => {
    const dispose = initQuotedSelectionLifecycle(document);
    try {
      seedChatFixture();
      document.body.innerHTML = `
        <section data-chat-selection-root="" data-session-path="/session/a.jsonl">
          <article data-message-id="assistant-1">
            <p><span id="selected-text">document mouseup quote</span></p>
          </article>
        </section>
      `;
      const range = selectElementText(document.getElementById('selected-text')!);
      Object.defineProperty(range, 'getClientRects', {
        configurable: true,
        value: () => [] as unknown as DOMRectList,
      });
      Object.defineProperty(range, 'getBoundingClientRect', {
        configurable: true,
        value: () => domRect({
          left: 96,
          right: 420,
          top: 100,
          bottom: 168,
          width: 324,
          height: 68,
        }),
      });

      window.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        clientX: 380,
        clientY: 220,
      }));

      expect(useStore.getState().quoteCandidate?.anchorRect).toEqual({
        left: 380,
        right: 381,
        top: 220,
        bottom: 221,
        width: 1,
        height: 1,
      });
    } finally {
      dispose();
    }
  });

  it('keeps added quotes when composer focus cancels the native selection candidate', () => {
    const dispose = initQuotedSelectionLifecycle(document);
    try {
      useStore.getState().addQuotedSelection({
        text: 'old quote',
        sourceTitle: 'Assistant message',
        sourceKind: 'chat',
        sourceSessionPath: '/session/a.jsonl',
        sourceMessageId: 'assistant-1',
        sourceRole: 'assistant',
        charCount: 9,
      });
      document.body.innerHTML = '<textarea id="composer"></textarea>';
      document.getElementById('composer')?.focus();

      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));

      expect(useStore.getState().quotedSelections[0]).toMatchObject({
        text: 'old quote',
        sourceKind: 'chat',
      });
    } finally {
      dispose();
    }
  });

  it('clears an existing chat candidate when the collapsed native selection remains in the same chat session', () => {
    const dispose = initQuotedSelectionLifecycle(document);
    try {
      useStore.setState({
        chatSessions: {
          '/session/a.jsonl': {
            items: [
              {
                type: 'message',
                data: {
                  id: 'assistant-1',
                  role: 'assistant',
                  blocks: [{ type: 'text', html: '<p>inside chat</p>', source: 'inside chat' }],
                },
              },
            ],
            hasMore: false,
            loadingMore: false,
          },
        },
      } as never);
      document.body.innerHTML = `
        <section data-chat-selection-root="" data-session-path="/session/a.jsonl">
          <article data-message-id="assistant-1">
            <span id="selected-text">inside chat</span>
            <span id="caret-host">cancel here</span>
          </article>
        </section>
      `;
      selectElementText(document.getElementById('selected-text')!);
      captureChatSelection('/session/a.jsonl');
      expect(useStore.getState().quoteCandidate).toMatchObject({ text: 'inside chat' });

      placeCollapsedSelection(document.getElementById('caret-host')!);

      document.dispatchEvent(new Event('selectionchange'));

      expect(useStore.getState().quoteCandidate).toBeNull();
    } finally {
      dispose();
    }
  });

  it('clears a transient chat candidate when pointer focus leaves the chat selection surface', () => {
    const dispose = initQuotedSelectionLifecycle(document);
    try {
      seedChatFixture();
      document.body.innerHTML = `
        <section data-chat-selection-root="" data-session-path="/session/a.jsonl">
          <article data-message-id="assistant-1">
            <span id="selected-text">document mouseup quote</span>
          </article>
        </section>
        <button id="settings-button" type="button">Settings</button>
      `;
      selectElementText(document.getElementById('selected-text')!);
      useStore.getState().setQuoteCandidate({
        text: 'document mouseup quote',
        sourceTitle: 'Assistant message',
        sourceKind: 'chat',
        sourceSessionPath: '/session/a.jsonl',
        sourceMessageId: 'assistant-1',
        sourceRole: 'assistant',
        charCount: 22,
      });

      document.getElementById('settings-button')?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
      );
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      expect(useStore.getState().quoteCandidate).toBeNull();
    } finally {
      dispose();
    }
  });

  it('clears a transient chat candidate when keyboard focus leaves the chat selection surface', () => {
    const dispose = initQuotedSelectionLifecycle(document);
    try {
      useStore.getState().setQuoteCandidate({
        text: 'old quote',
        sourceTitle: 'Assistant message',
        sourceKind: 'chat',
        sourceSessionPath: '/session/a.jsonl',
        sourceMessageId: 'assistant-1',
        sourceRole: 'assistant',
        charCount: 9,
      });
      document.body.innerHTML = `
        <section data-chat-selection-root="" data-session-path="/session/a.jsonl"></section>
        <input id="settings-input" />
      `;

      document.getElementById('settings-input')?.dispatchEvent(
        new FocusEvent('focusin', { bubbles: true }),
      );

      expect(useStore.getState().quoteCandidate).toBeNull();
    } finally {
      dispose();
    }
  });

  it('clears a transient chat candidate when the app window loses focus', () => {
    const dispose = initQuotedSelectionLifecycle(document);
    try {
      useStore.getState().setQuoteCandidate({
        text: 'old quote',
        sourceTitle: 'Assistant message',
        sourceKind: 'chat',
        sourceSessionPath: '/session/a.jsonl',
        sourceMessageId: 'assistant-1',
        sourceRole: 'assistant',
        charCount: 9,
      });

      window.dispatchEvent(new Event('blur'));

      expect(useStore.getState().quoteCandidate).toBeNull();
    } finally {
      dispose();
    }
  });

  it('keeps added preview quotes when chat capture sees an empty selection', () => {
    useStore.getState().addQuotedSelection({
      text: 'preview quote',
      sourceTitle: 'note.md',
      sourceKind: 'preview',
      sourceFilePath: '/notes/note.md',
      charCount: 13,
    });

    window.getSelection()?.removeAllRanges();
    captureChatSelection('/session/a.jsonl');

    expect(useStore.getState().quotedSelections[0]).toMatchObject({
      text: 'preview quote',
      sourceKind: 'preview',
    });
  });

  it('clears only quotes matching the requested source scope', () => {
    useStore.getState().setQuoteCandidate({
      text: 'chat quote',
      sourceTitle: 'Assistant message',
      sourceKind: 'chat',
      sourceSessionPath: '/session/a.jsonl',
      sourceMessageId: 'assistant-1',
      sourceRole: 'assistant',
      charCount: 10,
    });

    clearSelection({ sourceKind: 'preview' });

    expect(useStore.getState().quoteCandidate).toMatchObject({
      text: 'chat quote',
      sourceKind: 'chat',
    });

    clearSelection({ sourceKind: 'chat', sourceSessionPath: '/session/a.jsonl' });

    expect(useStore.getState().quoteCandidate).toBeNull();
  });

  it('clears an existing candidate when chat capture sees an empty selection', () => {
    useStore.getState().setQuoteCandidate({
      text: 'old quote',
      sourceTitle: 'Assistant message',
      sourceKind: 'chat',
      sourceSessionPath: '/session/a.jsonl',
      sourceMessageId: 'assistant-1',
      sourceRole: 'assistant',
      charCount: 9,
    });

    window.getSelection()?.removeAllRanges();
    captureChatSelection('/session/a.jsonl');

    expect(useStore.getState().quoteCandidate).toBeNull();
  });

  it('ignores cross-message chat selections instead of stealing ambiguous ownership', () => {
    useStore.setState({
      chatSessions: {
        '/session/a.jsonl': {
          items: [
            { type: 'message', data: { id: 'user-1', role: 'user', text: '第一条' } },
            { type: 'message', data: { id: 'assistant-1', role: 'assistant', blocks: [] } },
          ],
          hasMore: false,
          loadingMore: false,
        },
      },
    } as never);
    document.body.innerHTML = `
      <article data-message-id="user-1"><span id="start-text">第一条</span></article>
      <article data-message-id="assistant-1"><span id="end-text">第二条</span></article>
    `;
    selectAcrossElements(
      document.getElementById('start-text')!,
      document.getElementById('end-text')!,
    );

    captureChatSelection('/session/a.jsonl');

    expect(useStore.getState().quoteCandidate).toBeNull();
  });

  it('ignores selections inside chat action buttons', () => {
    useStore.setState({
      chatSessions: {
        '/session/a.jsonl': {
          items: [
            { type: 'message', data: { id: 'assistant-1', role: 'assistant', blocks: [] } },
          ],
          hasMore: false,
          loadingMore: false,
        },
      },
    } as never);
    document.body.innerHTML = `
      <article data-message-id="assistant-1">
        <button type="button"><span id="button-text">复制</span></button>
      </article>
    `;
    selectElementText(document.getElementById('button-text')!);

    captureChatSelection('/session/a.jsonl');

    expect(useStore.getState().quoteCandidate).toBeNull();
  });
});

function seedChatFixture(): void {
  useStore.setState({
    chatSessions: {
      '/session/a.jsonl': {
        items: [
          {
            type: 'message',
            data: {
              id: 'assistant-1',
              role: 'assistant',
              blocks: [{ type: 'text', html: '<p>document mouseup quote</p>', source: 'document mouseup quote' }],
            },
          },
        ],
        hasMore: false,
        loadingMore: false,
      },
    },
  } as never);
}

function domRect(rect: { left: number; right: number; top: number; bottom: number; width: number; height: number }): DOMRect {
  return {
    ...rect,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  } as DOMRect;
}

function selectElementText(element: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return range;
}

function selectAcrossElements(startElement: HTMLElement, endElement: HTMLElement): Range {
  const startNode = startElement.firstChild;
  const endNode = endElement.firstChild;
  if (!startNode || !endNode) throw new Error('test fixture must contain text nodes');
  const range = document.createRange();
  range.setStart(startNode, 0);
  range.setEnd(endNode, endNode.textContent?.length || 0);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return range;
}

function placeCollapsedSelection(element: HTMLElement): void {
  const textNode = element.firstChild;
  if (!textNode) throw new Error('test fixture must contain a text node');
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
