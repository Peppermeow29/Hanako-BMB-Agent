import { describe, expect, it } from "vitest";
import {
  getReasoningProfile,
  getThinkingFormat,
  normalizeProviderPayload,
} from "../../core/provider-compat.ts";

const kimiModel = {
  id: "kimi-for-coding",
  provider: "kimi-coding",
  api: "openai-completions",
  baseUrl: "https://api.kimi.com/coding/v1",
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
    supportsDeveloperRole: false,
    thinkingFormat: "kimi",
    reasoningProfile: "kimi-openai",
  },
};

describe("provider-compat/kimi", () => {
  it("declares the official Kimi OpenAI-compatible thinking contract", () => {
    expect(getThinkingFormat(kimiModel)).toBe("kimi");
    expect(getReasoningProfile(kimiModel)).toBe("kimi-openai");
  });

  it("maps legacy medium to Kimi high in chat mode", () => {
    const payload = {
      model: "kimi-for-coding",
      max_tokens: 12000,
      messages: [{ role: "user", content: "hi" }],
    };

    const result = normalizeProviderPayload(payload, kimiModel, {
      mode: "chat",
      reasoningLevel: "medium",
    });

    expect(result).not.toBe(payload);
    expect(result).toMatchObject({
      model: "kimi-for-coding",
      max_completion_tokens: 12000,
      reasoning_effort: "high",
      thinking: { type: "enabled" },
    });
    expect(result).not.toHaveProperty("max_tokens");
  });

  it("maps Hana Max/xhigh to Kimi max effort", () => {
    const result = normalizeProviderPayload({
      model: "kimi-for-coding",
      messages: [{ role: "user", content: "hi" }],
    }, kimiModel, {
      mode: "chat",
      reasoningLevel: "xhigh",
    });

    expect(result.reasoning_effort).toBe("max");
    expect(result.thinking).toEqual({ type: "enabled", keep: "all" });
    expect(result).not.toHaveProperty("output_config");
  });

  it.each([
    ["low", "low"],
    ["high", "high"],
    ["max", "max"],
  ])("maps the visible %s level to Kimi %s", (reasoningLevel, expectedEffort) => {
    const result = normalizeProviderPayload({
      model: "kimi-for-coding",
      messages: [{ role: "user", content: "hi" }],
    }, kimiModel, {
      mode: "chat",
      reasoningLevel,
    });

    expect(result.reasoning_effort).toBe(expectedEffort);
    expect(result).not.toHaveProperty("reasoning_effort", "auto");
    expect(result).not.toHaveProperty("reasoning_effort", "medium");
  });

  it("resolves legacy auto from the model default instead of generic medium", () => {
    const result = normalizeProviderPayload({
      model: "kimi-for-coding",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "auto",
    }, kimiModel, {
      mode: "chat",
      reasoningLevel: "auto",
    });

    expect(result.reasoning_effort).toBe("high");
  });

  it("honors a model-level thinkingLevelMap override", () => {
    const result = normalizeProviderPayload({
      model: "kimi-for-coding",
      messages: [{ role: "user", content: "hi" }],
    }, {
      ...kimiModel,
      thinkingLevelMap: { ...kimiModel.thinkingLevelMap, high: "max" },
    }, {
      mode: "chat",
      reasoningLevel: "high",
    });

    expect(result.reasoning_effort).toBe("max");
  });

  it("turns thinking off without leaving a reasoning effort", () => {
    const result = normalizeProviderPayload({
      model: "kimi-for-coding",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    }, kimiModel, {
      mode: "chat",
      reasoningLevel: "off",
    });

    expect(result.reasoning_effort).toBeUndefined();
    expect(result.thinking).toEqual({ type: "disabled" });
  });

  it("disables thinking and strips replayed reasoning_content for utility calls", () => {
    const payload = {
      model: "kimi-for-coding",
      messages: [
        { role: "assistant", content: "answer", reasoning_content: "private" },
        { role: "user", content: "summarize" },
      ],
      reasoning_effort: "medium",
      thinking: { type: "enabled", keep: "all" },
    };

    const result = normalizeProviderPayload(payload, kimiModel, { mode: "utility" });

    expect(result).not.toBe(payload);
    expect(result.reasoning_effort).toBeUndefined();
    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result.messages[0]).not.toHaveProperty("reasoning_content");
  });

  it("fixes kimi-for-coding utility temperature at the provider-compatible value", () => {
    const result = normalizeProviderPayload({
      model: "kimi-for-coding",
      messages: [{ role: "user", content: "summarize" }],
      temperature: 0.3,
    }, kimiModel, { mode: "utility" });

    expect(result.temperature).toBe(0.6);
    expect(result.thinking).toEqual({ type: "disabled" });
  });

  it("uses Moonshot K2.6's mode-specific fixed temperatures", () => {
    const model = {
      ...kimiModel,
      id: "kimi-k2.6",
      provider: "moonshot",
      baseUrl: "https://api.moonshot.cn/v1",
    };

    const chat = normalizeProviderPayload({
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.9,
    }, model, { mode: "chat", reasoningLevel: "low" });
    const utility = normalizeProviderPayload({
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "summarize" }],
      temperature: 0.2,
    }, model, { mode: "utility" });

    expect(chat.temperature).toBe(1.0);
    expect(utility.temperature).toBe(0.6);
    expect(utility.thinking).toEqual({ type: "disabled" });
  });

  it.each(["k3", "k3-256k", "kimi-k3"])(
    "omits unsupported temperature from %s summary requests",
    (modelId) => {
      const result = normalizeProviderPayload({
        model: modelId,
        messages: [{ role: "user", content: "summarize" }],
        temperature: 0.3,
      }, {
        ...kimiModel,
        id: modelId,
      }, { mode: "utility" });

      expect(result).not.toHaveProperty("temperature");
      expect(result.thinking).toEqual({ type: "disabled" });
    },
  );

  it("omits unsupported K3 temperature from chat requests", () => {
    const result = normalizeProviderPayload({
      model: "k3",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
    }, {
      ...kimiModel,
      id: "k3",
    }, {
      mode: "chat",
      reasoningLevel: "high",
    });

    expect(result).not.toHaveProperty("temperature");
    expect(result.thinking).toEqual({ type: "enabled", keep: "all" });
  });

  it("uses Moonshot K3 reasoning_effort without the unsupported K2 thinking field", () => {
    const result = normalizeProviderPayload({
      model: "kimi-k3",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      thinking: { type: "enabled" },
    }, {
      ...kimiModel,
      id: "kimi-k3",
      provider: "moonshot",
      baseUrl: "https://api.moonshot.cn/v1",
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "low",
        high: "high",
        xhigh: "max",
      },
    }, {
      mode: "chat",
      reasoningLevel: "low",
    });

    expect(result).not.toHaveProperty("temperature");
    expect(result).not.toHaveProperty("thinking");
    expect(result.reasoning_effort).toBe("low");
  });

  it("does not send a disabled K2 thinking field for Moonshot K3 utility calls", () => {
    const result = normalizeProviderPayload({
      model: "kimi-k3",
      messages: [{ role: "user", content: "summarize" }],
      thinking: { type: "disabled" },
    }, {
      ...kimiModel,
      id: "kimi-k3",
      provider: "moonshot",
      baseUrl: "https://api.moonshot.cn/v1",
    }, { mode: "utility" });

    expect(result).not.toHaveProperty("thinking");
    expect(result).not.toHaveProperty("reasoning_effort");
  });

  it("recovers reasoning_content for Kimi tool-call replay", () => {
    const payload = {
      model: "kimi-for-coding",
      messages: [
        {
          role: "assistant",
          content: [{
            type: "thinking",
            thinking: "I need to inspect the file.",
            thinkingSignature: "reasoning_content",
          }],
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "Read", arguments: "{}" },
          }],
        },
      ],
    };

    const result = normalizeProviderPayload(payload, kimiModel, {
      mode: "chat",
      reasoningLevel: "high",
    });

    expect(result.messages[0]).toMatchObject({
      reasoning_content: "I need to inspect the file.",
    });
  });

  it("keeps root tool parameters object-shaped while removing Kimi-incompatible root anyOf", () => {
    const schemaOnlyKimiModel = {
      id: "kimi-for-coding",
      provider: "kimi-coding",
      api: "openai-completions",
      baseUrl: "https://api.kimi.com/coding/v1",
      compat: kimiModel.compat,
    };
    const officeReadParameters = {
      type: "object",
      properties: {
        resource: { type: "object", description: "ResourceIO ResourceRef to read." },
        filePath: { type: "string", description: "Legacy absolute local path." },
        outputFormat: { type: "string", enum: ["text", "markdown", "html", "json"] },
      },
      anyOf: [
        { required: ["resource"] },
        { required: ["filePath"] },
      ],
    };
    const payload = {
      model: "kimi-for-coding",
      messages: [{ role: "user", content: "read this" }],
      tools: [{
        type: "function",
        function: {
          name: "office_read-document",
          description: "Read supported Office/text documents into structured text.",
          parameters: officeReadParameters,
        },
      }],
    };

    const result = normalizeProviderPayload(payload, schemaOnlyKimiModel, { mode: "chat" });
    const parameters = result.tools[0].function.parameters;

    expect(result).not.toBe(payload);
    expect(result.tools).not.toBe(payload.tools);
    expect(payload.tools[0].function.parameters).toBe(officeReadParameters);
    expect(payload.tools[0].function.parameters).toHaveProperty("type", "object");
    expect(parameters).toHaveProperty("type", "object");
    expect(parameters).toHaveProperty("properties", officeReadParameters.properties);
    expect(parameters).not.toHaveProperty("anyOf");
    expect(parameters.description).toContain("required field sets: resource; filePath");
  });

  it("normalizes nested anyOf schemas without changing other providers", () => {
    const schemaOnlyKimiModel = {
      id: "kimi-for-coding",
      provider: "kimi-coding",
      api: "openai-completions",
      baseUrl: "https://api.kimi.com/coding/v1",
      compat: kimiModel.compat,
    };
    const payload = {
      model: "kimi-for-coding",
      messages: [{ role: "user", content: "choose" }],
      tools: [{
        type: "function",
        function: {
          name: "choose",
          description: "Choose a value.",
          parameters: {
            type: "object",
            properties: {
              value: {
                type: "string",
                description: "The selected value.",
                anyOf: [
                  { enum: ["a"] },
                  { enum: ["b"] },
                ],
              },
            },
          },
        },
      }],
    };

    const kimiResult = normalizeProviderPayload(payload, schemaOnlyKimiModel, { mode: "chat" });
    const valueSchema = kimiResult.tools[0].function.parameters.properties.value;

    expect(kimiResult.tools[0].function.parameters).toHaveProperty("type", "object");
    expect(valueSchema).not.toHaveProperty("type");
    expect(valueSchema.description).toBe("The selected value.");
    expect(valueSchema.anyOf).toEqual([
      { type: "string", enum: ["a"] },
      { type: "string", enum: ["b"] },
    ]);

    const nonKimiResult = normalizeProviderPayload(payload, {
      id: "gpt-test",
      provider: "openai",
      api: "openai-completions",
    }, { mode: "chat" });
    expect(nonKimiResult).toEqual({ ...payload, max_tokens: 65_536 });
    expect(nonKimiResult.tools).toEqual(payload.tools);
  });
});
