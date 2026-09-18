import { describe, expect, it } from "vitest";
import { convertMessages } from "../../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { convertResponsesMessages } from "../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";
import {
  normalizeProviderContextMessages,
  normalizeProviderPayload,
} from "../../core/provider-compat.ts";
import {
  getEndpointDefaultReasoningCapability,
  getReasoningReplayContract,
  normalizeModelProtocolCompat,
  withThinkingFormatCompat,
} from "../../shared/model-capabilities.ts";

const OPENAI_COMPAT_BASE = {
  name: "Reasoning test model",
  api: "openai-completions" as const,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 131_072,
};

describe("reasoning replay capability contract", () => {
  it("normalizes an explicit replay contract without dropping unrelated protocol compat", () => {
    expect(normalizeModelProtocolCompat({
      thinkingFormat: "kimi",
      outputCapRequired: true,
      reasoningReplay: {
        carrier: "reasoning_content",
        policy: "require-tool-call",
      },
    })).toEqual({
      thinkingFormat: "kimi",
      outputCapRequired: true,
      reasoningReplay: {
        carrier: "reasoning_content",
        policy: "require-tool-call",
      },
    });
  });

  it.each([
    [
      "Kimi Chat Completions",
      {
        id: "future-kimi-code-model",
        provider: "kimi-coding",
        api: "openai-completions",
        baseUrl: "https://api.kimi.com/coding/v1",
        reasoning: true,
      },
      { carrier: "reasoning_content", policy: "require-tool-call" },
    ],
    [
      "DeepSeek Chat Completions",
      {
        id: "deepseek-reasoner",
        provider: "deepseek",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com/v1",
        reasoning: true,
      },
      { carrier: "reasoning_content", policy: "require-tool-call" },
    ],
    [
      "MiMo Chat Completions",
      {
        id: "mimo-v2.5-pro",
        provider: "mimo",
        api: "openai-completions",
        baseUrl: "https://api.xiaomimimo.com/v1",
        reasoning: true,
      },
      { carrier: "reasoning_content", policy: "require-tool-call" },
    ],
    [
      "GLM Chat Completions",
      {
        id: "glm-5.1",
        provider: "zhipu",
        api: "openai-completions",
        baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
        reasoning: true,
      },
      { carrier: "reasoning_content", policy: "require-tool-call", clearable: true },
    ],
    [
      "Anthropic Messages",
      {
        id: "claude-test",
        provider: "anthropic",
        api: "anthropic-messages",
        reasoning: true,
      },
      { carrier: "thinking_blocks", policy: "preserve" },
    ],
    [
      "OpenRouter",
      {
        id: "anthropic/claude-test",
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
      },
      { carrier: "reasoning_details", policy: "preserve" },
    ],
    [
      "OpenAI Responses",
      {
        id: "gpt-test",
        provider: "openai",
        api: "openai-responses",
        reasoning: true,
      },
      { carrier: "reasoning_items", policy: "preserve" },
    ],
    [
      "Gemini",
      {
        id: "gemini-test",
        provider: "google",
        api: "google-generative-ai",
        reasoning: true,
      },
      { carrier: "thought_signature", policy: "preserve" },
    ],
  ])("resolves %s without a model-id allowlist", (_name, model, expected) => {
    expect(getReasoningReplayContract(model)).toEqual(expected);
  });

  it("lets an explicit none policy override endpoint inference", () => {
    expect(getReasoningReplayContract({
      id: "k3",
      provider: "kimi-coding",
      api: "openai-completions",
      baseUrl: "https://api.kimi.com/coding/v1",
      reasoning: true,
      compat: { reasoningReplay: { policy: "none" } },
    })).toEqual({ policy: "none" });
  });

  it("does not assign reasoning_content replay to a generic OpenAI-compatible model", () => {
    expect(getReasoningReplayContract({
      id: "private-reasoning-model",
      provider: "custom",
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      reasoning: true,
    })).toBeNull();
  });

  it("keeps endpoint-level default reasoning limited to Kimi Coding", () => {
    expect(getEndpointDefaultReasoningCapability({
      id: "future-kimi-code-model",
      provider: "kimi-coding",
      api: "openai-completions",
      baseUrl: "https://api.kimi.com/coding/v1",
    })).toBe(true);
    expect(getEndpointDefaultReasoningCapability({
      id: "moonshot-v1-8k",
      provider: "moonshot",
      api: "openai-completions",
      baseUrl: "https://api.moonshot.cn/v1",
    })).toBeNull();
  });
});

