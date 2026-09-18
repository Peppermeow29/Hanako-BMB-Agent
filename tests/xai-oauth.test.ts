import { describe, expect, it, vi } from "vitest";

import {
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_DISCOVERY_URL,
  XAI_OAUTH_SCOPES,
  createXaiOAuthProvider,
} from "../lib/auth/xai-oauth.ts";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function discovery(overrides = {}) {
  return {
    device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
    token_endpoint: "https://auth.x.ai/oauth2/token",
    ...overrides,
  };
}

function callbacks(overrides = {}) {
  return {
    onAuth: vi.fn(),
    onDeviceCode: vi.fn(),
    onPrompt: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
}

describe("xAI OAuth driver", () => {
  it("discovers trusted endpoints and completes RFC 8628 polling with slow_down", async () => {
    const responses = [
      jsonResponse(discovery()),
      jsonResponse({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.x.ai/activate",
        interval: 5,
        expires_in: 120,
      }),
      jsonResponse({ error: "authorization_pending" }, 400),
      jsonResponse({ error: "slow_down" }, 400),
      jsonResponse({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        expires_in: 3600,
        id_token: "id-token",
      }),
    ];
    let currentTime = 10_000;
    const fetchImpl = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => responses.shift()!);
    const sleep = vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    const provider = createXaiOAuthProvider({
      fetchImpl: fetchImpl as typeof fetch,
      now: () => currentTime,
      sleep,
    });
    const loginCallbacks = callbacks();

    const credentials = await provider.login(loginCallbacks);

    expect(credentials).toEqual({
      access: "access-secret",
      refresh: "refresh-secret",
      expires: currentTime + 3600_000,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
      idToken: "id-token",
    });
    expect(loginCallbacks.onDeviceCode).toHaveBeenCalledWith({
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.x.ai/activate",
      intervalSeconds: 5,
      expiresInSeconds: 120,
    });
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([5000, 5000, 10000]);
    expect(fetchImpl.mock.calls[0][0]).toBe(XAI_OAUTH_DISCOVERY_URL);
    const deviceBody = new URLSearchParams(fetchImpl.mock.calls[1][1]?.body as string);
    expect(deviceBody.get("client_id")).toBe(XAI_OAUTH_CLIENT_ID);
    expect(deviceBody.get("scope")).toBe(XAI_OAUTH_SCOPES);
    const tokenBody = new URLSearchParams(fetchImpl.mock.calls[4][1]?.body as string);
    expect(tokenBody.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(tokenBody.get("device_code")).toBe("device-secret");
  });

  it.each([
    { device_authorization_endpoint: "http://auth.x.ai/oauth2/device/code" },
    { device_authorization_endpoint: "https://evil.example/oauth2/device/code" },
    { device_authorization_endpoint: "https://auth.x.ai:8443/oauth2/device/code" },
    { token_endpoint: "https://auth.x.ai.evil.example/oauth2/token" },
  ])("rejects untrusted discovery endpoints: %j", async (override) => {
    const fetchImpl = vi.fn(async () => jsonResponse(discovery(override)));
    const provider = createXaiOAuthProvider({ fetchImpl: fetchImpl as typeof fetch });

    await expect(provider.login(callbacks())).rejects.toThrow(/untrusted/i);
  });

  it.each([
    "https://evil.example/device",
    "https://accounts.x.ai:8443/device",
  ])("rejects an unsafe device verification URL: %s", async (verificationUri) => {
    const responses = [
      jsonResponse(discovery()),
      jsonResponse({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: verificationUri,
        interval: 5,
        expires_in: 120,
      }),
    ];
    const provider = createXaiOAuthProvider({
      fetchImpl: vi.fn(async () => responses.shift()!) as unknown as typeof fetch,
    });

    await expect(provider.login(callbacks())).rejects.toThrow(/unsafe verification_uri/i);
  });

  it("rejects device timing values that would overflow a JavaScript timer", async () => {
    const responses = [
      jsonResponse(discovery()),
      jsonResponse({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.x.ai/device",
        interval: Number.MAX_SAFE_INTEGER,
        expires_in: 120,
      }),
    ];
    const provider = createXaiOAuthProvider({
      fetchImpl: vi.fn(async () => responses.shift()!) as unknown as typeof fetch,
    });

    await expect(provider.login(callbacks())).rejects.toThrow(/response is incomplete/i);
  });

  it("rotates refresh tokens and preserves the old token when the server omits rotation", async () => {
    const rotated = createXaiOAuthProvider({
      fetchImpl: vi.fn(async () => jsonResponse({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 60,
      })) as unknown as typeof fetch,
      now: () => 1000,
    });
    await expect(rotated.refreshToken({
      access: "access-old",
      refresh: "refresh-old",
      expires: 0,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    })).resolves.toMatchObject({
      access: "access-new",
      refresh: "refresh-new",
      expires: 61_000,
    });

    const preserved = createXaiOAuthProvider({
      fetchImpl: vi.fn(async () => jsonResponse({
        access_token: "access-newer",
        expires_in: 120,
      })) as unknown as typeof fetch,
      now: () => 2000,
    });
    await expect(preserved.refreshToken({
      access: "access-old",
      refresh: "refresh-keep",
      expires: 0,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    })).resolves.toMatchObject({
      access: "access-newer",
      refresh: "refresh-keep",
      expires: 122_000,
    });
  });

  it("rejects an untrusted cached refresh endpoint before sending credentials", async () => {
    const fetchImpl = vi.fn();
    const provider = createXaiOAuthProvider({ fetchImpl: fetchImpl as typeof fetch });

    await expect(provider.refreshToken({
      access: "access-old",
      refresh: "refresh-secret",
      expires: 0,
      tokenEndpoint: "https://evil.example/oauth2/token",
    })).rejects.toThrow(/untrusted cached token_endpoint/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("combines caller cancellation with a finite request signal", async () => {
    const abortController = new AbortController();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    ));
    const provider = createXaiOAuthProvider({ fetchImpl: fetchImpl as typeof fetch });
    const loginPromise = provider.login(callbacks({ signal: abortController.signal }));

    abortController.abort(new Error("cancel discovery"));

    await expect(loginPromise).rejects.toThrow("cancel discovery");
  });

  it("falls back to JWT exp when expires_in is absent", async () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1234 })).toString("base64url");
    const provider = createXaiOAuthProvider({
      fetchImpl: vi.fn(async () => jsonResponse({
        access_token: `header.${payload}.signature`,
        refresh_token: "refresh-token",
      })) as unknown as typeof fetch,
      now: () => 1000,
    });

    await expect(provider.refreshToken({
      access: "old",
      refresh: "old-refresh",
      expires: 0,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    })).resolves.toMatchObject({ expires: 1_234_000 });
  });

  it("honors AbortSignal while waiting for device authorization", async () => {
    const abortController = new AbortController();
    const responses = [
      jsonResponse(discovery()),
      jsonResponse({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://x.ai/device",
        interval: 5,
        expires_in: 120,
      }),
    ];
    const provider = createXaiOAuthProvider({
      fetchImpl: vi.fn(async () => responses.shift()!) as unknown as typeof fetch,
      sleep: async (_milliseconds, signal) => {
        abortController.abort(new Error("cancelled by user"));
        if (signal?.aborted) throw signal.reason;
      },
    });

    await expect(provider.login(callbacks({ signal: abortController.signal })))
      .rejects.toThrow("cancelled by user");
  });

  it("fails explicitly on incomplete token responses", async () => {
    const responses = [
      jsonResponse(discovery()),
      jsonResponse({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.x.ai/activate",
        interval: 1,
        expires_in: 30,
      }),
      jsonResponse({ access_token: "access-without-refresh", expires_in: 60 }),
    ];
    let currentTime = 0;
    const provider = createXaiOAuthProvider({
      fetchImpl: vi.fn(async () => responses.shift()!) as unknown as typeof fetch,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
    });

    await expect(provider.login(callbacks())).rejects.toThrow(/missing refresh_token/i);
  });
});
