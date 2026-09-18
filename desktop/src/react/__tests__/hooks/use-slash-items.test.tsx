/**
 * @vitest-environment jsdom
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn<(path: string, opts?: RequestInit) => Promise<Response>>(async (path: string) => {
    if (path.startsWith('/api/commands')) {
      return new Response(JSON.stringify({
        commands: [
          { name: 'stop', description: 'Stop', source: 'core' },
          { name: 'plugin_hello', aliases: ['hello'], description: 'Plugin hello', source: 'plugin' },
        ],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      skills: [{ name: 'mio_skill', description: 'Mio skill', hidden: false, enabled: true }],
    }), { status: 200 });
  }),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (path: string, opts?: RequestInit) => mocks.hanaFetch(path, opts),
}));

describe('useSkillSlashItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      currentAgentId: 'hana',
      selectedAgentId: 'mio',
      skillCatalogVersion: 0,
    } as never);
  });

  it('fetches skills for the explicit target agent instead of the current focused agent', async () => {
    const { useSkillSlashItems } = await import('../../hooks/use-slash-items');

    const { result } = renderHook(() => useSkillSlashItems({ enabled: true, agentId: 'mio' }));

    await waitFor(() => expect(result.current.map(item => item.name)).toEqual(['mio_skill']));
    expect(mocks.hanaFetch.mock.calls[0]?.[0]).toBe('/api/skills?agentId=mio&runtime=1');
    expect(mocks.hanaFetch.mock.calls.map(call => call[0])).not.toContain('/api/skills?agentId=hana&runtime=1');
  });
});

describe('useServerSlashCommandItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      currentAgentId: 'hana',
      selectedAgentId: 'mio',
      skillCatalogVersion: 0,
    } as never);
  });

  it('fetches non-core server slash commands for the target agent', async () => {
    const { useServerSlashCommandItems } = await import('../../hooks/use-slash-items');

    const { result } = renderHook(() => useServerSlashCommandItems({ enabled: true, agentId: 'mio' }));

    await waitFor(() => expect(result.current.map(item => item.name)).toEqual(['plugin_hello']));
    expect(result.current[0]).toMatchObject({
      aliases: ['hello'],
      label: '/plugin_hello',
      type: 'server-command',
    });
    expect(mocks.hanaFetch.mock.calls[0]?.[0]).toBe('/api/commands?agentId=mio');
  });
});
