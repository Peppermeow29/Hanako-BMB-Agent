import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "../core/provider-registry.ts";

let tmpHome;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-provider-media-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function readPersistedProviders() {
  const catalogPath = path.join(tmpHome, "provider-catalog.json");
  if (fs.existsSync(catalogPath)) {
    return JSON.parse(fs.readFileSync(catalogPath, "utf-8")).providers || {};
  }
  const saved = YAML.load(fs.readFileSync(path.join(tmpHome, "added-models.yaml"), "utf-8"));
  return saved?.providers || {};
}

describe("ProviderRegistry media capabilities", () => {
  it("exposes built-in official image providers from media capabilities", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const providers = registry.getMediaProviders("image_generation");
    const byId = new Map(providers.map((provider) => [provider.providerId, provider]));

    expect(byId.get("openai")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gpt-image-1.5", protocolId: "openai-images" }),
    ]));
    expect(byId.get("openai")?.models).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gpt-image-2" }),
    ]));
    expect(byId.get("dashscope")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "wan2.7-image-pro", protocolId: "dashscope-wan-images" }),
      expect.objectContaining({ id: "qwen-image-2.0-pro", protocolId: "dashscope-qwen-multimodal-image" }),
      expect.objectContaining({ id: "qwen-image-plus", protocolId: "dashscope-qwen-text2image" }),
    ]));
    expect(byId.get("minimax")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "image-01", protocolId: "minimax-images" }),
      expect.objectContaining({ id: "image-01-live", protocolId: "minimax-images" }),
    ]));
    expect(byId.get("minimax")?.credentialLanes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "minimax", providerId: "minimax" }),
      expect.objectContaining({ id: "minimax-token-plan", providerId: "minimax-token-plan" }),
    ]));
    expect(byId.has("minimax-token-plan")).toBe(false);
    expect(byId.get("gemini")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gemini-2.5-flash-image", protocolId: "gemini-generate-content-image" }),
      expect.objectContaining({ id: "gemini-3.1-flash-image", protocolId: "gemini-generate-content-image" }),
      expect.objectContaining({ id: "gemini-3-pro-image", protocolId: "gemini-generate-content-image" }),
    ]));
    expect(byId.get("gemini")?.models.map((model) => model.id)).not.toContain("gemini-3.1-flash-image-preview");
    expect(byId.get("gemini")?.models.map((model) => model.id)).not.toContain("gemini-3-pro-image-preview");
    expect(byId.get("volcengine")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "doubao-seedream-5-0-lite-260128", displayName: "Seedream 5.0 Lite" }),
      expect.objectContaining({ id: "doubao-seedream-5-0-260128", displayName: "Seedream 5.0" }),
    ]));
    expect(registry.resolveMediaModel({
      providerId: "gemini",
      modelId: "gemini-3.1-flash-image-preview",
      capability: "image_generation",
    })).toMatchObject({
      model: expect.objectContaining({ id: "gemini-3.1-flash-image" }),
    });
  });

  it("exposes media parameters and reference-image limits at model/mode granularity", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const providers = registry.getMediaProviders("image_generation");
    const byId = new Map(providers.map((provider) => [provider.providerId, provider]));
    const openai = byId.get("openai");
    const dashscope = byId.get("dashscope");
    const gemini = byId.get("gemini");

    const gptImage = openai?.models.find((model) => model.id === "gpt-image-1.5");
    const dalle = openai?.models.find((model) => model.id === "dall-e-3");
    expect(gptImage?.modes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "image2image",
        inputLimits: expect.objectContaining({
          referenceImages: expect.objectContaining({ min: 1 }),
        }),
        parameterSchema: expect.objectContaining({
          properties: expect.objectContaining({
            quality: expect.objectContaining({ enum: ["auto", "low", "medium", "high"] }),
            background: expect.objectContaining({ enum: ["auto", "opaque", "transparent"] }),
          }),
        }),
      }),
    ]));
    expect(dalle?.modes).toEqual([
      expect.objectContaining({
        id: "text2image",
        inputLimits: expect.objectContaining({
          referenceImages: expect.objectContaining({ max: 0 }),
        }),
        parameterSchema: expect.objectContaining({
          properties: expect.objectContaining({
            quality: expect.objectContaining({ enum: ["standard", "hd"] }),
            style: expect.objectContaining({ enum: ["vivid", "natural"] }),
          }),
        }),
      }),
    ]);

    const qwen20 = dashscope?.models.find((model) => model.id === "qwen-image-2.0-pro");
    const qwenPlus = dashscope?.models.find((model) => model.id === "qwen-image-plus");
    expect(qwen20?.modes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "text2image" }),
      expect.objectContaining({
        id: "image2image",
        inputLimits: expect.objectContaining({
          referenceImages: expect.objectContaining({ min: 1 }),
        }),
      }),
    ]));
    expect(qwenPlus?.modes).toEqual([
      expect.objectContaining({
        id: "text2image",
        inputLimits: expect.objectContaining({
          referenceImages: expect.objectContaining({ max: 0 }),
        }),
      }),
    ]);

    const gemini25 = gemini?.models.find((model) => model.id === "gemini-2.5-flash-image");
    const gemini31 = gemini?.models.find((model) => model.id === "gemini-3.1-flash-image");
    const gemini25ImageMode = gemini25?.modes?.find((mode) => mode.id === "image2image");
    const gemini31ImageMode = gemini31?.modes?.find((mode) => mode.id === "image2image");
    expect(gemini25?.modes?.[0]?.parameterSchema.properties).not.toHaveProperty("resolution");
    expect(gemini25ImageMode?.inputLimits.referenceImages.max).toBe(3);
    expect(gemini31?.modes?.[0]?.parameterSchema.properties.ratio.enum).toContain("1:8");
    expect(gemini31?.modes?.[0]?.parameterSchema.properties.resolution.enum).toContain("512");
    expect(gemini31ImageMode?.inputLimits.referenceImages.max).toBe(14);
  });

  it("exposes provider-authored image ratios and resolution tiers without invented 4K fallbacks", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const providers = registry.getMediaProviders("image_generation");
    const byId = new Map(providers.map((provider) => [provider.providerId, provider]));
    const model = (providerId, modelId) => byId.get(providerId)?.models.find((item) => item.id === modelId);
    const mode = (providerId, modelId, modeId = "text2image") => model(providerId, modelId)?.modes.find((item) => item.id === modeId);
    const prop = (providerId, modelId, modeId, key) => mode(providerId, modelId, modeId)?.parameterSchema.properties[key];
    const defaults = (providerId, modelId, modeId = "text2image") => mode(providerId, modelId, modeId)?.defaults || {};

    expect(prop("openai", "gpt-image-1.5", "text2image", "ratio")).toMatchObject({
      enum: ["1:1", "3:2", "2:3"],
      default: "3:2",
    });
    expect(prop("openai", "gpt-image-1.5", "text2image", "resolution")).toMatchObject({
      enum: ["1K"],
      default: "1K",
    });
    expect(defaults("openai", "gpt-image-1.5")).toMatchObject({ ratio: "3:2", resolution: "1K" });

    expect(prop("openai-codex-oauth", "gpt-image-2", "text2image", "resolution")).toMatchObject({
      enum: ["1K", "2K"],
      default: "2K",
    });
    expect(prop("openai-codex-oauth", "gpt-image-2", "text2image", "resolution").enum).not.toContain("4K");
    expect(defaults("openai-codex-oauth", "gpt-image-2")).toMatchObject({ ratio: "3:2", resolution: "2K" });

    expect(prop("dashscope", "wan2.7-image-pro", "text2image", "resolution")).toMatchObject({
      enum: ["1K", "2K", "4K"],
      default: "4K",
    });
    expect(prop("dashscope", "wan2.7-image-pro", "image2image", "resolution")).toMatchObject({
      enum: ["1K", "2K"],
      default: "2K",
    });
    expect(prop("dashscope", "wan2.7-image", "text2image", "resolution")).toMatchObject({
      enum: ["1K", "2K"],
      default: "2K",
    });
    expect(prop("dashscope", "qwen-image-2.0-pro", "text2image", "resolution")).toMatchObject({
      enum: ["2K"],
      default: "2K",
    });
    expect(prop("dashscope", "qwen-image-2.0-pro", "text2image", "ratio")).toMatchObject({
      enum: ["16:9", "4:3", "1:1", "3:4", "9:16"],
      default: "4:3",
    });
    expect(prop("dashscope", "qwen-image-plus", "text2image", "resolution")).toMatchObject({
      enum: ["1K"],
      default: "1K",
    });

    expect(prop("gemini", "gemini-3.1-flash-image", "text2image", "resolution")).toMatchObject({
      enum: ["512", "1K", "2K", "4K"],
      default: "1K",
    });
    expect(prop("gemini", "gemini-3.1-flash-image", "text2image", "ratio")).toMatchObject({
      default: "3:2",
    });
    expect(defaults("gemini", "gemini-3.1-flash-image")).toMatchObject({ ratio: "3:2", resolution: "1K" });
    expect(defaults("gemini", "gemini-3-pro-image")).toMatchObject({ ratio: "3:2", resolution: "1K" });

    expect(prop("volcengine", "doubao-seedream-3-0-t2i", "text2image", "resolution")).toMatchObject({
      enum: ["1K"],
      default: "1K",
    });
    expect(prop("volcengine", "doubao-seedream-5-0-lite-260128", "text2image", "resolution")).toMatchObject({
      enum: ["1K", "2K", "4K"],
      default: "4K",
    });
    expect(defaults("volcengine", "doubao-seedream-5-0-lite-260128")).toMatchObject({ ratio: "3:2", resolution: "4K" });
    expect(prop("volcengine", "doubao-seedream-5-0-260128", "text2image", "resolution")).toMatchObject({
      enum: ["1K", "2K", "4K"],
      default: "4K",
    });

    expect(prop("minimax", "image-01", "text2image", "ratio")).toMatchObject({ default: "3:2" });
    expect(prop("minimax", "image-01", "text2image", "resolution")).toBeUndefined();

    expect(prop("agnes", "agnes-image-2.1-flash", "text2image", "ratio")).toMatchObject({ default: "3:2" });
    expect(prop("agnes", "agnes-image-2.1-flash", "text2image", "resolution")).toMatchObject({
      enum: ["1K"],
      default: "1K",
    });
  });

  it("exposes Agnes chat, image, and video capabilities from its provider plugin", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    expect(registry.get("agnes")).toMatchObject({
      id: "agnes",
      displayName: "Agnes AI",
      baseUrl: "https://apihub.agnes-ai.com/v1",
      api: "openai-completions",
    });
    expect(registry.getDefaultModels("agnes")).toEqual(["agnes-2.0-flash"]);
    expect(registry.resolveMediaModel({
      providerId: "agnes",
      modelId: "agnes-image-2.1-flash",
      capability: "image_generation",
    })).toMatchObject({
      providerId: "agnes",
      model: expect.objectContaining({
        id: "agnes-image-2.1-flash",
        protocolId: "agnes-images",
      }),
    });
    expect(registry.resolveMediaModel({
      providerId: "agnes",
      modelId: "agnes-video-v2.0",
      capability: "video_generation",
    })).toMatchObject({
      providerId: "agnes",
      model: expect.objectContaining({
        id: "agnes-video-v2.0",
        protocolId: "agnes-videos",
      }),
    });

    const providers = registry.getMediaProviders("video_generation");
    const agnes = providers.find((provider) => provider.providerId === "agnes");
    const video = agnes?.models.find((model) => model.id === "agnes-video-v2.0");
    const textMode = video?.modes?.find((mode) => mode.id === "text2video");
    const properties = textMode?.parameterSchema?.properties || {};
    expect(video?.ratios).toEqual(["3:2"]);
    expect(video?.resolutions).toEqual(["720p"]);
    expect(textMode?.defaults).toMatchObject({
      ratio: "3:2",
      video_resolution: "720p",
      duration: 5,
      frame_rate: 24,
    });
    expect(properties.ratio).toMatchObject({ enum: ["3:2"], default: "3:2" });
    expect(properties.video_resolution).toMatchObject({ enum: ["720p"], default: "720p" });
    expect(properties.duration).toMatchObject({ type: "integer", minimum: 3, maximum: 18, default: 5 });
    expect(properties.num_frames).toMatchObject({ type: "integer", minimum: 81, maximum: 441 });
    expect(properties).not.toHaveProperty("width");
    expect(properties).not.toHaveProperty("height");
  });

  it("exposes OpenCode Go as an OpenAI-compatible coding provider", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    expect(registry.get("opencode-go")).toMatchObject({
      id: "opencode-go",
      displayName: "OpenCode Go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      api: "openai-completions",
    });
    expect(registry.getDefaultModels("opencode-go")).toEqual(["glm-5.2"]);
  });

  it("exposes OpenCode Zen with model-owned wire protocols", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    expect(registry.get("opencode")).toMatchObject({
      id: "opencode",
      displayName: "OpenCode Zen",
      baseUrl: "https://opencode.ai/zen",
      api: "anthropic-messages",
    });
    expect(registry.getDefaultModelEntries("opencode")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "claude-sonnet-4-6", api: "anthropic-messages" }),
      expect.objectContaining({ id: "gpt-5.4", api: "openai-responses" }),
    ]));
  });

  it("uses MiniMax Token Plan credentials as a MiniMax image generation lane", () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), YAML.dump({
      providers: {
        "minimax-token-plan": {
          api_key: "token-plan-key",
          base_url: "https://api.minimaxi.com/anthropic",
          api: "anthropic-messages",
        },
      },
    }), "utf-8");

    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const status = registry.getMediaProviderCredentialStatus("minimax", "image_generation");
    const resolved = registry.resolveMediaModel({
      providerId: "minimax",
      modelId: "image-01",
      capability: "image_generation",
    });

    expect(status).toMatchObject({
      hasCredentials: true,
      activeLaneId: "minimax-token-plan",
      activeProviderId: "minimax-token-plan",
    });
    expect(resolved).toMatchObject({
      providerId: "minimax",
      model: expect.objectContaining({ id: "image-01", protocolId: "minimax-images" }),
    });
  });

  it("exposes built-in speech recognition providers without exposing MiniMax Token Plan as STT", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const providers = registry.getMediaProviders("speech_recognition");
    const byId = new Map(providers.map((provider) => [provider.providerId, provider]));

    expect(byId.get("openai")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gpt-4o-transcribe", protocolId: "openai-audio-transcriptions" }),
      expect.objectContaining({ id: "gpt-4o-mini-transcribe", protocolId: "openai-audio-transcriptions" }),
      expect.objectContaining({ id: "whisper-1", protocolId: "openai-audio-transcriptions" }),
    ]));
    expect(byId.get("mimo")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "mimo-v2.5-asr", protocolId: "mimo-chat-completions-asr" }),
    ]));
    expect(registry.get("mimo-token-plan")).toMatchObject({
      id: "mimo-token-plan",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      api: "openai-completions",
    });
    expect(byId.get("mimo-token-plan")).toMatchObject({
      providerId: "mimo-token-plan",
      displayName: "Xiaomi MiMo Token Plan",
    });
    expect(byId.get("mimo-token-plan")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "mimo-v2.5-asr", protocolId: "mimo-chat-completions-asr" }),
    ]));
    expect(byId.get("dashscope")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "qwen3-asr-flash", protocolId: "dashscope-qwen-asr-chat" }),
    ]));
    expect(byId.get("volcengine-speech")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "bigasr-flash", protocolId: "volcengine-bigasr-transcription" }),
    ]));
    expect(byId.get("system-speech")?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "system-speech", protocolId: "system-speech-recognition" }),
    ]));
    expect(byId.has("minimax-token-plan")).toBe(false);
  });

  it("exposes OAuth GPT Image 2 and projects Hana-owned chat defaults through the runtime auth alias", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const mediaProviders = registry.getMediaProviders("image_generation");
    const codex = mediaProviders.find((provider) => provider.providerId === "openai-codex-oauth");

    expect(codex).toMatchObject({
      providerId: "openai-codex-oauth",
      displayName: "OpenAI Codex (OAuth)",
    });
    expect(codex.models).toContainEqual(expect.objectContaining({
      id: "gpt-image-2",
      displayName: "GPT Image 2",
      protocolId: "openai-codex-responses-image",
    }));

    expect(registry.resolveChatProvider("openai-codex-oauth")).toMatchObject({
      originalProviderId: "openai-codex-oauth",
      providerId: "openai-codex",
      projection: "models-json",
      credentialSource: "auth-storage",
    });
    expect(registry.getChatModelIds("openai-codex-oauth")).toEqual(expect.arrayContaining([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.2",
    ]));
    expect(registry.getChatModelIds("openai-codex-oauth")).not.toContain("gpt-5.3-codex-spark");
  });

  it("treats a configured Volcengine Coding Plan credential lane as usable for Volcengine image generation", () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), YAML.dump({
      providers: {
        "volcengine-coding": {
          api_key: "coding-plan-key",
          base_url: "https://ark.cn-beijing.volces.com/api/coding/v3",
          api: "openai-completions",
        },
      },
    }), "utf-8");

    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const status = registry.getMediaProviderCredentialStatus("volcengine", "image_generation");

    expect(status).toMatchObject({
      hasCredentials: true,
      activeLaneId: "volcengine-coding",
      activeProviderId: "volcengine-coding",
    });
  });

  it("normalizes plugin-contributed CLI media providers into the same registry", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.registerProviderContribution({
      id: "jimeng-cli",
      displayName: "即梦 CLI",
      authType: "none",
      _pluginId: "jimeng",
      runtime: {
        kind: "browser-cli",
        protocolId: "browser-cli-media",
        command: {
          executable: "opencli",
          args: [
            { literal: "jimeng" },
            { literal: "generate" },
            { option: "--prompt", from: "prompt" },
            { option: "--model", from: "modelId" },
            { option: "--output", from: "outputDir" },
          ],
          timeoutMs: 120000,
          output: { kind: "file_glob", directory: "outputDir", pattern: "*.png" },
        },
      },
      capabilities: {
        chat: {
          projection: "none",
          runtimeProviderId: "jimeng-cli",
          displayProviderId: "jimeng-cli",
        },
        media: {
          imageGeneration: {
            models: [{
              id: "high_aes_general_v50",
              displayName: "即梦 5.0 Lite",
              protocolId: "browser-cli-media",
              inputs: ["text", "image"],
              outputs: ["image"],
            }],
          },
        },
      },
    });
    registry.reload();

    expect(registry.get("jimeng-cli")).toMatchObject({
      id: "jimeng-cli",
      source: { kind: "plugin", pluginId: "jimeng" },
      runtime: expect.objectContaining({ kind: "browser-cli" }),
    });
    expect(registry.getMediaModels("jimeng-cli", "image_generation")).toEqual([
      expect.objectContaining({
        id: "high_aes_general_v50",
        displayName: "即梦 5.0 Lite",
        protocolId: "browser-cli-media",
      }),
    ]);
    expect(registry.resolveChatProvider("jimeng-cli")).toMatchObject({
      providerId: "jimeng-cli",
      projection: "none",
    });
  });

  it("replaces declared CLI models with a refreshed runtime capability snapshot", async () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.registerProviderContribution({
      id: "runtime-cli",
      displayName: "Runtime CLI",
      authType: "none",
      _pluginId: "runtime-cli",
      capabilities: {
        chat: { projection: "none" },
        media: {
          imageGeneration: {
            models: [{ id: "declared-old", protocolId: "runtime-cli-images" }],
          },
        },
      },
    });
    registry.reload();

    const refresh = vi.fn(async () => ({
      version: "2.0.0",
      fingerprint: "runtime-cli:2.0.0",
      media: {
        imageGeneration: {
          defaultModelId: "discovered-new",
          models: [{
            id: "discovered-new",
            displayName: "Discovered New",
            protocolId: "runtime-cli-images",
            modes: [{ id: "text2image" }],
          }],
        },
      },
    }));
    registry.registerRuntimeMediaCapabilitySource("runtime-cli", { refresh }, { pluginId: "runtime-cli" });

    await expect(registry.refreshRuntimeMediaCapabilities({
      providerId: "runtime-cli",
      capability: "image_generation",
    })).resolves.toEqual(expect.objectContaining({
      "runtime-cli": expect.objectContaining({ status: "ready" }),
    }));

    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "runtime-cli",
      capability: "image_generation",
    }));
    expect(registry.getMediaModels("runtime-cli", "image_generation")).toEqual([
      expect.objectContaining({ id: "discovered-new", protocolId: "runtime-cli-images" }),
    ]);
    expect(registry.getMediaProviders("image_generation")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: "runtime-cli",
        runtimeCapability: expect.objectContaining({
          status: "ready",
          version: "2.0.0",
        }),
      }),
    ]));
    expect(registry.getRuntimeMediaCapabilityState("runtime-cli")).not.toHaveProperty("fingerprint");
    expect(() => registry.addMediaModel("runtime-cli", "image_generation", {
      id: "manual-model",
      protocolId: "runtime-cli-images",
    })).toThrow(/runtime-discovered.*manual model changes/i);
    expect(() => registry.updateMediaModelEntry(
      "runtime-cli",
      "image_generation",
      "discovered-new",
      { displayName: "Manual Rename" },
    )).toThrow(/runtime-discovered.*manual model changes/i);
    expect(() => registry.removeMediaModel("runtime-cli", "image_generation", "discovered-new"))
      .toThrow(/runtime-discovered.*manual model changes/i);
  });

  it("keeps CLI discovery failures explicit instead of exposing stale declarations", async () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.registerProviderContribution({
      id: "runtime-cli",
      displayName: "Runtime CLI",
      authType: "none",
      _pluginId: "runtime-cli",
      capabilities: {
        chat: { projection: "none" },
        media: {
          videoGeneration: {
            models: [{ id: "declared-old", protocolId: "runtime-cli-videos" }],
          },
        },
      },
    });
    registry.reload();
    registry.registerRuntimeMediaCapabilitySource("runtime-cli", {
      refresh: async () => {
        throw Object.assign(new Error("CLI help output could not be parsed"), {
          code: "cli_capabilities_unavailable",
        });
      },
    }, { pluginId: "runtime-cli" });

    await registry.refreshRuntimeMediaCapabilities({
      providerId: "runtime-cli",
      capability: "video_generation",
    });

    expect(registry.getMediaModels("runtime-cli", "video_generation")).toEqual([]);
    expect(registry.getMediaProviders("video_generation")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: "runtime-cli",
        models: [],
        runtimeCapability: expect.objectContaining({
          status: "error",
          error: expect.objectContaining({
            code: "cli_capabilities_unavailable",
            message: "CLI help output could not be parsed",
          }),
        }),
      }),
    ]));
    expect(registry.getMediaProviders("speech_recognition"))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ providerId: "runtime-cli" })]));
    expect(registry.getMediaProviderCredentialStatus("runtime-cli", "video_generation")).toMatchObject({
      hasCredentials: false,
      unavailableReason: "cli_capabilities_unavailable",
    });
    expect(() => registry.resolveMediaModel({
      providerId: "runtime-cli",
      modelId: "declared-old",
      capability: "video_generation",
    })).toThrow(/CLI help output could not be parsed/);
  });

  it("retains the last runtime snapshot as stale when a later refresh fails", async () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.registerProviderContribution({
      id: "runtime-cli",
      displayName: "Runtime CLI",
      authType: "none",
      _pluginId: "runtime-cli",
      capabilities: {
        chat: { projection: "none" },
        media: { imageGeneration: { models: [] } },
      },
    });
    registry.reload();
    let shouldFail = false;
    registry.registerRuntimeMediaCapabilitySource("runtime-cli", {
      refresh: async () => {
        if (shouldFail) throw new Error("CLI was upgraded while Hana was running");
        return {
          media: {
            imageGeneration: {
              models: [{ id: "discovered", protocolId: "runtime-cli-images" }],
            },
          },
        };
      },
    }, { pluginId: "runtime-cli" });

    await registry.refreshRuntimeMediaCapabilities({ providerId: "runtime-cli" });
    shouldFail = true;
    await registry.refreshRuntimeMediaCapabilities({ providerId: "runtime-cli" });

    expect(registry.getMediaModels("runtime-cli", "image_generation")).toEqual([
      expect.objectContaining({ id: "discovered" }),
    ]);
    expect(registry.getRuntimeMediaCapabilityState("runtime-cli")).toMatchObject({
      status: "stale",
      error: expect.objectContaining({ message: "CLI was upgraded while Hana was running" }),
    });
    expect(registry.getMediaProviderCredentialStatus("runtime-cli", "image_generation")).toMatchObject({
      hasCredentials: false,
      unavailableReason: "runtime_capability_refresh_failed",
    });
  });

  it("does not publish an in-flight snapshot after its plugin source is unregistered", async () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.registerProviderContribution({
      id: "runtime-cli",
      displayName: "Runtime CLI",
      authType: "none",
      _pluginId: "runtime-cli",
      capabilities: {
        chat: { projection: "none" },
        media: { imageGeneration: { models: [] } },
      },
    });
    registry.reload();
    let releaseRefresh: (snapshot: any) => void = () => {};
    registry.registerRuntimeMediaCapabilitySource("runtime-cli", {
      refresh: () => new Promise((resolve) => {
        releaseRefresh = resolve;
      }),
    }, { pluginId: "runtime-cli" });

    const pending = registry.refreshRuntimeMediaCapabilities({ providerId: "runtime-cli" });
    registry.unregisterRuntimeMediaCapabilitySource("runtime-cli", { pluginId: "runtime-cli" });
    releaseRefresh({
      fingerprint: { path: "/private/runtime-cli", version: "1", mtimeMs: 1, size: 1 },
      media: {
        imageGeneration: {
          models: [{ id: "late-model", protocolId: "runtime-cli-images" }],
        },
      },
    });
    await pending;

    expect(registry.getRuntimeMediaCapabilityState("runtime-cli")).toBeNull();
    expect(registry.getMediaModels("runtime-cli", "image_generation")).toEqual([]);
  });
});

