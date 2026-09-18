/**
 * reorderPinnedSessions: the pinned strip reorders on drop and snaps back when
 * the server refuses the new order.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockState = Record<string, any>;

const mockState: MockState = {};
const hanaFetchMock = vi.fn();

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
  hanaFetch: (...args: unknown[]) => hanaFetchMock(...args),
  hanaUrl: (p: string) => p,
}));

vi.mock('../../utils/history-builder', () => ({ buildItemsFromHistory: vi.fn(() => []) }));
vi.mock('../../utils/todo-compat', () => ({ migrateLegacyTodos: vi.fn(() => []) }));
vi.mock('../../utils/ui-helpers', () => ({ loadModels: vi.fn() }));
vi.mock('../../stores/agent-actions', () => ({ loadAvatars: vi.fn(), clearChat: vi.fn() }));
vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: vi.fn(),
  activateWorkspaceDesk: vi.fn(),
}));
vi.mock('../../stores/create-keyed-slice', () => ({ updateKeyed: vi.fn() }));
vi.mock('../../stores/stream-invalidator', () => ({
  snapshotStreamBuffer: vi.fn(),
  invalidateStreamBuffer: vi.fn(),
  registerStreamBufferInvalidator: vi.fn(),
  registerStreamBufferSnapshot: vi.fn(),
}));
vi.mock('../../utils/markdown', () => ({ renderMarkdown: (s: string) => s }));
vi.mock('../../services/websocket', () => ({ getWebSocket: () => null }));
vi.mock('../../services/stream-resume', () => ({ requestStreamResume: vi.fn() }));

import { reorderPinnedSessions } from '../../stores/session-actions';

function pinnedSession(sessionId: string, pinOrder: number | null) {
  return {
    path: `/sessions/${sessionId}.jsonl`,
    sessionId,
    title: sessionId,
    firstMessage: '',
    modified: '2026-04-29T01:00:00.000Z',
    messageCount: 1,
    agentId: 'hana',
    agentName: 'Hana',
    cwd: null,
    pinnedAt: '2026-04-28T07:00:00.000Z',
    pinOrder,
  };
}

describe('reorderPinnedSessions', () => {
  beforeEach(() => {
    hanaFetchMock.mockReset();
    for (const key of Object.keys(mockState)) delete mockState[key];
    Object.assign(mockState, {
      addToast: vi.fn(),
      sessions: [
        pinnedSession('sess_a', 1024),
        pinnedSession('sess_b', 2048),
        pinnedSession('sess_c', 3072),
      ],
    });
    (globalThis as any).window = (globalThis as any).window || {};
    (globalThis as any).window.t = (key: string) => key;
  });

  it('renumbers the pinned sessions immediately and posts the submitted order', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    hanaFetchMock.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));

    const pending = reorderPinnedSessions(['sess_c', 'sess_a', 'sess_b']);

    // Optimistic: the new order is visible before the request settles.
    expect(mockState.sessions.map((s: any) => [s.sessionId, s.pinOrder])).toEqual([
      ['sess_a', 2048],
      ['sess_b', 3072],
      ['sess_c', 1024],
    ]);
    expect(hanaFetchMock).toHaveBeenCalledWith('/api/sessions/pin-order', expect.objectContaining({
      method: 'POST',
    }));
    expect(JSON.parse(hanaFetchMock.mock.calls[0][1].body)).toEqual({
      sessionIds: ['sess_c', 'sess_a', 'sess_b'],
    });

    resolveFetch({
      ok: true,
      json: async () => ({
        ok: true,
        orders: [
          { sessionId: 'sess_c', pinOrder: 1024 },
          { sessionId: 'sess_a', pinOrder: 2048 },
          { sessionId: 'sess_b', pinOrder: 3072 },
        ],
      }),
    });

    await expect(pending).resolves.toBe(true);
    expect(mockState.sessions.map((s: any) => [s.sessionId, s.pinOrder])).toEqual([
      ['sess_a', 2048],
      ['sess_b', 3072],
      ['sess_c', 1024],
    ]);
  });

  it('restores the previous order and warns when the server rejects the reorder', async () => {
    hanaFetchMock.mockResolvedValue({
      ok: false,
      statusText: 'Bad Request',
      json: async () => ({ error: 'session_not_pinned' }),
    });

    await expect(reorderPinnedSessions(['sess_c', 'sess_a', 'sess_b'])).resolves.toBe(false);

    expect(mockState.sessions.map((s: any) => [s.sessionId, s.pinOrder])).toEqual([
      ['sess_a', 1024],
      ['sess_b', 2048],
      ['sess_c', 3072],
    ]);
    expect(mockState.addToast).toHaveBeenCalledWith('session.reorderFailed', 'info', expect.any(Number));
  });

  it('restores the previous order when the request throws', async () => {
    hanaFetchMock.mockRejectedValue(new Error('offline'));

    await expect(reorderPinnedSessions(['sess_b', 'sess_a', 'sess_c'])).resolves.toBe(false);

    expect(mockState.sessions.map((s: any) => [s.sessionId, s.pinOrder])).toEqual([
      ['sess_a', 1024],
      ['sess_b', 2048],
      ['sess_c', 3072],
    ]);
    expect(mockState.addToast).toHaveBeenCalledWith('session.reorderFailed', 'info', expect.any(Number));
  });

  it('does nothing when the submitted list is empty', async () => {
    await expect(reorderPinnedSessions([])).resolves.toBe(false);
    expect(hanaFetchMock).not.toHaveBeenCalled();
  });
});
