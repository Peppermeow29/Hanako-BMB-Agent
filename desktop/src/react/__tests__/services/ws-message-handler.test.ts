import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const previewRefreshMocks = vi.hoisted(() => ({
  changeOptions: { retryMissing: true, retryUnchanged: true },
  refreshOpenPreviewDocumentsForResourceChange: vi.fn(async () => undefined),
  markDeskTreeDirtyForResourceChange: vi.fn(),
}));

vi.mock('../../hooks/use-stream-buffer', () => ({
  streamBufferManager: {
    handle: vi.fn(),
    beginTurn: vi.fn(),
    finishTurn: vi.fn(),
  },
}));

vi.mock('../../stores/session-actions', () => ({
  loadSessions: vi.fn(),
}));

vi.mock('../../stores/channel-actions', () => ({
  loadChannels: vi.fn(),
  openChannel: vi.fn(),
}));

vi.mock('../../stores/preview-actions', () => ({
  handleLegacyArtifactBlock: vi.fn(),
}));

vi.mock('../../services/app-event-actions', () => ({
  handleAppEvent: vi.fn(),
}));

vi.mock('../../utils/preview-document-refresh', () => ({
  PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS: previewRefreshMocks.changeOptions,
  refreshOpenPreviewDocumentsForResourceChange: previewRefreshMocks.refreshOpenPreviewDocumentsForResourceChange,
  markDeskTreeDirtyForResourceChange: previewRefreshMocks.markDeskTreeDirtyForResourceChange,
}));

vi.mock('../../services/stream-resume', () => ({
  replayStreamResume: vi.fn(),
  isStreamResumeRebuilding: () => null,
  isStreamScopedMessage: () => false,
  updateSessionStreamMeta: vi.fn(),
}));

vi.mock('../../services/stream-key-dispatcher', () => ({
  dispatchStreamKey: vi.fn(),
}));

import { streamBufferManager } from '../../hooks/use-stream-buffer';
import { useStore } from '../../stores';
import { applyStreamingStatus, configureWsMessageHandler, handleServerMessage } from '../../services/ws-message-handler';
import { resetSessionRefreshSchedulerForTest } from '../../services/session-refresh-scheduler';
import { dispatchStreamKey } from '../../services/stream-key-dispatcher';
import { handleAppEvent } from '../../services/app-event-actions';
import { clearMessageLiveVersion, readMessageLiveVersion } from '../../stores/message-live-version';
import { loadSessions } from '../../stores/session-actions';
import zh from '../../../locales/zh.json';

/** Resolve a dotted i18n key against the real Chinese pack, the way window.t does. */
function translateZh(key: string): string {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    zh as unknown,
  );
  return typeof value === 'string' ? value : key;
}

afterEach(() => {
  resetSessionRefreshSchedulerForTest();
  previewRefreshMocks.refreshOpenPreviewDocumentsForResourceChange.mockClear();
  previewRefreshMocks.markDeskTreeDirtyForResourceChange.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ws-message-handler applyStreamingStatus', () => {
  beforeEach(() => {
    vi.mocked(loadSessions).mockClear();
    useStore.setState({
      currentSessionPath: '/focused.jsonl',
      pendingNewSession: false,
      sessions: [],
      streamingSessions: [],
      activeSessionStreams: {},
      unreadOutputSessionPaths: [],
      inlineErrors: {},
    } as never);
  });

  it('isStreaming=true 对传入的 path 做 addStreamingSession（即使不是焦点 session）', () => {
    applyStreamingStatus(true, '/other.jsonl');
    expect(useStore.getState().streamingSessions).toEqual(['/other.jsonl']);
  });

  it('isStreaming=false 对传入的 path 做 removeStreamingSession（非焦点 session 也必须清）', () => {
    useStore.setState({ streamingSessions: ['/focused.jsonl', '/other.jsonl'] } as never);
    applyStreamingStatus(false, '/other.jsonl');
    expect(useStore.getState().streamingSessions).toEqual(['/focused.jsonl']);
  });

  it('stream_resume 场景：服务端返回 isStreaming=false，前端把焦点 session 从 streamingSessions 移除', () => {
    useStore.setState({ streamingSessions: ['/focused.jsonl'] } as never);
    applyStreamingStatus(false, '/focused.jsonl');
    expect(useStore.getState().streamingSessions).toEqual([]);
  });

  it('ignores stale status=false when its streamId no longer matches the active stream', () => {
    useStore.setState({
      streamingSessions: ['/focused.jsonl'],
      activeSessionStreams: {
        '/focused.jsonl': { streamId: 'stream_new', turnId: null },
      },
      inputFocusTrigger: 0,
    } as never);

    const applied = applyStreamingStatus(false, '/focused.jsonl', { streamId: 'stream_old' });

    expect(applied).toBe(false);
    expect(useStore.getState().streamingSessions).toEqual(['/focused.jsonl']);
    expect(useStore.getState().inputFocusTrigger).toBe(0);
  });

  it('isStreaming=true 时重复调用不会产生重复 path', () => {
    applyStreamingStatus(true, '/focused.jsonl');
    applyStreamingStatus(true, '/focused.jsonl');
    expect(useStore.getState().streamingSessions).toEqual(['/focused.jsonl']);
  });

  it('sessionPath 为 null 不抛错（防御调用方漏传）', () => {
    useStore.setState({ streamingSessions: ['/focused.jsonl'] } as never);
    expect(() => applyStreamingStatus(false, null)).not.toThrow();
    expect(useStore.getState().streamingSessions).toEqual(['/focused.jsonl']);
  });

  it('后台 session 从 streaming 变为完成时标记未读输出', () => {
    useStore.setState({ streamingSessions: ['/other.jsonl'], unreadOutputSessionPaths: [] } as never);
    applyStreamingStatus(false, '/other.jsonl');
    expect(useStore.getState().unreadOutputSessionPaths).toEqual(['/other.jsonl']);
  });

  it('当前焦点 session 完成时不标记未读输出', () => {
    useStore.setState({ streamingSessions: ['/focused.jsonl'], unreadOutputSessionPaths: [] } as never);
    applyStreamingStatus(false, '/focused.jsonl');
    expect(useStore.getState().unreadOutputSessionPaths).toEqual([]);
  });

  it('收到 isStreaming=true 只维护运行集合，不产生未读输出标记', () => {
    applyStreamingStatus(true, '/other.jsonl');
    expect(useStore.getState().streamingSessions).toEqual(['/other.jsonl']);
    expect(useStore.getState().unreadOutputSessionPaths).toEqual([]);
  });
});

