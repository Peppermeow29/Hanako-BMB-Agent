import { describe, expect, it } from "vitest";
import {
  baseNameForShellPath,
  envValue,
  isWin32PathLike,
  normalizeBackslashEscapedDoubleQuotes,
  quoteCmdArg,
  resolveWin32CmdExecutable,
  resolveWin32DefaultPowerShellExecutable,
  resolveWin32PowerShellExecutable,
  splitShellLikeArgs,
} from "../lib/shell/shell-utils.ts";

describe("shell utils", () => {
  it("reads environment variables case-insensitively", () => {
    expect(envValue({ ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "COMSPEC")).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("detects Windows paths and returns platform-aware basenames", () => {
    expect(isWin32PathLike("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(true);
    expect(baseNameForShellPath("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("pwsh.exe");
    expect(baseNameForShellPath("/bin/zsh")).toBe("zsh");
  });

  it("splits shell-like command arguments consistently", () => {
    expect(splitShellLikeArgs('powershell -Command "Write-Output \\"name\\""')).toEqual([
      "powershell",
      "-Command",
      'Write-Output "name"',
    ]);
  });

  it("normalizes delimiter-style escaped quotes without touching quoted inner strings", () => {
    expect(normalizeBackslashEscapedDoubleQuotes('python -c \\"print(1)\\"')).toBe('python -c "print(1)"');
    expect(normalizeBackslashEscapedDoubleQuotes('powershell -Command "Write-Output \\"name\\""')).toBe(
      'powershell -Command "Write-Output \\"name\\""'
    );
  });

  it("resolves Windows native shell executables from one shared policy", () => {
    expect(resolveWin32CmdExecutable({ SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(resolveWin32CmdExecutable({ COMSPEC: "D:\\Tools\\cmd.exe" })).toBe("D:\\Tools\\cmd.exe");
    expect(resolveWin32PowerShellExecutable("powershell.exe", { SystemRoot: "C:\\Windows" })).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
    expect(resolveWin32PowerShellExecutable("pwsh.exe", {}, { resolveOnPath: () => "D:\\PowerShell\\pwsh.exe" })).toBe(
      "D:\\PowerShell\\pwsh.exe"
    );
  });

  it("prefers a probed PowerShell 7 executable for the Windows default", () => {
    const spawn = (command, args) => {
      if (command === "where.exe" && args[0] === "pwsh.exe") {
        return { status: 0, stdout: "D:\\PowerShell\\7\\pwsh.exe\r\n", stderr: "" };
      }
      if (command === "D:\\PowerShell\\7\\pwsh.exe") {
        return { status: 0, stdout: "7\r\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    };

    expect(resolveWin32DefaultPowerShellExecutable({ SystemRoot: "C:\\Windows" }, {
      spawn,
      exists: () => false,
      cache: false,
    })).toBe("D:\\PowerShell\\7\\pwsh.exe");
  });

  it("falls back to Windows PowerShell 5.1 when pwsh is missing or too old", () => {
    const spawn = (command) => {
      if (command === "where.exe") return { status: 0, stdout: "D:\\PowerShell\\6\\pwsh.exe\r\n", stderr: "" };
      if (command === "D:\\PowerShell\\6\\pwsh.exe") return { status: 0, stdout: "6\r\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    };

    expect(resolveWin32DefaultPowerShellExecutable({ SystemRoot: "C:\\Windows" }, {
      spawn,
      exists: () => false,
      cache: false,
    })).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("keeps HANA_POWERSHELL above automatic pwsh detection", () => {
    expect(resolveWin32DefaultPowerShellExecutable({
      HANA_POWERSHELL: "E:\\Tools\\pwsh-custom.exe",
      SystemRoot: "C:\\Windows",
    }, {
      spawn: () => { throw new Error("automatic detection should not run"); },
      exists: () => false,
      cache: false,
    })).toBe("E:\\Tools\\pwsh-custom.exe");
  });

  it("can reject unterminated quotes for execution parsers", () => {
    expect(() => splitShellLikeArgs('python -c "print(1)', {
      throwOnUnterminated: true,
      errorPrefix: "[win32-exec]",
    })).toThrow('[win32-exec] Unterminated quote in command: python -c "print(1)');
  });

  it("quotes cmd arguments with cmd-safe double quote escaping", () => {
    expect(quoteCmdArg("C:\\work\\run tests.bat", { always: true })).toBe('"C:\\work\\run tests.bat"');
    expect(quoteCmdArg('name"here')).toBe('"name""here"');
  });
});
