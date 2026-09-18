/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore, type StoreState } from '../../stores';
import type { DeskFile, RemoteWorkbenchContentRef } from '../../types';
import type { FileRef } from '../../types/file-ref';

const mockHanaFetch = vi.hoisted(() => vi.fn());
const mockOpenFilePreview = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: mockHanaFetch,
}));

vi.mock('../../utils/file-preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/file-preview')>();
  return {
    ...actual,
    openFilePreview: mockOpenFilePreview,
  };
});

describe('remote file preview workbench refs', () => {
  beforeEach(() => {
    useStore.setState({
      previewItems: [],
      openTabs: [],
      activeServerConnection: null,
      activeServerConnectionId: null,
      serverConnections: {},
      serverPort: '62950',
      serverToken: 'local-token',
    } as Partial<StoreState>);
    mockHanaFetch.mockReset();
    mockOpenFilePreview.mockClear();
    mockHanaFetch.mockResolvedValue({
      json: async () => ({ ok: true, version: { mtimeMs: 1, size: 4 } }),
    });
  });

  it('saves remote workbench content by mountId instead of producing a legacy rootId-only request', async () => {
    const { saveRemoteWorkbenchContent } = await import('../../utils/remote-file-preview');
    const ref: RemoteWorkbenchContentRef = {
      kind: 'workbench-file',
      mountId: 'mount_docs',
      subdir: 'notes',
      name: 'remote.md',
      contentPath: '/api/workbench/content?mountId=mount_docs&subdir=notes&name=remote.md',
    };

    await saveRemoteWorkbenchContent(ref, 'body');

    expect(mockHanaFetch).toHaveBeenCalledWith(
      '/api/workbench/actions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'writeText',
          mountId: 'mount_docs',
          subdir: 'notes',
          name: 'remote.md',
          content: 'body',
          expectedVersion: null,
        }),
      }),
    );
    expect(String(mockHanaFetch.mock.calls[0][1].body)).not.toContain('"rootId"');
  });

  it('retries remote workbench refresh when the first cache-busted read is unchanged', async () => {
    const { refreshPreviewItemsFromRemoteWorkbenchTarget } = await import('../../utils/remote-file-preview');
    const target: RemoteWorkbenchContentRef = {
      kind: 'workbench-file',
      mountId: 'mount_docs',
      subdir: 'notes',
      name: 'remote.md',
      contentPath: '/api/workbench/content?mountId=mount_docs&subdir=notes&name=remote.md',
      version: { mtimeMs: 2, size: 8 },
    };
    useStore.setState({
      previewItems: [{
        id: 'remote-note',
        type: 'markdown',
        title: 'remote.md',
        content: 'old',
        storageKind: 'remote-content',
        remoteContentRef: {
          ...target,
          version: { mtimeMs: 1, size: 3 },
        },
      }],
    } as Partial<StoreState>);
    mockHanaFetch
      .mockResolvedValueOnce(new Response('old', { status: 200 }))
      .mockResolvedValueOnce(new Response('new', { status: 200 }));

    await refreshPreviewItemsFromRemoteWorkbenchTarget(target, {
      retryUnchanged: true,
      retryDelaysMs: [0],
    });

    const item = useStore.getState().previewItems[0];
    expect(mockHanaFetch).toHaveBeenCalledTimes(2);
    expect(item.content).toBe('new');
    expect(item.fileVersion).toEqual({ mtimeMs: 2, size: 8 });
    expect(item.remoteContentRef?.version).toEqual({ mtimeMs: 2, size: 8 });
  });

  it('uses the content response version when opening a remote workbench document', async () => {
    const { openMobileWorkbenchPreview } = await import('../../utils/remote-file-preview');
    const staleListVersion = new Date('2026-06-20T00:00:00.000Z').toISOString();
    const file: DeskFile = {
      name: 'remote.md',
      isDir: false,
      mtime: staleListVersion,
      size: 0,
    };
    mockHanaFetch.mockResolvedValueOnce(new Response('# fresh\n', {
      status: 200,
      headers: {
        'X-Hana-File-MtimeMs': '1781989413542',
        'X-Hana-File-Size': '8',
      },
    }));

    await openMobileWorkbenchPreview({
      mountId: 'mount_docs',
      subdir: 'notes',
      file,
    });

    const item = useStore.getState().previewItems[0];
    expect(item.content).toBe('# fresh\n');
    expect(item.fileVersion).toEqual({ mtimeMs: 1781989413542, size: 8 });
    expect(item.remoteContentRef?.version).toEqual({ mtimeMs: 1781989413542, size: 8 });
  });

  it('does not downgrade a remote workbench refresh to a stale target version', async () => {
    const { refreshPreviewItemsFromRemoteWorkbenchTarget } = await import('../../utils/remote-file-preview');
    const staleVersion = { mtimeMs: 1000, size: 0 };
    const savedVersion = { mtimeMs: 2000, size: 12 };
    const diskVersion = { mtimeMs: 3000, size: 18 };
    const target: RemoteWorkbenchContentRef = {
      kind: 'workbench-file',
      mountId: 'mount_docs',
      subdir: 'notes',
      name: 'remote.md',
      contentPath: '/api/workbench/content?mountId=mount_docs&subdir=notes&name=remote.md',
      version: staleVersion,
    };
    useStore.setState({
      previewItems: [{
        id: 'remote-note',
        type: 'markdown',
        title: 'remote.md',
        content: 'saved body',
        storageKind: 'remote-content',
        fileVersion: savedVersion,
        remoteContentRef: target,
      }],
    } as Partial<StoreState>);
    mockHanaFetch.mockResolvedValueOnce(new Response('fresh external body', {
      status: 200,
      headers: {
        'X-Hana-File-MtimeMs': String(diskVersion.mtimeMs),
        'X-Hana-File-Size': String(diskVersion.size),
      },
    }));

    await refreshPreviewItemsFromRemoteWorkbenchTarget(target);

    const item = useStore.getState().previewItems[0];
    expect(item.content).toBe('fresh external body');
    expect(item.fileVersion).toEqual(diskVersion);
    expect(item.remoteContentRef?.version).toEqual(diskVersion);
  });

  it('opens local default workbench documents through native preview when this client owns the server', async () => {
    const { openWorkbenchFilePreview } = await import('../../utils/remote-file-preview');
    const file: DeskFile = {
      name: 'local.md',
      isDir: false,
      mtime: '2026-06-25T01:02:03.000Z',
      size: 8,
    };

    await openWorkbenchFilePreview({
      subdir: 'notes',
      localRootPath: '/Users/me/project',
      file,
    });

    expect(mockOpenFilePreview).toHaveBeenCalledWith('/Users/me/project/notes/local.md', 'local.md', 'md', {
      origin: 'desk',
      sourceRootPath: '/Users/me/project',
    });
    expect(mockHanaFetch).not.toHaveBeenCalled();
  });

  it('opens remote default workbench documents through ResourceIO content even in desktop runtime', async () => {
    const { openWorkbenchFilePreview } = await import('../../utils/remote-file-preview');
    useStore.setState({
      activeServerConnection: {
        connectionId: 'browser:server_lan',
        kind: 'lan',
        serverId: 'server_lan',
        userId: 'user_lan',
        studioId: 'studio_lan',
        label: 'LAN Hana',
        baseUrl: 'http://hana.local:14500',
        wsUrl: 'ws://hana.local:14500',
        token: null,
        authState: 'paired',
        trustState: 'lan',
        credentialKind: 'device_credential',
        platformAccountId: null,
        officialServiceKind: null,
        capabilities: ['resources', 'files'],
      },
    } as Partial<StoreState>);
    const file: DeskFile = {
      name: 'remote.md',
      isDir: false,
      mtime: '2026-06-25T01:02:03.000Z',
      size: 9,
    };
    mockHanaFetch.mockResolvedValueOnce(new Response('# remote\n', { status: 200 }));

    await openWorkbenchFilePreview({
      subdir: 'notes',
      localRootPath: '/Users/server/project',
      file,
    });

    expect(mockOpenFilePreview).not.toHaveBeenCalled();
    expect(mockHanaFetch).toHaveBeenCalledWith(expect.stringMatching(
      /^\/api\/workbench\/content\?mountId=default&subdir=notes&name=remote\.md&v=/,
    ));
    expect(useStore.getState().previewItems[0]).toMatchObject({
      title: 'remote.md',
      content: '# remote\n',
      storageKind: 'remote-content',
      remoteContentRef: {
        kind: 'workbench-file',
        mountId: 'default',
        rootId: 'default',
        subdir: 'notes',
        name: 'remote.md',
      },
    });
  });

  it('opens remote session FileRefs through ResourceIO content instead of native paths', async () => {
    const { openFileRefPreview } = await import('../../utils/remote-file-preview');
    useStore.setState({
      activeServerConnection: {
        connectionId: 'browser:server_lan',
        kind: 'lan',
        serverId: 'server_lan',
        userId: 'user_lan',
        studioId: 'studio_lan',
        label: 'LAN Hana',
        baseUrl: 'http://hana.local:14500',
        wsUrl: 'ws://hana.local:14500',
        token: null,
        authState: 'paired',
        trustState: 'lan',
        credentialKind: 'device_credential',
        platformAccountId: null,
        officialServiceKind: null,
        capabilities: ['resources', 'files'],
      },
    } as Partial<StoreState>);
    const fileRef: FileRef = {
      id: 'session-registry:/server/cache/report.md',
      fileId: 'sf_report',
      kind: 'markdown',
      source: 'session-registry',
      name: 'report.md',
      path: '/server/cache/report.md',
      ext: 'md',
      status: 'available',
      resource: {
        resourceId: 'res_sf_report',
        studioId: 'studio_lan',
        links: {
          self: '/api/resources/res_sf_report',
          content: '/api/resources/res_sf_report/content',
        },
      },
    };
    mockHanaFetch.mockResolvedValueOnce(new Response('# file ref\n', { status: 200 }));

    await openFileRefPreview(fileRef, {
      origin: 'session',
      sessionPath: '/sessions/main.jsonl',
      messageId: 'm1',
      blockIdx: 0,
    });

    expect(mockOpenFilePreview).not.toHaveBeenCalled();
    expect(mockHanaFetch).toHaveBeenCalledWith('/api/resources/res_sf_report/content');
    expect(useStore.getState().previewItems[0]).toMatchObject({
      title: 'report.md',
      content: '# file ref\n',
      storageKind: 'remote-content',
    });
  });
});
