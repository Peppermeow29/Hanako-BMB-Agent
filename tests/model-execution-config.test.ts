import { describe, expect, it } from "vitest";

import {
  callTextConfigFromResolvedModel,
  callTextConfigFromUtilityConfig,
  composeResolvedModelExecution,
} from "../core/model-execution-config.ts";

describe("model execution config", () => {
  it("keeps the selected model protocol and normalized endpoint ahead of catalog credential metadata", () => {
    const resolved = composeResolvedModelExecution({
      model: {
        id: "k3",
        provider: "kimi-coding",
        api: "openai-completions",
        baseUrl: "https://api.kimi.com/coding/v1",
      },
      credential: {
        api: "anthropic-messages",
        apiKey: "sk-kimi",
        baseUrl: "https://api.kimi.com/coding/",
        credentialSource: "provider-catalog",
      },
    });

    expect(resolved).toMatchObject({
      api: "openai-completions",
      apiKey: "sk-kimi",
      baseUrl: "https://api.kimi.com/coding/v1",
      credentialSource: "provider-catalog",
    });
  });

  it("preserves an AuthStorage resource URL as the dynamic execution endpoint", () => {
    const resolved = composeResolvedModelExecution({
      model: {
        id: "oauth-model",
        provider: "oauth-provider",
        api: "openai-responses",
        baseUrl: "https://static.example/v1",
      },
      credential: {
        api: "openai-responses",
        apiKey: "fresh-token",
        baseUrl: "https://tenant-resource.example/v1",
        credentialSource: "auth-storage",
      },
    });

    expect(resolved.api).toBe("openai-responses");
    expect(resolved.baseUrl).toBe("https://tenant-resource.example/v1");
  });

  it("composes safe AuthStorage protocol and model headers into an explicit call config", () => {
    const resolved = composeResolvedModelExecution({
      model: {
        id: "grok-4.5",
        provider: "xai-oauth",
        api: "openai-responses",
        headers: {
          Authorization: "Bearer stale-model",
          "x-grok-model-override": "grok-4.5",
        },
      },
      credential: {
        api_key: "fresh-token",
        base_url: "https://cli-chat-proxy.grok.com/v1",
        headers: {
          Cookie: "provider=stale",
          "x-xai-token-auth": "xai-grok-cli",
          "x-grok-client-version": "0.2.95",
        },
        credential_source: "auth-storage",
      },
    });

    expect(resolved.headers).toEqual({
      "x-grok-model-override": "grok-4.5",
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": "0.2.95",
    });
    expect(callTextConfigFromResolvedModel(resolved)).toEqual({
      api: "openai-responses",
      apiKey: "fresh-token",
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      headers: resolved.headers,
      model: resolved.model,
    });
  });

  it("preserves provider-catalog gateway headers and strips explicit override model credentials", () => {
    const catalog = composeResolvedModelExecution({
      model: { id: "proxy-model", provider: "proxy", headers: { "x-route": "model" } },
      credential: {
        api: "openai-completions",
        apiKey: "catalog-key",
        baseUrl: "https://proxy.example/v1",
        headers: { Authorization: "Gateway secret", "X-Route": "provider" },
        credentialSource: "provider-catalog",
      },
    });
    expect(catalog.headers).toEqual({ Authorization: "Gateway secret", "x-route": "model" });

    const override = composeResolvedModelExecution({
      model: {
        id: "proxy-model",
        provider: "proxy",
        baseUrl: "https://model.example/v1",
        headers: { Authorization: "Bearer stale", "X-Route": "stale" },
        accountId: "acct_stale",
      },
      credential: {
        api: "openai-completions",
        apiKey: "override-key",
        baseUrl: "https://override.example/v1",
        credentialSource: "explicit-utility-override",
      },
    });
    expect(override.baseUrl).toBe("https://override.example/v1");
    expect(override.headers).toEqual({});
    expect(override.model).not.toHaveProperty("headers");
    expect(override.model).not.toHaveProperty("accountId");
  });

  it("maps both utility roles through the same resolved-model adapter", () => {
    const utility = { id: "small", provider: "p" };
    const large = { id: "large", provider: "p" };
    const config = {
      utility,
      utility_large: large,
      api: "api-small",
      api_key: "key-small",
      base_url: "https://small.example/v1",
      headers: { "X-Model": "small" },
      large_api: "api-large",
      large_api_key: "key-large",
      large_base_url: "https://large.example/v1",
      large_headers: { "X-Model": "large" },
    };

    expect(callTextConfigFromUtilityConfig(config)).toEqual({
      api: "api-small",
      apiKey: "key-small",
      baseUrl: "https://small.example/v1",
      headers: { "X-Model": "small" },
      model: utility,
    });
    expect(callTextConfigFromUtilityConfig(config, "utility_large")).toEqual({
      api: "api-large",
      apiKey: "key-large",
      baseUrl: "https://large.example/v1",
      headers: { "X-Model": "large" },
      model: large,
    });
    expect(() => callTextConfigFromUtilityConfig(config, "embed")).toThrow(/Unsupported utility role/);
  });
});
