import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OAuthLoginCallbacks } from "../lib/pi-sdk/index.ts";
import { createAuthRoute } from "../server/routes/auth.ts";

type LoginImpl = (authKey: string, callbacks: OAuthLoginCallbacks) => Promise<void>;

function makeEngine(loginImpl: LoginImpl) {
  return {
    providerRegistry: {
      getAuthJsonKey: vi.fn((provider: string) => provider === "openai-codex-oauth" ? "openai-codex" : provider),
      clearAuthCache: vi.fn(),
      resolveChatProvider: vi.fn(() => ({
        sourceProviderId: "openai-codex-oauth",
        entry: { authType: "oauth" },
      })),
      getChatModelIds: vi.fn(() => ["gpt-5.6-sol", "my-codex-model"]),
      addModel: vi.fn(),
      removeModel: vi.fn(),
    },
    authStorage: {
      getOAuthProviders: vi.fn(() => [
        { id: "openai-codex", name: "OpenAI Codex", usesCallbackServer: true },
      ]),
      login: vi.fn(loginImpl),
      get: vi.fn(() => null),
      logout: vi.fn(),
    },
    onProviderChanged: vi.fn(async () => {}),
    availableModels: [],
    preferences: {
      getOAuthCustomModels: vi.fn(() => ({})),
      setOAuthCustomModels: vi.fn(),
    },
  };
}

