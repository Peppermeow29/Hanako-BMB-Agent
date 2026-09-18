import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-device-registry-"));
}

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf-8"));
}

describe("device registry", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("creates empty registries for old data roots", async () => {
    tmpDir = makeTmpDir();
    const { ensureDeviceAccessRegistries } = await import("../core/device-registry.ts");

    const result = ensureDeviceAccessRegistries(tmpDir, { now: "2026-05-16T00:00:00.000Z" });

    expect(result.created).toEqual([
      "devices.json",
      "device-credentials.json",
      "pairing-sessions.json",
    ]);
    expect(readJson(tmpDir, "devices.json")).toMatchObject({
      schemaVersion: 1,
      devices: [],
    });
    expect(readJson(tmpDir, "device-credentials.json")).toMatchObject({
      schemaVersion: 1,
      credentials: [],
    });
    expect(readJson(tmpDir, "pairing-sessions.json")).toMatchObject({
      schemaVersion: 1,
      pairingSessions: [],
    });
  });

  it("creates a hashed device credential and authenticates its clear secret once", async () => {
    tmpDir = makeTmpDir();
    const {
      authenticateDeviceCredential,
      createDeviceCredential,
    } = await import("../core/device-registry.ts");

    const issued = createDeviceCredential(tmpDir, {
      serverNodeId: "node_home_mac",
      userId: "user_owner",
      studioIds: ["studio_home"],
      displayName: "Owner iPhone",
      deviceKind: "mobile",
      trustState: "lan",
      scopes: ["chat", "resources.read"],
      now: "2026-05-16T00:00:00.000Z",
    });

    expect(issued.secret).toMatch(/^hana_dev_/);
    expect(issued.device).toMatchObject({
      serverNodeId: "node_home_mac",
      userId: "user_owner",
      studioIds: ["studio_home"],
      status: "active",
    });
    expect(issued.credential).not.toHaveProperty("secret");

    const credentialRegistry = readJson(tmpDir, "device-credentials.json");
    const serialized = JSON.stringify(credentialRegistry);
    expect(serialized).not.toContain(issued.secret);
    expect(credentialRegistry.credentials[0]).toMatchObject({
      credentialId: issued.credential.credentialId,
      deviceId: issued.device.deviceId,
      secretPrefix: issued.secret.slice(0, 18),
      status: "active",
    });
    expect(credentialRegistry.credentials[0].secretHash).toEqual(expect.any(String));
    expect(credentialRegistry.credentials[0].secretSalt).toEqual(expect.any(String));

    const principal = authenticateDeviceCredential(tmpDir, issued.secret, {
      now: "2026-05-16T00:00:01.000Z",
    });

    expect(principal).toMatchObject({
      kind: "device",
      credentialKind: "device_credential",
      connectionKind: "lan",
      trustState: "lan",
      serverNodeId: "node_home_mac",
      userId: "user_owner",
      studioId: "studio_home",
      studioIds: ["studio_home"],
      deviceId: issued.device.deviceId,
      credentialId: issued.credential.credentialId,
      scopes: ["chat", "resources.read"],
    });
  });

  it("rejects a revoked device credential", async () => {
    tmpDir = makeTmpDir();
    const {
      authenticateDeviceCredential,
      createDeviceCredential,
      revokeDeviceCredential,
    } = await import("../core/device-registry.ts");
    const issued = createDeviceCredential(tmpDir, {
      serverNodeId: "node_home_mac",
      userId: "user_owner",
      studioIds: ["studio_home"],
      displayName: "Owner iPad",
      deviceKind: "mobile",
      trustState: "lan",
      scopes: ["chat"],
      now: "2026-05-16T00:00:00.000Z",
    });

    revokeDeviceCredential(tmpDir, issued.credential.credentialId, {
      now: "2026-05-16T00:00:02.000Z",
    });

    expect(authenticateDeviceCredential(tmpDir, issued.secret)).toBeNull();
    expect(readJson(tmpDir, "device-credentials.json").credentials[0]).toMatchObject({
      status: "revoked",
      revokedAt: "2026-05-16T00:00:02.000Z",
    });
  });

  it("expires pairing sessions before approval", async () => {
    tmpDir = makeTmpDir();
    const {
      approvePairingSession,
      createPairingSession,
    } = await import("../core/device-registry.ts");
    const created = createPairingSession(tmpDir, {
      serverNodeId: "node_home_mac",
      userId: "user_owner",
      requestedDevice: {
        displayName: "Phone Browser",
        deviceKind: "browser",
      },
      ttlMs: 1000,
      now: "2026-05-16T00:00:00.000Z",
    });

    expect(() => approvePairingSession(tmpDir, {
      pairingSessionId: created.pairingSession.pairingSessionId,
      userCode: created.userCode,
      studioIds: ["studio_home"],
      trustState: "lan",
      scopes: ["chat"],
      now: "2026-05-16T00:00:02.000Z",
    })).toThrow("pairing session expired");

    expect(readJson(tmpDir, "pairing-sessions.json").pairingSessions[0]).toMatchObject({
      status: "expired",
      expiredAt: "2026-05-16T00:00:02.000Z",
    });
  });
});
