import { describe, expect, it } from "vitest";
import { repairProviderModelMetadata } from "../core/provider-model-metadata-migration.ts";
import { validateProviderModels } from "../shared/provider-model-validation.ts";

describe("repairProviderModelMetadata", () => {
  it("repairs legacy metadata without dropping models, ordering, or valid fields", () => {
    const providers = {
      openai: {
        base_url: "https://example.invalid/v1",
        models: [
          "string-model",
          {
            id: "legacy-model",
            name: "Legacy Model",
            context: 0,
            contextWindow: Number.POSITIVE_INFINITY,
            maxOutput: -1,
            maxTokens: "8192",
            maxOutputTokens: Number.NaN,
            api: "  ",
            reasoning: true,
            token: "top-secret-token",
            AuThOrIzAtIoN: "Bearer do-not-log-this",
            thinkingLevelMap: {
              off: null,
              minimal: "low",
              low: " ",
              medium: 7,
              high: "high",
              xhigh: null,
              ultra: "max",
            },
          },
          {
            id: "valid-model",
            context: 128_000,
            maxOutput: 16_384,
            api: "openai-responses",
            thinkingLevelMap: { off: null, low: "medium", xhigh: "max" },
            customMetadata: { nested: [1, 2, 3] },
          },
          {
            name: "missing-id-is-not-guessed",
            context: 0,
            token: "leave-untouched-without-id",
          },
        ],
      },
    };
    const inputSnapshot = structuredClone(providers);
    const validModelBytes = JSON.stringify(providers.openai.models[2]);

    const result = repairProviderModelMetadata(providers);

    expect(result.changed).toBe(true);
    expect(providers).toEqual(inputSnapshot);
    expect(result.providers).not.toBe(providers);
    expect(result.providers.openai.models).toHaveLength(providers.openai.models.length);
    expect(result.providers.openai.models.map((model) => (
      typeof model === "string" ? model : model.id || model.name
    ))).toEqual([
      "string-model",
      "legacy-model",
      "valid-model",
      "missing-id-is-not-guessed",
    ]);

    const repaired = result.providers.openai.models[1];
    expect(repaired).toEqual({
      id: "legacy-model",
      name: "Legacy Model",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        high: "high",
        xhigh: null,
      },
    });
    expect(JSON.stringify(result.providers.openai.models[2])).toBe(validModelBytes);
    expect(result.providers.openai.models[3]).toEqual(providers.openai.models[3]);

    validateProviderModels(
      "openai",
      result.providers.openai.models.filter((model) => (
        typeof model === "string" || (typeof model.id === "string" && model.id.trim())
      )),
      { baseUrl: result.providers.openai.base_url },
    );

    expect(result.repairs).toEqual([{
      providerId: "openai",
      modelId: "legacy-model",
      fields: [
        "token",
        "AuThOrIzAtIoN",
        "context",
        "contextWindow",
        "maxOutput",
        "maxTokens",
        "maxOutputTokens",
        "api",
        "thinkingLevelMap.low",
        "thinkingLevelMap.medium",
        "thinkingLevelMap.ultra",
      ],
    }]);
    expect(JSON.stringify(result.repairs)).not.toContain("top-secret-token");
    expect(JSON.stringify(result.repairs)).not.toContain("Bearer do-not-log-this");
  });

  it("removes an empty or malformed thinking map and cleans mixed-case credential fields", () => {
    const result = repairProviderModelMetadata({
      custom: {
        models: [
          {
            id: "empty-map",
            API_KEY: "secret-one",
            Refresh_Token: "secret-two",
            HeAdErS: { Authorization: "secret-three" },
            thinkingLevelMap: { ultra: "max", low: "" },
          },
          { id: "malformed-map", thinkingLevelMap: ["high"] },
        ],
      },
    });

    expect(result.providers.custom.models).toEqual([
      { id: "empty-map" },
      { id: "malformed-map" },
    ]);
    expect(result.repairs).toEqual([
      {
        providerId: "custom",
        modelId: "empty-map",
        fields: [
          "API_KEY",
          "Refresh_Token",
          "HeAdErS",
          "thinkingLevelMap.ultra",
          "thinkingLevelMap.low",
          "thinkingLevelMap",
        ],
      },
      {
        providerId: "custom",
        modelId: "malformed-map",
        fields: ["thinkingLevelMap"],
      },
    ]);
    validateProviderModels("custom", result.providers.custom.models);
    expect(JSON.stringify(result.repairs)).not.toMatch(/secret-(one|two|three)/);
  });

  it("removes every model credential field rejected by current validation", () => {
    const credentials = {
      api_key: "credential-value-01",
      ApIkEy: "credential-value-02",
      ToKeN: "credential-value-03",
      access: "credential-value-04",
      AcCeSsToKeN: "credential-value-05",
      ACCESS_TOKEN: "credential-value-06",
      refresh: "credential-value-07",
      REFRESH_TOKEN: "credential-value-08",
      RefreshToken: "credential-value-09",
      AccountId: "credential-value-10",
      ACCOUNT_ID: "credential-value-11",
      Authorization: "credential-value-12",
      Cookie: "credential-value-13",
      Headers: { Authorization: "credential-value-14" },
      ResourceUrl: "credential-value-15",
      RESOURCE_URL: "credential-value-16",
      Expires: "credential-value-17",
    };
    const result = repairProviderModelMetadata({
      custom: {
        models: [{ id: "credential-bearing-model", ...credentials }],
      },
    });

    expect(result.providers.custom.models).toEqual([{ id: "credential-bearing-model" }]);
    expect(result.repairs).toEqual([{
      providerId: "custom",
      modelId: "credential-bearing-model",
      fields: Object.keys(credentials),
    }]);
    validateProviderModels("custom", result.providers.custom.models);
    expect(JSON.stringify(result.repairs)).not.toContain("credential-value");
  });

  it("is idempotent and reports no change for already-valid providers", () => {
    const providers = {
      custom: {
        models: [
          "plain-model",
          {
            id: "valid-model",
            context: 128_000,
            maxOutputTokens: 8_192,
            api: "openai-completions",
            thinkingLevelMap: { off: null, minimal: "low", high: "high" },
          },
        ],
      },
    };

    const first = repairProviderModelMetadata(providers);
    const second = repairProviderModelMetadata(first.providers);

    expect(first).toEqual({
      providers,
      changed: false,
      repairs: [],
    });
    expect(first.providers).not.toBe(providers);
    expect(second).toEqual(first);
    validateProviderModels("custom", second.providers.custom.models);
  });
});
