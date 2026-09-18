// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { JSONContent } from '@tiptap/core';
import { Schema, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputArea } from '../../components/InputArea';
import { useStore } from '../../stores';
import type { DeskSearchResult } from '../../types';

const mocks = vi.hoisted(() => ({
  editorOptions: undefined as undefined | Record<string, unknown>,
  editorText: '',
  editorJson: undefined as undefined | JSONContent,
  editorState: undefined as undefined | EditorState,
  updateHandler: undefined as undefined | (() => void),
  searchDeskFiles: vi.fn(async (_query: string): Promise<DeskSearchResult[]> => []),
  mentionMenuProps: undefined as undefined | {
    items: Array<{ source?: string; name: string }>;
    busy: boolean;
  },
}));

const mentionSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
  },
});

function editorJsonForText(text: string) {
  return {
    type: 'doc',
    content: text
      ? [{ type: 'paragraph', content: [{ type: 'text', text }] }]
      : [],
  };
}

function setMockEditorDocument(doc: ProseMirrorNode, cursor: number): void {
  mocks.editorText = doc.textBetween(0, doc.content.size, '\n', '');
  mocks.editorJson = doc.toJSON();
  mocks.editorState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, cursor),
  });
}

vi.mock('@tiptap/react', () => ({
  useEditor: (options: Record<string, unknown>) => {
    mocks.editorOptions = options;
    const chain = {
      deleteRange: vi.fn(() => chain),
      insertContent: vi.fn(() => chain),
      focus: vi.fn(() => chain),
      run: vi.fn(),
    };
    return {
      commands: {
        focus: vi.fn(),
        clearContent: vi.fn(),
        scrollIntoView: vi.fn(),
        setContent: vi.fn(),
        insertContent: vi.fn(),
        splitListItem: vi.fn(),
      },
      chain: () => chain,
      getText: () => mocks.editorText,
      getJSON: () => mocks.editorJson ?? editorJsonForText(mocks.editorText),
      isActive: vi.fn(() => false),
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
  hanaFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../stores/session-actions', () => ({
  ensureSession: vi.fn(async () => ({
    sessionId: 'sess_input',
    sessionPath: '/session/input.jsonl',
    agentId: 'hana',
  })),
  loadSessions: vi.fn(),
  upsertOptimisticSessionFirstMessage: vi.fn(),
  continueDeletedAgentSession: vi.fn(),
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: vi.fn(),
  searchDeskFiles: (query: string) => mocks.searchDeskFiles(query),
  toggleJianSidebar: vi.fn(),
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: vi.fn(() => ({ readyState: WebSocket.OPEN, send: vi.fn() })),
}));

vi.mock('../../MainContent', () => ({
  attachFilesFromPaths: vi.fn(),
}));

vi.mock('../../components/input/SlashCommandMenu', () => ({
  SlashCommandMenu: () => null,
}));

vi.mock('../../components/input/MentionMenu', () => ({
  MentionMenu: (props: {
    items: Array<{ source?: string; name: string }>;
    busy: boolean;
  }) => {
    mocks.mentionMenuProps = props;
    return React.createElement(
      'div',
      {
        'data-testid': 'mention-menu',
        'data-busy': String(props.busy),
        'data-item-count': String(props.items.length),
      },
      props.items.map(item => React.createElement(
        'div',
        { key: item.name, 'data-source': item.source ?? 'unknown' },
        item.name,
      )),
    );
  },
}));

vi.mock('../../components/input/InputStatusBars', () => ({
  InputStatusBars: () => null,
}));

vi.mock('../../components/input/InputContextRow', () => ({
  InputContextRow: () => null,
}));

vi.mock('../../components/input/InputControlBar', () => ({
  InputControlBar: () => null,
}));

vi.mock('../../components/input/SessionConfirmationPrompt', () => ({
  SessionConfirmationPrompt: () => null,
}));

vi.mock('../../hooks/use-slash-items', () => ({
  useSkillSlashItems: () => [],
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

function seedInputState() {
  useStore.setState({
    currentSessionPath: '/session/input.jsonl',
    currentSessionId: 'sess_input',
    currentAgentId: 'hana',
    pendingDraftId: 'draft-input',
    sessions: [],
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
    deskFiles: [{ name: 'README.md', isDir: false }],
    deskBasePath: '/workspace',
    agents: [],
  } as never);
}

describe('InputArea file mention workspace search', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.editorOptions = undefined;
    mocks.editorText = '';
    mocks.editorJson = undefined;
    mocks.editorState = undefined;
    mocks.updateHandler = undefined;
    mocks.mentionMenuProps = undefined;
    mocks.searchDeskFiles.mockResolvedValue([{
      name: 'reader.ts',
      relativePath: 'src/reader.ts',
      parentSubdir: 'src',
      isDir: false,
    }]);
    seedInputState();
    window.platform = {} as typeof window.platform;
  });

  it('searches desk files when @ mention menu opens with a query and shows workspace results', async () => {
    const doc = mentionSchema.node('doc', null, [
      mentionSchema.node('paragraph', null, [mentionSchema.text('@read')]),
    ]);
    setMockEditorDocument(doc, doc.content.size - 1);

    render(React.createElement(InputArea));

    await waitFor(() => {
      expect(mocks.updateHandler).toBeTypeOf('function');
    });

    act(() => {
      mocks.updateHandler?.();
    });

    expect(screen.getByTestId('mention-menu')).toBeTruthy();

    await waitFor(() => {
      expect(mocks.searchDeskFiles).toHaveBeenCalledWith('read');
    }, { timeout: 500 });

    await waitFor(() => {
      expect(mocks.mentionMenuProps?.items.some(item => (
        item.source === 'workspace' && item.name === 'reader.ts'
      ))).toBe(true);
    }, { timeout: 500 });

    expect(screen.getByTestId('mention-menu').getAttribute('data-busy')).toBe('false');
  });
});
