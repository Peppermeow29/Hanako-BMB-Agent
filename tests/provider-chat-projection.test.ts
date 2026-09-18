import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProviderRegistry } from "../core/provider-registry.ts";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-provider-chat-projection-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("ProviderRegistry chat projection plans", () => {
  it("centralizes missing, empty, and non-empty model selection semantics", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const defaults = registry.getChatModelSelection("openai-codex-oauth");
    expect(defaults).toMatchObject({
      hasExplicitModels: false,
      selectionMode: "default",
    });
    expect(defaults?.models.map((model) => typeof model === "object" ? model.id : model)).toContain("gpt-5.6-sol");

    registry.saveProvider("openai-codex-oauth", { models: [] });
    expect(registry.getChatModelSelection("openai-codex-oauth")).toMatchObject({
      hasExplicitModels: true,
      selectionMode: "disabled",
      models: [],
    });
    expect(registry.getChatDiscoverableModelEntries("openai-codex-oauth")).toContain("gpt-5.6-sol");

    registry.saveProvider("openai-codex-oauth", { models: ["gpt-5.6-terra"] });
    expect(registry.getChatModelSelection("openai-codex-oauth")).toMatchObject({
      hasExplicitModels: true,
      selectionMode: "allowlist",
      models: ["gpt-5.6-terra"],
    });
    expect(registry.getChatDiscoverableModelEntries("openai-codex-oauth")).toEqual(
      expect.arrayContaining(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
    );
  });

  it("fails closed instead of enabling defaults for an invalid models config", () => {
    fs.writeFileSync(path.join(tmpHome, "provider-catalog.json"), JSON.stringify({
      catalogVersion: 2,
      providers: {
        "openai-codex-oauth": {
          models: "gpt-5.6-sol",
        },
      },
      capabilities: {},
      meta: {},
    }, null, 2));

    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    expect(registry.getAllProvidersRaw()["openai-codex-oauth"]).toMatchObject({
      _config_error: "invalid_models_config",
    });
    expect(registry.getChatModelSelection("openai-codex-oauth")).toMatchObject({
      configError: "invalid_models_config",
      hasExplicitModels: false,
      selectionMode: "invalid",
      models: [],
    });
    expect(registry.getChatProjectionPlans()
      .find((plan) => plan.sourceProviderId === "openai-codex-oauth")).toMatchObject({
      selectionMode: "invalid",
      config: { models: [] },
    });
    expect(registry.getChatDiscoverableModelEntries("openai-codex-oauth")).toContain("gpt-5.6-sol");
  });

  it("projects the canonical Codex catalog to its auth-storage runtime identity", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const plan = registry.getChatProjectionPlans()
      .find((item) => item.sourceProviderId === "openai-codex-oauth");
    expect(plan).toMatchObject({
      sourceProviderId: "openai-codex-oauth",
      runtimeProviderId: "openai-codex",
      projection: "models-json",
      credentialSource: "auth-storage",
      hasExplicitModels: false,
      selectionMode: "default",
    });
  });

  it("projects Grok OAuth through its dedicated subscription runtime", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    const plan = registry.getChatProjectionPlans()
      .find((item) => item.sourceProviderId === "xai-oauth");
    expect(plan).toMatchObject({
      sourceProviderId: "xai-oauth",
      runtimeProviderId: "xai-oauth",
      projection: "models-json",
      credentialSource: "auth-storage",
      selectionMode: "default",
      config: {
        base_url: "https://cli-chat-proxy.grok.com/v1",
        api: "openai-responses",
      },
    });
    expect(plan?.config.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "grok-4.5",
        api: "openai-responses",
        context: 500_000,
        maxOutput: 128_000,
        image: true,
        reasoning: true,
      }),
      expect.objectContaining({ id: "grok-4.3", context: 1_000_000 }),
    ]));
    expect(plan?.config.headers).toEqual({
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": "0.2.95",
      "x-grok-client-identifier": "hana",
    });
    expect(plan?.modelExecutionHeaders).toEqual({
      "grok-4.5": { "x-grok-model-override": "grok-4.5" },
      "grok-4.5-latest": { "x-grok-model-override": "grok-4.5-latest" },
      "grok-build-latest": { "x-grok-model-override": "grok-build-latest" },
      "grok-4.3": { "x-grok-model-override": "grok-4.3" },
    });
    expect(registry.getDefaultModels("xai-oauth")).toEqual([
      "grok-4.5",
      "grok-4.5-latest",
      "grok-build-latest",
      "grok-4.3",
    ]);

    expect(registry.getSdkProviderRegistrations()).toEqual([
      expect.objectContaining({
        sourceProviderId: "xai-oauth",
        providerId: "xai-oauth",
        config: expect.objectContaining({
          baseUrl: "https://cli-chat-proxy.grok.com/v1",
          api: "openai-responses",
          headers: {
            "x-xai-token-auth": "xai-grok-cli",
            "x-grok-client-version": "0.2.95",
            "x-grok-client-identifier": "hana",
          },
          oauth: expect.objectContaining({ name: "xAI Grok (OAuth)" }),
        }),
      }),
    ]);
  });

  it("rejects Grok OAuth base URL overrides outside the bearer-token allowlist", () => {
    const registry = new ProviderRegistry(tmpHome);

    expect(() => registry.saveProvider("xai-oauth", {
      base_url: "https://evil.example/v1",
    })).toThrow(/rejects baseUrl origin.*evil\.example/i);
  });

  it.each([
    undefined,
    [],
    ["http://oauth.example"],
    ["https://oauth.example/path"],
  ])("rejects invalid oauth-http origin allowlists: %j", (allowedBaseUrlOrigins) => {
    const registry = new ProviderRegistry(tmpHome);
    expect(() => registry.register({
      id: "invalid-oauth-runtime",
      displayName: "Invalid OAuth Runtime",
      authType: "oauth",
      defaultBaseUrl: "https://oauth.example/v1",
      defaultApi: "openai-responses",
      runtime: {
        kind: "oauth-http",
        ...(allowedBaseUrlOrigins === undefined ? {} : { allowedBaseUrlOrigins }),
      },
    })).toThrow(/allowedBaseUrlOrigins|bare HTTPS origin/i);
  });

  it("fails closed when two Hana providers target one runtime provider", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.register({
      id: "conflicting-codex",
      displayName: "Conflicting Codex",
      authType: "api-key",
      defaultBaseUrl: "https://conflict.example/v1",
      defaultApi: "openai-completions",
      models: ["conflict-model"],
      capabilities: {
        chat: {
          runtimeProviderId: "openai-codex",
          projection: "models-json",
        },
      },
    });
    registry.reload();

    expect(() => registry.getChatProjectionPlans()).toThrow(/runtime provider collision/i);
  });

  it("rejects duplicate SDK provider runtime registrations", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.register({
      id: "conflicting-sdk-provider",
      displayName: "Conflicting SDK Provider",
      authType: "oauth",
      defaultBaseUrl: "https://conflict.example/v1",
      defaultApi: "openai-responses",
      models: ["conflict-model"],
      capabilities: {
        chat: {
          runtimeProviderId: "xai-oauth",
          projection: "models-json",
          credentialSource: "auth-storage",
        },
      },
      sdkProvider: {
        providerId: "xai-oauth",
        config: {
          oauth: {
            name: "Conflict",
            login: async () => ({ access: "a", refresh: "r", expires: 1 }),
            refreshToken: async (credentials) => credentials,
            getApiKey: (credentials) => credentials.access,
          },
        },
      },
    });
    registry.reload();

    expect(() => registry.getSdkProviderRegistrations()).toThrow(/registration collision/i);
  });

  it("rejects an unknown chat credential source while building provider entries", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.register({
      id: "typo-credential-source",
      displayName: "Typo Credential Source",
      authType: "oauth",
      defaultBaseUrl: "https://oauth.example/v1",
      defaultApi: "openai-responses",
      models: ["typo-model"],
      capabilities: {
        chat: {
          runtimeProviderId: "typo-runtime",
          projection: "models-json",
          credentialSource: "auth-stroage",
        },
      },
    });

    expect(() => registry.reload()).toThrow(/Invalid chat credentialSource.*auth-stroage/i);
    expect(registry.getAll().has("typo-credential-source")).toBe(false);
  });

  it("preserves legacy sdk-auth-alias runtime-catalog behavior only when models is missing", () => {
    const registry = new ProviderRegistry(tmpHome);
    registry.register({
      id: "legacy-sdk-oauth",
      displayName: "Legacy SDK OAuth",
      authType: "oauth",
      authJsonKey: "legacy-runtime",
      defaultBaseUrl: "https://legacy.example/v1",
      defaultApi: "openai-responses",
      capabilities: {
        chat: {
          runtimeProviderId: "legacy-runtime",
          projection: "sdk-auth-alias",
        },
      },
    });
    registry.reload();

    expect(registry.getChatProjectionPlans().find((plan) => plan.sourceProviderId === "legacy-sdk-oauth")).toMatchObject({
      selectionMode: "runtime-catalog",
      hasExplicitModels: false,
    });

    registry.saveProvider("legacy-sdk-oauth", { models: [] });
    expect(registry.getChatProjectionPlans().find((plan) => plan.sourceProviderId === "legacy-sdk-oauth")).toMatchObject({
      selectionMode: "disabled",
      hasExplicitModels: true,
    });
  });

  it.each([
    { API_KEY: "model-secret" },
    { Authorization: "Bearer model-secret" },
    { resourceUrl: "https://credential.example" },
    { headers: { Cookie: "session=model-secret" } },
  ])("rejects model-level credential material: %j", (credentialPatch) => {
    const registry = new ProviderRegistry(tmpHome);
    registry.reload();

    expect(() => registry.saveProvider("openai", {
      api_key: "provider-key",
      models: [{ id: "gpt-5.6-sol", ...credentialPatch }],
    })).toThrow(/credentials belong to the provider or AuthStorage/);
  });
});
