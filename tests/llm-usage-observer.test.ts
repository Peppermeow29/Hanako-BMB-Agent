import { describe, expect, it, vi } from "vitest";
import {
  buildUsageDebugRecord,
  logLlmUsage,
  normalizeLlmUsage,
} from "../lib/llm/usage-observer.ts";

describe("LLM usage observer", () => {
  // Providers disagree on what "input" counts. OpenAI's prompt_tokens is the
  // whole prompt with the cached part folded in; Pi SDK and Anthropic report
  // input as the remainder that was NOT served from cache. Reading the second
  // shape with the first shape's arithmetic produces a hit ratio far above 1
  // and an uncached count pinned to zero, which in turn zeroes the input side
  // of any cost computed from rates. Numbers below are a real ledger record.
  it("reads Pi SDK input as the uncached remainder, not the whole prompt", () => {
    const usage = normalizeLlmUsage({
      input: 337,
      output: 436,
      cacheRead: 107008,
      cacheWrite: 0,
      totalTokens: 107781,
    });

    expect(usage.input.uncachedTokens).toBe(337);
    expect(usage.cache.hitRatio).toBeLessThanOrEqual(1);
    expect(usage.cache.hitRatio).toBeCloseTo(107008 / 107345, 6);
  });

  it("keeps the input side of rate-based cost from collapsing to zero", () => {
    const usage = normalizeLlmUsage(
      { input: 337, output: 436, cacheRead: 107008, cacheWrite: 0, totalTokens: 107781 },
      { costRates: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
    );

    expect(usage.costTotal).toBeCloseTo(337, 6);
  });

  // input_tokens means the opposite thing here than it does on Anthropic: the
  // whole prompt, with the cached slice broken out under input_tokens_details.
  it("treats OpenAI Responses input_tokens as the whole prompt", () => {
    const usage = normalizeLlmUsage({
      input_tokens: 500,
      output_tokens: 40,
      input_tokens_details: { cached_tokens: 400 },
    });

    expect(usage.input.uncachedTokens).toBe(100);
    expect(usage.cache.hitRatio).toBeCloseTo(0.8, 6);
    expect(usage.totalTokens).toBe(540);
  });

  it("normalizes Pi SDK usage and marks cache hits", () => {
    const usage = normalizeLlmUsage({
      input: 1200,
      output: 300,
      cacheRead: 900,
      cacheWrite: 150,
      totalTokens: 2550,
      cost: { total: 0.042 },
    });

    // input is already the uncached remainder, so all 1200 were paid at full
    // price; the prompt itself was 1200 + 900 read + 150 written = 2250.
    expect(usage).toEqual({
      input: { totalTokens: 1200, uncachedTokens: 1200 },
      output: { totalTokens: 300, reasoningTokens: null },
      cache: {
        readTokens: 900,
        writeTokens: 150,
        missTokens: null,
        hit: true,
        created: true,
        hitRatio: 900 / 2250,
        support: "reported",
      },
      totalTokens: 2550,
      costTotal: 0.042,
    });
  });

  it("normalizes Anthropic raw usage fields", () => {
    const usage = normalizeLlmUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 40,
    });

    // Anthropic bills cache reads and writes separately from input_tokens, so
    // the full prompt is 100 + 80 + 40 = 220 and none of the 100 was cached.
    expect(usage).toMatchObject({
      input: { totalTokens: 100, uncachedTokens: 100 },
      output: { totalTokens: 20, reasoningTokens: null },
      cache: {
        readTokens: 80,
        writeTokens: 40,
        hit: true,
        created: true,
        hitRatio: 80 / 220,
        support: "reported",
      },
      totalTokens: 240,
    });
  });

  it("normalizes OpenAI-compatible usage with cached prompt token details", () => {
    const usage = normalizeLlmUsage({
      prompt_tokens: 250,
      completion_tokens: 50,
      total_tokens: 300,
      prompt_tokens_details: { cached_tokens: 180 },
    });

    expect(usage).toMatchObject({
      input: { totalTokens: 250, uncachedTokens: 70 },
      output: { totalTokens: 50, reasoningTokens: null },
      cache: {
        readTokens: 180,
        writeTokens: 0,
        hit: true,
        created: false,
        hitRatio: 0.72,
        support: "reported",
      },
      totalTokens: 300,
    });
  });

  it("normalizes DeepSeek cache hit and miss token fields", () => {
    const usage = normalizeLlmUsage({
      prompt_tokens: 1000,
      completion_tokens: 120,
      total_tokens: 1120,
      prompt_cache_hit_tokens: 720,
      prompt_cache_miss_tokens: 280,
    });

    expect(usage).toMatchObject({
      input: { totalTokens: 1000, uncachedTokens: 280 },
      output: { totalTokens: 120, reasoningTokens: null },
      cache: {
        readTokens: 720,
        writeTokens: 0,
        missTokens: 280,
        hit: true,
        created: false,
        hitRatio: 0.72,
        support: "reported",
      },
      totalTokens: 1120,
    });
  });

  it("preserves unknown cache support instead of treating it as zero", () => {
    const usage = normalizeLlmUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
    }, { cacheSupport: "not_reported" });

    expect(usage).toMatchObject({
      input: { totalTokens: 10, uncachedTokens: null },
      output: { totalTokens: 5, reasoningTokens: null },
      cache: {
        readTokens: null,
        writeTokens: null,
        missTokens: null,
        hit: null,
        created: null,
        hitRatio: null,
        support: "not_reported",
      },
      totalTokens: 15,
    });
  });

  it("builds a structured debug record without request content", () => {
    const record = buildUsageDebugRecord({
      source: "utility",
      api: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 0,
      },
    });

    expect(record).toEqual({
      source: "utility",
      api: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      totalTokens: 200,
      costTotal: null,
      cacheHit: true,
      cacheCreated: false,
    });
  });

  it("writes model usage as one structured debug log line", () => {
    const logger = { log: vi.fn() };

    logLlmUsage({
      logger,
      source: "chat",
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      usage: { input: 10, output: 2, cacheRead: 8, cacheWrite: 0 },
    });

    expect(logger.log).toHaveBeenCalledWith(
      "llm-usage",
      "model_usage {\"source\":\"chat\",\"api\":null,\"provider\":\"anthropic\",\"modelId\":\"claude-opus-4-5\",\"inputTokens\":10,\"outputTokens\":2,\"cacheReadTokens\":8,\"cacheWriteTokens\":0,\"totalTokens\":20,\"costTotal\":null,\"cacheHit\":true,\"cacheCreated\":false}"
    );
  });
});
