import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const clearConfigCache = vi.fn();
const callText = vi.fn();
const probeProvider = vi.fn();

const saveConfig = vi.fn();

vi.mock("../lib/memory/config-loader.js", () => ({
  clearConfigCache,
  saveConfig,
  getRawConfig: () => ({}),
}));

/** Write a throwaway agent directory so the per-agent config route has a real file to read. */
const agentTempRoots: string[] = [];
function makeAgentDir(agentId: string, configYaml: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-model-sync-agents-"));
  agentTempRoots.push(root);
  const dir = path.join(root, agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), configYaml, "utf-8");
  return dir;
}

vi.mock("../core/llm-client.js", () => ({
  callText,
}));

vi.mock("../lib/llm/provider-client.js", async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  probeProvider,
}));

function expectAppEvent(emitEvent, type, payload) {
  expect(emitEvent).toHaveBeenCalledWith({
    type: "app_event",
    event: {
      type,
      payload,
      source: "server",
    },
  }, null);
}

/** 从 providerRegistry.getCredentials 构造 engine.resolveProviderCredentials（与 ModelManager 行为一致） */
function withResolveCreds(engine) {
  engine.resolveProviderCredentials = (provider) => {
    if (!provider) return { api_key: "", base_url: "", api: "" };
    const cred = engine.providerRegistry?.getCredentials?.(provider);
    if (cred) return { api_key: cred.apiKey || "", base_url: cred.baseUrl || "", api: cred.api || "", headers: cred.headers || {} };
    return { api_key: "", base_url: "", api: "" };
  };
  engine.resolveProviderCredentialsFresh ||= vi.fn(async (provider) => engine.resolveProviderCredentials(provider));
  return engine;
}

