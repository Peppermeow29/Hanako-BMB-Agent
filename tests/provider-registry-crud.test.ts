/**
 * ProviderRegistry — credential read + model CRUD 单元测试
 *
 * 覆盖新增方法：getCredentials, getProviderModels, getAllProvidersRaw,
 * addModel, removeModel, saveProvider, removeProvider
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { ProviderRegistry } from "../core/provider-registry.ts";

const tmpDir = path.join(os.tmpdir(), "hana-test-pr-crud-" + Date.now());

function writeAddedModels(providers) {
  const ymlPath = path.join(tmpDir, "added-models.yaml");
  fs.writeFileSync(ymlPath, YAML.dump({ providers }), "utf-8");
}

function readAddedModels() {
  const catalogPath = path.join(tmpDir, "provider-catalog.json");
  if (fs.existsSync(catalogPath)) {
    return readProviderCatalog().providers || {};
  }
  const ymlPath = path.join(tmpDir, "added-models.yaml");
  const raw = YAML.load(fs.readFileSync(ymlPath, "utf-8"));
  return raw?.providers || {};
}

function readProviderCatalog() {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, "provider-catalog.json"), "utf-8"));
}

function writeProviderCatalog(catalog) {
  fs.writeFileSync(
    path.join(tmpDir, "provider-catalog.json"),
    JSON.stringify(catalog, null, 2) + "\n",
    "utf-8",
  );
}

function readProviderCatalogMeta() {
  return readProviderCatalog().meta || {};
}

function readLocalProviderPlugin(providerId) {
  return JSON.parse(fs.readFileSync(
    path.join(tmpDir, "provider-plugins", providerId, "providers", `${providerId}.json`),
    "utf-8",
  ));
}

function readLocalProviderManifest(providerId) {
  return JSON.parse(fs.readFileSync(
    path.join(tmpDir, "provider-plugins", providerId, "manifest.json"),
    "utf-8",
  ));
}

function readOnlyLocalProviderPluginDir() {
  const root = path.join(tmpDir, "provider-plugins");
  const dirs = fs.readdirSync(root).filter((entry) => fs.statSync(path.join(root, entry)).isDirectory());
  expect(dirs).toHaveLength(1);
  return dirs[0];
}

/** 创建一个 registry，注册一个测试插件 */
function makeRegistry(pluginOverrides = {}) {
  const reg = new ProviderRegistry(tmpDir);
  // 清除所有内置插件，只留测试用的
  reg._plugins.clear();
  reg._entries.clear();

  const testPlugin = {
    id: "test-provider",
    displayName: "Test Provider",
    authType: "api-key",
    defaultBaseUrl: "https://api.test.com/v1",
    defaultApi: "openai-completions",
    ...pluginOverrides,
  };
  reg._plugins.set(testPlugin.id, testPlugin);
  return reg;
}

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── getCredentials ───────────────────────────────────────────────────────────

