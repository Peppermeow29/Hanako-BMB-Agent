/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePluginSurfaceUrl } from '../../hooks/use-plugin-surface-url';
import { useStore } from '../../stores';
import { createLocalServerConnection } from '../../services/server-connection';
import { DEFAULT_THEME } from '../../../shared/theme-registry';

const localConnection = createLocalServerConnection({
  serverPort: '3210',
  serverToken: 'local-token',
})!;

const remoteConnection = {
  ...localConnection,
  connectionId: 'lan:node_lan:studio_lan',
  kind: 'lan' as const,
  label: 'LAN Studio',
  baseUrl: 'https://hana.example',
  wsUrl: 'wss://hana.example',
  token: 'remote-token',
  trustState: 'lan' as const,
  credentialKind: 'device_credential' as const,
};

function Harness({ routeUrl, agentId = 'butter' }: { routeUrl: string; agentId?: string | null }) {
  const surface = usePluginSurfaceUrl(routeUrl, agentId);
  return (
    <div>
      <div data-testid="status">{surface.status}</div>
      <div data-testid="src">{surface.iframeSrc || ''}</div>
      <div data-testid="error">{surface.error || ''}</div>
    </div>
  );
}

function issuanceResponse(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    ticket: 'ticket-1',
    expiresAt: '2026-06-05T12:00:00.000Z',
    surfaceSession: {
      token: 'surface-session-1',
      expiresAt: '2026-06-06T00:00:00.000Z',
    },
    ...overrides,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('usePluginSurfaceUrl', () => {
  beforeEach(() => {
    document.documentElement.dataset.theme = DEFAULT_THEME;
    useStore.setState({
      serverConnections: { local: localConnection },
      activeServerConnectionId: 'local',
      activeServerConnection: localConnection,
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('leaves agentId out of the URL entirely when the surface has no agent', async () => {
    const fetchMock = vi.fn(async () => issuanceResponse());
    vi.stubGlobal('fetch', fetchMock);

    render(<Harness routeUrl="/api/plugins/demo/page" agentId={null} />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    const url = new URL(screen.getByTestId('src').textContent || '');
    // An empty agentId= reads as "an agent whose id is the empty string". A
    // surface with no agent should simply not carry the parameter.
    expect(url.searchParams.has('agentId')).toBe(false);
  });

  it('builds local iframe URLs with the loopback query token plus an issued plugin surface session', async () => {
    const fetchMock = vi.fn(async () => issuanceResponse());
    vi.stubGlobal('fetch', fetchMock);

    render(<Harness routeUrl="/api/plugins/demo/page?view=compact" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3210/api/plugins/iframe-ticket', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ routeUrl: '/api/plugins/demo/page?view=compact' }),
    }));
    const url = new URL(screen.getByTestId('src').textContent || '');
    expect(url.origin).toBe('http://127.0.0.1:3210');
    expect(url.pathname).toBe('/api/plugins/demo/page');
    expect(url.searchParams.get('view')).toBe('compact');
    expect(url.searchParams.get('token')).toBe('local-token');
    expect(url.searchParams.get('pluginSurfaceSession')).toBe('surface-session-1');
    expect(url.searchParams.get('pluginIframeTicket')).toBeNull();
    expect(url.searchParams.get('agentId')).toBe('butter');
    expect(url.searchParams.get('hana-css')).toBe(
      `http://127.0.0.1:3210/api/plugins/theme.css?theme=${DEFAULT_THEME}&token=local-token`,
    );
  });

  it('uses a remote iframe ticket and surface session without leaking the remote device credential into the iframe URL', async () => {
    useStore.setState({
      serverConnections: {
        local: localConnection,
        [remoteConnection.connectionId]: remoteConnection,
      },
      activeServerConnectionId: remoteConnection.connectionId,
      activeServerConnection: remoteConnection,
    } as any);
    const fetchMock = vi.fn(async () => issuanceResponse());
    vi.stubGlobal('fetch', fetchMock);

    render(<Harness routeUrl="/api/plugins/demo/page?view=compact" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledWith('https://hana.example/api/plugins/iframe-ticket', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: expect.objectContaining({ Authorization: 'Bearer remote-token' }),
      body: JSON.stringify({ routeUrl: '/api/plugins/demo/page?view=compact' }),
    }));
    const url = new URL(screen.getByTestId('src').textContent || '');
    expect(url.origin).toBe('https://hana.example');
    expect(url.searchParams.get('pluginIframeTicket')).toBe('ticket-1');
    expect(url.searchParams.get('pluginSurfaceSession')).toBe('surface-session-1');
    expect(url.searchParams.get('view')).toBe('compact');
    expect(url.searchParams.get('token')).toBeNull();
    expect(url.toString()).not.toContain('remote-token');
    expect(url.searchParams.get('hana-css')).toBe(
      `https://hana.example/api/plugins/theme.css?theme=${DEFAULT_THEME}`,
    );
  });

  it('keeps local surfaces rendering when the server omits the surface session field', async () => {
    const fetchMock = vi.fn(async () => issuanceResponse({ surfaceSession: undefined }));
    vi.stubGlobal('fetch', fetchMock);

    render(<Harness routeUrl="/api/plugins/demo/page" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    const url = new URL(screen.getByTestId('src').textContent || '');
    expect(url.searchParams.get('token')).toBe('local-token');
    expect(url.searchParams.get('pluginSurfaceSession')).toBeNull();
  });

  it('surfaces issuance failures as a retryable error state', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500, statusText: 'Internal Server Error' }));
    vi.stubGlobal('fetch', fetchMock);

    render(<Harness routeUrl="/api/plugins/demo/page" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
    expect(screen.getByTestId('error').textContent).toContain('plugin iframe ticket failed: 500');
    expect(screen.getByTestId('src').textContent).toBe('');
  });
});
