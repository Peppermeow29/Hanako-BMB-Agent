import { describe, expect, it, vi } from "vitest";
import path from "path";
import {
  buildWindowsServerGuardianArgs,
  isWindowsServerGuardianShutdownConfirmed,
  requestWindowsServerGuardianStop,
  resolveBeforeQuitServerAction,
  resolveWindowsServerGuardian,
} from "../desktop/src/shared/windows-server-guardian.cjs";

describe("Windows server guardian desktop contract", () => {
  it("prefers explicit guardian and resolves packaged/dev helper locations", () => {
    const explicit = "C:\\custom\\guardian.exe";
    expect(resolveWindowsServerGuardian({
      env: { HANA_WIN32_SERVER_GUARDIAN: explicit },
      resourcesPath: "C:\\Hana\\resources",
      appRoot: "C:\\repo",
      arch: "x64",
      existsSync: (candidate: string) => candidate === explicit,
    })).toBe(explicit);

    const packaged = path.join("C:\\Hana\\resources", "sandbox", "windows", "hana-win-sandbox.exe");
    expect(resolveWindowsServerGuardian({
      env: {},
      resourcesPath: "C:\\Hana\\resources",
      appRoot: "C:\\repo",
      arch: "x64",
      existsSync: (candidate: string) => candidate === packaged,
    })).toBe(packaged);
  });

  it("builds an explicit guardian mode invocation without shell quoting", () => {
    expect(buildWindowsServerGuardianArgs({
      parentPid: 123,
      cwd: "C:\\Hana Data\\server",
      executable: "C:\\Hana Data\\server\\hana-server.exe",
      args: ["C:\\Hana Data\\server\\bootstrap.js"],
    })).toEqual([
      "--supervise-server",
      "--parent-pid", "123",
      "--cwd", "C:\\Hana Data\\server",
      "--", "C:\\Hana Data\\server\\hana-server.exe",
      "C:\\Hana Data\\server\\bootstrap.js",
    ]);
  });

  it("rejects incomplete or ambiguous guardian launch inputs", () => {
    expect(() => buildWindowsServerGuardianArgs({ parentPid: 0, cwd: "C:\\x", executable: "x.exe" }))
      .toThrow(/parentPid/);
    expect(() => buildWindowsServerGuardianArgs({ parentPid: 1, cwd: "", executable: "x.exe" }))
      .toThrow(/cwd/);
    expect(() => buildWindowsServerGuardianArgs({ parentPid: 1, cwd: "C:\\x", executable: "" }))
      .toThrow(/executable/);
  });

  it("requests native Job termination through the guardian control pipe", () => {
    const end = vi.fn();
    expect(requestWindowsServerGuardianStop({ stdin: { end, destroyed: false, writableEnded: false } }))
      .toBe(true);
    expect(end).toHaveBeenCalledWith("stop\n");
    expect(requestWindowsServerGuardianStop({ stdin: { end, destroyed: true, writableEnded: false } }))
      .toBe(false);
  });

  it("does not treat native convergence failure exit 125 as confirmed shutdown", () => {
    expect(isWindowsServerGuardianShutdownConfirmed({ exitCode: 0 }, true)).toBe(true);
    expect(isWindowsServerGuardianShutdownConfirmed({ exitCode: 125 }, true)).toBe(false);
    expect(isWindowsServerGuardianShutdownConfirmed({ exitCode: 0 }, false)).toBe(false);
  });

  it("allows only one bounded before-quit shutdown attempt", () => {
    expect(resolveBeforeQuitServerAction({ state: "idle", hasActiveOwnedServer: true })).toBe("start");
    expect(resolveBeforeQuitServerAction({ state: "running", hasActiveOwnedServer: true })).toBe("wait");
    expect(resolveBeforeQuitServerAction({ state: "complete", hasActiveOwnedServer: true })).toBe("allow");
    expect(resolveBeforeQuitServerAction({ state: "idle", hasActiveOwnedServer: false })).toBe("allow");
  });
});
