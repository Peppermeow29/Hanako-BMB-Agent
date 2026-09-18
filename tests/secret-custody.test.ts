import { describe, expect, it } from "vitest";

describe("secret custody helpers", () => {
  it("masks explicitly registered default secret keys while preserving empty and similarly named fields", async () => {
    const { MASKED_SECRET, maskSecretValue, maskObjectSecrets } = await import("../shared/secret-custody.ts");

    expect(maskSecretValue("sk-test-secret")).toBe(MASKED_SECRET);
    expect(maskSecretValue("")).toBe("");
    expect(maskObjectSecrets({
      api_key: "sk-provider",
      token: "tg-token",
      appSecret: "fs-secret",
      bridge: {
        dingtalk: {
          clientSecret: "dt-client-secret",
          corpSecret: "dt-corp-secret",
          webhookSecret: "dt-webhook-secret",
          webhookToken: "dt-webhook-token",
          robotToken: "dt-robot-token",
          suiteSecret: "dt-suite-secret",
        },
      },
      oauth: [{ oauthClientSecret: "oauth-client-secret" }],
      clientSecretLabel: "visible label",
      visible: "safe",
    })).toEqual({
      api_key: MASKED_SECRET,
      token: MASKED_SECRET,
      appSecret: MASKED_SECRET,
      bridge: {
        dingtalk: {
          clientSecret: MASKED_SECRET,
          corpSecret: MASKED_SECRET,
          webhookSecret: MASKED_SECRET,
          webhookToken: MASKED_SECRET,
          robotToken: MASKED_SECRET,
          suiteSecret: MASKED_SECRET,
        },
      },
      oauth: [{ oauthClientSecret: MASKED_SECRET }],
      clientSecretLabel: "visible label",
      visible: "safe",
    });
  });

  it("resolves masked default secret values back to the saved secret instead of storing the mask", async () => {
    const { MASKED_SECRET, resolveSecretPatch } = await import("../shared/secret-custody.ts");

    expect(resolveSecretPatch({
      patch: {
        clientSecret: MASKED_SECRET,
        corpSecret: MASKED_SECRET,
        base_url: "https://api.example/v1",
      },
      existing: {
        clientSecret: "client-secret-saved",
        corpSecret: "corp-secret-saved",
        base_url: "https://old.example/v1",
      },
    })).toEqual({
      clientSecret: "client-secret-saved",
      corpSecret: "corp-secret-saved",
      base_url: "https://api.example/v1",
    });

    expect(resolveSecretPatch({
      patch: { api_key: "", base_url: "https://api.example/v1" },
      existing: { api_key: "sk-saved" },
      secretKeys: ["api_key"],
    })).toEqual({
      api_key: "",
      base_url: "https://api.example/v1",
    });
  });

  it("collects real secret mutations but ignores masked placeholders", async () => {
    const { MASKED_SECRET, collectSecretPatchPaths } = await import("../shared/secret-custody.ts");

    expect(collectSecretPatchPaths({
      providers: {
        deepseek: { api_key: "sk-new", base_url: "https://api.deepseek.com" },
        openai: { api_key: MASKED_SECRET },
      },
      bridge: {
        telegram: { token: "" },
        dingtalk: {
          clientSecret: "dt-new",
          corpSecret: MASKED_SECRET,
          webhookSecret: "dt-webhook-new",
        },
      },
      visible: "safe",
    })).toEqual([
      "providers.deepseek.api_key",
      "bridge.telegram.token",
      "bridge.dingtalk.clientSecret",
      "bridge.dingtalk.webhookSecret",
    ]);
  });

  it("keeps caller-provided secret key sets exact for mask, resolve, and collect operations", async () => {
    const {
      MASKED_SECRET,
      collectSecretPatchPaths,
      maskObjectSecrets,
      resolveSecretPatch,
    } = await import("../shared/secret-custody.ts");
    const secretKeys = ["appSecret"];

    expect(maskObjectSecrets({
      appSecret: "app-secret",
      clientSecret: "client-secret",
    }, secretKeys)).toEqual({
      appSecret: MASKED_SECRET,
      clientSecret: "client-secret",
    });

    expect(resolveSecretPatch({
      patch: { appSecret: MASKED_SECRET, clientSecret: MASKED_SECRET },
      existing: { appSecret: "saved-app-secret", clientSecret: "saved-client-secret" },
      secretKeys,
    })).toEqual({
      appSecret: "saved-app-secret",
      clientSecret: MASKED_SECRET,
    });

    expect(collectSecretPatchPaths({
      appSecret: "new-app-secret",
      clientSecret: "new-client-secret",
    }, secretKeys)).toEqual(["appSecret"]);
  });
});