describe('ws-message-handler session-scoped desktop events', () => {
  beforeEach(() => {
    useStore.setState({
      currentSessionPath: '/session/a.jsonl',
      currentSessionId: null,
      sessionLocatorsById: {},
      pendingNewSession: false,
      sessions: [{
        path: '/session/a.jsonl',
        title: 'A',
        firstMessage: 'hello',
        modified: '2026-04-24T10:00:00.000Z',
        messageCount: 1,
        agentId: 'a1',
        agentName: 'Hana',
        cwd: null,
      }],
      chatSessions: {},
      streamingSessions: [],
      computerOverlayBySession: {},
    } as never);
    clearMessageLiveVersion('/session/a.jsonl');
    useStore.getState().clearSession('/session/a.jsonl');
    useStore.getState().initSession('/session/a.jsonl', [], false);
  });

  it('session_user_message 直接把 user message 追加到对应桌面 session', () => {
    handleServerMessage({
      type: 'session_user_message',
      sessionPath: '/session/a.jsonl',
      message: {
        text: 'hello from bridge',
        quotedText: 'quote',
        attachments: [{ path: '/tmp/a.png', name: 'a.png', isDir: false }],
      },
    });

    const items = useStore.getState().chatSessions['/session/a.jsonl']?.items || [];
    expect(items).toHaveLength(1);
    const first = items[0];
    expect(first?.type).toBe('message');
    if (!first || first.type !== 'message') throw new Error('expected message item');
    expect(first.data.role).toBe('user');
    expect(first.data.text).toBe('hello from bridge');
    expect(first.data.quotedText).toBe('quote');
    expect(first.data.attachments).toEqual([{ path: '/tmp/a.png', name: 'a.png', isDir: false }]);
  });

  it('drops a websocket event whose sessionId is already bound to a different known path (#2078)', () => {
    useStore.setState({
      currentSessionId: 'sess_a',
      currentSessionPath: '/session/a.jsonl',
      sessions: [
        { path: '/session/a.jsonl', sessionId: 'sess_a', agentId: 'a1', agentName: 'Hana' },
        { path: '/session/b.jsonl', sessionId: 'sess_b', agentId: 'a1', agentName: 'Hana' },
      ],
      sessionLocatorsById: {
        sess_a: { path: '/session/a.jsonl' },
        sess_b: { path: '/session/b.jsonl' },
      },
      streamingSessions: [],
      activeSessionStreams: {},
    } as never);

    handleServerMessage({
      type: 'status',
      sessionId: 'sess_a',
      sessionPath: '/session/b.jsonl',
      streamId: 'stream-wrong',
      isStreaming: true,
    });

    expect(useStore.getState().streamingSessions).toEqual([]);
    expect(useStore.getState().sessionLocatorsById.sess_a).toEqual({ path: '/session/a.jsonl' });
  });

  it('session_user_message 透传 origin 到 store 里的 ChatMessage.origin', () => {
    handleServerMessage({
      type: 'session_user_message',
      sessionPath: '/session/a.jsonl',
      message: {
        text: '干净正文',
        origin: { kind: 'agent', agentId: 'hana', agentName: 'Hana' },
      },
    });

    const items = useStore.getState().chatSessions['/session/a.jsonl']?.items || [];
    const first = items[0];
    expect(first?.type).toBe('message');
    if (!first || first.type !== 'message') throw new Error('expected message item');
    expect(first.data.origin).toEqual({ kind: 'agent', agentId: 'hana', agentName: 'Hana' });
  });

  it('session_user_message 无 origin 字段时不在 ChatMessage 上生成 origin', () => {
    handleServerMessage({
      type: 'session_user_message',
      sessionPath: '/session/a.jsonl',
      message: {
        text: 'hello from bridge no origin',
      },
    });

    const items = useStore.getState().chatSessions['/session/a.jsonl']?.items || [];
    const first = items[0];
    expect(first?.type).toBe('message');
    if (!first || first.type !== 'message') throw new Error('expected message item');
    expect(first.data.origin).toBeUndefined();
  });

  it('session_user_message 保存附件-only 消息时不生成 textHtml', () => {
    handleServerMessage({
      type: 'session_user_message',
      sessionPath: '/session/a.jsonl',
      message: {
        text: '',
        attachments: [{ path: '/tmp/voice.wav', name: 'voice.wav', isDir: false, mimeType: 'audio/wav' }],
      },
    });

    const items = useStore.getState().chatSessions['/session/a.jsonl']?.items || [];
    const first = items[0];
    expect(first?.type).toBe('message');
    if (!first || first.type !== 'message') throw new Error('expected message item');
    expect(first.data.text).toBe('');
    expect(first.data.textHtml).toBeUndefined();
    expect(first.data.attachments).toEqual([{ path: '/tmp/voice.wav', name: 'voice.wav', isDir: false, mimeType: 'audio/wav' }]);
  });

  it('session_user_message confirms an optimistic user message by clientMessageId without duplicating it', () => {
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: {
        id: 'client-user-1',
        role: 'user',
        text: 'pending text',
        textHtml: 'pending text',
        sendStatus: 'pending',
      },
    });

    handleServerMessage({
      type: 'session_user_message',
      sessionPath: '/session/a.jsonl',
      clientMessageId: 'client-user-1',
      message: {
        id: 'entry-u1',
        text: 'confirmed text',
        timestamp: '2026-06-12T10:00:00.000Z',
      },
    });

    const items = useStore.getState().chatSessions['/session/a.jsonl']?.items || [];
    expect(items).toHaveLength(1);
    const first = items[0];
    expect(first?.type).toBe('message');
    if (!first || first.type !== 'message') throw new Error('expected message item');
    expect(first.data).toMatchObject({
      id: 'client-user-1',
      sourceEntryId: 'entry-u1',
      role: 'user',
      text: 'confirmed text',
      timestamp: Date.parse('2026-06-12T10:00:00.000Z'),
    });
    expect(first.data.sendStatus).toBeUndefined();
  });

  it('drops an ordinary stream event that tries to move a known sessionId to an unknown new path', () => {
    const sessionId = 'sess_ws_moved';
    const oldPath = '/session/old-a.jsonl';
    const newPath = '/session/new-a.jsonl';
    useStore.setState({
      sessions: [{
        path: oldPath,
        sessionId,
        title: 'A',
        firstMessage: 'hello',
        modified: '2026-04-24T10:00:00.000Z',
        messageCount: 1,
        agentId: 'a1',
        agentName: 'Hana',
        cwd: null,
      }],
      sessionLocatorsById: { [sessionId]: { path: oldPath } },
      chatSessions: {
        [sessionId]: {
          items: [],
          hasMore: false,
          loadingMore: false,
          oldestId: undefined,
          revision: null,
        },
      },
    } as never);

    handleServerMessage({
      type: 'session_user_message',
      sessionId,
      sessionPath: newPath,
      message: {
        id: 'moved-u1',
        text: 'moved path event',
      },
    });

    const state = useStore.getState();
    expect(state.sessionLocatorsById[sessionId]).toEqual({ path: oldPath });
    expect(state.chatSessions[sessionId]?.items).toHaveLength(0);
    expect(state.chatSessions[newPath]).toBeUndefined();
  });

  it('voice_transcription_update 按 fileId 回填现有用户语音附件', () => {
    handleServerMessage({
      type: 'session_user_message',
      sessionPath: '/session/a.jsonl',
      message: {
        text: '',
        attachments: [{
          fileId: 'sf_voice',
          path: '/tmp/voice.wav',
          name: '录音 1.wav',
          isDir: false,
          mimeType: 'audio/wav',
          presentation: 'voice-input',
        }],
      },
    });

    handleServerMessage({
      type: 'voice_transcription_update',
      sessionPath: '/session/a.jsonl',
      fileId: 'sf_voice',
      transcription: {
        status: 'ready',
        text: '今晚我们先把语音输入跑通。',
      },
    });

    const items = useStore.getState().chatSessions['/session/a.jsonl']?.items || [];
    expect(items).toHaveLength(1);
    const first = items[0];
    if (!first || first.type !== 'message') throw new Error('expected message item');
    expect(first.data.attachments?.[0]).toMatchObject({
      fileId: 'sf_voice',
      transcription: {
        status: 'ready',
        text: '今晚我们先把语音输入跑通。',
      },
    });
  });

  it('session_created 乐观插入后延迟刷新 session 列表，避免同一波事件重复全量拉取', async () => {
    vi.useFakeTimers();
    useStore.setState({
      sessionLocatorsById: {
        ...useStore.getState().sessionLocatorsById,
        sess_ws_created: { path: '/session/creation-reservation.jsonl' },
      },
    } as never);

    handleServerMessage({
      type: 'session_created',
      sessionPath: '/session/new.jsonl',
      session: {
        path: '/session/new.jsonl',
        sessionId: 'sess_ws_created',
        title: '手机新会话',
        firstMessage: 'from mobile',
        modified: '2026-05-16T12:00:00.000Z',
        messageCount: 1,
        agentId: 'a1',
        agentName: 'Hana',
        cwd: '/workspace',
      },
    });

    expect(useStore.getState().sessions[0]).toMatchObject({
      path: '/session/new.jsonl',
      sessionId: 'sess_ws_created',
      title: '手机新会话',
      firstMessage: 'from mobile',
      messageCount: 1,
      cwd: '/workspace',
    });
    expect(useStore.getState().sessionLocatorsById.sess_ws_created).toEqual({ path: '/session/new.jsonl' });
    expect(loadSessions).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(loadSessions).toHaveBeenCalledTimes(1);
  });

  it('stream replay 中的 session_user_message 若已由历史加载存在，不重复追加', () => {
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: {
        id: 'hist-0',
        role: 'user',
        text: 'hello from bridge',
        textHtml: 'hello from bridge',
        attachments: [{ path: '/tmp/a.png', name: 'a.png', isDir: false }],
        quotedText: 'quote',
      },
    });

    handleServerMessage({
      type: 'session_user_message',
      sessionPath: '/session/a.jsonl',
      __fromReplay: true,
      message: {
        text: 'hello from bridge',
        quotedText: 'quote',
        attachments: [{ path: '/tmp/a.png', name: 'a.png', isDir: false }],
      },
    });

    const items = useStore.getState().chatSessions['/session/a.jsonl']?.items || [];
    expect(items).toHaveLength(1);
  });

  it('session_branch_reset 只截断目标会话尾部并提升 message live version', () => {
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: { id: 'u1', role: 'user', text: 'old' },
    });
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: { id: 'a1', role: 'assistant', blocks: [] },
    });
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: { id: 'client-u2', sourceEntryId: 'entry-u2', role: 'user', text: 'retry' },
    });
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: { id: 'a2', role: 'assistant', blocks: [] },
    });
    useStore.getState().setSessionTodosForPath('/session/a.jsonl', [{ content: 'old todo', activeForm: 'old todo', status: 'pending' }]);
    useStore.getState().setSessionRegistryFiles('/session/a.jsonl', [{ fileId: 'old-file', filePath: '/tmp/old.txt' }]);

    handleServerMessage({
      type: 'session_branch_reset',
      sessionPath: '/session/a.jsonl',
      messageId: 'entry-u2',
      clientMessageId: 'client-u2',
      todos: [{ content: 'kept todo', activeForm: 'keeping todo', status: 'in_progress' }],
      sessionFiles: [{ fileId: 'kept-file', filePath: '/tmp/kept.txt' }],
    });

    const items = useStore.getState().chatSessions['/session/a.jsonl']?.items || [];
    expect(items.map(item => item.type === 'message' ? item.data.id : item.id)).toEqual(['u1', 'a1']);
    expect(readMessageLiveVersion('/session/a.jsonl')).toBe(1);
    expect(useStore.getState().todosBySession['/session/a.jsonl']).toEqual([
      { content: 'kept todo', activeForm: 'keeping todo', status: 'in_progress' },
    ]);
    expect(useStore.getState().sessionRegistryFilesByPath['/session/a.jsonl']).toEqual([
      { fileId: 'kept-file', filePath: '/tmp/kept.txt' },
    ]);
  });

  it('session_branch_reset 带 sessionFiles 时，通过 applyBranchResetSessionFiles 整表替换 registry（#2188）', () => {
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: { id: 'u1', role: 'user', text: 'old' },
    });
    useStore.getState().setSessionRegistryFiles('/session/a.jsonl', [{ fileId: 'old-file', filePath: '/tmp/old.txt' }]);
    const spy = vi.spyOn(useStore.getState(), 'applyBranchResetSessionFiles');

    handleServerMessage({
      type: 'session_branch_reset',
      sessionPath: '/session/a.jsonl',
      messageId: 'u1',
      todos: [],
      sessionFiles: [{ fileId: 'kept-file', filePath: '/tmp/kept.txt' }],
    });

    expect(spy).toHaveBeenCalledWith('/session/a.jsonl', [{ fileId: 'kept-file', filePath: '/tmp/kept.txt' }]);
    expect(useStore.getState().sessionRegistryFilesByPath['/session/a.jsonl']).toEqual([
      { fileId: 'kept-file', filePath: '/tmp/kept.txt' },
    ]);
    spy.mockRestore();
  });

  it('session_branch_reset 不带 sessionFiles 时，仍调用 applyBranchResetSessionFiles(path, null) 而不是跳过', () => {
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: { id: 'u1', role: 'user', text: 'old' },
    });
    useStore.getState().setSessionRegistryFiles('/session/a.jsonl', [{ fileId: 'old-file', filePath: '/tmp/old.txt' }]);
    const spy = vi.spyOn(useStore.getState(), 'applyBranchResetSessionFiles');

    handleServerMessage({
      type: 'session_branch_reset',
      sessionPath: '/session/a.jsonl',
      messageId: 'u1',
      todos: [],
    });

    expect(spy).toHaveBeenCalledWith('/session/a.jsonl', null);
    // registry 未被清空／覆盖：applyBranchResetSessionFiles(path, null) 只标记 resetSeen，不动 registry
    expect(useStore.getState().sessionRegistryFilesByPath['/session/a.jsonl']).toEqual([
      { fileId: 'old-file', filePath: '/tmp/old.txt' },
    ]);
    spy.mockRestore();
  });

  it('session_branch_reset 在 live client id 失配时回退到历史 sourceEntryId', () => {
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: { id: 'history-0', sourceEntryId: 'entry-u1', role: 'user', text: 'fork point' },
    });
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: { id: 'history-1', role: 'assistant', blocks: [] },
    });

    handleServerMessage({
      type: 'session_branch_reset',
      sessionPath: '/session/a.jsonl',
      clientMessageId: 'source-live-uuid',
      messageId: 'entry-u1',
      todos: [],
      sessionFiles: [],
    });

    expect(useStore.getState().chatSessions['/session/a.jsonl']?.items).toEqual([]);
  });

  it('session_branch_reset 用显式投影边界截断隐藏输入触发的 Agent turn', () => {
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: { id: 'u1', sourceEntryId: 'entry-visible-user', role: 'user', text: 'visible question' },
    });
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: { id: 'a1', sourceEntryId: 'entry-visible-assistant', role: 'assistant', blocks: [] },
    });
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: {
        id: 'a2',
        sourceEntryId: 'entry-hidden-assistant',
        turnInputEntryId: 'entry-hidden-input',
        role: 'assistant',
        blocks: [],
      },
    });

    handleServerMessage({
      type: 'session_branch_reset',
      sessionPath: '/session/a.jsonl',
      messageId: 'entry-hidden-input',
      projectionMessageId: 'entry-hidden-assistant',
      todos: [],
      sessionFiles: [],
    });

    const items = useStore.getState().chatSessions['/session/a.jsonl']?.items || [];
    expect(items.map(item => item.type === 'message' ? item.data.id : item.id)).toEqual(['u1', 'a1']);
  });

  it('session_branch_reset 在首个持久化回复不可见时按 turn input 截断可见回复', () => {
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: { id: 'u1', sourceEntryId: 'entry-visible-user', role: 'user', text: 'visible question' },
    });
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: { id: 'a1', sourceEntryId: 'entry-visible-assistant', role: 'assistant', blocks: [] },
    });
    useStore.getState().appendItem('/session/a.jsonl', {
      type: 'message',
      data: {
        id: 'visible-success',
        sourceEntryId: 'entry-success-assistant',
        turnInputEntryId: 'entry-hidden-input',
        role: 'assistant',
        blocks: [],
      },
    });

    handleServerMessage({
      type: 'session_branch_reset',
      sessionPath: '/session/a.jsonl',
      messageId: 'entry-hidden-input',
      projectionMessageId: 'entry-empty-error-assistant',
      todos: [],
      sessionFiles: [],
    });

    const items = useStore.getState().chatSessions['/session/a.jsonl']?.items || [];
    expect(items.map(item => item.type === 'message' ? item.data.id : item.id)).toEqual(['u1', 'a1']);
  });

  it('computer_overlay 写入当前 session 的 overlay keyed 状态并支持 clear', () => {
    handleServerMessage({
      type: 'computer_overlay',
      sessionPath: '/session/a.jsonl',
      phase: 'running',
      action: 'click_element',
      leaseId: 'lease-1',
      snapshotId: 'snapshot-1',
      visualSurface: 'provider',
      target: { coordinateSpace: 'element', elementId: 'mock-button' },
      ts: 100,
    });

    expect(useStore.getState().computerOverlayBySession['/session/a.jsonl']).toMatchObject({
      phase: 'running',
      action: 'click_element',
      leaseId: 'lease-1',
      visualSurface: 'provider',
    });

    handleServerMessage({
      type: 'computer_overlay',
      sessionPath: '/session/a.jsonl',
      phase: 'clear',
      action: 'stop',
      ts: 101,
    });

    expect(useStore.getState().computerOverlayBySession['/session/a.jsonl']).toBeUndefined();
  });

  it('tool_end 带 sessionFile 时更新 session registry 文件状态', () => {
    handleServerMessage({
      type: 'tool_end',
      sessionPath: '/session/a.jsonl',
      name: 'write',
      success: true,
      details: {
        sessionFile: {
          fileId: 'sf_write',
          filePath: '/workspace/draft.md',
          label: 'draft.md',
          operations: ['created'],
        },
      },
    });

    expect(useStore.getState().sessionRegistryFilesByPath['/session/a.jsonl']).toEqual([
      expect.objectContaining({
        fileId: 'sf_write',
        filePath: '/workspace/draft.md',
        operations: ['created'],
      }),
    ]);
    expect(previewRefreshMocks.refreshOpenPreviewDocumentsForResourceChange).not.toHaveBeenCalled();
  });

  it('content_block 文件事件把 resource envelope 同步进 session registry', () => {
    handleServerMessage({
      type: 'content_block',
      sessionPath: '/session/a.jsonl',
      block: {
        type: 'file',
        fileId: 'sf_generated',
        filePath: '/generated/image.png',
        label: 'image.png',
        ext: 'png',
        mime: 'image/png',
        kind: 'image',
        resource: {
          schemaVersion: 1,
          resourceId: 'res_sf_generated',
          name: 'studios/studio_1/resources/res_sf_generated',
          studioId: 'studio_1',
          type: 'file',
          source: 'session_file',
          fileId: 'sf_generated',
          lifecycle: { status: 'available', missingAt: null },
          storage: { provider: 'session_file', localOnly: true },
          links: {
            self: '/api/resources/res_sf_generated',
            content: '/api/resources/res_sf_generated/content',
          },
        },
      },
    });

    expect(useStore.getState().sessionRegistryFilesByPath['/session/a.jsonl']).toEqual([
      expect.objectContaining({
        fileId: 'sf_generated',
        resource: expect.objectContaining({
          resourceId: 'res_sf_generated',
          links: expect.objectContaining({
            content: '/api/resources/res_sf_generated/content',
          }),
        }),
      }),
    ]);
  });

  it('todo_write 全部 completed 时按生命周期移除当前 session todo', () => {
    useStore.setState({
      currentSessionPath: '/session/a.jsonl',
      todosBySession: {
        '/session/a.jsonl': [{ content: 'old', activeForm: 'doing old', status: 'in_progress' }],
      },
      todosLiveVersionBySession: {},
    } as never);

    handleServerMessage({
      type: 'tool_end',
      sessionPath: '/session/a.jsonl',
      name: 'todo_write',
      success: true,
      details: {
        todos: [
          { content: 'old', activeForm: 'doing old', status: 'completed' },
        ],
      },
    });

    expect(useStore.getState().todosBySession['/session/a.jsonl']).toEqual([]);
    expect(useStore.getState().todosLiveVersionBySession['/session/a.jsonl']).toBe(1);
  });

  it('todo_update 事件按 sessionPath 更新 keyed todos', () => {
    useStore.setState({
      currentSessionPath: '/session/a.jsonl',
      todosBySession: {
        '/session/a.jsonl': [{ content: 'a', activeForm: 'doing a', status: 'pending' }],
        '/session/b.jsonl': [{ content: 'b', activeForm: 'doing b', status: 'pending' }],
      },
    } as never);

    handleServerMessage({
      type: 'todo_update',
      sessionPath: '/session/b.jsonl',
      todos: [],
    });

    expect(useStore.getState().todosBySession['/session/a.jsonl']).toEqual([
      { content: 'a', activeForm: 'doing a', status: 'pending' },
    ]);
    expect(useStore.getState().todosBySession['/session/b.jsonl']).toEqual([]);
  });

  it('bridge_rc_attached / detached 直接补丁 sessions 列表上的接管态', () => {
    handleServerMessage({
      type: 'bridge_rc_attached',
      sessionPath: '/session/a.jsonl',
      sessionKey: 'feishu_dm_1@a1',
      platform: 'feishu',
      title: 'A',
    });

    expect(useStore.getState().sessions[0]?.rcAttachment).toEqual({
      sessionKey: 'feishu_dm_1@a1',
      platform: 'feishu',
      title: 'A',
    });

    handleServerMessage({
      type: 'bridge_rc_detached',
      sessionPath: '/session/a.jsonl',
    });

    expect(useStore.getState().sessions[0]?.rcAttachment).toBeNull();
  });

  it('patches session metadata updates and syncs focused thinking level', () => {
    useStore.setState({
      currentSessionPath: '/session/a.jsonl',
      thinkingLevel: 'medium',
      sessions: [
        {
          path: '/session/a.jsonl',
          title: 'A',
          firstMessage: 'hello',
          modified: '2026-04-24T10:00:00.000Z',
          messageCount: 1,
          agentId: 'a1',
          agentName: 'Hana',
          cwd: null,
          pinnedAt: null,
        },
        {
          path: '/session/b.jsonl',
          title: 'B',
          firstMessage: 'other',
          modified: '2026-04-24T10:00:00.000Z',
          messageCount: 1,
          agentId: 'a1',
          agentName: 'Hana',
          cwd: null,
          pinnedAt: null,
        },
      ],
    } as never);

    handleServerMessage({
      type: 'session_metadata_updated',
      sessionPath: '/session/a.jsonl',
      metadata: {
        pinnedAt: '2026-04-29T08:00:00.000Z',
        thinkingLevel: 'high',
      },
    });

    expect(useStore.getState().sessions.map(session => ({
      path: session.path,
      pinnedAt: session.pinnedAt,
    }))).toEqual([
      { path: '/session/a.jsonl', pinnedAt: '2026-04-29T08:00:00.000Z' },
      { path: '/session/b.jsonl', pinnedAt: null },
    ]);
    expect(useStore.getState().thinkingLevel).toBe('high');

    handleServerMessage({
      type: 'session_metadata_updated',
      sessionPath: '/session/b.jsonl',
      metadata: {
        thinkingLevel: 'off',
      },
    });

    expect(useStore.getState().thinkingLevel).toBe('high');
  });

  it('merges a pin order update into the matching session', () => {
    useStore.setState({
      sessions: [
        {
          path: '/session/a.jsonl',
          title: 'A',
          firstMessage: 'hello',
          modified: '2026-04-24T10:00:00.000Z',
          messageCount: 1,
          agentId: 'a1',
          agentName: 'Hana',
          cwd: null,
          pinnedAt: null,
        },
        {
          path: '/session/b.jsonl',
          title: 'B',
          firstMessage: 'other',
          modified: '2026-04-24T10:00:00.000Z',
          messageCount: 1,
          agentId: 'a1',
          agentName: 'Hana',
          cwd: null,
          pinnedAt: '2026-04-29T08:00:00.000Z',
        },
      ],
    } as never);

    handleServerMessage({
      type: 'session_metadata_updated',
      sessionPath: '/session/b.jsonl',
      metadata: { pinOrder: 3072 },
    });

    expect(useStore.getState().sessions.map(session => ({
      path: session.path,
      pinOrder: session.pinOrder,
    }))).toEqual([
      { path: '/session/a.jsonl', pinOrder: undefined },
      { path: '/session/b.jsonl', pinOrder: 3072 },
    ]);

    handleServerMessage({
      type: 'session_metadata_updated',
      sessionPath: '/session/b.jsonl',
      metadata: { pinnedAt: null, pinOrder: null },
    });

    expect(useStore.getState().sessions[1]).toMatchObject({
      pinnedAt: null,
      pinOrder: null,
    });
  });
});