describe("getCredentials", () => {
  it("migrates legacy added-models.yaml to provider-catalog.json and uses v2 as the live provider source", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-test-123",
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        models: ["model-a"],
      },
    });
    const legacyPath = path.join(tmpDir, "added-models.yaml");
    const legacyBefore = fs.readFileSync(legacyPath, "utf-8");

    const reg = makeRegistry();

    expect(reg.getCredentials("test-provider")).toMatchObject({
      apiKey: "sk-test-123",
      baseUrl: "https://custom.api.com/v1",
      api: "openai-completions",
    });
    expect(readProviderCatalog().providers["test-provider"].models).toEqual(["model-a"]);

    reg.updateModelEntry("test-provider", "model-a", { image: true });

    expect(fs.readFileSync(legacyPath, "utf-8")).toBe(legacyBefore);
    expect(readProviderCatalog().providers["test-provider"].models[0]).toMatchObject({
      id: "model-a",
      image: true,
    });
  });

  it("keeps MiniMax Token Plan as a distinct Anthropic-compatible provider boundary", () => {
    writeAddedModels({});
    const reg = new ProviderRegistry(tmpDir);

    const minimax = reg.get("minimax");
    const entry = reg.get("minimax-token-plan");

    expect(minimax).toMatchObject({
      id: "minimax",
      baseUrl: "https://api.minimaxi.com/anthropic",
      api: "anthropic-messages",
    });
    expect(entry).toMatchObject({
      id: "minimax-token-plan",
      displayName: "MiniMax Token Plan",
      authType: "api-key",
      baseUrl: "https://api.minimaxi.com/anthropic",
      api: "anthropic-messages",
      isBuiltin: true,
    });
    expect(entry.id).not.toBe(minimax.id);
    expect(reg.getDefaultModels("minimax-token-plan")).toEqual(
      expect.arrayContaining(["MiniMax-M3", "MiniMax-M2.1-highspeed"])
    );
  });

  it("registers GLM Coding Plan as a fixed-list Zhipu OpenAI-compatible provider", () => {
    writeAddedModels({});
    const reg = new ProviderRegistry(tmpDir);

    const entry = reg.get("zhipu-coding");

    expect(entry).toMatchObject({
      id: "zhipu-coding",
      displayName: "智谱 GLM Coding Plan",
      authType: "api-key",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      api: "openai-completions",
      isBuiltin: true,
    });
    expect(reg.getDefaultModels("zhipu-coding")).toEqual([
      "glm-5.2",
      "glm-5-turbo",
      "glm-4.7",
      "glm-4.5-air",
    ]);
  });

  it("返回已配置 provider 的 apiKey/baseUrl/api", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-test-123",
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
      },
    });
    const reg = makeRegistry();
    const creds = reg.getCredentials("test-provider");
    expect(creds).toEqual({
      apiKey: "sk-test-123",
      baseUrl: "https://custom.api.com/v1",
      api: "openai-completions",
    });
  });

  it("未配置的 provider 返回 null", () => {
    writeAddedModels({});
    const reg = makeRegistry();
    const creds = reg.getCredentials("nonexistent");
    expect(creds).toBeNull();
  });

  it("added-models.yaml 未设置 baseUrl/api 时，从插件默认值回退", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-fallback",
      },
    });
    const reg = makeRegistry();
    const creds = reg.getCredentials("test-provider");
    expect(creds.apiKey).toBe("sk-fallback");
    expect(creds.baseUrl).toBe("https://api.test.com/v1");
    expect(creds.api).toBe("openai-completions");
  });

  it("OAuth provider 无 api_key 时从 auth.json 取 access token", () => {
    // 写 auth.json
    const authPath = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      "test-oauth-key": {
        type: "oauth",
        access: "oauth-access-token-abc",
        refresh: "refresh-xyz",
        expires: Date.now() + 3600_000,
      },
    }), "utf-8");

    writeAddedModels({
      "test-oauth": {
        models: [{ id: "model-a" }],
      },
    });

    const reg = new ProviderRegistry(tmpDir);
    reg._plugins.clear();
    reg._entries.clear();
    reg._plugins.set("test-oauth", {
      id: "test-oauth",
      displayName: "Test OAuth",
      authType: "oauth",
      defaultBaseUrl: "https://api.test.com/v1",
      defaultApi: "openai-completions",
      authJsonKey: "test-oauth-key",
    });

    const creds = reg.getCredentials("test-oauth");
    expect(creds.apiKey).toBe("oauth-access-token-abc");
    expect(creds.baseUrl).toBe("https://api.test.com/v1");
    expect(creds.api).toBe("openai-completions");
  });

  it("OAuth provider 通过 authJsonKey 配置时仍用插件契约解析凭证", () => {
    const authPath = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      "test-oauth": {
        type: "oauth",
        access: "oauth-access-token-abc",
        refresh: "refresh-xyz",
        expires: Date.now() + 3600_000,
      },
    }), "utf-8");

    writeAddedModels({
      "test-oauth": {
        models: [{ id: "model-a" }],
      },
    });

    const reg = new ProviderRegistry(tmpDir);
    reg._plugins.clear();
    reg._entries.clear();
    reg._plugins.set("test-oauth-plugin", {
      id: "test-oauth-plugin",
      displayName: "Test OAuth",
      authType: "oauth",
      defaultBaseUrl: "https://api.test.com/v1",
      defaultApi: "openai-completions",
      authJsonKey: "test-oauth",
    });

    const creds = reg.getCredentials("test-oauth");
    expect(creds).toEqual({
      apiKey: "oauth-access-token-abc",
      baseUrl: "https://api.test.com/v1",
      api: "openai-completions",
    });
  });

  it("OAuth provider 通过插件 ID 请求时能读取 authJsonKey 下的用户配置", () => {
    const authPath = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      "test-oauth": {
        type: "oauth",
        access: "oauth-access-token-abc",
        resourceUrl: "https://resource.test.com/v1",
      },
    }), "utf-8");

    writeAddedModels({
      "test-oauth": {
        api: "openai-completions",
        models: [{ id: "model-a" }],
      },
    });

    const reg = new ProviderRegistry(tmpDir);
    reg._plugins.clear();
    reg._entries.clear();
    reg._plugins.set("test-oauth-plugin", {
      id: "test-oauth-plugin",
      displayName: "Test OAuth",
      authType: "oauth",
      defaultBaseUrl: "",
      defaultApi: "openai-completions",
      authJsonKey: "test-oauth",
    });

    const creds = reg.getCredentials("test-oauth-plugin");
    expect(creds).toEqual({
      apiKey: "oauth-access-token-abc",
      baseUrl: "https://resource.test.com/v1",
      api: "openai-completions",
    });
  });

  it("API Key provider 不走 auth.json（即使 auth.json 有同名条目）", () => {
    const authPath = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      "test-provider": { access: "should-not-use-this" },
    }), "utf-8");

    writeAddedModels({
      "test-provider": {
        api_key: "sk-real-key",
      },
    });

    const reg = makeRegistry(); // authType: "api-key"
    const creds = reg.getCredentials("test-provider");
    expect(creds.apiKey).toBe("sk-real-key");
  });

  it("API Key provider 无 api_key 时不从 auth.json 补（两条路独立）", () => {
    const authPath = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      "test-provider": { access: "leaked-token" },
    }), "utf-8");

    writeAddedModels({
      "test-provider": {
        // 没有 api_key
        models: ["m1"],
      },
    });

    const reg = makeRegistry(); // authType: "api-key"
    const creds = reg.getCredentials("test-provider");
    expect(creds.apiKey).toBe(""); // 不会读到 auth.json 的 leaked-token
  });

  it("OAuth provider auth.json 无对应条目时 apiKey 为空", () => {
    // auth.json 存在但没有对应 key
    const authPath = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({}), "utf-8");

    writeAddedModels({ "test-oauth": { models: ["m1"] } });

    const reg = new ProviderRegistry(tmpDir);
    reg._plugins.clear();
    reg._entries.clear();
    reg._plugins.set("test-oauth", {
      id: "test-oauth",
      displayName: "Test OAuth",
      authType: "oauth",
      defaultBaseUrl: "https://api.test.com/v1",
      defaultApi: "openai-completions",
      authJsonKey: "test-oauth-key",
    });

    const creds = reg.getCredentials("test-oauth");
    expect(creds.apiKey).toBe("");
  });

  it("OAuth-only provider 没有 added-models 条目时仍能从 auth.json 读取凭证", () => {
    const authPath = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      "test-oauth": {
        type: "oauth",
        access: "oauth-access-token-abc",
        accountId: "acct_123",
      },
    }), "utf-8");

    writeAddedModels({});

    const reg = new ProviderRegistry(tmpDir);
    reg._plugins.clear();
    reg._entries.clear();
    reg._plugins.set("test-oauth-plugin", {
      id: "test-oauth-plugin",
      displayName: "Test OAuth",
      authType: "oauth",
      defaultBaseUrl: "https://oauth.test.com/backend-api",
      defaultApi: "openai-codex-responses",
      authJsonKey: "test-oauth",
    });

    const creds = reg.getCredentials("test-oauth-plugin");
    expect(creds).toEqual({
      apiKey: "oauth-access-token-abc",
      baseUrl: "https://oauth.test.com/backend-api",
      api: "openai-codex-responses",
      accountId: "acct_123",
    });
  });
});

