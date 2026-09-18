import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildServeSpawnEnv,
  guardAgainstForeignServer,
  resolveServerSpawnSpec,
  spawnServerForeground,
} from "../cli/server-runner.ts";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-cli-runner-"));
}

describe("CLI server runner", () => {
  let tmpDir = null;
  let hanaHome = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (hanaHome) fs.rmSync(hanaHome, { recursive: true, force: true });
    tmpDir = null;
    hanaHome = null;
  });

  it("runs the source server entry in development", async () => {
    tmpDir = makeTmpDir();
    hanaHome = makeTmpDir(); // isolated HANA_HOME — never touch the real user home's pointers
    const spec = await resolveServerSpawnSpec({
      projectRoot: tmpDir,
      env: { HANA_HOME: hanaHome },
      extraArgs: ["--chat"],
    });

    expect(spec).toMatchObject({
      mode: "source",
      command: process.execPath,
    });
    expect(spec.args).toEqual([path.join(tmpDir, "server", "main-full.ts"), "--chat"]);
    expect(spec.env.HANA_RENDERER_DIST).toBeUndefined();
  });

  it("runs the packaged bootstrap entry when HANA_ROOT is available", async () => {
    tmpDir = makeTmpDir();
    hanaHome = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, "bundle"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "bootstrap.js"), "", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "bundle", "index.js"), "", "utf-8");

    const spec = await resolveServerSpawnSpec({
      projectRoot: "/source/project",
      env: { HANA_ROOT: tmpDir, HANA_HOME: hanaHome },
      extraArgs: [],
    });

    expect(spec.mode).toBe("packaged");
    expect(spec.args).toEqual([path.join(tmpDir, "bootstrap.js")]);
    expect(spec.env.HANA_ROOT).toBe(tmpDir);
    expect(spec.env.HANA_SERVER_ENTRY).toBe(path.join(tmpDir, "bundle", "index.js"));
  });

});

function writeServerInfoFile(hanaHome, info) {
  fs.mkdirSync(hanaHome, { recursive: true });
  fs.writeFileSync(path.join(hanaHome, "server-info.json"), JSON.stringify(info), "utf-8");
}

describe("guardAgainstForeignServer (CLI pre-spawn 同宅互斥预判)", () => {
  let hanaHome = null;

  afterEach(() => {
    if (hanaHome) fs.rmSync(hanaHome, { recursive: true, force: true });
    hanaHome = null;
  });

  it("does not block when no server-info.json exists", async () => {
    hanaHome = makeTmpDir();
    const result = await guardAgainstForeignServer({ hanaHome });
    expect(result).toEqual({ blocked: false, message: null });
  });

  it("blocks when the probe reports alive-same-home, with a message naming ownerKind/version/pid", async () => {
    hanaHome = makeTmpDir();
    writeServerInfoFile(hanaHome, { port: 12345, token: "tok", ownerKind: "desktop", version: "0.393.0", pid: 555 });
    const probeImpl = async () => ({ status: "alive-same-home" as const });

    const result = await guardAgainstForeignServer({ hanaHome, probeImpl });

    expect(result.blocked).toBe(true);
    expect(result.message).toContain("desktop");
    expect(result.message).toContain("0.393.0");
    expect(result.message).toContain("555");
  });

  it("blocks when the probe reports alive-unauthorized", async () => {
    hanaHome = makeTmpDir();
    writeServerInfoFile(hanaHome, { port: 12345, token: "tok", ownerKind: "standalone", pid: 1 });
    const probeImpl = async () => ({ status: "alive-unauthorized" as const });

    const result = await guardAgainstForeignServer({ hanaHome, probeImpl });
    expect(result.blocked).toBe(true);
  });

  it("does not block when the probe reports not-hana or dead — self-cleaning cases", async () => {
    hanaHome = makeTmpDir();
    writeServerInfoFile(hanaHome, { port: 12345, token: "tok" });

    const deadResult = await guardAgainstForeignServer({ hanaHome, probeImpl: async () => ({ status: "dead" as const }) });
    expect(deadResult).toEqual({ blocked: false, message: null });

    const notHanaResult = await guardAgainstForeignServer({
      hanaHome,
      probeImpl: async () => ({ status: "not-hana" as const, detail: "whatever" }),
    });
    expect(notHanaResult).toEqual({ blocked: false, message: null });
  });

  it("ignores whether the recorded pid looks alive — the probe result is the sole source of truth", async () => {
    hanaHome = makeTmpDir();
    // pid 999999999 is virtually guaranteed not to be alive on this machine,
    // yet the probe (not the pid check) still decides the outcome here.
    writeServerInfoFile(hanaHome, { port: 12345, token: "tok", ownerKind: "standalone", pid: 999999999 });
    const probeImpl = async () => ({ status: "alive-same-home" as const });

    const result = await guardAgainstForeignServer({ hanaHome, probeImpl });
    expect(result.blocked).toBe(true);
  });
});

describe("spawnServerForeground — blocked path never spawns", () => {
  let hanaHome = null;

  afterEach(() => {
    if (hanaHome) fs.rmSync(hanaHome, { recursive: true, force: true });
    hanaHome = null;
  });

  it("exits 1 and never resolves resolveServerSpawnSpec/spawn when a foreign server is detected", async () => {
    hanaHome = makeTmpDir();
    writeServerInfoFile(hanaHome, { port: 12345, token: "tok", ownerKind: "standalone", version: "0.393.0", pid: 1 });
    const probeImpl = async () => ({ status: "alive-same-home" as const });
    const exitCalls: any[] = [];
    const exit = ((code?: number) => { exitCalls.push(code); return undefined as any; }) as any;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await spawnServerForeground({
      projectRoot: "/nonexistent/project/root/that/must/never/be/touched",
      env: { HANA_HOME: hanaHome },
      probeImpl,
      exit,
    });

    expect(exitCalls).toEqual([1]);
    expect(result).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("buildServeSpawnEnv", () => {
  it("passes the env through unchanged and does not warn when allowDataDowngrade is false", () => {
    const warn = vi.fn();
    const result = buildServeSpawnEnv({ env: { FOO: "bar" }, allowDataDowngrade: false, warn });
    expect(result).toEqual({ FOO: "bar" });
    expect(result.HANA_ALLOW_DATA_DOWNGRADE).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("sets HANA_ALLOW_DATA_DOWNGRADE=1 and warns when allowDataDowngrade is true", () => {
    const warn = vi.fn();
    const result = buildServeSpawnEnv({ env: { FOO: "bar" }, allowDataDowngrade: true, warn });
    expect(result).toEqual({ FOO: "bar", HANA_ALLOW_DATA_DOWNGRADE: "1" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("--allow-data-downgrade");
  });
});