describe('ws-message-handler activity updates', () => {
  beforeEach(() => {
    useStore.setState({
      activities: [
        { id: 'activity-1', type: 'beautify', status: 'running', summary: '旧状态' },
        { id: 'activity-2', type: 'cron', status: 'done', summary: '另一条活动' },
      ],
    } as never);
  });

  it('merges activity_update by id so stale running cards do not remain in the panel', () => {
    handleServerMessage({
      type: 'activity_update',
      activity: { id: 'activity-1', type: 'beautify', status: 'done', summary: '新状态' },
    });

    expect(useStore.getState().activities).toEqual([
      { id: 'activity-1', type: 'beautify', status: 'done', summary: '新状态' },
      { id: 'activity-2', type: 'cron', status: 'done', summary: '另一条活动' },
    ]);
  });
});

describe('ws-message-handler permission mode events', () => {
  let windowTarget: EventTarget;

  beforeEach(() => {
    windowTarget = new EventTarget();
    vi.stubGlobal('window', windowTarget);
    useStore.setState({
      currentSessionPath: '/session/a.jsonl',
      pendingNewSession: false,
    } as never);
  });

  it('keeps explicit auto mode from legacy plan_mode messages instead of collapsing to operate', () => {
    const details: unknown[] = [];
    windowTarget.addEventListener('hana-plan-mode', (event) => {
      details.push((event as CustomEvent).detail);
    });

    handleServerMessage({
      type: 'plan_mode',
      sessionPath: '/session/a.jsonl',
      enabled: false,
      mode: 'auto',
    });

    expect(details).toEqual([{ enabled: false, mode: 'auto' }]);
  });

  it('syncs explicit permission_mode messages for the focused session', () => {
    const details: unknown[] = [];
    windowTarget.addEventListener('hana-plan-mode', (event) => {
      details.push((event as CustomEvent).detail);
    });

    handleServerMessage({
      type: 'permission_mode',
      sessionPath: '/session/a.jsonl',
      mode: 'ask',
    });

    expect(details).toEqual([{ enabled: false, mode: 'ask' }]);
  });
});