// ── auth policy ──────────────────────────────────────────────────────────────

describe("auth policy", () => {
  it("从内置 Ollama 声明推导无 key 策略，兼容旧 YAML 没有 auth_type 的数据", () => {
    writeAddedModels({
      ollama: {
        base_url: "http://192.168.1.20:11434/v1",
        api: "openai-completions",
        models: ["llama3"],
      },
    });

    const reg = new ProviderRegistry(tmpDir);

    expect(reg.getAuthType("ollama")).toBe("none");
    expect(reg.allowsMissingApiKey("ollama", "http://192.168.1.20:11434/v1")).toBe(true);
  });

  it("api-key provider 在远程地址仍然要求 key", () => {
    writeAddedModels({
      "test-provider": {
        base_url: "https://api.test.com/v1",
        api: "openai-completions",
        models: ["model-a"],
      },
    });

    const reg = makeRegistry();

    expect(reg.getAuthType("test-provider")).toBe("api-key");
    expect(reg.allowsMissingApiKey("test-provider", "https://api.test.com/v1")).toBe(false);
  });
});

// ── builtin defaults ─────────────────────────────────────────────────────────

describe("builtin default models", () => {
  it("uses the official OpenAI-compatible endpoint for Kimi Coding Plan", () => {
    writeAddedModels({});
    const reg = new ProviderRegistry(tmpDir);
    expect(reg.get("kimi-coding")).toMatchObject({
      baseUrl: "https://api.kimi.com/coding/v1",
      api: "openai-completions",
    });
  });

  it("uses the stable Kimi for Coding model ID for Kimi Coding Plan", () => {
    writeAddedModels({});
    const reg = new ProviderRegistry(tmpDir);
    expect(reg.getDefaultModels("kimi-coding")[0]).toBe("kimi-for-coding");
  });

  it("keeps DeepSeek defaults aligned with the V4 API endpoint and model family", () => {
    writeAddedModels({});
    const reg = new ProviderRegistry(tmpDir);
    expect(reg.get("deepseek").baseUrl).toBe("https://api.deepseek.com");
    expect(reg.getDefaultModels("deepseek")).toEqual([
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]);
  });

  it("uses the native Google Gemini API as the built-in Gemini contract", () => {
    writeAddedModels({});
    const reg = new ProviderRegistry(tmpDir);
    expect(reg.get("gemini").baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(reg.get("gemini").api).toBe("google-generative-ai");
    expect(reg.getDefaultModels("gemini")).toEqual([
      "gemini-3-pro-preview",
      "gemini-3-flash-preview",
    ]);
  });
});

// ── getProviderModels ────────────────────────────────────────────────────────

describe("getProviderModels", () => {
  it("返回字符串格式的模型 ID 列表", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a", "model-b", "model-c"],
      },
    });
    const reg = makeRegistry();
    const models = reg.getProviderModels("test-provider");
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("处理对象格式的模型条目（提取 id）", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: [
          "model-a",
          { id: "model-b", name: "Model B", context: 128000 },
          "model-c",
        ],
      },
    });
    const reg = makeRegistry();
    const models = reg.getProviderModels("test-provider");
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("未配置 models 时返回空数组", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x" },
    });
    const reg = makeRegistry();
    const models = reg.getProviderModels("test-provider");
    expect(models).toEqual([]);
  });

  it("不存在的 provider 返回空数组", () => {
    writeAddedModels({});
    const reg = makeRegistry();
    const models = reg.getProviderModels("nonexistent");
    expect(models).toEqual([]);
  });
});

// ── getAllProvidersRaw ────────────────────────────────────────────────────────

