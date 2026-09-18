import { describe, expect, it, vi } from "vitest";
import { createCommandRunner } from "../lib/shell/command-runner.ts";
import { resolveWin32DefaultPowerShellExecutable } from "../lib/shell/shell-utils.ts";

describe("createCommandRunner", () => {
  it("invokes the POSIX shell profile with executable and argv", async () => {
    const spawnCommand = vi.fn(async () => ({ exitCode: 0 }));
    const run = createCommandRunner({
      platform: "darwin",
      spawnCommand,
    });
    const onData = vi.fn();
    const signal = new AbortController().signal;

    const result = await run("echo hi", "/workspace", {
      env: { SHELL: "/bin/zsh" },
      onData,
      signal,
      timeout: 12,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(spawnCommand).toHaveBeenCalledTimes(1);
    expect(spawnCommand).toHaveBeenCalledWith({
      executable: "/bin/zsh",
      args: ["-lc", "echo hi"],
      cwd: "/workspace",
      env: { SHELL: "/bin/zsh" },
      onData,
      signal,
      timeout: 12,
      profile: expect.objectContaining({
        id: "macos-default",
        family: "posix",
      }),
    });
  });

  it("uses PowerShell for Windows native one-shot commands", async () => {
    const spawnCommand = vi.fn(async () => ({ exitCode: 0 }));
    const env = { SystemRoot: "C:\\Windows" };
    const run = createCommandRunner({
      platform: "win32",
      spawnCommand,
    });

    await run("Write-Output 1", "C:\\work", {
      env,
    });

    expect(spawnCommand).toHaveBeenCalledWith(expect.objectContaining({
      executable: resolveWin32DefaultPowerShellExecutable(env),
      args: [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Write-Output 1",
      ],
      cwd: "C:\\work",
      env,
      profile: expect.objectContaining({
        id: "windows-powershell",
        family: "powershell",
      }),
    }));
  });

  it("does not retry another shell family when the command exits non-zero", async () => {
    const spawnCommand = vi.fn(async () => ({ exitCode: 42 }));
    const run = createCommandRunner({
      platform: "linux",
      spawnCommand,
    });

    const result = await run("false", "/workspace", {
      env: { SHELL: "/bin/bash" },
    });

    expect(result).toEqual({ exitCode: 42 });
    expect(spawnCommand).toHaveBeenCalledTimes(1);
    expect((spawnCommand.mock.calls[0] as any)[0].profile.family).toBe("posix");
  });

  it("passes an explicit profile to the resolver", async () => {
    const spawnCommand = vi.fn(async () => ({ exitCode: 0 }));
    const resolveProfile = vi.fn(() => ({
      id: "custom",
      family: "powershell",
      executable: "pwsh.exe",
      env: { PATH: "custom" },
      argsForCommand: (command) => ["-Command", command],
    }));
    const run = createCommandRunner({
      platform: "win32",
      defaultProfile: "powershell",
      resolveProfile,
      spawnCommand,
    });

    await run("Get-Location", "C:\\work", {
      profile: "pwsh",
      env: { PATH: "base" },
    });

    expect(resolveProfile).toHaveBeenCalledWith({
      platform: "win32",
      profile: "pwsh",
      env: { PATH: "base" },
      resolveWin32ShellRuntime: undefined,
      getWin32ShellEnvForRuntime: undefined,
    });
    expect(spawnCommand).toHaveBeenCalledWith(expect.objectContaining({
      executable: "pwsh.exe",
      args: ["-Command", "Get-Location"],
      env: { PATH: "custom" },
    }));
  });

  it("passes Windows runtime resolvers to the default profile resolver", async () => {
    const spawnCommand = vi.fn(async () => ({ exitCode: 0 }));
    const resolveWin32ShellRuntime = vi.fn(() => ({
      shell: "C:\\Hanako\\resources\\git\\bin\\bash.exe",
      args: ["-lc"],
      label: "bundled",
    }));
    const getWin32ShellEnvForRuntime = vi.fn((env, shellInfo) => ({
      ...env,
      HANA_SHELL_LABEL: shellInfo.label,
    }));
    const run = createCommandRunner({
      platform: "win32",
      spawnCommand,
      resolveWin32ShellRuntime,
      getWin32ShellEnvForRuntime,
    });

    await run("pwd", "C:\\work", {
      profile: "git-bash",
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(resolveWin32ShellRuntime).toHaveBeenCalledWith({
      preferBundled: true,
      env: { PATH: "C:\\Windows\\System32" },
    });
    expect(spawnCommand).toHaveBeenCalledWith(expect.objectContaining({
      executable: "C:\\Hanako\\resources\\git\\bin\\bash.exe",
      args: ["-lc", "pwd"],
      env: {
        PATH: "C:\\Windows\\System32",
        HANA_SHELL_LABEL: "bundled",
      },
    }));
  });

  it("requires a spawnCommand adapter", async () => {
    const run = createCommandRunner({ platform: "darwin" });
    await expect(run("pwd", "/workspace")).rejects.toThrow(/spawnCommand is required/);
  });
});
