// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// handleServerMessage pulls in the full renderer dependency graph; stub the
// heavy collaborators so this file can focus on the notification → showNotification hop.
vi.mock('../../hooks/use-stream-buffer', () => ({
  streamBufferManager: { handle: vi.fn(), beginTurn: vi.fn(), finishTurn: vi.fn() },
}));
vi.mock('../../stores/session-actions', () => ({ loadSessions: vi.fn() }));
vi.mock('../../stores/desk-actions', () => ({ loadDeskFiles: vi.fn() }));
vi.mock('../../stores/channel-actions', () => ({ loadChannels: vi.fn(), openChannel: vi.fn() }));
vi.mock('../../stores/preview-actions', () => ({ handleLegacyArtifactBlock: vi.fn() }));
vi.mock('../../services/app-event-actions', () => ({ handleAppEvent: vi.fn() }));
vi.mock('../../services/stream-resume', () => ({
  replayStreamResume: vi.fn(),
  isStreamResumeRebuilding: () => null,
  isStreamScopedMessage: () => false,
  updateSessionStreamMeta: vi.fn(),
}));
vi.mock('../../services/stream-key-dispatcher', () => ({ dispatchStreamKey: vi.fn() }));

import { handleServerMessage } from '../../services/ws-message-handler';
import { useStore } from '../../stores';

describe('ws-message-handler desktop notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ currentSessionPath: null });
  });

  afterEach(() => {
    delete (window as unknown as { hana?: unknown }).hana;
  });

  it('把触发 agent 的 agentId 透传给 showNotification（多 agent 定时任务可分辨身份）', () => {
    const showNotification = vi.fn();
    (window as unknown as { hana: { showNotification: typeof showNotification } }).hana = { showNotification };

    handleServerMessage({
      type: 'notification',
      title: '提醒',
      body: '该喝水了',
      agentId: 'a2',
    });

    expect(showNotification).toHaveBeenCalledWith('提醒', '该喝水了', 'a2', {
      desktopFocusPolicy: 'always',
    });
  });

  it('agentId 缺失时透传 null，不从全局焦点兜底', () => {
    const showNotification = vi.fn();
    (window as unknown as { hana: { showNotification: typeof showNotification } }).hana = { showNotification };

    handleServerMessage({
      type: 'notification',
      title: '提醒',
      body: '正文',
      agentId: null,
    });

    expect(showNotification).toHaveBeenCalledWith('提醒', '正文', null, {
      desktopFocusPolicy: 'always',
    });
  });

  it('把 when_unfocused 策略透传给主进程，由桌面边界判断是否弹出', () => {
    const showNotification = vi.fn();
    (window as unknown as { hana: { showNotification: typeof showNotification } }).hana = { showNotification };

    handleServerMessage({
      type: 'notification',
      title: '完成',
      body: '这一轮已经结束',
      agentId: 'a2',
      desktopFocusPolicy: 'when_unfocused',
    });

    expect(showNotification).toHaveBeenCalledWith('完成', '这一轮已经结束', 'a2', {
      desktopFocusPolicy: 'when_unfocused',
    });
  });

  it('完成任务不是当前 Session 时，把 session-aware 通知转成 always', () => {
    const showNotification = vi.fn();
    (window as unknown as { hana: { showNotification: typeof showNotification } }).hana = { showNotification };
    useStore.setState({ currentSessionPath: '/tmp/current.jsonl' });

    handleServerMessage({
      type: 'notification',
      title: '完成',
      body: '这一轮已经结束',
      agentId: 'a2',
      desktopFocusPolicy: 'when_session_unfocused',
      sessionPath: '/tmp/finished.jsonl',
    });

    expect(showNotification).toHaveBeenCalledWith('完成', '这一轮已经结束', 'a2', {
      desktopFocusPolicy: 'always',
    });
  });

  it('完成任务正是当前 Session 时，把 session-aware 通知转成 when_unfocused', () => {
    const showNotification = vi.fn();
    (window as unknown as { hana: { showNotification: typeof showNotification } }).hana = { showNotification };
    useStore.setState({ currentSessionPath: '/tmp/finished.jsonl' });

    handleServerMessage({
      type: 'notification',
      title: '完成',
      body: '这一轮已经结束',
      agentId: 'a2',
      desktopFocusPolicy: 'when_session_unfocused',
      sessionPath: '/tmp/finished.jsonl',
    });

    expect(showNotification).toHaveBeenCalledWith('完成', '这一轮已经结束', 'a2', {
      desktopFocusPolicy: 'when_unfocused',
    });
  });
});
