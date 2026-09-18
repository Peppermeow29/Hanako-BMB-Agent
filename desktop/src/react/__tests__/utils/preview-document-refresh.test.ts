import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore, type StoreState } from '../../stores';
import type { PreviewItem, RemoteWorkbenchContentRef } from '../../types';
import type { ResourceChangeEvent } from '../../utils/preview-document-refresh';

const mocks = vi.hoisted(() => ({
  refreshPreviewItemsFromFile: vi.fn(async () => undefined),
  refreshPreviewItemsFromRemoteWorkbenchTarget: vi.fn(async () => undefined),
}));

vi.mock('../../utils/preview-file-refresh', () => ({
  PREVIEW_FILE_CHANGE_REFRESH_OPTIONS: Object.freeze({
    retryMissing: true,
    retryUnchanged: true,
  }),
  PREVIEW_FILE_CATCH_UP_REFRESH_OPTIONS: Object.freeze({
    retryMissing: true,
  }),
  refreshPreviewItemsFromFile: mocks.refreshPreviewItemsFromFile,
}));

vi.mock('../../utils/remote-file-preview', () => ({
  isRemoteWorkbenchContentRef: (value: unknown) => {
    if (!value || typeof value !== 'object') return false;
    const ref = value as Record<string, unknown>;
    return (ref.kind === 'workbench-file' || ref.kind === 'mobile-workbench')
      && (typeof ref.mountId === 'string' || typeof ref.rootId === 'string')
      && typeof ref.subdir === 'string'
      && typeof ref.name === 'string';
  },
  normalizeWorkbenchContentRef: (ref: RemoteWorkbenchContentRef) => {
    const mountId = ref.mountId || ref.rootId || 'default';
    return {
      ...ref,
      kind: 'workbench-file',
      mountId,
      rootId: ref.rootId || mountId,
      subdir: ref.subdir || '',
    };
  },
  refreshPreviewItemsFromRemoteWorkbenchTarget: mocks.refreshPreviewItemsFromRemoteWorkbenchTarget,
}));

function localItem(id: string, filePath: string): PreviewItem {
  return {
    id,
    type: 'markdown',
    title: `${id}.md`,
    content: '# Demo',
    filePath,
  };
}

function remoteRef(name: string, mountId = 'mount_docs'): RemoteWorkbenchContentRef {
  return {
    kind: 'workbench-file',
    mountId,
    subdir: 'notes',
    name,
    contentPath: `/api/workbench/content?mountId=${mountId}&subdir=notes&name=${name}`,
  };
}

function remoteItem(id: string, ref: RemoteWorkbenchContentRef): PreviewItem {
  return {
    id,
    type: 'markdown',
    title: ref.name,
    content: '# Remote',
    storageKind: 'remote-content',
    remoteContentRef: ref,
  };
}