describe("getAllProvidersRaw", () => {
  it("返回 added-models.yaml 原始数据", () => {
    const data = {
      "test-provider": {
        api_key: "sk-x",
        base_url: "https://api.test.com/v1",
        models: ["model-a"],
      },
      "other-provider": {
        api_key: "sk-y",
      },
    };
    writeAddedModels(data);
    const reg = makeRegistry();
    const raw = reg.getAllProvidersRaw();
    expect(raw["test-provider"].api_key).toBe("sk-x");
    expect(raw["other-provider"].api_key).toBe("sk-y");
    expect(raw["test-provider"].models).toEqual(["model-a"]);
  });

  it("added-models.yaml 不存在时返回空对象", () => {
    // 不写文件
    const reg = makeRegistry();
    const raw = reg.getAllProvidersRaw();
    expect(raw).toEqual({});
  });

  it("returns snapshots so callers cannot mutate the registry cache", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();

    const raw = reg.getAllProvidersRaw();
    raw["test-provider"].models.push("polluted-model");
    raw["new-provider"] = { api_key: "sk-polluted" };

    expect(reg.getAllProvidersRaw()).toEqual({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a"],
      },
    });
  });

  it("normalizes malformed provider records to empty configs at the registry boundary", () => {
    const ymlPath = path.join(tmpDir, "added-models.yaml");
    fs.writeFileSync(ymlPath, [
      "providers:",
      "  test-provider:",
      "    api_key: sk-x",
      "    models:",
      "      - model-a",
      "  empty-coding:",
      "  string-provider: broken",
      "  array-provider:",
      "    - nope",
      "  invalid-models:",
      "    models:",
      "      -",
      "      - id:",
      "      - id: model-b",
      "",
    ].join("\n"), "utf-8");

    const reg = makeRegistry();
    const raw = reg.getAllProvidersRaw();

    expect(raw["test-provider"].models).toEqual(["model-a"]);
    expect(raw["empty-coding"]).toEqual({ _config_error: "malformed_provider_config" });
    expect(raw["string-provider"]).toEqual({ _config_error: "malformed_provider_config" });
    expect(raw["array-provider"]).toEqual({ _config_error: "malformed_provider_config" });
    expect(raw["invalid-models"]).toEqual({
      _config_error: "invalid_models_config",
      models: [{ id: "model-b" }],
    });
  });
});

// ── provider catalog capabilities ───────────────────────────────────────────

describe("provider catalog capabilities", () => {
  it("exposes non-chat capability providers from provider-catalog.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider-catalog.json"),
      JSON.stringify({
        catalogVersion: 2,
        providers: {},
        capabilities: {
          "web.search": {
            providers: [
              { id: "brave", source: "api", requiresApiKey: true },
              { id: "duckduckgo_browser", source: "browser", requiresApiKey: false },
            ],
          },
        },
        meta: {},
      }, null, 2) + "\n",
      "utf-8",
    );
    const reg = makeRegistry();

    const providers = reg.getCapabilityProviders("web.search");
    providers.push({ id: "polluted", source: "test" });

    expect(reg.getCapabilityProviders("web.search")).toEqual([
      { id: "brave", source: "api", requiresApiKey: true },
      { id: "duckduckgo_browser", source: "browser", requiresApiKey: false },
    ]);
    expect(reg.getCapabilityProviders("missing.capability")).toEqual([]);
  });
});

describe("model defaults", () => {
  it("stores thinking defaults without creating a chat model allow list", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
      },
    });
    const reg = makeRegistry();

    reg.setModelDefaultThinkingLevel("test-provider", "model-a", "high");

    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toBeUndefined();
    expect(persisted["test-provider"].model_defaults).toEqual({
      "model-a": { thinking_level: "high" },
    });
    expect(reg.getModelDefaultThinkingLevel("test-provider", "model-a")).toBe("high");
  });
});

// ── addModel ─────────────────────────────────────────────────────────────────

describe("addModel", () => {
  it("向已有 provider 添加模型并持久化", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    reg.addModel("test-provider", "model-b");

    // 验证内存
    const models = reg.getProviderModels("test-provider");
    expect(models).toContain("model-b");

    // 验证持久化
    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toContain("model-b");
  });

  it("不会添加重复模型", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    reg.addModel("test-provider", "model-a");

    const persisted = readAddedModels();
    const count = persisted["test-provider"].models.filter(
      (m) => m === "model-a",
    ).length;
    expect(count).toBe(1);
  });

  it("provider 没有 models 字段时创建之", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x" },
    });
    const reg = makeRegistry();
    reg.addModel("test-provider", "new-model");

    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toEqual(["new-model"]);
  });

  it("支持添加对象格式的模型", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x", models: [] },
    });
    const reg = makeRegistry();
    reg.addModel("test-provider", { id: "model-obj", name: "Model Obj", context: 32000 });

    const persisted = readAddedModels();
    const entry = persisted["test-provider"].models.find(
      (m) => (typeof m === "object" ? m.id : m) === "model-obj",
    );
    expect(entry).toBeTruthy();
  });

  it("对象格式模型不与同 id 的已有条目重复", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x", models: ["model-obj"] },
    });
    const reg = makeRegistry();
    reg.addModel("test-provider", { id: "model-obj", name: "Model Obj" });

    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toHaveLength(1);
  });
});

// ── removeModel ──────────────────────────────────────────────────────────────

describe("removeModel", () => {
  it("移除模型并持久化", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a", "model-b", "model-c"],
      },
    });
    const reg = makeRegistry();
    reg.removeModel("test-provider", "model-b");

    const models = reg.getProviderModels("test-provider");
    expect(models).toEqual(["model-a", "model-c"]);

    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toEqual(["model-a", "model-c"]);
  });

  it("移除对象格式的模型条目（按 id 匹配）", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: [
          "model-a",
          { id: "model-b", name: "Model B" },
        ],
      },
    });
    const reg = makeRegistry();
    reg.removeModel("test-provider", "model-b");

    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toEqual(["model-a"]);
  });

  it("移除不存在的模型不会报错", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-x",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    expect(() => reg.removeModel("test-provider", "nonexistent")).not.toThrow();
    const persisted = readAddedModels();
    expect(persisted["test-provider"].models).toEqual(["model-a"]);
  });
});

// ── saveProvider ─────────────────────────────────────────────────────────────

