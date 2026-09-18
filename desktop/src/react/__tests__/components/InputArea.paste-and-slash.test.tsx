// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { JSONContent } from '@tiptap/core';
import { Schema, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputArea } from '../../components/InputArea';
import type { SlashItem } from '../../components/input/slash-commands';
import { useStore } from '../../stores';

const mocks = vi.hoisted(() => ({
  editorOptions: undefined as undefined | Record<string, unknown>,
  editorText: '',
  editorJson: undefined as undefined | JSONContent,
  editorState: undefined as undefined | EditorState,
  updateHandler: undefined as undefined | (() => void),
  insertContent: vi.fn(),
  setContent: vi.fn(),
  splitListItem: vi.fn(),
  editorIsActive: vi.fn((_name?: string) => false),
  chainInserted: [] as unknown[],
  chainDeletedRanges: [] as Array<{ from: number; to: number }>,
  chainClearContent: vi.fn(),
  ensureSession: vi.fn(async () => ({
    sessionId: 'sess_input',
    sessionPath: '/session/input.jsonl',
    agentId: 'hana',
  })),
  loadSessions: vi.fn(),
  upsertOptimisticSessionFirstMessage: vi.fn(),
  hanaFetch: vi.fn(),
  wsSend: vi.fn(),
  editorFocus: vi.fn(),
}));

function editorJsonForText(text: string) {
  return {
    type: 'doc',
    content: text
      ? [{ type: 'paragraph', content: [{ type: 'text', text }] }]
      : [],
  };
}

const slashRangeSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    hardBreak: { inline: true, group: 'inline', atom: true },
    skillBadge: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { name: { default: '' } },
    },
    fileBadge: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: {
        fileId: { default: null },
        path: { default: '' },
        name: { default: '' },
      },
    },
    agentBadge: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: {
        agentId: { default: '' },
        label: { default: '' },
      },
    },
  },
  marks: {
    bold: {},
    italic: {},
  },
});

function setMockEditorDocument(doc: ProseMirrorNode, cursor: number): void {
  mocks.editorJson = doc.toJSON();
  mocks.editorText = doc.textBetween(0, doc.content.size, '\n', '');
  mocks.editorState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, cursor),
  });
}

function findTextNodePosition(doc: ProseMirrorNode, text: string): number {
  let match = -1;
  doc.descendants((node, position) => {
    if (match >= 0 || !node.isText || node.text !== text) return match < 0;
    match = position;
    return false;
  });
  if (match < 0) throw new Error(`Missing text node: ${text}`);
  return match;
}

vi.mock('@tiptap/react', () => ({
  useEditor: (options: Record<string, unknown>) => {
    mocks.editorOptions = options;
    const chain = {
      clearContent: vi.fn(() => {
        mocks.chainClearContent();
        return chain;
      }),
      deleteRange: vi.fn((range: { from: number; to: number }) => {
        mocks.chainDeletedRanges.push(range);
        return chain;
      }),
      insertContent: vi.fn((content: unknown) => {
        mocks.chainInserted.push(content);
        return chain;
      }),
      focus: vi.fn(() => chain),
      run: vi.fn(),
    };
    return {
      commands: {
        focus: mocks.editorFocus,
        clearContent: vi.fn(),
        scrollIntoView: vi.fn(),
        setContent: mocks.setContent,
        insertContent: mocks.insertContent,
        splitListItem: mocks.splitListItem,
      },
      chain: () => chain,
      getText: () => mocks.editorText,
      getJSON: () => mocks.editorJson ?? editorJsonForText(mocks.editorText),
      isActive: mocks.editorIsActive,
      isDestroyed: false,
      get state() {
        return mocks.editorState ?? { tr: { setMeta: vi.fn(() => ({})) } };
      },
      view: { dispatch: vi.fn() },
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'update') mocks.updateHandler = handler;
      }),
      off: vi.fn(),
    };
  },
  EditorContent: () => React.createElement('div', { 'data-testid': 'editor' }),
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: { configure: () => ({}) },
}));

vi.mock('@tiptap/extension-bold', () => ({
  Bold: { extend: () => ({}) },
}));

vi.mock('@tiptap/extension-placeholder', () => ({
  default: { configure: () => ({ name: 'placeholder' }) },
}));

