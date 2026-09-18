import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import {
  hydrateInputDrafts,
  initInputDraftPersistence,
} from '../../stores/input-draft-persistence';
import { registerDraftSyncListener } from '../../stores/input-draft-sync';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));
vi.mock('../../services/server-connection', () => ({
  hasServerConnection: () => true,
}));

const mockFetch = vi.mocked(hanaFetch);

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => data } as unknown as Response;
}

describe('input draft persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    // 重置 store drafts（沿用本目录测试重置惯例）
    useStore.setState({ drafts: {}, draftDocs: {}, draftsHydratedAt: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
    registerDraftSyncListener(null);
  });

  it('hydrates server drafts into memory without overwriting existing keys', async () => {
    useStore.setState({ drafts: { 'sess-typed': 'user already typing' } });
    mockFetch.mockResolvedValueOnce(jsonResponse({
      home: { text: 'home draft', doc: { type: 'doc' }, updatedAt: 1 },
      sessions: {
        'sess-typed': { text: 'stale server copy', updatedAt: 1 },
        'sess-cold': { text: 'cold draft', updatedAt: 1 },
      },
    }));

    await hydrateInputDrafts();

    const s = useStore.getState();
    expect(s.drafts['__home__']).toBe('home draft');
    expect(s.draftDocs['__home__']).toEqual({ type: 'doc' });
    expect(s.drafts['sess-typed']).toBe('user already typing'); // 内存优先
    expect(s.drafts['sess-cold']).toBe('cold draft');
    expect(s.draftsHydratedAt).toBeGreaterThan(0);
  });

  it('debounces pushes and sends home scope / sessionId / sessionPath correctly', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));
    initInputDraftPersistence();
    const { notifyDraftSet, notifyDraftCleared } = await import('../../stores/input-draft-sync');

    notifyDraftSet('__home__', 'h1', null);
    notifyDraftSet('__home__', 'h2', null); // 同 key 重置 debounce，只发一次
    notifyDraftSet('sess-1', 'session text', { type: 'doc' } as any);
    notifyDraftSet('/agents/a/sessions/legacy.jsonl', 'legacy', null);

    await vi.advanceTimersByTimeAsync(600);

    const bodies = mockFetch.mock.calls
      .filter(([url]) => url === '/api/input-drafts')
      .map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies).toHaveLength(3);
    expect(bodies.find(b => b.scope === 'home')).toMatchObject({ text: 'h2' });
    expect(bodies.find(b => b.sessionId === 'sess-1')).toMatchObject({ text: 'session text', doc: { type: 'doc' } });
    expect(bodies.find(b => b.sessionPath === '/agents/a/sessions/legacy.jsonl')).toMatchObject({ text: 'legacy' });

    mockFetch.mockClear();
    notifyDraftCleared('sess-1');
    await vi.advanceTimersByTimeAsync(600);
    const clearBody = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(clearBody).toMatchObject({ sessionId: 'sess-1', text: '' });
  });
});
