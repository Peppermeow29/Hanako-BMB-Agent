import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  AuthStorage,
  FileAuthStorageBackend,
  InMemoryAuthStorageBackend,
} from "@earendil-works/pi-coding-agent";
import { forceRefreshOAuthApiKey } from "../core/oauth-force-refresh.ts";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const AUTH_KEY = "openai-codex";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/**
 * The refresh path decodes the new access token as a JWT and reads the ChatGPT
 * account id out of it, so a mocked token response has to carry a real-looking
 * payload segment.
 */
function codexJwt(accountId) {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64");
  return `header.${payload}.signature`;
}

function tokenResponse({ access, refresh, expiresIn = 3600 }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      access_token: access,
      refresh_token: refresh,
      expires_in: expiresIn,
      id_token: codexJwt("acct_id_token"),
    }),
  };
}

/** Nine days out: far from expiry as far as the local record is concerned. */
function futureExpiry() {
  return Date.now() + 9 * 24 * 3600 * 1000;
}

function seedData(access = "stale-A"): Record<string, any> {
  return {
    [AUTH_KEY]: {
      type: "oauth",
      access,
      refresh: "r1",
      expires: futureExpiry(),
      accountId: "acct_seed",
    },
  };
}

/** The SDK types credentials as a union; these tests only ever seed OAuth ones. */
function storedCred(authStorage): any {
  return authStorage.get(AUTH_KEY);
}

function inMemoryStore(raw) {
  const backend = new InMemoryAuthStorageBackend();
  backend.withLock(() => ({ result: undefined, next: raw }));
  return { backend, authStorage: AuthStorage.fromStorage(backend) };
}

function seededInMemoryStore(data = seedData()) {
  return inMemoryStore(JSON.stringify(data, null, 2));
}

describe("forceRefreshOAuthApiKey", () => {
  let tmpDir;

  beforeEach(() => {
    mockFetch.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-force-refresh-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rotates the credential even though the local record is not expired yet", async () => {
    const { backend, authStorage } = seededInMemoryStore();
    expect(storedCred(authStorage).expires).toBeGreaterThan(Date.now());

    const rotated = codexJwt("acct_new");
    mockFetch.mockResolvedValueOnce(tokenResponse({ access: rotated, refresh: "r2" }));

    const apiKey = await forceRefreshOAuthApiKey({
      authStorage,
      backend,
      authKey: AUTH_KEY,
      staleApiKey: "stale-A",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(TOKEN_URL);
    expect(apiKey).toBe(rotated);

    const stored = storedCred(authStorage);
    expect(stored.type).toBe("oauth");
    expect(stored.access).toBe(rotated);
    expect(stored.refresh).toBe("r2");
    expect(stored.accountId).toBe("acct_new");
  });

  it("skips the network call when the stored credential was already rotated", async () => {
    const { backend, authStorage } = seededInMemoryStore(seedData("B"));

    const apiKey = await forceRefreshOAuthApiKey({
      authStorage,
      backend,
      authKey: AUTH_KEY,
      staleApiKey: "A",
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(apiKey).toBe("B");
    expect(storedCred(authStorage).access).toBe("B");
    expect(storedCred(authStorage).refresh).toBe("r1");
  });

  it("leaves the stored credential untouched when the refresh call fails", async () => {
    const { backend, authStorage } = seededInMemoryStore();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    });

    await expect(forceRefreshOAuthApiKey({
      authStorage,
      backend,
      authKey: AUTH_KEY,
      staleApiKey: "stale-A",
    })).rejects.toThrow();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const stored = storedCred(authStorage);
    expect(stored.access).toBe("stale-A");
    expect(stored.refresh).toBe("r1");
  });

  it("rejects without any network call when the entry is missing or not an OAuth credential", async () => {
    const missing = seededInMemoryStore({});
    await expect(forceRefreshOAuthApiKey({
      authStorage: missing.authStorage,
      backend: missing.backend,
      authKey: AUTH_KEY,
      staleApiKey: "stale-A",
    })).rejects.toThrow();

    const wrongType = seededInMemoryStore({
      [AUTH_KEY]: { type: "api_key", key: "sk-test" },
    });
    await expect(forceRefreshOAuthApiKey({
      authStorage: wrongType.authStorage,
      backend: wrongType.backend,
      authKey: AUTH_KEY,
      staleApiKey: "stale-A",
    })).rejects.toThrow();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refreshes exactly once when two callers race on the same stale credential", async () => {
    const authPath = path.join(tmpDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify(seedData(), null, 2), "utf-8");
    const backend = new FileAuthStorageBackend(authPath);
    const authStorage = AuthStorage.fromStorage(backend);

    const rotated = codexJwt("acct_race");
    mockFetch.mockImplementation(async () => tokenResponse({ access: rotated, refresh: "r2" }));

    const call = () => forceRefreshOAuthApiKey({
      authStorage,
      backend,
      authKey: AUTH_KEY,
      staleApiKey: "stale-A",
    });
    const [first, second] = await Promise.all([call(), call()]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(first).toBe(rotated);
    expect(second).toBe(rotated);
    expect(JSON.parse(fs.readFileSync(authPath, "utf-8"))[AUTH_KEY].access).toBe(rotated);
  });

  it("rejects without any network call when the stored credentials are unreadable", async () => {
    const { backend, authStorage } = inMemoryStore("{not json");

    await expect(forceRefreshOAuthApiKey({
      authStorage,
      backend,
      authKey: AUTH_KEY,
      staleApiKey: "stale-A",
    })).rejects.toThrow();

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
