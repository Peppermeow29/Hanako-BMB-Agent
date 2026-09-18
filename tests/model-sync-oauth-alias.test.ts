import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncModels } from "../core/model-sync.ts";

let tmpHome;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-model-sync-alias-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("model sync OAuth aliases", () => {
  it("does not project sdk-auth-alias providers into models.json", () => {
    const modelsJsonPath = path.join(tmpHome, "models.json");

    syncModels({
      "openai-codex-oauth": {
        base_url: "https://chatgpt.com/backend-api",
        api: "openai-codex-responses",
        auth_type: "oauth",
        models: [
          "gpt-5.4",
          "gpt-5.5",
          { id: "gpt-image-2", type: "image", name: "GPT Image 2" },
        ],
      },
      openai: {
        base_url: "https://api.openai.com/v1",
        api: "openai-completions",
        auth_type: "api-key",
        api_key: "sk-test",
        models: ["gpt-5.5"],
      },
    }, {
      modelsJsonPath,
      chatProjectionMap: { "openai-codex-oauth": "sdk-auth-alias" },
    });

    const written = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(written.providers).not.toHaveProperty("openai-codex-oauth");
    expect(written.providers).toHaveProperty("openai");
  });

  it("projects Hana-owned OAuth models to the runtime alias without copying auth secrets", () => {
    const modelsJsonPath = path.join(tmpHome, "models.json");
    fs.writeFileSync(path.join(tmpHome, "auth.json"), JSON.stringify({
      "openai-codex": {
        access: "oauth-access-secret",
        refresh: "oauth-refresh-secret",
        accountId: "acct-secret",
        resourceUrl: "https://secret-resource.example",
      },
    }));

    syncModels({
      "openai-codex-oauth": {
        base_url: "https://chatgpt.com/backend-api",
        api: "openai-codex-responses",
        auth_type: "oauth",
        api_key: "catalog-oauth-secret",
        headers: {
          Authorization: "Bearer header-secret",
          Cookie: "session=cookie-secret",
        },
        models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      },
    }, {
      modelsJsonPath,
      chatProjectionPlans: {
        "openai-codex-oauth": {
          sourceProviderId: "openai-codex-oauth",
          runtimeProviderId: "openai-codex",
          projection: "models-json",
          credentialSource: "auth-storage",
        },
      },
    });

    const raw = fs.readFileSync(modelsJsonPath, "utf-8");
    const written = JSON.parse(raw);
    expect(written.providers).not.toHaveProperty("openai-codex-oauth");
    expect(written.providers["openai-codex"]).not.toHaveProperty("apiKey");
    expect(raw).not.toContain("oauth-access-secret");
    expect(raw).not.toContain("oauth-refresh-secret");
    expect(raw).not.toContain("catalog-oauth-secret");
    expect(raw).not.toContain("header-secret");
    expect(raw).not.toContain("cookie-secret");
    expect(raw).not.toContain("acct-secret");
    expect(raw).not.toContain("secret-resource.example");
    expect(written.providers["openai-codex"].api).toBe("openai-codex-responses");
    expect(written.providers["openai-codex"].models[0]).toMatchObject({
      id: "gpt-5.6-sol",
      contextWindow: 353400,
      maxTokens: 128000,
      thinkingLevelMap: { off: null, minimal: null, xhigh: "max" },
    });
  });

  it("rejects an unknown credential source before changing models.json", () => {
    const modelsJsonPath = path.join(tmpHome, "models.json");
    const original = JSON.stringify({ providers: { preserved: { apiKey: "keep-me" } } }, null, 2) + "\n";
    fs.writeFileSync(modelsJsonPath, original, "utf-8");

    expect(() => syncModels({
      "typo-oauth": {
        base_url: "https://oauth.example/v1",
        api: "openai-responses",
        auth_type: "oauth",
        api_key: "stale-catalog-token",
        headers: { Authorization: "Bearer stale-header" },
        models: ["typo-model"],
      },
    }, {
      modelsJsonPath,
      chatProjectionPlans: {
        "typo-oauth": {
          sourceProviderId: "typo-oauth",
          runtimeProviderId: "typo-runtime",
          projection: "models-json",
          credentialSource: "auth-stroage",
        },
      },
    })).toThrow(/Invalid chat credentialSource.*auth-stroage/i);

    expect(fs.readFileSync(modelsJsonPath, "utf-8")).toBe(original);
  });
});
