import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  buildWin32SandboxTokenDiagnosticArgs,
  buildWin32SandboxHelperArgs,
  createWin32SandboxTerminalStderrFilter,
  parseWin32SandboxTerminalRecord,
  resolveWin32SandboxHelper,
  resourceSiblingDir,
} from "../lib/sandbox/win32-sandbox-helper.ts";

describe("resolveWin32SandboxHelper", () => {
  it("prefers the explicit helper contract over every resource-root candidate", () => {
    const explicit = "C:\\custom\\hana-win-sandbox.exe";

    expect(resolveWin32SandboxHelper({
      env: {
        HANA_WIN32_SANDBOX_HELPER: explicit,
        HANA_DESKTOP_RESOURCES_PATH: "C:\\Hana\\resources",
        HANA_DESKTOP_IS_PACKAGED: "1",
        HANA_DESKTOP_APP_PATH: "C:\\OldHana\\resources\\app.asar",
        HANA_DESKTOP_EXEC_PATH: "C:\\OldHana\\HanaAgent.exe",
      },
      resourcesPath: "C:\\Electron\\resources",
      cwd: "C:\\repo",
      arch: "x64",
      existsSync: () => true,
    })).toBe(explicit);
  });

  it("resolves the installed helper and bundled Git from old packaged-shell variables", () => {
    const appPath = "C:\\Program Files\\HanaAgent\\resources\\app.asar";
    const expectedResources = path.win32.dirname(appPath);
    const expectedHelper = path.win32.join(
      expectedResources,
      "sandbox",
      "windows",
      "hana-win-sandbox.exe",
    );
    const expectedGit = path.win32.join(expectedResources, "git");
    const env = {
      HANA_DESKTOP_IS_PACKAGED: "1",
      HANA_DESKTOP_APP_PATH: appPath,
      HANA_DESKTOP_EXEC_PATH: "C:\\Program Files\\HanaAgent\\HanaAgent.exe",
      HANA_ROOT: "C:\\Users\\Hana\\.hanako\\artifacts\\server\\0.412.7",
    };
    const existsSync = (candidate: string) => candidate === expectedHelper || candidate === expectedGit;

    expect(resolveWin32SandboxHelper({
      env,
      resourcesPath: null,
      cwd: "C:\\Users\\Hana\\.hanako\\artifacts\\server\\0.412.7",
      arch: "x64",
      existsSync,
    })).toBe(expectedHelper);
    expect(resourceSiblingDir("git", {
      env,
      resourcesPath: null,
      existsSync,
    })).toBe(expectedGit);
  });

  it("prefers the new desktop resource-root contract over old packaged-shell inference", () => {
    const explicitResources = "C:\\Hana\\resources";
    const expectedGit = path.win32.join(explicitResources, "git");

    expect(resourceSiblingDir("git", {
      env: {
        HANA_DESKTOP_RESOURCES_PATH: explicitResources,
        HANA_DESKTOP_IS_PACKAGED: "1",
        HANA_DESKTOP_APP_PATH: "C:\\OldHana\\resources\\app.asar",
        HANA_DESKTOP_EXEC_PATH: "C:\\OldHana\\HanaAgent.exe",
      },
      resourcesPath: null,
      existsSync: () => true,
    })).toBe(expectedGit);
  });

  it("does not infer installation resources outside a packaged desktop process", () => {
    const legacyHelper = path.win32.join(
      "C:\\Hana\\resources",
      "sandbox",
      "windows",
      "hana-win-sandbox.exe",
    );

    expect(resolveWin32SandboxHelper({
      env: {
        HANA_DESKTOP_IS_PACKAGED: "0",
        HANA_DESKTOP_APP_PATH: "C:\\Hana\\resources\\app.asar",
        HANA_DESKTOP_EXEC_PATH: "C:\\Hana\\HanaAgent.exe",
      },
      resourcesPath: null,
      cwd: "C:\\repo",
      arch: "x64",
      existsSync: (candidate: string) => candidate === legacyHelper,
    })).toBeNull();
  });

  it("returns null when no explicit, packaged, artifact, or dev helper exists", () => {
    expect(resolveWin32SandboxHelper({
      env: {
        HANA_DESKTOP_IS_PACKAGED: "1",
        HANA_DESKTOP_APP_PATH: "C:\\Hana\\resources\\app.asar",
        HANA_DESKTOP_EXEC_PATH: "C:\\Hana\\HanaAgent.exe",
        HANA_ROOT: "C:\\Users\\Hana\\.hanako\\artifacts\\server\\0.412.7",
      },
      resourcesPath: null,
      cwd: "C:\\repo",
      arch: "x64",
      existsSync: () => false,
    })).toBeNull();
  });
});