describe('ws-message-handler background chat stream routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      currentSessionPath: '/session/a.jsonl',
      pendingNewSession: false,
      sessions: [
        {
          path: '/session/a.jsonl',
          title: 'A',
          firstMessage: 'hello',
          modified: '2026-04-24T10:00:00.000Z',
          messageCount: 1,
          agentId: 'a1',
          agentName: 'Hana',
          cwd: null,
        },
        {
          path: '/session/b.jsonl',
          title: 'B',
          firstMessage: 'hi',
          modified: '2026-04-24T10:01:00.000Z',
          messageCount: 1,
          agentId: 'a1',
          agentName: 'Hana',
          cwd: null,
        },
      ],
      chatSessions: {},
      streamingSessions: [],
    } as never);
    useStore.getState().clearSession('/session/a.jsonl');
    useStore.getState().clearSession('/session/b.jsonl');
    useStore.getState().initSession('/session/a.jsonl', [], false);
    useStore.getState().initSession('/session/b.jsonl', [], false);
  });

  it('非当前 session 的正文流也进入主聊天 buffer，同时保留 streamKey 预览分发', () => {
    const msg = {
      type: 'text_delta',
      sessionPath: '/session/b.jsonl',
      delta: '后台正文',
    };

    handleServerMessage(msg);

    expect(streamBufferManager.handle).toHaveBeenCalledWith(msg);
    expect(dispatchStreamKey).toHaveBeenCalledWith('/session/b.jsonl', msg);
  });

  it('远程端写入的用户消息会按 sessionPath 同步到桌面端后台会话缓存', () => {
    handleServerMessage({
      type: 'session_user_message',
      sessionPath: '/session/b.jsonl',
      message: {
        id: 'mobile-u1',
        text: '手机端发来的消息',
        timestamp: '2026-05-16T00:00:00.000Z',
      },
    });

    const items = useStore.getState().chatSessions['/session/b.jsonl']?.items || [];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'message',
      data: {
        id: 'mobile-u1',
        role: 'user',
        text: '手机端发来的消息',
      },
    });
  });
});

