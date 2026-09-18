import { Hono } from "hono";
import { describe, expect, it, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { SERVER_PROTOCOL_VERSION } from "../shared/contract-versions.cjs";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-server-identity-route-"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function writeValidIdentity(root) {
  writeJson(path.join(root, "server-node.json"), {
    schemaVersion: 1,
    serverId: "server_route",
    label: "Route Server",
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  });
  writeJson(path.join(root, "users.json"), {
    schemaVersion: 1,
    defaultUserId: "user_route",
    users: [{
      userId: "user_route",
      kind: "legacy_owner",
      displayName: "Route User",
      profileSource: "legacy_user_profile",
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
    }],
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  });
  writeJson(path.join(root, "studios.json"), {
    schemaVersion: 1,
    defaultStudioId: "studio_route",
    studios: [{
      studioId: "studio_route",
      ownerUserId: "user_route",
      label: "Route Studio",
      kind: "personal",
      storage: { provider: "legacy_hana_home", legacyRoot: true },
      membershipModel: "single_user_implicit",
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
    }],
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  });
}

describe("server identity route", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("returns token-protected local server identity metadata for the active legacy Studio", async () => {
    tmpDir = makeTmpDir();
    writeValidIdentity(tmpDir);
    const { createServerIdentityRoute } = await import("../server/routes/server-identity.ts");
    const app = new Hono();
    app.route("/api", createServerIdentityRoute({ hanakoHome: tmpDir, appVersion: "1.2.3" }));

    const res = await app.request("/api/server/identity");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connectionKind: "local",
      serverId: "server_route",
      serverNodeId: "server_route",
      serverNodeKind: "local",
      serverNodeTransport: "loopback",
      userId: "user_route",
      studioId: "studio_route",
      label: "Route Server",
      userLabel: "Route User",
      studioLabel: "Route Studio",
      trustState: "local",
      authState: "paired",
      credentialKind: "loopback_token",
      platformAccountId: null,
      officialServiceKind: null,
      executionBoundary: {
        schemaVersion: 1,
        boundaryId: "execb_server_route_studio_route",
        kind: "local_process",
        serverNodeId: "server_route",
        studioId: "studio_route",
        workbench: {
          kind: "legacy_agent_workbench",
          root: null,
        },
        sandbox: {
          kind: "legacy_session_permission",
          enforcedBy: "existing_runtime",
        },
        filesystem: {
          policy: "legacy_workbench_scope",
        },
        network: {
          policy: "local_runtime_default",
        },
      },
      capabilities: ["chat", "resources", "tools"],
      version: "1.2.3",
      serverProtocol: SERVER_PROTOCOL_VERSION,
    });
  });

  it("returns an explicit error when registry files are invalid", async () => {
    tmpDir = makeTmpDir();
    writeValidIdentity(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "studios.json"), "{ bad json", "utf-8");
    const { createServerIdentityRoute } = await import("../server/routes/server-identity.ts");
    const app = new Hono();
    app.route("/api", createServerIdentityRoute({ hanakoHome: tmpDir, appVersion: "1.2.3" }));

    const res = await app.request("/api/server/identity");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "invalid server identity registry",
      detail: expect.stringContaining("invalid studios.json"),
    });
  });

  it("uses the initialized runtime context when available", async () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, "server-node.json"), "{ bad json", "utf-8");
    const { createServerIdentityRoute } = await import("../server/routes/server-identity.ts");
    const app = new Hono();
    app.route("/api", createServerIdentityRoute({
      hanakoHome: tmpDir,
      appVersion: "9.9.9",
      getRuntimeContext: () => ({
        connectionKind: "local",
        serverId: "server_runtime_route",
        serverNodeId: "node_runtime_route",
        serverNodeKind: "local",
        serverNodeTransport: "loopback",
        userId: "user_runtime_route",
        studioId: "studio_runtime_route",
        label: "Runtime Route Server",
        userLabel: "Runtime Route User",
        studioLabel: "Runtime Route Studio",
        trustState: "local",
        authState: "paired",
        credentialKind: "loopback_token",
        platformAccountId: null,
        officialServiceKind: null,
        executionBoundary: {
          schemaVersion: 1,
          boundaryId: "execb_node_runtime_route_studio_runtime_route",
          kind: "local_process",
          serverNodeId: "node_runtime_route",
          studioId: "studio_runtime_route",
          workbench: { kind: "legacy_agent_workbench", root: null },
          sandbox: { kind: "legacy_session_permission", enforcedBy: "existing_runtime" },
          filesystem: { policy: "legacy_workbench_scope" },
          network: { policy: "local_runtime_default" },
        },
        capabilities: ["chat", "resources", "tools"],
        appVersion: "8.8.8",
      }),
    }));

    const res = await app.request("/api/server/identity");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connectionKind: "local",
      serverId: "server_runtime_route",
      serverNodeId: "node_runtime_route",
      serverNodeKind: "local",
      serverNodeTransport: "loopback",
      userId: "user_runtime_route",
      studioId: "studio_runtime_route",
      label: "Runtime Route Server",
      userLabel: "Runtime Route User",
      studioLabel: "Runtime Route Studio",
      trustState: "local",
      authState: "paired",
      credentialKind: "loopback_token",
      platformAccountId: null,
      officialServiceKind: null,
      executionBoundary: {
        schemaVersion: 1,
        boundaryId: "execb_node_runtime_route_studio_runtime_route",
        kind: "local_process",
        serverNodeId: "node_runtime_route",
        studioId: "studio_runtime_route",
        workbench: { kind: "legacy_agent_workbench", root: null },
        sandbox: { kind: "legacy_session_permission", enforcedBy: "existing_runtime" },
        filesystem: { policy: "legacy_workbench_scope" },
        network: { policy: "local_runtime_default" },
      },
      capabilities: ["chat", "resources", "tools"],
      version: "9.9.9",
      serverProtocol: SERVER_PROTOCOL_VERSION,
    });
  });

  it("describes the authenticated device principal for LAN clients", async () => {
    tmpDir = makeTmpDir();
    writeValidIdentity(tmpDir);
    const { createServerIdentityRoute } = await import("../server/routes/server-identity.ts");
    const app = new Hono();
    app.use("*", async (c, next) => {
      (c as any).set("authPrincipal", Object.freeze({
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        trustState: "lan",
        serverId: "server_route",
        serverNodeId: "server_route",
        userId: "user_route",
        studioId: "studio_route",
        scopes: ["chat", "resources.read", "files.read", "files.write"],
      }));
      await next();
    });
    app.route("/api", createServerIdentityRoute({ hanakoHome: tmpDir, appVersion: "1.2.3" }));

    const res = await app.request("/api/server/identity");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      connectionKind: "lan",
      trustState: "lan",
      authState: "paired",
      credentialKind: "device_credential",
      serverId: "server_route",
      userId: "user_route",
      studioId: "studio_route",
      capabilities: ["chat", "resources.read", "resources", "files.read", "files", "files.write"],
      serverProtocol: SERVER_PROTOCOL_VERSION,
    });
  });
});