describe("reasoning replay execution", () => {
  it("preserves a signed reasoning_content block across compatible model IDs", () => {
    const targetModel = withThinkingFormatCompat({
      ...OPENAI_COMPAT_BASE,
      id: "deepseek-v4-flash",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      reasoning: true,
    });
    const sourceMessages = [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        provider: "deepseek",
        api: "openai-completions",
        model: "deepseek-v4-pro",
        content: [
          { type: "thinking", thinking: "call the inspect tool", thinkingSignature: "reasoning_content" },
          { type: "toolCall", id: "call_1", name: "inspect", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "inspect",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ];

    const replayMessages = normalizeProviderContextMessages(sourceMessages, targetModel, {
      mode: "chat",
      reasoningLevel: "high",
    });
    const converted = convertMessages(
      targetModel,
      { messages: replayMessages } as Parameters<typeof convertMessages>[1],
      targetModel.compat as Parameters<typeof convertMessages>[2],
    );
    const payload = normalizeProviderPayload({
      model: targetModel.id,
      messages: converted,
      tools: [{ type: "function", function: { name: "inspect", parameters: { type: "object" } } }],
    }, targetModel, { mode: "chat", reasoningLevel: "high" });

    expect(sourceMessages[1]).toMatchObject({ model: "deepseek-v4-pro" });
    expect(payload.messages[1]).toMatchObject({
      reasoning_content: "call the inspect tool",
      tool_calls: [{ id: "call_1" }],
    });
  });

  it("preserves an explicitly empty Kimi reasoning step instead of treating it as lost history", () => {
    const model = withThinkingFormatCompat({
      ...OPENAI_COMPAT_BASE,
      id: "k3",
      provider: "kimi-coding",
      baseUrl: "https://api.kimi.com/coding/v1",
      reasoning: true,
    });
    const messages = normalizeProviderContextMessages([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        provider: "kimi-coding",
        api: "openai-completions",
        model: "k3",
        content: [
          { type: "thinking", thinking: "", thinkingSignature: "reasoning_content" },
          { type: "toolCall", id: "call_1", name: "inspect", arguments: {} },
        ],
      },
    ], model, { mode: "chat", reasoningLevel: "max" });
    const converted = convertMessages(
      model,
      { messages } as Parameters<typeof convertMessages>[1],
      model.compat as Parameters<typeof convertMessages>[2],
    );
    const payload = normalizeProviderPayload({ model: "k3", messages: converted }, model, {
      mode: "chat",
      reasoningLevel: "max",
    });

    expect(payload.messages[1]).toMatchObject({
      reasoning_content: "",
      tool_calls: [{ id: "call_1" }],
    });
  });

  it("projects an explicitly empty signed carrier even when the payload hook receives canonical blocks", () => {
    const model = withThinkingFormatCompat({
      ...OPENAI_COMPAT_BASE,
      id: "k3",
      provider: "kimi-coding",
      baseUrl: "https://api.kimi.com/coding/v1",
      reasoning: true,
    });
    const payload = normalizeProviderPayload({
      model: "k3",
      messages: [{
        role: "assistant",
        content: [{ type: "thinking", thinking: "", thinkingSignature: "reasoning_content" }],
        tool_calls: [{ id: "call_1", type: "function", function: { name: "inspect", arguments: "{}" } }],
      }],
    }, model, { mode: "chat", reasoningLevel: "max" });

    expect(payload.messages[0]).toHaveProperty("reasoning_content", "");
  });

  it("fails before serialization when required tool-call reasoning was genuinely lost", () => {
    const model = withThinkingFormatCompat({
      ...OPENAI_COMPAT_BASE,
      id: "k3",
      provider: "kimi-coding",
      baseUrl: "https://api.kimi.com/coding/v1",
      reasoning: true,
    });

    expect(() => normalizeProviderContextMessages([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        provider: "kimi-coding",
        api: "openai-completions",
        model: "k3",
        content: [{ type: "toolCall", id: "call_1", name: "inspect", arguments: {} }],
      },
    ], model, { mode: "chat", reasoningLevel: "max" }))
      .toThrow(/Kimi.*reasoning_content.*tool call/i);
  });

  it("does not transplant reasoning_content between incompatible provider families", () => {
    const targetModel = withThinkingFormatCompat({
      ...OPENAI_COMPAT_BASE,
      id: "deepseek-v4-flash",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      reasoning: true,
    });

    expect(() => normalizeProviderContextMessages([{
      role: "assistant",
      provider: "kimi-coding",
      api: "openai-completions",
      model: "k3",
      content: [
        { type: "thinking", thinking: "Kimi-only reasoning", thinkingSignature: "reasoning_content" },
        { type: "toolCall", id: "call_1", name: "inspect", arguments: {} },
      ],
    }], targetModel, { mode: "chat", reasoningLevel: "high" }))
      .toThrow(/DeepSeek.*reasoning_content.*tool call/i);
  });

  it("does not inject a replay field into generic OpenAI-compatible payloads", () => {
    const payload = {
      model: "private-reasoning-model",
      messages: [{
        role: "assistant",
        content: "visible answer",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "inspect", arguments: "{}" } }],
      }],
    };

    const result = normalizeProviderPayload(payload, {
      id: "private-reasoning-model",
      provider: "custom",
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      reasoning: true,
    }, { mode: "chat", reasoningLevel: "high" });
    expect(result).toEqual({ ...payload, max_tokens: 65_536 });
    expect(result.messages).toEqual(payload.messages);
    expect(payload.messages[0]).not.toHaveProperty("reasoning_content");
  });
});

