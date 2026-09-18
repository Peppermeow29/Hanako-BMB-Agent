import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-server-network-"));
}

describe("server network config", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("resolves missing config to loopback defaults", async () => {
    tmpDir = makeTmpDir();
    const {
      loadServerNetworkConfig,
      resolveServerListenOptions,
    } = await import("../core/server-network-config.ts");

    expect(loadServerNetworkConfig(tmpDir)).toMatchObject({
      schemaVersion: 1,
      mode: "loopback",
      listenHost: "127.0.0.1",
      listenPort: 14500,
    });
    expect(resolveServerListenOptions(tmpDir)).toMatchObject({
      mode: "loopback",
      host: "127.0.0.1",
      port: 14500,
    });
  });

  it("upgrades legacy configs without a port to the stable mobile port", async () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, "server-network.json"), JSON.stringify({
      schemaVersion: 1,
      mode: "loopback",
      listenHost: "127.0.0.1",
      customRemote: { enabled: false, baseUrl: null, wsUrl: null },
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    }, null, 2), "utf-8");
    const { loadServerNetworkConfig } = await import("../core/server-network-config.ts");

    expect(loadServerNetworkConfig(tmpDir)).toMatchObject({
      schemaVersion: 1,
      mode: "loopback",
      listenHost: "127.0.0.1",
      listenPort: 14500,
    });
  });

  it("allows explicit LAN listening when mode is lan", async () => {
    tmpDir = makeTmpDir();
    const {
      resolveServerListenOptions,
      saveServerNetworkConfig,
    } = await import("../core/server-network-config.ts");

    saveServerNetworkConfig(tmpDir, {
      schemaVersion: 1,
      mode: "lan",
      listenHost: "0.0.0.0",
      listenPort: 14510,
      customRemote: { enabled: false, baseUrl: null, wsUrl: null },
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    });

    expect(resolveServerListenOptions(tmpDir)).toMatchObject({
      mode: "lan",
      host: "0.0.0.0",
      port: 14510,
    });
  });

  it("rejects public hosts in loopback mode", async () => {
    tmpDir = makeTmpDir();
    const { saveServerNetworkConfig } = await import("../core/server-network-config.ts");

    expect(() => saveServerNetworkConfig(tmpDir, {
      schemaVersion: 1,
      mode: "loopback",
      listenHost: "0.0.0.0",
    })).toThrow("loopback mode must listen on a loopback host");
  });

  it("rejects unknown modes and invalid hosts explicitly", async () => {
    tmpDir = makeTmpDir();
    const { saveServerNetworkConfig } = await import("../core/server-network-config.ts");

    expect(() => saveServerNetworkConfig(tmpDir, {
      schemaVersion: 1,
      mode: "internet",
      listenHost: "127.0.0.1",
    })).toThrow("mode must be one of");
    expect(() => saveServerNetworkConfig(tmpDir, {
      schemaVersion: 1,
      mode: "lan",
      listenHost: "",
    })).toThrow("listenHost required");
    expect(() => saveServerNetworkConfig(tmpDir, {
      schemaVersion: 1,
      mode: "lan",
      listenHost: "0.0.0.0",
      listenPort: 80,
    })).toThrow("listenPort must be between 1024 and 65535");
  });
});
