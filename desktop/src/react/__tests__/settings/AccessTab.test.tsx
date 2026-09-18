/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockState = Record<string, any>;

const mockState: MockState = {};
const mockHanaFetch = vi.fn();

vi.mock('../../settings/store', () => {
  const hook: any = (selector?: (s: MockState) => unknown) =>
    selector ? selector(mockState) : mockState;
  hook.getState = () => mockState;
  hook.setState = (partial: Partial<MockState>) => Object.assign(mockState, partial);
  return { useSettingsStore: hook };
});

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mockHanaFetch(...args),
  hanaUrl: (path: string) => `http://127.0.0.1:14500${path}?token=local`,
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

const baseSummary = {
  network: {
    mode: 'loopback',
    listenHost: '127.0.0.1',
    configuredPort: 14500,
    actualPort: 14500,
    runtimeMode: 'loopback',
    runtimeHost: '127.0.0.1',
    restartRequired: false,
    lanAddresses: ['192.168.31.75'],
    localServerUrl: 'http://127.0.0.1:14500/',
    candidateLanServerUrl: 'http://192.168.31.75:14500/',
    lanServerUrl: null,
    localMobileUrl: 'http://127.0.0.1:14500/mobile/',
    candidateLanMobileUrl: 'http://192.168.31.75:14500/mobile/',
    lanMobileUrl: null,
    localDesktopUrl: 'http://127.0.0.1:14500/desktop/',
    candidateLanDesktopUrl: 'http://192.168.31.75:14500/desktop/',
    lanDesktopUrl: null,
  },
  account: {
    userId: 'user_owner',
    username: 'Owner',
    displayName: 'Owner',
    passwordSet: false,
  },
  devices: [],
  credentials: [],
};

const pairedSummary = {
  ...baseSummary,
  devices: [{
    deviceId: 'device_1',
    displayName: 'User Phone',
    deviceKind: 'mobile',
    status: 'active',
    trustState: 'lan',
    lastSeenAt: '2026-05-16T03:00:00.000Z',
  }],
  credentials: [{
    credentialId: 'cred_1',
    deviceId: 'device_1',
    status: 'active',
    scopes: ['chat', 'resources.read', 'files.read', 'files.write'],
    secretPrefix: 'hana_dev_abc',
    createdAt: '2026-05-16T02:00:00.000Z',
    lastUsedAt: '2026-05-16T03:00:00.000Z',
  }],
};

const lanSummary = {
  ...baseSummary,
  network: {
    ...baseSummary.network,
    mode: 'lan',
    listenHost: '0.0.0.0',
    runtimeMode: 'lan',
    runtimeHost: '0.0.0.0',
    lanServerUrl: 'http://192.168.31.75:14500/',
    lanMobileUrl: 'http://192.168.31.75:14500/mobile/',
    lanDesktopUrl: 'http://192.168.31.75:14500/desktop/',
  },
};

const localConnection = {
  connectionId: 'local',
  kind: 'local',
  serverId: 'local',
  studioId: 'local',
  label: 'Local Hana',
  baseUrl: 'http://127.0.0.1:14500',
  wsUrl: 'ws://127.0.0.1:14500',
  token: 'local',
  authState: 'paired',
  trustState: 'local',
  credentialKind: 'loopback_token',
  platformAccountId: null,
  officialServiceKind: null,
  capabilities: ['chat', 'resources', 'files', 'tools'],
};

const remoteConnection = {
  ...localConnection,
  connectionId: 'lan:node_lan:studio_lan',
  kind: 'lan',
  label: 'LAN Studio',
  baseUrl: 'http://192.168.31.75:14500',
  wsUrl: 'ws://192.168.31.75:14500',
  token: 'fixture-key',
  trustState: 'lan',
  credentialKind: 'device_credential',
};

