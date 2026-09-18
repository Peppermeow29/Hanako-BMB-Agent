/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (...args: unknown[]) => fetchMock(...args),
}));

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
}

describe('use-config cache', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
  });

  it('caches /api/config by explicit owner key', async () => {
    const { fetchConfig } = await import('../../hooks/use-config');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ desk: { heartbeat_master: true } }))
      .mockResolvedValueOnce(jsonResponse({ desk: { heartbeat_master: false } }));

    await expect(fetchConfig({ cacheKey: 'local' })).resolves.toEqual({ desk: { heartbeat_master: true } });
    await expect(fetchConfig({ cacheKey: 'remote' })).resolves.toEqual({ desk: { heartbeat_master: false } });
    await expect(fetchConfig({ cacheKey: 'local' })).resolves.toEqual({ desk: { heartbeat_master: true } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidates only the requested cache key when supplied', async () => {
    const { fetchConfig, invalidateConfigCache } = await import('../../hooks/use-config');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ value: 'local-v1' }))
      .mockResolvedValueOnce(jsonResponse({ value: 'remote-v1' }))
      .mockResolvedValueOnce(jsonResponse({ value: 'local-v2' }));

    await fetchConfig({ cacheKey: 'local' });
    await fetchConfig({ cacheKey: 'remote' });
    invalidateConfigCache('local');

    await expect(fetchConfig({ cacheKey: 'local' })).resolves.toEqual({ value: 'local-v2' });
    await expect(fetchConfig({ cacheKey: 'remote' })).resolves.toEqual({ value: 'remote-v1' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
