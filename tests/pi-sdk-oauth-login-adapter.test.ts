import { describe, expect, it, vi } from "vitest";

import {
  AuthStorage,
  loginOAuthProvider,
  type OAuthLoginCallbacks,
} from "../lib/pi-sdk/index.ts";

describe("Pi SDK OAuth login adapter", () => {
  it("satisfies the real 0.80.3 selector contract before browser I/O starts", async () => {
    const authStorage = AuthStorage.inMemory();
    const sentinel = new Error("__hana_stop_before_io__");
    const onAuth = vi.fn();
    const onDeviceCode = vi.fn();
    const callbacks: OAuthLoginCallbacks = {
      onAuth,
      onDeviceCode,
      onPrompt: async () => "",
      onSelect: async (prompt) => {
        expect(prompt.options.map(option => option.id)).toContain("browser");
        throw sentinel;
      },
      signal: new AbortController().signal,
    };

    await expect(loginOAuthProvider(authStorage, "openai-codex", callbacks))
      .rejects.toThrow("__hana_stop_before_io__");
    expect(onAuth).not.toHaveBeenCalled();
    expect(onDeviceCode).not.toHaveBeenCalled();
  });
});
