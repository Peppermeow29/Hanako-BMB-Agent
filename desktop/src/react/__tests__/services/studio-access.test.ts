import { describe, expect, it } from 'vitest';

import {
  deriveStudioAccessGrant,
  getStudioConnectionProfile,
  validateStudioConnectionTrust,
} from '../../services/studio-access';
import { createLocalServerConnection } from '../../services/server-connection';

describe('trusted space access contract', () => {
  it('defines local as a loopback-only connection profile', () => {
    expect(getStudioConnectionProfile('local')).toEqual({
      kind: 'local',
      transport: 'loopback',
      credentialKinds: ['loopback_token'],
      trustState: 'local',
      remoteReachable: false,
      requiresDevicePairing: false,
      requiresPlatformAccount: false,
      dataOwner: 'user_server',
      officialServiceKind: null,
    });
  });

  it('derives a local access grant without treating the loopback token as a remote credential', () => {
    const local = createLocalServerConnection({
      serverPort: 3210,
      serverToken: 'local-token',
    })!;

    expect(deriveStudioAccessGrant(local)).toEqual({
      grantId: 'access:local:local',
      connectionId: 'local',
      actorKind: 'local_user',
      scope: {
        serverId: 'local',
        userId: null,
        studioId: 'local',
      },
      transport: 'loopback',
      dataOwner: 'user_server',
      localOnly: true,
      capabilities: [
        'chat',
        'resources.read',
        'resources.write',
        'files.read',
        'files.write',
        'files.openLocal',
        'tools.run',
        'plugins.use',
        'studio.owner',
        'settings.read',
        'settings.write',
        'providers.manage',
        'secrets.write',
        'bridge.manage',
      ],
    });
  });

  it('derives a custom remote grant from device credentials without exposing desktop-only local file open access', () => {
    const remote = {
      ...createLocalServerConnection({
        serverPort: 3210,
        serverToken: 'local-token',
      })!,
      connectionId: 'custom:remote',
      kind: 'custom_remote' as const,
      serverId: 'server_remote',
      userId: 'user_remote',
      studioId: 'studio_remote',
      label: 'Remote Studio',
      baseUrl: 'https://hana.example',
      wsUrl: 'wss://hana.example',
      token: 'remote-token',
      trustState: 'tunnel' as const,
      credentialKind: 'device_credential' as const,
    };

    expect(deriveStudioAccessGrant(remote)).toEqual({
      grantId: 'access:custom:remote:studio_remote',
      connectionId: 'custom:remote',
      actorKind: 'device',
      scope: {
        serverId: 'server_remote',
        userId: 'user_remote',
        studioId: 'studio_remote',
      },
      transport: 'user_managed_tunnel',
      dataOwner: 'user_server',
      localOnly: false,
      capabilities: ['chat', 'resources.read', 'files.read', 'files.write', 'tools.run'],
    });
  });

  it('rejects non-local connections that try to reuse the loopback token credential', () => {
    const invalidRemote = {
      ...createLocalServerConnection({
        serverPort: 3210,
        serverToken: 'local-token',
      })!,
      connectionId: 'custom:bad',
      kind: 'custom_remote' as const,
      baseUrl: 'https://hana.example',
      wsUrl: 'wss://hana.example',
      trustState: 'tunnel' as const,
      credentialKind: 'loopback_token' as const,
    };

    expect(() => validateStudioConnectionTrust(invalidRemote))
      .toThrow('custom_remote connection must not use loopback_token');
  });

  it('rejects relay connections without official relay account context', () => {
    const invalidRelay = {
      ...createLocalServerConnection({
        serverPort: 3210,
        serverToken: 'local-token',
      })!,
      connectionId: 'relay:bad',
      kind: 'relay' as const,
      baseUrl: 'https://relay.hana.example',
      wsUrl: 'wss://relay.hana.example',
      trustState: 'tunnel' as const,
      credentialKind: 'user_session' as const,
      officialServiceKind: null,
      platformAccountId: null,
    };

    expect(() => validateStudioConnectionTrust(invalidRelay))
      .toThrow('relay connection requires officialServiceKind=relay');
  });

  it('allows LAN browser sessions created by local account login without requiring a platform account', () => {
    const connection = {
      ...createLocalServerConnection({
        serverPort: 3210,
        serverToken: 'local-token',
      })!,
      connectionId: 'lan:browser',
      kind: 'lan' as const,
      serverId: 'server_lan',
      userId: 'local_user',
      studioId: 'studio_lan',
      label: 'LAN Studio',
      baseUrl: 'http://192.168.1.20:14500',
      wsUrl: 'ws://192.168.1.20:14500',
      token: null,
      authState: 'user' as const,
      trustState: 'lan' as const,
      credentialKind: 'user_session' as const,
      capabilities: ['chat', 'resources', 'files'],
    };

    expect(deriveStudioAccessGrant(connection)).toMatchObject({
      actorKind: 'account_user',
      localOnly: false,
      dataOwner: 'user_server',
    });
  });
});
