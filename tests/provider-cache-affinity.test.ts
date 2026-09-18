import { describe, expect, it, vi } from "vitest";
import {
  applyProviderCacheAffinityToPayload,
  normalizeProviderCacheAffinityKey,
  withProviderCacheAffinity,
} from "../lib/llm/provider-cache-affinity.ts";

describe("provider cache affinity", () => {
  it("rewrites provider cache fields without replacing the real Pi Session identity", async () => {
    const baseOnPayload = vi.fn((payload) => ({ ...payload, normalized: true }));
    const options = withProviderCacheAffinity({
      sessionId: "pi-child-session",
      headers: { Authorization: "Bearer test" },
      onPayload: baseOnPayload,
    }, {
      api: "openai-completions",
      compat: { sendSessionAffinityHeaders: true },
    }, "pi-source-lineage");

    expect(options.sessionId).toBe("pi-child-session");
    expect(options.headers).toMatchObject({
      Authorization: "Bearer test",
      session_id: "pi-source-lineage",
      "x-client-request-id": "pi-source-lineage",
      "x-session-affinity": "pi-source-lineage",
    });
    const payload = await options.onPayload({
      prompt_cache_key: "pi-child-session",
      messages: [],
    }, { api: "openai-completions" });
    expect(baseOnPayload).toHaveBeenCalledOnce();
    expect(payload).toMatchObject({
      prompt_cache_key: "pi-source-lineage",
      normalized: true,
    });
  });

  it("keeps unsupported OpenAI-compatible headers untouched while still rewriting cache payloads", async () => {
    const options = withProviderCacheAffinity({
      sessionId: "pi-child",
      headers: { "x-test": "1" },
    }, {
      api: "openai-completions",
    }, "pi-source");

    expect(options.headers).toEqual({ "x-test": "1" });
    await expect(options.onPayload({ prompt_cache_key: "pi-child" }, null)).resolves.toEqual({
      prompt_cache_key: "pi-source",
    });
  });

  it("keeps Codex transport ownership on the child while sharing its prompt cache key", async () => {
    const options = withProviderCacheAffinity({ sessionId: "pi-child" }, {
      api: "openai-codex-responses",
    }, "pi-source");

    expect(options.sessionId).toBe("pi-child");
    expect(options.headers).toBeUndefined();
    await expect(options.onPayload({ prompt_cache_key: "pi-child" }, null)).resolves.toEqual({
      prompt_cache_key: "pi-source",
    });
  });

  it("supports Mistral's camelCase cache key and affinity header", async () => {
    const options = withProviderCacheAffinity({ sessionId: "pi-child" }, {
      api: "mistral-conversations",
    }, "pi-source");

    expect(options.sessionId).toBe("pi-child");
    expect(options.headers).toEqual({ "x-affinity": "pi-source" });
    await expect(options.onPayload({ promptCacheKey: "pi-child" }, null)).resolves.toEqual({
      promptCacheKey: "pi-source",
    });
  });

  it("does not enable affinity when provider caching is disabled", () => {
    const options = {
      sessionId: "pi-child",
      cacheRetention: "none",
      headers: { "x-test": "1" },
    };
    expect(withProviderCacheAffinity(options, { api: "openai-responses" }, "pi-source"))
      .toBe(options);
  });

  it("clamps persisted keys to the provider-safe length and leaves unrelated payloads untouched", () => {
    const key = normalizeProviderCacheAffinityKey("x".repeat(80));
    expect(key).toHaveLength(64);
    const payload = { messages: [] };
    expect(applyProviderCacheAffinityToPayload(payload, key)).toBe(payload);
  });
});
