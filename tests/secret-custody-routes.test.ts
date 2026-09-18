import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MASKED_SECRET } from "../shared/secret-custody.ts";

function withPrincipal(app, principal) {
  app.use("*", async (c, next) => {
    c.set("authPrincipal", Object.freeze(principal));
    await next();
  });
}

function remotePrincipal(scopes) {
  return {
    kind: "device",
    credentialKind: "device_credential",
    connectionKind: "lan",
    scopes,
  };
}

describe("secret custody across HTTP routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("masks provider secrets in summary responses", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const engine = {
      providerRegistry: {
        getAllProvidersRaw: () => ({
          deepseek: {
            base_url: "https://api.deepseek.com",
            api: "openai-completions",
            api_key: "sk-provider-secret",
            headers: { Authorization: "Bearer gateway-secret" },
            models: ["deepseek-chat"],
          },
        }),
        get: () => ({ authType: "api-key", baseUrl: "", api: "openai-completions" }),
        isOAuth: () => false,
        getAuthType: () => "api-key",
        allowsMissingApiKey: () => false,
        getAuthJsonKey: (id) => id,
        getOAuthProviderIds: () => [],
        getAll: () => new Map(),
      },
      preferences: { getOAuthCustomModels: () => ({}) },
      hanakoHome: "/tmp",
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/summary");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.providers.deepseek.api_key).toBe(MASKED_SECRET);
    expect(body.providers.deepseek.headers.Authorization).toBe(MASKED_SECRET);
    expect(JSON.stringify(body)).not.toContain("sk-provider-secret");
    expect(JSON.stringify(body)).not.toContain("gateway-secret");
  });

  it("reveals a provider api key only through the explicit secret endpoint", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const engine = {
      providerRegistry: {
        getAllProvidersRaw: () => ({
          deepseek: {
            base_url: "https://api.deepseek.com",
            api: "openai-completions",
            api_key: "sk-provider-secret",
            models: ["deepseek-chat"],
          },
        }),
        get: () => ({ authType: "api-key", baseUrl: "", api: "openai-completions" }),
        isOAuth: () => false,
        getAuthType: () => "api-key",
        allowsMissingApiKey: () => false,
        getAuthJsonKey: (id) => id,
        getOAuthProviderIds: () => [],
        getAll: () => new Map(),
      },
      preferences: { getOAuthCustomModels: () => ({}) },
      resolveProviderCredentials: (name) => name === "deepseek"
        ? { api_key: "sk-provider-secret", base_url: "https://api.deepseek.com", api: "openai-completions" }
        : { api_key: "", base_url: "", api: "" },
      hanakoHome: "/tmp",
    };

    app.route("/api", createProvidersRoute(engine));

    const summaryRes = await app.request("/api/providers/summary");
    const summaryBody = await summaryRes.json();
    expect(summaryBody.providers.deepseek.api_key).toBe(MASKED_SECRET);

    const revealRes = await app.request("/api/providers/deepseek/api-key");
    const revealBody = await revealRes.json();
    expect(revealRes.status).toBe(200);
    expect(revealBody).toEqual({ api_key: "sk-provider-secret" });
  });

  it("requires secret scope before a remote provider api key can be revealed", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    withPrincipal(app, remotePrincipal(["providers.manage"]));
    const engine = {
      providerRegistry: {
        getAllProvidersRaw: () => ({}),
        get: () => null,
        isOAuth: () => false,
        getAuthType: () => "api-key",
        allowsMissingApiKey: () => false,
        getAuthJsonKey: (id) => id,
        getOAuthProviderIds: () => [],
        getAll: () => new Map(),
      },
      preferences: { getOAuthCustomModels: () => ({}) },
      resolveProviderCredentials: () => ({ api_key: "sk-provider-secret", base_url: "", api: "" }),
      hanakoHome: "/tmp",
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/deepseek/api-key");
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({
      error: "secret_read_scope_required",
      scope: "secrets.write",
    });
  });

  it("preserves saved provider secrets when a masked config patch is submitted", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    const saveProvider = vi.fn();
    const engine = {
      config: {},
      configPath: "/tmp/test-config.yaml",
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      emitEvent: vi.fn(),
      providerRegistry: {
        getAllProvidersRaw: () => ({
          deepseek: {
            base_url: "https://old.example/v1",
            api_key: "sk-saved-provider",
            headers: { Authorization: "Bearer saved-gateway" },
          },
        }),
        saveProvider,
      },
    };
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          deepseek: {
            base_url: "https://new.example/v1",
            api_key: MASKED_SECRET,
            headers: { Authorization: MASKED_SECRET, "X-Corp-Auth": "new-token" },
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveProvider).toHaveBeenCalledWith("deepseek", {
      base_url: "https://new.example/v1",
      api_key: "sk-saved-provider",
      headers: {
        Authorization: "Bearer saved-gateway",
        "X-Corp-Auth": "new-token",
      },
    });
  });

  it("masks global preference secrets and resolves masked updates back to saved values", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.ts");
    const setSearchConfig = vi.fn();
    const setUtilityApi = vi.fn();
    const engine = {
      getSharedModels: () => ({}),
      getSearchConfig: () => ({ provider: "tavily", api_key: "tvly-secret" }),
      getUtilityApi: () => ({ provider: "openai", base_url: "https://api.example/v1", api_key: "sk-utility" }),
      setSearchConfig,
      setUtilityApi,
      emitEvent: vi.fn(),
    };
    const app = new Hono();
    app.route("/api", createPreferencesRoute(engine));

    const readRes = await app.request("/api/preferences/models");
    const readBody = await readRes.json();
    expect(readBody.search.api_key).toBe(MASKED_SECRET);
    expect(readBody.utility_api.api_key).toBe(MASKED_SECRET);
    expect(JSON.stringify(readBody)).not.toContain("tvly-secret");
    expect(JSON.stringify(readBody)).not.toContain("sk-utility");

    const writeRes = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        search: { provider: "tavily", api_key: MASKED_SECRET },
        utility_api: { provider: "openai", base_url: "https://new.example/v1", api_key: MASKED_SECRET },
      }),
    });

    expect(writeRes.status).toBe(200);
    expect(setSearchConfig).toHaveBeenCalledWith({ provider: "tavily", api_key: "tvly-secret" });
    expect(setUtilityApi).toHaveBeenCalledWith({
      provider: "openai",
      base_url: "https://new.example/v1",
      api_key: "sk-utility",
    });
  });

  it("masks bridge secrets in status and preserves masked config updates", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const agent: any = {
      id: "hana",
      config: {
        bridge: {
          telegram: { token: "tg-secret", enabled: true },
          feishu: { appId: "cli-id", appSecret: "fs-secret" },
          dingtalk: {
            corpId: "corp-1",
            clientId: "dt-client",
            clientSecret: "dt-secret",
            robotCode: "ding-robot",
            restBaseUrl: "https://api.dingtalk.io/v1.0",
          },
          qq: { appID: "qq-id", appSecret: "qq-secret" },
          wechat: { botToken: "wx-secret" },
        },
      },
      updateConfig: vi.fn(),
    };
    const engine = {
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
      getBridgeIndex: () => ({}),
      getBridgeReadOnly: () => false,
      getBridgeReceiptEnabled: () => true,
    };
    const bridgeManager = {
      getStatus: () => ({}),
      stopPlatform: vi.fn(),
      startPlatformFromConfig: vi.fn(),
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, bridgeManager));

    const readRes = await app.request("/api/bridge/status?agentId=hana");
    const readBody = await readRes.json();

    expect(readBody.telegram.token).toBe(MASKED_SECRET);
    expect(readBody.telegram.hasToken).toBe(true);
    expect(readBody.feishu.appSecret).toBe(MASKED_SECRET);
    expect(readBody.feishu.hasAppSecret).toBe(true);
    expect(readBody.feishu.region).toBe("feishu_cn");
    expect(readBody.feishu.domain).toBe("https://open.feishu.cn");
    expect(readBody.dingtalk.clientSecret).toBe(MASKED_SECRET);
    expect(readBody.dingtalk.hasClientSecret).toBe(true);
    expect(readBody.dingtalk.corpId).toBe("corp-1");
    expect(readBody.dingtalk.clientId).toBe("dt-client");
    expect(readBody.dingtalk.robotCode).toBe("ding-robot");
    expect(readBody.dingtalk.apiBaseUrl).toBe("https://api.dingtalk.com/v1.0");
    expect(readBody.dingtalk.restBaseUrl).toBe("https://api.dingtalk.com/v1.0");
    expect(readBody.qq.appSecret).toBe(MASKED_SECRET);
    expect(readBody.qq.hasAppSecret).toBe(true);
    expect(readBody.wechat.token).toBe(MASKED_SECRET);
    expect(readBody.wechat.hasBotToken).toBe(true);
    expect(JSON.stringify(readBody)).not.toContain("tg-secret");
    expect(JSON.stringify(readBody)).not.toContain("fs-secret");
    expect(JSON.stringify(readBody)).not.toContain("dt-secret");
    expect(JSON.stringify(readBody)).not.toContain("qq-secret");
    expect(JSON.stringify(readBody)).not.toContain("wx-secret");

    const writeRes = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "telegram",
        credentials: { token: MASKED_SECRET },
        enabled: false,
      }),
    });

    expect(writeRes.status).toBe(410);
    expect(agent.updateConfig).not.toHaveBeenCalled();

    agent.updateConfig.mockClear();
    const feishuWriteRes = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "feishu",
        credentials: { appId: "cli-id", appSecret: MASKED_SECRET, region: "lark_global" },
        enabled: true,
      }),
    });

    expect(feishuWriteRes.status).toBe(200);
    expect(agent.updateConfig).toHaveBeenCalledWith({
      bridge: {
        feishu: { appId: "cli-id", appSecret: "fs-secret", region: "lark_global", enabled: true },
      },
    });

    agent.updateConfig.mockClear();

  });

  it("requires an explicit agent for useSavedCredentials", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/api", createBridgeRoute({ currentAgentId: "hana" }, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "feishu", useSavedCredentials: true }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/agentId is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let the explicit plaintext test mode recover a displayed mask", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/api", createBridgeRoute({ currentAgentId: null }, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "feishu",
        useSavedCredentials: false,
        credentials: {
          corpId: "corp-1",
          clientId: "client-1",
          appSecret: MASKED_SECRET,
          robotCode: "robot-1",
        },
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/useSavedCredentials=true/);
    expect(fetchMock).not.toHaveBeenCalled();

    const omittedModeRes = await app.request("/api/bridge/test?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "feishu",
        credentials: {
          corpId: "corp-1",
          clientId: "client-1",
          appSecret: MASKED_SECRET,
          robotCode: "robot-1",
        },
      }),
    });
    expect(omittedModeRes.status).toBe(400);
    expect((await omittedModeRes.json()).error).toMatch(/useSavedCredentials=true/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tests bridge plaintext credentials without requiring an existing saved agent config", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ code: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = {
      currentAgentId: null,
      getAgent: () => null,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "feishu",
        credentials: { appId: "cli-id", appSecret: "fs-plaintext", region: "lark_global" },
      }),
    });
    const body = await res.json();

    expect(body).toMatchObject({
      ok: true,
      info: {
        msg: expect.any(String),
        credentialOk: true,
        region: "lark_global",
        domain: "https://open.larksuite.com",
        eventDelivery: "long_connection",
        callbackUrlRequired: false,
        credentialVerification: {
          status: "tested",
          method: "tenant_access_token",
          endpoint: "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
        },
        longConnection: {
          status: "not_tested",
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
      expect.objectContaining({
        body: JSON.stringify({ app_id: "cli-id", app_secret: "fs-plaintext" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("returns structured Feishu credential diagnostics without implying webhook setup", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        code: 99991663,
        msg: "app not found",
        error: { log_id: "202605300001" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = {
      currentAgentId: null,
      getAgent: () => null,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "feishu",
        credentials: { appId: "cli-id", appSecret: "bad-secret" },
      }),
    });
    const body = await res.json();

    expect(body).toMatchObject({
      ok: false,
      error: "app not found",
      info: {
        credentialOk: false,
        region: "feishu_cn",
        domain: "https://open.feishu.cn",
        eventDelivery: "long_connection",
        callbackUrlRequired: false,
        httpStatus: 400,
        feishuCode: 99991663,
        feishuMessage: "app not found",
        logId: "202605300001",
      },
    });
  });

  it("rejects unsupported Feishu regions on config save", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const agent = {
      id: "hana",
      config: { bridge: { feishu: { appId: "cli-id", appSecret: "fs-secret" } } },
      updateConfig: vi.fn(),
    };
    const engine = {
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
      getBridgeIndex: () => ({}),
      getBridgeReadOnly: () => false,
      getBridgeReceiptEnabled: () => true,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "feishu",
        credentials: { appId: "cli-id", appSecret: "fs-secret", region: "unknown-region" },
        enabled: true,
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: expect.stringMatching(/unsupported Feishu region/) });
    expect(agent.updateConfig).not.toHaveBeenCalled();
  });

  it("resolves masked bridge test credentials from the explicit agent only", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ code: 0 }) });
    vi.stubGlobal("fetch", fetchMock);

    const agentA = {
      id: "agent-a",
      config: {
        bridge: {
          feishu: { appId: "app-a", appSecret: "secret-a" },
        },
      },
    };
    const agentB = {
      id: "agent-b",
      config: {
        bridge: {
          feishu: { appId: "app-b", appSecret: "secret-b" },
        },
      },
    };
    const engine = {
      currentAgentId: "agent-a",
      getAgent: (id) => ({ "agent-a": agentA, "agent-b": agentB }[id] || null),
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test?agentId=agent-b", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "feishu",
        useSavedCredentials: true,
        credentials: { appId: "app-b", appSecret: MASKED_SECRET },
      }),
    });
    const body = await res.json();

    expect(body).toMatchObject({ ok: true, info: { credentialOk: true } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      expect.objectContaining({
        body: JSON.stringify({ app_id: "app-b", app_secret: "secret-b" }),
      }),
    );
  });

  it("rejects masked bridge test credentials without an explicit agent id", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const agent = {
      id: "agent-a",
      config: {
        bridge: {
          feishu: { appId: "app-a", appSecret: "secret-a" },
        },
      },
    };
    const engine = {
      currentAgentId: "agent-a",
      getAgent: (id) => id === "agent-a" ? agent : null,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, { getStatus: () => ({}) }));

    const res = await app.request("/api/bridge/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "feishu",
        useSavedCredentials: true,
        credentials: { appId: "app-a", appSecret: MASKED_SECRET },
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("agentId is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