describe("Pi SDK reasoning carrier conformance", () => {
  it("replays an OpenAI Responses reasoning item from its complete stored JSON", () => {
    const reasoningItem = {
      type: "reasoning",
      id: "rs_123",
      summary: [{ type: "summary_text", text: "opaque summary" }],
      encrypted_content: "opaque-payload",
    };
    const model = {
      ...OPENAI_COMPAT_BASE,
      id: "gpt-test",
      provider: "openai",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
    };

    const converted = convertResponsesMessages(model, {
      messages: [{
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-test",
        content: [{
          type: "thinking",
          thinking: "opaque summary",
          thinkingSignature: JSON.stringify(reasoningItem),
        }],
      }],
    } as Parameters<typeof convertResponsesMessages>[1], new Set(["openai"]), {});

    expect(converted).toEqual([reasoningItem]);
  });

  it("replays an OpenRouter reasoning_details item without flattening it to content", () => {
    const reasoningDetail = {
      type: "reasoning.encrypted",
      id: "call_1",
      data: "opaque-payload",
    };
    const model = {
      ...OPENAI_COMPAT_BASE,
      id: "provider/reasoning-model",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      compat: { thinkingFormat: "openrouter" as const },
    };

    const converted = convertMessages(model, {
      messages: [{
        role: "assistant",
        provider: "openrouter",
        api: "openai-completions",
        model: "provider/reasoning-model",
        content: [{
          type: "toolCall",
          id: "call_1",
          name: "inspect",
          arguments: {},
          thoughtSignature: JSON.stringify(reasoningDetail),
        }],
      }],
    } as Parameters<typeof convertMessages>[1], model.compat as Parameters<typeof convertMessages>[2]);

    expect(converted[0]).toMatchObject({
      reasoning_details: [reasoningDetail],
      tool_calls: [{ id: "call_1" }],
    });
  });
});
