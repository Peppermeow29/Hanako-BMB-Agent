import { describe, expect, it, vi } from 'vitest';
import { resolveFileRefUrl } from '../../services/resource-url';
import type { ServerConnection } from '../../services/server-connection';
import type { FileRef } from '../../types/file-ref';

const localConnection: ServerConnection = {
  connectionId: 'local',
  kind: 'local',
  serverId: 'server_local',
  userId: 'user_local',
  studioId: 'studio_local',
  label: 'Local Hana',
  baseUrl: 'http://127.0.0.1:14500',
  wsUrl: 'ws://127.0.0.1:14500',
  token: 'local token',
  authState: 'paired',
  trustState: 'local',
  credentialKind: 'loopback_token',
  platformAccountId: null,
  officialServiceKind: null,
  capabilities: ['resources'],
};

const remoteConnection: ServerConnection = {
  ...localConnection,
  connectionId: 'custom:remote',
  kind: 'custom_remote',
  serverId: 'server_remote',
  studioId: 'studio_remote',
  label: 'Remote Hana',
  baseUrl: 'https://hana.example',
  wsUrl: 'wss://hana.example',
  token: 'remote token',
  trustState: 'tunnel',
  credentialKind: 'device_credential',
};

function fileRef(patch: Partial<FileRef> = {}): FileRef {
  return {
    id: 'session-registry:/workspace/asset.png',
    fileId: 'sf_asset',
    kind: 'image',
    source: 'session-registry',
    name: 'asset.png',
    path: '/workspace/asset.png',
    ext: 'png',
    resource: {
      resourceId: 'res_sf_asset',
      studioId: 'studio_local',
      links: {
        self: '/api/resources/res_sf_asset',
        content: '/api/resources/res_sf_asset/content',
      },
    },
    ...patch,
  };
}

describe('resolveFileRefUrl', () => {
  it('keeps the local desktop file URL fast path when a local path is available', () => {
    const platform = { getFileUrl: vi.fn((p: string) => `file:///mock${p}`) };

    const result = resolveFileRefUrl(fileRef({ version: { mtimeMs: 11, size: 22 } }), {
      connection: localConnection,
      platform,
    });

    expect(result).toEqual({
      mode: 'local-file',
      url: 'file:///mock/workspace/asset.png?v=11-22',
    });
    expect(platform.getFileUrl).toHaveBeenCalledWith('/workspace/asset.png');
  });

  it('uses the resource content URL for a remote connection instead of exposing local paths', () => {
    const platform = { getFileUrl: vi.fn((p: string) => `file:///mock${p}`) };

    const result = resolveFileRefUrl(fileRef({ version: { mtimeMs: 11, size: 22 } }), {
      connection: remoteConnection,
      platform,
    });

    expect(result).toEqual({
      mode: 'resource-content',
      url: 'https://hana.example/api/resources/res_sf_asset/content?v=11-22',
    });
    expect(platform.getFileUrl).not.toHaveBeenCalled();
  });

  it('can resolve a resource URL without a desktop platform bridge', () => {
    const result = resolveFileRefUrl(fileRef({ path: '' }), {
      connection: remoteConnection,
      platform: null,
    });

    expect(result.mode).toBe('resource-content');
    expect(result.url).toBe('https://hana.example/api/resources/res_sf_asset/content');
  });

  it('uses inline data only when there is no path or resource content link', () => {
    const result = resolveFileRefUrl(fileRef({
      path: '',
      resource: undefined,
      inlineData: { mimeType: 'image/png', base64: 'ABC' },
    }), {
      connection: remoteConnection,
      platform: null,
    });

    expect(result).toEqual({
      mode: 'inline-data',
      url: 'data:image/png;base64,ABC',
    });
  });
});
