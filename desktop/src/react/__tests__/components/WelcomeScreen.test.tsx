/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(async (_path: string, _opts?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  loadModels: vi.fn(),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (path: string, opts?: RequestInit) => mocks.hanaFetch(path, opts),
}));

vi.mock('../../utils/ui-helpers', () => ({
  loadModels: () => mocks.loadModels(),
}));

const translations: Record<string, string | string[] | Record<string, { avatar: string }>> = {
  'input.workspace': '工作台：',
  'input.project': '项目：',
  'input.currentWorkspace': '本次工作台',
  'input.cwdProject': '工作台项目：{name}',
  'input.customProjects': '自定义项目',
  'input.selectProject': '选择项目',
  'input.noCustomProjects': '暂无自定义项目',
  'input.selectOtherFolder': '选择其他文件夹',
  'input.removeRecentWorkspace': '从列表移除',
  'input.removeStudioWorkspace': '移除工作台',
  'input.extraFolders': '额外文件夹',
  'input.addExternalFolder': '添加工作台以外的文件夹',
  'welcome.messages': ['想到什么就说什么吧~'],
  'yuan.welcome.hanako': ['想到什么就说什么吧~'],
  'welcome.memoryOn': '记忆',
  'welcome.memoryOff': '此次聊天不参考记忆',
  'welcome.memoryDisabled': '记忆已关闭',
  'yuan.types': { hanako: { avatar: 'Hanako.png' } },
};

