/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBridgeState } from '../../settings/tabs/bridge/useBridgeState';

interface MockSnapshot extends Record<string, unknown> {
  agentId: string;
  publicAgents: string;
  bridgeStatus: Record<string, unknown>;
}

interface MockState extends Record<string, unknown> {
  currentAgentId: string;
  showToast: ReturnType<typeof vi.fn>;
  settingsSnapshot: {
    data: MockSnapshot;
  } & Record<string, unknown>;
}

interface MockStoreHook {
  (selector?: (state: MockState) => unknown): unknown;
  getState: () => MockState;
  setState: (partial: Partial<MockState>) => void;
}

const mockState = {} as MockState;
const mockHanaFetch = vi.fn();
const mockUpdateSettingsSnapshot = vi.fn((mutator: (snapshot: MockSnapshot) => MockSnapshot) => {
  const snapshot = mockState.settingsSnapshot?.data;
  if (!snapshot) return;
  mockState.settingsSnapshot.data = mutator(snapshot);
});

vi.mock('../../settings/store', () => {
  const hook = ((selector?: (s: MockState) => unknown) =>
    selector ? selector(mockState) : mockState) as MockStoreHook;
  hook.getState = () => mockState;
  hook.setState = (partial: Partial<MockState>) => Object.assign(mockState, partial);
  return { useSettingsStore: hook };
});

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mockHanaFetch(...args),
}));

