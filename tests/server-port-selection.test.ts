import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import net from "net";
import http from "http";
import os from "os";
import path from "path";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-server-port-selection-"));
}

describe("server port selection", () => {
  let tmpDir: string | null = null;
  let closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers) {
      await close();
    }
    closers = [];
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  describe("randomPortInBand", () => {
    it("maps random() = 0 to the band minimum", async () => {
      const { randomPortInBand, LOOPBACK_PORT_BAND } = await import("../core/server-port-selection.ts");
      expect(randomPortInBand(() => 0)).toBe(LOOPBACK_PORT_BAND.min);
    });

    it("maps random() close to 1 to at most the band maximum, and returns an integer", async () => {
      const { randomPortInBand, LOOPBACK_PORT_BAND } = await import("../core/server-port-selection.ts");
      const port = randomPortInBand(() => 0.999999);
      expect(port).toBeLessThanOrEqual(LOOPBACK_PORT_BAND.max);
      expect(Number.isInteger(port)).toBe(true);
    });
  });

  describe("selectLoopbackListenPort", () => {
    it("retries past busy ports and returns the first free candidate", async () => {
      const { selectLoopbackListenPort } = await import("../core/server-port-selection.ts");
      let call = 0;
      const probe = async (): Promise<{ ok: true } | { ok: false; code: string }> => {
        call++;
        if (call < 3) return { ok: false, code: "EADDRINUSE" };
        return { ok: true };
      };
      // Distinct candidates per attempt so we can tell which one won.
      let randomCall = 0;
      const candidates = [0.1, 0.2, 0.3];
      const random = () => candidates[randomCall++] ?? 0.9;

      const port = await selectLoopbackListenPort({ probe, random, attempts: 3 });
      expect(call).toBe(3);
      expect(port).not.toBeNull();
    });

    it("returns null after exhausting attempts when probe always fails", async () => {
      const { selectLoopbackListenPort } = await import("../core/server-port-selection.ts");
      let call = 0;
      const probe = async () => {
        call++;
        return { ok: false, code: "EACCES" };
      };
      const port = await selectLoopbackListenPort({ probe, attempts: 5 });
      expect(port).toBeNull();
      expect(call).toBe(5);
    });

    it("skips excluded candidates without probing them", async () => {
      const { selectLoopbackListenPort, LOOPBACK_PORT_BAND } = await import("../core/server-port-selection.ts");
      const excludedPort = LOOPBACK_PORT_BAND.min; // random() = 0 -> band min
      // Alternate between 0 (excluded) and a distinct second value.
      let randomCall = 0;
      const randomValues = [0, 0.5];
      const random = () => randomValues[randomCall++] ?? 0.5;
      const probedPorts: number[] = [];
      const probe = async (port: number): Promise<{ ok: true } | { ok: false; code: string }> => {
        probedPorts.push(port);
        return { ok: true };
      };

      const port = await selectLoopbackListenPort({ probe, random, attempts: 3, exclude: [excludedPort] });
      expect(probedPorts).not.toContain(excludedPort);
      expect(port).not.toBe(excludedPort);
    });
  });

  describe("probeLoopbackListenPort", () => {
    it("reports EADDRINUSE for a busy port and ok for the same port once freed", async () => {
      const { probeLoopbackListenPort } = await import("../core/server-port-selection.ts");

      const occupied = net.createServer();
      await new Promise<void>((resolve, reject) => {
        occupied.once("error", reject);
        occupied.listen(0, "127.0.0.1", () => resolve());
      });
      const address = occupied.address();
      if (!address || typeof address === "string") throw new Error("expected AddressInfo");
      const busyPort = address.port;

      const busyResult = await probeLoopbackListenPort(busyPort, "127.0.0.1");
      expect(busyResult).toMatchObject({ ok: false, code: "EADDRINUSE" });

      await new Promise<void>((resolve) => occupied.close(() => resolve()));

      const freeResult = await probeLoopbackListenPort(busyPort, "127.0.0.1");
      expect(freeResult).toMatchObject({ ok: true });
    });
  });

  describe("ensureServerNetworkConfigWithPortSelection", () => {
    it("creates a fresh config with the selected port when no file exists", async () => {
      tmpDir = makeTmpDir();
      const {
        ensureServerNetworkConfigWithPortSelection,
      } = await import("../core/server-port-selection.ts");
      const { loadServerNetworkConfig } = await import("../core/server-network-config.ts");

      const result = await ensureServerNetworkConfigWithPortSelection(tmpDir, {
        select: async () => 23456,
      });

      expect(result).toMatchObject({ created: true, migrated: false, port: 23456 });
      const config = loadServerNetworkConfig(tmpDir);
      expect(config).toMatchObject({ mode: "loopback", listenHost: "127.0.0.1", listenPort: 23456 });
    });

    it("falls back to the legacy default port when selection fails on a fresh home", async () => {
      tmpDir = makeTmpDir();
      const {
        ensureServerNetworkConfigWithPortSelection,
      } = await import("../core/server-port-selection.ts");
      const { loadServerNetworkConfig } = await import("../core/server-network-config.ts");

      const result = await ensureServerNetworkConfigWithPortSelection(tmpDir, {
        select: async () => null,
      });

      expect(result).toMatchObject({ created: true, port: 14500 });
      const config = loadServerNetworkConfig(tmpDir);
      expect(config.listenPort).toBe(14500);
    });

    it("migrates an existing loopback+14500 config to a newly selected port", async () => {
      tmpDir = makeTmpDir();
      const { saveServerNetworkConfig } = await import("../core/server-network-config.ts");
      const {
        ensureServerNetworkConfigWithPortSelection,
      } = await import("../core/server-port-selection.ts");
      const { loadServerNetworkConfig } = await import("../core/server-network-config.ts");

      saveServerNetworkConfig(tmpDir, {
        schemaVersion: 1,
        mode: "loopback",
        listenHost: "127.0.0.1",
        listenPort: 14500,
        customRemote: { enabled: false, baseUrl: null, wsUrl: null },
      }, { now: "2026-01-01T00:00:00.000Z" });

      const result = await ensureServerNetworkConfigWithPortSelection(tmpDir, {
        select: async () => 31234,
      });

      expect(result).toMatchObject({ created: false, migrated: true, from: 14500, to: 31234 });
      const config = loadServerNetworkConfig(tmpDir);
      expect(config.listenPort).toBe(31234);
      expect(config.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(config.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
    });

    it("leaves an existing loopback config with a custom port untouched", async () => {
      tmpDir = makeTmpDir();
      const { saveServerNetworkConfig } = await import("../core/server-network-config.ts");
      const {
        ensureServerNetworkConfigWithPortSelection,
      } = await import("../core/server-port-selection.ts");

      saveServerNetworkConfig(tmpDir, {
        schemaVersion: 1,
        mode: "loopback",
        listenHost: "127.0.0.1",
        listenPort: 23456,
        customRemote: { enabled: false, baseUrl: null, wsUrl: null },
      });
      const before = fs.readFileSync(path.join(tmpDir, "server-network.json"), "utf-8");

      const result = await ensureServerNetworkConfigWithPortSelection(tmpDir, {
        select: async () => 31234,
      });

      const after = fs.readFileSync(path.join(tmpDir, "server-network.json"), "utf-8");
      expect(after).toBe(before);
      expect(result).toMatchObject({ created: false, migrated: false });
    });

    it("leaves an existing lan mode config with the legacy port untouched", async () => {
      tmpDir = makeTmpDir();
      const { saveServerNetworkConfig } = await import("../core/server-network-config.ts");
      const {
        ensureServerNetworkConfigWithPortSelection,
      } = await import("../core/server-port-selection.ts");

      saveServerNetworkConfig(tmpDir, {
        schemaVersion: 1,
        mode: "lan",
        listenHost: "0.0.0.0",
        listenPort: 14500,
        customRemote: { enabled: false, baseUrl: null, wsUrl: null },
      });
      const before = fs.readFileSync(path.join(tmpDir, "server-network.json"), "utf-8");

      const result = await ensureServerNetworkConfigWithPortSelection(tmpDir, {
        select: async () => 31234,
      });

      const after = fs.readFileSync(path.join(tmpDir, "server-network.json"), "utf-8");
      expect(after).toBe(before);
      expect(result).toMatchObject({ created: false, migrated: false });
    });

    it("propagates a corrupted config file as a thrown error", async () => {
      tmpDir = makeTmpDir();
      fs.writeFileSync(path.join(tmpDir, "server-network.json"), "{ not json", "utf-8");
      const {
        ensureServerNetworkConfigWithPortSelection,
      } = await import("../core/server-port-selection.ts");

      await expect(ensureServerNetworkConfigWithPortSelection(tmpDir, {
        select: async () => 31234,
      })).rejects.toThrow();
    });
  });

  describe("isHanaServerListeningOnPort", () => {
    it("returns true for a server that answers with status and version", async () => {
      const { isHanaServerListeningOnPort } = await import("../core/server-port-selection.ts");
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected AddressInfo");
      closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

      const result = await isHanaServerListeningOnPort({ port: address.port, host: "127.0.0.1" });
      expect(result).toBe(true);
    });

    it("returns false for a server that answers with plain text", async () => {
      const { isHanaServerListeningOnPort } = await import("../core/server-port-selection.ts");
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("hello world");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected AddressInfo");
      closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

      const result = await isHanaServerListeningOnPort({ port: address.port, host: "127.0.0.1" });
      expect(result).toBe(false);
    });

    it("returns false when nothing is listening on the port", async () => {
      const { isHanaServerListeningOnPort } = await import("../core/server-port-selection.ts");
      // Grab an ephemeral free port, then close it so nothing is listening.
      const probe = net.createServer();
      const freePort: number = await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
          const address = probe.address();
          resolve(typeof address === "object" && address ? address.port : 0);
        });
      });
      await new Promise<void>((resolve) => probe.close(() => resolve()));

      const result = await isHanaServerListeningOnPort({ port: freePort, host: "127.0.0.1", timeoutMs: 500 });
      expect(result).toBe(false);
    });
  });

  describe("decideLoopbackBindFallback", () => {
    it("falls back on EADDRINUSE in loopback mode when unpinned and not another Hana server", async () => {
      const { decideLoopbackBindFallback } = await import("../core/server-port-selection.ts");
      expect(decideLoopbackBindFallback({
        errCode: "EADDRINUSE",
        networkMode: "loopback",
        envPortPinned: false,
        hanaOnPort: false,
      })).toBe("fallback");
    });

    it("refuses to fall back when the occupant is another Hana server", async () => {
      const { decideLoopbackBindFallback } = await import("../core/server-port-selection.ts");
      expect(decideLoopbackBindFallback({
        errCode: "EADDRINUSE",
        networkMode: "loopback",
        envPortPinned: false,
        hanaOnPort: true,
      })).toBe("fail-other-hana");
    });

    it("falls back on EACCES and EPERM under the same conditions", async () => {
      const { decideLoopbackBindFallback } = await import("../core/server-port-selection.ts");
      for (const errCode of ["EACCES", "EPERM"]) {
        expect(decideLoopbackBindFallback({
          errCode,
          networkMode: "loopback",
          envPortPinned: false,
          hanaOnPort: false,
        })).toBe("fallback");
      }
    });

    it("never falls back for lan or custom_remote modes", async () => {
      const { decideLoopbackBindFallback } = await import("../core/server-port-selection.ts");
      for (const networkMode of ["lan", "custom_remote"]) {
        expect(decideLoopbackBindFallback({
          errCode: "EADDRINUSE",
          networkMode,
          envPortPinned: false,
          hanaOnPort: false,
        })).toBe("fail");
      }
    });

    it("never falls back when the port is pinned via env", async () => {
      const { decideLoopbackBindFallback } = await import("../core/server-port-selection.ts");
      expect(decideLoopbackBindFallback({
        errCode: "EADDRINUSE",
        networkMode: "loopback",
        envPortPinned: true,
        hanaOnPort: false,
      })).toBe("fail");
    });

    it("does not fall back for error codes outside the recognized set", async () => {
      const { decideLoopbackBindFallback } = await import("../core/server-port-selection.ts");
      expect(decideLoopbackBindFallback({
        errCode: "ENOTSUP",
        networkMode: "loopback",
        envPortPinned: false,
        hanaOnPort: false,
      })).toBe("fail");
    });
  });
});
