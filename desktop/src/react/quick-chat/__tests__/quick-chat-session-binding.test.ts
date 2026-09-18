import { beforeEach, describe, expect, it, vi } from 'vitest';
import { streamBufferManager } from '../../hooks/use-stream-buffer';
import { handleServerMessage } from '../../services/ws-message-handler';
import { useStore } from '../../stores';
import { sessionScopedValue } from '../../stores/session-slice';
import { bindQuickChatDetachedSession } from '../QuickChatApp';

describe('quick chat detached session binding', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useStore.setState({
      currentSessionPath: '/sessions/main.jsonl',
      currentSessionId: 'sess_main',
      sessionLocatorsById: { sess_main: { path: '/sessions/main.jsonl' } },
      pendingNewSession: true,
      sessions: [],
      chatSessions: {},
      streamingSessions: [],
      activeSessionStreams: {},
      inlineErrors: {},
      currentAgentId: 'hana',
      agentName: 'Hana',
      welcomeVisible: true,
    } as never);
  });

  it('makes a new detached session the current session for this quick-chat renderer', () => {
    const beginTurn = vi.spyOn(streamBufferManager, 'beginTurn');

    bindQuickChatDetachedSession({
      path: '/sessions/quick.jsonl',
      sessionId: 'sess_quick',
      agentId: 'hana',
      agentName: 'Hana',
      now: '2026-07-03T00:00:00.000Z',
    });

    let state = useStore.getState();
    expect(state.currentSessionPath).toBe('/sessions/quick.jsonl');
    expect(state.currentSessionId).toBe('sess_quick');
    expect(state.sessionLocatorsById.sess_quick).toEqual({ path: '/sessions/quick.jsonl' });
    expect(state.pendingNewSession).toBe(false);
    expect(sessionScopedValue(state, state.chatSessions, '/sessions/quick.jsonl')).toMatchObject({
      items: [],
      hasMore: false,
    });

    handleServerMessage({
      type: 'status',
      sessionPath: '/sessions/quick.jsonl',
      sessionId: 'sess_quick',
      isStreaming: true,
    });

    expect(beginTurn).toHaveBeenCalledWith('/sessions/quick.jsonl', 'sess_quick');

    handleServerMessage({
      type: 'session_user_message',
      sessionPath: '/sessions/quick.jsonl',
      sessionId: 'sess_quick',
      message: { id: 'msg_user_1', text: 'hello from quick chat' },
    });

    state = useStore.getState();
    const items = sessionScopedValue(state, state.chatSessions, '/sessions/quick.jsonl')?.items || [];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'message',
      data: { role: 'user', text: 'hello from quick chat' },
    });
  });
});