vi.mock('../../settings/actions', () => ({
  loadSettingsConfig: vi.fn(async () => {}),
  updateSettingsSnapshot: (mutator: (snapshot: MockSnapshot) => MockSnapshot) => mockUpdateSettingsSnapshot(mutator),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

function BridgeProbe() {
  const {
    status,
    tgToken,
    tgTokenDraft,
    fsAppSecret,
    fsAppSecretDraft,
    dtClientSecret,
    dtClientSecretDraft,
    qqAppSecret,
    qqAppSecretDraft,
    publicAgentsMd,
    loadStatus,
    selectedAgentId,
    setSelectedAgentId,
  } = useBridgeState();
  return (
    <div>
      <span data-testid="telegram-enabled">{String(status?.telegram?.enabled)}</span>
      <span data-testid="permission-mode">{status?.permissionMode || 'none'}</span>
      <span data-testid="rich-streaming">{String(status?.richStreamingEnabled)}</span>
      <span data-testid="telegram-token">{tgToken}</span>
      <span data-testid="telegram-token-stored">{String(tgTokenDraft.hasStored)}</span>
      <span data-testid="feishu-secret">{fsAppSecret}</span>
      <span data-testid="feishu-secret-stored">{String(fsAppSecretDraft.hasStored)}</span>
      <span data-testid="dingtalk-secret">{dtClientSecret}</span>
      <span data-testid="dingtalk-secret-stored">{String(dtClientSecretDraft.hasStored)}</span>
      <span data-testid="qq-secret">{qqAppSecret}</span>
      <span data-testid="qq-secret-stored">{String(qqAppSecretDraft.hasStored)}</span>
      <span data-testid="public-agents-md">{publicAgentsMd}</span>
      <span data-testid="selected-agent">{selectedAgentId || 'none'}</span>
      <span data-testid="wechat-status">{status?.wechat?.status || 'none'}</span>
      <button type="button" onClick={() => loadStatus()}>reload status</button>
      <button type="button" onClick={() => setSelectedAgentId('mio')}>bridge probe switch to mio</button>
    </div>
  );
}

function TelegramSecretProbe() {
  const bridge = useBridgeState();
  const saveTelegramToken = () => {
    if (!bridge.tgTokenDraft.dirty || !bridge.tgToken.trim()) return;
    void bridge.saveBridgeConfig('telegram', { token: bridge.tgToken.trim() });
  };
  return (
    <div>
      <input
        data-testid="telegram-secret-input"
        value={bridge.tgToken}
        onChange={(event) => bridge.setTgToken(event.target.value)}
        onBlur={saveTelegramToken}
      />
      <span data-testid="telegram-secret-owner">{bridge.tgTokenDraft.ownerId || 'none'}</span>
      <span data-testid="telegram-secret-dirty">{String(bridge.tgTokenDraft.dirty)}</span>
      <span data-testid="telegram-secret-stored">{String(bridge.tgTokenDraft.hasStored)}</span>
      <span data-testid="telegram-secret-revision">{String(bridge.tgTokenDraft.revision)}</span>
      <button type="button" onClick={() => bridge.testPlatform('telegram', {}, true)}>test saved</button>
      <button type="button" onClick={() => {
        bridge.setTgToken('');
        void bridge.saveBridgeConfig('telegram', { token: '' });
      }}>clear saved</button>
      <button type="button" onClick={() => bridge.setSelectedAgentId('mio')}>switch to mio</button>
      <button type="button" onClick={() => bridge.setSelectedAgentId('hana')}>switch to hana</button>
    </div>
  );
}

function DingTalkFieldProbe() {
  const bridge = useBridgeState();
  return (
    <input
      data-testid="dingtalk-client-id-input"
      value={bridge.dtClientId}
      onChange={(event) => bridge.setDtClientId(event.target.value)}
    />
  );
}

function DingTalkTestProbe() {
  const bridge = useBridgeState();
  return (
    <button type="button" onClick={() => bridge.testPlatform('dingtalk', {
      corpId: 'corp-1',
      clientId: 'client-1',
      clientSecret: 'secret-1',
      robotCode: 'robot-1',
      apiBaseUrl: 'https://api.dingtalk.com/v1.0',
    })}>test dingtalk credentials</button>
  );
}

function BridgeTestOwnershipProbe() {
  const bridge = useBridgeState();
  return (
    <div>
      <span data-testid="test-owner">{bridge.selectedAgentId || 'none'}</span>
      <span data-testid="testing-platform">{bridge.testingPlatform || 'none'}</span>
      <button type="button" onClick={() => bridge.testPlatform('telegram', { token: 'candidate' })}>
        test current agent
      </button>
      <button type="button" onClick={() => bridge.setSelectedAgentId('mio')}>
        test probe switch to mio
      </button>
    </div>
  );
}

function bridgeStatus(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'hana',
    telegram: {
      enabled: true,
      configured: true,
      status: 'connected',
      token: '********',
      hasToken: true,
      agentId: 'hana',
    },
    feishu: {
      enabled: false,
      status: 'disconnected',
      appId: 'feishu-app',
      appSecret: '********',
      hasAppSecret: true,
      agentId: 'hana',
    },
    dingtalk: {
      enabled: false,
      status: 'disconnected',
      corpId: 'ding-corp',
      clientId: 'ding-client',
      clientSecret: '********',
      hasClientSecret: true,
      robotCode: 'ding-robot',
      apiBaseUrl: 'https://api.dingtalk.com/v1.0',
      agentId: 'hana',
    },
    whatsapp: { enabled: false, status: 'disconnected', agentId: 'hana' },
    qq: {
      enabled: false,
      status: 'disconnected',
      appID: 'qq-app',
      appSecret: '********',
      hasAppSecret: true,
      agentId: 'hana',
    },
    wechat: { enabled: false, status: 'disconnected', token: '', agentId: 'hana' },
    permissionMode: 'operate',
    readOnly: false,
    receiptEnabled: true,
    richStreamingEnabled: true,
    knownUsers: {},
    owner: {},
    ...overrides,
  };
}

function BridgeEditorProbe() {
  const { publicAgentsMd, setPublicAgentsMd, savePublicAgentsMd } = useBridgeState();
  return (
    <div>
      <textarea
        data-testid="public-agents-md-input"
        value={publicAgentsMd}
        onChange={(event) => setPublicAgentsMd(event.target.value)}
      />
      <button type="button" onClick={savePublicAgentsMd}>save</button>
    </div>
  );
}

function BridgeOwnerProbe() {
  const { status, setOwner } = useBridgeState();
  return (
    <div>
      <span data-testid="telegram-owner">{status?.owner?.telegram || 'none'}</span>
      <button type="button" onClick={() => setOwner('telegram', 'owner-1')}>set owner</button>
    </div>
  );
}

describe('useBridgeState snapshot hydration', () => {
  beforeEach(() => {
    Object.keys(mockState).forEach(key => delete mockState[key]);
    Object.assign(mockState, {
      currentAgentId: 'hana',
      showToast: vi.fn(),
      settingsSnapshot: {
        key: 'local:snapshot:hana',
        status: 'ready',
        data: {
          agentId: 'hana',
          publicAgents: 'snapshot-public-agents-md',
          bridgeStatus: bridgeStatus(),
        },
        error: null,
        requestId: 1,
        updatedAt: Date.now(),
      },
    });
    mockHanaFetch.mockReset();
    mockUpdateSettingsSnapshot.mockClear();
    mockHanaFetch.mockImplementation((url: string) => {
      if (url === '/api/bridge/status?agentId=hana') {
        return new Promise<Response>(() => {});
      }
      throw new Error(`unexpected request: ${url}`);
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('uses snapshot bridge status before the status refresh request settles', () => {
    render(<BridgeProbe />);

    expect(screen.getByTestId('telegram-enabled')).toHaveTextContent('true');
    expect(screen.getByTestId('permission-mode')).toHaveTextContent('operate');
    expect(screen.getByTestId('rich-streaming')).toHaveTextContent('true');
    expect(screen.getByTestId('telegram-token')).toBeEmptyDOMElement();
    expect(screen.getByTestId('telegram-token-stored')).toHaveTextContent('true');
    expect(screen.getByTestId('feishu-secret')).toBeEmptyDOMElement();
    expect(screen.getByTestId('feishu-secret-stored')).toHaveTextContent('true');
    expect(screen.getByTestId('dingtalk-secret')).toBeEmptyDOMElement();
    expect(screen.getByTestId('dingtalk-secret-stored')).toHaveTextContent('true');
    expect(screen.getByTestId('qq-secret')).toBeEmptyDOMElement();
    expect(screen.getByTestId('qq-secret-stored')).toHaveTextContent('true');
    expect(screen.getByTestId('public-agents-md')).toHaveTextContent('snapshot-public-agents-md');
    expect(mockHanaFetch).toHaveBeenCalledWith(
      '/api/bridge/status?agentId=hana',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('keeps reconciling WeChat after QR confirmation until the selected Agent connects', async () => {
    vi.useFakeTimers();
    let statusRequests = 0;
    mockHanaFetch.mockImplementation((url: string) => {
      if (url !== '/api/bridge/status?agentId=hana') {
        throw new Error(`unexpected request: ${url}`);
      }
      statusRequests += 1;
      const wechat = statusRequests === 1
        ? { enabled: false, status: 'disconnected', token: '', agentId: 'hana' }
        : statusRequests === 2
          ? { enabled: true, status: 'connecting', token: '********', agentId: 'hana' }
          : { enabled: true, status: 'connected', token: '********', agentId: 'hana' };
      return Promise.resolve(new Response(JSON.stringify(bridgeStatus({ wechat }))));
    });

    render(<BridgeProbe />);
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      window.dispatchEvent(new Event('hana-bridge-reload'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('wechat-status')).toHaveTextContent('connecting');

    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(screen.getByTestId('wechat-status')).toHaveTextContent('connected');

    const requestsAfterConnection = statusRequests;
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(statusRequests).toBe(requestsAfterConnection);
  });

  it('cancels WeChat reconciliation when the selected Agent changes', async () => {
    vi.useFakeTimers();
    let hanaStatusRequests = 0;
    mockHanaFetch.mockImplementation((url: string) => {
      if (url === '/api/bridge/status?agentId=hana') {
        hanaStatusRequests += 1;
        const wechat = hanaStatusRequests === 1
          ? { enabled: false, status: 'disconnected', token: '', agentId: 'hana' }
          : { enabled: true, status: 'connecting', token: '********', agentId: 'hana' };
        return Promise.resolve(new Response(JSON.stringify(bridgeStatus({ wechat }))));
      }
      if (url === '/api/bridge/status?agentId=mio') {
        return Promise.resolve(new Response(JSON.stringify(bridgeStatus({
          agentId: 'mio',
          wechat: { enabled: false, status: 'disconnected', token: '', agentId: 'mio' },
        }))));
      }
      if (url === '/api/agents/mio/public-agents-md') {
        return Promise.resolve(new Response(JSON.stringify({ content: '' })));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<BridgeProbe />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      window.dispatchEvent(new Event('hana-bridge-reload'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('wechat-status')).toHaveTextContent('connecting');
    expect(hanaStatusRequests).toBe(2);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'bridge probe switch to mio' }));
      await Promise.resolve();
    });
    expect(screen.getByTestId('selected-agent')).toHaveTextContent('mio');
    expect(screen.getByTestId('wechat-status')).toHaveTextContent('disconnected');

    await act(async () => { await vi.runAllTimersAsync(); });
    expect(hanaStatusRequests).toBe(2);
    expect(screen.getByTestId('wechat-status')).toHaveTextContent('disconnected');
  });

  it('keeps saved public agents md in the settings snapshot for remounts', async () => {
    mockState.settingsSnapshot.data.publicAgents = '';
    mockHanaFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/api/bridge/status?agentId=hana') {
        return new Promise<Response>(() => {});
      }
      if (url === '/api/agents/hana/public-agents-md') {
        expect(opts).toMatchObject({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'saved public agents md' }),
        });
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const first = render(<BridgeEditorProbe />);

    fireEvent.change(screen.getByTestId('public-agents-md-input'), {
      target: { value: 'saved public agents md' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => {
      expect(mockState.showToast).toHaveBeenCalledWith('settings.saved', 'success');
    });
    expect(mockState.settingsSnapshot.data.publicAgents).toBe('saved public agents md');

    first.unmount();
    render(<BridgeEditorProbe />);

    expect(screen.getByTestId('public-agents-md-input')).toHaveValue('saved public agents md');
  });

  it('applies owner status returned by setOwner without waiting for a later refresh', async () => {
    mockHanaFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/api/bridge/status?agentId=hana') {
        return new Promise<Response>(() => {});
      }
      if (url === '/api/bridge/owner?agentId=hana') {
        expect(opts).toMatchObject({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: 'telegram', userId: 'owner-1' }),
        });
        return Promise.resolve(new Response(JSON.stringify({
          ok: true,
          status: {
            ...mockState.settingsSnapshot.data.bridgeStatus,
            owner: { telegram: 'owner-1' },
          },
        })));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<BridgeOwnerProbe />);

    expect(screen.getByTestId('telegram-owner')).toHaveTextContent('none');
    fireEvent.click(screen.getByRole('button', { name: 'set owner' }));

    await waitFor(() => {
      expect(screen.getByTestId('telegram-owner')).toHaveTextContent('owner-1');
    });
  });

  it('keeps a dirty secret when a stale masked status response arrives', async () => {
    let resolveStatus!: (response: Response) => void;
    mockHanaFetch.mockImplementation((url: string) => {
      if (url === '/api/bridge/status?agentId=hana') {
        return new Promise<Response>((resolve) => { resolveStatus = resolve; });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<TelegramSecretProbe />);
    fireEvent.change(screen.getByTestId('telegram-secret-input'), {
      target: { value: 'full-secret-from-clipboard' },
    });

    await act(async () => {
      resolveStatus(new Response(JSON.stringify(bridgeStatus())));
    });

    expect(screen.getByTestId('telegram-secret-input')).toHaveValue('full-secret-from-clipboard');
    expect(screen.getByTestId('telegram-secret-dirty')).toHaveTextContent('true');
    expect(screen.getByTestId('telegram-secret-revision')).toHaveTextContent('1');
  });

  it('keeps a dirty non-secret field when a status request started before the edit returns', async () => {
    let resolveStatus!: (response: Response) => void;
    mockHanaFetch.mockImplementation((url: string) => {
      if (url === '/api/bridge/status?agentId=hana') {
        return new Promise<Response>((resolve) => { resolveStatus = resolve; });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<DingTalkFieldProbe />);
    fireEvent.change(screen.getByTestId('dingtalk-client-id-input'), {
      target: { value: 'client-id-entered-after-request' },
    });

    await act(async () => {
      resolveStatus(new Response(JSON.stringify(bridgeStatus({
        dingtalk: {
          corpId: 'server-corp',
          clientId: 'stale-server-client-id',
          clientSecret: '********',
          hasClientSecret: true,
          robotCode: 'server-robot',
          apiBaseUrl: 'https://api.dingtalk.com/v1.0',
        },
      }))));
    });

    expect(screen.getByTestId('dingtalk-client-id-input')).toHaveValue('client-id-entered-after-request');
  });

  it('clears the submitted plaintext after save, ignores the returned mask, and tests with saved credentials', async () => {
    let statusRequests = 0;
    mockHanaFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/api/bridge/status?agentId=hana') {
        statusRequests += 1;
        return Promise.resolve(new Response(JSON.stringify(bridgeStatus())));
      }
      if (url === '/api/bridge/config?agentId=hana') {
        expect(opts).toMatchObject({
          method: 'POST',
          body: JSON.stringify({
            platform: 'telegram',
            credentials: { token: 'full-secret-from-clipboard' },
          }),
        });
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
      if (url === '/api/bridge/test?agentId=hana') {
        expect(opts).toMatchObject({
          method: 'POST',
          body: JSON.stringify({
            platform: 'telegram',
            credentials: {},
            useSavedCredentials: true,
          }),
        });
        return Promise.resolve(new Response(JSON.stringify({ ok: true, info: { username: 'hana_bot' } })));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<TelegramSecretProbe />);
    fireEvent.change(screen.getByTestId('telegram-secret-input'), {
      target: { value: 'full-secret-from-clipboard' },
    });
    fireEvent.blur(screen.getByTestId('telegram-secret-input'));

    await waitFor(() => {
      expect(screen.getByTestId('telegram-secret-input')).toHaveValue('');
      expect(screen.getByTestId('telegram-secret-stored')).toHaveTextContent('true');
    });
    expect(statusRequests).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('telegram-secret-input')).not.toHaveValue('********');

    fireEvent.click(screen.getByRole('button', { name: 'test saved' }));
    await waitFor(() => {
      expect(mockState.showToast).toHaveBeenCalledWith('settings.bridge.testOk @hana_bot', 'success');
    });
  });

  it('marks a stored secret absent after an explicit empty submission succeeds', async () => {
    let statusRequests = 0;
    mockHanaFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/api/bridge/status?agentId=hana') {
        statusRequests += 1;
        return Promise.resolve(new Response(JSON.stringify(bridgeStatus({
          telegram: statusRequests === 1
            ? { enabled: false, status: 'disconnected', token: '********', hasToken: true }
            : { enabled: false, status: 'disconnected', token: '', hasToken: false },
        }))));
      }
      if (url === '/api/bridge/config?agentId=hana') {
        expect(opts).toMatchObject({
          method: 'POST',
          body: JSON.stringify({
            platform: 'telegram',
            credentials: { token: '' },
          }),
        });
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<TelegramSecretProbe />);
    await waitFor(() => {
      expect(screen.getByTestId('telegram-secret-stored')).toHaveTextContent('true');
    });
    fireEvent.click(screen.getByRole('button', { name: 'clear saved' }));

    await waitFor(() => {
      expect(screen.getByTestId('telegram-secret-stored')).toHaveTextContent('false');
      expect(screen.getByTestId('telegram-secret-dirty')).toHaveTextContent('false');
    });
  });

  it('keeps connection-test state and results owned by the Agent and request generation', async () => {
    let resolveHanaTest!: (response: Response) => void;
    let resolveMioTest!: (response: Response) => void;
    mockHanaFetch.mockImplementation((url: string) => {
      if (url.startsWith('/api/bridge/status?agentId=')) return new Promise<Response>(() => {});
      if (url === '/api/agents/mio/public-agents-md') return new Promise<Response>(() => {});
      if (url === '/api/bridge/test?agentId=hana') {
        return new Promise<Response>((resolve) => { resolveHanaTest = resolve; });
      }
      if (url === '/api/bridge/test?agentId=mio') {
        return new Promise<Response>((resolve) => { resolveMioTest = resolve; });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<BridgeTestOwnershipProbe />);
    fireEvent.click(screen.getByRole('button', { name: 'test current agent' }));
    expect(screen.getByTestId('testing-platform')).toHaveTextContent('telegram');

    fireEvent.click(screen.getByRole('button', { name: 'test probe switch to mio' }));
    expect(screen.getByTestId('test-owner')).toHaveTextContent('mio');
    expect(screen.getByTestId('testing-platform')).toHaveTextContent('none');

    fireEvent.click(screen.getByRole('button', { name: 'test current agent' }));
    expect(screen.getByTestId('testing-platform')).toHaveTextContent('telegram');

    await act(async () => {
      resolveHanaTest(new Response(JSON.stringify({
        ok: true,
        info: { username: 'old_hana_bot' },
      })));
    });

    expect(mockState.showToast).not.toHaveBeenCalled();
    expect(screen.getByTestId('testing-platform')).toHaveTextContent('telegram');

    await act(async () => {
      resolveMioTest(new Response(JSON.stringify({
        ok: true,
        info: { username: 'mio_bot' },
      })));
    });

    expect(mockState.showToast).toHaveBeenCalledOnce();
    expect(mockState.showToast).toHaveBeenCalledWith(
      'settings.bridge.testOk @mio_bot',
      'success',
    );
    expect(screen.getByTestId('testing-platform')).toHaveTextContent('none');
  });

  it('does not clear a newer secret revision when an earlier save finishes', async () => {
    let resolveSave!: (response: Response) => void;
    mockHanaFetch.mockImplementation((url: string) => {
      if (url === '/api/bridge/status?agentId=hana') {
        return Promise.resolve(new Response(JSON.stringify(bridgeStatus())));
      }
      if (url === '/api/bridge/config?agentId=hana') {
        return new Promise<Response>((resolve) => { resolveSave = resolve; });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<TelegramSecretProbe />);
    fireEvent.change(screen.getByTestId('telegram-secret-input'), { target: { value: 'first-secret' } });
    fireEvent.blur(screen.getByTestId('telegram-secret-input'));
    fireEvent.change(screen.getByTestId('telegram-secret-input'), { target: { value: 'newer-secret' } });

    await act(async () => {
      resolveSave(new Response(JSON.stringify({ ok: true })));
    });

    await waitFor(() => {
      expect(screen.getByTestId('telegram-secret-input')).toHaveValue('newer-secret');
    });
    expect(screen.getByTestId('telegram-secret-dirty')).toHaveTextContent('true');
    expect(screen.getByTestId('telegram-secret-revision')).toHaveTextContent('2');
  });

  it('does not reuse a revision after switching away and back while a save is in flight', async () => {
    let resolveSave!: (response: Response) => void;
    mockHanaFetch.mockImplementation((url: string) => {
      if (url.startsWith('/api/bridge/status?agentId=')) return new Promise<Response>(() => {});
      if (url === '/api/agents/mio/public-agents-md') return new Promise<Response>(() => {});
      if (url === '/api/bridge/config?agentId=hana') {
        return new Promise<Response>((resolve) => { resolveSave = resolve; });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<TelegramSecretProbe />);
    fireEvent.change(screen.getByTestId('telegram-secret-input'), { target: { value: 'old-hana-secret' } });
    fireEvent.blur(screen.getByTestId('telegram-secret-input'));
    fireEvent.click(screen.getByRole('button', { name: 'switch to mio' }));
    fireEvent.click(screen.getByRole('button', { name: 'switch to hana' }));
    fireEvent.change(screen.getByTestId('telegram-secret-input'), { target: { value: 'new-hana-secret' } });

    await act(async () => {
      resolveSave(new Response(JSON.stringify({ ok: true })));
    });

    await waitFor(() => {
      expect(screen.getByTestId('telegram-secret-input')).toHaveValue('new-hana-secret');
    });
    expect(screen.getByTestId('telegram-secret-revision')).toHaveTextContent('2');
    expect(screen.getByTestId('telegram-secret-dirty')).toHaveTextContent('true');
  });

  it('ignores an older same-Agent status response after a newer refresh wins', async () => {
    const statusResolvers: Array<(response: Response) => void> = [];
    mockHanaFetch.mockImplementation((url: string) => {
      if (url === '/api/bridge/status?agentId=hana') {
        return new Promise<Response>((resolve) => { statusResolvers.push(resolve); });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<BridgeProbe />);
    fireEvent.click(screen.getByRole('button', { name: 'reload status' }));
    expect(statusResolvers).toHaveLength(2);

    await act(async () => {
      statusResolvers[1](new Response(JSON.stringify(bridgeStatus({
        telegram: { enabled: true, status: 'connected', token: '********', hasToken: true },
      }))));
    });
    await act(async () => {
      statusResolvers[0](new Response(JSON.stringify(bridgeStatus({
        telegram: { enabled: false, status: 'disconnected', token: '', hasToken: false },
      }))));
    });

    expect(screen.getByTestId('telegram-enabled')).toHaveTextContent('true');
    expect(screen.getByTestId('telegram-token-stored')).toHaveTextContent('true');
  });

  it('does not replay an unchanged stale snapshot after a live status wins', async () => {
    const staleBridgeStatus = bridgeStatus({
      telegram: { enabled: false, status: 'disconnected', token: '', hasToken: false },
    });
    mockState.settingsSnapshot.data.bridgeStatus = staleBridgeStatus;
    mockHanaFetch.mockImplementation((url: string) => {
      if (url === '/api/bridge/status?agentId=hana') {
        return Promise.resolve(new Response(JSON.stringify(bridgeStatus({
          telegram: { enabled: true, status: 'connected', token: '********', hasToken: true },
        }))));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const view = render(<BridgeProbe />);
    await waitFor(() => {
      expect(screen.getByTestId('telegram-enabled')).toHaveTextContent('true');
      expect(screen.getByTestId('telegram-token-stored')).toHaveTextContent('true');
    });

    mockState.settingsSnapshot.data = {
      ...mockState.settingsSnapshot.data,
      publicAgents: 'locally updated agents md',
      bridgeStatus: staleBridgeStatus,
    };
    view.rerender(<BridgeProbe />);

    expect(screen.getByTestId('telegram-enabled')).toHaveTextContent('true');
    expect(screen.getByTestId('telegram-token-stored')).toHaveTextContent('true');
  });

  it('hides the previous Agent status in the same render that changes selection', () => {
    mockHanaFetch.mockImplementation((url: string) => {
      if (url.startsWith('/api/bridge/status?agentId=')) return new Promise<Response>(() => {});
      if (url === '/api/agents/mio/public-agents-md') return new Promise<Response>(() => {});
      throw new Error(`unexpected request: ${url}`);
    });

    render(<BridgeProbe />);
    expect(screen.getByTestId('telegram-enabled')).toHaveTextContent('true');

    fireEvent.click(screen.getByRole('button', { name: 'bridge probe switch to mio' }));

    expect(screen.getByTestId('selected-agent')).toHaveTextContent('mio');
    expect(screen.getByTestId('telegram-enabled')).toHaveTextContent('undefined');
  });

  it('describes a DingTalk token-only success without claiming the Stream is connected', async () => {
    mockHanaFetch.mockImplementation((url: string) => {
      if (url === '/api/bridge/status?agentId=hana') {
        return new Promise<Response>(() => {});
      }
      if (url === '/api/bridge/test?agentId=hana') {
        return Promise.resolve(new Response(JSON.stringify({
          ok: true,
          info: { credentialOk: true, stream: { status: 'not_tested' } },
        })));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<DingTalkTestProbe />);
    fireEvent.click(screen.getByRole('button', { name: 'test dingtalk credentials' }));

    await waitFor(() => {
      expect(mockState.showToast).toHaveBeenCalledWith(
        'settings.bridge.dingtalkCredentialTestOk',
        'success',
      );
    });
    expect(mockState.showToast).not.toHaveBeenCalledWith('settings.bridge.testOk', 'success');
  });

  it('drops plaintext drafts when the selected Agent changes', async () => {
    mockHanaFetch.mockImplementation((url: string) => {
      if (url.startsWith('/api/bridge/status?agentId=')) return new Promise<Response>(() => {});
      if (url === '/api/agents/mio/public-agents-md') return new Promise<Response>(() => {});
      throw new Error(`unexpected request: ${url}`);
    });

    render(<TelegramSecretProbe />);
    fireEvent.change(screen.getByTestId('telegram-secret-input'), { target: { value: 'hana-only-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'switch to mio' }));

    await waitFor(() => {
      expect(screen.getByTestId('telegram-secret-owner')).toHaveTextContent('mio');
      expect(screen.getByTestId('telegram-secret-input')).toHaveValue('');
    });
    expect(screen.getByTestId('telegram-secret-dirty')).toHaveTextContent('false');
    expect(screen.getByTestId('telegram-secret-stored')).toHaveTextContent('false');
  });
});
