/**
 * model-sync.js 单元测试
 *
 * 测试：Provider Catalog provider configs → models.json 单向投影
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";

// mock known-models 词典查询：provider + model 二级结构，未命中时再查通用 fallback
const KNOWN_MODELS = {
  dashscope: {
    "qwen3.5-flash": {
      name: "Qwen3.5 Flash",
      context: 131072,
      maxOutput: 8192,
      image: true,
      reasoning: true,
      quirks: ["enable_thinking"],
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "qwen", groundingMode: "native" },
    },
    "qwen3.6-plus": {
      name: "Qwen3.6 Plus",
      context: 1000000,
      maxOutput: 65536,
      image: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "qwen", groundingMode: "native" },
    },
    "qwen3-vl-plus": {
      name: "Qwen3 VL Plus",
      context: 262144,
      maxOutput: 32768,
      image: true,
      video: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "qwen", groundingMode: "native" },
    },
  },
  deepseek: {
    "deepseek-chat": { name: "DeepSeek Chat", context: 128000, maxOutput: 8192 },
    "deepseek-v4-pro": { name: "DeepSeek V4 Pro", context: 1000000, maxOutput: 384000, reasoning: true, xhigh: true },
  },
  zhipu: {
    "glm-4.7-flash": { name: "GLM-4.7 Flash", context: 200000, maxOutput: 128000, reasoning: true },
  },
  "zhipu-coding": {
    "glm-5.2": { name: "GLM-5.2", context: 1000000, maxOutput: 131072, image: false, reasoning: true, xhigh: true },
  },
  volcengine: {
    "doubao-seed-2-0-pro-260215": {
      name: "Doubao Seed 2.0 Pro",
      context: 262144,
      maxOutput: 16384,
      image: true,
      reasoning: true,
    },
  },
  "opencode-go": {
    "glm-5.2": {
      name: "GLM-5.2",
      context: 1000000,
      maxOutput: 131072,
      image: false,
      reasoning: true,
      xhigh: true,
      compat: { thinkingFormat: "zhipu", reasoningProfile: "zhipu-openai" },
      toolUse: { supportsTools: true, dialect: "openai", toolResultFormat: "message" },
    },
  },
  anthropic: {
    "claude-opus-5": {
      name: "Claude Opus 5",
      context: 1000000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
      xhigh: true,
      compat: { thinkingFormat: "anthropic", reasoningProfile: "anthropic-adaptive-only" },
    },
    "claude-sonnet-5": {
      name: "Claude Sonnet 5",
      context: 1000000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
      xhigh: true,
      compat: { thinkingFormat: "anthropic", reasoningProfile: "anthropic-adaptive-only" },
    },
    "claude-fable-5": {
      name: "Claude Fable 5",
      context: 1000000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
      xhigh: true,
      compat: { thinkingFormat: "anthropic", reasoningProfile: "anthropic-adaptive-only" },
    },
  },
  openai: {
    "gpt-4o": {
      name: "GPT-4o",
      context: 128000,
      maxOutput: 16384,
      image: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "anchor", groundingMode: "prompted" },
    },
    "gpt-audio-mini": {
      name: "GPT Audio Mini",
      context: 128000,
      maxOutput: 16384,
      audio: true,
    },
    "gpt-image-1": { name: "GPT Image 1", type: "image" },
  },
  gemini: {
    "gemini-3-flash-preview": {
      name: "Gemini 3 Flash Preview",
      context: 1048576,
      maxOutput: 65535,
      image: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: false, coordinateSpace: "norm-1000", boxOrder: "yxyx", outputFormat: "gemini", groundingMode: "native" },
    },
  },
  "kimi-coding": {
    k3: {
      name: "Kimi K3",
      context: 1048576,
      image: true,
      reasoning: true,
      thinkingLevels: ["medium", "high", "max"],
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "low",
        high: "high",
        xhigh: "max",
      },
      defaultThinkingLevel: "max",
    },
    "k3-256k": {
      name: "Kimi K3 256K",
      context: 262144,
      image: true,
      reasoning: true,
      thinkingLevels: ["medium", "high", "max"],
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "low",
        high: "high",
        xhigh: "max",
      },
      defaultThinkingLevel: "high",
    },
    "kimi-for-coding": {
      name: "Kimi for Coding",
      context: 262144,
      maxOutput: 32768,
      image: true,
      reasoning: true,
      thinkingLevels: ["off", "low", "high", "max"],
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "high",
        high: "high",
        xhigh: "max",
      },
      defaultThinkingLevel: "high",
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "anchor", groundingMode: "prompted" },
    },
    "kimi-k2.6": {
      name: "Kimi K2.6",
      context: 262144,
      maxOutput: 98304,
      image: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "anchor", groundingMode: "prompted" },
    },
  },
  moonshot: {
    "kimi-k2.6": {
      name: "Kimi K2.6",
      context: 262144,
      maxOutput: 98304,
      image: true,
      video: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "anchor", groundingMode: "prompted" },
    },
  },
  minimax: {
    "MiniMax-M2.7": { name: "MiniMax M2.7", context: 204800, maxOutput: 131072, reasoning: true },
  },
  mimo: {
    "mimo-v2.5": {
      name: "MiMo V2.5",
      context: 1048576,
      maxOutput: 131072,
      image: true,
      video: true,
      audio: true,
      reasoning: true,
    },
  },
  openrouter: {
    "anthropic/claude-opus-5": {
      name: "Anthropic/Claude Opus 5",
      context: 1000000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
      xhigh: true,
      compat: { thinkingFormat: "openrouter", reasoningProfile: "openrouter-anthropic-adaptive" },
    },
    "anthropic/claude-sonnet-5": {
      name: "Anthropic/Claude Sonnet 5",
      context: 1000000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
      xhigh: true,
      compat: { thinkingFormat: "openrouter", reasoningProfile: "openrouter-anthropic-adaptive" },
    },
    "anthropic/claude-fable-5": {
      name: "Anthropic/Claude Fable 5",
      context: 1000000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
      xhigh: true,
      compat: { thinkingFormat: "openrouter", reasoningProfile: "openrouter-anthropic-adaptive" },
    },
    "deepseek/deepseek-v3.2": {
      name: "Deepseek/Deepseek V3.2",
      context: 163840,
      maxOutput: 163840,
      reasoning: true,
    },
    "xiaomi/mimo-v2-flash": {
      name: "Xiaomi/Mimo V2 Flash",
      context: 262144,
      maxOutput: 16384,
      reasoning: true,
    },
  },
  // 兼容读验证：legacy-vision 模型词典里用旧字段 vision，model-sync 应当识别并投影为 input
  legacy: {
    "legacy-vision-model": { name: "Legacy Vision Model", context: 32000, vision: true },
  },
};

const GENERIC_MODEL_FALLBACKS = {
  "kimi-k2.6": {
    name: "Kimi K2.6",
    context: 262144,
    maxOutput: 98304,
    image: true,
    reasoning: true,
    visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "anchor", groundingMode: "prompted" },
  },
  "MiniMax-M3": {
    name: "MiniMax M3",
    context: 1000000,
    maxOutput: 524288,
    image: true,
    reasoning: true,
  },
};

vi.mock("../shared/known-models.js", () => ({
  lookupKnownProvider(provider, modelId) {
    const dict = KNOWN_MODELS[provider];
    if (!dict || typeof modelId !== "string") return null;
    const candidates = [modelId, ...(modelId.includes("/") ? [modelId.split("/").pop()] : [])];
    for (const id of candidates) {
      if (dict[id]) return dict[id];
      const lowerId = id.toLowerCase();
      const match = Object.entries(dict).find(([key]) => key.toLowerCase() === lowerId)?.[1];
      if (match) return match;
    }
    return null;
  },
  lookupKnown(provider, modelId) {
    const lookup = (dict, id) => {
      if (!dict || typeof id !== "string") return null;
      if (dict[id]) return dict[id];
      const lowerId = id.toLowerCase();
      return Object.entries(dict).find(([key]) => key.toLowerCase() === lowerId)?.[1] || null;
    };
    if (provider) {
      const exact = lookup(KNOWN_MODELS[provider], modelId);
      if (exact) return exact;
    }
    const bare = modelId.includes("/") ? modelId.split("/").pop() : null;
    if (bare && provider) {
      const exactBare = lookup(KNOWN_MODELS[provider], bare);
      if (exactBare) return exactBare;
    }
    const fallback = lookup(GENERIC_MODEL_FALLBACKS, modelId);
    if (fallback) return fallback;
    if (bare) {
      const fallbackBare = lookup(GENERIC_MODEL_FALLBACKS, bare);
      if (fallbackBare) return fallbackBare;
    }
    return null;
  },
}));

const tmpDir = path.join(os.tmpdir(), "hana-test-model-sync-" + Date.now());
let modelsJsonPath;
let authJsonPath;

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  modelsJsonPath = path.join(tmpDir, "models.json");
  authJsonPath = path.join(tmpDir, "auth.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadSync() {
  const mod = await import("../core/model-sync.ts");
  return mod.syncModels;
}

function readProviderCatalogProviders() {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, "provider-catalog.json"), "utf-8")).providers || {};
}

describe("syncModels", () => {
  it("writes providers with credentials and models to models.json", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3.5-flash"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope).toBeDefined();
    expect(result.providers.dashscope.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(result.providers.dashscope.api).toBe("openai-completions");
    expect(result.providers.dashscope.apiKey).toBe("hana-runtime-api-key:dashscope");
    expect(result.providers.dashscope.models).toHaveLength(1);
    expect(result.providers.dashscope.models[0].id).toBe("qwen3.5-flash");
  });

  it("keeps auth-storage model override headers while stripping provider-level headers", async () => {
    const syncModels = await loadSync();

    const providers = {
      "xai-oauth": {
        base_url: "https://cli-chat-proxy.grok.com/v1",
        api: "openai-responses",
        headers: {
          "x-xai-token-auth": "xai-grok-cli",
          "x-grok-client-version": "0.2.95",
          "x-grok-client-identifier": "hana",
          Authorization: "Bearer should-not-project",
        },
        models: [{
          id: "grok-4.5",
          api: "openai-responses",
        }],
      },
    };

    syncModels(providers, {
      modelsJsonPath,
      chatProjectionPlans: {
        "xai-oauth": {
          sourceProviderId: "xai-oauth",
          runtimeProviderId: "xai-oauth",
          projection: "models-json",
          credentialSource: "auth-storage",
          modelExecutionHeaders: {
            "grok-4.5": { "x-grok-model-override": "grok-4.5" },
          },
        },
      },
    });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["xai-oauth"].headers).toBeUndefined();
    expect(result.providers["xai-oauth"].apiKey).toBeUndefined();
    expect(result.providers["xai-oauth"].models[0]).toMatchObject({
      id: "grok-4.5",
      headers: { "x-grok-model-override": "grok-4.5" },
    });
  });

  it("projects user-entered api keys as runtime refs so Pi SDK does not resolve env names", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "public",
        models: ["my-custom-model"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.custom.apiKey).toBe("hana-runtime-api-key:custom");
  });

  it("projects per-model default thinking level into runtime model metadata", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [
          { id: "reasoning-model", reasoning: true, defaultThinkingLevel: "high" },
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.custom.models[0]).toMatchObject({
      id: "reasoning-model",
      defaultThinkingLevel: "high",
    });
  });

  it("projects provider model_defaults into runtime model metadata", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["reasoning-model"],
        model_defaults: {
          "reasoning-model": { thinking_level: "high" },
        },
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.custom.models[0]).toMatchObject({
      id: "reasoning-model",
      defaultThinkingLevel: "high",
    });
  });

  it("projects explicit tool use contracts into runtime model metadata", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [
          {
            id: "tool-model",
            toolUse: {
              supportsTools: true,
              dialect: "openai",
              supportsParallelToolCalls: true,
              toolResultFormat: "message",
            },
          },
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.custom.models[0].toolUse).toEqual({
      supportsTools: true,
      dialect: "openai",
      supportsParallelToolCalls: true,
      toolResultFormat: "message",
    });
  });

  it("rejects malformed tool use contracts instead of silently falling back", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [
          {
            id: "tool-model",
            toolUse: {
              supportsTools: true,
              dialect: "surprise-wire-format",
              toolResultFormat: "message",
            },
          },
        ],
      },
    };

    expect(() => syncModels(providers, { modelsJsonPath })).toThrow(/invalid toolUse contract/i);
  });

  it("skips providers without api_key (and not localhost/OAuth)", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        // no api_key
        models: ["qwen3.5-flash"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope).toBeUndefined();
    expect(Object.keys(result.providers)).toHaveLength(0);
  });

  it("skips providers without models", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        // no models
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope).toBeUndefined();
  });

  it("skips providers without base_url", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        // no base_url
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3.5-flash"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope).toBeUndefined();
  });

  it("enriches model metadata from known-models dictionary", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3.5-flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.dashscope.models[0];
    expect(model.name).toBe("Qwen3.5 Flash");
    expect(model.contextWindow).toBe(131072);
    expect(model.maxTokens).toBe(8192);
    expect(model.input).toEqual(["text", "image"]);
    // 运行时 Model 对象不再挂 vision 字段（Pi SDK 标准用 input 数组）
    expect(model.vision).toBeUndefined();
    expect(model.reasoning).toBe(true);
    expect(model.quirks).toEqual(["enable_thinking"]);
    expect(model.compat.thinkingFormat).toBe("qwen");
  });

  it("preserves user-declared max thinking capability for local model objects", async () => {
    const syncModels = await loadSync();

    const providers = {
      zhipu: {
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        api: "openai-completions",
        api_key: "sk-test",
        models: [{
          id: "local-max-capable-model",
          name: "Local Max Capable Model",
          reasoning: true,
          xhigh: true,
          defaultThinkingLevel: "max",
        }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.zhipu.models[0];
    expect(model.id).toBe("local-max-capable-model");
    expect(model.reasoning).toBe(true);
    expect(model.xhigh).toBe(true);
    expect(model.defaultThinkingLevel).toBe("max");
  });

  it("projects native and prompted visual grounding family formats", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3-vl-plus", "qwen3.5-flash", "qwen3.6-plus"],
      },
      openai: {
        base_url: "https://api.openai.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["gpt-4o"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope.models[0].visionCapabilities).toEqual({
      grounding: true,
      boxes: true,
      points: true,
      coordinateSpace: "norm-1000",
      boxOrder: "xyxy",
      outputFormat: "qwen",
      groundingMode: "native",
    });
    expect(result.providers.dashscope.models[1].visionCapabilities).toMatchObject({
      outputFormat: "qwen",
      groundingMode: "native",
    });
    expect(result.providers.dashscope.models[2].visionCapabilities).toMatchObject({
      outputFormat: "qwen",
      groundingMode: "native",
    });
    expect(result.providers.openai.models[0].visionCapabilities).toMatchObject({
      outputFormat: "anchor",
      groundingMode: "prompted",
    });
  });

  it("accepts explicit user visual grounding capabilities for custom image models", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [{
          id: "custom-grounded-vl",
          image: true,
          visionCapabilities: {
            grounding: true,
            boxes: true,
            points: false,
            coordinateSpace: "norm-1000",
            boxOrder: "yxyx",
            outputFormat: "gemini",
            groundingMode: "native",
          },
        }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.custom.models[0].visionCapabilities).toEqual({
      grounding: true,
      boxes: true,
      points: false,
      coordinateSpace: "norm-1000",
      boxOrder: "yxyx",
      outputFormat: "gemini",
      groundingMode: "native",
    });
  });

  it("enriches provider models from generic fallbacks when provider-specific metadata is missing", async () => {
    const syncModels = await loadSync();

    const providers = {
      volcengine: {
        base_url: "https://ark.cn-beijing.volces.com/api/v3",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["kimi-k2.6"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.volcengine.models[0];
    expect(model.name).toBe("Kimi K2.6");
    expect(model.contextWindow).toBe(262144);
    expect(model.maxTokens).toBe(98304);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.reasoning).toBe(true);
  });

  it("normalizes legacy Kimi Coding Plan transport without rewriting the configured model id", async () => {
    const syncModels = await loadSync();

    const providers = {
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: ["kimi-k2.6"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["kimi-coding"]).toMatchObject({
      baseUrl: "https://api.kimi.com/coding/v1",
      api: "openai-completions",
      apiKey: "hana-runtime-api-key:kimi-coding",
    });
    expect(result.providers["kimi-coding"].models[0]).toMatchObject({
      id: "kimi-k2.6",
      name: "Kimi K2.6",
      contextWindow: 262144,
      maxTokens: 98304,
      input: ["text", "image"],
      reasoning: true,
      headers: { "User-Agent": "KimiCLI/1.5" },
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "kimi",
        reasoningProfile: "kimi-openai",
      },
    });
    expect(result.providers["kimi-coding"].modelOverrides).toBeUndefined();
  });

  it("preserves user metadata for the configured Kimi Coding model id", async () => {
    const syncModels = await loadSync();

    const providers = {
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: [{ id: "kimi-for-coding", name: "Kimi 自定义显示名", maxOutput: 16000, image: true, video: true, xhigh: true }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["kimi-coding"].modelOverrides).toBeUndefined();
    expect(result.providers["kimi-coding"].models[0]).toMatchObject({
      id: "kimi-for-coding",
      name: "Kimi 自定义显示名",
      maxTokens: 16000,
      xhigh: true,
      input: ["text", "image"],
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "kimi",
        reasoningProfile: "kimi-openai",
        hanaVideoInput: true,
      },
    });
  });

  it("keeps distinct Kimi model ids and user metadata isolated from the Pi default model", async () => {
    const syncModels = await loadSync();

    const providers = {
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: [
          "kimi-for-coding",
          {
            id: "k3",
            name: "User K3 Alias",
            context: 777777,
            maxOutput: 12345,
            image: false,
            reasoning: false,
          },
          "kimi-k2.6",
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const models = result.providers["kimi-coding"].models;
    expect(models.map((model) => model.id)).toEqual([
      "kimi-for-coding",
      "k3",
      "kimi-k2.6",
    ]);
    expect(models.find((model) => model.id === "k3")).toMatchObject({
      id: "k3",
      name: "User K3 Alias",
      contextWindow: 777777,
      maxTokens: 12345,
      input: ["text"],
      reasoning: false,
      headers: { "User-Agent": "KimiCLI/1.5" },
    });
  });

  it("projects official K3 image metadata without inventing video or output limits", async () => {
    const syncModels = await loadSync();

    const providers = {
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["k3", "k3-256k"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const models = result.providers["kimi-coding"].models;
    expect(models[0]).toMatchObject({
      id: "k3",
      name: "Kimi K3",
      contextWindow: 1048576,
      input: ["text", "image"],
      reasoning: true,
      defaultThinkingLevel: "max",
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "low",
        high: "high",
        xhigh: "max",
      },
      headers: { "User-Agent": "KimiCLI/1.5" },
    });
    expect(models[1]).toMatchObject({
      id: "k3-256k",
      name: "Kimi K3 256K",
      contextWindow: 262144,
      input: ["text", "image"],
      reasoning: true,
      defaultThinkingLevel: "high",
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "low",
        high: "high",
        xhigh: "max",
      },
      headers: { "User-Agent": "KimiCLI/1.5" },
    });
    for (const model of models) {
      expect(model).not.toHaveProperty("maxTokens");
      expect(model).not.toHaveProperty("visionCapabilities");
      expect(model.compat).not.toHaveProperty("hanaVideoInput");
    }
  });

  it("treats future official Kimi Coding ids as reasoning-capable without borrowing model metadata", async () => {
    const syncModels = await loadSync();
    const providers = {
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["future-kimi-code-model"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers["kimi-coding"].models[0];
    expect(model).toMatchObject({
      id: "future-kimi-code-model",
      reasoning: true,
      input: ["text"],
      headers: { "User-Agent": "KimiCLI/1.5" },
      compat: {
        thinkingFormat: "kimi",
        reasoningProfile: "kimi-openai",
        reasoningReplay: {
          carrier: "reasoning_content",
          policy: "require-tool-call",
        },
      },
    });
    expect(model).not.toHaveProperty("maxTokens");
  });

  it("keeps Kimi OpenAI-compatible configs custom while reusing Pi request headers", async () => {
    const syncModels = await loadSync();

    const providers = {
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["kimi-for-coding"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers["kimi-coding"].models[0];
    expect(model.id).toBe("kimi-for-coding");
    expect(model.headers).toEqual({ "User-Agent": "KimiCLI/1.5" });
    expect(model.compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "kimi",
      reasoningProfile: "kimi-openai",
    });
  });

  it("keeps Kimi Coding on official OpenAI-compatible thinking while other Anthropic-compatible reasoning models use anthropic format", async () => {
    const syncModels = await loadSync();

    const providers = {
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: ["kimi-k2.6"],
      },
      minimax: {
        base_url: "https://api.minimaxi.com/anthropic",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: ["MiniMax-M2.7"],
      },
      "minimax-token-plan": {
        base_url: "https://api.minimaxi.com/anthropic",
        api: "anthropic-messages",
        api_key: "sk-token-plan",
        models: ["MiniMax-M3"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["kimi-coding"]).toMatchObject({
      baseUrl: "https://api.kimi.com/coding/v1",
      api: "openai-completions",
    });
    expect(result.providers["kimi-coding"].models[0]).toMatchObject({
      id: "kimi-k2.6",
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "kimi",
        reasoningProfile: "kimi-openai",
      },
    });
    expect(result.providers.minimax.models[0].compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "anthropic",
    });
    expect(result.providers["minimax-token-plan"].api).toBe("anthropic-messages");
    expect(result.providers["minimax-token-plan"].baseUrl).toBe("https://api.minimaxi.com/anthropic");
    expect(result.providers["minimax-token-plan"].apiKey).toBe("hana-runtime-api-key:minimax-token-plan");
    expect(result.providers["minimax-token-plan"].models[0]).toMatchObject({
      id: "MiniMax-M3",
      name: "MiniMax M3",
      input: ["text", "image"],
      contextWindow: 1000000,
      maxTokens: 524288,
      reasoning: true,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "anthropic",
      },
    });
    expect(result.providers["minimax-token-plan"].models[0].compat?.hanaVideoInput).toBeUndefined();
  });

  it("marks DeepSeek V4 on the Anthropic endpoint with an explicit reasoning profile", async () => {
    const syncModels = await loadSync();

    const providers = {
      deepseek: {
        base_url: "https://api.deepseek.com/anthropic",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: ["deepseek-v4-pro"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.deepseek.models[0].compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "anthropic",
      reasoningProfile: "deepseek-v4-anthropic",
    });
  });

  it("does not infer thinkingFormat from Anthropic protocol without reasoning capability", async () => {
    const syncModels = await loadSync();

    const providers = {
      "custom-anthropic-proxy": {
        base_url: "https://example.test/anthropic",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: [{ id: "plain-chat", reasoning: false }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["custom-anthropic-proxy"].models[0].compat).toEqual({
      supportsDeveloperRole: false,
    });
  });

  it("sets input: ['text'] for models without image modality (no vision field on Model)", async () => {
    const syncModels = await loadSync();

    const providers = {
      deepseek: {
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["deepseek-chat"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.deepseek.models[0];
    expect(model.vision).toBeUndefined();
    expect(model.reasoning).toBe(false);
    expect(model.input).toEqual(["text"]);
  });

  it("projects explicit video capability into Hana compat and keeps Pi input schema-compatible", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [
          { id: "custom-video", video: true },
          { id: "custom-multimodal", image: true, video: true },
          "custom-unknown",
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.custom.models.map((m) => [m.id, m.input, m.compat?.hanaVideoInput])).toEqual([
      ["custom-video", ["text"], true],
      ["custom-multimodal", ["text", "image"], true],
      ["custom-unknown", ["text"], undefined],
    ]);
  });

  it("projects explicit audio capability into Hana compat and keeps Pi input schema-compatible", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [
          { id: "custom-audio", audio: true },
          { id: "custom-full-modal", image: true, video: true, audio: true },
          "custom-unknown",
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.custom.models.map((m) => [m.id, m.input, m.compat?.hanaVideoInput, m.compat?.hanaAudioInput])).toEqual([
      ["custom-audio", ["text"], undefined, true],
      ["custom-full-modal", ["text", "image"], true, true],
      ["custom-unknown", ["text"], undefined, undefined],
    ]);
  });

  it("projects known OpenAI audio models into Hana compat without invalid Pi input", async () => {
    const syncModels = await loadSync();

    const providers = {
      openai: {
        base_url: "https://api.openai.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["gpt-audio-mini"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.openai.models[0]).toMatchObject({
      id: "gpt-audio-mini",
      input: ["text"],
      compat: { hanaAudioInput: true },
    });
  });

  it("projects known video-capable models into Hana compat without invalid Pi input", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3-vl-plus"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope.models[0].input).toEqual(["text", "image"]);
    expect(result.providers.dashscope.models[0].compat.hanaVideoInput).toBe(true);
  });

  it("projects Moonshot Kimi official video capability into Hana compat", async () => {
    const syncModels = await loadSync();

    const providers = {
      moonshot: {
        base_url: "https://api.moonshot.cn/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["kimi-k2.6"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.moonshot.models[0]).toMatchObject({
      id: "kimi-k2.6",
      input: ["text", "image"],
      compat: { hanaVideoInput: true },
    });
  });

  it("projects MiMo V2.5 full-modal metadata without invalid Pi input", async () => {
    const syncModels = await loadSync();

    const providers = {
      mimo: {
        base_url: "https://api.xiaomimimo.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["mimo-v2.5"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.mimo.models[0];
    expect(model).toMatchObject({
      id: "mimo-v2.5",
      name: "MiMo V2.5",
      input: ["text", "image"],
      contextWindow: 1048576,
      maxTokens: 131072,
      reasoning: true,
    });
    expect(model.compat).toMatchObject({
      supportsDeveloperRole: false,
      hanaVideoInput: true,
      hanaAudioInput: true,
      thinkingFormat: "qwen-chat-template",
      reasoningProfile: "mimo-openai",
    });
  });

  it("projects Xiaomi Token Plan MiMo models with MiMo thinking compat", async () => {
    const syncModels = await loadSync();

    const providers = {
      "xiaomi-token": {
        base_url: "https://token-plan-cn.xiaomimimo.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [{
          id: "mimo-v2.5-pro",
          context: 1048576,
          maxOutput: 65536,
          reasoning: true,
        }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers["xiaomi-token"].models[0];
    expect(model).toMatchObject({
      id: "mimo-v2.5-pro",
      input: ["text"],
      contextWindow: 1048576,
      maxTokens: 65536,
      reasoning: true,
    });
    expect(model.compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "qwen-chat-template",
      reasoningProfile: "mimo-openai",
    });
  });

  it("projects OpenRouter reasoning models with OpenRouter thinking compat without official provider profiles", async () => {
    const syncModels = await loadSync();

    const providers = {
      openrouter: {
        base_url: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["DeepSeek/DeepSeek-V3.2", "xiaomi/MiMo-V2-Flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const [deepseek, mimo] = result.providers.openrouter.models;
    expect(deepseek).toMatchObject({
      id: "DeepSeek/DeepSeek-V3.2",
      contextWindow: 163840,
      maxTokens: 163840,
      reasoning: true,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "openrouter",
      },
    });
    expect(deepseek.compat).not.toHaveProperty("reasoningProfile");

    expect(mimo).toMatchObject({
      id: "xiaomi/MiMo-V2-Flash",
      contextWindow: 262144,
      maxTokens: 16384,
      reasoning: true,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "openrouter",
      },
    });
    expect(mimo.compat).not.toHaveProperty("reasoningProfile");
  });

  it("projects Volcengine reasoning models with Volcengine thinking compat", async () => {
    const syncModels = await loadSync();

    const providers = {
      volcengine: {
        base_url: "https://ark.cn-beijing.volces.com/api/v3",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["doubao-seed-2-0-pro-260215"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.volcengine.models[0];
    expect(model).toMatchObject({
      id: "doubao-seed-2-0-pro-260215",
      reasoning: true,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "volcengine",
      },
    });
  });

  it("projects Claude 5 adaptive-only profiles for Anthropic Messages providers", async () => {
    const syncModels = await loadSync();

    const providers = {
      anthropic: {
        base_url: "https://api.anthropic.com",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.anthropic.models.map((model) => model.id)).toEqual([
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
    for (const model of result.providers.anthropic.models) {
      expect(model).toMatchObject({
        contextWindow: 1000000,
        maxTokens: 128000,
        input: ["text", "image"],
        reasoning: true,
        compat: {
          supportsDeveloperRole: false,
          thinkingFormat: "anthropic",
          reasoningProfile: "anthropic-adaptive-only",
        },
      });
    }
  });

  it("writes a custom entry when an Anthropic builtin has a model-level API override", async () => {
    const syncModels = await loadSync();
    const providers = {
      anthropic: {
        base_url: "https://compat.example/v1",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: [{
          id: "claude-sonnet-4-5",
          api: "openai-completions",
          context: 200000,
          maxOutput: 64000,
          image: true,
          reasoning: true,
        }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.anthropic.models[0]).toMatchObject({
      id: "claude-sonnet-4-5",
      api: "openai-completions",
      contextWindow: 200000,
      maxTokens: 64000,
    });
    expect(result.providers.anthropic.modelOverrides).toBeUndefined();
  });

  it("projects Claude 5 OpenRouter profiles without Anthropic Messages fields", async () => {
    const syncModels = await loadSync();

    const providers = {
      openrouter: {
        base_url: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [
          "anthropic/claude-fable-5",
          "anthropic/claude-opus-5",
          "anthropic/claude-sonnet-5",
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.openrouter.models.map((model) => model.id)).toEqual([
      "anthropic/claude-fable-5",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
    ]);
    for (const model of result.providers.openrouter.models) {
      expect(model).toMatchObject({
        contextWindow: 1000000,
        maxTokens: 128000,
        input: ["text", "image"],
        reasoning: true,
        compat: {
          supportsDeveloperRole: false,
          thinkingFormat: "openrouter",
          reasoningProfile: "openrouter-anthropic-adaptive",
        },
      });
    }
  });

  it("writes Pi-loadable models when Hana video capability is enabled", async () => {
    const syncModels = await loadSync();
    const { AuthStorage, createModelRegistry } = await import("../lib/pi-sdk/index.ts");

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3-vl-plus"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const registry = createModelRegistry(new (AuthStorage as any)(tmpDir), modelsJsonPath);
    const available = await registry.getAvailable();
    expect(available).toHaveLength(1);
    expect(available[0]).toMatchObject({
      id: "qwen3-vl-plus",
      provider: "dashscope",
      input: ["text", "image"],
      compat: { hanaVideoInput: true },
    });
  });

  it("rejects the official DeepSeek provider id before writing models.json", async () => {
    const syncModels = await loadSync();

    const providers = {
      deepseek: {
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["deepseek"],
      },
    };

    expect(() => syncModels(providers, { modelsJsonPath }))
      .toThrow(/deepseek.*provider.*model/i);
    expect(fs.existsSync(modelsJsonPath)).toBe(false);
  });

  it("accepts legacy 'vision' field in dictionary and projects to input array", async () => {
    const syncModels = await loadSync();
    const providers = {
      legacy: {
        base_url: "https://legacy.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["legacy-vision-model"],
      },
    };
    syncModels(providers, { modelsJsonPath });
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.legacy.models[0];
    expect(model.input).toEqual(["text", "image"]);
    expect(model.vision).toBeUndefined();
  });

  it("accepts legacy 'vision' field in user override and projects to input array", async () => {
    const syncModels = await loadSync();
    const providers = {
      deepseek: {
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [{ id: "deepseek-chat", vision: true }],  // legacy user override
      },
    };
    syncModels(providers, { modelsJsonPath });
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.deepseek.models[0];
    expect(model.input).toEqual(["text", "image"]);
    expect(model.vision).toBeUndefined();
  });

  it("handles model objects with user overrides (name, context, maxOutput)", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [
          { id: "qwen3.5-flash", name: "My Custom Qwen", context: 65536, maxOutput: 4096 },
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.dashscope.models[0];
    expect(model.id).toBe("qwen3.5-flash");
    expect(model.name).toBe("My Custom Qwen");
    expect(model.contextWindow).toBe(65536);
    expect(model.maxTokens).toBe(4096);
  });

  it("projects an edited local context window, output cap, and generation settings", async () => {
    const syncModels = await loadSync();
    syncModels({
      "minicpm5-local": {
        base_url: "http://127.0.0.1:8080/v1",
        api: "openai-completions",
        models: [{
          id: "default_model",
          context: 65536,
          maxOutput: 4096,
          generation: { temperature: 0.35, topP: 0.8, topK: 40, minP: 0.05, repetitionPenalty: 1.1 },
        }],
      },
    }, { modelsJsonPath });

    expect(JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8")).providers["minicpm5-local"].models[0]).toMatchObject({
      contextWindow: 32768,
      maxTokens: 4096,
      generation: { temperature: 0.35, topP: 0.8, topK: 40, minP: 0.05, repetitionPenalty: 1.1 },
    });
  });

  it("projects raw maxOutputTokens metadata and preserves alias priority", async () => {
    const syncModels = await loadSync();
    const providers = {
      "custom-output-alias": {
        base_url: "https://models.example/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [
          { id: "raw-alias-model", maxOutputTokens: 64000 },
          { id: "priority-model", maxOutput: 111, maxTokens: 222, maxOutputTokens: 333 },
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["custom-output-alias"].models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "raw-alias-model", maxTokens: 64000 }),
      expect.objectContaining({ id: "priority-model", maxTokens: 111 }),
    ]));
  });

  it("projects discovered custom provider model metadata without falling back to default context", async () => {
    const syncModels = await loadSync();

    const providers = {
      "custom-vllm": {
        base_url: "http://127.0.0.1:8000/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [
          {
            id: "custom-vllm-chat",
            name: "Custom vLLM Chat",
            context: 32768,
            maxOutput: 4096,
            image: true,
            video: true,
            audio: true,
            reasoning: true,
          },
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers["custom-vllm"].models[0];
    expect(model).toMatchObject({
      id: "custom-vllm-chat",
      name: "Custom vLLM Chat",
      contextWindow: 32768,
      maxTokens: 4096,
      input: ["text", "image"],
      reasoning: true,
      compat: {
        hanaVideoInput: true,
        hanaAudioInput: true,
      },
    });
    expect(model.contextWindow).not.toBe(128000);
  });

  it("uses atomic write (tmp + rename)", async () => {
    const syncModels = await loadSync();

    const renameSpy = vi.spyOn(fs, "renameSync");

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3.5-flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    // renameSync should have been called with a tmp path → final path
    expect(renameSpy).toHaveBeenCalledTimes(1);
    const [src, dest] = renameSpy.mock.calls[0];
    expect(dest).toBe(modelsJsonPath);
    expect(src).toMatch(/\.tmp$/);

    renameSpy.mockRestore();
  });

  it("returns false if no changes", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3.5-flash"],
      },
    };

    // first call: writes
    const changed1 = syncModels(providers, { modelsJsonPath });
    expect(changed1).toBe(true);

    // second call: same data, no change
    const changed2 = syncModels(providers, { modelsJsonPath });
    expect(changed2).toBe(false);
  });

  it("allows localhost providers without api_key", async () => {
    const syncModels = await loadSync();

    const providers = {
      ollama: {
        base_url: "http://localhost:11434/v1",
        api: "openai-completions",
        // no api_key — but localhost, should pass
        models: ["llama3"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama).toBeDefined();
    expect(result.providers.ollama.apiKey).toBe("local");
    expect(result.providers.ollama.models[0].id).toBe("llama3");
  });

  it("projects bare Ollama OpenAI-compatible base URLs to the /v1 runtime API root", async () => {
    const syncModels = await loadSync();

    const providers = {
      ollama: {
        base_url: "http://localhost:51434",
        api: "openai-completions",
        models: ["llama3"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama.baseUrl).toBe("http://localhost:51434/v1");
  });

  it("does not duplicate /v1 for Ollama OpenAI-compatible base URLs", async () => {
    const syncModels = await loadSync();

    const providers = {
      ollama: {
        base_url: "http://localhost:51434/v1/",
        api: "openai-completions",
        models: ["llama3"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama.baseUrl).toBe("http://localhost:51434/v1");
  });

  it("allows IPv6 loopback providers without api_key", async () => {
    const syncModels = await loadSync();

    const providers = {
      ollama: {
        base_url: "http://[::1]:11434/v1",
        api: "openai-completions",
        models: ["llama3"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama).toBeDefined();
    expect(result.providers.ollama.apiKey).toBe("local");
    expect(result.providers.ollama.models[0].id).toBe("llama3");
  });

  it("allows no-auth providers without api_key on remote base URLs", async () => {
    const syncModels = await loadSync();

    const providers = {
      ollama: {
        base_url: "http://192.168.1.20:11434/v1",
        api: "openai-completions",
        auth_type: "none",
        models: ["llama3"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama).toBeDefined();
    expect(result.providers.ollama.apiKey).toBe("local");
    expect(result.providers.ollama.models[0].id).toBe("llama3");
  });

  it("projects known Ollama vision model families as image-capable even when discovery saved bare ids", async () => {
    const syncModels = await loadSync();

    const providers = {
      ollama: {
        base_url: "http://localhost:11434/v1",
        api: "openai-completions",
        auth_type: "none",
        models: [
          "llava:latest",
          { id: "minicpm-v:8b", name: "MiniCPM-V 8B" },
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama.models.map((model) => [model.id, model.input])).toEqual([
      ["llava:latest", ["text", "image"]],
      ["minicpm-v:8b", ["text", "image"]],
    ]);
  });

  it("derives no-auth policy from ProviderRegistry for existing Ollama configs", async () => {
    const { ModelManager } = await import("../core/model-manager.ts");
    fs.writeFileSync(path.join(tmpDir, "added-models.yaml"), [
      "providers:",
      "  ollama:",
      "    base_url: http://192.168.1.20:11434/v1",
      "    api: openai-completions",
      "    models:",
      "      - llama3",
      "",
    ].join("\n"), "utf-8");

    const mm = new ModelManager({ hanakoHome: tmpDir });
    mm._modelRegistry = {
      refresh: vi.fn(),
      getAvailable: vi.fn().mockResolvedValue([{ id: "llama3", provider: "ollama" }]),
    };

    const changed = await mm.syncAndRefresh();

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama).toBeDefined();
    expect(result.providers.ollama.apiKey).toBe("local");
    expect(mm._modelRegistry.refresh).toHaveBeenCalledTimes(1);
    expect(mm.availableModels).toEqual([{ id: "llama3", provider: "ollama" }]);
  });

  it("stores model thinking defaults without narrowing builtin provider model availability", async () => {
    const { ModelManager } = await import("../core/model-manager.ts");
    fs.writeFileSync(path.join(tmpDir, "added-models.yaml"), "providers: {}\n", "utf-8");

    const mm = new ModelManager({ hanakoHome: tmpDir });
    mm._modelRegistry = {
      refresh: vi.fn(),
      getAvailable: vi.fn().mockResolvedValue([
        { id: "gpt-4o", provider: "openai" },
        { id: "gpt-4.1", provider: "openai" },
      ]),
    };
    await mm.refreshAvailable();

    const result = await mm.setModelDefaultThinkingLevel({ id: "gpt-4o", provider: "openai" }, "high");

    const providers = readProviderCatalogProviders();
    expect(providers.openai.models).toBeUndefined();
    expect(providers.openai.model_defaults).toEqual({
      "gpt-4o": { thinking_level: "high" },
    });
    expect(result.thinkingLevel).toBe("high");
    expect(mm.availableModels.map(m => m.id)).toEqual(["gpt-4o", "gpt-4.1"]);
    expect(mm.availableModels.find(m => m.id === "gpt-4o")?.defaultThinkingLevel).toBe("high");
  });

  it("ignores malformed provider records without breaking valid model projection", async () => {
    const { ModelManager } = await import("../core/model-manager.ts");
    fs.writeFileSync(path.join(tmpDir, "added-models.yaml"), [
      "providers:",
      "  deepseek:",
      "    base_url: https://api.deepseek.com/v1",
      "    api: openai-completions",
      "    api_key: sk-deep",
      "    models:",
      "      - deepseek-chat",
      "  dashscope-coding:",
      "  string-provider: broken",
      "",
    ].join("\n"), "utf-8");

    const mm = new ModelManager({ hanakoHome: tmpDir });
    mm._modelRegistry = {
      refresh: vi.fn(),
      getAvailable: vi.fn().mockResolvedValue([
        { id: "deepseek-chat", provider: "deepseek" },
        { id: "unconfigured-model", provider: "other" },
      ]),
    };

    await expect(mm.syncAndRefresh()).resolves.toBe(true);

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.deepseek.models[0].id).toBe("deepseek-chat");
    expect(result.providers["dashscope-coding"]).toBeUndefined();
    expect(result.providers["string-provider"]).toBeUndefined();
    expect(mm.availableModels).toEqual([{ id: "deepseek-chat", provider: "deepseek" }]);
  });

  it("keeps SDK-auth alias providers available without a provider model allow list", async () => {
    const { ModelManager } = await import("../core/model-manager.ts");
    fs.writeFileSync(path.join(tmpDir, "added-models.yaml"), "providers: {}\n", "utf-8");

    const mm = new ModelManager({ hanakoHome: tmpDir });
    mm.providerRegistry.register({
      id: "legacy-sdk-oauth",
      displayName: "Legacy SDK OAuth",
      authType: "oauth",
      authJsonKey: "legacy-sdk-runtime",
      defaultBaseUrl: "https://legacy.example/v1",
      defaultApi: "openai-responses",
      capabilities: {
        chat: {
          projection: "sdk-auth-alias",
          runtimeProviderId: "legacy-sdk-runtime",
        },
      },
    });
    mm._modelRegistry = {
      refresh: vi.fn(),
      getAvailable: vi.fn().mockResolvedValue([
        { id: "legacy-model", provider: "legacy-sdk-runtime" },
        { id: "shadow-model", provider: "shadow-sdk-provider" },
      ]),
    };

    await mm.refreshAvailable();

    expect(mm.availableModels).toEqual([{ id: "legacy-model", provider: "legacy-sdk-runtime" }]);
  });

  it("handles multiple providers in one call", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-dash",
        models: ["qwen3.5-flash"],
      },
      deepseek: {
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        api_key: "sk-deep",
        models: ["deepseek-chat"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(Object.keys(result.providers)).toHaveLength(2);
    expect(result.providers.dashscope.models[0].id).toBe("qwen3.5-flash");
    expect(result.providers.deepseek.models[0].id).toBe("deepseek-chat");
    expect(result.providers.deepseek.models[0].name).toBe("DeepSeek Chat");
  });

  it("projects Gemini native API without OpenAI-chat store compatibility flags", async () => {
    const syncModels = await loadSync();

    const providers = {
      gemini: {
        base_url: "https://generativelanguage.googleapis.com/v1beta",
        api: "google-generative-ai",
        api_key: "sk-test",
        models: ["gemini-3-flash-preview"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.gemini.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(result.providers.gemini.api).toBe("google-generative-ai");
    expect(result.providers.gemini.models[0].compat).toEqual({
      supportsDeveloperRole: false,
      reasoningReplay: {
        carrier: "thought_signature",
        policy: "preserve",
      },
    });
  });

  it("sets compat.supportsStore=false for Gemini OpenAI compatibility configs (avoid 400 from /v1beta/openai)", async () => {
    const syncModels = await loadSync();

    const providers = {
      gemini: {
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["gemini-2.0-flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.gemini.models[0].compat).toBeDefined();
    expect(result.providers.gemini.models[0].compat.supportsStore).toBe(false);
  });

  it("sets compat.supportsStore=false when base_url points at generativelanguage even with non-gemini provider id", async () => {
    const syncModels = await loadSync();

    const providers = {
      "my-gemini-proxy": {
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["gemini-2.0-flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["my-gemini-proxy"].models[0].compat.supportsStore).toBe(false);
  });

  it("projects Zhipu OpenAI-compatible configs with explicit unsupported OpenAI fields", async () => {
    const syncModels = await loadSync();

    const providers = {
      zhipu: {
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["glm-4.7-flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.zhipu.models[0].compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsReasoningEffort: false,
      thinkingFormat: "zhipu",
      reasoningProfile: "zhipu-openai",
    });
  });

  it("projects GLM Coding Plan through the Z.AI OpenAI-compatible endpoint with Zhipu thinking compat", async () => {
    const syncModels = await loadSync();

    const providers = {
      "zhipu-coding": {
        base_url: "https://api.z.ai/api/coding/paas/v4",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["glm-5.2"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["zhipu-coding"]).toMatchObject({
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      api: "openai-completions",
      apiKey: "hana-runtime-api-key:zhipu-coding",
    });
    expect(result.providers["zhipu-coding"].models[0]).toMatchObject({
      id: "glm-5.2",
      name: "GLM-5.2",
      contextWindow: 1000000,
      maxTokens: 131072,
      reasoning: true,
      xhigh: true,
      compat: {
        supportsDeveloperRole: false,
        supportsStore: false,
        supportsReasoningEffort: false,
        thinkingFormat: "zhipu",
        reasoningProfile: "zhipu-openai",
      },
    });
  });

  it("projects OpenCode Go GLM-5.2 with explicit Zhipu thinking compat", async () => {
    const syncModels = await loadSync();

    const providers = {
      "opencode-go": {
        base_url: "https://opencode.ai/zen/go/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["glm-5.2"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["opencode-go"]).toMatchObject({
      baseUrl: "https://opencode.ai/zen/go/v1",
      api: "openai-completions",
      apiKey: "hana-runtime-api-key:opencode-go",
    });
    expect(result.providers["opencode-go"].models[0]).toMatchObject({
      id: "glm-5.2",
      name: "GLM-5.2",
      contextWindow: 1000000,
      maxTokens: 131072,
      reasoning: true,
      xhigh: true,
      compat: {
        supportsDeveloperRole: false,
        supportsStore: false,
        supportsReasoningEffort: false,
        thinkingFormat: "zhipu",
        reasoningProfile: "zhipu-openai",
      },
      toolUse: {
        supportsTools: true,
        dialect: "openai",
        toolResultFormat: "message",
      },
    });
  });

  it("hydrates exact OpenCode Go DeepSeek wire metadata from the Pi catalog", async () => {
    const syncModels = await loadSync();

    syncModels({
      "opencode-go": {
        base_url: "https://opencode.ai/zen/go/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["deepseek-v4-flash"],
      },
    }, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["opencode-go"].models[0]).toMatchObject({
      id: "deepseek-v4-flash",
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: "max",
      },
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "deepseek",
        outputCapField: "max_tokens",
      },
    });
  });

  it("projects OpenCode Zen model endpoints from each model protocol without duplicate suffixes", async () => {
    const syncModels = await loadSync();

    syncModels({
      opencode: {
        base_url: "https://opencode.ai/zen/v1/messages",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: [
          { id: "claude-sonnet-4-6", api: "anthropic-messages" },
          { id: "gpt-5.4", api: "openai-responses" },
        ],
      },
    }, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.opencode).toMatchObject({
      baseUrl: "https://opencode.ai/zen",
      api: "anthropic-messages",
      apiKey: "hana-runtime-api-key:opencode",
    });
    const models = new Map<string, any>(result.providers.opencode.models.map((model) => [model.id, model]));
    expect(models.get("claude-sonnet-4-6")).toMatchObject({
      id: "claude-sonnet-4-6",
      api: "anthropic-messages",
    });
    expect(models.get("claude-sonnet-4-6").baseUrl ?? result.providers.opencode.baseUrl)
      .toBe("https://opencode.ai/zen");
    expect(models.get("gpt-5.4")).toMatchObject({
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/v1",
    });
  });

  it("skips models with type: image from models.json output", async () => {
    const syncModels = await loadSync();

    const providers = {
      openai: {
        base_url: "https://api.openai.com/v1",
        api_key: "sk-test",
        api: "openai-completions",
        models: [
          "gpt-4o",
          { id: "gpt-image-1", type: "image" },
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const models = result.providers.openai?.models || [];
    const ids = models.map(m => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).not.toContain("gpt-image-1");
  });

  it("skips string model entries whose type is image via known-models lookup", async () => {
    const syncModels = await loadSync();

    const providers = {
      openai: {
        base_url: "https://api.openai.com/v1",
        api_key: "sk-test",
        api: "openai-completions",
        models: ["gpt-4o", "gpt-image-1"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const models = result.providers.openai?.models || [];
    const ids = models.map(m => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).not.toContain("gpt-image-1");
  });

  it("falls back to humanized name for unknown models", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-custom",
        models: ["my-custom-model-240101"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.custom.models[0];
    // date suffix stripped, humanized
    expect(model.name).toBe("My Custom Model");
    expect(model.contextWindow).toBe(128000); // default
    expect(model.input).toEqual(["text"]); // unknown model defaults to text-only
    expect(model.vision).toBeUndefined();
    expect(model.reasoning).toBe(false);
  });

  it("preserves explicit model compat declarations from custom provider config", async () => {
    const syncModels = await loadSync();

    const providers = {
      "opencode-go": {
        base_url: "https://opencode.example.test/v1",
        api: "openai-completions",
        api_key: "sk-custom",
        models: [{
          id: "deepseek-v4-pro",
          reasoning: true,
          compat: { thinkingFormat: "deepseek" },
        }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["opencode-go"].models[0].compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "deepseek",
    });
  });

  it("projects only controlled model protocol capability fields from user config", async () => {
    const syncModels = await loadSync();

    const providers = {
      ollama: {
        base_url: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        api_key: "local",
        models: [{
          id: "qwen2.5-vl-thinking",
          image: true,
          reasoning: true,
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
        }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.ollama.models[0];
    expect(model.compat).toEqual({
      supportsDeveloperRole: false,
      thinkingFormat: "qwen",
      reasoningProfile: "mimo-openai",
      reasoningReplay: {
        carrier: "reasoning_content",
        policy: "require-tool-call",
      },
    });
    expect(model.visionCapabilities).toEqual({
      grounding: true,
      boxes: true,
      points: true,
      coordinateSpace: "norm-1000",
      boxOrder: "xyxy",
      outputFormat: "qwen",
      groundingMode: "prompted",
    });
  });

  it("projects provider request headers into models.json even without an api key", async () => {
    const syncModels = await loadSync();

    const providers = {
      "gateway-provider": {
        base_url: "https://gateway.example/v1",
        api: "openai-completions",
        headers: {
          Authorization: "Bearer gateway-token",
          "X-Corp-Auth": "corp-token",
        },
        models: ["gateway-chat"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["gateway-provider"]).toMatchObject({
      baseUrl: "https://gateway.example/v1",
      api: "openai-completions",
      apiKey: "headers",
      headers: {
        Authorization: "Bearer gateway-token",
        "X-Corp-Auth": "corp-token",
      },
    });
    expect(result.providers["gateway-provider"].models[0].id).toBe("gateway-chat");
  });
});
