/**
 * @vitest-environment jsdom
 *
 * #1622：手动 Browse 选目录创建的 local_fs mount 工作台，拖拽文件到聊天区
 * 必须携带真实绝对路径（mount 披露 native root 时），而不是 workbench:<mountId>
 * 占位引用；同时要发起原生拖拽，让拖拽真正可用。
 */

import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { DeskTree } from '../../components/desk/DeskTree';
import type { CtxMenuState } from '../../components/desk/desk-types';
import {
  clearAppFileDragPayload,
  getActiveAppFileDragPayload,
} from '../../utils/app-file-drag';
import { takeMarkdownFileScreenshot } from '../../utils/screenshot';

const mocks = vi.hoisted(() => ({
  loadDeskTreeFiles: vi.fn(async () => {}),
}));

vi.mock('../../stores/desk-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/desk-actions')>();
  return {
    ...actual,
    loadDeskTreeFiles: mocks.loadDeskTreeFiles,
  };
});

vi.mock('../../utils/screenshot', () => ({
  takeMarkdownFileScreenshot: vi.fn(async () => undefined),
}));

function makeDataTransfer() {
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: vi.fn(),
    getData: vi.fn(() => ''),
    files: [],
    items: [],
  } as unknown as DataTransfer;
}

function renderTree() {
  return render(
    <DeskTree
      sortMode="name-asc"
      onShowMenu={vi.fn()}
      inlineEdit={null}
      onInlineEditChange={vi.fn()}
      onStartCreate={vi.fn(async () => {})}
    />,
  );
}

function renderTreeWithMenu(onShowMenu: (state: CtxMenuState) => void) {
  return render(
    <DeskTree
      sortMode="name-asc"
      onShowMenu={onShowMenu}
      inlineEdit={null}
      onInlineEditChange={vi.fn()}
      onStartCreate={vi.fn(async () => {})}
    />,
  );
}

