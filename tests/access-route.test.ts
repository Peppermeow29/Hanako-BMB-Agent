import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-access-route-"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function writeIdentity(root) {
  writeJson(path.join(root, "server-node.json"), {
    schemaVersion: 1,
    serverId: "server_access",
    label: "Access Server",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
  writeJson(path.join(root, "users.json"), {
    schemaVersion: 1,
    defaultUserId: "user_owner",
    users: [{
      userId: "user_owner",
      kind: "legacy_owner",
      displayName: "Owner",
      profileSource: "legacy_user_profile",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    }],
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
  writeJson(path.join(root, "studios.json"), {
    schemaVersion: 1,
    defaultStudioId: "studio_home",
    studios: [{
      studioId: "studio_home",
      ownerUserId: "user_owner",
      label: "Home Studio",
      kind: "personal",
      storage: { provider: "legacy_hana_home", legacyRoot: true },
      membershipModel: "single_user_implicit",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    }],
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
}

function localOwner() {
  return {
    kind: "local_user",
    credentialKind: "loopback_token",
    connectionKind: "local",
    serverId: "server_access",
    serverNodeId: "server_access",
    userId: "user_owner",
    studioId: "studio_home",
    scopes: ["chat", "resources", "tools"],
  };
}

async function makeApp(root, runtimeState: any = {}) {
  const { createAccessRoute } = await import("../server/routes/access.ts");
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).set("authPrincipal", Object.freeze(localOwner()));
    await next();
  });
  app.route("/api", createAccessRoute({
    engine: {
      hanakoHome: root,
      getRuntimeContext: () => ({
        serverId: "server_access",
        serverNodeId: "server_access",
        userId: "user_owner",
        studioId: "studio_home",
      }),
    },
    runtimeState: {
      mode: "loopback",
      listenHost: "127.0.0.1",
      actualPort: 14500,
      ...runtimeState,
    },
    listLanAddresses: () => ["192.168.31.75"],
    now: () => "2026-05-16T02:00:00.000Z",
  }));
  return app;
}

describe("access route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("summarizes mobile and desktop LAN access without exposing loopback tokens", async () => {
    tmpDir = makeTmpDir();
    writeIdentity(tmpDir);
    const app = await makeApp(tmpDir);

    const res = await app.request("/api/access/summary");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      network: {
        mode: "loopback",
        configuredPort: 14500,
        actualPort: 14500,
        restartRequired: false,
        lanAddresses: ["192.168.31.75"],
        localServerUrl: "http://127.0.0.1:14500/",
        candidateLanServerUrl: "http://192.168.31.75:14500/",
        lanServerUrl: null,
        localMobileUrl: "http://127.0.0.1:14500/mobile/",
        candidateLanMobileUrl: "http://192.168.31.75:14500/mobile/",
        lanMobileUrl: null,
        localDesktopUrl: "http://127.0.0.1:14500/desktop/",
        candidateLanDesktopUrl: "http://192.168.31.75:14500/desktop/",
        lanDesktopUrl: null,
      },
      account: {
        userId: "user_owner",
        displayName: "Owner",
        passwordSet: false,
      },
      devices: [],
      credentials: [],
    });
    expect(JSON.stringify(data)).not.toContain("token");
    expect(JSON.stringify(data)).not.toContain("secretHash");
  });

  it("requires restart when enabling LAN changes the listening host", async () => {
    tmpDir = makeTmpDir();
    writeIdentity(tmpDir);
    const app = await makeApp(tmpDir, { mode: "loopback", listenHost: "127.0.0.1", actualPort: 14500 });

    const res = await app.request("/api/access/network", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "lan", listenPort: 14500 }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      network: {
        mode: "lan",
        listenHost: "0.0.0.0",
        configuredPort: 14500,
        runtimeMode: "loopback",
        runtimeHost: "127.0.0.1",
        restartRequired: true,
        candidateLanServerUrl: "http://192.168.31.75:14500/",
        candidateLanMobileUrl: "http://192.168.31.75:14500/mobile/",
        candidateLanDesktopUrl: "http://192.168.31.75:14500/desktop/",
        lanServerUrl: null,
        lanMobileUrl: null,
        lanDesktopUrl: null,
      },
    });
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, "server-network.json"), "utf-8")))
      .toMatchObject({ mode: "lan", listenHost: "0.0.0.0", listenPort: 14500 });
  });

  it("still reports a restart requirement when the listening port changes", async () => {
    tmpDir = makeTmpDir();
    writeIdentity(tmpDir);
    const app = await makeApp(tmpDir, { mode: "loopback", listenHost: "127.0.0.1", actualPort: 14500 });

    const res = await app.request("/api/access/network", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "lan", listenPort: 14550 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      network: {
        mode: "lan",
        configuredPort: 14550,
        actualPort: 14500,
        restartRequired: true,
        candidateLanServerUrl: "http://192.168.31.75:14550/",
        candidateLanDesktopUrl: "http://192.168.31.75:14550/desktop/",
        lanServerUrl: null,
        lanMobileUrl: null,
        lanDesktopUrl: null,
      },
    });
  });

  it("issues a one-time visible mobile access key and persists only its hash", async () => {
    tmpDir = makeTmpDir();
    writeIdentity(tmpDir);
    writeJson(path.join(tmpDir, "server-network.json"), {
      schemaVersion: 1,
      mode: "lan",
      listenHost: "0.0.0.0",
      listenPort: 14500,
      customRemote: { enabled: false, baseUrl: null, wsUrl: null },
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    });
    const app = await makeApp(tmpDir, { mode: "lan", listenHost: "0.0.0.0", actualPort: 14500 });

    const res = await app.request("/api/access/mobile-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "User Phone",
        scopes: ["chat", "files.read", "files.write"],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.secret).toMatch(/^hana_dev_/);
    expect(data).toMatchObject({
      accessUrl: "http://192.168.31.75:14500/mobile/",
      device: {
        displayName: "User Phone",
        deviceKind: "mobile",
        trustState: "lan",
      },
      credential: {
        scopes: ["chat", "resources.read", "files.read", "files.write"],
        status: "active",
      },
    });
    const stored = fs.readFileSync(path.join(tmpDir, "device-credentials.json"), "utf-8");
    expect(stored).not.toContain(data.secret);
    expect(JSON.stringify(data)).not.toContain("secretHash");
  });

  it("issues a desktop access key for the browser PWA URL on another computer", async () => {
    tmpDir = makeTmpDir();
    writeIdentity(tmpDir);
    writeJson(path.join(tmpDir, "server-network.json"), {
      schemaVersion: 1,
      mode: "lan",
      listenHost: "0.0.0.0",
      listenPort: 14500,
      customRemote: { enabled: false, baseUrl: null, wsUrl: null },
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    });
    const app = await makeApp(tmpDir, { mode: "lan", listenHost: "0.0.0.0", actualPort: 14500 });

    const res = await app.request("/api/access/desktop-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Studio Laptop",
        scopes: ["chat", "files.read", "files.write"],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.secret).toMatch(/^hana_dev_/);
    expect(data).toMatchObject({
      accessUrl: "http://192.168.31.75:14500/desktop/",
      device: {
        displayName: "Studio Laptop",
        deviceKind: "desktop",
        trustState: "lan",
      },
      credential: {
        scopes: [
          "chat",
          "resources.read",
          "files.read",
          "files.write",
          "studio.owner",
          "settings.read",
          "settings.write",
          "providers.manage",
          "secrets.write",
          "bridge.manage",
        ],
        status: "active",
      },
    });
    expect(data.accessUrl).not.toContain("/mobile/");
    expect(data.accessUrl).toContain("/desktop/");
    const stored = fs.readFileSync(path.join(tmpDir, "device-credentials.json"), "utf-8");
    expect(stored).not.toContain(data.secret);
    expect(JSON.stringify(data)).not.toContain("secretHash");
  });

  it("updates the local account profile and password through owner-only routes", async () => {
    tmpDir = makeTmpDir();
    writeIdentity(tmpDir);
    const app = await makeApp(tmpDir);

    const profile = await app.request("/api/access/account/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "hana-owner", displayName: "Hana Owner" }),
    });
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({
      account: {
        username: "hana-owner",
        displayName: "Hana Owner",
        passwordSet: false,
      },
    });

    const password = await app.request("/api/access/account/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery staple" }),
    });
    expect(password.status).toBe(200);
    expect(await password.json()).toMatchObject({
      account: {
        username: "hana-owner",
        displayName: "Hana Owner",
        passwordSet: true,
      },
    });
    expect(fs.readFileSync(path.join(tmpDir, "local-user-auth.json"), "utf-8"))
      .not.toContain("correct horse battery staple");
  });
});
