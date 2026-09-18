import { describe, expect, it, vi } from "vitest";

import { ExecutionRouter } from "../core/execution-router.ts";

function createRouter(models, freshResolver = null) {
  const modelList = Object.values(models) as any[];
  const providerRegistry = {
    get: vi.fn((provider) => ({ id: provider, api: `provider-api-${provider}` })),
    getCredentials: vi.fn(() => ({
      api: "stale-provider-api",
      apiKey: "stale-provider-key",
      baseUrl: "https://stale.example/v1",
      headers: {
        Authorization: "Bearer stale-header-token",
        Cookie: "session=stale",
      },
      accountId: "acct_stale",
    })),
    allowsMissingApiKey: vi.fn(() => false),
  };
  const router = new ExecutionRouter(
    (ref) => {
      if (!ref || typeof ref !== "object") return null;
      return modelList.find((model) => model.id === ref.id && model.provider === ref.provider) || null;
    },
    providerRegistry,
    freshResolver,
  );
  return { router, providerRegistry };
}

describe("ExecutionRouter fresh credential routing", () => {
  it("refreshes once for same-provider utility models while preserving each model API", async () => {
    const models = {
      utility: {
        id: "small",
        provider: "oauth-runtime",
        api: "openai-responses",
        headers: {
          Authorization: "Bearer model-stale",
          "x-grok-model-override": "small",
        },
      },
      large: {
        id: "large",
        provider: "oauth-runtime",
        api: "openai-codex-responses",
        headers: {
          Cookie: "model=stale",
          "x-grok-model-override": "large",
        },
      },
    };
    const fresh = vi.fn(async () => ({
      api_key: "fresh-token",
      base_url: "https://fresh.example/v1",
      api: "provider-default",
      headers: {
        Authorization: "Bearer provider-stale",
        "x-grok-client-version": "0.2.95",
      },
      accountId: "acct_fresh",
      credential_source: "auth-storage",
    }));
    const { router } = createRouter(models, fresh);

    const config = await router.resolveUtilityConfigFresh({}, {
      utility: { id: "small", provider: "oauth-runtime" },
      utility_large: { id: "large", provider: "oauth-runtime" },
    }, {});

    expect(fresh).toHaveBeenCalledOnce();
    expect(fresh).toHaveBeenCalledWith("oauth-runtime");
    expect(config).toMatchObject({
      api: "openai-responses",
      large_api: "openai-codex-responses",
      api_key: "fresh-token",
      large_api_key: "fresh-token",
    });
    expect(config.headers).toEqual({
      "x-grok-client-version": "0.2.95",
      "x-grok-model-override": "small",
    });
    expect(config.large_headers).toEqual({
      "x-grok-client-version": "0.2.95",
      "x-grok-model-override": "large",
    });
    expect(config.utility).toMatchObject({ accountId: "acct_fresh", headers: config.headers });
    expect(config.utility_large).toMatchObject({ headers: config.large_headers });
  });

  it("refreshes different utility providers independently", async () => {
    const models = {
      utility: { id: "small", provider: "provider-a", api: "api-small" },
      large: { id: "large", provider: "provider-b", api: "api-large" },
    };
    const fresh = vi.fn(async (provider) => ({
      api_key: `key-${provider}`,
      base_url: `https://${provider}.example/v1`,
      api: `default-${provider}`,
      headers: {},
      credential_source: "provider-catalog",
    }));
    const { router } = createRouter(models, fresh);

    const config = await router.resolveUtilityConfigFresh({}, {
      utility: { id: "small", provider: "provider-a" },
      utility_large: { id: "large", provider: "provider-b" },
    }, {});

    expect(fresh.mock.calls.map(([provider]) => provider)).toEqual(["provider-a", "provider-b"]);
    expect(config).toMatchObject({
      api: "api-small",
      api_key: "key-provider-a",
      large_api: "api-large",
      large_api_key: "key-provider-b",
    });
  });

  it("keeps an explicit utility endpoint authoritative and skips refresh without inheriting stale credentials", async () => {
    const models = {
      utility: {
        id: "small",
        provider: "oauth-runtime",
        api: "api-small",
        headers: { Authorization: "Bearer model-stale", Cookie: "model=stale" },
        accountId: "acct_model_stale",
      },
      large: {
        id: "large",
        provider: "oauth-runtime",
        api: "api-large",
        headers: { Authorization: "Bearer large-stale" },
      },
    };
    const fresh = vi.fn(async () => {
      throw new Error("must not refresh");
    });
    const { router, providerRegistry } = createRouter(models, fresh);

    const config = await router.resolveUtilityConfigFresh({}, {
      utility: { id: "small", provider: "oauth-runtime" },
      utility_large: { id: "large", provider: "oauth-runtime" },
    }, {
      provider: "oauth-runtime",
      api_key: "override-key",
      base_url: "https://override.example/v1",
    });

    expect(fresh).not.toHaveBeenCalled();
    expect(providerRegistry.getCredentials).not.toHaveBeenCalled();
    expect(config).toMatchObject({
      api: "api-small",
      api_key: "override-key",
      base_url: "https://override.example/v1",
      large_api: "api-large",
      large_api_key: "override-key",
    });
    expect(config.utility).not.toHaveProperty("headers");
    expect(config.utility).not.toHaveProperty("accountId");
    expect(config.utility_large).not.toHaveProperty("headers");
  });

  it("fails closed when no fresh resolver is installed", async () => {
    const models = {
      utility: { id: "small", provider: "provider-a", api: "api-small" },
    };
    const { router } = createRouter(models);

    await expect(router.resolveUtilityConfigFresh({}, {
      utility: { id: "small", provider: "provider-a" },
    }, {}, { requireUtilityLarge: false })).rejects.toThrow(/Fresh credential resolver/);
  });
});
