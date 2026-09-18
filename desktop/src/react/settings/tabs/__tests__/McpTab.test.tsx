/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({
  loadMcpState: vi.fn(),
  setMcpEnabled: vi.fn(),
  addMcpConnector: vi.fn(),
  removeMcpConnector: vi.fn(),
  runMcpConnectorAction: vi.fn(),
  setAgentMcpConnector: vi.fn(),
  setAgentMcpTool: vi.fn(),
  startMcpOAuth: vi.fn(),
  pollMcpOAuth: vi.fn(),
  logoutMcpOAuth: vi.fn(),
}));

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('../mcp/mcp-api', () => ({
  EMPTY_MCP_STATE: {
    enabled: false,
    connectors: [],
    agentConfig: { connectors: {} },
  },
  ...apiMocks,
}));

import { McpTab } from '../McpTab';
import { useSettingsStore } from '../../store';
import { WindowSurfaceProvider, type WindowSurface } from '../../../ui/window-surface';
import type { McpConnector } from '../mcp/types';

function state(enabled: boolean, connectors: McpConnector[] = []) {
  return {
    enabled,
    connectors,
    agentConfig: { connectors: {} },
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  Object.values(apiMocks).forEach(mock => mock.mockReset());
  useSettingsStore.setState({
    currentAgentId: null,
    agents: [],
    toastMessage: '',
    toastType: '',
    toastVisible: false,
  });
});

describe('McpTab', () => {
  it('does not show an empty connector list while MCP state is still loading', async () => {
    let resolveState: (value: ReturnType<typeof state>) => void = () => {};
    apiMocks.loadMcpState.mockImplementation(() => new Promise(resolve => {
      resolveState = resolve;
    }));
    useSettingsStore.setState({
      currentAgentId: 'hanako',
      agents: [{ id: 'hanako', name: 'Hanako', yuan: 'hanako', isPrimary: true }],
    });

    render(<McpTab />);

    expect(screen.queryByText('settings.mcp.noConnectors')).toBeNull();
    expect(screen.getAllByText('status.loading').length).toBeGreaterThan(0);

    resolveState(state(false));
    await waitFor(() => expect(screen.getAllByText('settings.mcp.noConnectors').length).toBeGreaterThan(0));
  });

  it('offers the global defer settings on the tab itself, not inside a connector', async () => {
    apiMocks.loadMcpState.mockResolvedValue(state(true));
    useSettingsStore.setState({
      currentAgentId: 'hanako',
      agents: [{ id: 'hanako', name: 'Hanako', yuan: 'hanako', isPrimary: true }],
    });

    render(<McpTab />);

    await waitFor(() => expect(screen.getByText('settings.mcp.deferTitle')).toBeTruthy());
  });

  it('toggles the global connector switch when the master row text is clicked', async () => {
    apiMocks.loadMcpState
      .mockResolvedValueOnce(state(false))
      .mockResolvedValueOnce(state(true));
    apiMocks.setMcpEnabled.mockResolvedValue(undefined);
    useSettingsStore.setState({
      currentAgentId: 'hanako',
      agents: [{ id: 'hanako', name: 'Hanako', yuan: 'hanako', isPrimary: true }],
    });

    render(<McpTab />);

    await waitFor(() => expect(apiMocks.loadMcpState).toHaveBeenCalledWith('hanako'));
    fireEvent.click(screen.getByText('settings.mcp.masterName'));

    await waitFor(() => expect(apiMocks.setMcpEnabled).toHaveBeenCalledWith(true));
  });

  it('does not send duplicate global toggle requests when the small switch is clicked', async () => {
    apiMocks.loadMcpState
      .mockResolvedValueOnce(state(false))
      .mockResolvedValueOnce(state(true));
    apiMocks.setMcpEnabled.mockResolvedValue(undefined);
    useSettingsStore.setState({
      currentAgentId: 'hanako',
      agents: [{ id: 'hanako', name: 'Hanako', yuan: 'hanako', isPrimary: true }],
    });

    render(<McpTab />);

    await waitFor(() => expect(apiMocks.loadMcpState).toHaveBeenCalledWith('hanako'));
    fireEvent.click(screen.getByRole('switch', { name: 'common.off' }));

    await waitFor(() => expect(apiMocks.setMcpEnabled).toHaveBeenCalledTimes(1));
    expect(apiMocks.setMcpEnabled).toHaveBeenCalledWith(true);
  });

  it('opens connector removal in the owning settings overlay surface', async () => {
    const connector: McpConnector = {
      id: 'github-mcp',
      name: 'GitHub MCP',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      status: 'stopped',
      tools: [],
    };
    apiMocks.loadMcpState.mockResolvedValue(state(true, [connector]));
    useSettingsStore.setState({
      currentAgentId: 'hanako',
      agents: [{ id: 'hanako', name: 'Hanako', yuan: 'hanako', isPrimary: true }],
    });
    const overlayRoot = document.createElement('div');
    document.body.append(overlayRoot);
    const surface: WindowSurface = {
      id: 'settings-modal:mcp-tab-test',
      window,
      document,
      overlayRoot,
    };

    render(
      <WindowSurfaceProvider surface={surface}>
        <McpTab />
      </WindowSurfaceProvider>,
    );

    await waitFor(() => expect(screen.getByText('GitHub MCP')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'common.remove' }));

    expect(within(overlayRoot).getByRole('dialog', { name: 'settings.mcp.removeTitle' })).toBeTruthy();
  });
});