describe("saveProvider", () => {
  it("创建新的 provider 条目", () => {
    writeAddedModels({});
    const reg = makeRegistry();
    reg.saveProvider("new-provider", {
      api_key: "sk-new",
      base_url: "https://new.api.com/v1",
      api: "openai-completions",
    });

    const persisted = readAddedModels();
    expect(persisted["new-provider"]).toBeDefined();
    expect(persisted["new-provider"].api_key).toBe("sk-new");
  });

  it("把新增自定义 provider 保存成本地 Provider Plugin，密钥只留在 catalog overlay", () => {
    writeAddedModels({});
    const reg = makeRegistry();

    reg.saveProvider("new-provider", {
      display_name: "New Provider",
      auth_type: "api-key",
      api_key: "sk-new",
      headers: { "X-API-Key": "header-secret" },
      base_url: "https://new.api.com/v1",
      api: "openai-completions",
      models: [
        { id: "new-chat", name: "New Chat", reasoning: true, defaultThinkingLevel: "max" },
      ],
    });

    const manifest = readLocalProviderManifest("new-provider");
    expect(manifest).toMatchObject({
      id: "new-provider",
      type: "provider-plugin",
      provider: "new-provider",
    });

    const plugin = readLocalProviderPlugin("new-provider");
    expect(plugin).toMatchObject({
      id: "new-provider",
      displayName: "New Provider",
      authType: "api-key",
      defaultBaseUrl: "https://new.api.com/v1",
      defaultApi: "openai-completions",
      models: [
        { id: "new-chat", name: "New Chat", reasoning: true, defaultThinkingLevel: "max" },
      ],
    });
    expect(plugin).not.toHaveProperty("api_key");
    expect(plugin).not.toHaveProperty("headers");

    const catalog = readProviderCatalog().providers;
    expect(catalog["new-provider"]).toEqual({
      api_key: "sk-new",
      headers: { "X-API-Key": "header-secret" },
    });

    const entry = reg.get("new-provider");
    expect(entry).toMatchObject({
      id: "new-provider",
      displayName: "New Provider",
      baseUrl: "https://new.api.com/v1",
      api: "openai-completions",
      source: { kind: "local-provider-plugin" },
    });

    expect(reg.getAllProvidersRaw()["new-provider"]).toMatchObject({
      api_key: "sk-new",
      headers: { "X-API-Key": "header-secret" },
      base_url: "https://new.api.com/v1",
      api: "openai-completions",
      models: [
        { id: "new-chat", name: "New Chat", reasoning: true, defaultThinkingLevel: "max" },
      ],
    });
  });

  it("把旧 catalog-only 自定义 provider 一次性迁移成本地 Provider Plugin", () => {
    writeProviderCatalog({
      catalogVersion: 2,
      providers: {
        "custom-old": {
          display_name: "Custom Old",
          auth_type: "api-key",
          api_key: "sk-old",
          headers: { Authorization: "Bearer old" },
          base_url: "https://old.example/v1",
          api: "openai-completions",
          models: ["old-chat"],
        },
      },
      capabilities: {},
      meta: {},
    });

    const reg = new ProviderRegistry(tmpDir);
    const entry = reg.get("custom-old");

    expect(entry).toMatchObject({
      id: "custom-old",
      displayName: "Custom Old",
      baseUrl: "https://old.example/v1",
      api: "openai-completions",
      source: { kind: "local-provider-plugin" },
    });
    expect(readLocalProviderPlugin("custom-old")).toMatchObject({
      id: "custom-old",
      displayName: "Custom Old",
      defaultBaseUrl: "https://old.example/v1",
      defaultApi: "openai-completions",
      models: ["old-chat"],
    });
    expect(readProviderCatalog().providers["custom-old"]).toEqual({
      api_key: "sk-old",
      headers: { Authorization: "Bearer old" },
    });
    expect(reg.getAllProvidersRaw()["custom-old"]).toMatchObject({
      api_key: "sk-old",
      base_url: "https://old.example/v1",
      api: "openai-completions",
      models: ["old-chat"],
    });
  });

  it("把中文名旧 catalog-only provider 迁移到 safe storage slug 且保留 provider id", () => {
    const providerId = "硅基流动";
    writeProviderCatalog({
      catalogVersion: 2,
      providers: {
        [providerId]: {
          display_name: "硅基流动",
          auth_type: "api-key",
          api_key: "sk-silicon",
          base_url: "https://api.siliconflow.cn/v1",
          api: "openai-completions",
          models: ["deepseek-ai/DeepSeek-V3.2"],
        },
      },
      capabilities: {},
      meta: {},
    });

    const reg = new ProviderRegistry(tmpDir);
    const entry = reg.get(providerId);

    expect(entry).toMatchObject({
      id: providerId,
      displayName: "硅基流动",
      baseUrl: "https://api.siliconflow.cn/v1",
      api: "openai-completions",
      source: { kind: "local-provider-plugin" },
    });

    const storageId = readOnlyLocalProviderPluginDir();
    expect(storageId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(storageId).not.toBe(providerId);

    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, "provider-plugins", storageId, "manifest.json"), "utf-8"));
    expect(manifest).toMatchObject({
      id: storageId,
      provider: providerId,
    });
    const providerFile = JSON.parse(fs.readFileSync(
      path.join(tmpDir, "provider-plugins", storageId, "providers", `${storageId}.json`),
      "utf-8",
    ));
    expect(providerFile).toMatchObject({
      id: providerId,
      displayName: "硅基流动",
      defaultBaseUrl: "https://api.siliconflow.cn/v1",
    });
    expect(readProviderCatalog().providers[providerId]).toEqual({
      api_key: "sk-silicon",
    });
  });

  it("merges local provider plugin model metadata when catalog overlay only has bare ids", () => {
    writeAddedModels({});
    const reg = new ProviderRegistry(tmpDir);

    reg.saveProvider("custom-vl", {
      display_name: "Custom VL",
      auth_type: "api-key",
      api_key: "sk-vl",
      base_url: "https://vl.example/v1",
      api: "openai-completions",
      models: [{
        id: "vl-model",
        name: "VL Model",
        context: 128000,
        maxOutput: 16000,
        image: true,
        video: true,
        audio: true,
        reasoning: true,
      }],
    });

    const catalog = readProviderCatalog();
    catalog.providers["custom-vl"].models = ["vl-model"];
    writeProviderCatalog(catalog);

    const reloaded = new ProviderRegistry(tmpDir);
    const model = reloaded.getAllProvidersRaw()["custom-vl"].models[0];
    expect(model).toMatchObject({
      id: "vl-model",
      name: "VL Model",
      context: 128000,
      maxOutput: 16000,
      image: true,
      video: true,
      audio: true,
      reasoning: true,
    });
  });

  it("replaces local provider plugin models when an explicit model list is saved", () => {
    writeAddedModels({});
    const reg = new ProviderRegistry(tmpDir);

    reg.saveProvider("custom-local", {
      display_name: "Custom Local",
      auth_type: "api-key",
      api_key: "sk-local",
      base_url: "https://local.example/v1",
      api: "openai-completions",
      models: [
        { id: "keep-model", name: "Keep Model", context: 128000, image: true },
        { id: "drop-model", name: "Drop Model", reasoning: true },
      ],
    });

    reg.saveProvider("custom-local", { models: ["keep-model"] });

    expect(readLocalProviderPlugin("custom-local").models).toEqual([
      { id: "keep-model", name: "Keep Model", context: 128000, image: true },
    ]);

    const reloaded = new ProviderRegistry(tmpDir);
    expect(reloaded.getProviderModels("custom-local")).toEqual(["keep-model"]);
  });

  it("removes local provider plugin models without resurrecting them after reload", () => {
    writeAddedModels({});
    const reg = new ProviderRegistry(tmpDir);

    reg.saveProvider("custom-local", {
      display_name: "Custom Local",
      auth_type: "api-key",
      api_key: "sk-local",
      base_url: "https://local.example/v1",
      api: "openai-completions",
      models: [
        { id: "keep-model", name: "Keep Model", image: true },
        { id: "drop-model", name: "Drop Model", reasoning: true },
      ],
    });

    reg.removeModel("custom-local", "drop-model");

    expect(readLocalProviderPlugin("custom-local").models).toEqual([
      { id: "keep-model", name: "Keep Model", image: true },
    ]);

    const reloaded = new ProviderRegistry(tmpDir);
    expect(reloaded.getProviderModels("custom-local")).toEqual(["keep-model"]);
  });

  it("更新已有 provider 的配置（合并）", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "sk-old",
        base_url: "https://old.api.com/v1",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    reg.saveProvider("test-provider", {
      api_key: "sk-new",
      base_url: "https://new.api.com/v1",
    });

    const persisted = readAddedModels();
    expect(persisted["test-provider"].api_key).toBe("sk-new");
    expect(persisted["test-provider"].base_url).toBe("https://new.api.com/v1");
    // 原有的 models 保留
    expect(persisted["test-provider"].models).toEqual(["model-a"]);
  });

  it("写入后缓存失效，下次 get() 反映新值", () => {
    writeAddedModels({});
    const reg = makeRegistry();
    reg.saveProvider("test-provider", {
      api_key: "sk-saved",
      base_url: "https://saved.api.com/v1",
    });
    // 触发 reload
    const entry = reg.get("test-provider");
    expect(entry).toBeTruthy();
    expect(entry.baseUrl).toBe("https://saved.api.com/v1");
  });

  it("拒绝把官方 DeepSeek provider id 保存成模型", () => {
    writeAddedModels({
      deepseek: {
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["deepseek-v4-pro"],
      },
    });
    const reg = new ProviderRegistry(tmpDir);

    expect(() => reg.saveProvider("deepseek", { models: ["deepseek"] }))
      .toThrow(/deepseek.*provider.*model/i);

    const persisted = readAddedModels();
    expect(persisted.deepseek.models).toEqual(["deepseek-v4-pro"]);
  });

  it("内置 provider 首次保存空 models 时填充默认模型列表", () => {
    writeAddedModels({});
    const reg = new ProviderRegistry(tmpDir);

    reg.saveProvider("mimo", {
      api_key: "sk-mimo",
      base_url: "https://api.xiaomimimo.com/v1",
      api: "openai-completions",
      seed_default_models: true,
    });

    const persisted = readAddedModels();
    expect(persisted.mimo.models).toEqual(reg.getDefaultModels("mimo"));
    expect(persisted.mimo.models).toEqual(expect.arrayContaining([
      "mimo-v2.5-pro",
      "mimo-v2.5",
      "mimo-v2.5-tts",
      "mimo-v2.5-tts-voicedesign",
      "mimo-v2.5-tts-voiceclone",
    ]));
    expect(persisted.mimo.seed_default_models).toBeUndefined();
  });

  it("MiMo Token Plan 首次保存空 models 时填充独立默认模型列表", () => {
    writeAddedModels({});
    const reg = new ProviderRegistry(tmpDir);

    reg.saveProvider("mimo-token-plan", {
      api_key: "tp-mimo",
      base_url: "https://token-plan-cn.xiaomimimo.com/v1",
      api: "openai-completions",
      seed_default_models: true,
    });

    const persisted = readAddedModels();
    expect(persisted["mimo-token-plan"].models).toEqual(reg.getDefaultModels("mimo-token-plan"));
    expect(persisted["mimo-token-plan"].models).toEqual(expect.arrayContaining([
      "mimo-v2.5-pro",
      "mimo-v2.5",
      "mimo-v2.5-tts",
    ]));
    expect(persisted["mimo-token-plan"].seed_default_models).toBeUndefined();
  });

  it("已有 provider 显式保存空 models 时保留用户选择", () => {
    writeAddedModels({
      mimo: {
        api_key: "sk-mimo",
        base_url: "https://api.xiaomimimo.com/v1",
        api: "openai-completions",
        models: ["mimo-v2-pro"],
      },
    });
    const reg = new ProviderRegistry(tmpDir);

    reg.saveProvider("mimo", { models: [] });

    const persisted = readAddedModels();
    expect(persisted.mimo.models).toEqual([]);
  });
});

