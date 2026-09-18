import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendProviderApiPath,
  normalizeProviderBaseUrlForApi,
  probeProvider,
} from "../lib/llm/provider-client.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider endpoint handling", () => {
  it("appends an API path at most once", () => {
    expect(appendProviderApiPath("https://opencode.ai/zen", "/v1/messages"))
      .toBe("https://opencode.ai/zen/v1/messages");
    expect(appendProviderApiPath("https://opencode.ai/zen/v1", "/v1/messages"))
      .toBe("https://opencode.ai/zen/v1/messages");
    expect(appendProviderApiPath("https://opencode.ai/zen/v1/messages", "/v1/messages"))
      .toBe("https://opencode.ai/zen/v1/messages");
  });

  it("derives an Anthropic SDK base without rewriting unrelated path segments", () => {
    expect(normalizeProviderBaseUrlForApi({
      baseUrl: "https://gateway.example/tenant/anthropic/v1/messages",
      api: "anthropic-messages",
    })).toBe("https://gateway.example/tenant/anthropic");
    expect(normalizeProviderBaseUrlForApi({
      baseUrl: "https://gateway.example/tenant/anthropic/v1",
      api: "anthropic-messages",
    })).toBe("https://gateway.example/tenant/anthropic");
  });

  it("derives OpenAI SDK bases from complete user-entered endpoints", () => {
    expect(normalizeProviderBaseUrlForApi({
      baseUrl: "https://gateway.example/tenant/v1/chat/completions",
      api: "openai-completions",
    })).toBe("https://gateway.example/tenant/v1");
    expect(normalizeProviderBaseUrlForApi({
      baseUrl: "https://gateway.example/tenant/v1/responses",
      api: "openai-responses",
    })).toBe("https://gateway.example/tenant/v1");
    expect(normalizeProviderBaseUrlForApi({
      provider: "kimi-coding",
      baseUrl: "https://api.kimi.com/coding/v1/chat/completions",
      api: "openai-completions",
    })).toBe("https://api.kimi.com/coding/v1");
  });

  it("normalizes OpenCode Zen per protocol from either a root or full Messages endpoint", () => {
    for (const configured of [
      "https://opencode.ai/zen",
      "https://opencode.ai/zen/v1/messages",
    ]) {
      expect(normalizeProviderBaseUrlForApi({
        provider: "opencode",
        baseUrl: configured,
        api: "anthropic-messages",
      })).toBe("https://opencode.ai/zen");
      expect(normalizeProviderBaseUrlForApi({
        provider: "opencode",
        baseUrl: configured,
        api: "openai-completions",
      })).toBe("https://opencode.ai/zen/v1");
      expect(normalizeProviderBaseUrlForApi({
        provider: "opencode",
        baseUrl: configured,
        api: "openai-responses",
      })).toBe("https://opencode.ai/zen/v1");
    }
  });
});

describe("provider connectivity probe", () => {
  it("uses the configured model and accepts only a successful HTTP response", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "claude-sonnet-4-6" });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeProvider({
      baseUrl: "https://opencode.ai/zen/v1/messages",
      api: "anthropic-messages",
      apiKey: "test-key",
      modelId: "claude-sonnet-4-6",
    })).resolves.toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://opencode.ai/zen/v1/messages",
      expect.any(Object),
    );
  });

  it("rejects 404 HTML instead of treating it as connectivity success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>OpenCode</html>", {
      status: 404,
      statusText: "Not Found",
      headers: { "Content-Type": "text/html" },
    })));

    await expect(probeProvider({
      baseUrl: "https://opencode.ai/zen",
      api: "anthropic-messages",
      apiKey: "test-key",
      modelId: "claude-sonnet-4-6",
    })).resolves.toEqual({
      ok: false,
      status: 404,
      error: "HTTP 404 Not Found",
    });
  });
});