vi.mock('../../components/input/extensions/skill-badge', () => ({
  SkillBadge: { name: 'skillBadge' },
}));

vi.mock('../../components/input/extensions/file-badge', () => ({
  FileBadge: { name: 'fileBadge' },
}));

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'zh-CN' }),
}));

vi.mock('../../hooks/use-config', () => ({
  fetchConfig: vi.fn(async () => ({})),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (path: string, opts?: RequestInit) => mocks.hanaFetch(path, opts),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../stores/session-actions', () => ({
  ensureSession: mocks.ensureSession,
  loadSessions: mocks.loadSessions,
  upsertOptimisticSessionFirstMessage: mocks.upsertOptimisticSessionFirstMessage,
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: vi.fn(),
  searchDeskFiles: vi.fn(async () => []),
  toggleJianSidebar: vi.fn(),
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: vi.fn(() => ({ readyState: WebSocket.OPEN, send: mocks.wsSend })),
}));

vi.mock('../../MainContent', () => ({
  attachFilesFromPaths: vi.fn(),
}));

vi.mock('../../components/input/SlashCommandMenu', () => ({
  SlashCommandMenu: ({
    commands,
    selected,
    onSelect,
  }: {
    commands: SlashItem[];
    selected: number;
    onSelect: (item: SlashItem) => void;
  }) => React.createElement(
    'div',
    { 'data-testid': 'slash-menu', 'data-selected': String(selected) },
    commands.map(command => React.createElement(
      'button',
      {
        key: command.name,
        type: 'button',
        'aria-label': `slash-${command.name}`,
        onClick: () => onSelect(command),
      },
      command.label,
    )),
  ),
}));

vi.mock('../../components/input/FileMentionMenu', () => ({
  FileMentionMenu: () => null,
}));

vi.mock('../../components/input/InputStatusBars', () => ({
  InputStatusBars: () => null,
}));

vi.mock('../../components/input/InputContextRow', () => ({
  InputContextRow: () => null,
}));

vi.mock('../../components/input/InputControlBar', () => ({
  InputControlBar: ({
    onAttach,
    onSlashToggle,
  }: {
    onAttach: () => void;
    onSlashToggle: () => void;
  }) => React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'button',
      { type: 'button', 'aria-label': 'attach', onClick: onAttach },
      'send',
    ),
    React.createElement(
      'button',
      { type: 'button', 'aria-label': 'slash-toggle', onClick: onSlashToggle },
      'slash',
    ),
  ),
}));

vi.mock('../../components/input/SessionConfirmationPrompt', () => ({
  SessionConfirmationPrompt: () => null,
}));

vi.mock('../../hooks/use-slash-items', () => ({
  useSkillSlashItems: () => [
    {
      name: 'zz-first',
      label: '/zz-first',
      description: 'first',
      busyLabel: '',
      icon: '',
      type: 'skill',
      execute: vi.fn(),
    },
    {
      name: 'zz-second',
      label: '/zz-second',
      description: 'second',
      busyLabel: '',
      icon: '',
      type: 'skill',
      execute: vi.fn(),
    },
  ],
  useServerSlashCommandItems: () => [],
}));

vi.mock('../../utils/paste-upload-feedback', () => ({
  notifyPasteUploadFailure: vi.fn(),
}));

vi.mock('../../services/stream-resume', () => ({
  replayStreamResume: vi.fn(),
  isStreamResumeRebuilding: () => null,
  isStreamScopedMessage: () => false,
  updateSessionStreamMeta: vi.fn(),
}));