// ── updateModelEntry type field ───────────────────────────────────────────────

describe("updateModelEntry type field", () => {
  it("accepts type in updateModelEntry whitelist", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    reg.updateModelEntry("test-provider", "model-a", { type: "image" });

    const raw = readAddedModels();
    const entry = raw["test-provider"].models.find(
      m => (typeof m === "object" ? m.id : m) === "model-a"
    );
    expect(entry).toEqual({ id: "model-a", type: "image" });
  });

  it("persists audio and normalizes context/max output aliases in updateModelEntry", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: ["model-a"],
      },
    });
    const reg = makeRegistry();
    reg.updateModelEntry("test-provider", "model-a", {
      audio: true,
      contextWindow: 32768,
      maxTokens: 8192,
    });

    const raw = readAddedModels();
    const entry = raw["test-provider"].models.find(
      m => (typeof m === "object" ? m.id : m) === "model-a"
    );
    expect(entry).toEqual({
      id: "model-a",
      audio: true,
      context: 32768,
      maxOutput: 8192,
    });
  });

  it("persists validated local MiniCPM sampling metadata with context and output limits", () => {
    writeAddedModels({
      "test-provider": { api_key: "key-123", models: ["model-a"] },
    });
    const reg = makeRegistry();
    reg.updateModelEntry("test-provider", "model-a", {
      context: 65536,
      maxOutput: 4096,
      generation: { temperature: 0.35, topP: 0.8, topK: 40, minP: 0.05, repetitionPenalty: 1.1 },
    });

    expect(readAddedModels()["test-provider"].models).toContainEqual({
      id: "model-a",
      context: 65536,
      maxOutput: 4096,
      generation: { temperature: 0.35, topP: 0.8, topK: 40, minP: 0.05, repetitionPenalty: 1.1 },
    });
  });

  it("caps MiniCPM5 local context metadata at 32K", () => {
    writeAddedModels({
      "minicpm5-local": {
        base_url: "http://127.0.0.1:8080/v1",
        models: ["default_model"],
      },
    });
    const reg = makeRegistry({
      id: "minicpm5-local",
      displayName: "MiniCPM5 local",
      authType: "none",
      defaultBaseUrl: "http://127.0.0.1:8080/v1",
    });
    reg.updateModelEntry("minicpm5-local", "default_model", { context: 65_536 });

    const entry = readAddedModels()["minicpm5-local"].models[0];
    expect(entry).toMatchObject({ id: "default_model", context: 32_768 });
  });

  it("persists controlled protocol capabilities and filters unknown compat fields", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: [{ id: "model-a", compat: { hanaVideoInput: true } }],
      },
    });
    const reg = makeRegistry();
    reg.updateModelEntry("test-provider", "model-a", {
      compat: {
        thinkingFormat: "qwen",
        reasoningProfile: "mimo-openai",
        unsupportedWireFlag: "drop-me",
      },
      visionCapabilities: {
        grounding: true,
        boxes: true,
        points: true,
        coordinateSpace: "norm-1000",
        boxOrder: "xyxy",
        outputFormat: "qwen",
        groundingMode: "prompted",
        extraShape: "drop-me",
      },
    });

    const raw = readAddedModels();
    const entry = raw["test-provider"].models.find(
      m => (typeof m === "object" ? m.id : m) === "model-a"
    );
    expect(entry.compat).toEqual({
      hanaVideoInput: true,
      thinkingFormat: "qwen",
      reasoningProfile: "mimo-openai",
    });
    expect(entry.visionCapabilities).toEqual({
      grounding: true,
      boxes: true,
      points: true,
      coordinateSpace: "norm-1000",
      boxOrder: "xyxy",
      outputFormat: "qwen",
      groundingMode: "prompted",
    });
  });

  it("persists an explicit tool use contract as model metadata", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: ["tool-model"],
      },
    });
    const reg = makeRegistry();

    reg.updateModelEntry("test-provider", "tool-model", {
      toolUse: {
        supportsTools: true,
        dialect: "anthropic",
        supportsParallelToolCalls: true,
        supportsForcedToolChoice: true,
        supportsServerTools: false,
        toolResultFormat: "content_block",
        unknown: "drop-me",
      },
    });

    const raw = readAddedModels();
    const entry = raw["test-provider"].models.find(
      m => (typeof m === "object" ? m.id : m) === "tool-model"
    );
    expect(entry.toolUse).toEqual({
      supportsTools: true,
      dialect: "anthropic",
      supportsParallelToolCalls: true,
      supportsForcedToolChoice: true,
      supportsServerTools: false,
      toolResultFormat: "content_block",
    });
  });

  it("rejects malformed tool use contracts instead of applying a default dialect", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: ["tool-model"],
      },
    });
    const reg = makeRegistry();

    expect(() => reg.updateModelEntry("test-provider", "tool-model", {
      toolUse: {
        supportsTools: true,
        dialect: "surprise-wire-format",
        toolResultFormat: "message",
      },
    })).toThrow(/invalid toolUse contract/i);
  });
});