describe('ws-message-handler compaction lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      currentSessionPath: '/session/a.jsonl',
      pendingNewSession: false,
      sessions: [
        {
          path: '/session/a.jsonl',
          title: 'A',
          firstMessage: 'hello',
          modified: '2026-04-24T10:00:00.000Z',
          messageCount: 1,
          agentId: 'a1',
          agentName: 'Hana',
          cwd: null,
        },
        {
          path: '/session/b.jsonl',
          title: 'B',
          firstMessage: 'hi',
          modified: '2026-04-24T10:01:00.000Z',
          messageCount: 1,
          agentId: 'a1',
          agentName: 'Hana',
          cwd: null,
        },
      ],
      chatSessions: {},
      compactingSessions: [],
      compactionModeBySession: {},
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      contextBySession: {},
      sessionLocatorsById: {},
      toasts: [],
    } as never);
  });

  it('tracks compaction_start for a background session before stream routing returns', () => {
    handleServerMessage({
      type: 'compaction_start',
      sessionPath: '/session/b.jsonl',
      reason: 'threshold',
      mode: 'lossy_local',
    });

    expect(useStore.getState().compactingSessions).toEqual(['/session/b.jsonl']);
    expect(useStore.getState().compactionModeBySession).toEqual({
      '/session/b.jsonl': 'lossy_local',
    });
  });

  it('tracks compaction_end and preserves the provided context window when tokens are unknown', () => {
    useStore.setState({
      compactingSessions: ['/session/b.jsonl'],
      compactionModeBySession: { '/session/b.jsonl': 'lossy_local' },
    } as never);

    handleServerMessage({
      type: 'compaction_end',
      sessionPath: '/session/b.jsonl',
      tokens: null,
      contextWindow: 200_000,
      percent: null,
    });

    expect(useStore.getState().compactingSessions).toEqual([]);
    expect(useStore.getState().compactionModeBySession).toEqual({});
    expect(useStore.getState().contextBySession['/session/b.jsonl']).toEqual({
      tokens: null,
      window: 200_000,
      percent: null,
    });
  });

  it('routes lifecycle by sessionId without trusting stale path metadata as locator truth', () => {
    useStore.setState({
      sessionLocatorsById: {
        sess_b: { path: '/session/current-b.jsonl' },
      },
    } as never);

    handleServerMessage({
      type: 'compaction_start',
      sessionId: 'sess_b',
      sessionPath: '/session/stale-a.jsonl',
      reason: 'manual',
    });

    expect(useStore.getState().compactingSessions).toEqual(['sess_b']);
    expect(useStore.getState().sessionLocatorsById.sess_b).toEqual({ path: '/session/current-b.jsonl' });

    handleServerMessage({
      type: 'compaction_end',
      sessionId: 'sess_b',
      sessionPath: '/session/stale-a.jsonl',
      tokens: 20_000,
      contextWindow: 200_000,
      percent: 10,
    });

    expect(useStore.getState().compactingSessions).toEqual([]);
    expect(useStore.getState().contextBySession.sess_b).toEqual({
      tokens: 20_000,
      window: 200_000,
      percent: 10,
    });
    expect(useStore.getState().sessionLocatorsById.sess_b).toEqual({ path: '/session/current-b.jsonl' });
  });

  it('tracks accepted and clears succeeded results by sessionId', () => {
    handleServerMessage({ type: 'compaction_accepted', sessionId: 'sess_a', mode: 'lossy_local' });
    expect(useStore.getState().compactingSessions).toEqual(['sess_a']);
    expect(useStore.getState().compactionModeBySession).toEqual({ sess_a: 'lossy_local' });

    handleServerMessage({ type: 'compaction_start', sessionId: 'sess_a' });
    expect(useStore.getState().compactionModeBySession).toEqual({ sess_a: 'lossy_local' });

    handleServerMessage({ type: 'compaction_result', sessionId: 'sess_a', status: 'succeeded' });
    expect(useStore.getState().compactingSessions).toEqual([]);
    expect(useStore.getState().compactionModeBySession).toEqual({});
  });

  it('clears busy and surfaces noop and failed results', () => {
    for (const [status, message] of [
      ['noop', 'Nothing to compact'],
      ['failed', 'Compaction failed: provider unavailable'],
    ]) {
      handleServerMessage({ type: 'compaction_accepted', sessionId: 'sess_a' });
      handleServerMessage({ type: 'compaction_result', sessionId: 'sess_a', status, message });
    }

    expect(useStore.getState().compactingSessions).toEqual([]);
    expect(useStore.getState().toasts.slice(-2)).toEqual([
      expect.objectContaining({ text: 'Nothing to compact', type: 'info' }),
      expect.objectContaining({ text: 'Compaction failed: provider unavailable', type: 'error' }),
    ]);
  });

  it('preserves context_usage window even when tokens are unknown', () => {
    handleServerMessage({
      type: 'context_usage',
      sessionPath: '/session/a.jsonl',
      tokens: null,
      contextWindow: 200_000,
      percent: null,
    });

    expect(useStore.getState().contextBySession['/session/a.jsonl']).toEqual({
      tokens: null,
      window: 200_000,
      percent: null,
    });
  });
});

