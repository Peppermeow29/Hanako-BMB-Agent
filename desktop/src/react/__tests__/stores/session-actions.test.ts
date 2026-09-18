/**
 * session-actions 行为测试
 *
 * 聚焦 issue #405 回归：确保在 switchSession 流程里，
 * 后端返回的 per-session 模型信息 hydrate 不会骗过 loadMessages 的"已加载"判据，
 * 以及 loadMessages 的竞态护栏正确丢弃 stale 响应。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InlineErrorEntry } from '../../stores/streaming-slice';

type MockState = Record<string, unknown>;

const deskActionMocks = vi.hoisted(() => ({
  loadDeskFiles: vi.fn(),
  activateWorkspaceDesk: vi.fn(),
}));

const streamResumeMocks = vi.hoisted(() => ({
  requestStreamResume: vi.fn(),
}));

const mockState: MockState = {};
const initialStateFactory = (): MockState => ({
  currentSessionPath: null,
  currentSessionId: null,
  sessionLocatorsById: {} as Record<string, { path: string | null }>,
  pendingSessionSwitchPath: null,
  pendingNewSession: false,
  pendingDraftId: null,
  pendingProjectId: null,
  pendingNewSessionThinkingLevel: null,
  pendingNewSessionPermissionMode: null,
  sessionPermissionMode: 'ask',
  sessions: [] as Array<{ path: string }>,
  chatSessions: {} as Record<string, unknown>,
  sessionRegistryFilesByPath: {} as Record<string, unknown>,
  sessionModelsByPath: {} as Record<string, unknown>,
  _loadMessagesVersion: {} as Record<string, number>,
  _sessionFilesFlightByPath: {} as Record<string, { version: number; resetSeen: boolean; upserts: Record<string, unknown>[] }>,
  scrollPositions: {} as Record<string, number>,
  todosLiveVersionBySession: {} as Record<string, number>,
  todosBySession: {} as Record<string, unknown>,
  sessionStreams: {} as Record<string, unknown>,
  attachedFiles: [],
  attachedFilesBySession: {} as Record<string, unknown>,
  drafts: {} as Record<string, string>,
  draftDocs: {} as Record<string, unknown>,
  setDraft: vi.fn(),
  clearDraft: vi.fn(),
  streamingSessions: [] as string[],
  unreadOutputSessionPaths: [] as string[],
  capabilityRefreshingSessions: [] as string[],
  inlineErrors: {} as Record<string, InlineErrorEntry | null>,
  addToast: vi.fn(),
  activePanel: null,
  currentTab: 'chat',
  settingsModal: { open: false, activeTab: 'agent' },
  mediaViewer: null,
  skillViewerData: null,
  channelCreateOverlayVisible: false,
  computerOverlayBySession: {} as Record<string, unknown>,
  agents: [] as unknown[],
  currentAgentId: null,
  agentName: '',
  agentYuan: 'hanako',
  agentAvatarUrl: null,
  memoryEnabled: true,
  browserBySession: {} as Record<string, unknown>,
  welcomeVisible: false,
  deskContextAttached: false,
  docContextAttached: false,
  deskBasePath: '',
  deskCurrentPath: '',
  deskFiles: [] as unknown[],
  deskJianContent: null,
  workspaceDeskStateByRoot: {} as Record<string, unknown>,
  homeFolder: null,
  selectedFolder: null,
  selectedWorkspaceMountId: null,
  selectedWorkspaceLabel: null,
  deskWorkspaceMountId: null,
  deskWorkspaceLabel: null,
  studioWorkspaces: [],
  workspaceFolders: [] as string[],
  cwdHistory: [] as string[],
  selectedAgentId: null,
  thinkingLevel: 'medium',
  metaRecovery: null as unknown,
});

const dispatchedEvents: CustomEvent[] = [];

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => mockState,
    setState: (patch: MockState | ((s: MockState) => MockState)) => {
      const next = typeof patch === 'function' ? patch(mockState) : patch;
      Object.assign(mockState, next);
    },
  },
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
  hanaUrl: (p: string) => p,
}));

vi.mock('../../utils/history-builder', () => ({
  buildItemsFromHistory: (data: { messages?: unknown[] }) => (data.messages || []).map((m, i) => ({
    type: 'message' as const,
    data: { id: String(i), ...(m as object) },
  })),
}));

vi.mock('../../utils/todo-compat', () => ({
  migrateLegacyTodos: (x: { todos: unknown[] }) => x.todos,
}));

vi.mock('../../utils/ui-helpers', () => ({
  loadModels: vi.fn(),
}));

vi.mock('./agent-actions', () => ({
  loadAvatars: vi.fn(),
  clearChat: vi.fn(),
}));

vi.mock('../../stores/agent-actions', () => ({
  loadAvatars: vi.fn(),
  clearChat: vi.fn(),
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: deskActionMocks.loadDeskFiles,
  activateWorkspaceDesk: deskActionMocks.activateWorkspaceDesk,
}));

vi.mock('../../stores/create-keyed-slice', () => ({
  updateKeyed: vi.fn(),
}));

vi.mock('../../stores/stream-invalidator', () => ({
  snapshotStreamBuffer: vi.fn(),
  invalidateStreamBuffer: vi.fn(),
  registerStreamBufferInvalidator: vi.fn(),
  registerStreamBufferSnapshot: vi.fn(),
}));

vi.mock('../../utils/markdown', () => ({
  renderMarkdown: (s: string) => `<p>${s}</p>`,
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: () => null,
}));

vi.mock('../../services/stream-resume', () => ({
  requestStreamResume: streamResumeMocks.requestStreamResume,
}));

// Stub window.dispatchEvent / CustomEvent for jsdom-less runs
if (typeof window === 'undefined') {
  (globalThis as any).window = {
    dispatchEvent: (e: CustomEvent) => { dispatchedEvents.push(e); return true; },
  };
  (globalThis as any).CustomEvent = class {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
} else {
  window.dispatchEvent = ((e: Event) => {
    dispatchedEvents.push(e as CustomEvent);
    return true;
  }) as typeof window.dispatchEvent;
}

// Stub store methods used by loadMessages / switchSession
function installStoreMethods() {
  const s = mockState as MockState;
  s.initSession = vi.fn((path: string, items: unknown[], hasMore: boolean, revision?: string | null) => {
    const chat = mockState.chatSessions as Record<string, unknown>;
    chat[path] = { items, hasMore, loadingMore: false, revision: revision ?? null };
  });
  s.bumpLoadMessagesVersion = vi.fn((path: string) => {
    const versions = mockState._loadMessagesVersion as Record<string, number>;
    const next = (versions[path] ?? 0) + 1;
    versions[path] = next;
    return next;
  });
  s.updateSessionModel = vi.fn((path: string, model: unknown) => {
    // Critical invariant: must NOT write to chatSessions (#405 root cause).
    const models = mockState.sessionModelsByPath as Record<string, unknown>;
    models[path] = model;
  });
  s.clearSession = vi.fn((path: string) => {
    delete (mockState.chatSessions as Record<string, unknown>)[path];
    delete (mockState.sessionRegistryFilesByPath as Record<string, unknown>)[path];
    delete (mockState.sessionModelsByPath as Record<string, unknown>)[path];
    delete (mockState._loadMessagesVersion as Record<string, number>)[path];
    delete (mockState.scrollPositions as Record<string, number>)[path];
    delete (mockState._sessionFilesFlightByPath as Record<string, unknown>)[path];
  });
  s.setSessionRegistryFiles = vi.fn((path: string, files: unknown[]) => {
    const bySession = mockState.sessionRegistryFilesByPath as Record<string, unknown>;
    bySession[path] = files;
  });
  s.upsertSessionRegistryFile = vi.fn((path: string, file: Record<string, unknown>) => {
    const bySession = mockState.sessionRegistryFilesByPath as Record<string, Record<string, unknown>[]>;
    const files = bySession[path] || [];
    bySession[path] = [...files, file];
    const flightByPath = mockState._sessionFilesFlightByPath as Record<string, { version: number; resetSeen: boolean; upserts: Record<string, unknown>[] }>;
    const flight = flightByPath[path];
    if (flight) flight.upserts = [...flight.upserts, file];
  });
  s.beginSessionFilesFlight = vi.fn((path: string, version: number) => {
    const flightByPath = mockState._sessionFilesFlightByPath as Record<string, { version: number; resetSeen: boolean; upserts: Record<string, unknown>[] }>;
    flightByPath[path] = { version, resetSeen: false, upserts: [] };
  });
  s.consumeSessionFilesFlight = vi.fn((path: string, version: number) => {
    const flightByPath = mockState._sessionFilesFlightByPath as Record<string, { version: number; resetSeen: boolean; upserts: Record<string, unknown>[] }>;
    const flight = flightByPath[path];
    if (!flight || flight.version !== version) return null;
    delete flightByPath[path];
    return { resetSeen: flight.resetSeen, upserts: flight.upserts };
  });
  s.applyBranchResetSessionFiles = vi.fn((path: string, files: unknown[] | null) => {
    if (Array.isArray(files)) {
      const bySession = mockState.sessionRegistryFilesByPath as Record<string, unknown>;
      bySession[path] = files;
    }
    const flightByPath = mockState._sessionFilesFlightByPath as Record<string, { version: number; resetSeen: boolean; upserts: Record<string, unknown>[] }>;
    const flight = flightByPath[path];
    if (flight) flight.resetSeen = true;
  });
  s.setSessionTodosForPath = vi.fn((path: string, todos: unknown[]) => {
    const bySession = mockState.todosBySession as Record<string, unknown>;
    bySession[path] = todos;
  });
  s.bumpTodosLiveVersion = vi.fn((path: string) => {
    const versions = mockState.todosLiveVersionBySession as Record<string, number>;
    versions[path] = (versions[path] ?? 0) + 1;
  });
  s.setInlineError = vi.fn((path: string, error: string | InlineErrorEntry) => {
    const inlineErrors = mockState.inlineErrors as Record<string, InlineErrorEntry | null>;
    inlineErrors[path] = typeof error === 'string'
      ? { text: error, detail: null, code: null }
      : error;
  });
  s.appendItem = vi.fn((path: string, item: unknown) => {
    const chat = mockState.chatSessions as Record<string, { items: unknown[] }>;
    const entry = chat[path];
    if (entry) entry.items.push(item);
  });
  s.clearQuotedSelection = vi.fn();
  s.setActivePanel = vi.fn((v: unknown) => { mockState.activePanel = v; });
  s.requestInputFocus = vi.fn();
  s.setThinkingLevel = vi.fn((level: string) => { mockState.thinkingLevel = level; });
  s.setPendingNewSessionThinkingLevel = vi.fn((level: string | null) => { mockState.pendingNewSessionThinkingLevel = level; });
  s.setSessionPermissionMode = vi.fn((mode: string) => {
    mockState.sessionPermissionMode = mode;
    if (mockState.pendingNewSession === true) {
      mockState.pendingNewSessionPermissionMode = mode;
    }
  });
  s.setPendingNewSessionPermissionMode = vi.fn((mode: string | null) => { mockState.pendingNewSessionPermissionMode = mode; });
  s.setSessionCapabilityRefreshing = vi.fn((path: string, refreshing: boolean) => {
    const list = mockState.capabilityRefreshingSessions as string[];
    mockState.capabilityRefreshingSessions = refreshing
      ? (list.includes(path) ? list : [...list, path])
      : list.filter((p) => p !== path);
  });
  s.setDeskBasePath = vi.fn((path: string) => { mockState.deskBasePath = path; });
  s.setDeskCurrentPath = vi.fn((path: string) => { mockState.deskCurrentPath = path; });
  s.setDeskFiles = vi.fn((files: unknown[]) => { mockState.deskFiles = files; });
  s.setDeskJianContent = vi.fn((content: string | null) => { mockState.deskJianContent = content; });
  s.clearStaleMessageLocate = vi.fn();
  s.setSessionMetaRecovery = vi.fn((status: unknown) => { mockState.metaRecovery = status; });
}

import { hanaFetch } from '../../hooks/use-hana-fetch';
import { clearChat } from '../../stores/agent-actions';
import { loadDeskFiles } from '../../stores/desk-actions';
import { bumpMessageLiveVersion, clearMessageLiveVersion } from '../../stores/message-live-version';
import {
  archiveSession,
  completeSessionTodos,
  continueDeletedAgentSession,
  createNewSession,
  ensureSession,
  loadMessages,
  loadSessions,
  pendingNewSessionIdentityPatch,
  pinSession,
  reconcileCurrentSessionMessages,
  refreshSessionCapabilities,
  switchSession,
  upsertOptimisticSessionFirstMessage,
} from '../../stores/session-actions';
import { snapshotStreamBuffer } from '../../stores/stream-invalidator';

const mockFetch = vi.mocked(hanaFetch);
const mockClearChat = vi.mocked(clearChat);
const mockLoadDeskFiles = vi.mocked(loadDeskFiles);
const mockSnapshot = vi.mocked(snapshotStreamBuffer);

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

function mockPermissionDefault(mode = 'ask') {
  mockFetch.mockResolvedValueOnce(jsonResponse({ permissionMode: mode }));
}

  describe('session-actions', () => {
  beforeEach(() => {
    Object.keys(mockState).forEach(k => delete mockState[k]);
    Object.assign(mockState, initialStateFactory());
    Object.assign(mockState, { workspaceDeskStateByRoot: {} as Record<string, unknown> });
    (globalThis.window as unknown as { hana?: unknown }).hana = {};
    installStoreMethods();
    mockFetch.mockReset();
    mockClearChat.mockReset();
    mockLoadDeskFiles.mockReset();
    streamResumeMocks.requestStreamResume.mockReset();
    deskActionMocks.activateWorkspaceDesk.mockReset();
    deskActionMocks.activateWorkspaceDesk.mockImplementation(async (root?: string | null, options?: { mountId?: string | null; label?: string | null }) => {
      const mountId = options?.mountId || null;
      const normalized = mountId ? `studio:${mountId}` : (root || '');
      const currentRoot = (mockState.deskWorkspaceMountId as string | null)
        ? `studio:${mockState.deskWorkspaceMountId as string}`
        : ((mockState.deskBasePath as string) || '');
      const states = mockState.workspaceDeskStateByRoot as Record<string, any>;
      if (currentRoot) {
        states[currentRoot] = {
          deskCurrentPath: (mockState.deskCurrentPath as string) || '',
          deskFiles: mockState.deskFiles,
          deskJianContent: mockState.deskJianContent,
          cwdSkills: [],
          cwdSkillsOpen: false,
          previewOpen: false,
          openTabs: [],
          activeTabId: null,
        };
      }
      if (!normalized) {
        mockState.deskBasePath = '';
        mockState.deskWorkspaceMountId = null;
        mockState.deskWorkspaceLabel = null;
        mockState.deskCurrentPath = '';
        mockState.deskFiles = [];
        mockState.deskJianContent = null;
        return;
      }
      const saved = states[normalized] || null;
      const nextSubdir = currentRoot === normalized
        ? ((mockState.deskCurrentPath as string) || '')
        : (saved?.deskCurrentPath || '');
      mockState.deskBasePath = normalized;
      mockState.deskWorkspaceMountId = mountId;
      mockState.deskWorkspaceLabel = options?.label || null;
      mockState.deskCurrentPath = nextSubdir;
      mockState.deskFiles = [];
      mockState.deskJianContent = null;
      deskActionMocks.loadDeskFiles(nextSubdir, mountId ? null : normalized, mountId);
    });
    mockSnapshot.mockReset();
    mockSnapshot.mockReturnValue(null);
    clearMessageLiveVersion();
    dispatchedEvents.length = 0;
  });

  it('opens deleted-agent sessions as read-only history without calling the runtime switch route', async () => {
    const deletedPath = '/tmp/agents/deleted/sessions/old.jsonl';
    Object.assign(mockState, {
      currentSessionPath: null,
      currentSessionId: 'sess_previous',
      sessions: [{
        path: deletedPath,
        sessionId: 'sess_deleted_history',
        agentDeleted: true,
        agentId: 'deleted',
        agentName: 'Deleted',
        cwd: '/tmp/work',
      }],
      chatSessions: {},
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).startsWith('/api/sessions/messages')) {
        return jsonResponse({ messages: [{ role: 'user', content: 'old hello' }], blocks: [], todos: [], hasMore: false });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await switchSession(deletedPath);

    expect(mockFetch).not.toHaveBeenCalledWith('/api/sessions/switch', expect.anything());
    expect(mockState.currentSessionPath).toBe(deletedPath);
    expect(mockState.currentSessionId).toBe('sess_deleted_history');
    expect(mockState.sessionLocatorsById).toMatchObject({
      sess_deleted_history: { path: deletedPath },
    });
    expect(mockState.pendingSessionSwitchPath).toBeNull();
    expect(mockState.pendingNewSession).toBe(false);
    expect(mockState.currentAgentId).toBeNull();
    expect(deskActionMocks.activateWorkspaceDesk).toHaveBeenCalledWith('/tmp/work', { mountId: null, label: null });
    expect((mockState.chatSessions as Record<string, any>)[deletedPath].items).toHaveLength(1);
  });

  it('completes current session todos through the explicit cleanup route', async () => {
    const sessionPath = '/session/todo-cleanup.jsonl';
    mockFetch.mockResolvedValue(jsonResponse({ ok: true, todos: [] }));

    const ok = await completeSessionTodos(sessionPath);

    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('/api/sessions/todos/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: sessionPath }),
    });
    expect(mockState.setSessionTodosForPath).toHaveBeenCalledWith(sessionPath, []);
    expect(mockState.bumpTodosLiveVersion).toHaveBeenCalledWith(sessionPath);
  });

  it('does not complete session todos while that session is streaming', async () => {
    const sessionPath = '/session/streaming.jsonl';
    Object.assign(mockState, {
      streamingSessions: [sessionPath],
    });

    const ok = await completeSessionTodos(sessionPath);

    expect(ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('clears unread output marker when switching into a normal session', async () => {
    Object.assign(mockState, {
      currentSessionPath: '/session/current.jsonl',
      unreadOutputSessionPaths: ['/session/next.jsonl', '/session/other.jsonl'],
      sessions: [{ path: '/session/next.jsonl', sessionId: 'sess_next', cwd: '/tmp/work' }],
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/sessions/switch') {
        return jsonResponse({
          ok: true,
          path: '/session/next.jsonl',
          sessionId: 'sess_next',
          cwd: '/tmp/work',
          workspaceFolders: [],
          memoryEnabled: true,
          permissionMode: 'ask',
          accessMode: 'ask',
        });
      }
      if (String(url).startsWith('/api/sessions/messages')) {
        return jsonResponse({ messages: [], blocks: [], todos: [], hasMore: false });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await switchSession('/session/next.jsonl');

    expect(mockFetch).toHaveBeenCalledWith('/api/sessions/switch', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        path: '/session/next.jsonl',
        sessionId: 'sess_next',
        currentSessionPath: '/session/current.jsonl',
      }),
    }));
    expect(mockState.unreadOutputSessionPaths).toEqual(['/session/other.jsonl']);
    expect(mockState.currentSessionId).toBe('sess_next');
    expect(mockState.sessionLocatorsById).toMatchObject({ sess_next: { path: '/session/next.jsonl' } });
  });

  it('clears unread output marker when switching into a deleted-agent history session', async () => {
    const deletedPath = '/tmp/agents/deleted/sessions/unread.jsonl';
    Object.assign(mockState, {
      currentSessionPath: '/session/current.jsonl',
      currentSessionId: 'sess_current_should_clear',
      unreadOutputSessionPaths: [deletedPath, '/session/other.jsonl'],
      sessions: [{
        path: deletedPath,
        agentDeleted: true,
        agentId: 'deleted',
        agentName: 'Deleted',
        cwd: '/tmp/work',
      }],
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).startsWith('/api/sessions/messages')) {
        return jsonResponse({ messages: [], blocks: [], todos: [], hasMore: false });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await switchSession(deletedPath);

    expect(mockState.unreadOutputSessionPaths).toEqual(['/session/other.jsonl']);
    expect(mockState.currentSessionId).toBeNull();
  });

  it('continues a deleted-agent session by creating and switching to the returned primary-agent session', async () => {
    const oldPath = '/tmp/agents/deleted/sessions/old.jsonl';
    const newPath = '/tmp/agents/hana/sessions/new.jsonl';
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/sessions/continue-deleted-agent') {
        return jsonResponse({ ok: true, path: newPath, agentId: 'hana', agentName: 'Hana' });
      }
      if (url === '/api/sessions') {
        return jsonResponse([{ path: newPath, agentId: 'hana', agentName: 'Hana', cwd: '/tmp/work' }]);
      }
      if (url === '/api/sessions/switch') {
        return jsonResponse({
          ok: true,
          agentId: 'hana',
          agentName: 'Hana',
          cwd: '/tmp/work',
          workspaceFolders: [],
          memoryEnabled: true,
          permissionMode: 'ask',
          accessMode: 'ask',
        });
      }
      if (String(url).startsWith('/api/sessions/messages')) {
        return jsonResponse({ messages: [], blocks: [], todos: [], hasMore: false });
      }
      if (String(url).startsWith('/api/models')) return jsonResponse({});
      throw new Error(`unexpected fetch: ${url}`);
    });

    const ok = await continueDeletedAgentSession(oldPath);

    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('/api/sessions/continue-deleted-agent', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ path: oldPath }),
    }));
    expect(mockState.currentSessionPath).toBe(newPath);
  });

  it('warns when a deleted-agent continuation succeeds without fresh compaction', async () => {
    const oldPath = '/tmp/agents/deleted/sessions/old.jsonl';
    const newPath = '/tmp/agents/hana/sessions/new.jsonl';
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/sessions/continue-deleted-agent') {
        return jsonResponse({
          ok: true,
          path: newPath,
          agentId: 'hana',
          agentName: 'Hana',
          compacted: false,
          compactionError: 'model unavailable',
        });
      }
      if (url === '/api/sessions') {
        return jsonResponse([{ path: newPath, agentId: 'hana', agentName: 'Hana', cwd: '/tmp/work' }]);
      }
      if (url === '/api/sessions/switch') {
        return jsonResponse({
          ok: true,
          agentId: 'hana',
          agentName: 'Hana',
          cwd: '/tmp/work',
          workspaceFolders: [],
          memoryEnabled: true,
          permissionMode: 'ask',
          accessMode: 'ask',
        });
      }
      if (String(url).startsWith('/api/sessions/messages')) {
        return jsonResponse({ messages: [], blocks: [], todos: [], hasMore: false });
      }
      if (String(url).startsWith('/api/models')) return jsonResponse({});
      throw new Error(`unexpected fetch: ${url}`);
    });

    const ok = await continueDeletedAgentSession(oldPath);

    expect(ok).toBe(true);
    expect(mockState.addToast).toHaveBeenCalledWith(
      expect.stringContaining('model unavailable'),
      'warning',
      6000,
    );
    expect(mockState.currentSessionPath).toBe(newPath);
  });

  describe('pendingNewSessionIdentityPatch (#2101)', () => {
    it('returns a patch with pendingNewSession true and a non-empty pendingDraftId', () => {
      const patch = pendingNewSessionIdentityPatch();
      expect(patch.pendingNewSession).toBe(true);
      expect(typeof patch.pendingDraftId).toBe('string');
      expect(patch.pendingDraftId.length).toBeGreaterThan(0);
    });

    it('generates a distinct pendingDraftId on every call', () => {
      const first = pendingNewSessionIdentityPatch();
      const second = pendingNewSessionIdentityPatch();
      expect(first.pendingDraftId).not.toBe(second.pendingDraftId);
    });
  });

  describe('createNewSession cwd draft', () => {
    it('resets a global new-session draft to the primary agent and its effective workspace', async () => {
      (mockState as Record<string, unknown>).agents = [
        {
          id: 'hana',
          name: 'Hana',
          isPrimary: true,
          homeFolder: '/workspace/Primary',
          effectiveHomeFolder: '/workspace/Primary',
        },
        {
          id: 'mio',
          name: 'Mio',
          isPrimary: false,
          homeFolder: '/workspace/Mio',
          effectiveHomeFolder: '/workspace/Mio',
        },
      ];
      (mockState as Record<string, unknown>).currentAgentId = 'mio';
      (mockState as Record<string, unknown>).deskBasePath = '/workspace/Desktop';
      (mockState as Record<string, unknown>).deskCurrentPath = 'old/subdir';
      (mockState as Record<string, unknown>).deskFiles = [{ name: 'stale.md' }];
      (mockState as Record<string, unknown>).deskJianContent = 'stale';
      (mockState as Record<string, unknown>).homeFolder = '/workspace/Mio';
      mockPermissionDefault();

      await createNewSession();

      expect(mockState.selectedAgentId).toBe('hana');
      expect(mockState.selectedFolder).toBe('/workspace/Primary');
      expect(mockState.pendingNewSession).toBe(true);
      expect(mockState.deskBasePath).toBe('/workspace/Primary');
      expect(mockState.deskCurrentPath).toBe('');
      expect(mockState.deskFiles).toEqual([]);
      expect(mockState.deskJianContent).toBeNull();
      expect(mockLoadDeskFiles).toHaveBeenCalledWith('', '/workspace/Primary', null);
    });

    it('uses the primary agent effective default workspace instead of the active session cwd', async () => {
      (mockState as Record<string, unknown>).agents = [
        {
          id: 'hana',
          name: 'Hana',
          isPrimary: true,
          homeFolder: null,
          effectiveHomeFolder: '/home/test/Desktop/OH-WorkSpace',
        },
        {
          id: 'mio',
          name: 'Mio',
          isPrimary: false,
          homeFolder: null,
          effectiveHomeFolder: '/home/test/Desktop/OH-WorkSpace',
        },
      ];
      (mockState as Record<string, unknown>).currentAgentId = 'mio';
      (mockState as Record<string, unknown>).homeFolder = null;
      (mockState as Record<string, unknown>).deskBasePath = '/workspace/current-session';
      (mockState as Record<string, unknown>).deskCurrentPath = 'notes';
      (mockState as Record<string, unknown>).deskFiles = [{ name: 'stale.md' }];
      mockPermissionDefault();

      await createNewSession();

      expect(mockState.selectedAgentId).toBe('hana');
      expect(mockState.selectedFolder).toBe('/home/test/Desktop/OH-WorkSpace');
      expect(mockState.deskBasePath).toBe('/home/test/Desktop/OH-WorkSpace');
      expect(mockState.deskCurrentPath).toBe('');
      expect(mockLoadDeskFiles).toHaveBeenCalledWith('', '/home/test/Desktop/OH-WorkSpace', null);
    });

    it('invalidates an in-flight session switch so the new-session desk stays on the agent home folder', async () => {
      (mockState as Record<string, unknown>).currentSessionPath = '/session/hana.jsonl';
      (mockState as Record<string, unknown>).deskBasePath = '/workspace/Desktop/project-hana';
      (mockState as Record<string, unknown>).homeFolder = '/workspace/Desktop/project-hana';

      let resolveSwitch!: (r: Response) => void;
      const switchResponse = new Promise<Response>(resolve => { resolveSwitch = resolve; });
      mockFetch.mockImplementationOnce(() => switchResponse);
      mockPermissionDefault();

      const switching = switchSession('/session/desktop.jsonl');
      await createNewSession();

      resolveSwitch(jsonResponse({
        ok: true,
        path: '/session/desktop.jsonl',
        cwd: '/workspace/Desktop',
        workspaceFolders: [],
      }));
      await switching;

      expect(mockState.currentSessionPath).toBeNull();
      expect(mockState.pendingNewSession).toBe(true);
      expect(mockState.selectedFolder).toBe('/workspace/Desktop/project-hana');
      expect(mockState.deskBasePath).toBe('/workspace/Desktop/project-hana');
      expect(deskActionMocks.activateWorkspaceDesk).not.toHaveBeenCalledWith('/workspace/Desktop');
    });

    it('uses the runtime new-session permission default instead of the old active session mode', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        permissionMode: 'read_only',
      }));

      await createNewSession();

      const permissionEvent = dispatchedEvents.filter(e => e.type === 'hana-plan-mode').at(-1);
      expect(permissionEvent?.detail).toEqual({ enabled: true, mode: 'read_only' });
      expect(mockState.sessionPermissionMode).toBe('read_only');
      expect(mockState.pendingNewSessionPermissionMode).toBe('read_only');
    });

    it('initializes pending new-session thinking from the server default', async () => {
      (mockState as Record<string, unknown>).thinkingLevel = 'high';
      mockFetch.mockImplementation(async (url: string) => {
        if (url === '/api/preferences/session-permission-default') {
          return jsonResponse({ permissionMode: 'ask' });
        }
        if (url === '/api/session-thinking-level?pendingNewSession=1') {
          return jsonResponse({ thinkingLevel: 'medium' });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      await createNewSession();

      expect(mockFetch).toHaveBeenCalledWith('/api/session-thinking-level?pendingNewSession=1');
      expect(mockState.thinkingLevel).toBe('medium');
      expect(mockState.pendingNewSessionThinkingLevel).toBe('medium');
    });

    it('does not restore focus when a stale new-session continuation is no longer pending', async () => {
      let resolveDesk!: () => void;
      deskActionMocks.activateWorkspaceDesk.mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveDesk = resolve;
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        permissionMode: 'ask',
      }));

      const creating = createNewSession();
      Object.assign(mockState, {
        pendingNewSession: false,
        currentSessionPath: '/session/existing.jsonl',
        pendingSessionSwitchPath: null,
      });
      resolveDesk();
      await creating;

      expect((mockState as unknown as { requestInputFocus: ReturnType<typeof vi.fn> }).requestInputFocus)
        .not.toHaveBeenCalled();
    });

    it('sends extra workspace folders when creating a pending session', async () => {
      Object.assign(mockState, {
        pendingNewSession: true,
        pendingDraftId: 'draft-workspace-a',
        currentAgentId: 'hana',
        memoryEnabled: true,
        selectedFolder: '/workspace-a',
        workspaceFolders: ['/reference-a'],
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        ok: true,
        path: '/session/new.jsonl',
        sessionId: 'sess_workspace_a',
        agentId: 'hana',
        cwd: '/workspace-a',
        workspaceFolders: ['/reference-a'],
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        ok: true,
        sessionId: 'sess_workspace_a',
        agentId: 'hana',
        cwd: '/workspace-a',
        workspaceFolders: ['/reference-a'],
      }));

      await expect(ensureSession()).resolves.toMatchObject({ sessionId: 'sess_workspace_a', sessionPath: '/session/new.jsonl' });

      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        '/api/sessions/new-detached',
        expect.objectContaining({
          body: JSON.stringify({
            memoryEnabled: true,
            recordWorkspaceHistory: true,
            cwd: '/workspace-a',
            workspaceFolders: ['/reference-a'],
            currentSessionPath: null,
          }),
        }),
      );
      expect(mockState.workspaceFolders).toEqual(['/reference-a']);
      // 首页草稿在 session 创建成功时被消费（HOME_DRAFT_KEY 契约）
      expect((mockState as unknown as { clearDraft: ReturnType<typeof vi.fn> }).clearDraft)
        .toHaveBeenCalledWith('__home__');
    });

    it('consumes home draft on activation without copying text into the new session draft', async () => {
      const homeDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '晚上好啊' }] }] };
      Object.assign(mockState, {
        pendingNewSession: true,
        pendingDraftId: 'draft-home-consume',
        currentAgentId: 'hana',
        memoryEnabled: true,
        selectedFolder: '/workspace-home',
        drafts: { __home__: '晚上好啊' },
        draftDocs: { __home__: homeDoc },
        attachedFiles: [{
          fileId: 'sf_home',
          path: '/tmp/hana/session-files/home.png',
          name: 'home.png',
          isDirectory: false,
        }],
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        ok: true,
        path: '/session/home-consume.jsonl',
        sessionId: 'sess_home_consume',
        agentId: 'hana',
        cwd: '/workspace-home',
        workspaceFolders: [],
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        ok: true,
        sessionId: 'sess_home_consume',
        agentId: 'hana',
        cwd: '/workspace-home',
        workspaceFolders: [],
      }));

      await expect(ensureSession()).resolves.toMatchObject({
        sessionId: 'sess_home_consume',
        sessionPath: '/session/home-consume.jsonl',
      });

      expect((mockState as unknown as { clearDraft: ReturnType<typeof vi.fn> }).clearDraft)
        .toHaveBeenCalledWith('__home__');
      const drafts = mockState.drafts as Record<string, string>;
      const draftDocs = mockState.draftDocs as Record<string, unknown>;
      expect(drafts.sess_home_consume).toBeUndefined();
      expect(drafts['/session/home-consume.jsonl']).toBeUndefined();
      expect(draftDocs.sess_home_consume).toBeUndefined();
      expect(draftDocs['/session/home-consume.jsonl']).toBeUndefined();
      expect((mockState.attachedFilesBySession as Record<string, unknown[]>).sess_home_consume)
        .toEqual([{
          fileId: 'sf_home',
          path: '/tmp/hana/session-files/home.png',
          name: 'home.png',
          isDirectory: false,
        }]);
    });

    it('enters a pending draft without posting a new-session request', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url === '/api/preferences/session-permission-default') {
          return jsonResponse({ permissionMode: 'ask' });
        }
        if (url === '/api/session-thinking-level?pendingNewSession=1') {
          return jsonResponse({ thinkingLevel: 'medium' });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      await createNewSession();

      expect(mockState.pendingNewSession).toBe(true);
      expect(mockState.currentSessionPath).toBeNull();
      expect(mockFetch.mock.calls.some(([url]) => url === '/api/sessions/new-detached')).toBe(false);
    });

    it('posts one new-session request at send time using the current pending draft', async () => {
      Object.assign(mockState, {
        pendingNewSession: true,
        pendingDraftId: 'draft-workspace-b',
        currentAgentId: 'hana',
        memoryEnabled: true,
        selectedFolder: '/workspace-b',
        serverPort: '62950',
      });

      const createBodies: unknown[] = [];
      mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
        if (url === '/api/sessions/new-detached') {
          createBodies.push(JSON.parse(String(opts?.body)));
          return jsonResponse({
            ok: true,
            path: '/session/fresh.jsonl',
            sessionId: 'sess_fresh',
            agentId: 'hana',
            cwd: '/workspace-b',
            workspaceFolders: [],
          });
        }
        if (url === '/api/sessions/switch') {
          return jsonResponse({ ok: true, sessionId: 'sess_fresh', agentId: 'hana', workspaceFolders: [] });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      await expect(ensureSession()).resolves.toMatchObject({ sessionId: 'sess_fresh', sessionPath: '/session/fresh.jsonl' });

      expect(createBodies).toEqual([{
        memoryEnabled: true,
        recordWorkspaceHistory: true,
        cwd: '/workspace-b',
        currentSessionPath: null,
      }]);
      expect(mockFetch.mock.calls.filter(([url]) => url === '/api/sessions/new-detached')).toHaveLength(1);
      expect(mockState.currentSessionPath).toBe('/session/fresh.jsonl');
      expect(mockState.currentSessionId).toBe('sess_fresh');
      expect((mockState.chatSessions as Record<string, unknown>)['/session/fresh.jsonl']).toBeTruthy();
    });

    it('does not let a late detached create response activate a replacement pending draft (#2078 ABA)', async () => {
      Object.assign(mockState, {
        pendingNewSession: true,
        pendingDraftId: 'draft-a',
        currentAgentId: 'hana',
        memoryEnabled: true,
        selectedFolder: '/workspace-a',
      });
      let resolveCreate!: (response: Response) => void;
      mockFetch.mockImplementation((url: string) => {
        if (url !== '/api/sessions/new-detached') throw new Error(`unexpected fetch: ${url}`);
        return new Promise<Response>((resolve) => { resolveCreate = resolve; });
      });

      const creating = ensureSession('draft-a');
      Object.assign(mockState, {
        pendingNewSession: true,
        pendingDraftId: 'draft-b',
        selectedFolder: '/workspace-b',
      });
      resolveCreate(jsonResponse({
        ok: true,
        path: '/session/a.jsonl',
        sessionId: 'sess_a',
        agentId: 'hana',
      }));

      const ref = await creating;
      expect(ref).toEqual({ sessionId: 'sess_a', sessionPath: '/session/a.jsonl', agentId: 'hana' });
      expect(Object.isFrozen(ref)).toBe(true);
      expect(mockState.pendingDraftId).toBe('draft-b');
      expect(mockState.currentSessionPath).toBeNull();
      expect(mockFetch.mock.calls.some(([url]) => url === '/api/sessions/switch')).toBe(false);
    });

    it('sends workspaceMountId instead of cwd when the pending session selects a Studio workspace', async () => {
      Object.assign(mockState, {
        pendingNewSession: true,
        pendingDraftId: 'draft-mount',
        currentAgentId: 'hana',
        memoryEnabled: true,
        selectedFolder: null,
        selectedWorkspaceMountId: 'mount_docs',
        selectedWorkspaceLabel: 'Docs',
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        ok: true,
        path: '/session/new.jsonl',
        sessionId: 'sess_mount',
        agentId: 'hana',
        cwd: '/server/docs',
        workspaceMountId: 'mount_docs',
        workspaceLabel: 'Docs',
        workspaceFolders: [],
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        ok: true,
        sessionId: 'sess_mount',
        agentId: 'hana',
        cwd: '/server/docs',
        workspaceMountId: 'mount_docs',
        workspaceLabel: 'Docs',
        workspaceFolders: [],
      }));

      await expect(ensureSession()).resolves.toMatchObject({ sessionId: 'sess_mount' });

      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        '/api/sessions/new-detached',
        expect.objectContaining({
          body: JSON.stringify({
            memoryEnabled: true,
            recordWorkspaceHistory: true,
            workspaceMountId: 'mount_docs',
            currentSessionPath: null,
          }),
        }),
      );
      expect(deskActionMocks.activateWorkspaceDesk).toHaveBeenCalledWith('/server/docs', {
        mountId: 'mount_docs',
        label: 'Docs',
      });
      expect(mockState.selectedWorkspaceMountId).toBeNull();
    });

    it('carries the pending new-session thinking draft into session creation', async () => {
      Object.assign(mockState, {
        pendingNewSession: true,
        pendingDraftId: 'draft-thinking',
        currentAgentId: 'hana',
        memoryEnabled: true,
        selectedFolder: '/workspace-a',
        pendingNewSessionThinkingLevel: 'high',
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        ok: true,
        path: '/session/new.jsonl',
        sessionId: 'sess_thinking',
        agentId: 'hana',
        cwd: '/workspace-a',
        workspaceFolders: [],
        thinkingLevel: 'high',
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        ok: true,
        sessionId: 'sess_thinking',
        agentId: 'hana',
        cwd: '/workspace-a',
        workspaceFolders: [],
        thinkingLevel: 'high',
      }));

      await expect(ensureSession()).resolves.toMatchObject({ sessionId: 'sess_thinking' });

      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        '/api/sessions/new-detached',
        expect.objectContaining({
          body: JSON.stringify({
            memoryEnabled: true,
            recordWorkspaceHistory: true,
            cwd: '/workspace-a',
            thinkingLevel: 'high',
            currentSessionPath: null,
          }),
        }),
      );
      expect(mockState.pendingNewSessionThinkingLevel).toBeNull();
      expect(mockState.thinkingLevel).toBe('high');
    });

    it('carries the pending new-session permission draft into session creation', async () => {
      Object.assign(mockState, {
        pendingNewSession: true,
        pendingDraftId: 'draft-permission',
        currentAgentId: 'hana',
        memoryEnabled: true,
        selectedFolder: '/workspace-a',
        pendingNewSessionPermissionMode: 'auto',
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        ok: true,
        path: '/session/new.jsonl',
        sessionId: 'sess_permission',
        agentId: 'hana',
        cwd: '/workspace-a',
        workspaceFolders: [],
        permissionMode: 'auto',
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        ok: true,
        sessionId: 'sess_permission',
        agentId: 'hana',
        cwd: '/workspace-a',
        workspaceFolders: [],
        permissionMode: 'auto',
      }));

      await expect(ensureSession()).resolves.toMatchObject({ sessionId: 'sess_permission' });

      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        '/api/sessions/new-detached',
        expect.objectContaining({
          body: JSON.stringify({
            memoryEnabled: true,
            recordWorkspaceHistory: true,
            cwd: '/workspace-a',
            permissionMode: 'auto',
            currentSessionPath: null,
          }),
        }),
      );
      expect(mockState.pendingNewSessionPermissionMode).toBeNull();
      expect(mockState.sessionPermissionMode).toBe('auto');
    });

    it('carries an explicit project id from the new-session draft into session creation', async () => {
      Object.assign(mockState, {
        agents: [
          {
            id: 'hana',
            name: 'Hana',
            isPrimary: true,
            homeFolder: '/workspace/primary',
            effectiveHomeFolder: '/workspace/primary',
          },
          {
            id: 'mio',
            name: 'Mio',
            isPrimary: false,
            homeFolder: '/workspace/mio',
            effectiveHomeFolder: '/workspace/mio',
          },
        ],
        currentAgentId: 'mio',
        homeFolder: '/workspace/mio',
        deskBasePath: '/workspace/mio-session',
      });
      mockPermissionDefault();

      await createNewSession({ projectId: 'project-hana', cwd: '/workspace/project-hana' });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        ok: true,
        path: '/session/new.jsonl',
        sessionId: 'sess_project',
        agentId: 'hana',
        cwd: '/workspace/project-hana',
        projectId: 'project-hana',
        workspaceFolders: [],
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await expect(ensureSession()).resolves.toMatchObject({ sessionId: 'sess_project' });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/sessions/new-detached',
        expect.objectContaining({
          body: JSON.stringify({
            memoryEnabled: true,
            recordWorkspaceHistory: true,
            cwd: '/workspace/project-hana',
            projectId: 'project-hana',
            permissionMode: 'ask',
            agentId: 'hana',
            currentSessionPath: null,
          }),
        }),
      );
      expect(mockState.pendingProjectId).toBeNull();
    });

    it('surfaces the server error when pending session creation fails', async () => {
      const copy: Record<string, string> = {
        'session.createFailed': 'Create session failed',
        'error.code.unexpected': 'Something went wrong',
      };
      (globalThis.window as unknown as { t: (key: string) => string }).t = (key: string) => copy[key] ?? key;
      Object.assign(mockState, {
        pendingNewSession: true,
        pendingDraftId: 'draft-error',
        memoryEnabled: true,
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'session skill snapshot failed' }, false));

      await expect(ensureSession()).resolves.toBeNull();

      expect(mockState.inlineErrors).toMatchObject({
        '': {
          text: 'Create session failed: Something went wrong',
          detail: 'session skill snapshot failed',
          code: null,
        },
      });
      expect(mockState.addToast).toHaveBeenCalledWith(
        'Create session failed: Something went wrong',
        'error',
        6000,
        undefined,
      );
      expect(mockState.pendingNewSession).toBe(true);
    });

    it('新建失败带错误码时说人话，原始英文留在详情区', async () => {
      const copy: Record<string, string> = {
        'session.createFailed': 'Create session failed',
        'error.code.unexpected': 'Something went wrong',
        'error.code.noAvailableModel': '当前没有可用的对话模型',
      };
      (globalThis.window as unknown as { t: (key: string) => string }).t = (key: string) => copy[key] ?? key;
      Object.assign(mockState, {
        pendingNewSession: true,
        pendingDraftId: 'draft-coded',
        memoryEnabled: true,
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        error: 'no available model',
        code: 'no_available_model',
      }, false));

      await expect(ensureSession()).resolves.toBeNull();

      expect(mockState.inlineErrors).toMatchObject({
        '': {
          text: 'Create session failed: 当前没有可用的对话模型',
          detail: 'no available model',
          code: 'no_available_model',
        },
      });
    });

    it('新建失败走顶层 onError 的嵌套形状时，仍读得出 code 和 message', async () => {
      const copy: Record<string, string> = {
        'session.createFailed': 'Create session failed',
        'error.code.unexpected': 'Something went wrong',
        'error.code.sessionManifestUnavailable': '会话索引暂时不可用，请稍后重试',
      };
      (globalThis.window as unknown as { t: (key: string) => string }).t = (key: string) => copy[key] ?? key;
      Object.assign(mockState, {
        pendingNewSession: true,
        pendingDraftId: 'draft-nested',
        memoryEnabled: true,
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        error: { code: 'session_manifest_unavailable', message: 'session index is rebuilding', traceId: 't-1' },
      }, false));

      await expect(ensureSession()).resolves.toBeNull();

      expect(mockState.inlineErrors).toMatchObject({
        '': {
          text: 'Create session failed: 会话索引暂时不可用，请稍后重试',
          detail: 'session index is rebuilding',
          code: 'session_manifest_unavailable',
        },
      });
    });
  });

  describe('loadMessages 竞态护栏', () => {
    it('stale 响应不覆盖新状态：v1 fetch 在飞，v2 bump 后到达时丢弃 v1', async () => {
      // 两次 fetch：第一次慢，第二次快。第一次返回的 messages 必须被丢弃。
      let resolveFirst!: (r: Response) => void;
      const firstPromise = new Promise<Response>(r => { resolveFirst = r; });
      mockFetch.mockImplementationOnce(() => firstPromise);
      mockFetch.mockImplementationOnce(async () =>
        jsonResponse({
          messages: [{ text: 'new' }], blocks: [], todos: [], hasMore: false,
          sessionFiles: [{ fileId: 'sf_new', filePath: '/tmp/new.md' }],
        }),
      );

      const p1 = loadMessages('/a');
      const p2 = loadMessages('/a');
      await p2;
      // v1 的响应后到；此时 _loadMessagesVersion['/a'] === 2，应被判为 stale
      resolveFirst(jsonResponse({
        messages: [{ text: 'stale' }], blocks: [], todos: [], hasMore: false,
        sessionFiles: [{ fileId: 'sf_stale', filePath: '/tmp/stale.md' }],
      }));
      await p1;

      const chat = mockState.chatSessions as Record<string, { items: Array<{ data: { text: string } }> }>;
      expect(chat['/a']).toBeDefined();
      // 最新的 v2 结果取胜
      expect(chat['/a'].items).toHaveLength(1);
      expect(chat['/a'].items[0].data.text).toBe('new');
      // v1（stale）不应写入 SessionFile registry；v2 的结果保留
      expect((mockState.sessionRegistryFilesByPath as Record<string, unknown>)['/a']).toEqual([
        { fileId: 'sf_new', filePath: '/tmp/new.md' },
      ]);
    });

    it('正常单次调用写入 initSession', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'hello' }],
        blocks: [],
        todos: [],
        sessionFiles: [{ fileId: 'sf_write', filePath: '/workspace/draft.md' }],
        hasMore: false,
      }));
      await loadMessages('/a');
      const initSession = (mockState as unknown as { initSession: ReturnType<typeof vi.fn> }).initSession;
      expect(initSession).toHaveBeenCalledTimes(1);
      expect((mockState.sessionRegistryFilesByPath as Record<string, unknown>)['/a'])
        .toEqual([{ fileId: 'sf_write', filePath: '/workspace/draft.md' }]);
    });

    it('主 bug 回归（#2188）：mid-flight 收到 live message 更新时，跳过 messages hydrate 但仍写入 SessionFile registry', async () => {
      let resolveFetch!: (r: Response) => void;
      const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
      mockFetch.mockImplementationOnce(() => pending);

      const task = loadMessages('/a');
      bumpMessageLiveVersion('/a');
      resolveFetch(jsonResponse({
        messages: [{ text: 'stale' }], blocks: [], todos: [], hasMore: false,
        sessionFiles: [{ fileId: 'sf_live', filePath: '/tmp/live.md' }],
      }));
      await task;

      const initSession = (mockState as unknown as { initSession: ReturnType<typeof vi.fn> }).initSession;
      expect(initSession).not.toHaveBeenCalled();
      // messages/todos hydrate 被放弃，但 SessionFile registry 必须仍然写入
      // （否则远程 WebUI 的文件面板永远空 — #2188 根因）。
      expect((mockState.sessionRegistryFilesByPath as Record<string, unknown>)['/a']).toEqual([
        { fileId: 'sf_live', filePath: '/tmp/live.md' },
      ]);
    });

    it('mid-flight 期间收到 upsert：hydrate 后 registry 为快照与重放增量合并（重放后写胜）', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'hello' }], blocks: [], todos: [], hasMore: false,
        sessionFiles: [{ fileId: 'sf_snapshot', filePath: '/tmp/snapshot.md' }],
      }));

      const task = loadMessages('/a');
      // mid-flight：真实链路里这是 WS tool_end / content_block file 触发的 upsert
      (mockState as unknown as { upsertSessionRegistryFile: (path: string, f: Record<string, unknown>) => void })
        .upsertSessionRegistryFile('/a', { fileId: 'sf_live', filePath: '/tmp/live.md' });
      await task;

      expect((mockState.sessionRegistryFilesByPath as Record<string, unknown>)['/a']).toEqual([
        { fileId: 'sf_snapshot', filePath: '/tmp/snapshot.md' },
        { fileId: 'sf_live', filePath: '/tmp/live.md' },
      ]);
    });

    it('mid-flight 期间收到 branch reset：hydrate 放弃旧快照，不覆盖 reset 后的权威 registry', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'hello' }], blocks: [], todos: [], hasMore: false,
        sessionFiles: [{ fileId: 'sf_snapshot', filePath: '/tmp/snapshot.md' }],
      }));

      const task = loadMessages('/a');
      // mid-flight：真实链路里这是 WS session_branch_reset 触发的 applyBranchResetSessionFiles
      (mockState as unknown as { applyBranchResetSessionFiles: (path: string, files: unknown[] | null) => void })
        .applyBranchResetSessionFiles('/a', [{ fileId: 'sf_post_reset', filePath: '/tmp/post.md' }]);
      await task;

      const setSessionRegistryFiles = (mockState as unknown as { setSessionRegistryFiles: ReturnType<typeof vi.fn> }).setSessionRegistryFiles;
      expect(setSessionRegistryFiles).not.toHaveBeenCalled();
      expect((mockState.sessionRegistryFilesByPath as Record<string, unknown>)['/a']).toEqual([
        { fileId: 'sf_post_reset', filePath: '/tmp/post.md' },
      ]);
    });

    it('stale 响应不会先把 todos 回滚到旧快照', async () => {
      let resolveFirst!: (r: Response) => void;
      const firstPromise = new Promise<Response>((resolve) => { resolveFirst = resolve; });
      mockFetch.mockImplementationOnce(() => firstPromise);
      mockFetch.mockImplementationOnce(async () =>
        jsonResponse({ messages: [{ text: 'new' }], blocks: [], todos: [{ id: 'todo-new' }], hasMore: false }),
      );

      const p1 = loadMessages('/a');
      const p2 = loadMessages('/a');
      await p2;

      resolveFirst(jsonResponse({
        messages: [{ text: 'stale' }],
        blocks: [],
        todos: [{ id: 'todo-stale' }],
        hasMore: false,
      }));
      await p1;

      expect((mockState.todosBySession as Record<string, unknown>)['/a']).toEqual([{ id: 'todo-new' }]);
    });

    it('mid-flight 收到 live todo 更新时，整次 hydrate 跳过，不只跳过 messages', async () => {
      let resolveFetch!: (r: Response) => void;
      const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
      mockFetch.mockImplementationOnce(() => pending);

      const task = loadMessages('/a');
      (mockState.todosLiveVersionBySession as Record<string, number>)['/a'] = 1;
      resolveFetch(jsonResponse({
        messages: [{ text: 'stale' }],
        blocks: [],
        todos: [{ id: 'todo-stale' }],
        hasMore: false,
      }));
      await task;

      const initSession = (mockState as unknown as { initSession: ReturnType<typeof vi.fn> }).initSession;
      const setSessionTodosForPath = (mockState as unknown as { setSessionTodosForPath: ReturnType<typeof vi.fn> }).setSessionTodosForPath;
      expect(initSession).not.toHaveBeenCalled();
      expect(setSessionTodosForPath).not.toHaveBeenCalled();
      expect((mockState.todosBySession as Record<string, unknown>)['/a']).toBeUndefined();
    });
  });

  describe('loadMessages 合并 in-flight snapshot', () => {
    it('buf 有 in-flight 内容时，initSession 后 append 一条 assistant', async () => {
      mockSnapshot.mockReturnValue({
        hasContent: true,
        messageId: 'stream-42',
        text: '正文',
        thinking: '',
        mood: 'Vibe: 好',
        moodYuan: 'hanako',
        inThinking: false,
        inMood: false,
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'u', role: 'user' }], blocks: [], todos: [], hasMore: false,
      }));
      await loadMessages('/a');

      const chat = mockState.chatSessions as Record<string, { items: Array<{ type: string; data: { id?: string; role?: string; blocks?: Array<{ type: string }> } }> }>;
      const items = chat['/a'].items;
      expect(items.length).toBe(2);
      expect(items[1].type).toBe('message');
      expect(items[1].data.id).toBe('stream-42');
      expect(items[1].data.role).toBe('assistant');
      const blocks = items[1].data.blocks!;
      expect(blocks.some(b => b.type === 'mood')).toBe(true);
      expect(blocks.some(b => b.type === 'text')).toBe(true);
    });

    it('buf 为空（snapshot=null）时不 append 额外消息', async () => {
      mockSnapshot.mockReturnValue(null);
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'u', role: 'user' }], blocks: [], todos: [], hasMore: false,
      }));
      await loadMessages('/a');

      const chat = mockState.chatSessions as Record<string, { items: unknown[] }>;
      expect(chat['/a'].items.length).toBe(1);
    });
  });

  describe('loadSessions 首次自动切换', () => {
    it('reconciles the focused locator by currentSessionId without switching or reloading chat', async () => {
      Object.assign(mockState, {
        currentSessionId: 'sess_a',
        currentSessionPath: '/session/old-a.jsonl',
        pendingNewSession: false,
        pendingSessionSwitchPath: null,
        sessions: [{ path: '/session/old-a.jsonl', sessionId: 'sess_a' }],
      });
      mockFetch.mockResolvedValueOnce(jsonResponse([
        { path: '/session/current-b.jsonl', sessionId: 'sess_a' },
      ]));

      await loadSessions();

      expect(mockState.currentSessionId).toBe('sess_a');
      expect(mockState.currentSessionPath).toBe('/session/current-b.jsonl');
      expect(mockState.sessionLocatorsById).toMatchObject({
        sess_a: { path: '/session/current-b.jsonl' },
      });
      // 只断言没有多打一次 /api/sessions（没有触发额外 reload）——loadSessions()
      // 并行探测 /api/health 是另一个调用，不属于本用例要锁的"没有多余重载"行为。
      expect(mockFetch.mock.calls.filter(([url]) => url === '/api/sessions')).toHaveLength(1);
    });

    it('uses reconciled state before deciding whether the first session needs auto-switching', async () => {
      Object.assign(mockState, {
        currentSessionId: 'sess_b',
        currentSessionPath: null,
        pendingNewSession: false,
        pendingSessionSwitchPath: null,
      });
      mockFetch.mockResolvedValueOnce(jsonResponse([
        { path: '/session/a.jsonl', sessionId: 'sess_a' },
        { path: '/session/b.jsonl', sessionId: 'sess_b' },
      ]));

      await loadSessions();

      expect(mockState.currentSessionId).toBe('sess_b');
      expect(mockState.currentSessionPath).toBe('/session/b.jsonl');
      expect(mockState.pendingSessionSwitchPath).toBeNull();
      // 只断言没有多打一次 /api/sessions（没有触发额外 reload）——loadSessions()
      // 并行探测 /api/health 是另一个调用，不属于本用例要锁的"没有多余重载"行为。
      expect(mockFetch.mock.calls.filter(([url]) => url === '/api/sessions')).toHaveLength(1);
    });

    it('does not infer focused identity from path when currentSessionId is absent', async () => {
      Object.assign(mockState, {
        currentSessionId: null,
        currentSessionPath: '/session/old-a.jsonl',
        sessions: [{ path: '/session/old-a.jsonl', sessionId: 'sess_a' }],
      });
      mockFetch.mockResolvedValueOnce(jsonResponse([
        { path: '/session/current-b.jsonl', sessionId: 'sess_a' },
      ]));

      await loadSessions();

      expect(mockState.currentSessionPath).toBe('/session/old-a.jsonl');
    });

    it('does not overwrite an in-flight navigation target while reconciling locators', async () => {
      Object.assign(mockState, {
        currentSessionId: 'sess_a',
        currentSessionPath: '/session/old-a.jsonl',
        pendingSessionSwitchPath: '/session/target.jsonl',
        sessions: [{ path: '/session/old-a.jsonl', sessionId: 'sess_a' }],
      });
      mockFetch.mockResolvedValueOnce(jsonResponse([
        { path: '/session/current-b.jsonl', sessionId: 'sess_a' },
      ]));

      await loadSessions();

      expect(mockState.currentSessionPath).toBe('/session/old-a.jsonl');
      expect(mockState.pendingSessionSwitchPath).toBe('/session/target.jsonl');
    });

    it('已有 pending session 导航意图时，不用列表第一项覆盖它', async () => {
      Object.assign(mockState, {
        currentSessionPath: null,
        pendingSessionSwitchPath: '/b',
        pendingNewSession: false,
      });
      mockFetch.mockResolvedValueOnce(jsonResponse([
        { path: '/a' },
        { path: '/b' },
      ]));

      await loadSessions();

      expect(mockState.sessions).toEqual([
        { path: '/a' },
        { path: '/b' },
      ]);
      expect(mockState.currentSessionPath).toBeNull();
      expect(mockState.pendingSessionSwitchPath).toBe('/b');
      // 只断言没有多打一次 /api/sessions（没有触发额外 reload）——loadSessions()
      // 并行探测 /api/health 是另一个调用，不属于本用例要锁的"没有多余重载"行为。
      expect(mockFetch.mock.calls.filter(([url]) => url === '/api/sessions')).toHaveLength(1);
    });

    it('keeps the first optimistic user message when the server list is still empty for that session', async () => {
      Object.assign(mockState, {
        currentSessionPath: '/session/new.jsonl',
        currentSessionId: 'sess_new',
        currentAgentId: 'hana',
        agentName: 'Hana',
        deskBasePath: '/workspace',
        sessions: [],
      });
      upsertOptimisticSessionFirstMessage(
        '/session/new.jsonl',
        '第一句话',
        '2026-07-06T01:02:03.000Z',
      );
      mockFetch.mockResolvedValueOnce(jsonResponse([
        {
          path: '/session/new.jsonl',
          sessionId: 'sess_new',
          title: null,
          firstMessage: '',
          modified: '2026-07-06T01:02:02.000Z',
          messageCount: 0,
          cwd: '/workspace',
          agentId: 'hana',
          agentName: 'Hana',
        },
      ]));

      await loadSessions();

      expect((mockState.sessions as any[])[0]).toMatchObject({
        path: '/session/new.jsonl',
        sessionId: 'sess_new',
        firstMessage: '第一句话',
        messageCount: 1,
        modified: '2026-07-06T01:02:03.000Z',
        _optimisticFirstMessage: true,
      });
    });

    it('does not replace a persisted first message when sending later messages', () => {
      Object.assign(mockState, {
        currentSessionPath: '/session/existing.jsonl',
        currentSessionId: 'sess_existing',
        sessions: [
          {
            path: '/session/existing.jsonl',
            sessionId: 'sess_existing',
            title: '正式标题',
            firstMessage: '第一句话',
            modified: '2026-07-06T01:02:03.000Z',
            messageCount: 3,
          },
        ],
      });

      upsertOptimisticSessionFirstMessage(
        '/session/existing.jsonl',
        '第四句话',
        '2026-07-06T01:03:00.000Z',
      );

      expect((mockState.sessions as any[])[0]).toMatchObject({
        path: '/session/existing.jsonl',
        firstMessage: '第一句话',
        messageCount: 3,
        modified: '2026-07-06T01:02:03.000Z',
      });
      expect((mockState.sessions as any[])[0]._optimisticFirstMessage).toBeUndefined();
    });

    it('lets the persisted server projection replace the optimistic first-message projection', async () => {
      Object.assign(mockState, {
        currentSessionPath: '/session/new.jsonl',
        currentSessionId: 'sess_new',
        currentAgentId: 'hana',
        agentName: 'Hana',
        deskBasePath: '/workspace',
        sessions: [],
      });
      upsertOptimisticSessionFirstMessage(
        '/session/new.jsonl',
        '第一句话',
        '2026-07-06T01:02:03.000Z',
      );
      mockFetch.mockResolvedValueOnce(jsonResponse([
        {
          path: '/session/new.jsonl',
          sessionId: 'sess_new',
          title: '正式标题',
          firstMessage: '第一句话',
          modified: '2026-07-06T01:02:05.000Z',
          messageCount: 1,
          cwd: '/workspace',
          agentId: 'hana',
          agentName: 'Hana',
        },
      ]));

      await loadSessions();

      expect((mockState.sessions as any[])[0]).toMatchObject({
        path: '/session/new.jsonl',
        title: '正式标题',
        firstMessage: '第一句话',
        messageCount: 1,
        modified: '2026-07-06T01:02:05.000Z',
      });
      expect((mockState.sessions as any[])[0]._optimisticFirstMessage).toBeUndefined();
    });
  });

  describe('switchSession 的 hasData 语义（#405 直接回归）', () => {
    it('点回已提交的当前 session 会取消在途切换，旧响应不能把焦点切走', async () => {
      Object.assign(mockState, {
        currentSessionPath: '/a',
        chatSessions: {
          '/b': { items: [{ type: 'message', data: { id: 'cached-b' } }], hasMore: false },
        },
      });

      let resolveSwitchToB!: (r: Response) => void;
      const switchToB = new Promise<Response>(resolve => { resolveSwitchToB = resolve; });
      mockFetch.mockImplementationOnce(() => switchToB);

      const pendingSwitch = switchSession('/b');
      expect(mockState.pendingSessionSwitchPath).toBe('/b');

      await switchSession('/a');
      expect(mockState.pendingSessionSwitchPath).toBeNull();

      resolveSwitchToB(jsonResponse({
        ok: true,
        agentId: null,
        cwd: '/workspace-b',
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));
      await pendingSwitch;

      expect(mockState.currentSessionPath).toBe('/a');
      expect(deskActionMocks.activateWorkspaceDesk).not.toHaveBeenCalledWith('/workspace-b');
    });

    it('surfaces the server error when switching to an old session fails', async () => {
      const copy: Record<string, string> = {
        'session.switchFailed': 'Switch session failed',
        'error.code.unexpected': 'Something went wrong',
      };
      (globalThis.window as unknown as { t: (key: string) => string }).t = (key: string) => copy[key] ?? key;
      Object.assign(mockState, {
        currentSessionPath: '/session/current.jsonl',
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        error: 'Invalid session path',
      }, false));

      await switchSession('/session/old.jsonl');

      expect(mockState.currentSessionPath).toBe('/session/current.jsonl');
      expect(mockState.inlineErrors).toMatchObject({
        '/session/current.jsonl': {
          text: 'Switch session failed: Something went wrong',
          detail: 'Invalid session path',
          code: null,
        },
      });
      expect(mockState.addToast).toHaveBeenCalledWith(
        'Switch session failed: Something went wrong',
        'error',
        6000,
        undefined,
      );
    });

    it('切换失败带错误码时说人话，toast 带上错误码', async () => {
      const copy: Record<string, string> = {
        'session.switchFailed': 'Switch session failed',
        'error.code.unexpected': 'Something went wrong',
        'error.code.sessionLocatorNotActive': '这个会话已经不是当前版本，刷新一下列表',
      };
      (globalThis.window as unknown as { t: (key: string) => string }).t = (key: string) => copy[key] ?? key;
      Object.assign(mockState, {
        currentSessionPath: '/session/current.jsonl',
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        error: 'session locator is not active',
        code: 'session_locator_not_active',
      }, false));

      await switchSession('/session/old.jsonl');

      expect(mockState.inlineErrors).toMatchObject({
        '/session/current.jsonl': {
          text: 'Switch session failed: 这个会话已经不是当前版本，刷新一下列表',
          detail: 'session locator is not active',
          code: 'session_locator_not_active',
        },
      });
      expect(mockState.addToast).toHaveBeenCalledWith(
        'Switch session failed: 这个会话已经不是当前版本，刷新一下列表',
        'error',
        6000,
        { errorCode: 'session_locator_not_active' },
      );
    });

    it('切换失败走顶层 onError 的嵌套形状时，仍读得出 code 和 message', async () => {
      const copy: Record<string, string> = {
        'session.switchFailed': 'Switch session failed',
        'error.code.unexpected': 'Something went wrong',
        'error.code.sessionManifestUnavailable': '会话索引暂时不可用，请稍后重试',
      };
      (globalThis.window as unknown as { t: (key: string) => string }).t = (key: string) => copy[key] ?? key;
      Object.assign(mockState, {
        currentSessionPath: '/session/current.jsonl',
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        error: { code: 'session_manifest_unavailable', message: 'session index is rebuilding', traceId: 't-1' },
      }, false));

      await switchSession('/session/old.jsonl');

      expect(mockState.inlineErrors).toMatchObject({
        '/session/current.jsonl': {
          text: 'Switch session failed: 会话索引暂时不可用，请稍后重试',
          detail: 'session index is rebuilding',
          code: 'session_manifest_unavailable',
        },
      });
    });

    it('后端返回 currentModelId，uncached session 仍然触发 loadMessages', async () => {
      // 1) /sessions/switch 响应
      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        currentModelId: 'claude-opus-4-6',
        currentModelName: 'Claude Opus 4.6',
        currentModelProvider: 'anthropic',
      }));
      // 2) /sessions/messages 响应（loadMessages 内部）
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'history' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/a');

      // 关键：必须调用了 loadMessages 的 fetch（第二次 fetch 到 /sessions/messages）
      const calls = mockFetch.mock.calls.map(c => String(c[0]));
      expect(calls.some(u => u.startsWith('/api/sessions/switch'))).toBe(true);
      expect(calls.some(u => u.startsWith('/api/sessions/messages'))).toBe(true);

      // 模型快照确实被记录
      const models = mockState.sessionModelsByPath as Record<string, unknown>;
      expect(models['/a']).toMatchObject({ id: 'claude-opus-4-6', provider: 'anthropic' });

      // updateSessionModel 实现没有污染 chatSessions（没有 stub）
      // 注意：loadMessages 之后 chatSessions[/a] 才存在（来自 initSession），
      // 所以这里通过 updateSessionModel 的 mock 记录来验证它调用时 chatSessions 是空的。
      const updateSessionModelMock = (mockState as unknown as {
        updateSessionModel: ReturnType<typeof vi.fn>;
      }).updateSessionModel;
      expect(updateSessionModelMock).toHaveBeenCalled();
    });

    it('hydrates audio capability fields from the switch response into the per-session model snapshot', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        currentModelId: 'mimo-v2.5',
        currentModelName: 'MiMo V2.5',
        currentModelProvider: 'mimo',
        currentModelInput: ['text'],
        currentModelAudio: true,
        currentModelAudioTransport: 'mimo-input-audio',
        currentModelAudioTransportSupported: true,
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/audio-session');

      const models = mockState.sessionModelsByPath as Record<string, Record<string, unknown>>;
      expect(models['/audio-session']).toMatchObject({
        id: 'mimo-v2.5',
        provider: 'mimo',
        input: ['text'],
        audio: true,
        audioTransport: 'mimo-input-audio',
        audioTransportSupported: true,
      });
    });

    it('hydrates an unavailable historical model as blocked session-owned state', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        currentModelId: 'removed-chat-model',
        currentModelName: 'Removed Chat Model',
        currentModelProvider: 'legacy-provider',
        currentModelAvailable: false,
        currentModelUnavailableReason: 'model_removed',
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'old history' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/removed-model-session');

      const models = mockState.sessionModelsByPath as Record<string, Record<string, unknown>>;
      expect(models['/removed-model-session']).toMatchObject({
        id: 'removed-chat-model',
        provider: 'legacy-provider',
        available: false,
        unavailableReason: 'model_removed',
      });
      const calls = mockFetch.mock.calls.map(c => String(c[0]));
      expect(calls.some(url => url.startsWith('/api/sessions/messages'))).toBe(true);
    });

    it('已缓存的 session：switchSession 不再次 loadMessages', async () => {
      // 预置：/a 已经 initSession 过
      (mockState.chatSessions as Record<string, unknown>)['/a'] = {
        items: [{ type: 'message', data: { id: '0', text: 'cached' } }],
        hasMore: false,
        loadingMore: false,
      };

      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        currentModelId: 'claude-opus-4-6',
        currentModelName: 'Claude Opus 4.6',
        currentModelProvider: 'anthropic',
      }));

      await switchSession('/a');

      // 只应该有一次 /api/sessions/switch，不应该有 /api/sessions/messages
      const calls = mockFetch.mock.calls.map(c => String(c[0]));
      expect(calls.filter(u => u.startsWith('/api/sessions/messages'))).toHaveLength(0);
    });

    it('后端确认目标 session 已结束时，清掉刷新前遗留的 streaming 标记', async () => {
      (mockState.chatSessions as Record<string, unknown>)['/a'] = {
        items: [{ type: 'message', data: { id: '0', text: 'cached' } }],
        hasMore: false,
        loadingMore: false,
      };
      Object.assign(mockState, {
        streamingSessions: ['/a', '/background'],
      });

      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
        isStreaming: false,
      }));

      await switchSession('/a');

      expect(mockState.streamingSessions).toEqual(['/background']);
      expect(streamResumeMocks.requestStreamResume).not.toHaveBeenCalled();
    });

    it('后端确认目标 session 仍在输出时，切入后主动请求恢复该 session 的流', async () => {
      (mockState.chatSessions as Record<string, unknown>)['/a'] = {
        items: [{ type: 'message', data: { id: '0', text: 'cached' } }],
        hasMore: false,
        loadingMore: false,
      };

      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
        isStreaming: true,
      }));

      await switchSession('/a');

      expect(mockState.streamingSessions).toEqual(['/a']);
      expect(streamResumeMocks.requestStreamResume).toHaveBeenCalledWith('/a');
    });

    it('切换完成后仍在 chat surface 时恢复输入焦点', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'history' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/a');

      expect((mockState as unknown as { requestInputFocus: ReturnType<typeof vi.fn> }).requestInputFocus)
        .toHaveBeenCalledTimes(1);
    });

    it('用户已离开 chat surface 时不抢回输入焦点', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'history' }], blocks: [], todos: [], hasMore: false,
      }));

      const switching = switchSession('/a');
      (mockState as Record<string, unknown>).currentTab = 'channels';
      await switching;

      expect((mockState as unknown as { requestInputFocus: ReturnType<typeof vi.fn> }).requestInputFocus)
        .not.toHaveBeenCalled();
    });

    it('切 session 时激活目标 cwd 的工作台面板，不携带旧 deskCurrentPath', async () => {
      (mockState as Record<string, unknown>).deskCurrentPath = 'notes/daily';
      (mockState as Record<string, unknown>).deskBasePath = '/workspace-old';
      (mockState as Record<string, unknown>).deskFiles = [{ name: 'stale.md' }];
      (mockState as Record<string, unknown>).deskJianContent = 'stale';

      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        cwd: '/workspace-a',
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'history' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/a');

      expect(mockState.deskBasePath).toBe('/workspace-a');
      expect(mockState.deskCurrentPath).toBe('');
      expect(mockState.deskFiles).toEqual([]);
      expect(mockState.deskJianContent).toBeNull();
      expect(mockLoadDeskFiles).toHaveBeenCalledWith('', '/workspace-a', null);
    });

    it('switching across agents synchronizes the active agent home while showing the session cwd', async () => {
      Object.assign(mockState, {
        agents: [
          {
            id: 'hana',
            name: 'Hana',
            yuan: 'hanako',
            isPrimary: true,
            homeFolder: '/workspace/hana-home',
            effectiveHomeFolder: '/workspace/hana-home',
          },
          {
            id: 'mio',
            name: 'Mio',
            yuan: 'hanako',
            isPrimary: false,
            homeFolder: '/workspace/mio-home',
            effectiveHomeFolder: '/workspace/mio-home',
          },
        ],
        currentAgentId: 'hana',
        homeFolder: '/workspace/hana-home',
        deskBasePath: '/workspace/hana-session',
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: 'mio',
        agentName: 'Mio',
        cwd: '/workspace/mio-session',
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'mio history' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/mio');

      expect(mockState.currentAgentId).toBe('mio');
      expect(mockState.homeFolder).toBe('/workspace/mio-home');
      expect(mockState.deskBasePath).toBe('/workspace/mio-session');
    });

    it('切到同一 workspace 的 session 时保留当前 desk 子目录', async () => {
      (mockState as Record<string, unknown>).deskCurrentPath = 'notes/daily';
      (mockState as Record<string, unknown>).deskBasePath = '/workspace-a';
      (mockState as Record<string, unknown>).deskFiles = [{ name: 'stale.md' }];
      (mockState as Record<string, unknown>).deskJianContent = 'stale';

      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        cwd: '/workspace-a',
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'history' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/a');

      expect(mockState.deskBasePath).toBe('/workspace-a');
      expect(mockState.deskCurrentPath).toBe('notes/daily');
      expect(mockState.deskFiles).toEqual([]);
      expect(mockState.deskJianContent).toBeNull();
      expect(mockLoadDeskFiles).toHaveBeenCalledWith('notes/daily', '/workspace-a', null);
    });

    it('恢复切回 workspace 时该 workspace 上次打开的 desk 子目录', async () => {
      (mockState as Record<string, unknown>).deskCurrentPath = 'notes/daily';
      (mockState as Record<string, unknown>).deskBasePath = '/workspace-a';
      (mockState as Record<string, unknown>).deskFiles = [{ name: 'stale-a.md' }];
      (mockState as Record<string, unknown>).deskJianContent = 'stale-a';

      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        cwd: '/workspace-b',
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'workspace b' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/b');

      expect(mockState.deskBasePath).toBe('/workspace-b');
      expect(mockState.deskCurrentPath).toBe('');

      (mockState as Record<string, unknown>).deskCurrentPath = 'src';
      (mockState as Record<string, unknown>).deskFiles = [{ name: 'stale-b.md' }];
      (mockState as Record<string, unknown>).deskJianContent = 'stale-b';

      mockLoadDeskFiles.mockClear();
      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        cwd: '/workspace-a',
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'workspace a' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/a');

      expect(mockState.deskBasePath).toBe('/workspace-a');
      expect(mockState.deskCurrentPath).toBe('notes/daily');
      expect(mockState.deskFiles).toEqual([]);
      expect(mockState.deskJianContent).toBeNull();
      expect(mockLoadDeskFiles).toHaveBeenCalledWith('notes/daily', '/workspace-a', null);
    });

    it('目标 session 没有 cwd 时清空 desk state，不回落到旧 workspace', async () => {
      (mockState as Record<string, unknown>).deskBasePath = '/workspace-old';
      (mockState as Record<string, unknown>).deskCurrentPath = 'notes/daily';
      (mockState as Record<string, unknown>).deskFiles = [{ name: 'stale.md' }];
      (mockState as Record<string, unknown>).deskJianContent = 'stale';

      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        cwd: null,
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'history' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/a');

      expect(mockState.deskBasePath).toBe('');
      expect(mockState.deskCurrentPath).toBe('');
      expect(mockState.deskFiles).toEqual([]);
      expect(mockState.deskJianContent).toBeNull();
      expect(mockLoadDeskFiles).not.toHaveBeenCalled();
    });

    it('当前 session 附件删空后，切走时仍显式写回空数组，避免旧附件复活', async () => {
      (mockState as Record<string, unknown>).currentSessionPath = '/a';
      (mockState as Record<string, unknown>).attachedFiles = [];
      (mockState.attachedFilesBySession as Record<string, unknown>)['/a'] = [{ name: 'old.txt' }];

      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'history' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/b');

      expect((mockState.attachedFilesBySession as Record<string, unknown>)['/a']).toEqual([]);
      expect(mockState.attachedFiles).toEqual([]);
    });
  });

  describe('archiveSession 按 path 清缓存', () => {
    it('归档非当前 session 时也按归档 path 清理 chat / stream 相关缓存', async () => {
      (mockState as Record<string, unknown>).currentSessionPath = '/current';
      (mockState as Record<string, unknown>).sessions = [
        { path: '/archived', sessionId: 'sess_archived' },
        { path: '/current', sessionId: 'sess_current' },
      ];
      (mockState.chatSessions as Record<string, unknown>)['/archived'] = {
        items: [{ type: 'message', data: { id: '1', text: 'archived' } }],
        hasMore: false,
        loadingMore: false,
      };
      (mockState.sessionModelsByPath as Record<string, unknown>)['/archived'] = { id: 'm', provider: 'p' };
      (mockState._loadMessagesVersion as Record<string, number>)['/archived'] = 2;
      (mockState.sessionStreams as Record<string, unknown>)['/archived'] = { isStreaming: true };
      (mockState.attachedFilesBySession as Record<string, unknown>)['/archived'] = [{ name: 'a.txt' }];
      (mockState.drafts as Record<string, string>)['/archived'] = 'draft';
      (mockState.draftDocs as Record<string, unknown>)['/archived'] = { type: 'doc' };
      (mockState.todosBySession as Record<string, unknown>)['/archived'] = [{ id: 'todo-1' }];
      (mockState.todosLiveVersionBySession as Record<string, number>)['/archived'] = 3;
      (mockState.streamingSessions as string[]) = ['/current', '/archived'];
      (mockState.inlineErrors as Record<string, InlineErrorEntry | null>)['/archived'] = {
        text: 'boom',
        detail: null,
        code: null,
      };

      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      mockFetch.mockResolvedValueOnce(jsonResponse([{ path: '/current' }]));

      await archiveSession('/archived');

      expect(mockFetch).toHaveBeenCalledWith('/api/sessions/archive', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/archived', sessionId: 'sess_archived' }),
      }));
      const clearSessionMock = (mockState as unknown as {
        clearSession: ReturnType<typeof vi.fn>;
      }).clearSession;
      expect(clearSessionMock).toHaveBeenCalledWith('/archived');
      expect(mockState.currentSessionPath).toBe('/current');
      expect((mockState.chatSessions as Record<string, unknown>)['/archived']).toBeUndefined();
      expect((mockState.sessionStreams as Record<string, unknown>)['/archived']).toBeUndefined();
      expect((mockState.attachedFilesBySession as Record<string, unknown>)['/archived']).toBeUndefined();
      expect((mockState.drafts as Record<string, string>)['/archived']).toBeUndefined();
      expect((mockState.draftDocs as Record<string, unknown>)['/archived']).toBeUndefined();
      expect((mockState.todosBySession as Record<string, unknown>)['/archived']).toBeUndefined();
      expect((mockState.streamingSessions as string[])).toEqual(['/current']);
      expect((mockState.inlineErrors as Record<string, InlineErrorEntry | null>)['/archived']).toBeNull();
      expect(mockClearChat).not.toHaveBeenCalled();
    });

    it('归档当前 session 时在 currentSessionPath 置空前按该 path 清理缓存', async () => {
      (mockState as Record<string, unknown>).currentSessionPath = '/current';
      (mockState.chatSessions as Record<string, unknown>)['/current'] = {
        items: [{ type: 'message', data: { id: '1', text: 'current' } }],
        hasMore: false,
        loadingMore: false,
      };
      (mockState.chatSessions as Record<string, unknown>)['/other'] = {
        items: [{ type: 'message', data: { id: '2', text: 'other' } }],
        hasMore: false,
        loadingMore: false,
      };
      (mockState.sessionModelsByPath as Record<string, unknown>)['/current'] = { id: 'm', provider: 'p' };
      (mockState._loadMessagesVersion as Record<string, number>)['/current'] = 1;
      (mockState.sessionStreams as Record<string, unknown>)['/current'] = { isStreaming: true };
      (mockState.streamingSessions as string[]) = ['/current'];

      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      mockFetch.mockResolvedValueOnce(jsonResponse([{ path: '/other' }]));
      // loadSessions() 内部紧跟 /api/sessions 并行探测 /api/health（session
      // 元数据待恢复状态）——按调用顺序占掉这个位置的响应队列，空块即可，
      // fetchSessionMetaRecoveryStatus 对缺失/形状不对的响应本就容错。
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        cwd: '/workspace-other',
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));

      await archiveSession('/current');

      const clearSessionMock = (mockState as unknown as {
        clearSession: ReturnType<typeof vi.fn>;
      }).clearSession;
      expect(clearSessionMock).toHaveBeenCalledWith('/current');
      expect(mockClearChat).toHaveBeenCalledTimes(1);
      expect((mockState.chatSessions as Record<string, unknown>)['/current']).toBeUndefined();
      expect((mockState.sessionStreams as Record<string, unknown>)['/current']).toBeUndefined();
      expect((mockState.streamingSessions as string[])).toEqual([]);
      expect(mockState.currentSessionPath).toBe('/other');
    });
  });

  describe('pinSession', () => {
    it('posts the explicit pinned state and updates only the matching session after success', async () => {
      const pinnedAt = '2026-04-29T08:00:00.000Z';
      (mockState as Record<string, unknown>).sessions = [
        { path: '/a', sessionId: 'sess_a', pinnedAt: null },
        { path: '/b', sessionId: 'sess_b', pinnedAt: null },
      ];
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true, pinnedAt, sessionId: 'sess_a' }));

      const ok = await pinSession('/a', true);

      expect(ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('/api/sessions/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/a', sessionId: 'sess_a', pinned: true }),
      });
      expect((mockState.sessions as Array<{ path: string; sessionId: string; pinnedAt: string | null }>)).toEqual([
        { path: '/a', sessionId: 'sess_a', pinnedAt },
        { path: '/b', sessionId: 'sess_b', pinnedAt: null },
      ]);
    });

    it('leaves sessions unchanged and shows a toast when pinning fails', async () => {
      const sessions = [
        { path: '/a', pinnedAt: null },
      ];
      (mockState as Record<string, unknown>).sessions = sessions;
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'write failed' }, false));
      (globalThis.window as unknown as { t: (key: string) => string }).t = (key: string) => key;

      const ok = await pinSession('/a', true);

      expect(ok).toBe(false);
      expect(mockState.sessions).toBe(sessions);
      expect(mockState.addToast).toHaveBeenCalledWith('session.pinFailed', 'info', 3000);
    });
  });

  // ── #1610: 会话修订点同步（/rc 接管期间消息漏同步修复） ──

  describe('loadMessages revision stamp', () => {
    it('stamps the server revision into the hydrated session cache', async () => {
      const sessionPath = '/session/revisioned.jsonl';
      (mockState as Record<string, unknown>).sessions = [
        { path: sessionPath, sessionId: 'sess_revisioned' },
      ];
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ role: 'user', content: 'hi' }],
        blocks: [],
        todos: [],
        hasMore: false,
        revision: '2048:1765500000000',
      }));

      await loadMessages(sessionPath);

      expect(mockFetch).toHaveBeenCalledWith(
        `/api/sessions/messages?path=${encodeURIComponent(sessionPath)}&sessionId=sess_revisioned`,
      );
      const cached = (mockState.chatSessions as Record<string, { revision?: string | null }>)[sessionPath];
      expect(cached.revision).toBe('2048:1765500000000');
    });

    it('stamps a null revision when the server omits it', async () => {
      const sessionPath = '/session/no-revision.jsonl';
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [],
        blocks: [],
        todos: [],
        hasMore: false,
      }));

      await loadMessages(sessionPath);

      const cached = (mockState.chatSessions as Record<string, { revision?: string | null }>)[sessionPath];
      expect(cached.revision).toBeNull();
    });
  });

  describe('reconcileCurrentSessionMessages', () => {
    const sessionPath = '/session/rc-target.jsonl';

    function installCachedCurrentSession({
      cachedRevision = 'rev-old',
      listRevision = 'rev-new',
    }: { cachedRevision?: string | null; listRevision?: string | null } = {}) {
      Object.assign(mockState, {
        currentSessionPath: sessionPath,
        sessions: [{ path: sessionPath, revision: listRevision, modified: '2026-06-10T08:00:00.000Z', messageCount: 3 }],
        chatSessions: {
          [sessionPath]: { items: [], hasMore: false, loadingMore: false, revision: cachedRevision },
        },
      });
    }

    it('re-pulls the current session when the list revision drifts from the cached one', async () => {
      installCachedCurrentSession({ cachedRevision: 'rev-old', listRevision: 'rev-new' });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [
          { role: 'user', content: 'from telegram' },
          { role: 'assistant', content: 'rc reply' },
        ],
        blocks: [],
        todos: [],
        hasMore: false,
        revision: 'rev-new',
      }));

      await reconcileCurrentSessionMessages('test_drift');

      expect(mockFetch).toHaveBeenCalledWith(
        `/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`,
      );
      const cached = (mockState.chatSessions as Record<string, { items: unknown[]; revision?: string | null }>)[sessionPath];
      expect(cached.items).toHaveLength(2);
      expect(cached.revision).toBe('rev-new');
    });

    it('skips the fetch when the cached revision matches the list revision', async () => {
      installCachedCurrentSession({ cachedRevision: 'rev-same', listRevision: 'rev-same' });

      await reconcileCurrentSessionMessages('test_match');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('re-pulls once when the cached revision is unknown', async () => {
      installCachedCurrentSession({ cachedRevision: null, listRevision: 'rev-new' });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [], blocks: [], todos: [], hasMore: false, revision: 'rev-new',
      }));

      await reconcileCurrentSessionMessages('test_unknown_cache');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const cached = (mockState.chatSessions as Record<string, { revision?: string | null }>)[sessionPath];
      expect(cached.revision).toBe('rev-new');
    });

    it('does not re-pull while the session is streaming', async () => {
      installCachedCurrentSession();
      Object.assign(mockState, { streamingSessions: [sessionPath] });

      await reconcileCurrentSessionMessages('test_streaming');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not re-pull when the session has no message cache yet', async () => {
      installCachedCurrentSession();
      Object.assign(mockState, { chatSessions: {} });

      await reconcileCurrentSessionMessages('test_cold');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not re-pull when the list projection carries no revision', async () => {
      installCachedCurrentSession({ listRevision: null });

      await reconcileCurrentSessionMessages('test_no_list_revision');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not re-pull while a session switch is pending', async () => {
      installCachedCurrentSession();
      Object.assign(mockState, { pendingSessionSwitchPath: '/session/other.jsonl' });

      await reconcileCurrentSessionMessages('test_pending_switch');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('deduplicates concurrent triggers into one in-flight fetch', async () => {
      installCachedCurrentSession();
      let resolveFetch: (value: Response) => void = () => {};
      mockFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }));

      const first = reconcileCurrentSessionMessages('ws_reconnect');
      const second = reconcileCurrentSessionMessages('window_focus');

      resolveFetch(jsonResponse({ messages: [], blocks: [], todos: [], hasMore: false, revision: 'rev-new' }));
      await Promise.all([first, second]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('allows a follow-up reconcile after the previous one settles', async () => {
      installCachedCurrentSession();
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [], blocks: [], todos: [], hasMore: false, revision: 'rev-mid',
      }));

      await reconcileCurrentSessionMessages('first');

      // 列表又前进了一个修订点
      Object.assign(mockState, {
        sessions: [{ path: sessionPath, revision: 'rev-final' }],
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [], blocks: [], todos: [], hasMore: false, revision: 'rev-final',
      }));

      await reconcileCurrentSessionMessages('second');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const cached = (mockState.chatSessions as Record<string, { revision?: string | null }>)[sessionPath];
      expect(cached.revision).toBe('rev-final');
    });
  });

  describe('switchSession revision reconcile', () => {
    it('re-pulls a cached session whose list revision drifted while it was in the background', async () => {
      const target = '/session/cached-stale.jsonl';
      Object.assign(mockState, {
        currentSessionPath: '/session/current.jsonl',
        sessions: [
          { path: target, cwd: '/tmp/work', revision: 'rev-after-rc' },
        ],
        chatSessions: {
          [target]: { items: [{ type: 'message', data: { id: '0' } }], hasMore: false, loadingMore: false, revision: 'rev-before-rc' },
        },
      });
      mockFetch.mockImplementation(async (url: string) => {
        if (String(url) === '/api/sessions/switch') {
          return jsonResponse({ ok: true, isStreaming: false });
        }
        if (String(url).startsWith('/api/sessions/messages')) {
          return jsonResponse({
            messages: [
              { role: 'user', content: 'old' },
              { role: 'user', content: 'rc message' },
            ],
            blocks: [],
            todos: [],
            hasMore: false,
            revision: 'rev-after-rc',
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      await switchSession(target);

      expect(mockFetch).toHaveBeenCalledWith(
        `/api/sessions/messages?path=${encodeURIComponent(target)}`,
      );
      const cached = (mockState.chatSessions as Record<string, { items: unknown[]; revision?: string | null }>)[target];
      expect(cached.items).toHaveLength(2);
      expect(cached.revision).toBe('rev-after-rc');
    });

    it('does not re-pull a cached session whose revision still matches the list', async () => {
      const target = '/session/cached-fresh.jsonl';
      Object.assign(mockState, {
        currentSessionPath: '/session/current.jsonl',
        sessions: [
          { path: target, cwd: '/tmp/work', revision: 'rev-same' },
        ],
        chatSessions: {
          [target]: { items: [{ type: 'message', data: { id: '0' } }], hasMore: false, loadingMore: false, revision: 'rev-same' },
        },
      });
      mockFetch.mockImplementation(async (url: string) => {
        if (String(url) === '/api/sessions/switch') {
          return jsonResponse({ ok: true, isStreaming: false });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      await switchSession(target);

      expect(mockFetch).not.toHaveBeenCalledWith(
        `/api/sessions/messages?path=${encodeURIComponent(target)}`,
      );
    });
  });

  describe('refreshSessionCapabilities', () => {
    const target = '/session/drift.jsonl';

    it('marks busy during refresh, reloads messages, and clears busy afterward', async () => {
      const busyDuringRequest: boolean[] = [];
      mockFetch.mockImplementation(async (url: string) => {
        if (String(url) === '/api/sessions/fresh-compact') {
          busyDuringRequest.push((mockState.capabilityRefreshingSessions as string[]).includes(target));
          return jsonResponse({ ok: true, tokensBefore: 100, tokensAfter: 10 });
        }
        if (String(url).startsWith('/api/sessions/messages')) {
          return jsonResponse({ messages: [], blocks: [], todos: [], hasMore: false });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const ok = await refreshSessionCapabilities(target);

      expect(ok).toBe(true);
      expect(busyDuringRequest).toEqual([true]);
      expect((mockState.capabilityRefreshingSessions as string[]).includes(target)).toBe(false);
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/sessions/messages?path=${encodeURIComponent(target)}`,
      );
    });

    it('surfaces a refresh failure as an inline error and clears busy', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'already compacting' }, false));

      const ok = await refreshSessionCapabilities(target);

      expect(ok).toBe(false);
      expect((mockState.capabilityRefreshingSessions as string[]).includes(target)).toBe(false);
      const capabilityError = (mockState.inlineErrors as Record<string, InlineErrorEntry | null>)[target];
      expect(capabilityError?.text).toContain('already compacting');
    });

    it('嵌套形状不渲染 [object Object]，错误码照样透传', async () => {
      const copy: Record<string, string> = {
        'input.refreshAndCompactFailed': 'Refresh failed',
        'error.code.unexpected': 'Something went wrong',
        'error.code.sessionBusy': '这个会话正忙，等当前操作结束',
      };
      (globalThis.window as unknown as { t: (key: string) => string }).t = (key: string) => copy[key] ?? key;
      mockFetch.mockResolvedValueOnce(jsonResponse({
        error: { code: 'session_busy', message: 'session is busy', traceId: 't-3' },
      }, false));

      const ok = await refreshSessionCapabilities(target);

      expect(ok).toBe(false);
      const capabilityError = (mockState.inlineErrors as Record<string, InlineErrorEntry | null>)[target];
      expect(capabilityError?.text).not.toContain('[object Object]');
      expect(capabilityError?.text).toBe('Refresh failed: 这个会话正忙，等当前操作结束');
      expect(capabilityError?.code).toBe('session_busy');
    });
  });

  describe('continueDeletedAgentSession 的错误呈现', () => {
    it('嵌套形状不渲染 [object Object]，toast 带上错误码', async () => {
      const copy: Record<string, string> = {
        'session.deletedAgent.continueFailed': 'Continue failed',
        'error.code.unexpected': 'Something went wrong',
        'error.code.sessionBusy': '这个会话正忙，等当前操作结束',
      };
      (globalThis.window as unknown as { t: (key: string) => string }).t = (key: string) => copy[key] ?? key;
      mockFetch.mockResolvedValueOnce(jsonResponse({
        error: { code: 'session_busy', message: 'session is busy', traceId: 't-4' },
      }, false));

      const ok = await continueDeletedAgentSession('/session/deleted.jsonl');

      expect(ok).toBe(false);
      const toastCalls = (mockState.addToast as ReturnType<typeof vi.fn>).mock.calls;
      const failureToast = toastCalls.find(call => String(call[0]).startsWith('Continue failed'));
      expect(failureToast).toBeDefined();
      expect(String(failureToast?.[0])).not.toContain('[object Object]');
      expect(failureToast?.[0]).toBe('Continue failed: 这个会话正忙，等当前操作结束');
      expect(failureToast?.[3]).toEqual({ errorCode: 'session_busy' });
    });
  });
});