describe('preview document refresh', () => {
  beforeEach(() => {
    mocks.refreshPreviewItemsFromFile.mockClear();
    mocks.refreshPreviewItemsFromRemoteWorkbenchTarget.mockClear();
    useStore.setState({
      previewItems: [],
      openTabs: [],
      deskBasePath: '',
      deskWorkspaceMountId: null,
    } as Partial<StoreState>);
  });

  it('routes local and remote document targets through the same refresh contract', async () => {
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshPreviewDocumentTarget,
    } = await import('../../utils/preview-document-refresh');
    const target = remoteRef('remote.md');

    await refreshPreviewDocumentTarget({ kind: 'local-file', filePath: '/tmp/note.md' });
    await refreshPreviewDocumentTarget({ kind: 'workbench-file', target });

    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
      '/tmp/note.md',
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      target,
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });

  it('refreshes only open preview documents across local files and remote workbench targets', async () => {
    const sharedRemote = remoteRef('remote.md');
    useStore.setState({
      previewItems: [
        localItem('open-local', '/tmp/open.md'),
        localItem('duplicate-local', '/tmp/open.md'),
        localItem('closed-local', '/tmp/closed.md'),
        remoteItem('open-remote', sharedRemote),
        remoteItem('duplicate-remote', { ...sharedRemote, rootId: sharedRemote.mountId }),
        remoteItem('closed-remote', remoteRef('closed.md')),
      ],
      openTabs: ['open-local', 'duplicate-local', 'open-remote', 'duplicate-remote'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
      refreshOpenPreviewDocuments,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocuments();

    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
      '/tmp/open.md',
      PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
    );
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      sharedRemote,
      PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
    );
  });

  it('falls back to open preview documents when a change target does not match an open preview identity', async () => {
    const openRemote = remoteRef('open.md');
    useStore.setState({
      previewItems: [
        remoteItem('open-remote', openRemote),
      ],
      openTabs: ['open-remote'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshPreviewDocumentTarget,
    } = await import('../../utils/preview-document-refresh');

    await refreshPreviewDocumentTarget({ kind: 'local-file', filePath: '/tmp/open.md' });

    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
      '/tmp/open.md',
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      openRemote,
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });

  it('does not fall back when the target already matches an open preview document', async () => {
    useStore.setState({
      previewItems: [
        localItem('open-local', '/tmp/open.md'),
        remoteItem('other-remote', remoteRef('other.md')),
      ],
      openTabs: ['open-local', 'other-remote'],
    } as Partial<StoreState>);
    const { refreshPreviewDocumentTarget } = await import('../../utils/preview-document-refresh');

    await refreshPreviewDocumentTarget({ kind: 'local-file', filePath: '/tmp/open.md' });

    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).not.toHaveBeenCalled();
  });

  it('refreshes matching open preview documents for an external workspace file change', async () => {
    const openRemote = remoteRef('note.md', 'default');
    useStore.setState({
      deskBasePath: '/workspace',
      previewItems: [
        localItem('open-local', '/workspace/notes/local.md'),
        remoteItem('open-remote', openRemote),
        remoteItem('unrelated-remote', remoteRef('other.md', 'default')),
      ],
      openTabs: ['open-local', 'open-remote', 'unrelated-remote'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshOpenPreviewDocumentsForFilePath,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocumentsForFilePath('/workspace/notes/note.md');

    expect(mocks.refreshPreviewItemsFromFile).not.toHaveBeenCalled();
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      openRemote,
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });

  it('matches mounted workbench preview documents through the native root file path', async () => {
    const openRemote = remoteRef('note.md', 'mount_docs');
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceNativeRoot: '/Users/me/Documents',
      previewItems: [
        remoteItem('open-remote', openRemote),
      ],
      openTabs: ['open-remote'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshOpenPreviewDocumentsForFilePath,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocumentsForFilePath('/Users/me/Documents/notes/note.md');

    expect(mocks.refreshPreviewItemsFromFile).not.toHaveBeenCalled();
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      openRemote,
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });

  it('builds mount ResourceRefs for mounted workbench preview documents', async () => {
    const openRemote = remoteRef('note.md', 'mount_docs');
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceNativeRoot: '/Users/me/Documents',
      previewItems: [
        remoteItem('open-remote', openRemote),
      ],
      openTabs: ['open-remote'],
    } as Partial<StoreState>);
    const {
      openPreviewDocumentWatchResources,
    } = await import('../../utils/preview-document-refresh');

    expect(openPreviewDocumentWatchResources().map(item => item.ref)).toEqual([
      { kind: 'mount', mountId: 'mount_docs', path: 'notes/note.md' },
    ]);
  });

  it('refreshes matching open documents from a ResourceIO local change event', async () => {
    useStore.setState({
      previewItems: [
        localItem('open-local', '/workspace/notes/local.md'),
        localItem('closed-local', '/workspace/notes/closed.md'),
      ],
      openTabs: ['open-local'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshOpenPreviewDocumentsForResourceChange,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocumentsForResourceChange({
      type: 'resource.changed',
      resource: {
        kind: 'local-file',
        provider: 'local_fs',
        path: '/workspace/notes/local.md',
      },
    } satisfies ResourceChangeEvent);

    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
      '/workspace/notes/local.md',
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });

  it('refreshes matching open documents from ResourceIO deleted and renamed events', async () => {
    useStore.setState({
      previewItems: [
        localItem('deleted-local', '/workspace/notes/deleted.md'),
        localItem('old-local', '/workspace/notes/old.md'),
        localItem('new-local', '/workspace/notes/new.md'),
      ],
      openTabs: ['deleted-local', 'old-local', 'new-local'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshOpenPreviewDocumentsForResourceChange,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocumentsForResourceChange({
      type: 'resource.deleted',
      resource: {
        kind: 'local-file',
        provider: 'local_fs',
        path: '/workspace/notes/deleted.md',
      },
    } satisfies ResourceChangeEvent);

    await refreshOpenPreviewDocumentsForResourceChange({
      type: 'resource.renamed',
      oldResource: {
        kind: 'local-file',
        provider: 'local_fs',
        path: '/workspace/notes/old.md',
      },
      newResource: {
        kind: 'local-file',
        provider: 'local_fs',
        path: '/workspace/notes/new.md',
      },
    } satisfies ResourceChangeEvent);

    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledTimes(3);
    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
      '/workspace/notes/deleted.md',
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
      '/workspace/notes/old.md',
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
      '/workspace/notes/new.md',
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });

  it('refreshes mounted workbench preview documents from ResourceIO mount events with native file projections', async () => {
    const openRemote = remoteRef('note.md', 'mount_docs');
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceNativeRoot: '/Users/me/Documents',
      previewItems: [
        remoteItem('open-remote', openRemote),
      ],
      openTabs: ['open-remote'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshOpenPreviewDocumentsForResourceChange,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocumentsForResourceChange({
      type: 'resource.changed',
      resource: {
        kind: 'mount',
        provider: 'mount',
        mountId: 'mount_docs',
        path: 'notes/note.md',
        filePath: '/Users/me/Documents/notes/note.md',
      },
    } satisfies ResourceChangeEvent);

    expect(mocks.refreshPreviewItemsFromFile).not.toHaveBeenCalled();
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      openRemote,
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });

  it('matches mounted workbench preview documents by mount registry when another mount is active', async () => {
    const openRemote = remoteRef('note.md', 'mount_docs');
    useStore.setState({
      deskBasePath: 'studio:mount_other',
      deskWorkspaceMountId: 'mount_other',
      deskWorkspaceNativeRoot: '/Users/me/Other',
      studioWorkspaces: [
        { mountId: 'mount_docs', label: 'Docs', nativeRootPath: '/Users/me/Documents' },
        { mountId: 'mount_other', label: 'Other', nativeRootPath: '/Users/me/Other' },
      ],
      previewItems: [
        remoteItem('open-remote', openRemote),
      ],
      openTabs: ['open-remote'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      openPreviewDocumentWatchFilePaths,
      refreshOpenPreviewDocumentsForFilePath,
    } = await import('../../utils/preview-document-refresh');

    expect(openPreviewDocumentWatchFilePaths()).toEqual(['/Users/me/Documents/notes/note.md']);

    await refreshOpenPreviewDocumentsForFilePath('/Users/me/Documents/notes/note.md');
    expect(mocks.refreshPreviewItemsFromFile).not.toHaveBeenCalled();
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      openRemote,
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });

  it('refreshes open local preview documents below a ResourceIO directory change', async () => {
    useStore.setState({
      previewItems: [
        localItem('open-child', '/workspace/notes/a.md'),
        localItem('open-other', '/workspace/other/a.md'),
      ],
      openTabs: ['open-child', 'open-other'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshOpenPreviewDocumentsForResourceChange,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocumentsForResourceChange({
      type: 'resource.changed',
      resource: {
        kind: 'local-file',
        provider: 'local_fs',
        path: '/workspace/notes',
        isDirectory: true,
      },
    } satisfies ResourceChangeEvent);

    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
      '/workspace/notes/a.md',
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).not.toHaveBeenCalled();
  });

  it('refreshes mounted workbench preview documents from mount resource events without native file projections', async () => {
    const openRemote = remoteRef('note.md', 'mount_docs');
    useStore.setState({
      previewItems: [
        remoteItem('open-remote', openRemote),
        remoteItem('unrelated-remote', remoteRef('other.md', 'mount_docs')),
      ],
      openTabs: ['open-remote', 'unrelated-remote'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshOpenPreviewDocumentsForResourceChange,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocumentsForResourceChange({
      type: 'resource.changed',
      resource: {
        kind: 'mount',
        provider: 'mount',
        mountId: 'mount_docs',
        path: 'notes/note.md',
      },
    } satisfies ResourceChangeEvent);

    expect(mocks.refreshPreviewItemsFromFile).not.toHaveBeenCalled();
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      openRemote,
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });

  it('refreshes mounted workbench child documents below a mount directory event', async () => {
    const openRemote = remoteRef('note.md', 'mount_docs');
    useStore.setState({
      previewItems: [
        remoteItem('open-remote', openRemote),
        remoteItem('unrelated-remote', { ...remoteRef('root.md', 'mount_docs'), subdir: '' }),
      ],
      openTabs: ['open-remote', 'unrelated-remote'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshOpenPreviewDocumentsForResourceChange,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocumentsForResourceChange({
      type: 'resource.changed',
      resource: {
        kind: 'mount',
        provider: 'mount',
        mountId: 'mount_docs',
        path: 'notes',
        isDirectory: true,
      },
    } satisfies ResourceChangeEvent);

    expect(mocks.refreshPreviewItemsFromFile).not.toHaveBeenCalled();
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).toHaveBeenCalledWith(
      openRemote,
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
  });

  it('refreshes local native-open documents below a projected mount directory event', async () => {
    useStore.setState({
      previewItems: [
        localItem('native-open', '/Users/me/Documents/notes/note.md'),
        localItem('native-other', '/Users/me/Documents/archive/note.md'),
      ],
      openTabs: ['native-open', 'native-other'],
    } as Partial<StoreState>);
    const {
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      refreshOpenPreviewDocumentsForResourceChange,
    } = await import('../../utils/preview-document-refresh');

    await refreshOpenPreviewDocumentsForResourceChange({
      type: 'resource.changed',
      resource: {
        kind: 'mount',
        provider: 'mount',
        mountId: 'mount_docs',
        path: 'notes',
        filePath: '/Users/me/Documents/notes',
        isDirectory: true,
      },
    } satisfies ResourceChangeEvent);

    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledTimes(1);
    expect(mocks.refreshPreviewItemsFromFile).toHaveBeenCalledWith(
      '/Users/me/Documents/notes/note.md',
      PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
    );
    expect(mocks.refreshPreviewItemsFromRemoteWorkbenchTarget).not.toHaveBeenCalled();
  });
});