describe('ws-message-handler app events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureWsMessageHandler({});
  });

  it('app_event 消息会 route 到 handleAppEvent', () => {
    handleServerMessage({
      type: 'app_event',
      event: {
        type: 'models-changed',
        payload: { reason: 'provider' },
        source: 'server',
      },
    });

    expect(handleAppEvent).toHaveBeenCalledWith('models-changed', { reason: 'provider' }, { source: 'server' });
  });

  it('resource.changed 消息会刷新匹配的打开预览文档', () => {
    const msg = {
      type: 'resource.changed',
      filePath: '/workspace/notes/a.md',
      resource: { kind: 'local-file', provider: 'local_fs', path: '/workspace/notes/a.md' },
    };

    handleServerMessage(msg);

    expect(previewRefreshMocks.refreshOpenPreviewDocumentsForResourceChange).toHaveBeenCalledWith(
      msg,
      previewRefreshMocks.changeOptions,
    );
  });

  it('resource.deleted 和 resource.renamed 消息也走同一条刷新路径', () => {
    const deletedMsg = {
      type: 'resource.deleted',
      resource: { kind: 'local-file', provider: 'local_fs', path: '/workspace/notes/deleted.md' },
    };
    const renamedMsg = {
      type: 'resource.renamed',
      oldResource: { kind: 'local-file', provider: 'local_fs', path: '/workspace/notes/old.md' },
      newResource: { kind: 'local-file', provider: 'local_fs', path: '/workspace/notes/new.md' },
    };

    handleServerMessage(deletedMsg);
    handleServerMessage(renamedMsg);

    expect(previewRefreshMocks.markDeskTreeDirtyForResourceChange).toHaveBeenCalledWith(deletedMsg);
    expect(previewRefreshMocks.markDeskTreeDirtyForResourceChange).toHaveBeenCalledWith(renamedMsg);
    expect(previewRefreshMocks.refreshOpenPreviewDocumentsForResourceChange).toHaveBeenCalledWith(
      deletedMsg,
      previewRefreshMocks.changeOptions,
    );
    expect(previewRefreshMocks.refreshOpenPreviewDocumentsForResourceChange).toHaveBeenCalledWith(
      renamedMsg,
      previewRefreshMocks.changeOptions,
    );
  });
});

