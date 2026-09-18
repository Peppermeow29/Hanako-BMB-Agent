import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectWin32PowerShellFlavor,
  getSandboxPowerShellProbeResult,
  prepareSandboxRuntime,
  resetSandboxPowerShellProbeCacheForTests,
  sandboxRuntimeCacheRoot,
  setSandboxPowerShellProbeResult,
} from "../lib/sandbox/win32-runtime-cache.ts";

const tempRoots = [];

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-runtime-cache-test-"));
  tempRoots.push(root);
  return root;
}

function touch(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("win32 sandbox runtime cache", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("mirrors bundled Git under HANA_HOME and rewrites all runtime paths", () => {
    const tempRoot = makeTempRoot();
    const hanakoHome = path.join(tempRoot, "home");
    const sourceRoot = path.join(tempRoot, "Program Files", "Hanako", "resources", "git");
    const sourceGit = path.join(sourceRoot, "cmd", "git.exe");
    touch(sourceGit, "git");
    touch(path.join(sourceRoot, "bin", "bash.exe"), "bash");

    const prepared = prepareSandboxRuntime({
      bundledRoot: sourceRoot,
      git: sourceGit,
    }, {
      hanakoHome,
      kind: "git",
    });

    const cacheRoot = sandboxRuntimeCacheRoot(hanakoHome);
    expect(prepared.bundledRoot.startsWith(cacheRoot)).toBe(true);
    expect(prepared.git).toBe(path.join(prepared.bundledRoot, "cmd", "git.exe"));
    expect(prepared.git).not.toBe(sourceGit);
    expect(fs.existsSync(prepared.git)).toBe(true);
    expect(path.relative(hanakoHome, prepared.git).startsWith("..")).toBe(false);
  });

  it("mirrors the Node executable directory under HANA_HOME", () => {
    const tempRoot = makeTempRoot();
    const hanakoHome = path.join(tempRoot, "home");
    const sourceRoot = path.join(tempRoot, "Program Files", "Hanako", "resources", "server");
    const sourceNode = path.join(sourceRoot, "hana-server.exe");
    touch(sourceNode, "node");
    touch(path.join(sourceRoot, "node.dll"), "dll");

    const prepared = prepareSandboxRuntime({
      executable: sourceNode,
    }, {
      hanakoHome,
      kind: "node",
    });

    const cacheRoot = sandboxRuntimeCacheRoot(hanakoHome);
    expect(prepared.executable.startsWith(cacheRoot)).toBe(true);
    expect(prepared.executable).not.toBe(sourceNode);
    expect(fs.existsSync(prepared.executable)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(prepared.executable), "node.dll"))).toBe(true);
    expect(path.relative(hanakoHome, prepared.executable).startsWith("..")).toBe(false);
  });

  it("reuses a valid cached runtime instead of copying on every command", () => {
    const tempRoot = makeTempRoot();
    const hanakoHome = path.join(tempRoot, "home");
    const sourceRoot = path.join(tempRoot, "Program Files", "Hanako", "resources", "git");
    const sourceGit = path.join(sourceRoot, "cmd", "git.exe");
    touch(sourceGit, "git");

    const first = prepareSandboxRuntime({
      bundledRoot: sourceRoot,
      git: sourceGit,
    }, {
      hanakoHome,
      kind: "git",
    });
    const marker = path.join(first.bundledRoot, ".hana-sandbox-runtime.json");
    const markerBefore = fs.statSync(marker).mtimeMs;

    const second = prepareSandboxRuntime({
      bundledRoot: sourceRoot,
      git: sourceGit,
    }, {
      hanakoHome,
      kind: "git",
    });

    expect(second).toEqual(first);
    expect(fs.statSync(marker).mtimeMs).toBe(markerBefore);
  });
});

describe("sandbox PowerShell startup probe cache", () => {
  afterEach(() => {
    resetSandboxPowerShellProbeCacheForTests();
  });

  it("returns null for an executable that has not been probed yet", () => {
    expect(getSandboxPowerShellProbeResult("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBeNull();
  });

  it("caches a probe verdict per executable path independently", () => {
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const legacy = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

    setSandboxPowerShellProbeResult(pwsh, "unsupported");
    setSandboxPowerShellProbeResult(legacy, "ok");

    expect(getSandboxPowerShellProbeResult(pwsh)).toBe("unsupported");
    expect(getSandboxPowerShellProbeResult(legacy)).toBe("ok");
  });

  it("is case-insensitive on Windows-style paths", () => {
    const executable = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    setSandboxPowerShellProbeResult(executable, "ok");
    expect(getSandboxPowerShellProbeResult(executable.toUpperCase())).toBe("ok");
  });
});

describe("win32 PowerShell flavor detection for the exec_command tool description", () => {
  it("returns null on non-win32 platforms without probing", () => {
    const spawn = vi.fn();
    expect(detectWin32PowerShellFlavor({ platform: "darwin", spawn })).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns pwsh when where.exe finds pwsh.exe on PATH", () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: "C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n" }));
    expect(detectWin32PowerShellFlavor({ platform: "win32", spawn: spawn as any })).toBe("pwsh");
  });

  it("returns windows-powershell when where.exe does not find pwsh.exe", () => {
    const spawn = vi.fn(() => ({ status: 1, stdout: "" }));
    expect(detectWin32PowerShellFlavor({ platform: "win32", spawn: spawn as any })).toBe("windows-powershell");
  });

  it("returns windows-powershell when the probe throws", () => {
    const spawn = vi.fn(() => { throw new Error("boom"); });
    expect(detectWin32PowerShellFlavor({ platform: "win32", spawn: spawn as any })).toBe("windows-powershell");
  });

  it("probes fresh on every call instead of memoizing across tool-set builds", () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: "pwsh.exe\r\n" }));
    detectWin32PowerShellFlavor({ platform: "win32", spawn: spawn as any });
    detectWin32PowerShellFlavor({ platform: "win32", spawn: spawn as any });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("queries where.exe pwsh.exe with a bounded timeout and a hidden window", () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: "pwsh.exe\r\n" }));
    detectWin32PowerShellFlavor({ platform: "win32", spawn: spawn as any });
    expect(spawn).toHaveBeenCalledWith("where.exe", ["pwsh.exe"], expect.objectContaining({
      timeout: 3000,
      windowsHide: true,
    }));
  });
});