describe("custom provider image protocol inference (#1627)", () => {
  it("infers openai-images for image models on a custom provider with the default OpenAI-compatible api", () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), YAML.dump({
      providers: {
        "my-proxy": {
          api_key: "proxy-key",
          base_url: "https://proxy.example.com/v1",
          models: [
            "gpt-5.5",
            { id: "flux-1.1-pro", type: "image", name: "FLUX 1.1 Pro" },
          ],
        },
      },
    }), "utf-8");

    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const providers = registry.getMediaProviders("image_generation");
    const proxy = providers.find((provider) => provider.providerId === "my-proxy");

    expect(proxy).toBeDefined();
    expect(proxy.models).toEqual([
      expect.objectContaining({ id: "flux-1.1-pro", protocolId: "openai-images" }),
    ]);
    // 聊天模型不受影响
    expect(registry.getChatModelIds("my-proxy")).toEqual(["gpt-5.5"]);
  });

  it("infers openai-images for media.image_generation models on a custom openai-responses provider", () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), YAML.dump({
      providers: {
        "my-responses-proxy": {
          api_key: "proxy-key",
          base_url: "https://responses.example.com/v1",
          api: "openai-responses",
          media: {
            image_generation: {
              models: [{ id: "gpt-image-1.5" }],
            },
          },
        },
      },
    }), "utf-8");

    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    expect(registry.getMediaModels("my-responses-proxy", "image_generation")).toEqual([
      expect.objectContaining({ id: "gpt-image-1.5", protocolId: "openai-images" }),
    ]);
  });

  it("keeps an explicit model protocolId instead of overwriting it with the inferred one", () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), YAML.dump({
      providers: {
        "my-proxy": {
          api_key: "proxy-key",
          base_url: "https://proxy.example.com/v1",
          media: {
            image_generation: {
              models: [{ id: "special-model", protocolId: "my-own-protocol" }],
            },
          },
        },
      },
    }), "utf-8");

    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    expect(registry.getMediaModels("my-proxy", "image_generation")).toEqual([
      expect.objectContaining({ id: "special-model", protocolId: "my-own-protocol" }),
    ]);
  });

  it("does not infer a protocol for custom providers speaking a non-OpenAI-compatible api", () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), YAML.dump({
      providers: {
        "my-anthropic-proxy": {
          api_key: "proxy-key",
          base_url: "https://claude-proxy.example.com",
          api: "anthropic-messages",
          models: [{ id: "claude-image-x", type: "image" }],
        },
      },
    }), "utf-8");

    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const models = registry.getMediaModels("my-anthropic-proxy", "image_generation");
    expect(models).toEqual([expect.objectContaining({ id: "claude-image-x" })]);
    expect(models[0].protocolId).toBeUndefined();
  });

  it("does not start inferring protocols for built-in providers without explicit rules", () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), YAML.dump({
      providers: {
        groq: {
          api_key: "groq-key",
          models: [{ id: "imaginary-image-model", type: "image" }],
        },
      },
    }), "utf-8");

    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const models = registry.getMediaModels("groq", "image_generation");
    expect(models).toEqual([expect.objectContaining({ id: "imaginary-image-model" })]);
    expect(models[0].protocolId).toBeUndefined();
  });

  it("addMediaModel persists the inferred openai-images protocol for custom OpenAI-compatible providers", () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), YAML.dump({
      providers: {
        "my-proxy": {
          api_key: "proxy-key",
          base_url: "https://proxy.example.com/v1",
        },
      },
    }), "utf-8");

    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    registry.addMediaModel("my-proxy", "image_generation", { id: "flux-1.1-pro" });

    expect(registry.getMediaModels("my-proxy", "image_generation")).toEqual([
      expect.objectContaining({ id: "flux-1.1-pro", protocolId: "openai-images" }),
    ]);
    const savedProviders = readPersistedProviders();
    expect(savedProviders["my-proxy"].media.image_generation.models).toEqual([
      expect.objectContaining({ id: "flux-1.1-pro", protocolId: "openai-images" }),
    ]);
  });

  it("addMediaModel still rejects models whose protocol cannot be determined", () => {
    fs.writeFileSync(path.join(tmpHome, "added-models.yaml"), YAML.dump({
      providers: {
        "my-anthropic-proxy": {
          api_key: "proxy-key",
          base_url: "https://claude-proxy.example.com",
          api: "anthropic-messages",
        },
      },
    }), "utf-8");

    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    expect(() => registry.addMediaModel("my-anthropic-proxy", "image_generation", { id: "claude-image-x" }))
      .toThrow(/missing protocolId/);
  });
});
