import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

// vi.hoisted: the mock factory below is hoisted above this file's imports, and
// importing the store now reaches use-hana-fetch during that hoisted phase.
const mockHanaFetch = vi.hoisted(() => vi.fn());

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: mockHanaFetch,
}));

vi.mock('../../stores/agent-actions', () => ({
  clearChat: vi.fn(),
}));

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

function jsonStatusResponse(body: unknown, status: number): Response {
  return { status, json: async () => body } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('desk-actions workspace roots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as any).document;
    mockHanaFetch.mockReset();
    mockHanaFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/preferences/workspace-ui-state')) return jsonResponse({ state: null });
      if (url.startsWith('/api/desk/jian')) return jsonResponse({ content: null });
      return jsonResponse({});
    });
    (globalThis as any).window = {
      t: (key: string) => key,
      platform: {
        readFileSnapshot: vi.fn(async (filePath: string) => ({
          content: `content:${filePath}`,
          version: { mtimeMs: 1, size: 10, sha256: 'hash' },
        })),
        getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
      },
    };
    useStore.setState({
      serverPort: 62950,
      activeServerConnection: null,
      activeServerConnectionId: null,
      serverConnections: {},
      deskBasePath: '',
      deskWorkspaceMountId: null,
      deskWorkspaceLabel: null,
      deskCurrentPath: '',
      deskFiles: [],
      deskTreeFilesByPath: {},
      deskExpandedPaths: [],
      deskSelectedPath: '',
      deskJianContent: null,
      cwdSkills: [],
      cwdSkillsOpen: false,
      workspaceDeskStateByRoot: {},
      previewOpen: false,
      previewItems: [],
      openTabs: [],
      activeTabId: null,
      selectedFolder: '/home-folder',
      selectedWorkspaceMountId: null,
      selectedWorkspaceLabel: null,
      studioWorkspaces: [],
      homeFolder: '/fallback-home',
      workspaceFolders: [],
      pendingNewSession: true,
      currentSessionPath: null,
      currentAgentId: 'hana',
      selectedAgentId: null,
    } as never);
  });

  it('loads the selected/home folder when no explicit override is passed', async () => {
    mockHanaFetch
      .mockResolvedValueOnce(jsonResponse({ files: [], basePath: '/home-folder' }))
      .mockResolvedValueOnce(jsonResponse({ content: null }));

    const { loadDeskFiles } = await import('../../stores/desk-actions');
    await loadDeskFiles();

    expect(mockHanaFetch).toHaveBeenNthCalledWith(
      1,
      '/api/desk/files?dir=%2Fhome-folder',
    );
  });

  it('passes the selected agent id when loading the selected agent workbench', async () => {
    useStore.setState({
      currentAgentId: 'hana',
      selectedAgentId: 'mio',
      selectedFolder: '/workspace/Mio',
      deskBasePath: '/workspace/Mio',
    } as never);
    mockHanaFetch
      .mockResolvedValueOnce(jsonResponse({ files: [], basePath: '/workspace/Mio' }))
      .mockResolvedValueOnce(jsonResponse({ content: null }));

    const { loadDeskFiles } = await import('../../stores/desk-actions');
    await loadDeskFiles();

    expect(mockHanaFetch).toHaveBeenNthCalledWith(
      1,
      '/api/desk/files?dir=%2Fworkspace%2FMio&agentId=mio',
    );
  });

  it('prunes a stale local workspace history entry when the selected local root is missing', async () => {
    useStore.setState({
      selectedFolder: '/workspace/Missing',
      deskBasePath: '/workspace/Missing',
      cwdHistory: ['/workspace/Missing', '/workspace/Keep'],
      deskFiles: [{ name: 'old.md', isDir: false }],
      deskTreeFilesByPath: { '': [{ name: 'old.md', isDir: false }] },
    } as never);
    mockHanaFetch
      .mockResolvedValueOnce(jsonStatusResponse({ error: { code: 'resource_not_found', message: 'missing' } }, 404))
      .mockResolvedValueOnce(jsonResponse({ cwd_history: ['/workspace/Keep'] }));

    const { loadDeskFiles } = await import('../../stores/desk-actions');
    await loadDeskFiles();

    expect(useStore.getState().selectedFolder).toBeNull();
    expect(useStore.getState().deskBasePath).toBe('');
    expect(useStore.getState().deskFiles).toEqual([]);
    expect(useStore.getState().deskTreeFilesByPath).toEqual({});
    expect(useStore.getState().cwdHistory).toEqual(['/workspace/Keep']);
    expect(mockHanaFetch).toHaveBeenNthCalledWith(
      2,
      '/api/config/workspaces/recent?agentId=hana',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ path: '/workspace/Missing' }),
      }),
    );
  });

  it('keeps local workspace history on permission errors', async () => {
    useStore.setState({
      selectedFolder: '/workspace/Private',
      deskBasePath: '/workspace/Private',
      cwdHistory: ['/workspace/Private', '/workspace/Keep'],
      deskFiles: [{ name: 'private.md', isDir: false }],
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonStatusResponse({
      error: { code: 'insufficient_scope', message: 'forbidden' },
    }, 403));

    const { loadDeskFiles } = await import('../../stores/desk-actions');
    await loadDeskFiles();

    expect(useStore.getState().selectedFolder).toBe('/workspace/Private');
    expect(useStore.getState().deskBasePath).toBe('/workspace/Private');
    expect(useStore.getState().cwdHistory).toEqual(['/workspace/Private', '/workspace/Keep']);
    expect(mockHanaFetch).toHaveBeenCalledTimes(1);
  });

  it('loads files through the workbench mount route when a Studio workspace is active', async () => {
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceLabel: 'Docs',
    } as never);
    mockHanaFetch
      .mockResolvedValueOnce(jsonResponse({
        mountId: 'mount_docs',
        mount: { label: 'Docs' },
        files: [{ name: 'remote.md', isDir: false }],
      }))
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' } as unknown as Response);

    const { loadDeskFiles } = await import('../../stores/desk-actions');
    await loadDeskFiles();

    expect(mockHanaFetch).toHaveBeenNthCalledWith(
      1,
      '/api/workbench/files?mountId=mount_docs',
    );
    expect(useStore.getState().deskFiles).toEqual([{ name: 'remote.md', isDir: false }]);
    expect(useStore.getState().deskBasePath).toBe('studio:mount_docs');
  });

  it('does not prune local workspace history when a Studio mount load returns 404', async () => {
    const existingFiles = [{ name: 'remote.md', isDir: false }];
    useStore.setState({
      selectedFolder: '/workspace/Local',
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceLabel: 'Docs',
      cwdHistory: ['/workspace/Local'],
      deskFiles: existingFiles,
      deskTreeFilesByPath: { '': existingFiles },
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonStatusResponse({
      error: { code: 'resource_not_found', message: 'missing' },
    }, 404));

    const { loadDeskFiles } = await import('../../stores/desk-actions');
    await loadDeskFiles();

    expect(useStore.getState().selectedFolder).toBe('/workspace/Local');
    expect(useStore.getState().cwdHistory).toEqual(['/workspace/Local']);
    expect(useStore.getState().deskBasePath).toBe('studio:mount_docs');
    expect(useStore.getState().deskFiles).toBe(existingFiles);
    expect(mockHanaFetch).toHaveBeenCalledTimes(1);
  });

  it('stores the disclosed native root of a local_fs workspace from the workbench files response', async () => {
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceLabel: 'Docs',
    } as never);
    mockHanaFetch
      .mockResolvedValueOnce(jsonResponse({
        mountId: 'mount_docs',
        mount: { label: 'Docs', nativeRootPath: '/Users/me/docs' },
        files: [{ name: 'remote.md', isDir: false }],
      }))
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' } as unknown as Response);

    const { loadDeskFiles } = await import('../../stores/desk-actions');
    await loadDeskFiles();

    expect(useStore.getState().deskWorkspaceNativeRoot).toBe('/Users/me/docs');
  });

  it('keeps the visible mounted workspace files when a refresh fails', async () => {
    const existingFiles = [{ name: 'existing.md', isDir: false }];
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceLabel: 'Docs',
      deskFiles: existingFiles,
      deskTreeFilesByPath: { '': existingFiles },
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({ error: 'workspace_not_found' }));

    const { loadDeskFiles } = await import('../../stores/desk-actions');
    await loadDeskFiles('', null, 'mount_docs');

    expect(useStore.getState().deskFiles).toBe(existingFiles);
    expect(useStore.getState().deskTreeFilesByPath['']).toBe(existingFiles);
  });

  it('keeps cached tree children when a background tree refresh fails', async () => {
    const existingChildren = [{ name: 'child.md', isDir: false }];
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceLabel: 'Docs',
      deskTreeFilesByPath: { docs: existingChildren },
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({ error: 'workspace_not_found' }));

    const { loadDeskTreeFiles } = await import('../../stores/desk-actions');
    await loadDeskTreeFiles('docs', { force: true });

    expect(useStore.getState().deskTreeFilesByPath.docs).toBe(existingChildren);
  });

  it('clears the stored native root when the workbench files response stops disclosing it', async () => {
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceLabel: 'Docs',
      deskWorkspaceNativeRoot: '/Users/me/docs',
    } as never);
    mockHanaFetch
      .mockResolvedValueOnce(jsonResponse({
        mountId: 'mount_docs',
        mount: { label: 'Docs' },
        files: [],
      }))
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' } as unknown as Response);

    const { loadDeskFiles } = await import('../../stores/desk-actions');
    await loadDeskFiles();

    expect(useStore.getState().deskWorkspaceNativeRoot).toBeNull();
  });

  it('seeds the native root when applying a studio workspace and resets it for plain folders', async () => {
    mockHanaFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/workbench/files')) {
        return jsonResponse({
          mountId: 'mount_docs',
          mount: { label: 'Docs', nativeRootPath: '/Users/me/docs' },
          files: [],
        });
      }
      if (url.startsWith('/api/workbench/content')) {
        return { ok: false, status: 404, text: async () => '' } as unknown as Response;
      }
      if (url.startsWith('/api/preferences/workspace-ui-state')) return jsonResponse({ state: null });
      if (url.startsWith('/api/desk/')) return jsonResponse({ files: [], content: null });
      if (url.startsWith('/api/config/workspaces/recent')) return jsonResponse({ cwd_history: [] });
      return jsonResponse({});
    });

    const { applyStudioWorkspace, applyFolder } = await import('../../stores/desk-actions');
    await applyStudioWorkspace({
      mountId: 'mount_docs',
      label: 'Docs',
      nativeRootPath: '/Users/me/docs',
    });

    expect(useStore.getState().deskWorkspaceMountId).toBe('mount_docs');
    expect(useStore.getState().deskWorkspaceNativeRoot).toBe('/Users/me/docs');

    await applyFolder('/Users/me/plain');

    expect(useStore.getState().deskWorkspaceMountId).toBeNull();
    expect(useStore.getState().deskWorkspaceNativeRoot).toBeNull();
  });

  it('adds and removes extra workspace folders without changing the primary folder', async () => {
    const { addWorkspaceFolder, removeWorkspaceFolder } = await import('../../stores/desk-actions');

    addWorkspaceFolder('/reference');
    addWorkspaceFolder('/home-folder');
    addWorkspaceFolder('/reference');

    expect(useStore.getState().selectedFolder).toBe('/home-folder');
    expect(useStore.getState().workspaceFolders).toEqual(['/reference']);

    removeWorkspaceFolder('/reference');
    expect(useStore.getState().workspaceFolders).toEqual([]);
  });

  it('records the selected workspace in the local picker history when switching folders', async () => {
    useStore.setState({
      selectedFolder: '/hana',
      homeFolder: '/hana',
      cwdHistory: ['/workspace/Desktop'],
    } as never);
    mockHanaFetch
      .mockResolvedValueOnce(jsonResponse({ cwd_history: ['/workspace/Desktop'] }))
      .mockResolvedValueOnce(jsonResponse({ files: [], basePath: '/workspace/Desktop' }))
      .mockResolvedValueOnce(jsonResponse({ content: null }));

    const { applyFolder } = await import('../../stores/desk-actions');
    applyFolder('/workspace/Desktop');

    expect(useStore.getState().selectedFolder).toBe('/workspace/Desktop');
    expect(useStore.getState().cwdHistory).toEqual(['/workspace/Desktop']);
  });

  it('promotes an extra folder to primary instead of keeping it in both lists', async () => {
    useStore.setState({
      selectedFolder: '/hana',
      homeFolder: '/hana',
      cwdHistory: ['/workspace/Desktop'],
      workspaceFolders: ['/reference', '/workspace/Desktop'],
    } as never);
    mockHanaFetch
      .mockResolvedValueOnce(jsonResponse({ cwd_history: ['/workspace/Desktop'] }))
      .mockResolvedValueOnce(jsonResponse({ files: [], basePath: '/workspace/Desktop' }))
      .mockResolvedValueOnce(jsonResponse({ content: null }));

    const { applyFolder } = await import('../../stores/desk-actions');
    applyFolder('/workspace/Desktop');

    expect(useStore.getState().selectedFolder).toBe('/workspace/Desktop');
    expect(useStore.getState().cwdHistory).toEqual(['/workspace/Desktop']);
    expect(useStore.getState().workspaceFolders).toEqual(['/reference']);
  });

  it('removes recent workspaces locally and persists the history deletion', async () => {
    useStore.setState({
      cwdHistory: ['/workspace/Desktop', '/workspace/Novel'],
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({ cwd_history: ['/workspace/Novel'] }));

    const { removeRecentWorkspace } = await import('../../stores/desk-actions');
    await removeRecentWorkspace('/workspace/Desktop/');

    expect(useStore.getState().cwdHistory).toEqual(['/workspace/Novel']);
    expect(mockHanaFetch).toHaveBeenCalledWith(
      '/api/config/workspaces/recent?agentId=hana',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ path: '/workspace/Desktop' }),
      }),
    );
  });

  it('does not record recent-workspace changes against a guessed agent when none is current', async () => {
    // Recent workspaces live in one agent's own config. With no current agent
    // there is nobody to attribute the change to, and asking the server to pick
    // is how the wrong agent's history gets edited — so no request goes out.
    useStore.setState({
      currentAgentId: null,
      cwdHistory: ['/workspace/Desktop', '/workspace/Novel'],
    } as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { removeRecentWorkspace, clearRecentWorkspaces } = await import('../../stores/desk-actions');
    await removeRecentWorkspace('/workspace/Desktop');
    await clearRecentWorkspaces();

    expect(mockHanaFetch.mock.calls.some(([url]) => String(url).includes('/api/config/workspaces/recent'))).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('removes a Studio workspace mount and clears the selected mount when it was active', async () => {
    useStore.setState({
      selectedWorkspaceMountId: 'mount_docs',
      selectedWorkspaceLabel: 'Docs',
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceLabel: 'Docs',
      studioWorkspaces: [
        { workspaceId: 'default', mountId: 'default', label: 'Default', isDefault: true },
        { workspaceId: 'mount_docs', mountId: 'mount_docs', label: 'Docs', isDefault: false },
      ],
    } as never);
    mockHanaFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/studio/workspaces/mount_docs' && opts?.method === 'DELETE') {
        return jsonResponse({ ok: true, mountId: 'mount_docs' });
      }
      if (url === '/api/studio/workspaces') {
        return jsonResponse({
          workspaces: [{ workspaceId: 'default', mountId: 'default', label: 'Default', isDefault: true }],
        });
      }
      if (url.startsWith('/api/preferences/workspace-ui-state')) return jsonResponse({ state: null });
      return jsonResponse({});
    });

    const { removeStudioWorkspace } = await import('../../stores/desk-actions');
    await removeStudioWorkspace('mount_docs');

    expect(useStore.getState().studioWorkspaces.map(workspace => workspace.mountId)).toEqual(['default']);
    expect(useStore.getState().selectedWorkspaceMountId).toBeNull();
    expect(useStore.getState().deskWorkspaceMountId).toBeNull();
    expect(useStore.getState().deskBasePath).toBe('');
    expect(mockHanaFetch).toHaveBeenCalledWith(
      '/api/studio/workspaces/mount_docs',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('clears recent workspace history through the server API', async () => {
    useStore.setState({
      cwdHistory: ['/workspace/Desktop', '/workspace/Novel'],
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({ cwd_history: [] }));

    const { clearRecentWorkspaces } = await import('../../stores/desk-actions');
    await clearRecentWorkspaces();

    expect(useStore.getState().cwdHistory).toEqual([]);
    expect(mockHanaFetch).toHaveBeenCalledWith(
      '/api/config/workspaces/recent/all?agentId=hana',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('persists the selected workspace before refreshing the visible desk root', async () => {
    const persist = deferred<Response>();
    mockHanaFetch
      .mockResolvedValueOnce(jsonResponse({ state: null }))
      .mockReturnValueOnce(persist.promise)
      .mockResolvedValueOnce(jsonResponse({ files: [{ name: 'note.md' }], basePath: '/workspace/Desktop' }))
      .mockResolvedValueOnce(jsonResponse({ content: null }));

    const { applyFolder } = await import('../../stores/desk-actions');
    const run = applyFolder('/workspace/Desktop');

    expect(useStore.getState().selectedFolder).toBe('/workspace/Desktop');
    expect(useStore.getState().deskBasePath).toBe('/workspace/Desktop');
    expect(useStore.getState().deskFiles).toEqual([]);
    expect(mockHanaFetch).toHaveBeenCalledTimes(2);
    expect(mockHanaFetch).toHaveBeenNthCalledWith(
      1,
      '/api/preferences/workspace-ui-state?workspace=%2Fworkspace%2FDesktop&surface=electron',
    );
    expect(mockHanaFetch).toHaveBeenNthCalledWith(
      2,
      '/api/config/workspaces/recent?agentId=hana',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/workspace/Desktop' }),
      }),
    );

    persist.resolve(jsonResponse({ cwd_history: ['/workspace/Desktop'] }));
    await run;

    expect(mockHanaFetch).toHaveBeenNthCalledWith(
      3,
      '/api/desk/files?dir=%2Fworkspace%2FDesktop',
    );
    expect(useStore.getState().deskBasePath).toBe('/workspace/Desktop');
    expect(useStore.getState().deskFiles).toEqual([{ name: 'note.md' }]);
  });

  it('persists preview panel layout as part of the workspace UI state', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskCurrentPath: 'src',
      deskExpandedPaths: ['src'],
      deskSelectedPath: 'src/App.tsx',
      rightWorkspaceTab: 'workspace',
      jianView: 'desk',
      jianDrawerOpen: true,
      previewOpen: true,
      openTabs: ['file-/workspace/src/App.tsx', 'memory-note'],
      activeTabId: 'file-/workspace/src/App.tsx',
      previewReadingPositions: {
        'file-/workspace/src/App.tsx': {
          preview: {
            scrollTop: 320,
            scrollHeight: 1400,
            clientHeight: 700,
            ratio: 0.5,
            anchorId: 'intro',
            contentHash: 'hash-a',
          },
          currentHeadingId: 'intro',
          currentHeadingText: 'Intro',
          contentHash: 'hash-a',
        },
      },
      previewItems: [
        {
          id: 'file-/workspace/src/App.tsx',
          type: 'code',
          title: 'App.tsx',
          content: 'content is not persisted',
          filePath: '/workspace/src/App.tsx',
          ext: 'tsx',
          language: 'tsx',
          sourceRootPath: '/workspace',
        },
        {
          id: 'memory-note',
          type: 'markdown',
          title: 'memory',
          content: 'transient',
        },
      ],
    } as never);

    const { persistCurrentWorkspaceUiStateNow } = await import('../../stores/workspace-ui-state-actions');
    await persistCurrentWorkspaceUiStateNow('/workspace');

    expect(mockHanaFetch).toHaveBeenCalledWith('/api/preferences/workspace-ui-state', expect.objectContaining({
      method: 'PUT',
    }));
    const [, requestInit] = mockHanaFetch.mock.calls.at(-1) || [];
    const body = JSON.parse(String((requestInit as RequestInit).body));
    expect(body).toMatchObject({
      workspace: '/workspace',
      surface: 'electron',
      state: {
        deskExpandedPaths: ['src'],
        deskSelectedPath: 'src/App.tsx',
        rightWorkspaceTab: 'workspace',
        jianView: 'desk',
        jianDrawerOpen: true,
        previewOpen: true,
        openTabs: ['file-/workspace/src/App.tsx'],
        activeTabId: 'file-/workspace/src/App.tsx',
        previewTabs: [{
          id: 'file-/workspace/src/App.tsx',
          filePath: '/workspace/src/App.tsx',
          relativePath: 'src/App.tsx',
          title: 'App.tsx',
          type: 'code',
          ext: 'tsx',
          language: 'tsx',
          sourceRootPath: '/workspace',
          readingPosition: {
            preview: {
              scrollTop: 320,
              scrollHeight: 1400,
              clientHeight: 700,
              ratio: 0.5,
              anchorId: 'intro',
              contentHash: 'hash-a',
            },
            currentHeadingId: 'intro',
            currentHeadingText: 'Intro',
            contentHash: 'hash-a',
          },
        }],
      },
    });
    expect(body.state).not.toHaveProperty('deskCurrentPath');
  });

  it('persists the workspace snapshot captured before switching roots', async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({
        deskBasePath: '/workspace-a',
        deskCurrentPath: 'notes',
        deskExpandedPaths: ['notes'],
        deskSelectedPath: 'notes/a.md',
        rightWorkspaceTab: 'workspace',
        jianView: 'desk',
        jianDrawerOpen: true,
        previewOpen: true,
        openTabs: ['file-/workspace-a/notes/a.md'],
        activeTabId: 'file-/workspace-a/notes/a.md',
        previewItems: [{
          id: 'file-/workspace-a/notes/a.md',
          type: 'markdown',
          title: 'a.md',
          content: 'old workspace content',
          filePath: '/workspace-a/notes/a.md',
          ext: 'md',
        }],
      } as never);

      const { activateWorkspaceDesk } = await import('../../stores/desk-actions');
      await activateWorkspaceDesk('/workspace-b', { reload: false });
      await vi.runOnlyPendingTimersAsync();

      const putCall = mockHanaFetch.mock.calls.find(([url, init]) =>
        url === '/api/preferences/workspace-ui-state' && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(String((putCall?.[1] as RequestInit).body));
      expect(body).toMatchObject({
        workspace: '/workspace-a',
        state: {
          deskExpandedPaths: ['notes'],
          deskSelectedPath: 'notes/a.md',
          jianDrawerOpen: true,
          previewOpen: true,
          openTabs: ['file-/workspace-a/notes/a.md'],
          activeTabId: 'file-/workspace-a/notes/a.md',
          previewTabs: [{
            id: 'file-/workspace-a/notes/a.md',
            filePath: '/workspace-a/notes/a.md',
            relativePath: 'notes/a.md',
          }],
        },
      });
      expect(body.state).not.toHaveProperty('deskCurrentPath');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps visible desk state keyed by workspace root', async () => {
    useStore.setState({
      deskBasePath: '/workspace-a',
      deskCurrentPath: 'notes/daily',
      deskFiles: [{ name: 'a.md' }],
      deskTreeFilesByPath: { '': [{ name: 'notes', isDir: true }], notes: [{ name: 'a.md', isDir: false }] },
      deskExpandedPaths: ['notes'],
      deskSelectedPath: 'notes/a.md',
      deskJianContent: 'a-note',
      cwdSkills: [{ name: 'skill-a', description: '', source: 'workspace', filePath: '/workspace-a/.agents/skills/a/SKILL.md', baseDir: '/workspace-a/.agents/skills/a' }],
      cwdSkillsOpen: true,
      jianDrawerOpen: true,
      previewOpen: true,
      openTabs: ['previewItem-a'],
      activeTabId: 'previewItem-a',
      previewItems: [{
        id: 'previewItem-a',
        type: 'markdown',
        title: 'a.md',
        content: 'a',
        filePath: '/workspace-a/notes/a.md',
        ext: 'md',
      }],
    } as never);

    const { activateWorkspaceDesk } = await import('../../stores/desk-actions');

    await activateWorkspaceDesk('/workspace-b', { reload: false });

    expect(useStore.getState().deskBasePath).toBe('/workspace-b');
    expect(useStore.getState().deskCurrentPath).toBe('');
    expect(useStore.getState().previewOpen).toBe(false);
    expect(useStore.getState().openTabs).toEqual([]);
    expect(useStore.getState().activeTabId).toBeNull();
    expect(useStore.getState().jianDrawerOpen).toBe(false);
    expect(useStore.getState().workspaceDeskStateByRoot['/workspace-a'].previewOpen).toBe(true);
    expect(useStore.getState().workspaceDeskStateByRoot['/workspace-a'].openTabs).toEqual(['previewItem-a']);
    expect(useStore.getState().workspaceDeskStateByRoot['/workspace-a'].activeTabId).toBe('previewItem-a');

    useStore.setState({
      deskCurrentPath: 'src',
      deskFiles: [{ name: 'b.md' }],
      deskTreeFilesByPath: { '': [{ name: 'src', isDir: true }], src: [{ name: 'b.md', isDir: false }] },
      deskExpandedPaths: ['src'],
      deskSelectedPath: 'src/b.md',
      deskJianContent: 'b-note',
      previewOpen: false,
      jianDrawerOpen: true,
      openTabs: ['previewItem-b'],
      activeTabId: 'previewItem-b',
    } as never);

    await activateWorkspaceDesk('/workspace-a', { reload: false });

    expect(useStore.getState().deskBasePath).toBe('/workspace-a');
    expect(useStore.getState().deskCurrentPath).toBe('');
    expect(useStore.getState().deskFiles).toEqual([]);
    expect(useStore.getState().deskTreeFilesByPath).toEqual({
      '': [{ name: 'notes', isDir: true }],
      notes: [{ name: 'a.md', isDir: false }],
    });
    expect(useStore.getState().deskExpandedPaths).toEqual(['notes']);
    expect(useStore.getState().deskSelectedPath).toBe('notes/a.md');
    expect(useStore.getState().deskJianContent).toBeNull();
    expect(useStore.getState().cwdSkillsOpen).toBe(true);
    expect(useStore.getState().jianDrawerOpen).toBe(true);
    expect(useStore.getState().previewOpen).toBe(true);
    expect(useStore.getState().openTabs).toEqual(['previewItem-a']);
    expect(useStore.getState().activeTabId).toBe('previewItem-a');
  });

  it('restores persisted workspace preview state from the backend when memory has no entry', async () => {
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      state: {
        deskCurrentPath: 'src/react',
        deskExpandedPaths: ['src', 'src/react'],
        deskSelectedPath: 'src/react/App.tsx',
        jianDrawerOpen: true,
        previewOpen: true,
        openTabs: ['file-src/react/App.tsx'],
        activeTabId: 'file-src/react/App.tsx',
        previewTabs: [
          {
            id: 'file-src/react/App.tsx',
            relativePath: 'src/react/App.tsx',
            title: 'App.tsx',
            type: 'code',
            ext: 'tsx',
            language: 'tsx',
            readingPosition: {
              preview: {
                scrollTop: 144,
                ratio: 0.25,
                anchorId: 'setup',
              },
              currentHeadingId: 'setup',
              currentHeadingText: 'Setup',
            },
          },
        ],
      },
    }));
    useStore.setState({
      previewOpen: false,
      openTabs: ['runtime-preview'],
      activeTabId: 'runtime-preview',
    } as never);

    const { activateWorkspaceDesk } = await import('../../stores/desk-actions');
    await activateWorkspaceDesk('/workspace', { reload: false });

    expect(mockHanaFetch).toHaveBeenCalledWith('/api/preferences/workspace-ui-state?workspace=%2Fworkspace&surface=electron');
    expect(useStore.getState().deskCurrentPath).toBe('');
    expect(useStore.getState().deskExpandedPaths).toEqual(['src', 'src/react']);
    expect(useStore.getState().deskSelectedPath).toBe('src/react/App.tsx');
    expect(useStore.getState().jianDrawerOpen).toBe(true);
    expect(useStore.getState().previewOpen).toBe(true);
    expect(useStore.getState().openTabs).toEqual(['file-src/react/App.tsx']);
    expect(useStore.getState().activeTabId).toBe('file-src/react/App.tsx');
    expect(useStore.getState().previewReadingPositions).toEqual({
      'file-src/react/App.tsx': {
        preview: {
          scrollTop: 144,
          ratio: 0.25,
          anchorId: 'setup',
        },
        currentHeadingId: 'setup',
        currentHeadingText: 'Setup',
      },
    });
    expect(useStore.getState().previewItems).toEqual([
      expect.objectContaining({
        id: 'file-src/react/App.tsx',
        filePath: '/workspace/src/react/App.tsx',
        title: 'App.tsx',
        content: 'content:/workspace/src/react/App.tsx',
        fileVersion: { mtimeMs: 1, size: 10, sha256: 'hash' },
      }),
    ]);
    expect(window.platform?.readFileSnapshot).toHaveBeenCalledWith('/workspace/src/react/App.tsx');
  });

  it('hydrates persisted preview metadata needed by PDF and HTML renderers', async () => {
    const {
      hydratePersistedPreviewItems,
      readingPositionsFromPersistedWorkspaceUiState,
    } = await import('../../stores/workspace-ui-state-actions');

    const persisted = {
      previewTabs: [
        {
          id: 'file-docs/report.pdf',
          relativePath: 'docs/report.pdf',
          title: 'report.pdf',
          type: 'pdf',
          ext: 'pdf',
        },
        {
          id: 'file-pages/demo.html',
          relativePath: 'pages/demo.html',
          title: 'demo.html',
          type: 'html',
          ext: 'html',
          sourceRootPath: '/workspace',
          readingPosition: {
            preview: {
              scrollTop: 64,
              ratio: 0.2,
              anchorId: 'demo',
            },
            currentHeadingId: 'demo',
            currentHeadingText: 'Demo',
          },
        },
      ],
    };

    const items = await hydratePersistedPreviewItems('/workspace', persisted);

    expect(window.platform?.getFileUrl).toHaveBeenCalledWith('/workspace/docs/report.pdf');
    expect(items).toEqual([
      expect.objectContaining({
        id: 'file-docs/report.pdf',
        type: 'pdf',
        filePath: '/workspace/docs/report.pdf',
        content: '',
        sourceUrl: 'file:///workspace/docs/report.pdf',
      }),
      expect.objectContaining({
        id: 'file-pages/demo.html',
        type: 'html',
        filePath: '/workspace/pages/demo.html',
        content: 'content:/workspace/pages/demo.html',
        sourceRootPath: '/workspace',
      }),
    ]);
    expect(readingPositionsFromPersistedWorkspaceUiState(persisted, ['file-pages/demo.html'])).toEqual({
      'file-pages/demo.html': {
        preview: {
          scrollTop: 64,
          ratio: 0.2,
          anchorId: 'demo',
        },
        currentHeadingId: 'demo',
        currentHeadingText: 'Demo',
      },
    });
  });

  it('renames a tree item by explicit parent subdir and updates that tree cache', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
        notes: [{ name: 'chapter.md', isDir: false }],
      },
      deskFiles: [{ name: 'notes', isDir: true }],
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      files: [{ name: 'renamed.md', isDir: false }],
    }));

    const { deskRenameTreeItem } = await import('../../stores/desk-actions');
    const ok = await deskRenameTreeItem('notes', 'chapter.md', 'renamed.md', false);

    expect(ok).toBe(true);
    expect(mockHanaFetch).toHaveBeenCalledWith('/api/desk/files', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        action: 'rename',
        dir: '/workspace',
        subdir: 'notes',
        oldName: 'chapter.md',
        newName: 'renamed.md',
      }),
    }));
    expect(useStore.getState().deskTreeFilesByPath.notes).toEqual([{ name: 'renamed.md', isDir: false }]);
  });

  it('creates a file by explicit parent subdir and updates that tree cache', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        notes: [],
      },
      deskFiles: [{ name: 'notes', isDir: true }],
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      files: [{ name: 'idea.md', isDir: false }],
    }));

    const { deskCreateFileInSubdir } = await import('../../stores/desk-actions');
    const ok = await deskCreateFileInSubdir('notes', 'idea.md', '');

    expect(ok).toBe(true);
    expect(mockHanaFetch).toHaveBeenCalledWith('/api/desk/files', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        dir: '/workspace',
        subdir: 'notes',
        name: 'idea.md',
        content: '',
      }),
    }));
    expect(useStore.getState().deskTreeFilesByPath.notes).toEqual([{ name: 'idea.md', isDir: false }]);
    expect(useStore.getState().deskFiles).toEqual([{ name: 'notes', isDir: true }]);
  });

  it('creates a folder by explicit parent subdir without replacing the root desk files', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskCurrentPath: 'notes',
      deskTreeFilesByPath: {
        notes: [],
      },
      deskFiles: [],
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      files: [{ name: 'drafts', isDir: true }],
    }));

    const { deskMkdirInSubdir } = await import('../../stores/desk-actions');
    const ok = await deskMkdirInSubdir('notes', 'drafts');

    expect(ok).toBe(true);
    expect(mockHanaFetch).toHaveBeenCalledWith('/api/desk/files', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        action: 'mkdir',
        dir: '/workspace',
        subdir: 'notes',
        name: 'drafts',
      }),
    }));
    expect(useStore.getState().deskTreeFilesByPath.notes).toEqual([{ name: 'drafts', isDir: true }]);
    expect(useStore.getState().deskFiles).toEqual([]);
  });

  it('renames expanded folder cache keys when a tree folder is renamed', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
        notes: [{ name: 'chapter.md', isDir: false }],
        'notes/deep': [{ name: 'leaf.md', isDir: false }],
      },
      deskExpandedPaths: ['notes', 'notes/deep'],
      deskSelectedPath: 'notes/deep/leaf.md',
      deskFiles: [{ name: 'notes', isDir: true }],
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      files: [{ name: 'renamed', isDir: true }],
    }));

    const { deskRenameTreeItem } = await import('../../stores/desk-actions');
    const ok = await deskRenameTreeItem('', 'notes', 'renamed', true);

    expect(ok).toBe(true);
    expect(useStore.getState().deskTreeFilesByPath['renamed/deep']).toEqual([{ name: 'leaf.md', isDir: false }]);
    expect(useStore.getState().deskTreeFilesByPath.notes).toBeUndefined();
    expect(useStore.getState().deskExpandedPaths).toEqual(['renamed', 'renamed/deep']);
    expect(useStore.getState().deskSelectedPath).toBe('renamed/deep/leaf.md');
  });

  it('trashes tree items through the platform trash API and refreshes affected parents', async () => {
    const trashItem = vi.fn(async () => true);
    (globalThis as any).window.platform = { trashItem };
    useStore.setState({
      deskBasePath: '/workspace',
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
        notes: [{ name: 'chapter.md', isDir: false }],
      },
      deskExpandedPaths: ['notes'],
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      files: [],
      basePath: '/workspace',
    }));

    const { deskTrashTreeItems } = await import('../../stores/desk-actions');
    const ok = await deskTrashTreeItems([
      { sourceSubdir: 'notes', name: 'chapter.md', isDirectory: false },
    ]);

    expect(ok).toBe(true);
    expect(trashItem).toHaveBeenCalledWith('/workspace/notes/chapter.md');
    expect(mockHanaFetch).toHaveBeenCalledWith('/api/desk/files?dir=%2Fworkspace&subdir=notes');
    expect(useStore.getState().deskTreeFilesByPath.notes).toEqual([]);
  });

  it('keeps right Jian drawer state keyed by workspace root and collapses unseen roots', async () => {
    useStore.setState({
      deskBasePath: '/workspace-a',
      jianDrawerOpen: true,
      workspaceDeskStateByRoot: {},
    } as never);

    const { activateWorkspaceDesk } = await import('../../stores/desk-actions');

    await activateWorkspaceDesk('/workspace-b', { reload: false });

    expect(useStore.getState().jianDrawerOpen).toBe(false);
    expect(useStore.getState().workspaceDeskStateByRoot['/workspace-a'].jianDrawerOpen).toBe(true);

    useStore.setState({ jianDrawerOpen: true } as never);
    await activateWorkspaceDesk('/workspace-a', { reload: false });

    expect(useStore.getState().jianDrawerOpen).toBe(true);
    expect(useStore.getState().workspaceDeskStateByRoot['/workspace-b'].jianDrawerOpen).toBe(true);
  });

  it('uses the mobile surface bucket for persisted workspace state in the PWA shell', async () => {
    (globalThis as any).document = {
      documentElement: {
        getAttribute: (name: string) => (name === 'data-platform' ? 'web' : null),
      },
    };
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      state: {
        deskExpandedPaths: ['mobile-only'],
        deskSelectedPath: 'mobile-only/a.md',
      },
    }));

    const { activateWorkspaceDesk } = await import('../../stores/desk-actions');
    await activateWorkspaceDesk('/workspace', { reload: false });

    expect(mockHanaFetch).toHaveBeenCalledWith('/api/preferences/workspace-ui-state?workspace=%2Fworkspace&surface=pwa');
    expect(useStore.getState().deskExpandedPaths).toEqual(['mobile-only']);
    expect(useStore.getState().deskSelectedPath).toBe('mobile-only/a.md');
  });

  it('loads tree children by explicit subdir without changing the visible current directory', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskCurrentPath: 'drafts',
      deskFiles: [{ name: 'draft.md', isDir: false }],
      deskTreeFilesByPath: {},
      deskExpandedPaths: [],
      deskSelectedPath: '',
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      files: [{ name: 'chapter.md', isDir: false }],
      basePath: '/workspace',
    }));

    const { loadDeskTreeFiles } = await import('../../stores/desk-actions');
    await loadDeskTreeFiles('notes');

    expect(mockHanaFetch).toHaveBeenCalledWith('/api/desk/files?dir=%2Fworkspace&subdir=notes');
    expect(useStore.getState().deskCurrentPath).toBe('drafts');
    expect(useStore.getState().deskFiles).toEqual([{ name: 'draft.md', isDir: false }]);
    expect(useStore.getState().deskTreeFilesByPath).toEqual({
      notes: [{ name: 'chapter.md', isDir: false }],
    });
  });

  it('safe-deletes tree items through the mobile workbench route in the PWA shell', async () => {
    (globalThis as any).document = {
      documentElement: {
        getAttribute: (name: string) => (name === 'data-platform' ? 'web' : null),
      },
    };
    useStore.setState({
      deskBasePath: '/workspace',
      deskTreeFilesByPath: {
        notes: [{ name: 'chapter.md', isDir: false }],
      },
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      files: [],
    }));

    const { deskTrashTreeItems } = await import('../../stores/desk-actions');
    const ok = await deskTrashTreeItems([{ sourceSubdir: 'notes', name: 'chapter.md', isDirectory: false }]);

    expect(ok).toBe(true);
    expect(mockHanaFetch).toHaveBeenCalledWith('/api/workbench/actions', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'safeDelete',
        mountId: 'default',
        subdir: 'notes',
        name: 'chapter.md',
      }),
    }));
    expect(useStore.getState().deskTreeFilesByPath.notes).toEqual([]);
  });

  it('safe-deletes default workspace tree items through ResourceIO for remote desktop clients', async () => {
    const trashItem = vi.fn(async () => true);
    window.platform = { trashItem } as unknown as typeof window.platform;
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
      deskBasePath: '/server/workspace',
      deskTreeFilesByPath: {
        notes: [{ name: 'chapter.md', isDir: false }],
      },
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      files: [],
    }));

    const { deskTrashTreeItems } = await import('../../stores/desk-actions');
    const ok = await deskTrashTreeItems([{ sourceSubdir: 'notes', name: 'chapter.md', isDirectory: false }]);

    expect(ok).toBe(true);
    expect(trashItem).not.toHaveBeenCalled();
    expect(mockHanaFetch).toHaveBeenCalledWith('/api/workbench/actions', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'safeDelete',
        mountId: 'default',
        subdir: 'notes',
        name: 'chapter.md',
      }),
    }));
    expect(useStore.getState().deskTreeFilesByPath.notes).toEqual([]);
  });

  it('safe-deletes mounted workspace tree items with the active mountId', async () => {
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskTreeFilesByPath: {
        notes: [{ name: 'chapter.md', isDir: false }],
      },
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      files: [],
    }));

    const { deskTrashTreeItems } = await import('../../stores/desk-actions');
    const ok = await deskTrashTreeItems([{ sourceSubdir: 'notes', name: 'chapter.md', isDirectory: false }]);

    expect(ok).toBe(true);
    expect(mockHanaFetch).toHaveBeenCalledWith('/api/workbench/actions', expect.objectContaining({
      body: JSON.stringify({
        action: 'safeDelete',
        mountId: 'mount_docs',
        subdir: 'notes',
        name: 'chapter.md',
      }),
    }));
  });

  it('uploads browser File objects through the workbench upload route', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskTreeFilesByPath: {
        notes: [],
      },
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      files: [{ name: 'note.md', isDir: false }],
    }));
    const file = new File(['hello'], 'note.md', { type: 'text/markdown' });

    const { deskUploadBrowserFilesToSubdir } = await import('../../stores/desk-actions');
    const ok = await deskUploadBrowserFilesToSubdir([file], 'notes');

    expect(ok).toBe(true);
    const call = mockHanaFetch.mock.calls[0];
    expect(call[0]).toBe('/api/workbench/upload');
    expect(call[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(call[1].body)).toEqual({
      mountId: 'default',
      subdir: 'notes',
      files: [{
        name: 'note.md',
        type: 'text/markdown',
        contentBase64: 'aGVsbG8=',
      }],
    });
    expect(useStore.getState().deskTreeFilesByPath.notes).toEqual([{ name: 'note.md', isDir: false }]);
  });

  it('uploads browser File objects to the active mounted workspace', async () => {
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskTreeFilesByPath: {
        notes: [],
      },
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      files: [{ name: 'note.md', isDir: false }],
    }));
    const file = new File(['hello'], 'note.md', { type: 'text/markdown' });

    const { deskUploadBrowserFilesToSubdir } = await import('../../stores/desk-actions');
    const ok = await deskUploadBrowserFilesToSubdir([file], 'notes');

    expect(ok).toBe(true);
    const call = mockHanaFetch.mock.calls[0];
    expect(call[0]).toBe('/api/workbench/upload');
    expect(JSON.parse(call[1].body)).toMatchObject({
      mountId: 'mount_docs',
      subdir: 'notes',
    });
  });

  it('moves tree items by explicit source and destination subdirs without relying on the current folder', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskCurrentPath: 'drafts',
      deskFiles: [{ name: 'draft.md', isDir: false }],
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
        notes: [{ name: 'chapter.md', isDir: false }],
        archive: [],
      },
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      filesByPath: {
        notes: [],
        archive: [{ name: 'chapter.md', isDir: false }],
      },
      files: [{ name: 'draft.md', isDir: false }],
    }));

    const { deskMoveTreeFiles } = await import('../../stores/desk-actions');
    await deskMoveTreeFiles([{ sourceSubdir: 'notes', name: 'chapter.md', isDirectory: false }], 'archive');

    expect(mockHanaFetch).toHaveBeenCalledWith('/api/desk/files', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'movePaths',
        dir: '/workspace',
        items: [{ sourceSubdir: 'notes', name: 'chapter.md', isDirectory: false }],
        destSubdir: 'archive',
        currentSubdir: '',
      }),
    }));
    expect(useStore.getState().deskCurrentPath).toBe('drafts');
    expect(useStore.getState().deskTreeFilesByPath.notes).toEqual([]);
    expect(useStore.getState().deskTreeFilesByPath.archive).toEqual([{ name: 'chapter.md', isDir: false }]);
    expect(useStore.getState().deskFiles).toEqual([{ name: 'draft.md', isDir: false }]);
  });

  it('searches workspace files against the active desk root', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      results: [
        { name: 'DeskTree.tsx', relativePath: 'src/DeskTree.tsx', parentSubdir: 'src', isDir: false },
      ],
    }));

    const { searchDeskFiles } = await import('../../stores/desk-actions');
    const results = await searchDeskFiles('Desk');

    expect(mockHanaFetch).toHaveBeenCalledWith('/api/desk/search-files?dir=%2Fworkspace&q=Desk');
    expect(results).toEqual([
      { name: 'DeskTree.tsx', relativePath: 'src/DeskTree.tsx', parentSubdir: 'src', isDir: false },
    ]);
  });

  it('jumps to a search result by expanding ancestors and selecting the real tree path', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskTreeFilesByPath: {},
      deskExpandedPaths: [],
      deskSelectedPath: '',
    } as never);
    mockHanaFetch
      .mockResolvedValueOnce(jsonResponse({ files: [{ name: 'components', isDir: true }], basePath: '/workspace' }))
      .mockResolvedValueOnce(jsonResponse({ files: [{ name: 'DeskTree.tsx', isDir: false }], basePath: '/workspace' }));

    const { jumpToDeskSearchResult } = await import('../../stores/desk-actions');
    await jumpToDeskSearchResult({
      name: 'DeskTree.tsx',
      relativePath: 'src/components/DeskTree.tsx',
      parentSubdir: 'src/components',
      isDir: false,
    });

    expect(mockHanaFetch).toHaveBeenNthCalledWith(1, '/api/desk/files?dir=%2Fworkspace&subdir=src');
    expect(mockHanaFetch).toHaveBeenNthCalledWith(2, '/api/desk/files?dir=%2Fworkspace&subdir=src%2Fcomponents');
    expect(useStore.getState().deskExpandedPaths).toEqual(['src', 'src/components']);
    expect(useStore.getState().deskSelectedPath).toBe('src/components/DeskTree.tsx');
  });

  it('reveals an absolute workspace directory by expanding tree paths without replacing the desk root', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskCurrentPath: 'legacy/current-dir',
      deskFiles: [{ name: 'old.md', isDir: false }],
      deskTreeFilesByPath: {
        '': [{ name: 'existing.md', isDir: false }],
      },
      deskExpandedPaths: [],
      deskSelectedPath: '',
      rightWorkspaceTab: 'session-files',
    } as never);
    mockHanaFetch
      .mockResolvedValueOnce(jsonResponse({
        files: [{ name: 'OH-Works', isDir: true }],
        basePath: '/workspace',
      }))
      .mockResolvedValueOnce(jsonResponse({
        files: [{ name: 'Screenshots', isDir: true }],
        basePath: '/workspace',
      }))
      .mockResolvedValueOnce(jsonResponse({
        files: [{ name: 'hana.png', isDir: false }],
        basePath: '/workspace',
      }));

    const { revealDeskDirectory } = await import('../../stores/desk-actions');
    const ok = await revealDeskDirectory('/workspace/OH-Works/Screenshots');

    expect(ok).toBe(true);
    expect(mockHanaFetch).toHaveBeenNthCalledWith(1, '/api/desk/files?dir=%2Fworkspace');
    expect(mockHanaFetch).toHaveBeenNthCalledWith(2, '/api/desk/files?dir=%2Fworkspace&subdir=OH-Works');
    expect(mockHanaFetch).toHaveBeenNthCalledWith(3, '/api/desk/files?dir=%2Fworkspace&subdir=OH-Works%2FScreenshots');
    expect(useStore.getState().deskBasePath).toBe('/workspace');
    expect(useStore.getState().deskCurrentPath).toBe('');
    expect(useStore.getState().deskFiles).toEqual([{ name: 'OH-Works', isDir: true }]);
    expect(useStore.getState().deskTreeFilesByPath).toMatchObject({
      '': [{ name: 'OH-Works', isDir: true }],
      'OH-Works': [{ name: 'Screenshots', isDir: true }],
      'OH-Works/Screenshots': [{ name: 'hana.png', isDir: false }],
    });
    expect(useStore.getState().deskExpandedPaths).toEqual(['OH-Works', 'OH-Works/Screenshots']);
    expect(useStore.getState().deskSelectedPath).toBe('OH-Works/Screenshots');
    expect(useStore.getState().rightWorkspaceTab).toBe('workspace');
  });

  it('does not reveal a directory outside the active desk root', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskCurrentPath: '',
      deskExpandedPaths: [],
      deskSelectedPath: '',
    } as never);

    const { revealDeskDirectory } = await import('../../stores/desk-actions');
    const ok = await revealDeskDirectory('/other/OH-Works');

    expect(ok).toBe(false);
    expect(mockHanaFetch).not.toHaveBeenCalled();
    expect(useStore.getState().deskExpandedPaths).toEqual([]);
    expect(useStore.getState().deskSelectedPath).toBe('');
  });
});