describe('ws-message-handler turn_end side effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      currentSessionId: null,
      currentSessionPath: '/session/a.jsonl',
      pendingNewSession: false,
      sessionLocatorsById: {},
      sessions: [{
        path: '/session/a.jsonl',
        title: 'A',
        firstMessage: 'hello',
        modified: '2026-04-24T10:00:00.000Z',
        messageCount: 1,
        agentId: 'a1',
        agentName: 'Hana',
        cwd: null,
      }],
      chatSessions: {},
      streamingSessions: [],
      inputFocusTrigger: 0,
    } as never);
  });

  it('turn_end for the current session does not request input focus', () => {
    handleServerMessage({
      type: 'turn_end',
      sessionPath: '/session/a.jsonl',
    });

    expect(useStore.getState().inputFocusTrigger).toBe(0);
    expect(previewRefreshMocks.refreshOpenPreviewDocumentsForResourceChange).not.toHaveBeenCalled();
  });

  it('background turn_end keeps refresh and context usage but does not request input focus', async () => {
    vi.useFakeTimers();
    vi.mocked(loadSessions).mockClear();
    const requestContextUsage = vi.fn();
    configureWsMessageHandler({ requestContextUsage });
    useStore.setState({
      sessions: [
        ...useStore.getState().sessions,
        {
          path: '/session/b.jsonl',
          title: 'B',
          firstMessage: 'background',
          modified: '2026-04-24T10:01:00.000Z',
          messageCount: 1,
          agentId: 'a1',
          agentName: 'Hana',
          cwd: null,
        },
      ],
    } as never);

    handleServerMessage({
      type: 'turn_end',
      sessionPath: '/session/b.jsonl',
    });

    expect(useStore.getState().inputFocusTrigger).toBe(0);
    expect(requestContextUsage).toHaveBeenCalledWith('/session/b.jsonl');
    expect(loadSessions).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);

    expect(loadSessions).toHaveBeenCalledTimes(1);
  });

  it('status=false requests input focus when the focused session was streaming', () => {
    useStore.setState({
      streamingSessions: ['/session/a.jsonl'],
      inputFocusTrigger: 0,
    } as never);

    handleServerMessage({
      type: 'status',
      sessionPath: '/session/a.jsonl',
      isStreaming: false,
    });

    expect(useStore.getState().streamingSessions).toEqual([]);
    expect(useStore.getState().inputFocusTrigger).toBe(1);
    expect(useStore.getState().inputFocusTriggerSource).toBe('restore');
  });

  it('stale status=false does not finish the newer local stream turn', () => {
    vi.mocked(streamBufferManager.finishTurn).mockClear();
    useStore.setState({
      streamingSessions: ['/session/a.jsonl'],
      activeSessionStreams: {
        '/session/a.jsonl': { streamId: 'stream_new', turnId: null },
      },
      inputFocusTrigger: 0,
    } as never);

    handleServerMessage({
      type: 'status',
      sessionPath: '/session/a.jsonl',
      streamId: 'stream_old',
      isStreaming: false,
    });

    expect(useStore.getState().streamingSessions).toEqual(['/session/a.jsonl']);
    expect(streamBufferManager.finishTurn).not.toHaveBeenCalledWith('/session/a.jsonl');
    expect(useStore.getState().inputFocusTrigger).toBe(0);
  });

  it('identity-less status=false does not finish a stream with a known streamId', () => {
    vi.mocked(streamBufferManager.finishTurn).mockClear();
    useStore.setState({
      streamingSessions: ['/session/a.jsonl'],
      activeSessionStreams: {
        '/session/a.jsonl': { streamId: 'stream_new', turnId: null },
      },
      inputFocusTrigger: 0,
    } as never);

    handleServerMessage({
      type: 'status',
      sessionPath: '/session/a.jsonl',
      isStreaming: false,
    });

    expect(useStore.getState().streamingSessions).toEqual(['/session/a.jsonl']);
    expect(streamBufferManager.finishTurn).not.toHaveBeenCalledWith('/session/a.jsonl');
    expect(useStore.getState().inputFocusTrigger).toBe(0);
  });

  it('already_stopped abort_result clears a stale streaming marker when no stream identity exists', () => {
    vi.mocked(streamBufferManager.finishTurn).mockClear();
    useStore.setState({
      streamingSessions: ['/session/a.jsonl'],
      activeSessionStreams: {},
      inputFocusTrigger: 0,
    } as never);

    handleServerMessage({
      type: 'abort_result',
      status: 'already_stopped',
      sessionPath: '/session/a.jsonl',
      streamId: null,
    });

    expect(useStore.getState().streamingSessions).toEqual([]);
    expect(streamBufferManager.finishTurn).toHaveBeenCalledWith('/session/a.jsonl', null);
    expect(useStore.getState().inputFocusTrigger).toBe(1);
  });

  it('rejected abort_result leaves local stream state untouched', () => {
    useStore.setState({
      streamingSessions: ['/session/a.jsonl'],
      activeSessionStreams: {
        '/session/a.jsonl': { streamId: 'stream_old', turnId: null },
      },
    } as never);

    handleServerMessage({
      type: 'abort_result',
      status: 'rejected',
      reason: 'stale_stream',
      sessionPath: '/session/a.jsonl',
      streamId: 'stream_current',
    });

    expect(useStore.getState().streamingSessions).toEqual(['/session/a.jsonl']);
    expect(useStore.getState().activeSessionStreams['/session/a.jsonl']?.streamId).toBe('stream_old');
  });

  it('turn_end does not clear the matching stream before status=false arrives', () => {
    useStore.setState({
      streamingSessions: ['/session/a.jsonl'],
      activeSessionStreams: {
        '/session/a.jsonl': { streamId: 'stream_done', turnId: null },
      },
      inputFocusTrigger: 0,
    } as never);

    handleServerMessage({
      type: 'turn_end',
      sessionPath: '/session/a.jsonl',
      streamId: 'stream_done',
    });

    expect(useStore.getState().streamingSessions).toEqual(['/session/a.jsonl']);
    expect(useStore.getState().activeSessionStreams['/session/a.jsonl']?.streamId).toBe('stream_done');
    expect(useStore.getState().inputFocusTrigger).toBe(0);
  });

  it('intermediate turn_end keeps streaming state and input focus untouched', () => {
    useStore.setState({
      streamingSessions: ['/session/a.jsonl'],
      activeSessionStreams: {
        '/session/a.jsonl': { streamId: 'stream_mid', turnId: 'turn_mid' },
      },
      inputFocusTrigger: 0,
    } as never);

    handleServerMessage({
      type: 'turn_end',
      sessionPath: '/session/a.jsonl',
      streamId: 'stream_mid',
      turnId: 'turn_mid',
    });

    expect(useStore.getState().streamingSessions).toEqual(['/session/a.jsonl']);
    expect(useStore.getState().activeSessionStreams['/session/a.jsonl']).toEqual({
      streamId: 'stream_mid',
      turnId: 'turn_mid',
    });
    expect(useStore.getState().inputFocusTrigger).toBe(0);
  });

  it('stale turn_end does not clear a newer stream identity', () => {
    useStore.setState({
      streamingSessions: ['/session/a.jsonl'],
      activeSessionStreams: {
        '/session/a.jsonl': { streamId: 'stream_new', turnId: null },
      },
      inputFocusTrigger: 0,
    } as never);

    handleServerMessage({
      type: 'turn_end',
      sessionPath: '/session/a.jsonl',
      streamId: 'stream_old',
    });

    expect(useStore.getState().streamingSessions).toEqual(['/session/a.jsonl']);
    expect(useStore.getState().activeSessionStreams['/session/a.jsonl']?.streamId).toBe('stream_new');
  });

  it('passes sessionId from status events into stream buffer lifecycle', () => {
    const sessionId = 'sess_status_stream';
    vi.mocked(streamBufferManager.beginTurn).mockClear();
    vi.mocked(streamBufferManager.finishTurn).mockClear();
    useStore.setState({
      currentSessionId: sessionId,
      currentSessionPath: '/session/a-renamed.jsonl',
      sessions: [{
        path: '/session/a-renamed.jsonl',
        sessionId,
        title: 'A',
        firstMessage: 'hello',
        modified: '2026-04-24T10:00:00.000Z',
        messageCount: 1,
      }],
      sessionLocatorsById: { [sessionId]: { path: '/session/a-renamed.jsonl' } },
      streamingSessions: [],
      activeSessionStreams: {},
    } as never);

    handleServerMessage({
      type: 'status',
      sessionId,
      sessionPath: '/session/a-renamed.jsonl',
      streamId: 'stream_status',
      isStreaming: true,
    });

    expect(streamBufferManager.beginTurn).toHaveBeenCalledWith('/session/a-renamed.jsonl', sessionId);

    handleServerMessage({
      type: 'status',
      sessionId,
      sessionPath: '/session/a-renamed.jsonl',
      streamId: 'stream_status',
      isStreaming: false,
    });

    expect(streamBufferManager.finishTurn).toHaveBeenCalledWith('/session/a-renamed.jsonl', sessionId);
  });

  it('background status=false does not request input focus', () => {
    useStore.setState({
      streamingSessions: ['/session/b.jsonl'],
      inputFocusTrigger: 0,
    } as never);

    handleServerMessage({
      type: 'status',
      sessionPath: '/session/b.jsonl',
      isStreaming: false,
    });

    expect(useStore.getState().inputFocusTrigger).toBe(0);
  });

  it('turn_end requests context usage through the injected callback', () => {
    const requestContextUsage = vi.fn();
    configureWsMessageHandler({ requestContextUsage });

    handleServerMessage({
      type: 'turn_end',
      sessionPath: '/session/a.jsonl',
    });

    expect(requestContextUsage).toHaveBeenCalledWith('/session/a.jsonl');
  });

  it('shows focused slash_result through the inline notice bridge', () => {
    const windowTarget = new EventTarget();
    vi.stubGlobal('window', windowTarget);
    const listener = vi.fn();
    window.addEventListener('hana-inline-notice', listener);

    try {
      handleServerMessage({
        type: 'slash_result',
        sessionPath: '/session/a.jsonl',
        text: 'plugin command finished',
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
        text: 'plugin command finished',
        type: 'success',
      });
    } finally {
      window.removeEventListener('hana-inline-notice', listener);
      vi.unstubAllGlobals();
    }
  });

  it('does not mark an old browser thumbnail as fresh when a running update omits thumbnail data', () => {
    vi.stubGlobal('window', { platform: {} });
    useStore.setState({
      browserBySession: {
        '/session/a.jsonl': {
          running: true,
          url: 'https://old.example',
          thumbnail: 'OLD_THUMB',
          thumbnailCapturedAt: 111,
          thumbnailUrl: 'https://old.example',
          thumbnailFresh: true,
        },
      },
    } as never);

    handleServerMessage({
      type: 'browser_status',
      sessionPath: '/session/a.jsonl',
      running: true,
      url: 'https://new.example',
    });

    expect(useStore.getState().browserBySession['/session/a.jsonl']).toMatchObject({
      running: true,
      url: 'https://new.example',
      thumbnail: 'OLD_THUMB',
      thumbnailCapturedAt: 111,
      thumbnailUrl: 'https://old.example',
      thumbnailFresh: false,
    });
  });

  it('keys browser status by sessionId when the locator is known', () => {
    vi.stubGlobal('window', { platform: {} });
    useStore.setState({
      currentSessionPath: '/session/a-renamed.jsonl',
      currentSessionId: 'sess_browser_a',
      sessions: [{
        path: '/session/a-renamed.jsonl',
        sessionId: 'sess_browser_a',
      }],
      sessionLocatorsById: {
        sess_browser_a: { path: '/session/a-renamed.jsonl' },
      },
      browserBySession: {
        '/session/a-renamed.jsonl': {
          running: true,
          url: 'https://old.example',
          thumbnail: 'OLD_THUMB',
          thumbnailCapturedAt: 111,
          thumbnailUrl: 'https://old.example',
          thumbnailFresh: true,
        },
      },
    } as never);

    handleServerMessage({
      type: 'browser_status',
      sessionPath: '/session/a-renamed.jsonl',
      running: true,
      url: 'https://new.example',
    });

    expect(useStore.getState().browserBySession.sess_browser_a).toMatchObject({
      running: true,
      url: 'https://new.example',
      thumbnail: 'OLD_THUMB',
      thumbnailCapturedAt: 111,
      thumbnailUrl: 'https://old.example',
      thumbnailFresh: false,
    });
    expect(useStore.getState().browserBySession['/session/a-renamed.jsonl']).toBeUndefined();
  });

  it('coalesces rapid turn_end session refreshes into one list request', async () => {
    vi.useFakeTimers();
    const requestContextUsage = vi.fn();
    configureWsMessageHandler({ requestContextUsage });

    handleServerMessage({
      type: 'turn_end',
      sessionPath: '/session/a.jsonl',
    });
    handleServerMessage({
      type: 'turn_end',
      sessionPath: '/session/a.jsonl',
    });

    expect(loadSessions).not.toHaveBeenCalled();
    expect(requestContextUsage).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(300);

    expect(loadSessions).toHaveBeenCalledTimes(1);
  });
});