describe('DeskTree drag payloads for workspace roots', () => {
  let startDrag: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearAppFileDragPayload();
    startDrag = vi.fn();
    window.t = ((key: string) => ({
      'common.screenshotShare': '截图分享',
    }[key] || key)) as typeof window.t;
    window.platform = { startDrag } as unknown as typeof window.platform;
    vi.mocked(takeMarkdownFileScreenshot).mockClear();
    document.documentElement.removeAttribute('data-platform');
    useStore.setState({
      activeServerConnection: null,
      activeServerConnectionId: null,
      serverConnections: {},
      serverPort: 62950,
      serverToken: 'local-token',
      deskFiles: [{ name: 'report.md', isDir: false }],
      deskTreeFilesByPath: { '': [{ name: 'report.md', isDir: false }] },
      deskExpandedPaths: [],
      deskSelectedPath: '',
    } as never);
  });

  afterEach(() => {
    clearAppFileDragPayload();
    cleanup();
  });

  it('drags plain folder workspace files with native paths', () => {
    useStore.setState({
      deskBasePath: '/Users/me/project',
      deskWorkspaceMountId: null,
      deskWorkspaceNativeRoot: null,
    } as never);

    const { container } = renderTree();
    const item = container.querySelector('[data-desk-path="report.md"]');
    expect(item).not.toBeNull();
    fireEvent.dragStart(item as Element, { dataTransfer: makeDataTransfer() });

    expect(getActiveAppFileDragPayload()?.files).toEqual([
      expect.objectContaining({ path: '/Users/me/project/report.md' }),
    ]);
    expect(startDrag).toHaveBeenCalledWith('/Users/me/project/report.md');
  });

  it('drags native-root mount workspace files with real absolute paths and starts a native drag', () => {
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceLabel: 'Docs',
      deskWorkspaceNativeRoot: '/Users/me/docs',
    } as never);

    const { container } = renderTree();
    const item = container.querySelector('[data-desk-path="report.md"]');
    expect(item).not.toBeNull();
    fireEvent.dragStart(item as Element, { dataTransfer: makeDataTransfer() });

    expect(getActiveAppFileDragPayload()?.files).toEqual([
      expect.objectContaining({ path: '/Users/me/docs/report.md' }),
    ]);
    expect(startDrag).toHaveBeenCalledWith('/Users/me/docs/report.md');
  });

  it('keeps workbench references for mounts without a disclosed native root', () => {
    useStore.setState({
      deskBasePath: 'studio:mount_remote',
      deskWorkspaceMountId: 'mount_remote',
      deskWorkspaceLabel: 'Remote',
      deskWorkspaceNativeRoot: null,
    } as never);

    const { container } = renderTree();
    const item = container.querySelector('[data-desk-path="report.md"]');
    expect(item).not.toBeNull();
    fireEvent.dragStart(item as Element, { dataTransfer: makeDataTransfer() });

    expect(getActiveAppFileDragPayload()?.files).toEqual([
      expect.objectContaining({ path: 'workbench:mount_remote:report.md' }),
    ]);
    expect(startDrag).not.toHaveBeenCalled();
  });

  it('keeps workbench references for a remote client viewing the default workspace', () => {
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
      deskBasePath: '/Users/server/project',
      deskWorkspaceMountId: null,
      deskWorkspaceNativeRoot: null,
    } as never);

    const { container } = renderTree();
    const item = container.querySelector('[data-desk-path="report.md"]');
    expect(item).not.toBeNull();
    fireEvent.dragStart(item as Element, { dataTransfer: makeDataTransfer() });

    expect(getActiveAppFileDragPayload()?.files).toEqual([
      expect.objectContaining({ path: 'workbench:default:report.md' }),
    ]);
    expect(startDrag).not.toHaveBeenCalled();
  });

  it('exposes the full filename on the hovered tree row, not only the text span', () => {
    useStore.setState({
      deskBasePath: '/Users/me/project',
      deskWorkspaceMountId: null,
      deskWorkspaceNativeRoot: null,
      deskFiles: [{ name: 'very-long-report-name-that-truncates.md', isDir: false }],
      deskTreeFilesByPath: { '': [{ name: 'very-long-report-name-that-truncates.md', isDir: false }] },
    } as never);

    const { container } = renderTree();
    const item = container.querySelector('[data-desk-path="very-long-report-name-that-truncates.md"]');

    expect(item?.getAttribute('title')).toBe('very-long-report-name-that-truncates.md');
  });

  it('adds screenshot share to local Markdown workspace context menus', () => {
    const onShowMenu = vi.fn();
    useStore.setState({
      deskBasePath: '/Users/me/project',
      deskWorkspaceMountId: null,
      deskWorkspaceNativeRoot: null,
    } as never);

    const { container } = renderTreeWithMenu(onShowMenu);
    fireEvent.contextMenu(container.querySelector('[data-desk-path="report.md"]') as Element, { clientX: 8, clientY: 12 });

    const menu = onShowMenu.mock.calls[0][0];
    const screenshotItem = menu.items.find((item: { label?: string }) => item.label === '截图分享');
    expect(screenshotItem).toBeTruthy();

    screenshotItem.action();
    expect(takeMarkdownFileScreenshot).toHaveBeenCalledWith('/Users/me/project/report.md', {
      saveDir: '/Users/me/project',
      fileName: 'report.md',
    });
  });

  it('does not add screenshot share to non-Markdown workspace context menus', () => {
    const onShowMenu = vi.fn();
    useStore.setState({
      deskBasePath: '/Users/me/project',
      deskWorkspaceMountId: null,
      deskWorkspaceNativeRoot: null,
      deskFiles: [{ name: 'archive.zip', isDir: false }],
      deskTreeFilesByPath: { '': [{ name: 'archive.zip', isDir: false }] },
    } as never);

    const { container } = renderTreeWithMenu(onShowMenu);
    fireEvent.contextMenu(container.querySelector('[data-desk-path="archive.zip"]') as Element, { clientX: 8, clientY: 12 });

    expect(onShowMenu.mock.calls[0][0].items.some((item: { label?: string }) => item.label === '截图分享')).toBe(false);
  });
});
