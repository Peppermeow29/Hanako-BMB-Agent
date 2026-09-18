import { describe, expect, it } from "vitest";
import { enrichModelFromKnownMetadata } from "../core/model-known-enrichment.ts";

describe("enrichModelFromKnownMetadata", () => {
  it("adds Hana metadata to Pi built-in Kimi models without dropping request headers", () => {
    const model = {
      id: "kimi-for-coding",
      name: "Kimi For Coding",
      api: "anthropic-messages",
      provider: "kimi-coding",
      baseUrl: "https://api.kimi.com/coding",
      headers: { "User-Agent": "KimiCLI/1.5" },
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 32768,
    };

    const enriched = enrichModelFromKnownMetadata(model);

    expect(enriched.headers).toEqual({ "User-Agent": "KimiCLI/1.5" });
    expect(enriched.visionCapabilities).toMatchObject({
      grounding: true,
      outputFormat: "anchor",
    });
    expect(enriched.compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "kimi",
      reasoningProfile: "kimi-openai",
    });
    expect(enriched.api).toBe("openai-completions");
    expect(enriched.baseUrl).toBe("https://api.kimi.com/coding/v1");
  });

  it("normalizes Kimi transport and reuses request headers without replacing user model metadata", () => {
    const model = {
      id: "k3",
      name: "User-defined K3",
      api: "anthropic-messages",
      provider: "kimi-coding",
      baseUrl: "https://api.kimi.com/coding",
      reasoning: true,
      input: ["text"],
      contextWindow: 777777,
      maxTokens: 12345,
      cost: {
        input: 9,
        output: 8,
        cacheRead: 7,
        cacheWrite: 6,
      },
    };

    const enriched = enrichModelFromKnownMetadata(model);

    expect(enriched).toMatchObject({
      id: "k3",
      name: "User-defined K3",
      input: ["text"],
      contextWindow: 777777,
      maxTokens: 12345,
      cost: {
        input: 9,
        output: 8,
        cacheRead: 7,
        cacheWrite: 6,
      },
    });
    expect(enriched.headers).toEqual({ "User-Agent": "KimiCLI/1.5" });
    expect(enriched.api).toBe("openai-completions");
    expect(enriched.baseUrl).toBe("https://api.kimi.com/coding/v1");
    expect(enriched.compat).toMatchObject({
      thinkingFormat: "kimi",
      reasoningProfile: "kimi-openai",
    });
  });

  it("fills the endpoint reasoning contract for a future Kimi id without overwriting its identity", () => {
    const enriched = enrichModelFromKnownMetadata({
      id: "future-kimi-code-model",
      name: "Future Kimi",
      api: "openai-completions",
      provider: "kimi-coding",
      baseUrl: "https://api.kimi.com/coding/v1",
      input: ["text"],
    });

    expect(enriched).toMatchObject({
      id: "future-kimi-code-model",
      name: "Future Kimi",
      reasoning: true,
      compat: {
        thinkingFormat: "kimi",
        reasoningProfile: "kimi-openai",
        reasoningReplay: {
          carrier: "reasoning_content",
          policy: "require-tool-call",
        },
      },
    });
  });

  it("adds image input to runtime-discovered Ollama vision model families", () => {
    const model = {
      id: "llava:latest",
      name: "LLaVA Latest",
      api: "openai-completions",
      provider: "ollama",
      baseUrl: "http://localhost:11434/v1",
    };

    const enriched = enrichModelFromKnownMetadata(model);

    expect(enriched.input).toEqual(["text", "image"]);
  });

  it("preserves an explicit text-only input contract ahead of known image metadata", () => {
    const model = {
      id: "kimi-for-coding",
      name: "Kimi For Coding",
      api: "openai-completions",
      provider: "kimi-coding",
      baseUrl: "https://api.kimi.com/coding/v1",
      input: ["text"],
    };

    const enriched = enrichModelFromKnownMetadata(model);

    expect(enriched.input).toEqual(["text"]);
    expect(enriched).not.toHaveProperty("visionCapabilities");
  });

  it("marks runtime-discovered Volcengine coding models without image metadata as text-only", () => {
    const model = {
      id: "ark-code-latest",
      name: "Ark Code Latest",
      api: "openai-completions",
      provider: "volcengine-coding",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    };

    const enriched = enrichModelFromKnownMetadata(model);

    expect(enriched.input).toEqual(["text"]);
  });

  it("keeps known Volcengine coding vision models image-capable", () => {
    const model = {
      id: "doubao-seed-2-0-pro-260215",
      name: "Doubao Seed 2.0 Pro",
      api: "openai-completions",
      provider: "volcengine-coding",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    };

    const enriched = enrichModelFromKnownMetadata(model);

    expect(enriched.input).toEqual(["text", "image"]);
  });
});
