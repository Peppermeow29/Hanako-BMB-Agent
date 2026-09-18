// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputArea } from '../../components/InputArea';
import { useStore } from '../../stores';

const deskActionMocks = vi.hoisted(() => ({
  loadDeskFiles: vi.fn(),
  revealDeskDirectory: vi.fn(async () => true),
  searchDeskFiles: vi.fn(async () => []),
  toggleJianSidebar: vi.fn(),
  continueDeletedAgentSession: vi.fn(),
}));

vi.mock('@tiptap/react', () => ({
  useEditor: () => ({
    commands: {
      focus: vi.fn(),
      clearContent: vi.fn(),
      scrollIntoView: vi.fn(),
      setContent: vi.fn(),
      insertContent: vi.fn(),
    },
    chain: () => ({
      clearContent: () => ({
        insertContent: () => ({
          insertContent: () => ({
            focus: () => ({ run: vi.fn() }),
          }),
        }),
      }),
    }),
    getText: () => '',
    getJSON: () => ({ type: 'doc', content: [] }),
    state: { tr: { setMeta: vi.fn(() => ({})) } },
    view: { dispatch: vi.fn() },
    on: vi.fn(),
    off: vi.fn(),
  }),
  EditorContent: () => React.createElement('div', { 'data-testid': 'editor' }),
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: { configure: () => ({}) },
}));

vi.mock('@tiptap/extension-bold', () => ({
  Bold: { extend: () => ({}) },
}));

vi.mock('@tiptap/extension-placeholder', () => ({
  default: { configure: () => ({}) },
}));

vi.mock('../../components/input/extensions/skill-badge', () => ({
  SkillBadge: {},
}));

vi.mock('../../components/input/extensions/file-badge', () => ({
  FileBadge: {},
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
  continueDeletedAgentSession: deskActionMocks.continueDeletedAgentSession,
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: deskActionMocks.loadDeskFiles,
  revealDeskDirectory: deskActionMocks.revealDeskDirectory,
  searchDeskFiles: deskActionMocks.searchDeskFiles,
  toggleJianSidebar: deskActionMocks.toggleJianSidebar,
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: vi.fn(() => null),
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
  InputStatusBars: ({
    slashBusy,
    slashBusyLabel,
    compacting,
    compactingLabel,
    screenshotBusy,
    screenshotLabel,
    screenshotPageLabel,
    inlineError,
    slashResult,
    onResultClick,
  }: {
    slashBusy?: string | null;
    slashBusyLabel?: string;
    compacting?: boolean;
    compactingLabel?: string;
    screenshotBusy?: boolean;
    screenshotLabel?: string;
    screenshotPageLabel?: string | null;
    inlineError?: string | null;
    slashResult?: unknown;
    onResultClick?: () => void;
  }) => {
    const label = slashBusy
      ? slashBusyLabel
      : compacting
        ? compactingLabel
        : screenshotBusy
          ? (screenshotPageLabel || screenshotLabel)
          : inlineError
            ? inlineError
            : slashResult
              ? 'slash-result'
              : null;
    return label
      ? React.createElement('button', {
        'data-testid': 'input-status-bars',
        onClick: onResultClick,
        type: 'button',
      }, label)
      : null;
  },
}));

vi.mock('../../components/input/InputContextRow', () => ({
  InputContextRow: ({
    attachedFiles,
    hasQuotedSelection,
  }: {
    attachedFiles?: unknown[];
    hasQuotedSelection?: boolean;
  }) => (
    (attachedFiles?.length || hasQuotedSelection)
      ? React.createElement('div', { 'data-testid': 'input-context-row' })
      : null
  ),
}));

vi.mock('../../components/input/InputControlBar', () => ({
  InputControlBar: () => React.createElement('button', { type: 'button' }, 'send'),
}));