describe("auth oauth route", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses an in-flight callback-server flow for the same provider", async () => {
    let capturedCallbacks: OAuthLoginCallbacks;
    let selectedMethod: string | undefined;
    const engine = makeEngine(async (_authKey, callbacks) => {
      capturedCallbacks = callbacks;
      selectedMethod = await callbacks.onSelect({
        message: "Choose login method",
        options: [
          { id: "device_code", label: "Device code" },
          { id: "browser", label: "Browser" },
        ],
      });
      callbacks.onAuth({ url: "https://auth.example/start" });
      return new Promise<void>(() => {});
    });
    const app = new Hono();
    app.route("/api", createAuthRoute(engine));

    const first = await app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth" }),
    });
    const second = await app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth" }),
    });

    expect(await second.json()).toEqual(await first.clone().json());
    expect(engine.authStorage.login).toHaveBeenCalledTimes(1);
    expect(engine.authStorage.login).toHaveBeenCalledWith("openai-codex", expect.any(Object));
    expect(capturedCallbacks.onManualCodeInput).toEqual(expect.any(Function));
    expect(capturedCallbacks.signal).toBeInstanceOf(AbortSignal);
    expect(selectedMethod).toBe("browser");
  });

  it("defaults legacy start requests to browser login and rejects unsupported methods", async () => {
    const engine = makeEngine(async (_authKey, callbacks) => {
      const selected = await callbacks.onSelect({
        message: "Choose login method",
        options: [{ id: "browser", label: "Browser" }],
      });
      expect(selected).toBe("browser");
      callbacks.onAuth({ url: "https://auth.example/start" });
      return new Promise<void>(() => {});
    });
    const app = new Hono();
    app.route("/api", createAuthRoute(engine));

    const legacyResponse = await app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth" }),
    });
    expect(legacyResponse.status).toBe(200);

    const invalidResponse = await app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth", loginMethod: "device_code" }),
    });
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toEqual({
      error: "Unsupported OAuth login method: device_code",
    });
  });

  it("maps SDK device-code callbacks onto the existing start response", async () => {
    const engine = makeEngine((_authKey, callbacks) => {
      callbacks.onDeviceCode({
        verificationUri: "https://auth.example/device",
        userCode: "ABCD-EFGH",
      });
      return new Promise<void>(() => {});
    });
    const app = new Hono();
    app.route("/api", createAuthRoute(engine));

    const response = await app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth", loginMethod: "browser" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      url: "https://auth.example/device",
      instructions: "ABCD-EFGH",
      polling: true,
    });
  });

  it("aborts the SDK login when an exposed OAuth flow times out", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const engine = makeEngine((_authKey, callbacks) => {
      capturedSignal = callbacks.signal;
      callbacks.onAuth({ url: "https://auth.example/start" });
      return new Promise<void>((_resolve, reject) => {
        callbacks.signal?.addEventListener("abort", () => reject(callbacks.signal?.reason), { once: true });
      });
    });
    const app = new Hono();
    app.route("/api", createAuthRoute(engine));

    const response = await app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth", loginMethod: "browser" }),
    });
    expect(response.status).toBe(200);
    expect(capturedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(capturedSignal?.aborted).toBe(true);
  });

  it("does not abort a successfully completed OAuth login during later cleanup", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const engine = makeEngine(async (_authKey, callbacks) => {
      capturedSignal = callbacks.signal;
      callbacks.onAuth({ url: "https://auth.example/start" });
    });
    const app = new Hono();
    app.route("/api", createAuthRoute(engine));

    const response = await app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth", loginMethod: "browser" }),
    });
    expect(response.status).toBe(200);

    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

    expect(capturedSignal?.aborted).toBe(false);
  });

  it("aborts a stale OAuth flow that never exposes an authorization URL", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const engine = makeEngine((_authKey, callbacks) => {
      capturedSignal = callbacks.signal;
      return new Promise<void>((_resolve, reject) => {
        callbacks.signal?.addEventListener("abort", () => reject(callbacks.signal?.reason), { once: true });
      });
    });
    const app = new Hono();
    app.route("/api", createAuthRoute(engine));

    const responsePromise = app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth", loginMethod: "browser" }),
    });
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

    expect(capturedSignal?.aborted).toBe(true);
    expect((await responsePromise).status).toBe(500);
  });

  it("waits for the same provider flow when the auth URL is still starting", async () => {
    let capturedCallbacks: OAuthLoginCallbacks;
    let resolveLoginStarted: () => void;
    const loginStarted = new Promise<void>((resolve) => {
      resolveLoginStarted = resolve;
    });
    const engine = makeEngine((_authKey, callbacks) => {
      capturedCallbacks = callbacks;
      resolveLoginStarted();
      return new Promise<void>(() => {});
    });
    const app = new Hono();
    app.route("/api", createAuthRoute(engine));

    const firstPromise = app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth" }),
    });
    await loginStarted;

    const secondPromise = app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth" }),
    });

    capturedCallbacks.onAuth({ url: "https://auth.example/start" });

    const first = await firstPromise;
    const second = await secondPromise;

    expect(await second.json()).toEqual(await first.json());
    expect(engine.authStorage.login).toHaveBeenCalledTimes(1);
  });

  it("refreshes Hana model availability after OAuth logout", async () => {
    const engine = makeEngine(() => new Promise<void>(() => {}));
    const app = new Hono();
    app.route("/api", createAuthRoute(engine));

    const response = await app.request("/api/auth/oauth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth" }),
    });

    expect(response.status).toBe(200);
    expect(engine.authStorage.logout).toHaveBeenCalledWith("openai-codex");
    expect(engine.providerRegistry.clearAuthCache).toHaveBeenCalled();
    expect(engine.onProviderChanged).toHaveBeenCalled();
  });

  it("delegates the legacy OAuth custom-model route to Provider Catalog", async () => {
    const engine = makeEngine(() => new Promise<void>(() => {}));
    const app = new Hono();
    app.route("/api", createAuthRoute(engine));

    const response = await app.request("/api/auth/oauth/openai-codex/custom-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "my-codex-model" }),
    });

    expect(response.status).toBe(200);
    expect(engine.providerRegistry.addModel).toHaveBeenCalledWith("openai-codex-oauth", "my-codex-model");
    expect(engine.onProviderChanged).toHaveBeenCalled();
    expect(engine.preferences.setOAuthCustomModels).not.toHaveBeenCalled();
  });
});