function seedInputState(overrides: Partial<ReturnType<typeof useStore.getState>> = {}) {
  useStore.setState({
    currentSessionPath: '/session/input.jsonl',
    currentSessionId: 'sess_input',
    currentAgentId: 'hana',
    pendingDraftId: 'draft-input',
    sessions: [{
      path: '/session/input.jsonl',
      sessionId: 'sess_input',
      agentId: 'hana',
      agentName: 'Hana',
    }],
    sessionLocatorsById: { sess_input: { path: '/session/input.jsonl' } },
    connected: true,
    pendingNewSession: false,
    streamingSessions: [],
    compactingSessions: [],
    inlineErrors: {},
    attachedFiles: [],
    attachedFilesBySession: {},
    docContextAttached: false,
    quoteCandidate: null,
    quotedSelections: [],
    quotedSelection: null,
    models: [{
      id: 'deepseek-chat',
      provider: 'deepseek',
      name: 'DeepSeek Chat',
      input: ['text'],
      isCurrent: true,
    }],
    sessionModelsByPath: {},
    previewItems: [],
    previewOpen: false,
    activeTabId: null,
    chatSessions: {},
    serverPort: 3210,
    serverToken: null,
    modelSwitching: false,
    welcomeVisible: false,
    agentYuan: 'hanako',
    ...overrides,
  } as never);
}

function tiptapPasteHandler(): ((view: unknown, event: ClipboardEvent) => boolean | void) | undefined {
  const editorProps = mocks.editorOptions?.editorProps as Record<string, unknown> | undefined;
  return editorProps?.handlePaste as ((view: unknown, event: ClipboardEvent) => boolean | void) | undefined;
}

function latestEditorOptions(): Record<string, unknown> | undefined {
  return mocks.editorOptions;
}

function tiptapKeyDownHandler(): ((view: unknown, event: KeyboardEvent) => boolean | void) | undefined {
  const editorProps = mocks.editorOptions?.editorProps as Record<string, unknown> | undefined;
  return editorProps?.handleKeyDown as ((view: unknown, event: KeyboardEvent) => boolean | void) | undefined;
}

function tiptapBeforeInputHandler(): ((view: unknown, event: InputEvent) => boolean | void) | undefined {
  const editorProps = mocks.editorOptions?.editorProps as Record<string, unknown> | undefined;
  const domEvents = editorProps?.handleDOMEvents as Record<string, unknown> | undefined;
  return domEvents?.beforeinput as ((view: unknown, event: InputEvent) => boolean | void) | undefined;
}

function installImageCompressionMocks() {
  const close = vi.fn();
  const drawImage = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
    width: 4000,
    height: 3000,
    close,
  })));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function toBlob(
    callback: BlobCallback,
    type?: string,
  ) {
    callback(new Blob([new Uint8Array([4, 5, 6])], { type: type || 'image/jpeg' }));
  });
  return { close, drawImage };
}

