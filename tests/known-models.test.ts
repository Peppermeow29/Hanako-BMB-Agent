import { describe, expect, it } from "vitest";

import defaultModels from "../lib/default-models.json";
import {
  listKnownProviderModels,
  lookupKnown,
  lookupKnownProvider,
  lookupKnownWithSource,
} from "../shared/known-models.ts";

describe("known-models dictionary", () => {
  it("treats missing model ids as unknown instead of throwing", () => {
    expect(lookupKnown("openai", undefined)).toBeNull();
    expect(lookupKnown(undefined, undefined)).toBeNull();
  });

  it("keeps current OpenAI GPT-5.4 API context metadata", () => {
    expect(lookupKnown("openai", "gpt-5.4")).toMatchObject({
      name: "GPT-5.4",
      context: 272000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
    });
    expect(lookupKnown("openai", "gpt-5.4-mini")).toMatchObject({
      context: 400000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
    });
  });

  it("declares GPT-5.5 metadata for Codex OAuth with the Hana-owned Codex contract", () => {
    expect(lookupKnown("openai-codex-oauth", "gpt-5.5")).toMatchObject({
      name: "GPT-5.5",
      context: 272000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
      api: "openai-codex-responses",
      thinkingLevels: ["low", "medium", "high", "max"],
      thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
      defaultThinkingLevel: "medium",
    });
  });

  it("keeps legacy Codex OAuth defaults on provider-specific 272K contracts", () => {
    for (const id of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.2"]) {
      expect(lookupKnownProvider("openai-codex-oauth", id)).toMatchObject({
        context: 272000,
        maxOutput: 128000,
        api: "openai-codex-responses",
        thinkingLevels: ["low", "medium", "high", "max"],
        thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
        defaultThinkingLevel: "medium",
      });
    }
    expect(lookupKnownProvider("openai-codex-oauth", "gpt-5.3-codex-spark")).toMatchObject({
      context: 128000,
      maxOutput: 128000,
      api: "openai-codex-responses",
      legacyCompatibility: true,
    });
  });

  it("keeps GPT-5.6 provider contracts isolated from generic fallback metadata", () => {
    expect(defaultModels.openai.slice(0, 4)).toEqual([
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(lookupKnownProvider("openai", "gpt-5.6-sol")).toMatchObject({
      context: 1050000,
      maxOutput: 128000,
      api: "openai-responses",
      thinkingLevels: ["off", "low", "medium", "high", "max"],
      thinkingLevelMap: { off: "none", xhigh: "max" },
      defaultThinkingLevel: "medium",
    });
    expect(lookupKnownProvider("openai-codex-oauth", "gpt-5.6-sol")).toMatchObject({
      context: 353400,
      maxContext: 372000,
      maxOutput: 128000,
      api: "openai-codex-responses",
      thinkingLevels: ["low", "medium", "high", "max"],
      thinkingLevelMap: { off: null, minimal: null, xhigh: "max" },
      defaultThinkingLevel: "low",
    });
    expect(lookupKnownWithSource("unknown-proxy", "gpt-5.6-sol")).toEqual({
      source: "fallback",
      metadata: {
        name: "GPT-5.6 Sol",
        context: 1050000,
        maxOutput: 128000,
        image: true,
        reasoning: true,
      },
    });
    expect(lookupKnownProvider("unknown-proxy", "gpt-5.6-sol")).toBeNull();
  });

  it("declares all six OpenRouter GPT-5.6 routes", () => {
    expect(listKnownProviderModels("openrouter")).toEqual(expect.arrayContaining([
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-sol-pro",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-terra-pro",
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-luna-pro",
    ]));
    expect(lookupKnownProvider("openrouter", "openai/gpt-5.6-sol")).toMatchObject({
      api: "openai-completions",
      context: 1050000,
      maxOutput: 128000,
    });
  });

  it("declares GPT Image 2 as an image model for OpenAI and Codex OAuth", () => {
    expect(lookupKnown("openai", "gpt-image-2")).toEqual({
      name: "GPT Image 2",
      type: "image",
    });
    expect(lookupKnown("openai-codex-oauth", "gpt-image-2")).toEqual({
      name: "GPT Image 2",
      type: "image",
    });
  });

  it("declares recent frontier and agent model metadata by provider", () => {
    expect(lookupKnown("openai", "gpt-5.5")).toMatchObject({
      context: 272000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
    });
    expect(lookupKnown("anthropic", "claude-opus-4-7")).toMatchObject({
      context: 1000000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
    });
    for (const [id, name] of [
      ["claude-opus-5", "Claude Opus 5"],
      ["claude-sonnet-5", "Claude Sonnet 5"],
    ]) {
      expect(lookupKnown("anthropic", id)).toMatchObject({
        name,
        context: 1000000,
        maxOutput: 128000,
        image: true,
        reasoning: true,
        xhigh: true,
        compat: {
          thinkingFormat: "anthropic",
          reasoningProfile: "anthropic-adaptive-only",
        },
      });
      expect(lookupKnown("unknown-provider", `anthropic/${id}`)).toMatchObject({
        name,
        context: 1000000,
        maxOutput: 128000,
        image: true,
        reasoning: true,
        xhigh: true,
      });
    }
    expect(lookupKnown("anthropic", "claude-fable-5")).toMatchObject({
      name: "Claude Fable 5",
      context: 1000000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
      xhigh: true,
      compat: {
        thinkingFormat: "anthropic",
        reasoningProfile: "anthropic-adaptive-only",
      },
    });
    expect(lookupKnown("anthropic", "claude-mythos-5")).toMatchObject({
      name: "Claude Mythos 5",
      context: 1000000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
      xhigh: true,
      compat: {
        thinkingFormat: "anthropic",
        reasoningProfile: "anthropic-adaptive-only",
      },
    });
    expect(lookupKnown("openrouter", "anthropic/claude-fable-5")).toMatchObject({
      name: "Anthropic/Claude Fable 5",
      context: 1000000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
      xhigh: true,
      compat: {
        thinkingFormat: "openrouter",
        reasoningProfile: "openrouter-anthropic-adaptive",
      },
    });
    for (const [id, name] of [
      ["anthropic/claude-opus-5", "Anthropic/Claude Opus 5"],
      ["anthropic/claude-sonnet-5", "Anthropic/Claude Sonnet 5"],
    ]) {
      expect(lookupKnown("openrouter", id)).toMatchObject({
        name,
        context: 1000000,
        maxOutput: 128000,
        image: true,
        reasoning: true,
        xhigh: true,
        compat: {
          thinkingFormat: "openrouter",
          reasoningProfile: "openrouter-anthropic-adaptive",
        },
      });
    }
    expect(lookupKnown("unknown-provider", "anthropic/claude-mythos-5")).toMatchObject({
      name: "Claude Mythos 5",
      context: 1000000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
      xhigh: true,
    });
    expect(lookupKnown("dashscope", "qwen3.6-plus")).toMatchObject({
      context: 1000000,
      maxOutput: 65536,
      image: true,
      reasoning: true,
      quirks: ["enable_thinking"],
    });
    expect(lookupKnown("zhipu", "glm-5.1")).toMatchObject({
      context: 200000,
      maxOutput: 128000,
      image: false,
      reasoning: true,
    });
    expect(lookupKnown("zhipu", "glm-5.2")).toMatchObject({
      name: "GLM-5.2",
      context: 1000000,
      maxOutput: 131072,
      image: false,
      reasoning: true,
      xhigh: true,
    });
    expect(lookupKnown("zhipu", "glm-4.7-flash")).toMatchObject({
      context: 200000,
      maxOutput: 128000,
      image: false,
      reasoning: true,
    });
    expect(lookupKnown("mistral", "mistral-small-2603")).toMatchObject({
      context: 256000,
      maxOutput: 256000,
      reasoning: true,
    });
    expect(lookupKnown("xai", "grok-4.20-reasoning")).toMatchObject({
      context: 2000000,
      maxOutput: 2000000,
      image: true,
      reasoning: true,
    });
    expect(defaultModels.xai[0]).toBe("grok-4.5");
    expect(lookupKnown("xai", "grok-4.5")).toMatchObject({
      name: "Grok 4.5",
      context: 500000,
      image: true,
      reasoning: true,
    });
  });

  it("lists provider-specific known model ids without exposing the raw dictionary", () => {
    expect(listKnownProviderModels("zhipu")).toEqual(expect.arrayContaining([
      "glm-5.2",
      "glm-5.1",
      "glm-4.7-flash",
    ]));
    expect(listKnownProviderModels("missing-provider")).toEqual([]);
  });

  it("lists GLM-5.2 first in the curated Zhipu defaults", () => {
    expect(defaultModels.zhipu[0]).toBe("glm-5.2");
  });

  it("declares OpenCode Go GLM-5.2 with the GLM OpenAI-compatible thinking contract", () => {
    expect(defaultModels["opencode-go"]).toEqual(["glm-5.2"]);
    expect(lookupKnown("opencode-go", "glm-5.2")).toMatchObject({
      name: "GLM-5.2",
      context: 1000000,
      maxOutput: 131072,
      image: false,
      reasoning: true,
      xhigh: true,
      compat: {
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

  it("declares GLM Coding Plan fixed models under the Zhipu coding provider", () => {
    expect(defaultModels["zhipu-coding"]).toEqual([
      "glm-5.2",
      "glm-5-turbo",
      "glm-4.7",
      "glm-4.5-air",
    ]);
    expect(lookupKnown("zhipu-coding", "glm-5.2")).toMatchObject({
      name: "GLM-5.2",
      context: 1000000,
      maxOutput: 131072,
      image: false,
      reasoning: true,
      xhigh: true,
    });
    for (const id of ["glm-5-turbo", "glm-4.7", "glm-4.5-air"]) {
      expect(lookupKnown("zhipu-coding", id)).toMatchObject({
        context: 200000,
        image: false,
        reasoning: true,
      });
    }
  });

  it("declares Agnes 2.0 Flash as a curated OpenAI-compatible multimodal agent model", () => {
    expect(defaultModels.agnes).toEqual(["agnes-2.0-flash"]);
    expect(lookupKnown("agnes", "agnes-2.0-flash")).toMatchObject({
      name: "Agnes 2.0 Flash",
      image: true,
      reasoning: false,
      toolUse: {
        supportsTools: true,
        dialect: "openai",
        toolResultFormat: "message",
      },
    });
    expect(lookupKnown("custom", "agnes-2.0-flash")).toMatchObject({
      reasoning: false,
    });
  });

  it("uses generic model fallbacks when a provider has no provider-specific entry", () => {
    expect(lookupKnown("volcengine", "kimi-k2.6")).toMatchObject({
      name: "Kimi K2.6",
      context: 262144,
      maxOutput: 98304,
      image: true,
      reasoning: true,
    });
  });

  it("declares the latest Doubao Seed 2.0 Lite visual metadata for Volcengine providers", () => {
    const expected = {
      name: "Doubao Seed 2.0 Lite (Full-Modal)",
      context: 256000,
      maxOutput: 128000,
      image: true,
      video: true,
      reasoning: true,
    };
    expect(lookupKnown("volcengine", "doubao-seed-2-0-lite-260428")).toMatchObject(expected);
    expect(lookupKnown("volcengine-coding", "doubao-seed-2-0-lite-260428")).toMatchObject(expected);
  });

  it("declares the stable Kimi for Coding model for Kimi Coding Plan", () => {
    expect(lookupKnown("kimi-coding", "kimi-for-coding")).toMatchObject({
      name: "Kimi for Coding",
      context: 262144,
      maxOutput: 32768,
      image: true,
      reasoning: true,
      thinkingLevels: ["off", "low", "high", "max"],
      defaultThinkingLevel: "high",
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "high",
        high: "high",
        xhigh: "max",
      },
      compat: {
        thinkingFormat: "kimi",
        reasoningProfile: "kimi-openai",
      },
    });
  });

  it("declares official Kimi K3 metadata while keeping the stable default model", () => {
    const k3 = lookupKnownProvider("kimi-coding", "k3");
    const k3_256k = lookupKnownProvider("kimi-coding", "k3-256k");
    expect(k3).toMatchObject({
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
    });
    expect(k3_256k).toMatchObject({
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
    });
    expect(k3).not.toHaveProperty("video");
    expect(k3).not.toHaveProperty("maxOutput");
    expect(k3_256k).not.toHaveProperty("video");
    expect(k3_256k).not.toHaveProperty("maxOutput");
    expect(defaultModels["kimi-coding"]).toEqual(["kimi-for-coding"]);
  });

  it("declares current Moonshot K3 metadata and defaults", () => {
    expect(defaultModels.moonshot).toEqual(["kimi-k3", "kimi-k2.6"]);
    expect(lookupKnownProvider("moonshot", "kimi-k3")).toMatchObject({
      name: "Kimi K3",
      context: 1048576,
      image: true,
      reasoning: true,
      thinkingLevels: ["low", "high", "max"],
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "low",
        high: "high",
        xhigh: "max",
      },
      defaultThinkingLevel: "max",
    });
    expect(lookupKnownProvider("moonshot", "kimi-k3")).not.toHaveProperty("maxOutput");
  });

  it("declares official Moonshot Kimi K2.6 video capability", () => {
    expect(lookupKnown("moonshot", "kimi-k2.6")).toMatchObject({
      name: "Kimi K2.6",
      image: true,
      video: true,
      reasoning: true,
    });
  });

  it("declares Xiaomi MiMo V2.5 series with Pro text-only and Omni full-modal limits", () => {
    expect(lookupKnown("mimo", "mimo-v2.5-pro")).toEqual({
      name: "MiMo V2.5 Pro",
      context: 1048576,
      maxOutput: 131072,
      reasoning: true,
    });
    expect(lookupKnown("mimo", "mimo-v2.5")).toEqual({
      name: "MiMo V2.5",
      context: 1048576,
      maxOutput: 131072,
      image: true,
      video: true,
      audio: true,
      reasoning: true,
    });

    for (const id of [
      "mimo-v2.5-tts",
      "mimo-v2.5-tts-voicedesign",
      "mimo-v2.5-tts-voiceclone",
    ]) {
      expect(lookupKnown("mimo", id)).toMatchObject({
        context: 8192,
        maxOutput: 8192,
      });
    }
  });

  it("looks up known model ids case-insensitively after exact matches miss", () => {
    expect(lookupKnown("mimo", "MiMo-V2.5-Pro")).toEqual(lookupKnown("mimo", "mimo-v2.5-pro"));
    expect(lookupKnown("openrouter", "DeepSeek/DeepSeek-V3.2")).toEqual(
      lookupKnown("openrouter", "deepseek/deepseek-v3.2"),
    );
    expect(lookupKnown("unknown-provider", "MiMo-V2-Flash")).toEqual(
      lookupKnown("unknown-provider", "mimo-v2-flash"),
    );
  });

  it("keeps Xiaomi MiMo V2 Omni aligned with current official full-modal metadata", () => {
    expect(lookupKnown("mimo", "mimo-v2-omni")).toMatchObject({
      context: 262144,
      maxOutput: 131072,
      image: true,
      video: true,
      audio: true,
      reasoning: true,
    });
  });

  it("declares current MiniMax M-series text and image metadata across billing providers", () => {
    const m3 = {
      name: "MiniMax M3",
      // context 为用户策展值：实测 500k 以上基本不可用，不取官方 1M
      //（sync-known-models-from-pi.mjs 排除表持有此口径）
      context: 500000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
    };
    expect(lookupKnown("minimax", "MiniMax-M3")).toEqual(m3);
    // minimax-token-plan 不在词典分区内，经 known-model-fallbacks.json 兜底解析；
    // 2026-07-08 起两个数据源已对齐同值。
    expect(lookupKnown("minimax-token-plan", "MiniMax-M3")).toEqual(m3);
    expect(lookupKnown("minimax", "MiniMax-M2.1-highspeed")).toEqual({
      name: "MiniMax M2.1 Highspeed",
      context: 204800,
      maxOutput: 204800,
      image: false,
      reasoning: true,
    });
    expect(listKnownProviderModels("minimax")).toEqual(expect.arrayContaining([
      "MiniMax-M3",
      "MiniMax-M2.1-highspeed",
    ]));
  });

  it("keeps provider-specific metadata ahead of generic fallbacks", () => {
    expect(lookupKnown("openai-codex-oauth", "gpt-5.5")).toMatchObject({
      context: 272000,
    });
    expect(lookupKnown("unknown-provider", "gpt-5.5")).toMatchObject({
      context: 272000,
    });
  });

  it("does not treat arbitrary provider-specific entries as generic fallbacks", () => {
    expect(lookupKnown("unknown-provider", "openrouter/auto")).toBeNull();
  });

  it("declares DeepSeek V4 Flash Vision (Exp) as image-capable on the official DeepSeek provider", () => {
    expect(lookupKnown("deepseek", "deepseek-v4-flash-vision-exp")).toMatchObject({
      name: "DeepSeek V4 Flash Vision (Exp)",
      context: 1000000,
      maxOutput: 384000,
      image: true,
      reasoning: true,
      xhigh: true,
    });
  });

  it("declares DeepSeek V4's official three-tier thinking ladder, dropping the unsupported medium", () => {
    for (const id of ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
      expect(lookupKnown("deepseek", id)).toMatchObject({
        thinkingLevels: ["off", "low", "high", "max"],
        defaultThinkingLevel: "high",
      });
    }
  });

  it("also reaches DeepSeek V4 Flash Vision (Exp) through the generic fallback table, without inheriting DeepSeek's protocol-level thinking ladder", () => {
    expect(lookupKnownWithSource("unknown-proxy", "deepseek-v4-flash-vision-exp")).toEqual({
      source: "fallback",
      metadata: {
        name: "DeepSeek V4 Flash Vision (Exp)",
        context: 1000000,
        maxOutput: 384000,
        image: true,
        reasoning: true,
        xhigh: true,
      },
    });
  });
});
