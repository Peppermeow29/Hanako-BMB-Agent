/**
 * @vitest-environment jsdom
 *
 * #1616：手动 Browse 选目录创建 local_fs mount 后，"打开当前工作台文件夹"按钮
 * 不应消失——只要 mount 披露了 native root，按钮就用它打开本地文件夹。
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { DeskOpenButton, DeskOpenIconButton } from '../../components/desk/DeskToolbar';

describe('Desk open-folder buttons for workspace roots', () => {
  let openFolder: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openFolder = vi.fn();
    window.t = ((key: string) => key) as typeof window.t;
    window.platform = { openFolder } as unknown as typeof window.platform;
    document.documentElement.removeAttribute('data-platform');
    useStore.setState({
      activeServerConnection: null,
      activeServerConnectionId: null,
      serverConnections: {},
      serverPort: 62950,
      serverToken: 'local-token',
      deskBasePath: '',
      deskWorkspaceMountId: null,
      deskWorkspaceLabel: null,
      deskWorkspaceNativeRoot: null,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the plain folder workspace through the native path', () => {
    useStore.setState({ deskBasePath: '/Users/me/project' } as never);

    render(<DeskOpenIconButton />);
    fireEvent.click(screen.getByRole('button', { name: 'desk.openInFinder' }));

    expect(openFolder).toHaveBeenCalledWith('/Users/me/project');
  });

  it('keeps the button for a Browse-mounted local_fs workspace and opens its native root', () => {
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceLabel: 'Docs',
      deskWorkspaceNativeRoot: '/Users/me/docs',
    } as never);

    render(<DeskOpenIconButton />);
    fireEvent.click(screen.getByRole('button', { name: 'desk.openInFinder' }));

    expect(openFolder).toHaveBeenCalledWith('/Users/me/docs');
  });

  it('still hides the buttons for mounts without a disclosed native root', () => {
    useStore.setState({
      deskBasePath: 'studio:mount_remote',
      deskWorkspaceMountId: 'mount_remote',
      deskWorkspaceLabel: 'Remote',
      deskWorkspaceNativeRoot: null,
    } as never);

    render(
      <>
        <DeskOpenIconButton />
        <DeskOpenButton />
      </>,
    );

    expect(screen.queryByRole('button', { name: 'desk.openInFinder' })).toBeNull();
    expect(openFolder).not.toHaveBeenCalled();
  });

  it('hides the buttons for remote clients viewing the default workspace', () => {
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

    render(
      <>
        <DeskOpenIconButton />
        <DeskOpenButton />
      </>,
    );

    expect(screen.queryByRole('button', { name: 'desk.openInFinder' })).toBeNull();
    expect(openFolder).not.toHaveBeenCalled();
  });

  it('shows the labeled toolbar button for native-root mounts', () => {
    useStore.setState({
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceNativeRoot: '/Users/me/docs',
    } as never);

    render(<DeskOpenButton />);
    fireEvent.click(screen.getByRole('button'));

    expect(openFolder).toHaveBeenCalledWith('/Users/me/docs');
  });
});