describe('ws-message-handler error presentation', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { t: translateZh });
    useStore.setState({
      currentSessionPath: '/session/a.jsonl',
      pendingNewSession: false,
      sessionLocatorsById: {},
      sessions: [],
      inlineErrors: {},
      toasts: [],
    } as never);
  });

  it('shows the generic internal-contract sentence and hides the raw assertion in the details', () => {
    handleServerMessage({
      type: 'error',
      code: 'internal_contract',
      message: 'agentId required',
      sessionPath: '/session/a.jsonl',
    });

    const shown = useStore.getState().inlineErrors['/session/a.jsonl'];
    expect(shown).toEqual({
      text: translateZh('error.code.internalContract'),
      detail: 'agentId required',
      code: 'internal_contract',
    });
    expect(shown?.text).not.toContain('agentId');
  });

  // 一条既没有 sessionPath 也没有 sessionId 的身份错误没有会话可以挂靠，只能走 toast。
  // 少了这一档，服务端认定的调用方 bug 会退化成一行 console.warn，用户什么也看不到。
  it('toasts an identity error that carries no session to attach to', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    handleServerMessage({
      type: 'error',
      code: 'internal_contract',
      message: 'session identity required',
    });

    expect(useStore.getState().toasts).toEqual([expect.objectContaining({
      text: translateZh('error.code.internalContract'),
      type: 'error',
      errorCode: 'internal_contract',
    })]);
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });
});
