// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadMessages: vi.fn(async () => {}),
  clearChat: vi.fn(),
  streamBufferManager: {
    clear: vi.fn(),
    finishTurn: vi.fn(),
  },
  ws: {
    readyState: 1,
    send: vi.fn(),
  },
}));

vi.mock('../../hooks/use-stream-buffer', () => ({
  streamBufferManager: mocks.streamBufferManager,
}));

vi.mock('../../stores/session-actions', () => ({
  loadMessages: mocks.loadMessages,
}));

vi.mock('../../stores/agent-actions', () => ({
  clearChat: mocks.clearChat,
}));

import { useStore } from '../../stores';
import { invalidateStreamResumeMeta } from '../../stores/stream-invalidator';
import {
  injectHandlers,
  injectWebSocketGetter,
  getSessionStreamMeta,
  invalidateSessionStreamMeta,
  replayStreamResume,
  requestStreamResume,
  updateSessionStreamMeta,
} from '../../services/stream-resume';

describe('stream-resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      currentSessionPath: '/focused.jsonl',
      streamingSessions: ['/background.jsonl'],
      activeSessionStreams: {},
      sessions: [
        { path: '/focused.jsonl', title: 'focused' },
        { path: '/background.jsonl', title: 'background' },
      ],
      chatSessions: {
        '/focused.jsonl': { items: [], hasMore: false, loadingMore: false },
        '/background.jsonl': { items: [], hasMore: false, loadingMore: false },
      },
    } as never);
    injectWebSocketGetter(() => mocks.ws as unknown as WebSocket);
  });

  it('hydrates a completed empty resume for background sessions instead of leaving them stuck streaming', async () => {
    const statuses: Array<{ isStreaming: boolean; sessionPath: string | null }> = [];
    injectHandlers(vi.fn(), (isStreaming, sessionPath) => {
      statuses.push({ isStreaming, sessionPath });
      useStore.setState((state) => ({
        streamingSessions: isStreaming
          ? Array.from(new Set([...state.streamingSessions, sessionPath].filter(Boolean))) as string[]
          : state.streamingSessions.filter((path) => path !== sessionPath),
      }));
    });

    replayStreamResume({
      type: 'stream_resume',
      sessionPath: '/background.jsonl',
      streamId: 'stream_1',
      sinceSeq: 3,
      nextSeq: 4,
      isStreaming: false,
      reset: false,
      truncated: false,
      events: [],
    });

    await vi.waitFor(() => {
      expect(mocks.loadMessages).toHaveBeenCalledWith('/background.jsonl');
    });

    expect(mocks.streamBufferManager.finishTurn).toHaveBeenCalledWith('/background.jsonl');
    expect(mocks.streamBufferManager.clear).not.toHaveBeenCalledWith('/background.jsonl');
    expect(statuses).toContainEqual({ isStreaming: false, sessionPath: '/background.jsonl' });
    expect(useStore.getState().streamingSessions).toEqual([]);
  });

  it('replays background session events to the normal websocket handler', () => {
    const handled: unknown[] = [];
    const statuses: Array<{ isStreaming: boolean; sessionPath: string | null }> = [];
    injectHandlers((msg) => handled.push(msg), (isStreaming, sessionPath) => {
      statuses.push({ isStreaming, sessionPath });
    });

    replayStreamResume({
      type: 'stream_resume',
      sessionPath: '/background.jsonl',
      streamId: 'stream_2',
      sinceSeq: 1,
      nextSeq: 3,
      isStreaming: true,
      reset: false,
      truncated: false,
      events: [
        { seq: 2, event: { type: 'text_delta', delta: 'late text' } },
      ],
    });

    expect(handled).toEqual([
      expect.objectContaining({
        type: 'text_delta',
        delta: 'late text',
        sessionPath: '/background.jsonl',
        streamId: 'stream_2',
        seq: 2,
        __fromReplay: true,
      }),
    ]);
    expect(statuses).toEqual([{ isStreaming: true, sessionPath: '/background.jsonl' }]);
  });

  it('does not replay the same stream sequence twice when a resume response is repeated', () => {
    const handled: unknown[] = [];
    injectHandlers((msg) => handled.push(msg), vi.fn());

    const resume = {
      type: 'stream_resume',
      sessionPath: '/background.jsonl',
      streamId: 'stream_dedupe',
      sinceSeq: 0,
      nextSeq: 3,
      isStreaming: true,
      reset: false,
      truncated: false,
      events: [
        { seq: 1, event: { type: 'tool_start', name: 'echo', args: { value: 'one' } } },
        { seq: 2, event: { type: 'tool_end', name: 'echo', success: true } },
      ],
    };

    replayStreamResume(resume);
    replayStreamResume(resume);

    expect(handled).toHaveLength(2);
    expect(handled).toEqual([
      expect.objectContaining({ type: 'tool_start', seq: 1 }),
      expect.objectContaining({ type: 'tool_end', seq: 2 }),
    ]);
  });

  it('reports duplicate live stream sequences as already consumed', () => {
    expect(updateSessionStreamMeta({
      sessionPath: '/background.jsonl',
      streamId: 'stream_live_dedupe',
      seq: 1,
    })).toBe(true);

    expect(updateSessionStreamMeta({
      sessionPath: '/background.jsonl',
      streamId: 'stream_live_dedupe',
      seq: 1,
    })).toBe(false);
  });

  it('requests the current stream from the beginning after render state is invalidated', () => {
    updateSessionStreamMeta({
      sessionPath: '/background.jsonl',
      streamId: 'stream_lost_render_cache',
      seq: 42,
    });

    invalidateStreamResumeMeta('/background.jsonl');
    requestStreamResume('/background.jsonl');

    expect(mocks.ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'resume_stream',
      sessionPath: '/background.jsonl',
      streamId: null,
      sinceSeq: 0,
    }));
  });

  it('includes sessionId when requesting stream resume for a known locator', () => {
    useStore.setState({
      sessions: [{ path: '/background.jsonl', sessionId: 'sess_stream_resume' }] as never,
      sessionLocatorsById: { sess_stream_resume: { path: '/background.jsonl' } },
    } as never);

    requestStreamResume('/background.jsonl');

    expect(mocks.ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'resume_stream',
      sessionPath: '/background.jsonl',
      sessionId: 'sess_stream_resume',
      streamId: null,
      sinceSeq: 0,
    }));
  });

  it('keeps stream metadata under sessionId when the session locator changes', () => {
    useStore.setState({
      sessions: [{ path: '/old.jsonl', sessionId: 'sess_stream_meta' }] as never,
      sessionLocatorsById: { sess_stream_meta: { path: '/old.jsonl' } },
    } as never);

    updateSessionStreamMeta({
      sessionPath: '/old.jsonl',
      streamId: 'stream_by_id',
      seq: 12,
    });

    useStore.setState({
      sessions: [{ path: '/new.jsonl', sessionId: 'sess_stream_meta' }] as never,
      sessionLocatorsById: { sess_stream_meta: { path: '/new.jsonl' } },
    } as never);

    expect(getSessionStreamMeta('/new.jsonl')).toMatchObject({
      streamId: 'stream_by_id',
      lastSeq: 12,
    });

    invalidateSessionStreamMeta('/new.jsonl');
    expect(getSessionStreamMeta('/new.jsonl')).toMatchObject({
      streamId: null,
      lastSeq: 0,
    });
  });

  it('replays resume events through the canonical path when sessionId points away from a legacy path', () => {
    const handled: unknown[] = [];
    injectHandlers((msg) => handled.push(msg), vi.fn());
    useStore.setState({
      currentSessionId: 'sess_stream_moved',
      currentSessionPath: '/sessions/current.jsonl',
      sessions: [{ path: '/sessions/current.jsonl', sessionId: 'sess_stream_moved' }] as never,
      sessionLocatorsById: { sess_stream_moved: { path: '/sessions/current.jsonl' } },
      chatSessions: {
        sess_stream_moved: { items: [], hasMore: false, loadingMore: false },
      },
    } as never);

    replayStreamResume({
      type: 'stream_resume',
      sessionId: 'sess_stream_moved',
      sessionPath: '/sessions/legacy.jsonl',
      streamId: 'stream_moved',
      sinceSeq: 0,
      nextSeq: 2,
      isStreaming: true,
      reset: false,
      truncated: false,
      events: [
        { seq: 1, event: { type: 'text_delta', delta: 'canonical text' } },
      ],
    });

    expect(handled).toEqual([
      expect.objectContaining({
        type: 'text_delta',
        sessionPath: '/sessions/current.jsonl',
        streamId: 'stream_moved',
        seq: 1,
        __fromReplay: true,
      }),
    ]);
  });

  it('rebuilds the current session by sessionId when a reset resume carries a legacy path', async () => {
    const statuses: Array<{ isStreaming: boolean; sessionPath: string | null }> = [];
    injectHandlers(vi.fn(), (isStreaming, sessionPath) => {
      statuses.push({ isStreaming, sessionPath });
    });
    useStore.setState({
      currentSessionId: 'sess_stream_reset_moved',
      currentSessionPath: '/sessions/current-reset.jsonl',
      sessions: [{ path: '/sessions/current-reset.jsonl', sessionId: 'sess_stream_reset_moved' }] as never,
      sessionLocatorsById: { sess_stream_reset_moved: { path: '/sessions/current-reset.jsonl' } },
      chatSessions: {
        sess_stream_reset_moved: { items: [], hasMore: false, loadingMore: false },
      },
    } as never);

    replayStreamResume({
      type: 'stream_resume',
      sessionId: 'sess_stream_reset_moved',
      sessionPath: '/sessions/legacy-reset.jsonl',
      streamId: 'stream_reset_moved',
      sinceSeq: 0,
      nextSeq: 1,
      isStreaming: false,
      reset: true,
      truncated: false,
      events: [],
    });

    await vi.waitFor(() => {
      expect(mocks.loadMessages).toHaveBeenCalledWith('/sessions/current-reset.jsonl');
    });

    expect(mocks.streamBufferManager.clear).toHaveBeenCalledWith('/sessions/current-reset.jsonl');
    expect(mocks.clearChat).toHaveBeenCalled();
    expect(statuses).toEqual([{ isStreaming: false, sessionPath: '/sessions/current-reset.jsonl' }]);
  });

  it('keeps the session marked streaming when resume replay is empty but runtime says it is still running', () => {
    const statuses: Array<{ isStreaming: boolean; sessionPath: string | null }> = [];
    injectHandlers(vi.fn(), (isStreaming, sessionPath) => {
      statuses.push({ isStreaming, sessionPath });
      useStore.setState((state) => ({
        streamingSessions: isStreaming
          ? Array.from(new Set([...state.streamingSessions, sessionPath].filter(Boolean))) as string[]
          : state.streamingSessions.filter((path) => path !== sessionPath),
      }));
    });

    replayStreamResume({
      type: 'stream_resume',
      sessionPath: '/background.jsonl',
      streamId: null,
      sinceSeq: 42,
      nextSeq: 1,
      isStreaming: false,
      runtimeIsStreaming: true,
      reset: false,
      truncated: false,
      events: [],
    });

    expect(statuses).toEqual([{ isStreaming: true, sessionPath: '/background.jsonl' }]);
    expect(useStore.getState().streamingSessions).toEqual(['/background.jsonl']);
  });

  it('force-clears a stale active stream when runtime resume says the session is no longer running', () => {
    const statuses: Array<{
      isStreaming: boolean;
      sessionPath: string | null;
      force?: boolean;
    }> = [];
    useStore.setState({
      streamingSessions: ['/background.jsonl'],
      activeSessionStreams: {
        '/background.jsonl': { streamId: 'stream-new', turnId: null },
      },
    } as never);
    injectHandlers(vi.fn(), (isStreaming, sessionPath, _identity, options) => {
      statuses.push({ isStreaming, sessionPath, force: options?.force });
      if (!sessionPath) return;
      if (isStreaming) {
        useStore.getState().addStreamingSession(sessionPath, _identity);
      } else if (options?.force) {
        useStore.getState().forceRemoveStreamingSession(sessionPath);
      } else {
        useStore.getState().removeStreamingSession(sessionPath, _identity);
      }
    });

    replayStreamResume({
      type: 'stream_resume',
      sessionPath: '/background.jsonl',
      streamId: null,
      sinceSeq: 42,
      nextSeq: 1,
      isStreaming: false,
      runtimeIsStreaming: false,
      reset: false,
      truncated: false,
      events: [],
    });

    expect(statuses).toEqual([
      { isStreaming: false, sessionPath: '/background.jsonl', force: true },
    ]);
    expect(useStore.getState().streamingSessions).toEqual([]);
    expect(useStore.getState().activeSessionStreams['/background.jsonl']).toBeUndefined();
  });
});
