// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputArea, createStopRequest } from '../../components/InputArea';
import { useStore } from '../../stores';

const mocks = vi.hoisted(() => ({
  editorOptions: undefined as undefined | Record<string, unknown>,
  editorText: '',
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

vi.mock('@tiptap/react', () => ({
  useEditor: (options: Record<string, unknown>) => {
    mocks.editorOptions = options;
    const chain = {
      clearContent: vi.fn(() => chain),
      insertContent: vi.fn(() => chain),
      focus: vi.fn(() => chain),
      run: vi.fn(),
    };
    return {
      commands: {
        focus: mocks.editorFocus,
        clearContent: vi.fn(),
        scrollIntoView: vi.fn(),
        setContent: vi.fn(),
        insertContent: vi.fn(),
      },
      chain: () => chain,
      getText: () => mocks.editorText,
      getJSON: () => editorJsonForText(mocks.editorText),
      isDestroyed: false,
      state: { tr: { setMeta: vi.fn(() => ({})) } },
      view: { dispatch: vi.fn() },
      on: vi.fn(),
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
  ensureSession: vi.fn(async () => true),
  loadSessions: vi.fn(),
  upsertOptimisticSessionFirstMessage: vi.fn(),
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: vi.fn(),
  searchDeskFiles: vi.fn(async () => []),
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
  InputControlBar: () => React.createElement('button', { type: 'button' }, 'send'),
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

function seedInputState(overrides: Partial<ReturnType<typeof useStore.getState>> = {}) {
  useStore.setState({
    currentSessionPath: '/session/input.jsonl',
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
    inputFocusTrigger: 0,
    inputFocusTriggerSource: 'gesture',
    ...overrides,
  } as never);
}

describe('InputArea focus-restore surface gating (#2045 symptom 3)', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.editorOptions = undefined;
    mocks.editorText = '';
    mocks.editorFocus.mockClear();
    seedInputState();
    window.platform = {} as typeof window.platform;
  });

  it('does not focus the editor on mobile when the trigger source is restore', async () => {
    render(<InputArea surface="mobile" />);

    useStore.setState({ inputFocusTrigger: 1, inputFocusTriggerSource: 'restore' } as never);

    // Give any (incorrectly) scheduled rAF/timeout a chance to run.
    await new Promise((resolve) => { window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)); });

    expect(mocks.editorFocus).not.toHaveBeenCalled();
  });

  it('focuses the editor on mobile when the trigger source is an explicit gesture', async () => {
    render(<InputArea surface="mobile" />);

    useStore.setState({ inputFocusTrigger: 1, inputFocusTriggerSource: 'gesture' } as never);

    await waitFor(() => {
      expect(mocks.editorFocus).toHaveBeenCalled();
    });
  });

  it('focuses the editor on desktop (default surface) even when the trigger source is restore', async () => {
    render(React.createElement(InputArea));

    useStore.setState({ inputFocusTrigger: 1, inputFocusTriggerSource: 'restore' } as never);

    await waitFor(() => {
      expect(mocks.editorFocus).toHaveBeenCalled();
    });
  });
});

describe('InputArea Stop request contract', () => {
  it('sends a session-scoped Stop even when active stream metadata is missing', () => {
    expect(createStopRequest({
      sessionId: 'sess-input',
      sessionPath: '/session/input.jsonl',
      streamId: null,
    })).toEqual({
      type: 'abort',
      sessionId: 'sess-input',
      sessionPath: '/session/input.jsonl',
    });
  });

  it('includes a known stream id so the server can reject a delayed Stop safely', () => {
    expect(createStopRequest({
      sessionId: 'sess-input',
      sessionPath: '/session/input.jsonl',
      streamId: 'stream-current',
    })).toEqual({
      type: 'abort',
      sessionId: 'sess-input',
      sessionPath: '/session/input.jsonl',
      streamId: 'stream-current',
    });
  });
});
