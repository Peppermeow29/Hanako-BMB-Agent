// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { useStore } from '../../stores';
import type { ChatListItem } from '../../stores/chat-types';
import { RightWorkspacePanel } from '../../components/right-workspace/RightWorkspacePanel';
import { openFilePreview } from '../../utils/file-preview';
import { openMediaViewerForRef } from '../../utils/open-media-viewer';
import { takeMarkdownFileScreenshot } from '../../utils/screenshot';
import { hanaFetch } from '../../hooks/use-hana-fetch';

const mockOpenFilePreview = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../utils/file-preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/file-preview')>();
  return {
    ...actual,
    openFilePreview: mockOpenFilePreview,
  };
});

vi.mock('../../utils/open-media-viewer', () => ({
  openMediaViewerForRef: vi.fn(),
}));

vi.mock('../../utils/screenshot', () => ({
  takeMarkdownFileScreenshot: vi.fn(async () => undefined),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

// 整列卡片栈的兄弟卡（Activity / Session 状态）各有独立测试；这里聚焦 desk 卡 tab
// 逻辑，stub 掉它们避免「工作目录」等文案在多张卡里重复导致 getByText 命中多个。
vi.mock('../../components/right-workspace/AgentActivityCard', () => ({
  AgentActivityCard: () => null,
}));
vi.mock('../../components/right-workspace/SessionStatusCard', () => ({
  SessionStatusCard: () => null,
}));

const tMap: Record<string, string> = {
  'rightWorkspace.tabs.sessionFiles': '对话文件',
  'rightWorkspace.tabs.workspace': '工作台',
  'rightWorkspace.sessionFiles.empty': '本对话还没有产生或上传文件',
  'rightWorkspace.sessionFiles.title': '对话文件',
  'rightWorkspace.sessionFiles.status.expired': '已过期',
  'rightWorkspace.sessionFiles.status.available': '可用',
  'rightWorkspace.sessionFiles.actions.preview': '预览',
  'rightWorkspace.sessionFiles.actions.open': '打开',
  'rightWorkspace.sessionFiles.actions.reveal': '定位',
  'rightWorkspace.sessionFiles.actions.copyPath': '复制路径',
  'rightWorkspace.sessionFiles.actions.copySelectedPaths': '复制 2 个路径',
  'rightWorkspace.sessionFiles.actions.downloadToDevice': '下载到本机',
  'common.screenshotShare': '截图分享',
  'rightWorkspace.sessionFiles.actions.sendToBridge': '发送到...',
  'rightWorkspace.sessionFiles.actions.sendToBridgeLoading': '正在加载 Bridge 会话...',
  'rightWorkspace.sessionFiles.actions.sendToBridgeEmpty': '没有可发送的 Bridge 会话',
  'rightWorkspace.sessionFiles.actions.sendToBridgeLoadFailed': 'Bridge 会话加载失败',
  'rightWorkspace.sessionFiles.bridgeLoadFailed': '加载 Bridge 会话失败：boom',
  'rightWorkspace.sessionFiles.sendSuccess': '已发送到 Hana：飞书 · 小群',
  'rightWorkspace.sessionFiles.sendFailed': '发送到 Hana：飞书 · 小群 失败：boom',
  'rightWorkspace.sessionFiles.list': '对话文件列表',
  'rightWorkspace.sessionFiles.sort.label': '对话文件排序',
  'rightWorkspace.sessionFiles.sort.timeDesc': '时间↓',
  'rightWorkspace.sessionFiles.sort.nameAsc': '名称↑',
  'rightWorkspace.sessionFiles.sort.nameDesc': '名称↓',
  'rightWorkspace.sessionFiles.sort.typeAsc': '类型↑',
  'rightWorkspace.jian.collapse': '收起笺',
  'rightWorkspace.jian.expand': '展开笺',
  'desk.workspaceTitle': '工作台',
  'desk.jianLabel': '笺',
  'desk.jianPlaceholder': '写点什么...',
  'desk.openInFinder': '打开文件夹',
  'desk.sort.nameAscShort': '名称↑',
  'desk.sort.label': '排序',
  'preview.toggle': '预览面板',
  'common.noFiles': '没有文件',
  'settings.bridge.feishu': '飞书',
};

function resetStore(items: ChatListItem[] = []) {
  useStore.setState({
    currentSessionPath: '/sessions/main.jsonl',
    chatSessions: {
      '/sessions/main.jsonl': {
        items,
        hasMore: false,
        loadingMore: false,
      },
    },
    sessionRegistryFilesByPath: {},
    activeServerConnection: null,
    activeServerConnectionId: null,
    serverConnections: {},
    serverPort: 62950,
    serverToken: 'local-token',
    rightWorkspaceTab: 'workspace',
    jianDrawerOpen: true,
    deskBasePath: '/tmp/hana-work',
    deskCurrentPath: '',
    deskFiles: [],
    deskJianContent: '',
    agents: [{ id: 'hana', name: 'Hana', yuan: 'hanako', hasAvatar: false }],
    currentAgentId: 'hana',
    selectedFolder: null,
    homeFolder: null,
    jianView: 'desk',
  } as never);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RightWorkspacePanel', () => {
  let localStorageData: Record<string, string>;

  beforeEach(() => {
    localStorageData = {};
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => localStorageData[key] ?? null,
        setItem: (key: string, value: string) => {
          localStorageData[key] = value;
        },
        removeItem: (key: string) => {
          delete localStorageData[key];
        },
        clear: () => {
          localStorageData = {};
        },
      },
    });
    window.t = ((key: string) => tMap[key] || key) as typeof window.t;
    vi.mocked(openFilePreview).mockClear();
    vi.mocked(openMediaViewerForRef).mockClear();
    vi.mocked(takeMarkdownFileScreenshot).mockClear();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(hanaFetch).mockImplementation(async () => jsonResponse({ sessions: [] }));
    document.documentElement.removeAttribute('data-platform');
    window.platform = {
      openFolder: () => undefined,
      openFile: vi.fn(),
      showInFinder: vi.fn(),
      watchFile: async () => true,
      unwatchFile: async () => true,
      onFileChanged: () => undefined,
      startDrag: vi.fn(),
    } as unknown as typeof window.platform;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    resetStore();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders extensible right workspace tabs and keeps workspace as the compatibility default', () => {
    const { container } = render(<RightWorkspacePanel />);

    const tabList = screen.getByRole('tablist', { name: 'rightWorkspace.tabs.label' });
    expect(tabList.closest('.universal-card')).toBe(container.querySelector('.universal-card'));
    expect(within(tabList).getByRole('tab', { name: '对话文件' })).toBeInTheDocument();
    expect(within(tabList).getByRole('tab', { name: '工作台' })).toHaveAttribute('aria-selected', 'true');
    expect(container.querySelector('[data-right-workspace-tab-slider]')).toBeInTheDocument();
    expect((tabList as HTMLElement).style.getPropertyValue('--right-workspace-active-tab-index')).toBe('1');
    expect(screen.getByText('hana-work')).toBeInTheDocument();
    expect(screen.queryByText(/工作台 ·/)).not.toBeInTheDocument();
  });

  it('hides desktop-only open-folder controls in the PWA workspace', () => {
    document.documentElement.setAttribute('data-platform', 'web');

    render(<RightWorkspacePanel />);

    expect(screen.queryByRole('button', { name: '打开文件夹' })).not.toBeInTheDocument();
  });

  it('moves the tab slider when switching between session files and workspace', () => {
    render(<RightWorkspacePanel />);

    const tabList = screen.getByRole('tablist', { name: 'rightWorkspace.tabs.label' });
    expect((tabList as HTMLElement).style.getPropertyValue('--right-workspace-active-tab-index')).toBe('1');

    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    expect((tabList as HTMLElement).style.getPropertyValue('--right-workspace-active-tab-index')).toBe('0');
    expect(screen.getByRole('tab', { name: '对话文件' })).toHaveAttribute('aria-selected', 'true');
  });

  it('lets file names use the row width until hover or focus reveals file actions', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '../../components/right-workspace/RightWorkspacePanel.module.css'),
      'utf-8',
    );

    expect(css).toMatch(/\.fileActions\s*\{[\s\S]*position:\s*absolute/);
    expect(css).toMatch(/\.fileActions\s*\{[\s\S]*opacity:\s*0/);
    expect(css).toMatch(/\.fileRow:hover \.fileMain,\s*\.fileRow:focus-within \.fileMain\s*\{[\s\S]*padding-right:\s*122px/);
    expect(css).toMatch(/\.fileRow:hover \.fileActions,\s*\.fileRow:focus-within \.fileActions\s*\{[\s\S]*opacity:\s*1/);
    expect(css).not.toMatch(/\.fileRowSelected \.fileActions\s*\{[\s\S]*opacity:\s*1/);
  });

  it('keeps right workspace panel spacing on the shared panel gap contract', () => {
    const panelCss = fs.readFileSync(
      path.join(__dirname, '../../components/right-workspace/RightWorkspacePanel.module.css'),
      'utf-8',
    );
    const globalCss = fs.readFileSync(
      path.join(__dirname, '../../../styles.css'),
      'utf-8',
    );
    const shellBlock = panelCss.match(/\.shell\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const jianInnerBlock = globalCss.match(/\.jian-sidebar-inner\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const floatRightBlock = globalCss.match(/\.float-sidebar\[data-side="right"\]\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const rootBlock = globalCss.match(/:root\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const universalCardBlock = globalCss.match(/\.universal-card,\s*\.jian-card\s*\{[\s\S]*?\}/)?.[0] ?? '';

    expect(rootBlock).toMatch(/--panel-edge-gap:\s*var\(--space-8\);/);
    expect(rootBlock).toMatch(/--panel-card-bg:\s*var\(--bg-card,\s*var\(--bg\)\);/);
    expect(rootBlock).toMatch(/--panel-card-radius:\s*var\(--radius-lg\);/);
    expect(rootBlock).toMatch(/--panel-card-border:\s*1px solid rgba\(0,\s*0,\s*0,\s*0\.08\);/);
    expect(rootBlock).toMatch(/--panel-card-shadow:\s*none;/);
    expect(shellBlock).toMatch(/padding:\s*var\(--panel-edge-gap\) 0;/);
    expect(shellBlock).toMatch(/gap:\s*var\(--panel-edge-gap\);/);
    expect(panelCss).toMatch(/--right-workspace-jian-bottom:\s*var\(--panel-edge-gap\);/);
    expect(jianInnerBlock).toMatch(/padding:\s*0 var\(--panel-edge-gap\) 0 0;/);
    expect(floatRightBlock).toMatch(/padding:\s*0 var\(--panel-edge-gap\);/);
    expect(universalCardBlock).toMatch(/background(?:-color)?:\s*var\(--panel-card-bg\);/);
    expect(universalCardBlock).toMatch(/border-radius:\s*var\(--panel-card-radius\);/);
    expect(universalCardBlock).toMatch(/border:\s*var\(--panel-card-border\);/);
    expect(universalCardBlock).toMatch(/box-shadow:\s*var\(--panel-card-shadow\);/);
  });

  it('places the preview toggle before the open-folder icon in the workspace toolbar', () => {
    render(<RightWorkspacePanel />);

    const previewToggle = screen.getByRole('button', { name: '预览面板' });
    const openFolder = screen.getByRole('button', { name: '打开文件夹' });

    expect(previewToggle.compareDocumentPosition(openFolder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(previewToggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(previewToggle);

    expect(useStore.getState().previewOpen).toBe(true);
    expect(previewToggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('uses natural empty copy without a duplicate session files heading', () => {
    render(<RightWorkspacePanel />);

    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    expect(screen.queryByRole('heading', { name: '对话文件' })).not.toBeInTheDocument();
    expect(screen.getByText('本对话还没有产生或上传文件')).toBeInTheDocument();
  });

  it('shows current session registry files from the session file selector', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 1700000000000,
          blocks: [
            {
              type: 'file',
              fileId: 'sf_report',
              filePath: '/tmp/session-files/report.pdf',
              label: 'report.pdf',
              ext: 'pdf',
              status: 'available',
            },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);

    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    expect(screen.queryByRole('heading', { name: '对话文件' })).not.toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('session-block-file')).toBeInTheDocument();
    expect(screen.getByText('可用')).toBeInTheDocument();
  });

  it('uses file-kind icons for audio session files', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 1700000000000,
          blocks: [
            {
              type: 'file',
              fileId: 'sf_audio',
              filePath: '/tmp/session-files/recording.wav',
              label: 'recording.wav',
              ext: 'wav',
              status: 'available',
            },
          ],
        },
      },
    ]);

    const { container } = render(<RightWorkspacePanel />);

    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    expect(screen.getByText('recording.wav')).toBeInTheDocument();
    expect(container.querySelector('svg[data-file-kind="audio"]')).not.toBeNull();
  });

  it('wires session file actions to preview, open, reveal and copy path consumers', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 1700000000000,
          blocks: [
            {
              type: 'file',
              fileId: 'sf_report',
              filePath: '/tmp/session-files/report.pdf',
              label: 'report.pdf',
              ext: 'pdf',
              status: 'available',
            },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    fireEvent.click(screen.getByRole('button', { name: '预览 report.pdf' }));
    expect(openFilePreview).toHaveBeenCalledWith('/tmp/session-files/report.pdf', 'report.pdf', 'pdf', {
      origin: 'session',
      sessionPath: '/sessions/main.jsonl',
      messageId: 'a1',
      fileId: 'sf_report',
      blockIdx: 0,
    });

    fireEvent.click(screen.getByRole('button', { name: '打开 report.pdf' }));
    expect(window.platform?.openFile).toHaveBeenCalledWith('/tmp/session-files/report.pdf');

    fireEvent.click(screen.getByRole('button', { name: '定位 report.pdf' }));
    expect(window.platform?.showInFinder).toHaveBeenCalledWith('/tmp/session-files/report.pdf');

    fireEvent.click(screen.getByRole('button', { name: '复制路径 report.pdf' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/session-files/report.pdf');
  });

  it('renders a download-to-device action for resource-backed session files', () => {
    resetStore([]);
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
      sessionRegistryFilesByPath: {
        '/sessions/main.jsonl': [{
          fileId: 'sf_report',
          filePath: '/remote/cache/report.pdf',
          label: 'report.pdf',
          ext: 'pdf',
          status: 'available',
          resource: {
            schemaVersion: 1,
            resourceId: 'res_sf_report',
            name: 'studios/studio_lan/resources/res_sf_report',
            studioId: 'studio_lan',
            type: 'file',
            source: 'session_file',
            fileId: 'sf_report',
            lifecycle: { status: 'available', missingAt: null },
            storage: { provider: 'session_file', localOnly: true },
            links: {
              self: '/api/resources/res_sf_report',
              content: '/api/resources/res_sf_report/content',
            },
          },
        }],
      },
    } as never);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    const download = screen.getByRole('link', { name: '下载到本机 report.pdf' });
    expect(download).toHaveAttribute('href', 'http://hana.local:14500/api/resources/res_sf_report/content');
    expect(download).toHaveAttribute('download', 'report.pdf');
  });

  it('previews remote resource-backed session files through ResourceIO without local path controls', async () => {
    vi.mocked(hanaFetch).mockImplementation(async (url) => {
      if (String(url).startsWith('/api/resources/res_sf_report/content')) {
        return new Response('# remote report\n', { status: 200 });
      }
      return jsonResponse({ sessions: [] });
    });
    resetStore([]);
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
      sessionRegistryFilesByPath: {
        '/sessions/main.jsonl': [{
          fileId: 'sf_report',
          filePath: '/remote/cache/report.md',
          label: 'report.md',
          ext: 'md',
          status: 'available',
          resource: {
            schemaVersion: 1,
            resourceId: 'res_sf_report',
            name: 'studios/studio_lan/resources/res_sf_report',
            studioId: 'studio_lan',
            type: 'file',
            source: 'session_file',
            fileId: 'sf_report',
            lifecycle: { status: 'available', missingAt: null },
            storage: { provider: 'session_file', localOnly: true },
            links: {
              self: '/api/resources/res_sf_report',
              content: '/api/resources/res_sf_report/content',
            },
          },
        }],
      },
    } as never);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    expect(screen.getByRole('button', { name: '预览 report.md' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '下载到本机 report.md' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开 report.md' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '定位 report.md' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '复制路径 report.md' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '预览 report.md' }));

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/resources/res_sf_report/content');
    });
    expect(openFilePreview).not.toHaveBeenCalled();
    expect(useStore.getState().previewItems[0]).toMatchObject({
      title: 'report.md',
      content: '# remote report\n',
      storageKind: 'remote-content',
    });
  });

  it('uses preview and download actions without local path controls in the PWA session file panel', () => {
    document.documentElement.setAttribute('data-platform', 'web');
    resetStore([]);
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
      sessionRegistryFilesByPath: {
        '/sessions/main.jsonl': [{
          fileId: 'sf_report',
          filePath: '/remote/cache/report.pdf',
          label: 'report.pdf',
          ext: 'pdf',
          status: 'available',
          resource: {
            schemaVersion: 1,
            resourceId: 'res_sf_report',
            name: 'studios/studio_lan/resources/res_sf_report',
            studioId: 'studio_lan',
            type: 'file',
            source: 'session_file',
            fileId: 'sf_report',
            lifecycle: { status: 'available', missingAt: null },
            storage: { provider: 'session_file', localOnly: true },
            links: {
              self: '/api/resources/res_sf_report',
              content: '/api/resources/res_sf_report/content',
            },
          },
        }],
      },
    } as never);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    expect(screen.getByRole('button', { name: '预览 report.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '下载到本机 report.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开 report.pdf' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '定位 report.pdf' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '复制路径 report.pdf' })).not.toBeInTheDocument();
  });

  it('sorts session files without a manual refresh or add entry', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'older',
          role: 'assistant',
          timestamp: 3000,
          blocks: [
            { type: 'file', fileId: 'sf_zeta', filePath: '/tmp/session-files/zeta.md', label: 'zeta.md', ext: 'md', status: 'available' },
          ],
        },
      },
      {
        type: 'message',
        data: {
          id: 'newer',
          role: 'assistant',
          timestamp: 1000,
          blocks: [
            { type: 'file', fileId: 'sf_alpha', filePath: '/tmp/session-files/alpha.png', label: 'alpha.png', ext: 'png', status: 'available' },
          ],
        },
      },
      {
        type: 'message',
        data: {
          id: 'middle',
          role: 'assistant',
          timestamp: 2000,
          blocks: [
            { type: 'file', fileId: 'sf_beta', filePath: '/tmp/session-files/beta.pdf', label: 'beta.pdf', ext: 'pdf', status: 'available' },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    const names = () => screen.getAllByTestId('session-file-name').map(el => el.textContent);
    expect(names()).toEqual(['zeta.md', 'beta.pdf', 'alpha.png']);

    fireEvent.click(screen.getByRole('button', { name: '对话文件排序' }));
    fireEvent.click(screen.getByText('名称↑'));

    expect(names()).toEqual(['alpha.png', 'beta.pdf', 'zeta.md']);
    expect(screen.queryByText('打开文件夹')).not.toBeInTheDocument();
    expect(screen.queryByText('粘贴')).not.toBeInTheDocument();
  });

  it('copies selected session file paths by keyboard without accepting pasted files into the registry', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 3000,
          blocks: [
            { type: 'file', fileId: 'sf_alpha', filePath: '/tmp/session-files/alpha.png', label: 'alpha.png', ext: 'png', status: 'available' },
          ],
        },
      },
      {
        type: 'message',
        data: {
          id: 'a2',
          role: 'assistant',
          timestamp: 2000,
          blocks: [
            { type: 'file', fileId: 'sf_beta', filePath: '/tmp/session-files/beta.pdf', label: 'beta.pdf', ext: 'pdf', status: 'available' },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    const rows = screen.getAllByTestId('session-file-row');
    fireEvent.click(rows[0]);
    fireEvent.click(rows[1], { metaKey: true });
    fireEvent.keyDown(screen.getByRole('list', { name: '对话文件列表' }), { key: 'c', metaKey: true });
    fireEvent.paste(screen.getByRole('list', { name: '对话文件列表' }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/session-files/alpha.png\n/tmp/session-files/beta.pdf');
    expect(screen.getAllByTestId('session-file-row')).toHaveLength(2);
  });

  it('supports rubber-band selection inside the session file list', async () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 3000,
          blocks: [
            { type: 'file', fileId: 'sf_alpha', filePath: '/tmp/session-files/alpha.png', label: 'alpha.png', ext: 'png', status: 'available' },
          ],
        },
      },
      {
        type: 'message',
        data: {
          id: 'a2',
          role: 'assistant',
          timestamp: 2000,
          blocks: [
            { type: 'file', fileId: 'sf_beta', filePath: '/tmp/session-files/beta.pdf', label: 'beta.pdf', ext: 'pdf', status: 'available' },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    const list = screen.getByRole('list', { name: '对话文件列表' });
    const rows = screen.getAllByTestId('session-file-row');
    vi.spyOn(rows[0], 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 10, left: 10, top: 10, right: 90, bottom: 32, width: 80, height: 22, toJSON: () => {},
    } as DOMRect);
    vi.spyOn(rows[1], 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 70, left: 10, top: 70, right: 90, bottom: 92, width: 80, height: 22, toJSON: () => {},
    } as DOMRect);

    fireEvent.mouseDown(list, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 100, clientY: 40 });
    fireEvent.mouseUp(window);

    await waitFor(() => {
      expect(rows[0]).toHaveAttribute('data-selected', 'true');
      expect(rows[1]).toHaveAttribute('data-selected', 'false');
    });

    fireEvent.keyDown(list, { key: 'c', metaKey: true });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/session-files/alpha.png');
  });

  it('uses the selected session files when dragging them out to the desktop', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 3000,
          blocks: [
            { type: 'file', fileId: 'sf_alpha', filePath: '/tmp/session-files/alpha.png', label: 'alpha.png', ext: 'png', status: 'available' },
          ],
        },
      },
      {
        type: 'message',
        data: {
          id: 'a2',
          role: 'assistant',
          timestamp: 2000,
          blocks: [
            { type: 'file', fileId: 'sf_beta', filePath: '/tmp/session-files/beta.pdf', label: 'beta.pdf', ext: 'pdf', status: 'available' },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    const rows = screen.getAllByTestId('session-file-row');
    fireEvent.click(rows[0]);
    fireEvent.click(rows[1], { metaKey: true });
    fireEvent.dragStart(rows[1]);

    expect(window.platform?.startDrag).toHaveBeenCalledWith(['/tmp/session-files/alpha.png', '/tmp/session-files/beta.pdf']);
  });

  it('opens a right-click menu for session files without exposing paste/add actions', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 1700000000000,
          blocks: [
            { type: 'file', fileId: 'sf_report', filePath: '/tmp/session-files/report.pdf', label: 'report.pdf', ext: 'pdf', status: 'available' },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    fireEvent.contextMenu(screen.getByTestId('session-file-row'), { clientX: 24, clientY: 48 });

    expect(screen.getByText('预览')).toBeInTheDocument();
    expect(screen.getByText('打开')).toBeInTheDocument();
    expect(screen.getByText('定位')).toBeInTheDocument();
    expect(screen.getByText('复制路径')).toBeInTheDocument();
    expect(screen.queryByText('粘贴')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('复制路径'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/session-files/report.pdf');
  });

  it('adds screenshot share to Markdown session file context menus', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 1700000000000,
          blocks: [
            { type: 'file', fileId: 'sf_report', filePath: '/tmp/session-files/a1b2c3', label: 'report.md', ext: 'md', status: 'available' },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));
    fireEvent.contextMenu(screen.getByTestId('session-file-row'), { clientX: 24, clientY: 48 });

    fireEvent.click(screen.getByText('截图分享'));

    expect(takeMarkdownFileScreenshot).toHaveBeenCalledWith('/tmp/session-files/a1b2c3', {
      fileName: 'report.md',
    });
  });

  it('sends session files to an existing Bridge target from the context submenu', async () => {
    const sendBodies: unknown[] = [];
    vi.mocked(hanaFetch).mockImplementation(async (path, init) => {
      if (path.startsWith('/api/bridge/sessions?platform=feishu')) {
        return jsonResponse({
          sessions: [{ sessionKey: 'fs_1', chatId: 'oc_chat', displayName: '小群' }],
        });
      }
      if (path.startsWith('/api/bridge/sessions?')) {
        return jsonResponse({ sessions: [] });
      }
      if (path.startsWith('/api/bridge/send-media')) {
        sendBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ ok: true, fileId: 'sf_sent' });
      }
      return jsonResponse({});
    });
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 1700000000000,
          blocks: [
            { type: 'file', fileId: 'sf_report', filePath: '/tmp/session-files/report.pdf', label: 'report.pdf', ext: 'pdf', status: 'available' },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));
    fireEvent.contextMenu(screen.getByTestId('session-file-row'), { clientX: 24, clientY: 48 });

    fireEvent.mouseEnter(screen.getByText('发送到...'));
    fireEvent.click(await screen.findByText('Hana：飞书 · 小群'));

    await waitFor(() => {
      expect(sendBodies).toEqual([
        {
          platform: 'feishu',
          chatId: 'oc_chat',
          filePath: '/tmp/session-files/report.pdf',
          label: 'report.pdf',
          sessionPath: '/sessions/main.jsonl',
        },
      ]);
    });
    expect(hanaFetch).toHaveBeenCalledWith('/api/bridge/send-media?agentId=hana', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));
  });

  it('opens pathless screenshot files through MediaViewer and disables path actions', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'shot-1',
          role: 'assistant',
          timestamp: 1700000000000,
          blocks: [
            { type: 'screenshot', base64: 'iVBORw0...', mimeType: 'image/png' },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    const name = 'screenshot-shot-1-0.png';
    fireEvent.click(screen.getByRole('button', { name: `预览 ${name}` }));
    expect(openMediaViewerForRef).toHaveBeenCalledWith(expect.objectContaining({
      source: 'session-block-screenshot',
      name,
      path: '',
      inlineData: { base64: 'iVBORw0...', mimeType: 'image/png' },
    }), { origin: 'session', sessionPath: '/sessions/main.jsonl' });

    expect(screen.queryByRole('button', { name: `打开 ${name}` })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `定位 ${name}` })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `复制路径 ${name}` })).not.toBeInTheDocument();
  });

  it('collapses and expands the Jian drawer without unmounting its editor state', () => {
    render(<RightWorkspacePanel />);

    const drawer = screen.getByRole('region', { name: '笺' });
    expect(drawer).toHaveAttribute('data-open', 'true');
    expect(screen.getByPlaceholderText('写点什么...')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '收起笺' }));

    expect(drawer).toHaveAttribute('data-open', 'false');
    expect(screen.getByRole('button', { name: '展开笺' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByPlaceholderText('写点什么...')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展开笺' }));

    expect(drawer).toHaveAttribute('data-open', 'true');
    expect(screen.getByRole('button', { name: '收起笺' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('hides raw Jian execution status while preserving it when editing the instruction body', async () => {
    vi.useFakeTimers();
    useStore.setState({
      deskJianContent: [
        '帮我巡检这个目录，执行五次。',
        '',
        '<!-- exec-log -->',
        '上次任务快照：',
        '```jian-snapshot',
        '帮我巡检这个目录，执行五次。',
        '```',
        '',
        '执行状态：',
        '- 状态：进行中',
        '- 进度：4/5',
        '- 说明：已完成第 4 次巡检。',
        '<!-- /exec-log -->',
      ].join('\n'),
    } as never);

    try {
      render(<RightWorkspacePanel />);

      expect(screen.getByPlaceholderText('写点什么...')).toHaveValue('帮我巡检这个目录，执行五次。');
      expect(screen.queryByText(/上次任务快照/)).not.toBeInTheDocument();
      expect(screen.queryByText(/执行状态/)).not.toBeInTheDocument();
      expect(screen.queryByText(/进度：4\/5/)).not.toBeInTheDocument();

      fireEvent.change(screen.getByPlaceholderText('写点什么...'), {
        target: { value: '帮我巡检这个目录，执行五次。 ' },
      });
      await vi.advanceTimersByTimeAsync(850);

      const saveCall = vi.mocked(hanaFetch).mock.calls.find(([url, init]) => (
        url === '/api/desk/jian' && init && typeof init === 'object' && init.method === 'POST'
      ));
      expect(saveCall).toBeTruthy();
      const body = JSON.parse(String((saveCall?.[1] as RequestInit).body));
      expect(body.content).toContain('帮我巡检这个目录，执行五次。 ');
      expect(body.content).toContain('上次任务快照：');
      expect(body.content).toContain('- 进度：4/5');
    } finally {
      vi.useRealTimers();
    }
  });
});
