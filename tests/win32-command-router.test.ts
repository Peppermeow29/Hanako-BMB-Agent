import { describe, expect, it } from "vitest";
import { classifyWin32Command } from "../lib/sandbox/win32-command-router.ts";

describe("classifyWin32Command", () => {
  const resolveNativePath = (name) => {
    const table = {
      ipconfig: "C:\\Windows\\System32\\ipconfig.exe",
      reg: "C:\\Windows\\System32\\reg.exe",
      git: "C:\\Program Files\\Git\\cmd\\git.exe",
      python: "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311\\python.exe",
    };
    return table[name.toLowerCase()] || null;
  };

  it("routes Windows system executables to cmd", () => {
    expect(classifyWin32Command("ipconfig /all", { resolveNativePath }).runner).toBe("cmd");
    expect(classifyWin32Command("reg query HKCU\\Software", { resolveNativePath }).runner).toBe("cmd");
  });

  it("routes cmd builtins to cmd", () => {
    expect(classifyWin32Command("dir C:\\", { resolveNativePath }).runner).toBe("cmd");
    expect(classifyWin32Command("echo test", { resolveNativePath })).toEqual(
      expect.objectContaining({ runner: "cmd", reason: "cmd-builtin" })
    );
  });

  it("routes Windows find syntax to cmd instead of POSIX find", () => {
    expect(classifyWin32Command('find /c /v "" sample.txt', { resolveNativePath })).toEqual(
      expect.objectContaining({ runner: "cmd", reason: "windows-find-command" })
    );
  });

  it("routes Windows text utilities to cmd", () => {
    expect(classifyWin32Command('findstr /N "Hello" sample.txt', { resolveNativePath })).toEqual(
      expect.objectContaining({ runner: "cmd", reason: "windows-native-utility" })
    );
  });

  it("keeps POSIX-shaped find expressions on the default powershell path", () => {
    expect(classifyWin32Command('find . -name "*.txt"', { resolveNativePath })).toEqual(
      expect.objectContaining({ runner: "powershell-command", reason: "default-powershell" })
    );
  });

  it("routes explicit Windows shells to cmd", () => {
    expect(classifyWin32Command("cmd /c dir", { resolveNativePath }).runner).toBe("cmd");
  });

  it("routes explicit PowerShell commands to the PowerShell runner", () => {
    expect(classifyWin32Command('powershell -Command "Write-Output 1"', { resolveNativePath })).toEqual(
      expect.objectContaining({ runner: "powershell", reason: "explicit-powershell-shell" })
    );
    expect(classifyWin32Command('pwsh -Command "Write-Output 1"', { resolveNativePath })).toEqual(
      expect.objectContaining({ runner: "powershell", reason: "explicit-powershell-shell" })
    );
  });

  it("routes Windows script files to their native shell runners", () => {
    expect(classifyWin32Command("C:\\tmp\\run-tests.bat --fast", { resolveNativePath })).toEqual(
      expect.objectContaining({ runner: "cmd-script", reason: "cmd-script-file" })
    );
    expect(classifyWin32Command('"C:\\tmp\\run tests.cmd"', { resolveNativePath })).toEqual(
      expect.objectContaining({ runner: "cmd-script", reason: "cmd-script-file" })
    );
    expect(classifyWin32Command("C:\\tmp\\run-tests.ps1", { resolveNativePath })).toEqual(
      expect.objectContaining({ runner: "powershell-file", reason: "powershell-script-file" })
    );
  });

  it("keeps explicit POSIX shells on the bash path", () => {
    expect(classifyWin32Command("bash -lc pwd", { resolveNativePath }).runner).toBe("bash");
    expect(classifyWin32Command("sh -lc pwd", { resolveNativePath }).runner).toBe("bash");
  });

  it("routes simple Git commands to the structured git runner", () => {
    expect(classifyWin32Command("git status", { resolveNativePath }).runner).toBe("git");
  });

  it("routes simple Python commands to the structured python runner", () => {
    expect(classifyWin32Command("python script.py", { resolveNativePath }).runner).toBe("python");
    expect(classifyWin32Command('python -c "import sys; print(sys.version)"', { resolveNativePath }).runner).toBe("python");
    expect(classifyWin32Command('python -c \\"import sys; print(sys.version)\\"', { resolveNativePath }).runner).toBe("python");
  });

  it("routes simple Node commands to the structured node runner", () => {
    expect(classifyWin32Command("node server.js", { resolveNativePath }).runner).toBe("node");
    expect(classifyWin32Command('node -e "console.log(process.version)"', { resolveNativePath }).runner).toBe("node");
    expect(classifyWin32Command('node -e \\"console.log(process.version);\\"', { resolveNativePath }).runner).toBe("node");
  });

  it("runs shell-shaped Python commands through the default powershell shell", () => {
    expect(classifyWin32Command("python script.py > out.txt", { resolveNativePath })).toEqual(
      expect.objectContaining({ runner: "powershell-command", reason: "default-powershell-complex" })
    );
  });

  it("runs shell-shaped Node commands through the default powershell shell", () => {
    expect(classifyWin32Command("node server.js > out.txt", { resolveNativePath })).toEqual(
      expect.objectContaining({ runner: "powershell-command", reason: "default-powershell-complex" })
    );
  });

  it("defaults unknown or complex Windows commands to powershell", () => {
    expect(classifyWin32Command("tool --version", { resolveNativePath })).toEqual(
      expect.objectContaining({ runner: "powershell-command", reason: "default-powershell" })
    );
    expect(classifyWin32Command("ls && pwd", { resolveNativePath })).toEqual(
      expect.objectContaining({ runner: "powershell-command", reason: "default-powershell-complex" })
    );
  });
});