describe('AccessTab', () => {
  beforeEach(() => {
    Object.keys(mockState).forEach(key => delete mockState[key]);
    Object.assign(mockState, {
      set: vi.fn((partial: Partial<MockState>) => Object.assign(mockState, partial)),
      showToast: vi.fn(),
      serverConnections: { local: localConnection },
      activeServerConnectionId: 'local',
      activeServerConnection: localConnection,
      settingsSnapshot: {
        key: null,
        status: 'idle',
        data: null,
        error: null,
        requestId: 0,
        updatedAt: null,
      },
    });
    mockHanaFetch.mockReset();
    mockHanaFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (url === '/api/access/summary') return Promise.resolve(jsonResponse(baseSummary));
      if (url === '/api/access/network' && options?.method === 'PUT') {
        return Promise.resolve(jsonResponse({
          ok: true,
          network: {
            ...baseSummary.network,
            mode: 'lan',
            listenHost: '0.0.0.0',
            configuredPort: 14500,
            lanServerUrl: 'http://192.168.31.75:14500/',
            candidateLanServerUrl: 'http://192.168.31.75:14500/',
            lanMobileUrl: 'http://192.168.31.75:14500/mobile/',
            candidateLanMobileUrl: 'http://192.168.31.75:14500/mobile/',
            lanDesktopUrl: 'http://192.168.31.75:14500/desktop/',
            candidateLanDesktopUrl: 'http://192.168.31.75:14500/desktop/',
            restartRequired: false,
          },
        }));
      }
      if (url === '/api/access/mobile-credentials' && options?.method === 'POST') {
        return Promise.resolve(jsonResponse({
          ok: true,
          secret: 'hana_dev_visible_once',
          accessUrl: 'http://192.168.31.75:14500/mobile/',
          device: { deviceId: 'device_1', displayName: 'iPhone', status: 'active' },
          credential: { credentialId: 'cred_1', scopes: ['chat', 'files.read', 'files.write'], status: 'active' },
        }));
      }
      if (url === '/api/access/desktop-credentials' && options?.method === 'POST') {
        return Promise.resolve(jsonResponse({
          ok: true,
          secret: 'hana_dev_desktop_visible_once',
          accessUrl: 'http://192.168.31.75:14500/desktop/',
          device: { deviceId: 'device_desktop', displayName: 'Studio Laptop', deviceKind: 'desktop', status: 'active' },
          credential: { credentialId: 'cred_desktop', scopes: ['chat', 'files.read', 'files.write'], status: 'active' },
        }));
      }
      if (url === '/api/access/account/profile' && options?.method === 'PUT') {
        return Promise.resolve(jsonResponse({
          ok: true,
          account: { ...baseSummary.account, username: 'hana-owner', displayName: 'Hana Owner' },
        }));
      }
      if (url === '/api/access/account/password' && options?.method === 'PUT') {
        return Promise.resolve(jsonResponse({
          ok: true,
          account: { ...baseSummary.account, passwordSet: true },
        }));
      }
      if (url === '/api/access/account/password' && options?.method === 'DELETE') {
        return Promise.resolve(jsonResponse({
          ok: true,
          account: { ...baseSummary.account, passwordSet: false },
        }));
      }
      if (url === '/api/devices/credentials/cred_1/revoke' && options?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'http://192.168.31.75:14500/api/web-auth/login') {
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      if (url === 'http://192.168.31.75:14500/api/server/identity') {
        return {
          ok: true,
          json: async () => ({
            connectionKind: 'lan',
            serverId: 'server_lan',
            serverNodeId: 'node_lan',
            userId: 'user_lan',
            studioId: 'studio_lan',
            label: 'LAN Server',
            trustState: 'lan',
            authState: 'paired',
            credentialKind: 'device_credential',
            capabilities: ['chat', 'resources', 'files'],
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch URL: ${url}`);
    }));
    Object.assign(window, {
      hana: { reloadMainWindow: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the stable mobile URL and saves LAN network settings', async () => {
    const { AccessTab } = await import('../../settings/tabs/AccessTab');

    render(<AccessTab />);

    await screen.findByText('settings.access.mobileUrlLocalHint');
    expect(screen.getByText('settings.access.networkAccess')).toBeInTheDocument();
    expect(screen.getByText('settings.access.mobileAccess')).toBeInTheDocument();
    expect(screen.getByText('settings.access.desktopAccess')).toBeInTheDocument();
    expect(screen.getByText('settings.access.status')).toBeInTheDocument();
    expect(screen.getByText('settings.access.runtimeEndpoint')).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1:14500')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('http://127.0.0.1:14500/mobile/')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('http://127.0.0.1:14500/desktop/')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('14500')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'settings.access.lanToggle' }));
    expect(await screen.findByDisplayValue('http://192.168.31.75:14500/mobile/')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('http://192.168.31.75:14500/desktop/')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'settings.access.qrCode' })).toHaveAttribute(
      'src',
      expect.stringContaining('/api/access/mobile-qr.svg?port=14500'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.access.saveNetwork' }));

    await waitFor(() => {
      expect(mockHanaFetch).toHaveBeenCalledWith('/api/access/network', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ mode: 'lan', listenPort: 14500 }),
      }));
    });
    expect(await screen.findByDisplayValue('http://192.168.31.75:14500/mobile/')).toBeInTheDocument();
    expect(screen.queryByText('settings.access.restartRequired')).not.toBeInTheDocument();
  });

  it('uses snapshot access summary for the LAN switch before the refresh request settles', async () => {
    let resolveSummary: (value: Response) => void = () => {};
    mockState.settingsSnapshot = {
      key: 'local:snapshot:agent-a',
      status: 'ready',
      data: {
        agentId: 'agent-a',
        access: lanSummary,
      },
      error: null,
      requestId: 1,
      updatedAt: Date.now(),
    };
    mockHanaFetch.mockImplementation((url: string) => {
      if (url === '/api/access/summary') {
        return new Promise<Response>((resolve) => {
          resolveSummary = resolve;
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const { AccessTab } = await import('../../settings/tabs/AccessTab');

    render(<AccessTab />);

    expect(screen.getByRole('switch', { name: 'settings.access.lanToggle' }))
      .toHaveAttribute('aria-checked', 'true');
    expect(screen.getByDisplayValue('14500')).toBeInTheDocument();
    expect(screen.getByDisplayValue('http://192.168.31.75:14500/mobile/')).toBeInTheDocument();
    expect(screen.getByDisplayValue('http://192.168.31.75:14500/desktop/')).toBeInTheDocument();

    resolveSummary(jsonResponse(lanSummary));
    await waitFor(() => {
      expect(mockHanaFetch).toHaveBeenCalledWith('/api/access/summary');
    });
  });

  it('keeps the phone URL on the runtime port and hides QR when a saved port change needs restart', async () => {
    mockHanaFetch.mockImplementation((url: string) => {
      if (url === '/api/access/summary') {
        return Promise.resolve(jsonResponse({
          ...baseSummary,
          network: {
            ...baseSummary.network,
            mode: 'lan',
            listenHost: '0.0.0.0',
            configuredPort: 14550,
            actualPort: 14500,
            runtimeMode: 'lan',
            runtimeHost: '0.0.0.0',
            restartRequired: true,
            lanServerUrl: 'http://192.168.31.75:14500/',
            candidateLanServerUrl: 'http://192.168.31.75:14550/',
            lanMobileUrl: 'http://192.168.31.75:14500/mobile/',
            candidateLanMobileUrl: 'http://192.168.31.75:14550/mobile/',
            lanDesktopUrl: 'http://192.168.31.75:14500/desktop/',
            candidateLanDesktopUrl: 'http://192.168.31.75:14550/desktop/',
          },
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const { AccessTab } = await import('../../settings/tabs/AccessTab');

    render(<AccessTab />);

    expect(await screen.findByDisplayValue('http://192.168.31.75:14500/mobile/')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('http://192.168.31.75:14500/desktop/')).toBeInTheDocument();
    expect(screen.getByDisplayValue('14550')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('http://192.168.31.75:14550/mobile/')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('http://192.168.31.75:14550/desktop/')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'settings.access.qrCode' })).not.toBeInTheDocument();
    expect(screen.getAllByText('settings.access.restartRequired').length).toBeGreaterThan(0);
  });

  it('generates a mobile access key and keeps the returned secret visible once', async () => {
    const { AccessTab } = await import('../../settings/tabs/AccessTab');

    render(<AccessTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'settings.access.generateMobileKey' }));

    expect(await screen.findByDisplayValue('hana_dev_visible_once')).toBeInTheDocument();
    expect(mockHanaFetch).toHaveBeenCalledWith('/api/access/mobile-credentials', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        displayName: 'Mobile PWA',
        scopes: ['chat', 'resources.read', 'files.read', 'files.write'],
      }),
    }));
  });

  it('generates a desktop access key from the manual computer section', async () => {
    const { AccessTab } = await import('../../settings/tabs/AccessTab');

    render(<AccessTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'settings.access.generateDesktopKey' }));

    expect(await screen.findByDisplayValue('hana_dev_desktop_visible_once')).toBeInTheDocument();
    expect(mockHanaFetch).toHaveBeenCalledWith('/api/access/desktop-credentials', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        displayName: 'Desktop Frontend',
        scopes: [
          'chat',
          'resources.read',
          'files.read',
          'files.write',
          'studio.owner',
          'settings.read',
          'settings.write',
          'providers.manage',
          'secrets.write',
          'bridge.manage',
        ],
      }),
    }));
  });

  it('connects to an existing LAN server from the client connection section', async () => {
    const { AccessTab } = await import('../../settings/tabs/AccessTab');

    render(<AccessTab />);

    fireEvent.change(await screen.findByLabelText('settings.access.remoteServerUrl'), {
      target: { value: 'http://192.168.31.75:14500' },
    });
    fireEvent.change(screen.getByLabelText('settings.access.remoteServerKey'), {
      target: { value: 'fixture-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.access.connectLanServer' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('http://192.168.31.75:14500/api/web-auth/login', expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ credential: 'fixture-key' }),
      }));
    });
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('http://192.168.31.75:14500/api/server/identity', expect.objectContaining({
        credentials: 'include',
        headers: { Authorization: 'Bearer fixture-key' },
      }));
      expect(window.hana.reloadMainWindow).toHaveBeenCalledTimes(1);
    });
  });

  it('renders remote connections as local-only management and can return to the local server', async () => {
    Object.assign(mockState, {
      serverConnections: {
        local: localConnection,
        [remoteConnection.connectionId]: remoteConnection,
      },
      activeServerConnectionId: remoteConnection.connectionId,
      activeServerConnection: remoteConnection,
    });
    const { AccessTab } = await import('../../settings/tabs/AccessTab');

    render(<AccessTab />);

    expect(await screen.findByText('settings.access.remoteConnection')).toBeInTheDocument();
    expect(screen.getByText('LAN Studio')).toBeInTheDocument();
    expect(screen.queryByText('settings.access.localAccount')).not.toBeInTheDocument();
    expect(mockHanaFetch).not.toHaveBeenCalledWith('/api/access/summary');

    fireEvent.click(screen.getByRole('button', { name: 'settings.access.returnToLocal' }));

    expect(mockState.activeServerConnectionId).toBe('local');
    expect(mockState.activeServerConnection).toBe(localConnection);
    expect(window.hana.reloadMainWindow).toHaveBeenCalledTimes(1);
  });

  it('saves the local owner profile and password from the account section', async () => {
    const { AccessTab } = await import('../../settings/tabs/AccessTab');

    render(<AccessTab />);

    fireEvent.change(await screen.findByLabelText('settings.access.username'), {
      target: { value: 'hana-owner' },
    });
    fireEvent.change(screen.getByLabelText('settings.access.displayName'), {
      target: { value: 'Hana Owner' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.access.saveAccount' }));

    await waitFor(() => {
      expect(mockHanaFetch).toHaveBeenCalledWith('/api/access/account/profile', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ username: 'hana-owner', displayName: 'Hana Owner' }),
      }));
    });

    fireEvent.change(screen.getByLabelText('settings.access.newPassword'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.access.savePassword' }));

    await waitFor(() => {
      expect(mockHanaFetch).toHaveBeenCalledWith('/api/access/account/password', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ password: 'correct horse battery staple' }),
      }));
    });
  });

  it('revokes individual credentials without requiring whole-device revocation', async () => {
    mockHanaFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (url === '/api/access/summary') return Promise.resolve(jsonResponse(pairedSummary));
      if (url === '/api/devices/credentials/cred_1/revoke' && options?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const { AccessTab } = await import('../../settings/tabs/AccessTab');

    render(<AccessTab />);

    expect(await screen.findByText('User Phone')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'settings.access.revokeCredential' }));

    await waitFor(() => {
      expect(mockHanaFetch).toHaveBeenCalledWith('/api/devices/credentials/cred_1/revoke', { method: 'POST' });
    });
  });

  it('clears the local password from the password section', async () => {
    mockHanaFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (url === '/api/access/summary') {
        return Promise.resolve(jsonResponse({
          ...baseSummary,
          account: { ...baseSummary.account, passwordSet: true },
        }));
      }
      if (url === '/api/access/account/password' && options?.method === 'DELETE') {
        return Promise.resolve(jsonResponse({
          ok: true,
          account: { ...baseSummary.account, passwordSet: false },
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const { AccessTab } = await import('../../settings/tabs/AccessTab');

    render(<AccessTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'settings.access.clearPassword' }));

    await waitFor(() => {
      expect(mockHanaFetch).toHaveBeenCalledWith('/api/access/account/password', { method: 'DELETE' });
    });
  });
});
