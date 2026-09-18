/**
 * @vitest-environment jsdom
 *
 * 这组用例刻意不 mock settings/api：错误码要真的穿过 hanaFetch 那道边界才算数。
 * 上一版把 hanaFetch 换成了假的，于是"非 2xx 先抛裸 Error、body 连同 code 一起丢掉"
 * 这个真实行为被 mock 挡住了，测试全绿而产线上永远拿不到码。这里只 stub 全局 fetch，
 * 剩下的路径（hanaFetch → switchToAgent → toast）全部跑真的。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState: Record<string, any> = {};
const mockTranslations: Record<string, string> = {};

vi.mock('../../settings/store', () => ({
  useSettingsStore: {
    getState: () => mockState,
    setState: (patch: Record<string, any>) => Object.assign(mockState, patch),
  },
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => mockTranslations[key] ?? key,
}));

const AGENT_MODEL_UNAVAILABLE = '这个助手配置的模型当前不可用，去设置里给它换一个';

function resetState() {
  Object.keys(mockState).forEach((key) => delete mockState[key]);
  Object.keys(mockTranslations).forEach((key) => delete mockTranslations[key]);
  Object.assign(mockState, {
    // hanaFetch 用它算出真实的 baseUrl，没有连接就走不到 fetch。
    serverPort: '3210',
    serverToken: 'test-token',
    currentAgentId: 'agent-a',
    agentName: 'Agent A',
    settingsAgentId: null,
    activeServerConnectionId: null,
    set: vi.fn((patch: Record<string, unknown>) => Object.assign(mockState, patch)),
    getSettingsAgentId: () => mockState.settingsAgentId || mockState.currentAgentId,
    showToast: vi.fn(),
  });
}

/** 只给 /api/agents/switch 定制响应，其余请求一律回空对象（成功路径的后续加载不是本组关注点）。 */
function stubFetch(switchResponse: { status: number; body: unknown }) {
  const fetchMock = vi.fn(async (input: string) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/agents/switch') {
      return new Response(JSON.stringify(switchResponse.body), {
        status: switchResponse.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('switchToAgent over the real hanaFetch boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    resetState();
    // 每个用例都会打日志，统一在这里静音，afterEach 负责还原，
    // 不依赖各用例自己记得 restore（漏一个就会污染后面的用例）。
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // 清理放在用例之后：留到下一个 beforeEach 才清，意味着最后一个用例跑完后
    // 全局 fetch 仍是被替换的状态，会漏给同一进程里后跑的测试文件。
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('把服务端 409 带的错误码翻成本地化文案，而不是把英文原文糊到 toast 上', async () => {
    mockTranslations['error.code.agentModelNotAvailable'] = AGENT_MODEL_UNAVAILABLE;
    stubFetch({
      status: 409,
      body: {
        error: 'agent "agent-b" is configured with model "ghost-1" which is not available',
        code: 'agent_model_not_available',
      },
    });

    const { switchToAgent } = await import('../../settings/actions');
    await switchToAgent('agent-b');

    expect(mockState.showToast).toHaveBeenCalledWith(
      `settings.agent.switchFailed: ${AGENT_MODEL_UNAVAILABLE}`,
      'error',
    );
    // 切换失败不改焦点。
    expect(mockState.currentAgentId).toBe('agent-a');
  });

  it('遇到没有错误码的失败时保留服务端原文，不把排障线索换成通用兜底句', async () => {
    stubFetch({ status: 500, body: { error: 'ENOENT: agent config is unreadable' } });

    const { switchToAgent } = await import('../../settings/actions');
    await switchToAgent('agent-b');

    expect(mockState.showToast).toHaveBeenCalledWith(
      'settings.agent.switchFailed: ENOENT: agent config is unreadable',
      'error',
    );
  });

  it('服务端顶层错误处理器的嵌套形状同样翻得出人话，不把整段 JSON 糊到 toast 上', async () => {
    // 未被路由 catch 的异常会冒到 app.onError，那里回的是 {error:{code,message,traceId}}，
    // 跟路由自己应答的扁平形状不是一个形。只认扁平的话，这里会把整个 JSON 字符串
    // 当成"错误消息"显示出来，错误码也一并丢掉。
    mockTranslations['error.code.agentModelNotAvailable'] = AGENT_MODEL_UNAVAILABLE;
    stubFetch({
      status: 500,
      body: {
        error: {
          code: 'agent_model_not_available',
          message: 'agent "agent-b" is configured with model "ghost-1" which is not available',
          traceId: 'trace-123',
        },
      },
    });

    const { switchToAgent } = await import('../../settings/actions');
    await switchToAgent('agent-b');

    expect(mockState.showToast).toHaveBeenCalledWith(
      `settings.agent.switchFailed: ${AGENT_MODEL_UNAVAILABLE}`,
      'error',
    );
    const [[shown]] = mockState.showToast.mock.calls;
    expect(shown).not.toContain('traceId');
    expect(shown).not.toContain('{');
  });

  it('2xx 里带 error 信封、消息却是空串时退到错误码，不留下"切换失败: "这样的悬空冒号', async () => {
    // 200 配一个消息为空的 error 信封：非 2xx 那条路上 hanaFetch 总会兜一句
    // "status statusText"，永远不会空；真正可能空手抵达呈现层的是这一条。
    stubFetch({
      status: 200,
      body: { error: { code: 'session_busy', message: '', traceId: 'trace-9' } },
    });

    const { switchToAgent } = await import('../../settings/actions');
    await switchToAgent('agent-b');

    const [[shown]] = mockState.showToast.mock.calls;
    expect(shown).toBe('settings.agent.switchFailed: session_busy');
  });

  it('成功切换时更新焦点助手并报成功', async () => {
    stubFetch({
      status: 200,
      body: { ok: true, agent: { id: 'agent-b', name: 'Agent B' } },
    });

    const { switchToAgent } = await import('../../settings/actions');
    await switchToAgent('agent-b');

    expect(mockState.currentAgentId).toBe('agent-b');
    expect(mockState.agentName).toBe('Agent B');
    expect(mockState.settingsAgentId).toBeNull();
    expect(mockState.showToast).toHaveBeenCalledWith('settings.agent.switched', 'success');
  });
});
