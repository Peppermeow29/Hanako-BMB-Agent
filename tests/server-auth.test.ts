import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-server-auth-"));
}

function runtimeContext() {
  return {
    serverId: "server_local",
    serverNodeId: "node_local",
    userId: "user_local",
    studioId: "studio_local",
    connectionKind: "local",
    credentialKind: "loopback_token",
    platformAccountId: null,
    officialServiceKind: null,
    capabilities: ["chat", "resources", "tools"],
  };
}

describe("server auth service", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("authenticates loopback token only for local connection context", async () => {
    tmpDir = makeTmpDir();
    const { createServerAuthService } = await import("../core/server-auth.ts");
    const auth = createServerAuthService({
      hanakoHome: tmpDir,
      loopbackToken: "local-secret",
      runtimeContext: runtimeContext(),
    });

    expect(auth.authenticateRequest({
      authorization: "Bearer local-secret",
      connectionKind: "local",
    })).toMatchObject({
      kind: "local_user",
      credentialKind: "loopback_token",
      connectionKind: "local",
      trustState: "local",
      serverNodeId: "node_local",
      userId: "user_local",
      studioId: "studio_local",
    });

    expect(auth.authenticateRequest({
      authorization: "Bearer local-secret",
      connectionKind: "lan",
    })).toBeNull();
  });

  it("accepts query token only when the adapter explicitly allows it", async () => {
    tmpDir = makeTmpDir();
    const { createServerAuthService } = await import("../core/server-auth.ts");
    const auth = createServerAuthService({
      hanakoHome: tmpDir,
      loopbackToken: "local-secret",
      runtimeContext: runtimeContext(),
    });

    expect(auth.authenticateRequest({
      queryToken: "local-secret",
      connectionKind: "local",
    })).toBeNull();

    expect(auth.authenticateRequest({
      queryToken: "local-secret",
      allowQueryToken: true,
      connectionKind: "local",
    })).toMatchObject({
      kind: "local_user",
      credentialKind: "loopback_token",
    });
  });

  it("authenticates a paired device credential", async () => {
    tmpDir = makeTmpDir();
    const { createDeviceCredential } = await import("../core/device-registry.ts");
    const { createServerAuthService } = await import("../core/server-auth.ts");
    const issued = createDeviceCredential(tmpDir, {
      serverNodeId: "node_local",
      userId: "user_local",
      studioIds: ["studio_local"],
      displayName: "Phone",
      deviceKind: "mobile",
      trustState: "lan",
      scopes: ["chat", "resources.read"],
      now: "2026-05-16T00:00:00.000Z",
    });
    const auth = createServerAuthService({
      hanakoHome: tmpDir,
      loopbackToken: "local-secret",
      runtimeContext: runtimeContext(),
    });

    expect(auth.authenticateRequest({
      authorization: `Bearer ${issued.secret}`,
      connectionKind: "lan",
    })).toMatchObject({
      kind: "device",
      credentialKind: "device_credential",
      connectionKind: "lan",
      trustState: "lan",
      serverNodeId: "node_local",
      userId: "user_local",
      studioId: "studio_local",
      deviceId: issued.device.deviceId,
      scopes: ["chat", "resources.read"],
    });
  });

  it("requires paired device credentials to match their transport trust state", async () => {
    tmpDir = makeTmpDir();
    const { createDeviceCredential } = await import("../core/device-registry.ts");
    const { createServerAuthService } = await import("../core/server-auth.ts");
    const lanIssued = createDeviceCredential(tmpDir, {
      serverNodeId: "node_local",
      userId: "user_local",
      studioIds: ["studio_local"],
      displayName: "LAN Phone",
      deviceKind: "mobile",
      trustState: "lan",
      scopes: ["chat"],
      now: "2026-05-16T00:00:00.000Z",
    });
    const tunnelIssued = createDeviceCredential(tmpDir, {
      serverNodeId: "node_local",
      userId: "user_local",
      studioIds: ["studio_local"],
      displayName: "Tunnel Phone",
      deviceKind: "mobile",
      trustState: "tunnel",
      scopes: ["chat"],
      now: "2026-05-16T00:00:00.000Z",
    });
    const auth = createServerAuthService({
      hanakoHome: tmpDir,
      loopbackToken: "local-secret",
      runtimeContext: runtimeContext(),
    });

    expect(auth.authenticateRequest({
      authorization: `Bearer ${lanIssued.secret}`,
      connectionKind: "custom_remote",
    })).toBeNull();
    expect(auth.authenticateRequest({
      authorization: `Bearer ${tunnelIssued.secret}`,
      connectionKind: "lan",
    })).toBeNull();
    expect(auth.authenticateRequest({
      authorization: `Bearer ${tunnelIssued.secret}`,
      connectionKind: "custom_remote",
    })).toMatchObject({
      kind: "device",
      trustState: "tunnel",
      connectionKind: "custom_remote",
    });
  });

  it("rejects revoked and unknown credentials without falling back to local user", async () => {
    tmpDir = makeTmpDir();
    const {
      createDeviceCredential,
      revokeDeviceCredential,
    } = await import("../core/device-registry.ts");
    const { createServerAuthService } = await import("../core/server-auth.ts");
    const issued = createDeviceCredential(tmpDir, {
      serverNodeId: "node_local",
      userId: "user_local",
      studioIds: ["studio_local"],
      displayName: "Phone",
      deviceKind: "mobile",
      trustState: "lan",
      scopes: ["chat"],
      now: "2026-05-16T00:00:00.000Z",
    });
    revokeDeviceCredential(tmpDir, issued.credential.credentialId, {
      now: "2026-05-16T00:00:01.000Z",
    });
    const auth = createServerAuthService({
      hanakoHome: tmpDir,
      loopbackToken: "local-secret",
      runtimeContext: runtimeContext(),
    });

    expect(auth.authenticateRequest({
      authorization: `Bearer ${issued.secret}`,
      connectionKind: "lan",
    })).toBeNull();
    expect(auth.authenticateRequest({
      authorization: "Bearer definitely-not-real",
      connectionKind: "lan",
    })).toBeNull();
  });

  it("returns structured deny diagnostics for stale local tokens", async () => {
    tmpDir = makeTmpDir();
    const { createServerAuthService } = await import("../core/server-auth.ts");
    const auth = createServerAuthService({
      hanakoHome: tmpDir,
      loopbackToken: "new-local-secret",
      runtimeContext: runtimeContext(),
    });

    expect(auth.authenticateRequestDetailed({
      authorization: "Bearer old-local-secret",
      connectionKind: "local",
    })).toMatchObject({
      principal: null,
      denied: {
        error: "forbidden",
        reason: "invalid_credential",
        credentialSource: "authorization",
        connectionKind: "local",
      },
    });
  });

  it("authenticates web sessions from HttpOnly cookie material without accepting them as URL tokens", async () => {
    tmpDir = makeTmpDir();
    const { createDeviceCredential } = await import("../core/device-registry.ts");
    const { createWebSession } = await import("../core/web-session-store.ts");
    const { createServerAuthService } = await import("../core/server-auth.ts");
    const issued = createDeviceCredential(tmpDir, {
      serverNodeId: "node_local",
      userId: "user_local",
      studioIds: ["studio_local"],
      displayName: "Phone Browser",
      deviceKind: "mobile",
      trustState: "lan",
      scopes: ["chat", "resources.read", "files.read", "files.write"],
      now: "2026-05-16T00:00:00.000Z",
    });
    const auth = createServerAuthService({
      hanakoHome: tmpDir,
      loopbackToken: "local-secret",
      runtimeContext: runtimeContext(),
    });
    const devicePrincipal = auth.authenticateRequest({
      authorization: `Bearer ${issued.secret}`,
      connectionKind: "lan",
      now: "2026-05-16T00:00:01.000Z",
    });
    const webSession = createWebSession(tmpDir, {
      principal: devicePrincipal,
      userAgent: "Mobile Safari",
      now: "2026-05-16T00:00:02.000Z",
      ttlMs: 60_000,
    });

    expect(auth.authenticateRequest({
      cookieHeader: `hana_session=${webSession.secret}`,
      connectionKind: "lan",
      now: "2026-05-16T00:00:03.000Z",
    })).toMatchObject({
      kind: "device",
      credentialKind: "device_credential",
      connectionKind: "lan",
      trustState: "lan",
      userId: "user_local",
      studioId: "studio_local",
      scopes: ["chat", "resources.read", "files.read", "files.write"],
    });

    expect(auth.authenticateRequest({
      queryToken: webSession.secret,
      allowQueryToken: true,
      connectionKind: "lan",
      now: "2026-05-16T00:00:03.000Z",
    })).toBeNull();
  });

  it("does not replay a local-owner web session over LAN transport", async () => {
    tmpDir = makeTmpDir();
    const { createWebSession } = await import("../core/web-session-store.ts");
    const { createServerAuthService } = await import("../core/server-auth.ts");
    const auth = createServerAuthService({
      hanakoHome: tmpDir,
      loopbackToken: "local-secret",
      runtimeContext: runtimeContext(),
    });
    const localPrincipal = auth.authenticateRequest({
      authorization: "Bearer local-secret",
      connectionKind: "local",
      now: "2026-05-16T00:00:00.000Z",
    });
    const webSession = createWebSession(tmpDir, {
      principal: localPrincipal,
      now: "2026-05-16T00:00:01.000Z",
      ttlMs: 60_000,
    });

    expect(auth.authenticateRequest({
      cookieHeader: `hana_session=${webSession.secret}`,
      connectionKind: "local",
      now: "2026-05-16T00:00:02.000Z",
    })).toMatchObject({
      kind: "local_user",
      connectionKind: "local",
    });
    expect(auth.authenticateRequest({
      cookieHeader: `hana_session=${webSession.secret}`,
      connectionKind: "lan",
      now: "2026-05-16T00:00:02.000Z",
    })).toBeNull();
  });
});
