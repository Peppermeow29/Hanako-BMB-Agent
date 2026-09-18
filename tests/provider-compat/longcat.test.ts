import { describe, expect, it } from "vitest";
import {
  getThinkingFormat,
  normalizeProviderPayload,
} from "../../core/provider-compat.ts";

const longcatModel = {
  id: "LongCat-2.0-Preview",
  provider: "longcat",
  api: "openai-completions",
  baseUrl: "https://api.longcat.chat/openai/v1",
  reasoning: true,
};

describe("provider-compat/longcat", () => {
  it("declares the LongCat thinking contract", () => {
    expect(getThinkingFormat(longcatModel)).toBe("longcat");
    expect(getThinkingFormat({
      ...longcatModel,
      provider: "custom",
      baseUrl: "https://api.longcat.chat/openai/v1",
    })).toBe("longcat");
  });

  it("disables thinking and strips stale reasoning history for utility requests", () => {
    const payload = {
      model: "LongCat-2.0-Preview",
      messages: [
        { role: "assistant", content: "answer", reasoning_content: "private" },
        { role: "user", content: "summarize" },
      ],
      reasoning_effort: "high",
    };

    const result = normalizeProviderPayload(payload, longcatModel, { mode: "utility" });

    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result.messages[0]).not.toHaveProperty("reasoning_content");
  });
});
