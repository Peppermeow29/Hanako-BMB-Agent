import { describe, expect, it } from "vitest";
import { normalizeProviderPayload } from "../../core/provider-compat.ts";
import * as zhipu from "../../core/provider-compat/zhipu.ts";

const zhipuModel = {
  id: "glm-5.1",
  provider: "zhipu",
  api: "openai-completions",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  reasoning: true,
  maxTokens: 131072,
};

const glm52Model = {
  ...zhipuModel,
  id: "glm-5.2",
  baseUrl: "https://api.z.ai/api/coding/paas/v4",
  contextWindow: 1000000,
};

describe("provider-compat/zhipu — matches", () => {
  it("matches official provider and BigModel OpenAI-compatible endpoints", () => {
    expect(zhipu.matches({ provider: "zhipu" })).toBe(true);
    expect(zhipu.matches({ provider: "zhipu-coding" })).toBe(true);
    expect(zhipu.matches({
      provider: "custom",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    })).toBe(true);
    expect(zhipu.matches({
      provider: "custom",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
    })).toBe(true);
    expect(zhipu.matches({
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      compat: { thinkingFormat: "zhipu" },
    })).toBe(true);
  });

  it("tolerates missing model fields", () => {
    expect(zhipu.matches(null)).toBe(false);
    expect(zhipu.matches(undefined)).toBe(false);
    expect(zhipu.matches({ provider: "custom" })).toBe(false);
  });
});

describe("provider-compat/zhipu — apply", () => {
  it("chat thinking mode restores reasoning_content for assistant tool-call history", () => {
    const payload = {
      model: "glm-5.1",
      messages: [
        { role: "user", content: "查一下最新资料" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Need to search first.", thinkingSignature: "reasoning_content" },
          ],
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "web_search", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "search result" },
      ],
      tools: [{ type: "function", function: { name: "web_search" } }],
    };

    const result = normalizeProviderPayload(payload, zhipuModel, {
      mode: "chat",
      reasoningLevel: "high",
    });

    expect(result.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(result.messages[1]).toMatchObject({
      content: "",
      reasoning_content: "Need to search first.",
    });
    expect(payload.messages[1]).not.toHaveProperty("reasoning_content");
  });

  it("chat thinking mode fails closed when tool-call history lost reasoning_content", () => {
    const payload = {
      model: "glm-5.1",
      messages: [
        { role: "user", content: "查一下最新资料" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "web_search", arguments: "{}" },
          }],
        },
      ],
      tools: [{ type: "function", function: { name: "web_search" } }],
    };

    expect(() => normalizeProviderPayload(payload, zhipuModel, {
      mode: "chat",
      reasoningLevel: "high",
    })).toThrow(/Zhipu.*reasoning_content.*tool_calls/);
  });

  it("chat recovery mode clears historical reasoning without disabling current GLM thinking", () => {
    const payload = {
      model: "glm-5.1",
      messages: [
        { role: "user", content: "查一下最新资料" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "web_search", arguments: "{}" },
          }],
        },
      ],
      tools: [{ type: "function", function: { name: "web_search" } }],
      enable_thinking: true,
    };

    const result = normalizeProviderPayload(payload, zhipuModel, {
      mode: "chat",
      reasoningLevel: "high",
      reasoningReplay: "clear",
    });

    expect(result.thinking).toEqual({ type: "enabled", clear_thinking: true });
    expect(result).not.toHaveProperty("enable_thinking");
    expect(result.messages[1]).toMatchObject({ content: "" });
    expect(result.messages[1]).not.toHaveProperty("reasoning_content");
  });

  it("GLM-5.2 Max keeps thinking enabled instead of being normalized as off", () => {
    const payload = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "max",
      max_completion_tokens: 131072,
    };

    const result = normalizeProviderPayload(payload, glm52Model, {
      mode: "chat",
      reasoningLevel: "max",
      outputBudgetSource: "system",
    });

    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result).not.toHaveProperty("max_completion_tokens");
    expect(result.max_tokens).toBe(131072);
  });

  it("chat thinking off disables GLM thinking and strips stale reasoning_content", () => {
    const payload = {
      model: "glm-5.1",
      messages: [
        { role: "user", content: "继续" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "previous thinking",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "web_search", arguments: "{}" },
          }],
        },
      ],
      reasoning_effort: "high",
    };

    const result = normalizeProviderPayload(payload, zhipuModel, {
      mode: "chat",
      reasoningLevel: "off",
    });

    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result.messages[1]).not.toHaveProperty("reasoning_content");
  });

  it("utility mode disables GLM thinking and strips stale reasoning_content", () => {
    const payload = {
      model: "glm-5.1",
      messages: [
        {
          role: "assistant",
          content: "",
          reasoning_content: "previous thinking",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "web_search", arguments: "{}" },
          }],
        },
      ],
      reasoning_effort: "high",
    };

    const result = normalizeProviderPayload(payload, zhipuModel, { mode: "utility" });

    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result.messages[0]).not.toHaveProperty("reasoning_content");
  });
});
