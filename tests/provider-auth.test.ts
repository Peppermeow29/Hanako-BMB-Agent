import { describe, expect, it } from "vitest";
import { MASKED_SECRET } from "../shared/secret-custody.ts";
import {
  collectProviderHeaderSecretPatchPaths,
  mergeProviderHeaders,
  maskProviderHeaders,
  normalizeProviderHeaders,
  resolveProviderHeadersPatch,
  stripCredentialHeaders,
} from "../shared/provider-auth.ts";

describe("provider auth helpers", () => {
  it("normalizes provider request headers and drops unsafe transport headers", () => {
    expect(normalizeProviderHeaders({
      " Authorization ": "Bearer gateway",
      "X-Corp-Auth": "token",
      Host: "evil.example",
      "Bad Header": "bad",
      Empty: "",
    })).toEqual({
      Authorization: "Bearer gateway",
      "X-Corp-Auth": "token",
    });
  });

  it("masks provider request header values and preserves masked patches by header name", () => {
    const existing = {
      Authorization: "Bearer saved",
      "X-Corp-Auth": "saved-token",
    };

    expect(maskProviderHeaders(existing)).toEqual({
      Authorization: MASKED_SECRET,
      "X-Corp-Auth": MASKED_SECRET,
    });

    expect(resolveProviderHeadersPatch({
      existing,
      patch: {
        authorization: MASKED_SECRET,
        "X-Corp-Auth": "new-token",
      },
    })).toEqual({
      authorization: "Bearer saved",
      "X-Corp-Auth": "new-token",
    });
  });

  it("treats unmasked provider request headers as secret mutations", () => {
    expect(collectProviderHeaderSecretPatchPaths({
      Authorization: MASKED_SECRET,
      "X-Corp-Auth": "plain-token",
    }, "providers.proxy.headers")).toEqual([
      "providers.proxy.headers.X-Corp-Auth",
    ]);
  });

  it("merges header sources case-insensitively and strips credential-bearing headers", () => {
    const merged = mergeProviderHeaders(
      {
        Authorization: "Bearer stale-provider",
        Cookie: "provider=stale",
        "X-Corp-Auth": "stale-custom-auth",
        "X-Grok-Client-Version": "0.2.95",
        "x-xai-token-auth": "xai-grok-cli",
      },
      {
        authorization: "Bearer stale-model",
        "X-API-Key": "stale-key",
        "x-grok-model-override": "grok-4.5",
      },
    );

    expect(stripCredentialHeaders(merged)).toEqual({
      "X-Grok-Client-Version": "0.2.95",
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-model-override": "grok-4.5",
    });
  });
});