// ── media model CRUD ─────────────────────────────────────────────────────────

describe("media model CRUD", () => {
  it("adds image models to media.image_generation instead of chat models", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: ["chat-model"],
      },
    });
    const reg = makeRegistry({
      runtime: { kind: "http", protocolId: "test-images" },
      capabilities: {
        media: {
          imageGeneration: {
            models: [],
          },
        },
      },
    });

    reg.addMediaModel("test-provider", "image_generation", {
      id: "image-model",
      displayName: "Image Model",
      protocolId: "test-images",
    });

    const raw = readAddedModels();
    expect(raw["test-provider"].models).toEqual(["chat-model"]);
    expect(raw["test-provider"].media.image_generation.models).toEqual([
      { id: "image-model", displayName: "Image Model", protocolId: "test-images" },
    ]);
  });

  it("updates and removes image models from media.image_generation", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: ["chat-model"],
        media: {
          image_generation: {
            models: [{ id: "image-model", protocolId: "test-images" }],
          },
        },
      },
    });
    const reg = makeRegistry({
      runtime: { kind: "http", protocolId: "test-images" },
      capabilities: {
        media: {
          imageGeneration: {
            models: [],
          },
        },
      },
    });

    reg.updateMediaModelEntry("test-provider", "image_generation", "image-model", {
      displayName: "Renamed Image Model",
      inputs: ["text", "image"],
    });
    expect(readAddedModels()["test-provider"].media.image_generation.models).toEqual([
      {
        id: "image-model",
        protocolId: "test-images",
        displayName: "Renamed Image Model",
        inputs: ["text", "image"],
      },
    ]);

    reg.removeMediaModel("test-provider", "image_generation", "image-model");
    expect(readAddedModels()["test-provider"].media.image_generation.models).toEqual([]);
  });

  it("infers the media protocol for custom model ids added from settings", () => {
    writeAddedModels({
      dashscope: {
        api_key: "dash-key",
      },
    });
    const reg = makeRegistry();

    reg.addMediaModel("dashscope", "image_generation", {
      id: "qwen-image-2.0-pro",
    });

    expect(readAddedModels().dashscope.media.image_generation.models).toEqual([
      { id: "qwen-image-2.0-pro", displayName: "qwen-image-2.0-pro", protocolId: "dashscope-qwen-multimodal-image" },
    ]);
  });
});