describe('WelcomeScreen workspace picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const t = vi.fn((key: string, vars?: Record<string, string | number>) => {
      const template = translations[key] ?? key;
      return typeof template === 'string'
        ? template.replace(/\{(\w+)\}/g, (_match, name) => String(vars?.[name] ?? `{${name}}`))
        : template;
    });
    vi.stubGlobal('t', t);
    window.t = t as typeof window.t;
    window.platform = { selectFolder: vi.fn() } as unknown as typeof window.platform;
    useStore.setState({
      welcomeVisible: true,
      agents: [],
      agentName: 'Hanako',
      agentAvatarUrl: null,
      agentYuan: 'hanako',
      currentAgentId: 'hana',
      selectedAgentId: null,
      memoryEnabled: true,
      selectedFolder: '/workspace/Desktop',
      selectedWorkspaceMountId: null,
      selectedWorkspaceLabel: null,
      deskWorkspaceMountId: null,
      deskWorkspaceLabel: null,
      studioWorkspaces: [],
      homeFolder: '/workspace/Desktop/project-hana',
      cwdHistory: ['/workspace/Desktop/project-hana'],
      workspaceFolders: ['/workspace/Reference'],
      serverPort: 62950,
      serverToken: 'test-token',
      pendingProjectId: null,
      sessionProjectCatalog: {
        folders: [],
        projects: [
          { id: 'project-writing', name: '写作项目', folderId: null, order: 0 },
        ],
      },
      sessionProjectCatalogLoaded: true,
      locale: 'zh',
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('groups primary workspace selection before extra folders', async () => {
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    render(<WelcomeScreen />);
    fireEvent.click(screen.getByRole('button', { name: /工作台：Desktop/ }));

    const currentLabel = screen.getByText('本次工作台');
    const selectOther = screen.getByText('选择其他文件夹');
    const extraLabel = screen.getByText('额外文件夹');
    const addExternal = screen.getByText('添加工作台以外的文件夹');

    expect(currentLabel.compareDocumentPosition(selectOther) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(selectOther.compareDocumentPosition(extraLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(extraLabel.compareDocumentPosition(addExternal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('turns folder groups into scrollable lists after five items', async () => {
    useStore.setState({
      cwdHistory: [
        '/workspace/One',
        '/workspace/Two',
        '/workspace/Three',
        '/workspace/Four',
        '/workspace/Five',
        '/workspace/Six',
      ],
      workspaceFolders: [
        '/workspace/ExtraOne',
        '/workspace/ExtraTwo',
        '/workspace/ExtraThree',
        '/workspace/ExtraFour',
        '/workspace/ExtraFive',
        '/workspace/ExtraSix',
      ],
    } as never);
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    const { container } = render(<WelcomeScreen />);
    fireEvent.click(screen.getByRole('button', { name: /工作台：Desktop/ }));

    expect(container.querySelector('[data-folder-history-list="primary"]')).toHaveAttribute('data-scrollable', 'true');
    expect(container.querySelector('[data-folder-history-list="extra"]')).toHaveAttribute('data-scrollable', 'true');
  });

  it('selects a Studio workspace by mountId instead of a local path', async () => {
    mocks.hanaFetch.mockImplementation(async (path: string) => {
      if (path === '/api/studio/workspaces') {
        return new Response(JSON.stringify({
          workspaces: [{ workspaceId: 'mount_docs', mountId: 'mount_docs', label: 'Docs', capabilities: ['list', 'read', 'write'] }],
        }), { status: 200 });
      }
      if (path.startsWith('/api/preferences/workspace-ui-state')) {
        return new Response(JSON.stringify({ state: null }), { status: 200 });
      }
      if (path === '/api/workbench/files?mountId=mount_docs') {
        return new Response(JSON.stringify({
          mountId: 'mount_docs',
          mount: { label: 'Docs' },
          files: [{ name: 'remote.md', isDir: false }],
        }), { status: 200 });
      }
      if (path.startsWith('/api/workbench/content')) {
        return new Response('', { status: 404 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    render(<WelcomeScreen />);
    await waitFor(() => expect(useStore.getState().studioWorkspaces).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /工作台：Desktop/ }));
    fireEvent.click(screen.getByText('Docs'));

    await waitFor(() => {
      expect(useStore.getState().selectedWorkspaceMountId).toBe('mount_docs');
      expect(useStore.getState().deskBasePath).toBe('studio:mount_docs');
    });
    expect(mocks.hanaFetch.mock.calls.some(([path]) => path === '/api/workbench/files?mountId=mount_docs')).toBe(true);
  });

  it('removes a recent workspace from the picker without switching workspace', async () => {
    mocks.hanaFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      cwd_history: [],
    }), { status: 200 }));
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    render(<WelcomeScreen />);
    fireEvent.click(screen.getByRole('button', { name: /工作台：Desktop/ }));
    fireEvent.click(screen.getByRole('button', { name: '从列表移除' }));

    expect(useStore.getState().selectedFolder).toBe('/workspace/Desktop');
    expect(useStore.getState().cwdHistory).toEqual([]);
    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/config/workspaces/recent?agentId=hana', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ path: '/workspace/Desktop/project-hana' }),
    }));
  });

  it('shows a remove button for user-added Studio workspaces', async () => {
    useStore.setState({
      selectedWorkspaceMountId: 'mount_docs',
      selectedWorkspaceLabel: 'Docs',
      selectedFolder: null,
      studioWorkspaces: [
        { workspaceId: 'default', mountId: 'default', label: 'Default', isDefault: true },
        { workspaceId: 'mount_docs', mountId: 'mount_docs', label: 'Docs', isDefault: false },
      ],
    } as never);
    mocks.hanaFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/api/studio/workspaces/mount_docs' && opts?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true, mountId: 'mount_docs' }), { status: 200 });
      }
      if (path === '/api/studio/workspaces') {
        return new Response(JSON.stringify({
          workspaces: [{ workspaceId: 'default', mountId: 'default', label: 'Default', isDefault: true }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    render(<WelcomeScreen />);
    fireEvent.click(screen.getByRole('button', { name: /工作台：Docs/ }));

    expect(screen.queryByTitle('移除工作台')).toBeInTheDocument();
    expect(screen.queryAllByTitle('移除工作台')).toHaveLength(1);
    fireEvent.click(screen.getByTitle('移除工作台'));

    await waitFor(() => {
      expect(useStore.getState().studioWorkspaces.map(workspace => workspace.mountId)).toEqual(['default']);
    });
    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/studio/workspaces/mount_docs', expect.objectContaining({
      method: 'DELETE',
    }));
  });

  it('does not show a project picker while creating a new session', async () => {
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    render(<WelcomeScreen />);

    expect(screen.queryByRole('button', { name: /项目：/ })).not.toBeInTheDocument();
    expect(screen.queryByText('自定义项目')).not.toBeInTheDocument();
    expect(useStore.getState().pendingProjectId).toBeNull();
  });

  it('disables the memory toggle when the selected agent has memory disabled in settings', async () => {
    useStore.setState({
      agents: [
        { id: 'hana', name: 'Hanako', yuan: 'hanako', isPrimary: true, memoryMasterEnabled: false },
      ],
      currentAgentId: 'hana',
      memoryEnabled: true,
    } as never);
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    render(<WelcomeScreen />);
    const button = screen.getByRole('button', { name: '记忆已关闭' });
    fireEvent.click(button);

    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(useStore.getState().memoryEnabled).toBe(true);
  });

  it('selects the target agent workbench when choosing an agent on the welcome screen', async () => {
    useStore.setState({
      agents: [
        {
          id: 'hana',
          name: 'Hanako',
          yuan: 'hanako',
          isPrimary: true,
          homeFolder: '/workspace/Hana',
          chatModel: { id: 'deepseek-chat', provider: 'deepseek' },
        },
        {
          id: 'mio',
          name: 'Mio',
          yuan: 'hanako',
          isPrimary: false,
          homeFolder: '/workspace/Mio',
          chatModel: { id: 'gpt-5.2', provider: 'openai' },
        },
      ],
      currentAgentId: 'hana',
      selectedAgentId: null,
      selectedFolder: '/workspace/Hana',
      homeFolder: '/workspace/Hana',
      workspaceFolders: ['/workspace/Reference'],
    } as never);
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    render(<WelcomeScreen />);
    fireEvent.click(screen.getByRole('button', { name: /Mio/ }));

    expect(useStore.getState().selectedAgentId).toBe('mio');
    expect(useStore.getState().selectedFolder).toBe('/workspace/Mio');
    expect(useStore.getState().workspaceFolders).toEqual([]);
    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/models/set', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ modelId: 'gpt-5.2', provider: 'openai' }),
    }));
  });

  it('uses the target agent effective default workspace when no explicit home folder is configured', async () => {
    useStore.setState({
      agents: [
        {
          id: 'hana',
          name: 'Hanako',
          yuan: 'hanako',
          isPrimary: true,
          homeFolder: '/workspace/Hana',
          effectiveHomeFolder: '/workspace/Hana',
        },
        {
          id: 'mio',
          name: 'Mio',
          yuan: 'hanako',
          isPrimary: false,
          homeFolder: null,
          effectiveHomeFolder: '/home/test/Desktop/OH-WorkSpace',
        },
      ],
      currentAgentId: 'hana',
      selectedAgentId: null,
      selectedFolder: '/workspace/Hana',
      homeFolder: '/workspace/Hana',
    } as never);
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    render(<WelcomeScreen />);
    fireEvent.click(screen.getByRole('button', { name: /Mio/ }));

    expect(useStore.getState().selectedAgentId).toBe('mio');
    expect(useStore.getState().selectedFolder).toBe('/home/test/Desktop/OH-WorkSpace');
  });

  it('does not reload the visible workspace when two agents resolve to the same folder', async () => {
    useStore.setState({
      agents: [
        {
          id: 'hana',
          name: 'Hanako',
          yuan: 'hanako',
          isPrimary: true,
          homeFolder: '/home/test/Desktop/OH-WorkSpace',
          effectiveHomeFolder: '/home/test/Desktop/OH-WorkSpace',
        },
        {
          id: 'mio',
          name: 'Mio',
          yuan: 'hanako',
          isPrimary: false,
          homeFolder: '/home/test/Desktop/OH-WorkSpace',
          effectiveHomeFolder: '/home/test/Desktop/OH-WorkSpace',
        },
      ],
      currentAgentId: 'hana',
      selectedAgentId: null,
      selectedFolder: '/home/test/Desktop/OH-WorkSpace',
      deskBasePath: '/home/test/Desktop/OH-WorkSpace',
      homeFolder: '/home/test/Desktop/OH-WorkSpace',
    } as never);
    const deskActions = await import('../../stores/desk-actions');
    const activateSpy = vi.spyOn(deskActions, 'activateWorkspaceDesk');
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    render(<WelcomeScreen />);
    fireEvent.click(screen.getByRole('button', { name: /Mio/ }));

    expect(useStore.getState().selectedAgentId).toBe('mio');
    expect(useStore.getState().selectedFolder).toBe('/home/test/Desktop/OH-WorkSpace');
    expect(activateSpy).not.toHaveBeenCalled();
  });
});
