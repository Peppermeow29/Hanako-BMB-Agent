import { describe, expect, it } from 'vitest';
import { createConnectionSlice, type ConnectionSlice } from '../../stores/connection-slice';
import { mergeServerIdentity } from '../../services/server-connection';

function createHarness() {
  let state: ConnectionSlice;
  const set = (partial: Partial<ConnectionSlice>) => {
    state = { ...state, ...partial };
  };
  const get = () => state;
  state = createConnectionSlice(set, get);
  return {
    get state() {
      return state;
    },
  };
}

describe('connection slice registry', () => {
  it('sets local server connection into the registry and active mirror together', () => {
    const h = createHarness();

    h.state.setLocalServerConnection(3210, 'local-token');

    expect(h.state.activeServerConnectionId).toBe('local');
    expect(h.state.serverConnections.local).toEqual(h.state.activeServerConnection);
    expect(h.state.activeServerConnection).toMatchObject({
      connectionId: 'local',
      kind: 'local',
      baseUrl: 'http://127.0.0.1:3210',
      token: 'local-token',
    });
  });

  it('refreshes local transport without losing stable identity in the registry', () => {
    const h = createHarness();
    h.state.setLocalServerConnection(3210, 'old-token');
    const stable = mergeServerIdentity(h.state.activeServerConnection!, {
      serverId: 'server_stable',
      userId: 'user_stable',
      studioId: 'studio_stable',
      label: 'Stable Studio',
    });
    h.state.setActiveServerConnection(stable);

    h.state.setLocalServerConnection(4222, 'new-token');

    expect(h.state.activeServerConnectionId).toBe('local');
    expect(h.state.activeServerConnection).toMatchObject({
      connectionId: 'local',
      serverId: 'server_stable',
      userId: 'user_stable',
      studioId: 'studio_stable',
      baseUrl: 'http://127.0.0.1:4222',
      token: 'new-token',
    });
    expect(h.state.serverConnections.local).toEqual(h.state.activeServerConnection);
  });

  it('can select a non-local connection from the registry without touching legacy port fields', () => {
    const h = createHarness();
    h.state.setLocalServerConnection(3210, 'local-token');
    const remote = {
      ...h.state.activeServerConnection!,
      connectionId: 'custom:remote',
      kind: 'custom_remote' as const,
      label: 'Remote Studio',
      baseUrl: 'https://hana.example',
      wsUrl: 'wss://hana.example',
      token: 'remote-token',
      trustState: 'tunnel' as const,
      credentialKind: 'device_credential' as const,
    };

    h.state.upsertServerConnection(remote);
    h.state.selectServerConnection('custom:remote');

    expect(h.state.serverPort).toBe('3210');
    expect(h.state.serverToken).toBe('local-token');
    expect(h.state.activeServerConnectionId).toBe('custom:remote');
    expect(h.state.activeServerConnection).toBe(remote);
  });
});
