import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../settings/api', () => ({
  hanaFetch: mocks.hanaFetch,
}));

import { loadLlmUsageEntries } from '../../settings/tabs/providers/usage-ledger-actions';

describe('usage ledger actions', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requests explicit date windows without the latest-entry default limit', async () => {
    mocks.hanaFetch.mockResolvedValue({
      json: async () => ({ entries: [] }),
    });

    await loadLlmUsageEntries({
      since: '2026-05-20T00:00:00.000Z',
      until: '2026-05-21T00:00:00.000Z',
    });

    expect(mocks.hanaFetch).toHaveBeenCalledWith(
      '/api/usage/llm?since=2026-05-20T00%3A00%3A00.000Z&until=2026-05-21T00%3A00%3A00.000Z',
    );
  });
});