vi.mock('../../components/input/SessionConfirmationPrompt', () => ({
  SessionConfirmationPrompt: () => React.createElement('div', { 'data-testid': 'approval-prompt' }),
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

function expectBefore(first: HTMLElement, second: HTMLElement) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

function seedLayeredInputState() {
  const sessionPath = '/session/status-stack.jsonl';
  useStore.setState({
    currentSessionPath: sessionPath,
    connected: true,
    pendingNewSession: false,
    pendingSessionSwitchPath: null,
    streamingSessions: [],
    compactingSessions: [sessionPath],
    compactionModeBySession: {},
    inlineErrors: {},
    screenshotTaskCount: 0,
    screenshotProgress: null,
    attachedFiles: [{
      path: '/tmp/example.md',
      name: 'example.md',
      isDirectory: false,
    }],
    attachedFilesBySession: {
      [sessionPath]: [{
        path: '/tmp/example.md',
        name: 'example.md',
        isDirectory: false,
      }],
    },
    docContextAttached: false,
    quoteCandidate: null,
    quotedSelections: [{
      text: 'quoted',
      sourceTitle: 'note.md',
      sourceKind: 'preview',
      charCount: 6,
    }],
    quotedSelection: null,
    todosBySession: {
      [sessionPath]: [{
        content: '读上下文',
        activeForm: '正在读上下文',
        status: 'in_progress',
      }],
    },
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
  } as never);
  useStore.getState().initSession(sessionPath, [{
    type: 'message',
    data: {
      id: 'assistant-confirmation',
      role: 'assistant',
      blocks: [{
        type: 'session_confirmation',
        confirmId: 'confirm-1',
        kind: 'tool_action_approval',
        surface: 'input',
        status: 'pending',
        title: '允许 Hana 执行这次操作',
      }],
    },
  }], false);
}

describe('InputArea status stack', () => {
  beforeEach(() => {
    seedLayeredInputState();
    window.platform = {} as typeof window.platform;
    delete (window as unknown as { hana?: unknown }).hana;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('places transient notices between context chips and the approval prompt', () => {
    render(React.createElement(InputArea));

    const contextRow = screen.getByTestId('input-context-row');
    const statusBars = screen.getByTestId('input-status-bars');
    const approvalPrompt = screen.getByTestId('approval-prompt');
    const editor = screen.getByTestId('editor');

    expectBefore(contextRow, statusBars);
    expectBefore(statusBars, approvalPrompt);
    expectBefore(approvalPrompt, editor);
  });

  it('shows one fresh-compact status when capability refresh is also compacting', () => {
    const sessionPath = '/session/status-stack.jsonl';
    useStore.setState({
      compactingSessions: [sessionPath],
      capabilityRefreshingSessions: [sessionPath],
      chatSessions: {
        [sessionPath]: { items: [] },
      },
      pendingSessionConfirmationsByPath: {},
    } as never);

    render(React.createElement(InputArea));

    const statusBars = screen.getAllByTestId('input-status-bars');
    expect(statusBars).toHaveLength(1);
    expect(statusBars[0].textContent).toContain('input.refreshAndCompactBusy');
    expect(statusBars[0].textContent).not.toContain('chat.compacting');
    expect(screen.getAllByText('input.refreshAndCompactBusy')).toHaveLength(1);
  });

  it('labels lossy local compaction as instant simple compaction', () => {
    const sessionPath = '/session/status-stack.jsonl';
    useStore.setState({
      compactionModeBySession: { [sessionPath]: 'lossy_local' },
      capabilityRefreshingSessions: [],
      chatSessions: {
        [sessionPath]: { items: [] },
      },
      pendingSessionConfirmationsByPath: {},
    } as never);

    render(React.createElement(InputArea));

    expect(screen.getByTestId('input-status-bars').textContent)
      .toContain('chat.instantSimpleCompaction');
  });

  it('opens legacy screenshot notice directories in the system file manager', async () => {
    const openFolder = vi.fn();
    window.platform = { openFolder } as unknown as typeof window.platform;
    render(React.createElement(InputArea));

    window.dispatchEvent(new CustomEvent('hana-inline-notice', {
      detail: {
        text: '截图已保存到工作目录下的「OH-Works」文件夹',
        type: 'success',
        deskDir: '/workspace/OH-Works',
      },
    }));

    fireEvent.click(await screen.findByTestId('input-status-bars'));

    expect(openFolder).toHaveBeenCalledWith('/workspace/OH-Works');
    expect(deskActionMocks.toggleJianSidebar).not.toHaveBeenCalled();
    expect(deskActionMocks.revealDeskDirectory).not.toHaveBeenCalled();
    expect(deskActionMocks.loadDeskFiles).not.toHaveBeenCalled();
  });

  it('reveals the generated screenshot in the system file manager when the notice carries a file path', async () => {
    const openFile = vi.fn();
    const openFolder = vi.fn();
    const showInFinder = vi.fn();
    window.platform = { openFile, openFolder, showInFinder } as unknown as typeof window.platform;
    render(React.createElement(InputArea));

    window.dispatchEvent(new CustomEvent('hana-inline-notice', {
      detail: {
        text: '截图已保存到工作目录下的「OH-Works」文件夹',
        type: 'success',
        deskDir: '/workspace/OH-Works/截图',
        filePath: '/workspace/OH-Works/截图/hanako-20260617.png',
      },
    }));

    fireEvent.click(await screen.findByTestId('input-status-bars'));

    expect(showInFinder).toHaveBeenCalledWith('/workspace/OH-Works/截图/hanako-20260617.png');
    expect(openFile).not.toHaveBeenCalled();
    expect(openFolder).not.toHaveBeenCalled();
    expect(deskActionMocks.toggleJianSidebar).not.toHaveBeenCalled();
    expect(deskActionMocks.revealDeskDirectory).not.toHaveBeenCalled();
  });

  it('does not show the composer context row for todos alone', () => {
    const sessionPath = '/session/todos-only.jsonl';
    useStore.setState({
      currentSessionPath: sessionPath,
      attachedFiles: [],
      attachedFilesBySession: {},
      quotedSelections: [],
      todosBySession: {
        [sessionPath]: [{
          content: '读上下文',
          activeForm: '正在读上下文',
          status: 'in_progress',
        }],
      },
      compactingSessions: [],
      chatSessions: {},
    } as never);

    render(React.createElement(InputArea));

    expect(screen.queryByTestId('input-context-row')).toBeNull();
  });

  it('covers deleted-agent sessions with a read-only continuation action and progress bar', () => {
    const deletedPath = '/session/deleted-agent.jsonl';
    deskActionMocks.continueDeletedAgentSession.mockReturnValue(new Promise<boolean>(() => {}));
    useStore.setState({
      currentSessionPath: deletedPath,
      sessions: [{
        path: deletedPath,
        title: 'Old chat',
        firstMessage: 'old hello',
        modified: new Date().toISOString(),
        messageCount: 2,
        agentId: 'deleted',
        agentName: 'Deleted Agent',
        cwd: '/tmp/work',
        agentDeleted: true,
        readOnlyReason: 'agent_deleted',
        continuationAvailable: true,
      }],
      chatSessions: {},
      compactingSessions: [],
      attachedFiles: [],
      attachedFilesBySession: {},
      quotedSelections: [],
      todosBySession: {},
    } as never);

    render(React.createElement(InputArea));

    expect(screen.getByText('session.deletedAgent.title')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'session.deletedAgent.continueButton' });
    fireEvent.click(button);

    expect(deskActionMocks.continueDeletedAgentSession).toHaveBeenCalledWith(deletedPath);
    expect(screen.getByTestId('deleted-agent-progress')).toBeTruthy();
  });
});
