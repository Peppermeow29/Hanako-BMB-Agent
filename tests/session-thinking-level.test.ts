import { describe, expect, it } from "vitest";
import {
  normalizeRequestThinkingLevel,
  normalizeSessionThinkingLevel,
  getModelThinkingLevels,
  modelSupportsAnthropicMaxEffort,
  modelSupportsXhigh,
  normalizePiSdkThinkingLevel,
  normalizeThinkingLevelForModel,
  resolveModelDefaultThinkingLevel,
} from "../core/session-thinking-level.ts";

describe("session thinking level capabilities", () => {
  it("keeps model-agnostic legacy auto compatibility at medium", () => {
    expect(normalizeSessionThinkingLevel("auto")).toBe("medium");
    expect(normalizeRequestThinkingLevel("auto")).toBe("medium");
    expect(normalizeSessionThinkingLevel(undefined)).toBe("medium");
  });

  it("resolves legacy auto from the selected model default after the model is known", () => {
    const model = {
      id: "reasoning-model",
      provider: "test",
      thinkingLevels: ["off", "low", "medium", "high", "max"],
      defaultThinkingLevel: "high",
    };

    expect(normalizeThinkingLevelForModel("auto", model)).toBe("high");
  });

  it("clamps legacy Kimi medium to high and preserves its four visible levels", () => {
    const model = {
      id: "kimi-for-coding",
      provider: "kimi-coding",
      thinkingLevels: ["off", "low", "high", "max"],
      defaultThinkingLevel: "high",
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "high",
        high: "high",
        xhigh: "max",
      },
    };

    expect(normalizeThinkingLevelForModel("auto", model)).toBe("high");
    expect(normalizeThinkingLevelForModel("medium", model)).toBe("high");
    expect(normalizeThinkingLevelForModel("max", model)).toBe("max");
  });

  it("accepts Max as the canonical deep thinking level", () => {
    const model = { id: "glm-5.2", provider: "zhipu", reasoning: true };

    expect(normalizeSessionThinkingLevel("max")).toBe("max");
    expect(normalizeRequestThinkingLevel("max")).toBe("max");
    expect(modelSupportsXhigh(model)).toBe(true);
    expect(normalizeThinkingLevelForModel("max", model)).toBe("max");
    expect(normalizeThinkingLevelForModel("max", { id: "plain-model", provider: "test" })).toBe("high");
  });

  it("maps Hana-visible max to Pi SDK xhigh only at the SDK boundary", () => {
    expect(normalizePiSdkThinkingLevel("max")).toBe("xhigh");
    expect(normalizePiSdkThinkingLevel("xhigh")).toBe("xhigh");
    expect(normalizePiSdkThinkingLevel("auto")).toBe("medium");
  });

  it("clamps unsupported legacy OAuth off levels to each GPT-5.6 model default", () => {
    const sol = {
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      thinkingLevels: ["low", "medium", "high", "max"],
      thinkingLevelMap: { off: null, minimal: null, xhigh: "max" },
      defaultThinkingLevel: "low",
    };
    const terra = { ...sol, id: "gpt-5.6-terra", defaultThinkingLevel: "medium" };

    expect(normalizeThinkingLevelForModel("off", sol)).toBe("low");
    expect(normalizeThinkingLevelForModel("off", terra)).toBe("medium");
    expect(normalizeThinkingLevelForModel("max", sol)).toBe("max");
    expect(modelSupportsXhigh(sol)).toBe(true);
  });

  it("shows the unified Max level for GPT-5.5", () => {
    const model = { id: "gpt-5.5", provider: "openai", reasoning: true };

    expect(modelSupportsXhigh(model)).toBe(true);
    expect(normalizeThinkingLevelForModel("xhigh", model)).toBe("xhigh");
  });

  it("shows the unified Max level for Claude models with Anthropic max effort", () => {
    const models = [
      { id: "claude-opus-4-7", provider: "anthropic", reasoning: true },
      { id: "claude-opus-4-6", provider: "anthropic", reasoning: true },
      { id: "claude-sonnet-4-6", provider: "anthropic", reasoning: true },
      { id: "claude-fable-5", provider: "anthropic", reasoning: true },
      { id: "claude-mythos-5", provider: "anthropic", reasoning: true },
      { id: "claude-opus-5", provider: "anthropic", reasoning: true },
      { id: "claude-sonnet-5", provider: "anthropic", reasoning: true },
      { id: "anthropic/claude-opus-4-7", provider: "vercel-ai-gateway", api: "anthropic-messages", reasoning: true },
    ];

    for (const model of models) {
      expect(modelSupportsXhigh(model)).toBe(true);
      expect(modelSupportsAnthropicMaxEffort(model)).toBe(true);
      expect(normalizeThinkingLevelForModel("xhigh", model)).toBe("xhigh");
    }
  });

  it("does not infer Anthropic max effort for non-Anthropic wire formats by model name alone", () => {
    const model = {
      id: "anthropic/claude-opus-4-7",
      provider: "openrouter",
      api: "openai-completions",
      reasoning: true,
    };

    expect(modelSupportsAnthropicMaxEffort(model)).toBe(false);
  });

  it("allows unified Max for OpenRouter Claude Fable without using Anthropic Messages effort control", () => {
    const model = {
      id: "anthropic/claude-fable-5",
      provider: "openrouter",
      api: "openai-completions",
      reasoning: true,
    };

    expect(modelSupportsXhigh(model)).toBe(true);
    expect(modelSupportsAnthropicMaxEffort(model)).toBe(false);
    expect(normalizeThinkingLevelForModel("xhigh", model)).toBe("xhigh");
  });

  it.each([
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5",
  ])("allows unified Max for OpenRouter %s through its adaptive profile", (id) => {
    const model = {
      id,
      provider: "openrouter",
      api: "openai-completions",
      reasoning: true,
    };

    expect(modelSupportsXhigh(model)).toBe(true);
    expect(modelSupportsAnthropicMaxEffort(model)).toBe(false);
    expect(normalizeThinkingLevelForModel("xhigh", model)).toBe("xhigh");
  });

  it("declares DeepSeek's official three-tier ladder (off/low/high/max) for V4 models, dropping the unsupported medium", () => {
    const model = {
      id: "deepseek-v4-flash",
      provider: "deepseek",
      thinkingLevels: ["off", "low", "high", "max"],
      defaultThinkingLevel: "high",
    };

    expect(getModelThinkingLevels(model)).toEqual(["off", "low", "high", "max"]);
    expect(getModelThinkingLevels(model)).not.toContain("medium");
    expect(resolveModelDefaultThinkingLevel(model)).toBe("high");
  });

  it("resolves model-level thinking defaults with per-model xhigh capability", () => {
    expect(resolveModelDefaultThinkingLevel(
      { id: "gpt-5.5", provider: "openai", defaultThinkingLevel: "xhigh" },
      "medium",
    )).toBe("xhigh");

    expect(resolveModelDefaultThinkingLevel(
      { id: "plain-model", provider: "test", defaultThinkingLevel: "xhigh" },
      "low",
    )).toBe("high");

    expect(resolveModelDefaultThinkingLevel(
      { id: "glm-5.2", provider: "zhipu", defaultThinkingLevel: "max" },
      "medium",
    )).toBe("max");

    expect(resolveModelDefaultThinkingLevel(
      { id: "plain-model", provider: "test" },
      "low",
    )).toBe("low");
  });
});