describe('InputArea paste and slash menu behavior', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.editorOptions = undefined;
    mocks.editorText = '';
    mocks.editorJson = undefined;
    mocks.editorState = undefined;
    mocks.updateHandler = undefined;
    mocks.chainInserted = [];
    mocks.chainDeletedRanges = [];
    mocks.chainClearContent.mockClear();
    mocks.splitListItem.mockClear();
    mocks.editorIsActive.mockReset();
    mocks.editorIsActive.mockReturnValue(false);
    mocks.editorFocus.mockClear();
    mocks.upsertOptimisticSessionFirstMessage.mockClear();
    mocks.ensureSession.mockImplementation(async () => {
      useStore.setState({
        currentSessionPath: '/session/input.jsonl',
        currentSessionId: 'sess_input',
        pendingNewSession: false,
        welcomeVisible: false,
      } as never);
      return {
        sessionId: 'sess_input',
        sessionPath: '/session/input.jsonl',
        agentId: 'hana',
      };
    });
    seedInputState();
    mocks.hanaFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    window.platform = {} as typeof window.platform;
  });

  it('keeps desktop editor creation immediate while deferring mobile editor creation until after mount', () => {
    const { unmount } = render(React.createElement(InputArea));

    expect(latestEditorOptions()?.immediatelyRender).toBe(true);

    unmount();
    mocks.editorOptions = undefined;
    render(<InputArea surface="mobile" />);

    expect(latestEditorOptions()?.immediatelyRender).toBe(false);
  });

  it('consumes a rich URL paste through the TipTap paste hook before the default editor paste runs', () => {
    render(React.createElement(InputArea));

    const preventDefault = vi.fn();
    const result = tiptapPasteHandler()?.(null, {
      preventDefault,
      clipboardData: {
        items: [],
        getData: (type: string) => ({
          'text/plain': 'Example Article',
          'text/html': '<a href="https://example.com/article">Example Article</a>',
          'text/uri-list': '',
        }[type] ?? ''),
      },
    } as unknown as ClipboardEvent);

    expect(result).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.insertContent).toHaveBeenCalledWith('https://example.com/article');
  });

  it('selects the highlighted slash command on Enter without falling through to message send', async () => {
    const doc = slashRangeSchema.node('doc', null, [
      slashRangeSchema.node('paragraph', null, [slashRangeSchema.text('/zz')]),
    ]);
    setMockEditorDocument(doc, 4);
    render(React.createElement(InputArea));

    await waitFor(() => {
      expect(mocks.updateHandler).toBeTypeOf('function');
    });

    act(() => {
      mocks.updateHandler?.();
    });

    await screen.findByTestId('slash-menu');
    fireEvent.keyDown(screen.getByTestId('editor'), { key: 'ArrowDown' });

    await waitFor(() => {
      expect(screen.getByTestId('slash-menu').getAttribute('data-selected')).toBe('1');
    });

    fireEvent.keyDown(screen.getByTestId('editor'), { key: 'Enter' });

    expect(mocks.chainInserted).toContainEqual({
      type: 'skillBadge',
      attrs: { name: 'zz-second' },
    });
    expect(mocks.chainDeletedRanges).toEqual([{ from: 1, to: 4 }]);
    expect(mocks.chainClearContent).not.toHaveBeenCalled();
    expect(mocks.wsSend).not.toHaveBeenCalled();
  });

  it('replaces only the selected rich-document slash trigger when a skill is clicked', async () => {
    const doc = slashRangeSchema.node('doc', null, [
      slashRangeSchema.node('paragraph', null, [
        slashRangeSchema.text('第一行', [slashRangeSchema.mark('bold')]),
      ]),
      slashRangeSchema.node('paragraph', null, [
        slashRangeSchema.text('前文 ', [slashRangeSchema.mark('italic')]),
        slashRangeSchema.node('fileBadge', { fileId: 'file-1', path: '/tmp/a.txt', name: 'a.txt' }),
        slashRangeSchema.text(' '),
        slashRangeSchema.node('agentBadge', { agentId: 'agent-1', label: 'Agent One' }),
        slashRangeSchema.text(' '),
        slashRangeSchema.text('/', [slashRangeSchema.mark('bold')]),
        slashRangeSchema.text('z'),
        slashRangeSchema.text('z', [slashRangeSchema.mark('italic')]),
        slashRangeSchema.text(' 后文', [slashRangeSchema.mark('bold')]),
      ]),
      slashRangeSchema.node('paragraph', null, [slashRangeSchema.text('最后一行')]),
    ]);
    const slashFrom = findTextNodePosition(doc, '/');
    setMockEditorDocument(doc, slashFrom + 3);
    render(React.createElement(InputArea));

    fireEvent.click(screen.getByRole('button', { name: 'slash-toggle' }));
    fireEvent.click(await screen.findByRole('button', { name: 'slash-zz-first' }));

    expect(mocks.chainDeletedRanges).toEqual([{ from: slashFrom, to: slashFrom + 3 }]);
    expect(mocks.chainInserted).toEqual([
      { type: 'skillBadge', attrs: { name: 'zz-first' } },
      ' ',
    ]);
    expect(mocks.chainClearContent).not.toHaveBeenCalled();
  });

  it('inserts a toolbar-selected skill at the current selection when there is no slash trigger', async () => {
    const doc = slashRangeSchema.node('doc', null, [
      slashRangeSchema.node('paragraph', null, [slashRangeSchema.text('已有正文')]),
    ]);
    setMockEditorDocument(doc, 3);
    render(React.createElement(InputArea));

    fireEvent.click(screen.getByRole('button', { name: 'slash-toggle' }));
    fireEvent.click(await screen.findByRole('button', { name: 'slash-zz-first' }));

    expect(mocks.chainDeletedRanges).toEqual([]);
    expect(mocks.chainClearContent).not.toHaveBeenCalled();
    expect(mocks.chainInserted).toEqual([
      { type: 'skillBadge', attrs: { name: 'zz-first' } },
      ' ',
    ]);
  });

  it('saves rich list drafts as markdown text plus the editor document', async () => {
    render(React.createElement(InputArea));

    await waitFor(() => {
      expect(mocks.updateHandler).toBeTypeOf('function');
    });

    mocks.editorJson = {
      type: 'doc',
      content: [{
        type: 'orderedList',
        attrs: { start: 1 },
        content: [{
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'first' }],
          }],
        }],
      }],
    };

    act(() => {
      mocks.updateHandler?.();
    });

    expect(useStore.getState().drafts.sess_input).toBe('1. first');
    expect(useStore.getState().draftDocs.sess_input).toEqual(mocks.editorJson);
  });

  it('uses Shift+Enter inside list items to create the next list item', () => {
    mocks.editorIsActive.mockImplementation((name?: string) => name === 'listItem');
    render(React.createElement(InputArea));

    const preventDefault = vi.fn();
    const handled = tiptapKeyDownHandler()?.(null, {
      key: 'Enter',
      shiftKey: true,
      isComposing: false,
      defaultPrevented: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.splitListItem).toHaveBeenCalledWith('listItem');
    expect(mocks.wsSend).not.toHaveBeenCalled();
  });

  it('leaves Shift+Enter outside lists to the editor default soft break behavior', () => {
    mocks.editorIsActive.mockReturnValue(false);
    render(React.createElement(InputArea));

    const preventDefault = vi.fn();
    const handled = tiptapKeyDownHandler()?.(null, {
      key: 'Enter',
      shiftKey: true,
      isComposing: false,
      defaultPrevented: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(mocks.splitListItem).not.toHaveBeenCalled();
  });

  it('handles welcome Enter inside TipTap before the editor inserts a newline', async () => {
    seedInputState({
      currentSessionPath: null,
      pendingNewSession: true,
      welcomeVisible: true,
    });
    mocks.editorText = '你好 Hana';
    render(React.createElement(InputArea));

    const preventDefault = vi.fn();
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(event, 'preventDefault', { value: preventDefault });

    const handled = tiptapKeyDownHandler()?.(null, event);

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(mocks.ensureSession).toHaveBeenCalledTimes(1);
      expect(mocks.loadSessions).toHaveBeenCalledTimes(1);
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
    expect(mocks.upsertOptimisticSessionFirstMessage).toHaveBeenCalledWith(
      '/session/input.jsonl',
      '你好 Hana',
      expect.any(String),
    );
  });

  it('maps mobile insertParagraph beforeinput to the same send path as Enter', async () => {
    seedInputState({
      currentSessionPath: null,
      pendingNewSession: true,
      welcomeVisible: true,
    });
    mocks.editorText = '手机端回车发送';
    render(<InputArea surface="mobile" />);

    const preventDefault = vi.fn();
    const handled = tiptapBeforeInputHandler()?.(null, {
      inputType: 'insertParagraph',
      isComposing: false,
      defaultPrevented: false,
      preventDefault,
    } as unknown as InputEvent);

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(mocks.ensureSession).toHaveBeenCalledTimes(1);
      expect(mocks.loadSessions).toHaveBeenCalledTimes(1);
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
  });

  it('returns focus to the editor after the desktop file picker resolves', async () => {
    const selectFiles = vi.fn(async () => ['/tmp/report.pdf']);
    window.platform = { selectFiles } as unknown as typeof window.platform;
    render(React.createElement(InputArea));

    const attach = screen.getByRole('button', { name: 'attach' });
    attach.focus();
    expect(document.activeElement).toBe(attach);

    fireEvent.click(attach);

    await waitFor(() => {
      expect(selectFiles).toHaveBeenCalledTimes(1);
      expect(mocks.editorFocus).toHaveBeenCalledTimes(1);
    });
  });

  it('passes pasted clipboard files with filesystem paths through the drag attachment path', async () => {
    const { attachFilesFromPaths } = await import('../../MainContent');
    const file = new File(['report'], 'report.pdf', { type: 'application/pdf' });
    const getFilePath = vi.fn(() => '/Users/hana/Desktop/report.pdf');
    window.platform = { getFilePath } as unknown as typeof window.platform;
    render(React.createElement(InputArea));

    const preventDefault = vi.fn();
    const handled = tiptapPasteHandler()?.(null, {
      preventDefault,
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'application/pdf',
          getAsFile: () => file,
        }],
        getData: () => '',
      },
    } as unknown as ClipboardEvent);

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(attachFilesFromPaths).toHaveBeenCalledWith(['/Users/hana/Desktop/report.pdf'], {
        '/Users/hana/Desktop/report.pdf': 'report.pdf',
      });
    });
    expect(mocks.hanaFetch).not.toHaveBeenCalledWith('/api/upload-blob', expect.anything());
  });

  it('registers pasted image blob uploads as path-backed attachments without base64Data', async () => {
    mocks.hanaFetch.mockImplementation(async (path: string) => {
      if (path === '/api/upload-blob') {
        return new Response(JSON.stringify({
          uploads: [{
            fileId: 'sf_pasted_image',
            dest: '/hana/session-files/pasted.png',
            name: 'pasted.png',
            isDirectory: false,
          }],
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const getFilePath = vi.fn(() => null);
    window.platform = { getFilePath } as unknown as typeof window.platform;
    render(React.createElement(InputArea));

    const preventDefault = vi.fn();
    const file = new File([new Uint8Array([1, 2, 3])], 'clipboard.png', { type: 'image/png' });
    const handled = tiptapPasteHandler()?.(null, {
      preventDefault,
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => file,
        }],
      },
    } as unknown as ClipboardEvent);

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/upload-blob', expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }));
    });
    await waitFor(() => {
      expect(useStore.getState().attachedFiles).toEqual([{
        fileId: 'sf_pasted_image',
        path: '/hana/session-files/pasted.png',
        name: 'pasted.png',
        isDirectory: false,
      }]);
    });
    expect(useStore.getState().attachedFiles[0]).not.toHaveProperty('base64Data');
  });

  it('compresses oversized pasted images before upload-blob', async () => {
    installImageCompressionMocks();
    mocks.hanaFetch.mockImplementation(async (path: string) => {
      if (path === '/api/upload-blob') {
        return new Response(JSON.stringify({
          uploads: [{
            fileId: 'sf_compressed_paste',
            dest: '/hana/session-files/pasted.jpg',
            name: 'pasted.jpg',
            isDirectory: false,
          }],
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const getFilePath = vi.fn(() => null);
    window.platform = { getFilePath } as unknown as typeof window.platform;
    render(React.createElement(InputArea));

    const preventDefault = vi.fn();
    const file = new File([new Uint8Array(900 * 1024)], 'clipboard.png', { type: 'image/png' });
    const handled = tiptapPasteHandler()?.(null, {
      preventDefault,
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => file,
        }],
      },
    } as unknown as ClipboardEvent);

    expect(handled).toBe(true);
    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/upload-blob', expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }));
    });
    const body = JSON.parse(String(mocks.hanaFetch.mock.calls.find(([path]) => path === '/api/upload-blob')?.[1]?.body));
    expect(body).toMatchObject({
      name: 'input.pastedImage.jpg',
      mimeType: 'image/jpeg',
      base64Data: 'BAUG',
      sessionPath: '/session/input.jsonl',
    });
  });

  it('sends chat quoted selection through the existing prompt quote contract', async () => {
    seedInputState({
      quotedSelections: [
        {
          text: '原句一',
          sourceTitle: 'Assistant message',
          sourceKind: 'chat',
          sourceSessionPath: '/session/input.jsonl',
          sourceMessageId: 'assistant-1',
          sourceRole: 'assistant',
          charCount: 3,
        },
        {
          text: '原句二',
          sourceTitle: 'note.md',
          sourceKind: 'preview',
          sourceFilePath: '/notes/note.md',
          lineStart: 2,
          lineEnd: 2,
          charCount: 3,
        },
      ],
    });
    mocks.editorText = '请继续';
    render(React.createElement(InputArea));

    const preventDefault = vi.fn();
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(event, 'preventDefault', { value: preventDefault });

    const handled = tiptapKeyDownHandler()?.(null, event);

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(payload.text).toBe([
      '请继续',
      '',
      '[引用片段] 原句一',
      '',
      '[引用片段] note.md（第2-2行，共3字）路径: /notes/note.md',
      '[引用原文]',
      '原句二',
      '[/引用原文]',
    ].join('\n'));
    expect(payload.displayMessage).toMatchObject({
      text: '请继续',
      quotedText: '原句一\n\n原句二',
    });
    expect(useStore.getState().quotedSelections).toEqual([]);
  });

  it('adds an optimistic user message with a clientMessageId when sending a prompt', async () => {
    mocks.editorText = '马上显示这条消息';
    render(React.createElement(InputArea));

    const preventDefault = vi.fn();
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(event, 'preventDefault', { value: preventDefault });

    const handled = tiptapKeyDownHandler()?.(null, event);

    expect(handled).toBe(true);
    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledTimes(1);
    });
    const payload = JSON.parse(String(mocks.wsSend.mock.calls[0][0]));
    expect(payload.clientMessageId).toMatch(/^client-user-/);

    const items = useStore.getState().chatSessions.sess_input?.items || [];
    expect(items).toHaveLength(1);
    const first = items[0];
    expect(first?.type).toBe('message');
    if (!first || first.type !== 'message') throw new Error('expected optimistic message item');
    expect(first.data).toMatchObject({
      id: payload.clientMessageId,
      role: 'user',
      text: '马上显示这条消息',
      sendStatus: 'pending',
    });
  });

  it('uploads mobile file-picker attachments through browser File API', async () => {
    const uploadJson = {
      uploads: [{
        fileId: 'sf_mobile_image',
        dest: '/hana/session-files/mobile.png',
        name: 'mobile.png',
        isDirectory: false,
      }],
    };
    mocks.hanaFetch.mockImplementation(async (path: string) => {
      if (path === '/api/upload-blob') {
        return new Response(JSON.stringify(uploadJson), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    window.platform = { selectFiles: vi.fn(async () => []) } as unknown as typeof window.platform;
    render(<InputArea surface="mobile" />);

    fireEvent.click(screen.getByRole('button', { name: 'attach' }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    const file = new File([new Uint8Array([1, 2, 3])], 'mobile.png', { type: 'image/png' });
    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/upload-blob', expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }));
    });
    const body = JSON.parse(String(mocks.hanaFetch.mock.calls.find(([path]) => path === '/api/upload-blob')?.[1]?.body));
    expect(body).toMatchObject({
      name: 'mobile.png',
      mimeType: 'image/png',
      sessionPath: '/session/input.jsonl',
    });
    expect(body.base64Data).toBe('AQID');
    expect(useStore.getState().attachedFiles[0]).toMatchObject({
      fileId: 'sf_mobile_image',
      path: '/hana/session-files/mobile.png',
      name: 'mobile.png',
      isDirectory: false,
      base64Data: 'AQID',
      mimeType: 'image/png',
    });
  });

  it('compresses oversized mobile browser image files before upload-blob', async () => {
    installImageCompressionMocks();
    const uploadJson = {
      uploads: [{
        fileId: 'sf_mobile_compressed',
        dest: '/hana/session-files/mobile.jpg',
        name: 'mobile.jpg',
        isDirectory: false,
      }],
    };
    mocks.hanaFetch.mockImplementation(async (path: string) => {
      if (path === '/api/upload-blob') {
        return new Response(JSON.stringify(uploadJson), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    window.platform = { selectFiles: vi.fn(async () => []) } as unknown as typeof window.platform;
    render(<InputArea surface="mobile" />);

    fireEvent.click(screen.getByRole('button', { name: 'attach' }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    const file = new File([new Uint8Array(900 * 1024)], 'mobile.png', { type: 'image/png' });
    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/upload-blob', expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }));
    });
    const body = JSON.parse(String(mocks.hanaFetch.mock.calls.find(([path]) => path === '/api/upload-blob')?.[1]?.body));
    expect(body).toMatchObject({
      name: 'mobile.jpg',
      mimeType: 'image/jpeg',
      base64Data: 'BAUG',
      sessionPath: '/session/input.jsonl',
    });
    expect(useStore.getState().attachedFiles[0]).toMatchObject({
      fileId: 'sf_mobile_compressed',
      path: '/hana/session-files/mobile.jpg',
      name: 'mobile.jpg',
      isDirectory: false,
      base64Data: 'BAUG',
      mimeType: 'image/jpeg',
    });
  });
});