describe("model sync related routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    while (agentTempRoots.length) {
      fs.rmSync(agentTempRoots.pop() as string, { recursive: true, force: true });
    }
  });

  it("provider-only config updates trigger model registry sync", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    const app = new Hono();
    const saveProvider = vi.fn();
    const reload = vi.fn();
    const engine = {
      config: {},
      currentAgentId: "hana",
      setHomeFolder: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      providerRegistry: { saveProvider, removeProvider: vi.fn(), reload },
      emitEvent: vi.fn(),
    };

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          dashscope: {
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            api: "openai-completions",
            api_key: "sk-test",
            models: ["qwen-plus"],
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveProvider).toHaveBeenCalledTimes(1);
    expect(saveProvider).toHaveBeenCalledWith("dashscope", {
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      api: "openai-completions",
      api_key: "sk-test",
      models: ["qwen-plus"],
    });
    expect(clearConfigCache).toHaveBeenCalledTimes(1);
    expect(engine.updateConfig).toHaveBeenCalledWith({});
    expect(engine.onProviderChanged).toHaveBeenCalledTimes(1);
    // The provider catalog is global: every agent's model list changes, so the
    // event names no agent rather than naming whichever one was focused.
    expectAppEvent(engine.emitEvent, "models-changed", { agentId: null });
  });

  it("provider-only config updates return an error and emit no event when provider refresh fails", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    const app = new Hono();
    const engine = {
      config: {},
      currentAgentId: "hana",
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockRejectedValue(new Error("registry refresh failed")),
      providerRegistry: {
        saveProvider: vi.fn(),
        removeProvider: vi.fn(),
      },
      emitEvent: vi.fn(),
    };

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          dashscope: {
            api: "openai-completions",
            models: ["qwen-plus"],
          },
        },
      }),
    });
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error).toContain("registry refresh failed");
    expect(engine.updateConfig).not.toHaveBeenCalled();
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("shared model preference updates trigger model registry sync", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.ts");
    const app = new Hono();
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
      currentAgentId: "hana",
      emitEvent: vi.fn(),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          utility: { id: "test-model", provider: "test-provider" },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.setSharedModels).toHaveBeenCalledWith({
      utility: { id: "test-model", provider: "test-provider" },
    });
    expect(engine.syncModelsAndRefresh).toHaveBeenCalledTimes(1);
    // Shared model preferences are global: every agent's model list changes, so
    // the event names no agent rather than naming whichever one was focused.
    expectAppEvent(engine.emitEvent, "models-changed", { agentId: null });
  });

  it("auxiliary vision toggle updates shared prefs without refreshing the model registry", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.ts");
    const app = new Hono();
    const engine = {
      getSharedModels: vi.fn(() => ({ vision_enabled: false })),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      resolveModelWithCredentials: vi.fn(),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
      currentAgentId: "hana",
      emitEvent: vi.fn(),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          vision_enabled: true,
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.setSharedModels).toHaveBeenCalledWith({
      vision_enabled: true,
    });
    expect(engine.resolveModelWithCredentials).not.toHaveBeenCalled();
    expect(engine.syncModelsAndRefresh).not.toHaveBeenCalled();
    expectAppEvent(engine.emitEvent, "models-changed", { agentId: null });
  });

  it("shared model preference updates return an error and emit no event when model refresh fails", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.ts");
    const app = new Hono();
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockRejectedValue(new Error("model refresh failed")),
      currentAgentId: "hana",
      emitEvent: vi.fn(),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          utility: { id: "test-model", provider: "test-provider" },
        },
      }),
    });
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error).toContain("model refresh failed");
    expect(engine.setSharedModels).toHaveBeenCalledWith({
      utility: { id: "test-model", provider: "test-provider" },
    });
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("shared model preference updates reject providerless refs before saving", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.ts");
    const app = new Hono();
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
      emitEvent: vi.fn(),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          utility: { id: "test-model" },
        },
      }),
    });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain("provider");
    expect(engine.setSharedModels).not.toHaveBeenCalled();
    expect(engine.syncModelsAndRefresh).not.toHaveBeenCalled();
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("shared vision model preference updates are provider-aware and image-capable", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.ts");
    const app = new Hono();
    const engine = {
      getSharedModels: vi.fn(() => ({ vision: null })),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      resolveModelWithCredentials: vi.fn(() => ({
        model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
        provider: "dashscope",
        api: "openai-completions",
        api_key: "sk-test",
        base_url: "https://example.test/v1",
      })),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
      currentAgentId: "hana",
      emitEvent: vi.fn(),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: { vision: { id: "qwen-vl", provider: "dashscope" } },
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.resolveModelWithCredentials).toHaveBeenCalledWith({
      id: "qwen-vl",
      provider: "dashscope",
    });
    expect(engine.setSharedModels).toHaveBeenCalledWith({
      vision: { id: "qwen-vl", provider: "dashscope" },
    });
    expectAppEvent(engine.emitEvent, "models-changed", { agentId: null });
  });

  it("shared vision model preference rejects text-only models", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.ts");
    const app = new Hono();
    const engine = {
      getSharedModels: vi.fn(() => ({ vision: null })),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      resolveModelWithCredentials: vi.fn(() => ({
        model: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
        provider: "deepseek",
        api: "openai-completions",
        api_key: "sk-test",
        base_url: "https://example.test/v1",
      })),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
      emitEvent: vi.fn(),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: { vision: { id: "deepseek-chat", provider: "deepseek" } },
      }),
    });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain("image");
    expect(engine.setSharedModels).not.toHaveBeenCalled();
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("inline 凭证缺少显式 provider 时返回 400", async () => {
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const agentDir = makeAgentDir("hana", "agent:\n  name: Hana\n");
    const engine = {
      agentsDir: path.dirname(agentDir),
      setHomeFolder: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
      getHomeFolder: vi.fn(() => null),
      getThinkingLevel: vi.fn(() => "medium"),
      getSandbox: vi.fn(() => "workspace-write"),
      getLocale: vi.fn(() => "zh-CN"),
      getTimezone: vi.fn(() => "Asia/Shanghai"),
      getLearnSkills: vi.fn(() => false),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => []),
      emitEvent: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request("/api/agents/hana/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api: {
          api_key: "sk-test",
        },
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("api.provider is required");
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("inline 空 api_key 也会同步到 provider 配置，用于真正清空凭证", async () => {
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const saveProvider = vi.fn();
    const agentDir = makeAgentDir("hana", "agent:\n  name: Hana\napi:\n  provider: openai\n");
    const engine = {
      agentsDir: path.dirname(agentDir),
      setHomeFolder: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      providerRegistry: {
        saveProvider,
        removeProvider: vi.fn(),
        getAllProvidersRaw: vi.fn(() => ({})),
      },
      getHomeFolder: vi.fn(() => null),
      getThinkingLevel: vi.fn(() => "medium"),
      getSandbox: vi.fn(() => "workspace-write"),
      getLocale: vi.fn(() => "zh-CN"),
      getTimezone: vi.fn(() => "Asia/Shanghai"),
      getLearnSkills: vi.fn(() => false),
      invalidateAgentListCache: vi.fn(),
      listAgents: vi.fn(() => []),
      currentAgentId: "hana",
      emitEvent: vi.fn(),
    };

    app.route("/api", createAgentsRoute(engine));

    const res = await app.request("/api/agents/hana/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api: {
          provider: "openai",
          api_key: "",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveProvider).toHaveBeenCalledWith("openai", { api_key: "" });
    expect(engine.onProviderChanged).toHaveBeenCalledTimes(1);
    // This event does name an agent, and correctly so: the change came from
    // that agent's own config route, so the id is the one in the path rather
    // than the one the server is focused on.
    expectAppEvent(engine.emitEvent, "models-changed", { agentId: "hana" });
  });

  it("global locale config updates emit locale-changed after success", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    const app = new Hono();
    const engine = {
      config: {},
      configPath: "/tmp/test-config.yaml",
      setLocale: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      providerRegistry: {
        saveProvider: vi.fn(),
        removeProvider: vi.fn(),
      },
      emitEvent: vi.fn(),
    };

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "en-US" }),
    });

    expect(res.status).toBe(200);
    expect(engine.setLocale).toHaveBeenCalledWith("en-US");
    expect(engine.updateConfig).not.toHaveBeenCalled();
    expectAppEvent(engine.emitEvent, "locale-changed", { locale: "en-US" });
  });

  it("model routes expose stable ids and readable display names", async () => {
    const { createModelsRoute } = await import("../server/routes/models.ts");
    const app = new Hono();
    const engine = {
      availableModels: [
        {
          id: "gpt-5.4",
          name: "Gpt 5.4",
          provider: "openai-codex",
          reasoning: true,
          toolUse: {
            supportsTools: true,
            dialect: "openai",
            toolResultFormat: "message",
            supportsParallelToolCalls: true,
          },
        },
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          provider: "deepseek",
          reasoning: true,
        },
        {
          id: "gpt-audio-mini",
          name: "GPT Audio Mini",
          provider: "openai",
          api: "openai-completions",
          input: ["text"],
          audio: true,
        },
      ],
      currentModel: { id: "gpt-5.4", name: "Gpt 5.4" },
      config: {},
      providerRegistry: { get: () => ({}) },
    };

    app.route("/api", createModelsRoute(engine));

    const allRes = await app.request("/api/models");
    const allData = await allRes.json();
    expect(allRes.status).toBe(200);
    expect(allData.models[0].id).toBe("gpt-5.4");
    expect(allData.models[0].name).toBe("Gpt 5.4");
    expect(allData.models[0].toolUse).toEqual({
      supportsTools: true,
      dialect: "openai",
      toolResultFormat: "message",
      supportsParallelToolCalls: true,
    });
    expect(allData.models[1].xhigh).toBe(true);
    expect(allData.models[2]).toMatchObject({
      id: "gpt-audio-mini",
      audio: true,
      audioTransport: "openai-input-audio",
      audioTransportSupported: true,
    });
  });

  it("auxiliary vision route exposes availability without settings secrets", async () => {
    const { createModelsRoute } = await import("../server/routes/models.ts");
    const app = new Hono();
    const engine = {
      availableModels: [],
      currentModel: null,
      config: {},
      getSharedModels: vi.fn(() => ({
        vision_enabled: true,
        vision: { id: "qwen-vl", provider: "dashscope" },
      })),
      resolveModelWithCredentials: vi.fn(() => ({
        model: {
          id: "qwen-vl",
          provider: "dashscope",
          name: "Qwen VL",
          input: ["text", "image"],
        },
        provider: "dashscope",
        api: "openai-completions",
        api_key: "sk-test-secret",
        base_url: "https://dashscope.example/v1",
      })),
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models/auxiliary-vision");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({
      auxiliaryVision: {
        enabled: true,
        configured: true,
        available: true,
        unavailableReason: null,
        model: { id: "qwen-vl", provider: "dashscope" },
      },
    });
    expect(JSON.stringify(data)).not.toContain("sk-test-secret");
    expect(JSON.stringify(data)).not.toContain("dashscope.example");
  });

  it("auxiliary vision route reports text-only configured models as unavailable", async () => {
    const { createModelsRoute } = await import("../server/routes/models.ts");
    const app = new Hono();
    const engine = {
      availableModels: [],
      currentModel: null,
      config: {},
      getSharedModels: vi.fn(() => ({
        vision_enabled: true,
        vision: { id: "deepseek-chat", provider: "deepseek" },
      })),
      resolveModelWithCredentials: vi.fn(() => ({
        model: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
        provider: "deepseek",
      })),
    };

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models/auxiliary-vision");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.auxiliaryVision).toEqual({
      enabled: true,
      configured: true,
      available: false,
      unavailableReason: "model_without_image_input",
      model: { id: "deepseek-chat", provider: "deepseek" },
    });
  });

  it("model health accepts explicit model refs and uses the utility LLM path", async () => {
    const { createModelsRoute } = await import("../server/routes/models.ts");
    const app = new Hono();
    const resolved = {
      model: {
        id: "deepseek-v4-flash",
        provider: "deepseek",
        reasoning: true,
        maxTokens: 384000,
      },
      provider: "deepseek",
      api: "openai-completions",
      api_key: "sk-test",
      base_url: "https://api.deepseek.com/v1",
    };
    const engine = {
      availableModels: [],
      currentModel: null,
      config: {},
      resolveModelWithCredentialsFresh: vi.fn(async () => resolved),
    };
    callText.mockResolvedValue("ok");

    app.route("/api", createModelsRoute(engine));

    const healthRes = await app.request("/api/models/health", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelId: { id: "deepseek-v4-flash", provider: "deepseek" },
      }),
    });
    const healthData = await healthRes.json();

    expect(healthRes.status).toBe(200);
    expect(healthData).toMatchObject({ ok: true, provider: "deepseek" });
    expect(engine.resolveModelWithCredentialsFresh).toHaveBeenCalledWith({
      id: "deepseek-v4-flash",
      provider: "deepseek",
    });
    expect(callText).toHaveBeenCalledWith(expect.objectContaining({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com/v1",
      model: resolved.model,
      maxTokens: 128,
      timeoutMs: 15_000,
    }));
  });

  it("bills the model health probe to the global utility account, not the focused agent", async () => {
    const { createModelsRoute } = await import("../server/routes/models.ts");
    const app = new Hono();
    const resolved = {
      model: { id: "probe-model", provider: "deepseek" },
      provider: "deepseek",
      api: "openai-completions",
      api_key: "sk-test",
      base_url: "https://api.deepseek.com/v1",
    };
    const engine = {
      availableModels: [],
      currentModel: null,
      config: {},
      // The server is focused on an agent, but a settings-panel health probe is
      // not that agent's work and must not land on its usage account.
      currentAgentId: "hana",
      usageLedger: {},
      resolveModelWithCredentialsFresh: vi.fn(async () => resolved),
    };
    callText.mockResolvedValue("ok");

    app.route("/api", createModelsRoute(engine));

    const res = await app.request("/api/models/health", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: { id: "probe-model", provider: "deepseek" } }),
    });

    expect(res.status).toBe(200);
    expect(callText).toHaveBeenCalledWith(expect.objectContaining({
      usageContext: expect.objectContaining({
        attribution: { kind: "utility", agentId: null },
      }),
    }));
  });

  it("model health forwards resolved Grok OAuth provider and model headers to callText", async () => {
    const { createModelsRoute } = await import("../server/routes/models.ts");
    const app = new Hono();
    const resolved = {
      model: {
        id: "grok-4.1",
        provider: "xai",
        reasoning: true,
      },
      provider: "xai",
      api: "openai-completions",
      api_key: "oauth-token",
      base_url: "https://api.x.ai/v1",
      headers: {
        "x-grok-client-version": "0.1.202",
        "x-grok-model-override": "grok-4.1",
      },
    };
    const engine = {
      availableModels: [],
      currentModel: null,
      config: {},
      resolveModelWithCredentialsFresh: vi.fn(async () => resolved),
    };
    callText.mockResolvedValue("OK");

    app.route("/api", createModelsRoute(engine));

    const healthRes = await app.request("/api/models/health", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "grok-4.1", provider: "xai" }),
    });

    expect(healthRes.status).toBe(200);
    expect(callText).toHaveBeenCalledWith(expect.objectContaining({
      api: "openai-completions",
      apiKey: "oauth-token",
      baseUrl: "https://api.x.ai/v1",
      headers: {
        "x-grok-client-version": "0.1.202",
        "x-grok-model-override": "grok-4.1",
      },
    }));
  });

  it("model health reports empty-after-thinking as a diagnostic failure", async () => {
    const { AppError } = await import("../shared/errors.ts");
    const { createModelsRoute } = await import("../server/routes/models.ts");
    const app = new Hono();
    const resolved = {
      model: {
        id: "MiniMax-M2.7",
        provider: "minimax",
        reasoning: true,
      },
      provider: "minimax",
      api: "anthropic-messages",
      api_key: "sk-test",
      base_url: "https://api.minimaxi.com/anthropic",
    };
    const engine = {
      availableModels: [],
      currentModel: null,
      config: {},
      resolveModelWithCredentialsFresh: vi.fn(async () => resolved),
    };
    callText.mockRejectedValue(new AppError("LLM_EMPTY_RESPONSE", {
      message: "模型未回复正文，请检查思考内容或稍后重试。",
      context: { model: "MiniMax-M2.7", reason: "empty_after_thinking" },
    }));

    app.route("/api", createModelsRoute(engine));

    const healthRes = await app.request("/api/models/health", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "MiniMax-M2.7", provider: "minimax" }),
    });
    const healthData = await healthRes.json();

    expect(healthRes.status).toBe(200);
    expect(healthData).toMatchObject({
      ok: false,
      code: "LLM_EMPTY_RESPONSE",
      reason: "empty_after_thinking",
      error: "模型未回复正文，请检查思考内容或稍后重试。",
    });
  });

  it("classifies expected session model switch failures instead of returning a generic 500", async () => {
    const { createModelsRoute } = await import("../server/routes/models.ts");
    const app = new Hono();
    const engine = {
      availableModels: [],
      currentModel: null,
      config: {},
      isSessionStreaming: vi.fn(() => false),
      switchSessionModel: vi.fn()
        .mockRejectedValueOnce(new Error("Model not found: minimax-token-plan/MiniMax-M2.7"))
        .mockRejectedValueOnce(new Error("No API key configured for provider minimax-token-plan"))
        .mockRejectedValueOnce(new Error("cannot switch model during compaction"))
        .mockRejectedValueOnce(Object.assign(
          new Error("新模型的上下文空间不足，无法容纳当前会话。请先压缩当前会话，再重新切换。"),
          { code: "MODEL_CONTEXT_TOO_LARGE" },
        )),
      getSessionByPath: vi.fn(),
    };
    app.route("/api", createModelsRoute(engine));

    const request = () => app.request("/api/models/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionPath: "/tmp/session.jsonl",
        modelId: "MiniMax-M2.7",
        provider: "minimax-token-plan",
      }),
    });

    const missingModel = await request();
    expect(missingModel.status).toBe(404);
    expect(await missingModel.json()).toMatchObject({
      code: "MODEL_NOT_FOUND",
      error: expect.stringContaining("MiniMax-M2.7"),
    });

    const missingCredentials = await request();
    expect(missingCredentials.status).toBe(422);
    expect(await missingCredentials.json()).toMatchObject({
      code: "MODEL_CREDENTIALS_MISSING",
      error: expect.stringContaining("minimax-token-plan"),
    });

    const conflict = await request();
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "MODEL_SWITCH_CONFLICT",
      error: expect.stringContaining("compaction"),
    });

    const contextTooLarge = await request();
    expect(contextTooLarge.status).toBe(409);
    expect(await contextTooLarge.json()).toMatchObject({
      code: "MODEL_CONTEXT_TOO_LARGE",
      error: expect.stringContaining("请先压缩"),
    });
  });

  it("oauth provider with empty baseUrl falls back to registry", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          provider: "openai-codex",
          contextWindow: 272000,
          maxOutputTokens: 128000,
        },
      ]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "", baseUrl: "", api: "openai-codex-responses" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openai-codex" }),
    });

    expect(res.status).toBe(200);
    expect(engine.getRegistryModelsForProvider).toHaveBeenCalledWith("openai-codex");
    const data = await res.json();
    expect(data.source).toBe("registry");
    expect(data.models[0].id).toBe("gpt-5.4");
  });

  it("provider model delete refreshes runtime models and notifies the app", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const removeModel = vi.fn();
    const engine = {
      currentAgentId: "hana",
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      emitEvent: vi.fn(),
      providerRegistry: { removeModel },
      hanakoHome: "/tmp",
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/openrouter/models/openrouter%2Fqwen%2Fqwen-vl-plus", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(removeModel).toHaveBeenCalledWith("openrouter", "openrouter/qwen/qwen-vl-plus");
    expect(clearConfigCache).toHaveBeenCalledTimes(1);
    expect(engine.onProviderChanged).toHaveBeenCalledTimes(1);
    expectAppEvent(engine.emitEvent, "models-changed", { agentId: null });
    expect(engine.emitEvent).toHaveBeenCalledTimes(1);
  });

  it("provider model update refreshes runtime models and notifies the app", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const updateModelEntry = vi.fn();
    const engine = {
      currentAgentId: "hana",
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      emitEvent: vi.fn(),
      providerRegistry: { updateModelEntry },
      hanakoHome: "/tmp",
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/openrouter/models/openrouter%2Fqwen%2Fqwen-vl-plus", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Qwen VL Plus" }),
    });

    expect(res.status).toBe(200);
    expect(updateModelEntry).toHaveBeenCalledWith("openrouter", "openrouter/qwen/qwen-vl-plus", {
      name: "Qwen VL Plus",
    });
    expect(clearConfigCache).toHaveBeenCalledTimes(1);
    expect(engine.onProviderChanged).toHaveBeenCalledTimes(1);
    expectAppEvent(engine.emitEvent, "models-changed", { agentId: null });
    expect(engine.emitEvent).toHaveBeenCalledTimes(1);
  });

  it("provider model update returns a declared 400 validation error", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const validationError = Object.assign(new Error("Invalid thinkingLevelMap for model"), {
      statusCode: 400,
      code: "INVALID_PROVIDER_MODEL_METADATA",
    });
    const engine = {
      providerRegistry: {
        updateModelEntry: vi.fn(() => { throw validationError; }),
      },
      hanakoHome: "/tmp",
    };

    app.route("/api", createProvidersRoute(engine));
    const res = await app.request("/api/providers/openai/models/gpt-5.6-sol", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thinkingLevelMap: { ultra: "max" } }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid thinkingLevelMap for model" });
  });

  it("provider connection test resolves fresh credentials before probing", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    probeProvider.mockResolvedValue({ ok: true });
    const resolveProviderCredentialsFresh = vi.fn(async () => ({
      api_key: "fresh-token",
      base_url: "https://fresh.example/v1",
      api: "openai-completions",
      headers: {},
    }));
    const resolveProviderCredentials = vi.fn(() => ({
      api_key: "stale-token",
      base_url: "https://stale.example/v1",
      api: "openai-completions",
      headers: { Authorization: "Bearer stale-header" },
    }));
    const engine = {
      resolveProviderCredentialsFresh,
      resolveProviderCredentials,
      providerRegistry: {
        get: vi.fn(() => ({ baseUrl: "https://stale.example/v1", api: "openai-completions" })),
        isOAuth: vi.fn(() => true),
      },
      hanakoHome: "/tmp",
    };
    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "oauth-provider" }),
    });

    expect(res.status).toBe(200);
    expect(resolveProviderCredentialsFresh).toHaveBeenCalledWith("oauth-provider");
    expect(resolveProviderCredentials).not.toHaveBeenCalled();
    expect(probeProvider).toHaveBeenCalledWith({
      baseUrl: "https://fresh.example/v1",
      api: "openai-completions",
      apiKey: "fresh-token",
      headers: {},
    });
  });

  it("provider connection test probes a configured model matching the active protocol", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    probeProvider.mockResolvedValue({ ok: true, status: 200 });
    const engine = {
      resolveProviderCredentialsFresh: vi.fn(async () => ({
        api_key: "zen-key",
        base_url: "https://opencode.ai/zen/v1/messages",
        api: "anthropic-messages",
        headers: {},
      })),
      providerRegistry: {
        getChatModelEntries: vi.fn(() => [
          { id: "gpt-5.4", api: "openai-responses" },
          { id: "claude-sonnet-4-6", api: "anthropic-messages" },
        ]),
        resolveChatProvider: vi.fn(() => ({ credentialSource: "provider-catalog" })),
      },
      hanakoHome: "/tmp",
    };
    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "opencode" }),
    });

    expect(res.status).toBe(200);
    expect(probeProvider).toHaveBeenCalledWith({
      baseUrl: "https://opencode.ai/zen",
      api: "anthropic-messages",
      apiKey: "zen-key",
      headers: {},
      modelId: "claude-sonnet-4-6",
    });
  });

  it("provider connection test treats explicit body headers as the only credentials", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    probeProvider.mockResolvedValue({ ok: true });
    const resolveProviderCredentialsFresh = vi.fn();
    const resolveProviderCredentials = vi.fn(() => ({
      api_key: "stale-token",
      headers: { Cookie: "session=stale" },
    }));
    const engine = {
      resolveProviderCredentialsFresh,
      resolveProviderCredentials,
      providerRegistry: {
        get: vi.fn(() => ({ baseUrl: "https://entry.example/v1", api: "openai-completions" })),
        isOAuth: vi.fn(() => true),
      },
      hanakoHome: "/tmp",
    };
    app.route("/api", createProvidersRoute(engine));

    await app.request("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "oauth-provider",
        headers: { Authorization: "Bearer explicit-header-token" },
      }),
    });

    expect(resolveProviderCredentialsFresh).not.toHaveBeenCalled();
    expect(resolveProviderCredentials).not.toHaveBeenCalled();
    expect(probeProvider).toHaveBeenCalledWith({
      baseUrl: "https://entry.example/v1",
      api: "openai-completions",
      apiKey: "",
      headers: { Authorization: "Bearer explicit-header-token" },
    });
    expect(JSON.stringify(probeProvider.mock.calls[0][0])).not.toContain("stale");
  });

  it("provider connection test never probes after fresh credential resolution fails", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const engine = {
      resolveProviderCredentialsFresh: vi.fn(async () => { throw new Error("refresh failed"); }),
      providerRegistry: {
        get: vi.fn(() => ({ baseUrl: "https://entry.example/v1", api: "openai-completions" })),
        isOAuth: vi.fn(() => true),
      },
      hanakoHome: "/tmp",
    };
    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "oauth-provider" }),
    });

    expect(await res.json()).toMatchObject({ ok: false, error: "refresh failed" });
    expect(probeProvider).not.toHaveBeenCalled();
  });

  it("providers summary treats no-auth providers as credential-ready without api_key", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const allowsMissingApiKey = vi.fn(() => true);
    const engine = {
      providerRegistry: {
        getAllProvidersRaw: vi.fn(() => ({
          ollama: {
            base_url: "http://192.168.1.20:11434/v1",
            api: "openai-completions",
            models: ["llama3"],
          },
        })),
        get: vi.fn(() => ({
          authType: "none",
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          displayName: "Ollama",
        })),
        isOAuth: vi.fn(() => false),
        getAuthType: vi.fn(() => "none"),
        allowsMissingApiKey,
        getAuthJsonKey: (id) => id,
        getOAuthProviderIds: () => [],
        getAll: () => new Map(),
      },
      preferences: {
        getOAuthCustomModels: () => ({}),
      },
      hanakoHome: "/tmp",
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/summary");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.providers.ollama).toMatchObject({
      auth_type: "none",
      has_credentials: true,
      api_key: "",
      models: ["llama3"],
    });
    expect(allowsMissingApiKey).toHaveBeenCalledWith(
      "ollama",
      "http://192.168.1.20:11434/v1",
    );
  });

  it("providers summary exposes invalid models config while runtime models stay disabled", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const engine = {
      providerRegistry: {
        getAllProvidersRaw: vi.fn(() => ({
          "openai-codex-oauth": { _config_error: "invalid_models_config" },
        })),
        get: vi.fn(() => ({
          authType: "oauth",
          baseUrl: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
          displayName: "OpenAI Codex (OAuth)",
        })),
        isOAuth: vi.fn(() => true),
        getAuthType: vi.fn(() => "oauth"),
        getAuthJsonKey: vi.fn(() => "openai-codex"),
        getChatModelEntries: vi.fn(() => []),
        getOAuthProviderIds: vi.fn(() => ["openai-codex-oauth"]),
        getAll: vi.fn(() => new Map()),
      },
      authStorage: {
        getOAuthProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
        get: () => ({ type: "oauth" }),
      },
      preferences: { getOAuthCustomModels: () => ({}) },
      hanakoHome: "/tmp",
    };
    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/summary");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.providers["openai-codex-oauth"]).toMatchObject({
      config_status: "invalid",
      config_error: "invalid_models_config",
      models: [],
      missing_fields: ["models"],
    });
  });

  it("providers summary distinguishes configured providers from registry-only setup entries", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const { ProviderRegistry } = await import("../core/provider-registry.ts");
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-provider-summary-"));
    try {
      fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), [
        "providers:",
        "  deepseek:",
        "    api_key: sk-test",
        "    base_url: https://api.deepseek.com",
        "    api: openai-completions",
        "    models:",
        "      - deepseek-v4-pro",
        "  my-provider:",
        "    api_key: sk-test",
        "    base_url: https://api.example.com/v1",
        "    api: openai-completions",
        "    models:",
        "      - m1",
        "",
      ].join("\n"), "utf-8");

      const registry = new ProviderRegistry(tmpHome);
      const engine = {
        providerRegistry: registry,
        authStorage: {
          getOAuthProviders: () => [],
        },
        preferences: {
          getOAuthCustomModels: () => ({}),
        },
        getRegistryModelsForProvider: () => [],
        resolveProviderCredentials: () => ({ api_key: "", base_url: "", api: "" }),
        hanakoHome: tmpHome,
      };
      const app = new Hono();
      app.route("/api", createProvidersRoute(engine));

      const before = await (await app.request("/api/providers/summary")).json();
      expect(before.providers.deepseek).toMatchObject({
        is_configured: true,
        can_delete: true,
      });
      expect(before.providers["my-provider"]).toMatchObject({
        is_configured: true,
        can_delete: true,
      });

      registry.removeProvider("deepseek");
      registry.removeProvider("my-provider");

      const after = await (await app.request("/api/providers/summary")).json();
      expect(after.providers["my-provider"]).toBeUndefined();
      expect(after.providers.deepseek).toMatchObject({
        is_configured: false,
        can_delete: false,
        config_status: "needs_setup",
        models: [],
      });
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("oauth provider with empty registry falls back to defaults", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "", baseUrl: "", api: "openai-codex-responses" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: (id) => id === "openai-codex" ? ["gpt-5.4", "gpt-5.3-codex"] : [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openai-codex" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("builtin");
    expect(data.models.map(m => m.id)).toContain("gpt-5.4");
  });

  it("legacy sdk-auth-alias discovery stays on the Pi runtime catalog without probing remotely", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const resolveProviderCredentialsFresh = vi.fn();
    const engine = {
      resolveProviderCredentialsFresh,
      getRegistryModelsForProvider: vi.fn(() => [{
        id: "legacy-runtime-model",
        name: "Legacy Runtime Model",
        provider: "legacy-runtime",
        contextWindow: 128000,
        maxTokens: 16000,
      }]),
      providerRegistry: {
        resolveChatProvider: () => ({
          sourceProviderId: "legacy-oauth",
          projection: "sdk-auth-alias",
          credentialSource: "auth-storage",
        }),
        getAuthJsonKey: () => "legacy-runtime",
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    };
    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "legacy-oauth" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      source: "registry",
      models: [expect.objectContaining({ id: "legacy-runtime-model", maxOutput: 16000 })],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveProviderCredentialsFresh).not.toHaveBeenCalled();
  });

  it("fetch-models resolves fresh saved credentials before a remote catalog request", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "fresh-model" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const resolveProviderCredentialsFresh = vi.fn(async () => ({
      api_key: "fresh-token",
      base_url: "https://fresh.example/v1",
      api: "openai-completions",
      headers: { "X-Fresh": "yes" },
    }));
    const resolveProviderCredentials = vi.fn(() => ({
      api_key: "stale-token",
      base_url: "https://stale.example/v1",
      api: "openai-completions",
      headers: { Cookie: "stale=yes" },
    }));
    const engine = {
      resolveProviderCredentialsFresh,
      resolveProviderCredentials,
      getRegistryModelsForProvider: vi.fn(() => []),
      providerRegistry: {
        resolveChatProvider: () => ({
          sourceProviderId: "remote-provider",
          projection: "models-json",
          credentialSource: "provider-catalog",
        }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    };
    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "remote-provider" }),
    });

    expect(res.status).toBe(200);
    expect(resolveProviderCredentialsFresh).toHaveBeenCalledWith("remote-provider");
    expect(resolveProviderCredentials).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("https://fresh.example/v1/models", expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer fresh-token",
        "X-Fresh": "yes",
      }),
    }));
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain("stale");
  });

  it("fetch-models treats explicit body headers as authoritative and never mixes saved secrets", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "explicit-model" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const resolveProviderCredentialsFresh = vi.fn();
    const resolveProviderCredentials = vi.fn(() => ({
      api_key: "stale-token",
      headers: { Cookie: "stale=yes" },
    }));
    const engine = {
      resolveProviderCredentialsFresh,
      resolveProviderCredentials,
      getRegistryModelsForProvider: vi.fn(() => []),
      providerRegistry: {
        resolveChatProvider: () => ({
          sourceProviderId: "explicit-provider",
          projection: "models-json",
          credentialSource: "provider-catalog",
        }),
        get: () => ({ baseUrl: "https://explicit.example/v1", api: "openai-completions" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    };
    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "explicit-provider",
        headers: { Authorization: "Bearer explicit-header" },
      }),
    });

    expect(res.status).toBe(200);
    expect(resolveProviderCredentialsFresh).not.toHaveBeenCalled();
    expect(resolveProviderCredentials).not.toHaveBeenCalled();
    const requestHeaders = fetchMock.mock.calls[0][1].headers;
    expect(requestHeaders).toMatchObject({ Authorization: "Bearer explicit-header" });
    expect(JSON.stringify(requestHeaders)).not.toContain("stale");
  });

  it("fetch-models never probes after fresh credential resolution fails", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const engine = {
      resolveProviderCredentialsFresh: vi.fn(async () => { throw new Error("fresh fetch failed"); }),
      getRegistryModelsForProvider: vi.fn(() => []),
      providerRegistry: {
        resolveChatProvider: () => ({
          sourceProviderId: "broken-provider",
          projection: "models-json",
          credentialSource: "provider-catalog",
        }),
      },
      hanakoHome: "/tmp",
    };
    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "broken-provider" }),
    });

    expect(await res.json()).toMatchObject({ error: "fresh fetch failed", models: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("provider with explicit api_key uses remote catalog", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "MiniMax-M2.5", context_length: 1000000, max_output_tokens: 80000 },
          { id: "MiniMax-M2", context_length: 1000000, max_output_tokens: 80000 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "minimax",
        base_url: "https://api.minimaxi.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data.models).toHaveLength(2);
    expect(data.models[0].id).toBe("MiniMax-M2.5");
  });

  it("marks discovered Ollama vision model families as image-capable", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "llava:latest" },
          { id: "minicpm-v:8b" },
          { id: "llama3.2" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: fs.mkdtempSync(path.join(os.tmpdir(), "hana-ollama-discovery-")),
    });

    try {
      app.route("/api", createProvidersRoute(engine));

      const res = await app.request("/api/providers/fetch-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "ollama",
          base_url: "http://localhost:11434/v1",
          api: "openai-completions",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.models.find((model) => model.id === "llava:latest")).toMatchObject({ image: true });
      expect(data.models.find((model) => model.id === "minicpm-v:8b")).toMatchObject({ image: true });
      expect(data.models.find((model) => model.id === "llama3.2")?.image).toBeUndefined();
    } finally {
      fs.rmSync(engine.hanakoHome, { recursive: true, force: true });
    }
  });

  it("provider fetch-models uses saved request headers as credentials", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: "gateway-model", context_length: 128000 }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({
          apiKey: "",
          baseUrl: "https://gateway.example/v1",
          api: "openai-completions",
          headers: { Authorization: "Bearer gateway-token", "X-Corp-Auth": "corp-token" },
        }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "gateway-provider" }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({
      Authorization: "Bearer gateway-token",
      "X-Corp-Auth": "corp-token",
    });
    const data = await res.json();
    expect(data.models[0].id).toBe("gateway-model");
  });

  it("fetch-models does not expose the official DeepSeek provider id as a model", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "deepseek" },
          { id: "deepseek-v4-pro", context_length: 1000000, max_output_tokens: 384000 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "deepseek",
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models.map(m => m.id)).toEqual(["deepseek-v4-pro"]);
    expect(data.ignoredModels).toEqual(["deepseek"]);
  });

  it("discovered-models filters cached official DeepSeek provider ids", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-test-model-cache-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "models-cache.json"),
        JSON.stringify({
          deepseek: {
            fetchedAt: "2026-05-06T08:00:00.000Z",
            models: [
              { id: "deepseek" },
              { id: "deepseek-v4-flash" },
            ],
          },
        }),
        "utf-8",
      );

      const app = new Hono();
      const engine = withResolveCreds({
        providerRegistry: {
          getCredentials: () => ({ apiKey: "sk-test", baseUrl: "https://api.deepseek.com/v1", api: "openai-completions" }),
        },
        hanakoHome: tmpDir,
      });

      app.route("/api", createProvidersRoute(engine));

      const res = await app.request("/api/providers/deepseek/discovered-models");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.models.map(m => m.id)).toEqual(["deepseek-v4-flash"]);
      expect(data.ignoredModels).toEqual(["deepseek"]);
      expect(data.fetchedAt).toBe("2026-05-06T08:00:00.000Z");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("api-key provider with saved credentials uses remote catalog", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "qwen3.5-flash", context_length: 131072, max_output_tokens: 16384 },
          { id: "qwen3.5-plus", context_length: 1048576, max_output_tokens: 65536 },
          { id: "qwen3-max", context_length: 262144, max_output_tokens: 32768 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "dashscope",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
      }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data.models).toHaveLength(3);
  });

  it("codex oauth model discovery uses the local catalog and never probes ChatGPT backend /models", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai-codex", contextWindow: 272000, maxOutputTokens: 128000 },
      ]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "oauth-token", baseUrl: "https://chatgpt.com/backend-api", api: "openai-codex-responses" }),
        getAuthJsonKey: () => "openai-codex",
        getDefaultModels: () => [],
        isOAuth: () => true,
        resolveChatProvider: () => ({
          sourceProviderId: "openai-codex-oauth",
          projection: "models-json",
          credentialSource: "auth-storage",
          entry: { id: "openai-codex-oauth", baseUrl: "https://chatgpt.com/backend-api" },
        }),
        getChatDiscoverableModelEntries: () => [{ id: "gpt-5.4", name: "GPT-5.4", contextWindow: 272000, maxOutputTokens: 96000 }],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openai-codex-oauth" }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const data = await res.json();
    expect(data.source).toBe("hana-catalog");
    expect(data.models[0].id).toBe("gpt-5.4");
    expect(data.models[0]).toMatchObject({ context: 272000, maxOutput: 96000 });
    expect(engine.getRegistryModelsForProvider).not.toHaveBeenCalled();
  });

  it("codex oauth discovery still exposes Hana defaults when the runtime allowlist is explicitly empty", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "oauth-token", baseUrl: "https://chatgpt.com/backend-api", api: "openai-codex-responses" }),
        getAuthJsonKey: () => "openai-codex",
        getDefaultModels: () => [],
        isOAuth: () => true,
        resolveChatProvider: () => ({
          sourceProviderId: "openai-codex-oauth",
          projection: "models-json",
          credentialSource: "auth-storage",
          entry: { id: "openai-codex-oauth", baseUrl: "https://chatgpt.com/backend-api" },
        }),
        getChatDiscoverableModelEntries: () => ["gpt-5.6-sol"],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openai-codex-oauth" }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const data = await res.json();
    expect(data.source).toBe("hana-catalog");
    expect(data.models.map((model) => model.id)).toContain("gpt-5.6-sol");
  });

  it("remote 404 falls back to registry for ordinary remote catalogs", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }));

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([
        { id: "custom-chat", name: "Custom Chat", provider: "custom-provider", contextWindow: 128000, maxTokens: 8192 },
      ]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "sk-test", baseUrl: "https://api.example.com/v1", api: "openai-completions" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "custom-provider" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("registry");
    expect(data.models[0].id).toBe("custom-chat");
    expect(data.models[0].maxOutput).toBe(8192);
  });

  it("remote 401 returns error without fallback", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" }));

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn(),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "bad-key", baseUrl: "https://api.example.com/v1", api: "openai-completions" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "some-provider" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.error).toContain("401");
    expect(data.models).toEqual([]);
    expect(engine.getRegistryModelsForProvider).not.toHaveBeenCalled();
  });

  it("defaults fallback uses authJsonKey when provider ID has no defaults", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "", baseUrl: "", api: "openai-codex-responses" }),
        getAuthJsonKey: () => "openai-codex",
        getDefaultModels: (id) => {
          if (id === "openai-codex") return ["gpt-5.4", "gpt-5.3-codex"];
          return null;
        },
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openai-codex-oauth" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("builtin");
    expect(data.models.map(m => m.id)).toEqual(["gpt-5.4", "gpt-5.3-codex"]);
  });

  it("anthropic-messages hits /v1/models and normalizes Anthropic fields", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "claude-opus-4-7",
            display_name: "Claude Opus 4.7",
            max_input_tokens: 200000,
            max_tokens: 64000,
          },
          { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", max_input_tokens: 200000, max_tokens: 64000 },
        ],
        has_more: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "sk-test", baseUrl: "https://api.anthropic.com", api: "anthropic-messages" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "anthropic" }),
    });

    expect(res.status).toBe(200);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["User-Agent"]).toBe("HanaAgent/1.0");

    const data = await res.json();
    expect(data.models).toEqual([
      { id: "claude-opus-4-7", name: "Claude Opus 4.7", context: 200000, maxOutput: 64000 },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context: 200000, maxOutput: 64000 },
    ]);
  });

  it("anthropic-messages model discovery does not duplicate /v1 in base URLs", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "claude-compatible", display_name: "Claude Compatible" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "", baseUrl: "", api: "" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "custom-anthropic",
        base_url: "https://anthropic-compatible.example/v1",
        api: "anthropic-messages",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("https://anthropic-compatible.example/v1/models?limit=1000");
  });

  it("google-generative-ai hits native Gemini /models with x-goog-api-key and normalizes fields", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          {
            name: "models/gemini-3.1-pro-preview",
            baseModelId: "gemini-3.1-pro-preview",
            displayName: "Gemini 3.1 Pro Preview",
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({
          apiKey: "gemini-key",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          api: "google-generative-ai",
        }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "gemini" }),
    });

    expect(res.status).toBe(200);
    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall[0]).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(fetchCall[1].headers["x-goog-api-key"]).toBe("gemini-key");
    expect(fetchCall[1].headers.Authorization).toBeUndefined();

    const data = await res.json();
    expect(data.models).toEqual([
      {
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        context: 1048576,
        maxOutput: 65536,
      },
    ]);
  });

  it("zhipu model discovery supplements incomplete remote catalogs with curated current GLM defaults", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "glm-5", context_length: 200000, max_output_tokens: 128000 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({
          apiKey: "zhipu-key",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
          api: "openai-completions",
        }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: (id) => id === "zhipu" ? ["glm-5.2", "glm-5.1", "glm-5", "glm-4.7-flash"] : [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "zhipu" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.models.slice(0, 4).map(m => m.id)).toEqual(["glm-5", "glm-5.2", "glm-5.1", "glm-4.7-flash"]);
    expect(data.models.find(m => m.id === "glm-5.2")).toMatchObject({
      name: "GLM-5.2",
      context: 1000000,
      maxOutput: 131072,
    });
    expect(data.models.map(m => m.id)).toEqual(expect.arrayContaining(["glm-5-turbo", "glm-4-flash"]));
  });

  it("anthropic-messages falls back to defaults when remote 404s", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }));

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "sk-test", baseUrl: "https://api.kimi.com/coding", api: "anthropic-messages" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: (id) => id === "kimi-coding" ? ["kimi-k2.6", "kimi-k2.5"] : [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "kimi-coding" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("builtin");
    expect(data.models.map(m => m.id)).toEqual(["kimi-k2.6", "kimi-k2.5"]);
  });

  it("normalizes MiniMax CN v1 base URLs for Anthropic-compatible model discovery", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "MiniMax-M2.7", display_name: "MiniMax M2.7" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "sk-test", baseUrl: "https://api.minimaxi.com/v1", api: "anthropic-messages" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "minimax" }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.minimaxi.com/anthropic/v1/models?limit=1000");
    const data = await res.json();
    expect(data.models.map(m => m.id)).toEqual(["MiniMax-M2.7"]);
  });

  it("normalizes MiniMax Token Plan v1 base URLs to the shared Anthropic endpoint", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "MiniMax-M3", display_name: "MiniMax M3" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "sk-test", baseUrl: "https://api.minimaxi.com/v1", api: "anthropic-messages" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "minimax-token-plan" }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.minimaxi.com/anthropic/v1/models?limit=1000");
    const data = await res.json();
    expect(data.models.map(m => m.id)).toEqual(["MiniMax-M3"]);
  });

  it("request body api_key overrides saved credentials", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "test-model" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "saved-key", baseUrl: "https://api.example.com/v1", api: "openai-completions" }),
        get: () => ({ baseUrl: "https://api.example.com/v1", api: "openai-completions" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-provider",
        api_key: "body-key",
      }),
    });

    expect(res.status).toBe(200);
    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall[1].headers["Authorization"]).toBe("Bearer body-key");
  });
});
