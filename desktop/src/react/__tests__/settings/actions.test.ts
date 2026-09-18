/**
 * @vitest-environment jsdom
 *
 * 注意：这个文件把 settings/api 整个 mock 掉了，假的 hanaFetch 不带 status 语义
 * ——它对任何响应都直接把 body 交给调用方，而真的 hanaFetch 会在非 2xx 时先抛出
 * 带错误码的异常。所以这里适合测加载编排（竞态、abort、状态清理），**不适合**测
 * 错误路径：在这儿写的错误用例锁的是假契约，产线上根本不会那样跑（已经发生过一次）。
 * 错误呈现的用例一律写进 switch-agent-error-boundary.test.ts，那边只 stub 全局
 * fetch，让请求走真实边界。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockState = Record<string, any>;

const mockState: MockState = {};

vi.mock('../../settings/store', () => ({
  useSettingsStore: {
    getState: () => mockState,
    setState: (patch: MockState | ((s: MockState) => MockState)) => {
      const next = typeof patch === 'function' ? patch(mockState) : patch;
      Object.assign(mockState, next);
    },
  },
}));

const mockFetch = vi.fn();

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mockFetch(...args),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

function jsonResponse(body: unknown) {
  return { json: async () => body } as Response;
}

function resetState() {
  Object.keys(mockState).forEach((key) => delete mockState[key]);
  Object.assign(mockState, {
    currentAgentId: 'agent-a',
    settingsAgentId: null,
    activeServerConnectionId: null,
    settingsConfig: null,
    settingsConfigKey: null,
    settingsConfigStatus: 'idle',
    settingsConfigError: null,
    settingsSnapshot: {
      key: null,
      status: 'idle',
      data: null,
      error: null,
      requestId: 0,
      updatedAt: null,
    },
    globalModelsConfig: null,
    homeFolder: null,
    currentPins: [],
    pluginSettingsStatus: 'idle',
    pluginSettingsError: null,
    pluginAllowFullAccess: undefined,
    pluginDevToolsEnabled: undefined,
    pluginUserDir: '',
    set: vi.fn((patch: Record<string, unknown>) => Object.assign(mockState, patch)),
    getSettingsAgentId: () => mockState.settingsAgentId || mockState.currentAgentId,
    showToast: vi.fn(),
  });
}

function buildPayload(agentId: string, endpoint: string) {
  switch (endpoint) {
    case 'config':
      return { agent: { id: agentId, name: `${agentId}-name` }, desk: { home_folder: `/${agentId}/home` } };
    case 'identity':
      return { content: `${agentId}-identity` };
    case 'agents-md':
      return { content: `${agentId}-agents-md` };
    case 'public-agents-md':
      return { content: `${agentId}-public-agents-md` };
    case 'pinned':
      return { pins: [`${agentId}-pin`] };
    case 'experience':
      return { content: `${agentId}-experience` };
    case 'user-profile':
      return { content: 'user-profile' };
    case 'models':
      return { models: { chat: { id: `${agentId}-chat`, provider: 'openai' } } };
    default:
      throw new Error(`unexpected endpoint: ${endpoint}`);
  }
}

function parseEndpoint(path: string): { agentId: string; endpoint: string } {
  if (path === '/api/user-profile') return { agentId: 'user', endpoint: 'user-profile' };
  if (path === '/api/preferences/models') return { agentId: 'global', endpoint: 'models' };
  const match = path.match(/^\/api\/agents\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`unexpected path: ${path}`);
  return { agentId: decodeURIComponent(match[1]), endpoint: match[2] };
}

describe('settings actions', () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    resetState();
    (window as any).platform = { settingsChanged: vi.fn() };
  });

  it('旧的 loadSettingsConfig 响应晚到时，不覆盖新的 settings pane', async () => {
    const deferredA = new Map<string, (value: Response) => void>();
    mockFetch.mockImplementation((path: string) => {
      const { agentId, endpoint } = parseEndpoint(path);
      if (agentId === 'agent-a') {
        return new Promise<Response>((resolve) => {
          deferredA.set(endpoint, resolve);
        });
      }
      if (agentId === 'agent-b') {
        return Promise.resolve(jsonResponse(buildPayload(agentId, endpoint)));
      }
      if (agentId === 'user') return Promise.resolve(jsonResponse(buildPayload('user', endpoint)));
      if (agentId === 'global') return Promise.resolve(jsonResponse(buildPayload('agent-b', endpoint)));
      throw new Error(`unexpected agent: ${agentId}`);
    });

    const { loadSettingsConfig } = await import('../../settings/actions');

    mockState.settingsAgentId = 'agent-a';
    const first = loadSettingsConfig();
    expect(mockState.settingsConfigKey).toBe('local:config:agent-a');
    expect(mockState.settingsConfigStatus).toBe('loading');

    mockState.settingsAgentId = 'agent-b';
    await loadSettingsConfig();

    expect(mockState.settingsConfigKey).toBe('local:config:agent-b');
    expect(mockState.settingsConfigStatus).toBe('ready');
    expect(mockState.settingsConfig.agent.name).toBe('agent-b-name');
    expect(mockState.currentPins).toEqual(['agent-b-pin']);
    expect(mockState.homeFolder).toBe('/agent-b/home');

    for (const [endpoint, resolve] of deferredA.entries()) {
      resolve(jsonResponse(buildPayload('agent-a', endpoint)));
    }
    await first;

    expect(mockState.settingsConfig.agent.name).toBe('agent-b-name');
    expect(mockState.currentPins).toEqual(['agent-b-pin']);
    expect(mockState.homeFolder).toBe('/agent-b/home');
  });

  it('切换 settings owner 时会先清掉旧配置，避免新页面显示旧开关状态', async () => {
    mockFetch.mockImplementation((path: string) => {
      const { agentId, endpoint } = parseEndpoint(path);
      return Promise.resolve(jsonResponse(buildPayload(agentId, endpoint)));
    });

    const { loadSettingsConfig } = await import('../../settings/actions');

    mockState.settingsAgentId = 'agent-a';
    await loadSettingsConfig();
    expect(mockState.settingsConfig.agent.name).toBe('agent-a-name');
    expect(mockState.settingsConfigStatus).toBe('ready');

    const deferred = new Map<string, (value: Response) => void>();
    mockFetch.mockImplementation((path: string) => {
      const { agentId, endpoint } = parseEndpoint(path);
      if (agentId === 'agent-b') {
        return new Promise<Response>((resolve) => {
          deferred.set(endpoint, resolve);
        });
      }
      if (agentId === 'user') return Promise.resolve(jsonResponse(buildPayload('user', endpoint)));
      if (agentId === 'global') return Promise.resolve(jsonResponse(buildPayload('agent-b', endpoint)));
      throw new Error(`unexpected agent: ${agentId}`);
    });

    mockState.settingsAgentId = 'agent-b';
    const second = loadSettingsConfig();

    expect(mockState.settingsConfigKey).toBe('local:config:agent-b');
    expect(mockState.settingsConfigStatus).toBe('loading');
    expect(mockState.settingsConfig).toBeNull();
    expect(mockState.globalModelsConfig).toBeNull();
    expect(mockState.currentPins).toEqual([]);

    for (const [endpoint, resolve] of deferred.entries()) {
      resolve(jsonResponse(buildPayload('agent-b', endpoint)));
    }
    await second;

    expect(mockState.settingsConfigStatus).toBe('ready');
    expect(mockState.settingsConfig.agent.name).toBe('agent-b-name');
  });

  it('新请求会 abort 旧的 loadSettingsConfig，且 abort 不记成加载错误', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockImplementation((path: string, opts?: { signal?: AbortSignal }) => {
      const { agentId, endpoint } = parseEndpoint(path);
      if (agentId === 'agent-a') {
        return new Promise<Response>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            (err as Error & { name: string }).name = 'AbortError';
            reject(err);
          }, { once: true });
        });
      }
      if (agentId === 'agent-b') {
        return Promise.resolve(jsonResponse(buildPayload(agentId, endpoint)));
      }
      if (agentId === 'user') return Promise.resolve(jsonResponse(buildPayload('user', endpoint)));
      if (agentId === 'global') return Promise.resolve(jsonResponse(buildPayload('agent-b', endpoint)));
      throw new Error(`unexpected agent: ${agentId}`);
    });

    const { loadSettingsConfig } = await import('../../settings/actions');

    mockState.settingsAgentId = 'agent-a';
    const first = loadSettingsConfig();

    mockState.settingsAgentId = 'agent-b';
    await loadSettingsConfig();
    await first;

    expect(mockState.settingsConfig.agent.name).toBe('agent-b-name');
    expect(consoleSpy).not.toHaveBeenCalledWith(
      '[settings] load failed:',
      expect.objectContaining({ name: 'AbortError' }),
    );
  });

  it('loadSettingsSnapshot hydrates config, preferences, and plugin settings from one backend truth source', async () => {
    mockFetch.mockImplementation((path: string) => {
      if (path === '/api/settings/snapshot?agentId=agent-a') {
        return Promise.resolve(jsonResponse({
          agentId: 'agent-a',
          config: {
            agent: { id: 'agent-a', name: 'Agent A' },
            desk: { home_folder: '/agent-a/home' },
          },
          identity: 'agent-a-identity',
          agents: 'agent-a-agents-md',
          publicAgents: 'agent-a-public',
          userProfile: 'user-profile',
          experience: 'agent-a-experience',
          pinned: { pins: ['agent-a-pin'] },
          globalModels: { models: { utility: { id: 'u' }, utility_large: { id: 'ul' } } },
          preferences: {
            quickChat: { shortcut: 'CommandOrControl+Shift+K', reuseTimeoutMinutes: 12 },
            notifications: {
              chatCompletion: 'when_session_unfocused',
              scheduledTaskCompletion: 'always',
              patrolCompletion: 'when_unfocused',
            },
            bridge: { permissionMode: 'operate', readOnly: false, receiptEnabled: true },
            speechRecognition: { enabled: true, defaultModel: { provider: 'dashscope', id: 'qwen3-asr' } },
            experiments: [{ id: 'provider.deepseek_roleplay_reasoning_patch', owner: 'provider', value: true }],
          },
          plugins: {
            allowFullAccess: true,
            devToolsEnabled: true,
            userDir: '/plugins',
            settingsTabs: [{ pluginId: 'demo', id: 'demo-settings', title: 'Demo', nativeComponent: 'DemoSettings' }],
          },
        }));
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const { loadSettingsSnapshot } = await import('../../settings/actions');

    await loadSettingsSnapshot();

    expect(mockState.settingsSnapshot.status).toBe('ready');
    expect(mockState.settingsConfig).toMatchObject({
      agent: { name: 'Agent A' },
      _identity: 'agent-a-identity',
      _agents: 'agent-a-agents-md',
      _publicAgents: 'agent-a-public',
      _userProfile: 'user-profile',
      _experience: 'agent-a-experience',
    });
    expect(mockState.globalModelsConfig.models.utility.id).toBe('u');
    expect(mockState.homeFolder).toBe('/agent-a/home');
    expect(mockState.currentPins).toEqual(['agent-a-pin']);
    expect(mockState.pluginSettingsStatus).toBe('ready');
    expect(mockState.pluginAllowFullAccess).toBe(true);
    expect(mockState.pluginDevToolsEnabled).toBe(true);
  });

  it('clears same-owner stale snapshot data while a fresh settings snapshot is loading', async () => {
    let resolveSnapshot: (value: Response) => void = () => {};
    mockState.settingsConfigKey = 'local:config:agent-a';
    mockState.settingsConfigStatus = 'ready';
    mockState.settingsConfig = { agent: { id: 'agent-a', name: 'Stale Agent' }, keep_awake: false };
    mockState.globalModelsConfig = { models: { utility: { id: 'old-u' } } };
    mockState.homeFolder = '/old/home';
    mockState.currentPins = ['old-pin'];
    mockState.pluginSettingsStatus = 'ready';
    mockState.pluginAllowFullAccess = false;
    mockState.pluginDevToolsEnabled = false;
    mockState.pluginUserDir = '/old/plugins';
    mockState.settingsSnapshot = {
      key: 'local:snapshot:agent-a',
      status: 'ready',
      data: {
        agentId: 'agent-a',
        config: { agent: { id: 'agent-a', name: 'Stale Agent' }, keep_awake: false },
        identity: 'old-identity',
        agents: '',
        publicAgents: '',
        userProfile: '',
        experience: '',
        pinned: { pins: ['old-pin'] },
        globalModels: { models: { utility: { id: 'old-u' } } },
        preferences: {
          quickChat: {},
          notifications: {},
          bridge: { permissionMode: 'auto', readOnly: false, receiptEnabled: true },
          speechRecognition: { enabled: false },
          experiments: [],
        },
        plugins: {
          allowFullAccess: false,
          devToolsEnabled: false,
          userDir: '/old/plugins',
          settingsTabs: [{ pluginId: 'old', id: 'old-tab', title: 'Old', nativeComponent: 'OldSettings' }],
        },
        access: { network: { mode: 'loopback' } },
        bridgeStatus: { agentId: 'agent-a', telegram: { enabled: false } },
      },
      error: null,
      requestId: 3,
      updatedAt: Date.now(),
    };
    mockFetch.mockImplementation((path: string) => {
      if (path === '/api/settings/snapshot?agentId=agent-a') {
        return new Promise<Response>((resolve) => {
          resolveSnapshot = resolve;
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const { loadSettingsSnapshot } = await import('../../settings/actions');

    const pending = loadSettingsSnapshot();

    expect(mockState.settingsSnapshot).toMatchObject({
      key: 'local:snapshot:agent-a',
      status: 'loading',
      data: null,
    });
    expect(mockState.settingsConfig).toBeNull();
    expect(mockState.globalModelsConfig).toBeNull();
    expect(mockState.currentPins).toEqual([]);
    expect(mockState.pluginAllowFullAccess).toBeUndefined();
    expect(mockState.pluginDevToolsEnabled).toBeUndefined();

    resolveSnapshot(jsonResponse({
      agentId: 'agent-a',
      config: { agent: { id: 'agent-a', name: 'Fresh Agent' }, keep_awake: true },
      identity: 'fresh-identity',
      agents: '',
      publicAgents: '',
      userProfile: '',
      experience: '',
      pinned: { pins: ['fresh-pin'] },
      globalModels: { models: { utility: { id: 'new-u' } } },
      preferences: {
        quickChat: {},
        notifications: {},
        bridge: { permissionMode: 'operate', readOnly: false, receiptEnabled: true },
        speechRecognition: { enabled: true },
        experiments: [],
      },
      plugins: {
        allowFullAccess: true,
        devToolsEnabled: true,
        userDir: '/fresh/plugins',
        settingsTabs: [],
      },
      access: { network: { mode: 'lan' } },
      bridgeStatus: { agentId: 'agent-a', telegram: { enabled: true } },
    }));
    await pending;

    expect(mockState.settingsConfig.agent.name).toBe('Fresh Agent');
    expect(mockState.settingsSnapshot.data.access.network.mode).toBe('lan');
    expect(mockState.pluginAllowFullAccess).toBe(true);
  });

  it('setPrimaryAgent updates only primary ownership and keeps the current focus', async () => {
    mockFetch.mockImplementation((path: string, opts?: RequestInit) => {
      if (path === '/api/agents/primary') {
        expect(opts).toMatchObject({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'agent-b' }),
        });
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (path === '/api/agents') {
        return Promise.resolve(jsonResponse({
          agents: [
            { id: 'agent-a', name: 'Agent A', yuan: 'hanako', isPrimary: false },
            { id: 'agent-b', name: 'Agent B', yuan: 'ming', isPrimary: true },
          ],
        }));
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const { setPrimaryAgent } = await import('../../settings/actions');

    await setPrimaryAgent('agent-b');

    expect(mockState.currentAgentId).toBe('agent-a');
    expect(mockState.agentName).toBe('Agent A');
    expect(mockState.agents.find((agent: any) => agent.id === 'agent-b')?.isPrimary).toBe(true);
  });
});
