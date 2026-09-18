import { describe, expect, it, vi } from 'vitest';
import {
  createOnboardingVerificationPlan,
  resolveOnboardingAgentId,
  saveLocale,
  saveModel,
  saveOnboardingIdentity,
  saveProvider,
  saveWorkspace,
  selectOnboardingAgentId,
  verifyOnboardingPersistence,
} from '../onboarding-actions';
import type { HanaFetch } from '../onboarding-actions';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('onboarding agent resolution', () => {
  it('uses the renamed primary agent instead of a hardcoded hanako id', async () => {
    const hanaFetch = vi.fn<HanaFetch>(async path => {
      if (path === '/api/agents?fresh=1') {
        return jsonResponse({
          agents: [
            { id: 'secondary', isCurrent: true },
            { id: 'renamed-primary', isPrimary: true },
          ],
        });
      }
      return jsonResponse({ ok: true });
    });

    const agentId = await resolveOnboardingAgentId(hanaFetch);
    await saveOnboardingIdentity({
      hanaFetch,
      agentId,
      userName: '测试用户',
      agentName: '新名字',
      memoryEnabled: true,
    });

    expect(agentId).toBe('renamed-primary');
    expect(hanaFetch).toHaveBeenLastCalledWith('/api/agents/renamed-primary/config', expect.objectContaining({
      method: 'PUT',
    }));
  });

  it('falls back to a unique current agent and then to the only valid agent', () => {
    expect(selectOnboardingAgentId([
      { id: 'agent-a' },
      { id: 'agent-b', isCurrent: true },
    ])).toBe('agent-b');
    expect(selectOnboardingAgentId([{ id: 'only-agent' }])).toBe('only-agent');
  });

  it('rejects an ambiguous list instead of guessing from list order', () => {
    expect(() => selectOnboardingAgentId([
      { id: 'agent-a' },
      { id: 'agent-b' },
    ])).toThrow('ambiguous');
  });
});

describe('onboarding saveModel', () => {
  it('persists only models the user explicitly added to the provider', async () => {
    const hanaFetch = vi.fn<HanaFetch>(async () => jsonResponse({ ok: true }));

    await saveModel({
      hanaFetch,
      agentId: 'hana-primary',
      providerName: 'deepseek',
      selectedModel: 'deepseek-v4-pro',
      selectedUtility: 'deepseek-v4-flash',
      selectedUtilityLarge: 'deepseek-v4-pro',
      addedModels: [
        'deepseek-v4-flash',
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', audio: true },
      ],
      fetchedModels: [
        { id: 'deepseek-v4-flash' },
        { id: 'deepseek-v4-pro' },
        { id: 'deepseek-v4-unused' },
      ],
    } as Parameters<typeof saveModel>[0] & {
      addedModels: Array<string | { id: string; name?: string }>;
    });

    const providerSaveCall = hanaFetch.mock.calls.find(([path, options]) => {
      const body = JSON.parse(String(options?.body));
      return path === '/api/agents/hana-primary/config' && body.providers;
    });

    expect(providerSaveCall).toBeTruthy();
    const body = JSON.parse(String(providerSaveCall?.[1]?.body));
    expect(body.providers.deepseek.models).toEqual([
      'deepseek-v4-flash',
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', audio: true },
    ]);
  });
});

describe('onboarding saveOnboardingIdentity', () => {
  it('persists user name, optional agent name, and the memory master switch together', async () => {
    const hanaFetch = vi.fn<HanaFetch>(async () => jsonResponse({ ok: true }));

    await saveOnboardingIdentity({
      hanaFetch,
      agentId: 'hana-primary',
      userName: '  测试用户  ',
      agentName: '  小花  ',
      memoryEnabled: true,
    });

    expect(hanaFetch).toHaveBeenCalledWith('/api/agents/hana-primary/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: { name: '测试用户' },
        agent: { name: '小花' },
        memory: { enabled: true },
      }),
    });
  });

  it('keeps the current agent name when the agent name input is left blank', async () => {
    const hanaFetch = vi.fn<HanaFetch>(async () => jsonResponse({ ok: true }));

    await saveOnboardingIdentity({
      hanaFetch,
      agentId: 'hana-primary',
      userName: '测试用户',
      agentName: '   ',
      memoryEnabled: false,
    });

    const body = JSON.parse(String(hanaFetch.mock.calls[0][1]?.body));
    expect(body).toEqual({
      user: { name: '测试用户' },
      memory: { enabled: false },
    });
  });
});

describe('onboarding saveWorkspace', () => {
  it('creates the default workspace before saving the agent desk config', async () => {
    const hanaFetch = vi.fn<HanaFetch>(async () => jsonResponse({ ok: true }));

    await saveWorkspace({
      hanaFetch,
      agentId: 'hana-primary',
      workspacePath: '/Users/test/Desktop/OH-WorkSpace',
      defaultPath: '/Users/test/Desktop/OH-WorkSpace',
    });

    expect(hanaFetch).toHaveBeenNthCalledWith(1, '/api/config/default-workspace', {
      method: 'POST',
    });
    expect(hanaFetch).toHaveBeenNthCalledWith(2, '/api/agents/hana-primary/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        desk: {
          home_folder: '/Users/test/Desktop/OH-WorkSpace',
          heartbeat_enabled: false,
          heartbeat_interval: 31,
        },
      }),
    });
  });
});

describe('onboarding mutation failures', () => {
  it('rejects a non-2xx response with the server error instead of continuing', async () => {
    const hanaFetch = vi.fn<HanaFetch>(async () => jsonResponse({ error: 'settings were not written' }, 500));

    await expect(saveLocale(hanaFetch, 'hana-primary', 'zh-CN')).rejects.toThrow('settings were not written');
  });
});

describe('onboarding persistence verification', () => {
  it('reads back acknowledged provider settings without retaining the raw API key', async () => {
    const verificationPlan = createOnboardingVerificationPlan();
    const hanaFetch = vi.fn<HanaFetch>(async (path, options) => {
      if (path === '/api/agents/renamed-primary/config' && options?.method === 'PUT') {
        return jsonResponse({ ok: true });
      }
      if (path === '/api/agents/renamed-primary/config') {
        return jsonResponse({
          api: { provider: 'deepseek' },
          providers: {
            deepseek: {
              base_url: 'https://api.deepseek.com',
              api: 'openai-completions',
              api_key: '[redacted]',
            },
          },
        });
      }
      throw new Error(`unexpected path ${path}`);
    });

    await saveProvider({
      hanaFetch,
      agentId: 'renamed-primary',
      providerName: 'deepseek',
      providerUrl: 'https://api.deepseek.com',
      providerApi: 'openai-completions',
      apiKey: 'sk-secret-value',
      verificationPlan,
    });
    await verifyOnboardingPersistence({ hanaFetch, agentId: 'renamed-primary', verificationPlan });

    expect(JSON.stringify(verificationPlan)).not.toContain('sk-secret-value');
  });
});