// ── getModelsByType ───────────────────────────────────────────────────────────

describe("getModelsByType", () => {
  it("returns only image models for a provider", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: [
          "chat-model",
          { id: "image-model", type: "image" },
        ],
      },
    });
    const reg = makeRegistry();
    const imageModels = reg.getModelsByType("test-provider", "image");
    expect(imageModels).toHaveLength(1);
    expect(imageModels[0].id).toBe("image-model");
  });

  it("returns empty array for provider with no image models", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-123",
        models: ["chat-model"],
      },
    });
    const reg = makeRegistry();
    expect(reg.getModelsByType("test-provider", "image")).toEqual([]);
  });
});

// ── getAllModelsByType ─────────────────────────────────────────────────────────

describe("getAllModelsByType", () => {
  it("aggregates image models across providers", () => {
    writeAddedModels({
      "test-provider": {
        api_key: "key-a",
        models: [{ id: "img-a", type: "image" }],
      },
      "other-provider": {
        api_key: "key-b",
        models: [{ id: "img-b", type: "image" }, "chat-b"],
      },
    });
    const reg = makeRegistry();
    reg._plugins.set("other-provider", {
      id: "other-provider", displayName: "Other", authType: "api-key",
      defaultBaseUrl: "https://other.com", defaultApi: "openai-completions",
    });

    const all = reg.getAllModelsByType("image");
    expect(all).toHaveLength(2);
    expect(all.map(m => m.id).sort()).toEqual(["img-a", "img-b"]);
    expect(all.every(m => m.provider)).toBe(true);
  });
});

// ── removeProvider ───────────────────────────────────────────────────────────

describe("removeProvider", () => {
  it("删除 provider 条目", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x" },
      "keep-me": { api_key: "sk-y" },
    });
    const reg = makeRegistry();
    reg.removeProvider("test-provider");

    const persisted = readAddedModels();
    expect(persisted["test-provider"]).toBeUndefined();
    expect(persisted["keep-me"]).toBeDefined();
  });

  it("records an explicit deletion tombstone and clears it when provider is saved again", () => {
    writeAddedModels({
      "test-provider": { api_key: "sk-x" },
    });
    const reg = makeRegistry();

    reg.removeProvider("test-provider");
    expect(readProviderCatalogMeta().deletedProviders).toContain("test-provider");

    reg.saveProvider("test-provider", { api_key: "sk-new" });
    expect(readProviderCatalogMeta().deletedProviders || []).not.toContain("test-provider");
    expect(readAddedModels()["test-provider"].api_key).toBe("sk-new");
  });

  it("删除不存在的 provider 不报错", () => {
    writeAddedModels({});
    const reg = makeRegistry();
    expect(() => reg.removeProvider("nonexistent")).not.toThrow();
  });
});
