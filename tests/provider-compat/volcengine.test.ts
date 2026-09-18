import { describe, expect, it } from "vitest";
import {
  getThinkingFormat,
  normalizeProviderPayload,
} from "../../core/provider-compat.ts";

const volcengineModel = {
  id: "doubao-seed-2-0-pro-260215",
  provider: "volcengine",
  api: "openai-completions",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  reasoning: true,
};

describe("provider-compat/volcengine", () => {
  it("declares the official Volcengine thinking contract", () => {
    expect(getThinkingFormat(volcengineModel)).toBe("volcengine");
    expect(getThinkingFormat({
      ...volcengineModel,
      provider: "custom",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    })).toBe("volcengine");
  });

  it("enables thinking while preserving supported Chat Completions effort", () => {
    const payload = {
      model: "doubao-seed-2-0-pro-260215",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "medium",
    };

    const result = normalizeProviderPayload(payload, volcengineModel, {
      mode: "chat",
      reasoningLevel: "high",
    });

    expect(result).not.toBe(payload);
    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result.reasoning_effort).toBe("high");
  });

  it("does not treat an omitted reasoning level as off for reasoning models", () => {
    const result = normalizeProviderPayload({
      model: "doubao-seed-2-0-pro-260215",
      messages: [{ role: "user", content: "hi" }],
    }, volcengineModel, { mode: "chat" });

    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result).not.toHaveProperty("reasoning_effort");
  });

  it("maps Hana max effort to Volcengine high instead of leaking unsupported max", () => {
    const result = normalizeProviderPayload({
      model: "doubao-seed-2-0-pro-260215",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "max",
    }, volcengineModel, {
      mode: "chat",
      reasoningLevel: "max",
    });

    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result.reasoning_effort).toBe("high");
  });

  it("disables thinking and strips stale reasoning history for utility/off requests", () => {
    const payload = {
      model: "doubao-seed-2-0-pro-260215",
      messages: [
        { role: "assistant", content: "answer", reasoning_content: "private" },
        { role: "user", content: "summarize" },
      ],
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    };

    const result = normalizeProviderPayload(payload, volcengineModel, { mode: "utility" });

    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result.messages[0]).not.toHaveProperty("reasoning_content");
  });
});