describe("buildWin32SandboxHelperArgs", () => {
  it("projects the helper contract as write roots instead of read ACL grants", () => {
    const args = buildWin32SandboxHelperArgs({
      cwd: "C:\\work",
      timeoutMs: 5000,
      executable: "C:\\Hanako\\resources\\git\\bin\\bash.exe",
      args: ["-lc", "curl https://example.com"],
      grants: {
        readPaths: ["C:\\outside\\brief.md"],
        optionalReadPaths: ["C:\\Users\\Hana"],
        writePaths: ["C:\\work"],
        optionalWritePaths: ["C:\\Users\\Hana\\.hanako\\.ephemeral"],
        denyReadPaths: ["C:\\Users\\Hana\\.hanako\\auth.json"],
        denyWritePaths: ["C:\\work\\.git"],
      },
    });

    expect(args).toEqual([
      "--cwd",
      "C:\\work",
      "--writable-root",
      "C:\\work",
      "--writable-root-optional",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
      "--deny-write",
      "C:\\work\\.git",
      "--timeout-ms",
      "5000",
      "--",
      "C:\\Hanako\\resources\\git\\bin\\bash.exe",
      "-lc",
      "curl https://example.com",
    ]);
    expect(args).not.toEqual(expect.arrayContaining([
      "--grant-read",
      "--grant-read-optional",
      "--grant-write",
      "--grant-write-optional",
      "--deny-read",
      "--diagnose-legacy-acl",
      "--cleanup-legacy-acl",
      "--cleanup-hana-write-acl",
      "--cleanup-legacy-profile",
      "--legacy-appcontainer-profile",
    ]));
  });

  it("always emits one strict native timeout argument before the executable boundary", () => {
    expect(buildWin32SandboxHelperArgs({
      cwd: "C:\\work",
      timeoutMs: 0,
      executable: "C:\\Windows\\System32\\cmd.exe",
    })).toEqual([
      "--cwd", "C:\\work",
      "--timeout-ms", "0",
      "--", "C:\\Windows\\System32\\cmd.exe",
    ]);

    for (const timeoutMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0xFFFFFFFF]) {
      expect(() => buildWin32SandboxHelperArgs({
        cwd: "C:\\work",
        timeoutMs,
        executable: "C:\\Windows\\System32\\cmd.exe",
      })).toThrow(/timeoutMs/);
    }
  });

  it("opts into the helper's explicitly named current desktop only when requested", () => {
    expect(buildWin32SandboxHelperArgs({
      cwd: "C:\\work",
      timeoutMs: 5000,
      desktopMode: "current",
      executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoProfile", "-Command", "Write-Output ok"],
    })).toEqual([
      "--cwd", "C:\\work",
      "--current-desktop",
      "--timeout-ms", "5000",
      "--", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoProfile", "-Command", "Write-Output ok",
    ]);

    expect(buildWin32SandboxHelperArgs({
      cwd: "C:\\work",
      timeoutMs: 5000,
      executable: "C:\\Windows\\System32\\cmd.exe",
    })).not.toContain("--current-desktop");

    expect(() => buildWin32SandboxHelperArgs({
      cwd: "C:\\work",
      timeoutMs: 5000,
      desktopMode: "shared" as any,
      executable: "C:\\Windows\\System32\\cmd.exe",
    })).toThrow(/desktopMode/);
  });

  it("preserves a caller-owned cmd command tail only when explicitly requested", () => {
    expect(buildWin32SandboxHelperArgs({
      cwd: "C:\\work",
      timeoutMs: 5000,
      verbatimLastArg: true,
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -EncodedCommand AAA='],
    })).toContain("--verbatim-last-arg");

    expect(() => buildWin32SandboxHelperArgs({
      cwd: "C:\\work",
      timeoutMs: 5000,
      verbatimLastArg: true,
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: [],
    })).toThrow(/verbatimLastArg requires at least one child argument/);
  });

  it("parses the last versioned native terminal record without confusing exit 124 with timeout", () => {
    const output = [
      "child output",
      'hana-win-sandbox: terminal-v1 status="timed_out" exitCode="124" timeoutMs="5000" win32Error="0"',
      'hana-win-sandbox: terminal-v1 status="exited" exitCode="124" timeoutMs="5000" win32Error="0"',
    ].join("\n");

    expect(parseWin32SandboxTerminalRecord(output)).toEqual({
      version: 1,
      status: "exited",
      exitCode: 124,
      timeoutMs: 5000,
      win32Error: 0,
    });
  });

  it("filters only exact terminal records across stderr chunk boundaries and flushes other bytes unchanged", () => {
    const forwarded: Buffer[] = [];
    const filter = createWin32SandboxTerminalStderrFilter({
      onData: (data: Buffer) => forwarded.push(Buffer.from(data)),
    });

    filter.push(Buffer.from([
      "warning one\r\n",
      "prefix hana-win-sandbox: terminal-v1 is ordinary stderr\n",
      'hana-win-sandbox: terminal-v1 status="tim',
    ].join("")));
    filter.push(Buffer.from([
      'ed_out" exitCode="124" timeoutMs="5000" win32Error="0"\r\n',
      "warning tail",
    ].join("")));
    filter.flush();

    expect(Buffer.concat(forwarded).toString("utf8")).toBe([
      "warning one\r\n",
      "prefix hana-win-sandbox: terminal-v1 is ordinary stderr\n",
      "warning tail",
    ].join(""));
    expect(filter.terminalRecord).toEqual({
      version: 1,
      status: "timed_out",
      exitCode: 124,
      timeoutMs: 5000,
      win32Error: 0,
    });
  });

  it("builds token diagnostic args without changing the executable contract", () => {
    expect(buildWin32SandboxTokenDiagnosticArgs({
      cwd: "C:\\work",
      timeoutMs: 0,
      executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoLogo", "-Command", "Write-Output ok"],
      grants: {
        writePaths: ["C:\\work"],
        optionalWritePaths: ["C:\\Users\\Hana\\.hanako\\.ephemeral"],
        denyWritePaths: ["C:\\work\\protected-cache"],
      },
    })).toEqual([
      "--diagnose-token",
      "--cwd",
      "C:\\work",
      "--writable-root",
      "C:\\work",
      "--writable-root-optional",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
      "--deny-write",
      "C:\\work\\protected-cache",
      "--timeout-ms",
      "0",
      "--",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoLogo",
      "-Command",
      "Write-Output ok",
    ]);
  });

  it("keeps required ACL failures diagnosable with numeric Win32 codes", () => {
    const helperSource = fs.readFileSync(
      path.join(process.cwd(), "desktop", "native", "HanaWindowsSandboxHelper", "main.cpp"),
      "utf-8",
    );

    expect(helperSource).toContain("static std::wstring win32Diagnostic(DWORD code)");
    expect(helperSource).toContain('fail(L"cannot apply ACL for " + path + L": " + win32Diagnostic(rc))');
  });
});
