import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Electron adds resourcesPath at runtime, but the Node Process type does not
// declare it. Keep the test's platform fixture explicit without weakening the
// production typing surface.
declare global {
  namespace NodeJS {
    interface Process {
      resourcesPath?: string;
    }
  }
}

const spawnAndStream = vi.fn<(...args: any[]) => Promise<{ exitCode: number }>>(async (cmd, args, opts) => {
  if (/hana-win-sandbox\.exe$/i.test(String(cmd))) {
    // The sandboxed PowerShell startup probe always succeeds by default so
    // tests that don't care about probing can exercise the actual command;
    // tests that specifically exercise probe failure override this per-case.
    if (Array.isArray(args) && args.includes("[Console]::Out.Write('ok')")) {
      opts?.onStdout?.(Buffer.from("ok"));
    }
    opts?.onStderr?.(Buffer.from(
      'hana-win-sandbox: terminal-v1 status="exited" exitCode="0" timeoutMs="5000" win32Error="0"\n'
    ));
  }
  return { exitCode: 0 };
});
const classifyWin32Command = vi.fn();
const prepareSandboxRuntime = vi.fn<(...args: any[]) => any>((runtimeInfo) => runtimeInfo);
const sandboxPowerShellProbeCache = new Map<string, "ok" | "unsupported">();
const getSandboxPowerShellProbeResult = vi.fn((executable: string) =>
  sandboxPowerShellProbeCache.get(String(executable).toLowerCase()) ?? null);
const setSandboxPowerShellProbeResult = vi.fn((executable: string, result: "ok" | "unsupported") => {
  sandboxPowerShellProbeCache.set(String(executable).toLowerCase(), result);
});
const existsSync = vi.fn<(...args: any[]) => boolean>(() => false);
const mkdirSync = vi.fn();
const statSync = vi.fn<(...args: any[]) => any>(() => ({ isDirectory: () => true }));
const spawnSync = vi.fn<(...args: any[]) => { status: number; stdout: string; stderr: string }>(() => ({ status: 1, stdout: "", stderr: "" }));
const systemCmdExe = "C:\\Windows\\System32\\cmd.exe";
const powershellUtf8Prelude = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [Console]::OutputEncoding";

function withPowerShellUtf8Prelude(command: string) {
  return `${powershellUtf8Prelude}; ${command}`;
}

vi.mock("../lib/sandbox/exec-helper.js", () => ({
  spawnAndStream,
}));

vi.mock("../lib/sandbox/win32-command-router.js", () => ({
  classifyWin32Command,
}));

vi.mock("../lib/sandbox/win32-runtime-cache.js", () => ({
  prepareSandboxRuntime,
  getSandboxPowerShellProbeResult,
  setSandboxPowerShellProbeResult,
}));

vi.mock("fs", () => ({
  existsSync,
  mkdirSync,
  statSync,
}));

vi.mock("child_process", () => ({
  spawnSync,
}));

async function loadExecFactory() {
  const mod = await import("../lib/sandbox/win32-exec.ts");
  return mod.createWin32Exec;
}

describe("createWin32Exec", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sandboxPowerShellProbeCache.clear();
    prepareSandboxRuntime.mockImplementation((runtimeInfo) => runtimeInfo);
    existsSync.mockReturnValue(false);
    mkdirSync.mockImplementation(() => undefined);
    statSync.mockImplementation(() => ({ isDirectory: () => true }));
    spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });
  });

  it("routes Windows native commands through cmd.exe", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-system-executable" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("ipconfig /all", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      systemCmdExe,
      ["/d", "/s", "/c", '"chcp 65001 >NUL & ipconfig /all"'],
      expect.objectContaining({
        cwd: "C:\\work",
        windowsVerbatimArguments: true,
        env: expect.objectContaining({
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
        }),
      })
    );
  });

  it("rejects before spawning when the working directory is missing", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-system-executable" });
    statSync.mockImplementation((p: any) => {
      if (p === "C:\\gone") {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return { isDirectory: () => true };
    });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await expect(
      exec("ipconfig /all", "C:\\gone", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      }),
    ).rejects.toMatchObject({ code: "HANA_EXEC_CWD_MISSING", cwd: "C:\\gone" });
    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("preserves explicit Python encoding settings while adding other UTF-8 defaults", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("type sample.txt", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: {
        PATH: "C:\\Windows\\System32",
        PYTHONUTF8: "0",
      },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      systemCmdExe,
      ["/d", "/s", "/c", '"chcp 65001 >NUL & type sample.txt"'],
      expect.objectContaining({
        windowsVerbatimArguments: true,
        env: expect.objectContaining({
          PYTHONUTF8: "0",
          PYTHONIOENCODING: "utf-8",
        }),
      })
    );
  });

  it("routes sandboxed Windows native commands through cmd with UTF-8 defaults", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-native-utility" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    await exec('findstr /N "Hello" sample.txt', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--verbatim-last-arg",
      "--timeout-ms",
      "5000",
      "--",
      systemCmdExe,
      "/d",
      "/s",
      "/c",
      '"chcp 65001 >NUL & findstr /N "Hello" sample.txt"',
    ]));
    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      helperArgs,
      expect.objectContaining({
        cwd: "C:\\work",
        timeout: 12,
        timeoutErrorValue: 5,
        killMode: "process",
        exitStdioGraceMs: 2000,
        env: expect.objectContaining({
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
        }),
      })
    );
  });

  it("passes embedded double quotes through the sandbox helper verbatim", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-native-utility" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    await exec(
      'reg query "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\ICM" /s',
      "C:\\work",
      {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      },
    );

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toContain("--verbatim-last-arg");
    const last = helperArgs[helperArgs.length - 1];
    expect(last).toBe(
      '"chcp 65001 >NUL & reg query "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\ICM" /s"',
    );
  });

  it("promotes the Hana sandbox scratch root to a required writable-root for every sandbox-helper launch", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-native-utility" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work", "C:\\other"],
        },
      },
    });

    await exec("dir", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    const envRoot = "C:\\Users\\Hana\\.hanako\\.ephemeral\\win32-sandbox-env";
    const tempDir = `${envRoot}\\Temp`;
    expect(mkdirSync).toHaveBeenCalledWith(envRoot, { recursive: true });
    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining(["--writable-root", envRoot]));
    // The two policy-derived roots stay required roots too; the scratch root
    // is appended, not substituted for them.
    expect(helperArgs).toEqual(expect.arrayContaining(["--writable-root", "C:\\work"]));
    expect(helperArgs).toEqual(expect.arrayContaining(["--writable-root", "C:\\other"]));
    const spawnOptions = spawnAndStream.mock.calls[0][2];
    expect(spawnOptions.env).toEqual(expect.objectContaining({ TEMP: tempDir, TMP: tempDir }));
  });

  it("does not add a required writable-root when the sandbox has no hanakoHome", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-native-utility" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: { readPaths: [], writePaths: ["C:\\work"] },
      },
    });

    await exec("dir", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32", TEMP: "C:\\Users\\Hana\\AppData\\Local\\Temp" },
    });

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining(["--writable-root", "C:\\work"]));
    expect(helperArgs.filter((a: string) => a === "--writable-root")).toHaveLength(1);
    const spawnOptions = spawnAndStream.mock.calls[0][2];
    // No hanakoHome means withWin32SandboxRuntimeEnv never redirects TEMP;
    // only the UTF-8 defaults get layered on top of whatever was passed in.
    expect(spawnOptions.env.TEMP).toBe("C:\\Users\\Hana\\AppData\\Local\\Temp");
  });

  it("spawns direct cmd with windowsVerbatimArguments", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec('echo "a b"', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      systemCmdExe,
      ["/d", "/s", "/c", '"chcp 65001 >NUL & echo "a b""'],
      expect.objectContaining({ windowsVerbatimArguments: true }),
    );
  });

  it("uses the native terminal status to distinguish timeout from a real command exit 124", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({ sandbox: { helperPath: helper, grants: { writePaths: ["C:\\work"] } } });
    const chunks: string[] = [];

    spawnAndStream.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts.onStderr(Buffer.from(
        'hana-win-sandbox: terminal-v1 status="exited" exitCode="124" timeoutMs="5000" win32Error="0"\n'
      ));
      return { exitCode: 124 };
    });
    await expect(exec("echo ok", "C:\\work", {
      onData: (data) => chunks.push(Buffer.from(data).toString("utf8")),
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    })).resolves.toEqual({ exitCode: 124 });
    expect(chunks).toEqual([]);

    spawnAndStream.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts.onStderr(Buffer.from(
        'hana-win-sandbox: terminal-v1 status="timed_out" exitCode="124" timeoutMs="5000" win32Error="0"\n'
      ));
      return { exitCode: 124 };
    });
    await expect(exec("echo ok", "C:\\work", {
      onData: (data) => chunks.push(Buffer.from(data).toString("utf8")),
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    })).rejects.toThrow("timeout:5");
    expect(chunks).toEqual([]);
  });

  it("surfaces native Job termination failures without retrying", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    spawnAndStream.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts.onStderr(Buffer.from(
        'hana-win-sandbox: terminal-v1 status="termination_failed" exitCode="" timeoutMs="5000" win32Error="5"\n'
      ));
      return { exitCode: 125 };
    });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({ sandbox: { helperPath: helper, grants: { writePaths: ["C:\\work"] } } });
    const chunks: string[] = [];

    await expect(exec("echo ok", "C:\\work", {
      onData: (data) => chunks.push(Buffer.from(data).toString("utf8")),
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    })).rejects.toMatchObject({ code: "HANA_WIN32_SANDBOX_TERMINATION_FAILED", win32Error: 5 });
    expect(chunks).toEqual([]);
    expect(spawnAndStream).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a sandbox helper exits without its terminal protocol record", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    spawnAndStream.mockResolvedValueOnce({ exitCode: 0 });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({ sandbox: { helperPath: helper, grants: { writePaths: ["C:\\work"] } } });

    await expect(exec("echo ok", "C:\\work", {
      onData: () => {}, signal: undefined, timeout: 5, env: { PATH: "C:\\Windows\\System32" },
    })).rejects.toMatchObject({ code: "HANA_WIN32_SANDBOX_TERMINAL_PROTOCOL" });
    expect(spawnAndStream).toHaveBeenCalledTimes(1);
  });

  it("does not expose native terminal records to command output while preserving stdout and ordinary stderr", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    spawnAndStream.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts.onStdout(Buffer.from("stdout line\n"));
      opts.onStderr(Buffer.from("warning line\r\nhana-win-sandbox: terminal-v1 status=\"ex"));
      opts.onStderr(Buffer.from("ited\" exitCode=\"0\" timeoutMs=\"5000\" win32Error=\"0\"\r\ntrailing stderr"));
      return { exitCode: 0 };
    });
    const chunks: string[] = [];
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({ sandbox: { helperPath: helper, grants: { writePaths: ["C:\\work"] } } });

    await expect(exec("echo ok", "C:\\work", {
      onData: (data) => chunks.push(Buffer.from(data).toString("utf8")),
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    })).resolves.toEqual({ exitCode: 0 });

    expect(chunks.join("")).toBe("stdout line\nwarning line\r\ntrailing stderr");
    expect(chunks.join("")).not.toContain("terminal-v1");
  });

  it("routes explicit PowerShell commands directly without cmd wrapping", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell", reason: "explicit-powershell-shell" });
    const powerShellExe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec('powershell -Command "Write-Output \\"name\\""', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      powerShellExe,
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        withPowerShellUtf8Prelude('Write-Output "name"'),
      ],
      expect.objectContaining({
        cwd: "C:\\work",
        env: expect.objectContaining({
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
        }),
      })
    );
  });

  it("routes PowerShell script files through a UTF-8 -Command wrapper with argv", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell-file", reason: "powershell-script-file" });
    const powerShellExe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec('"C:\\work\\run tests.ps1" -Name Hana', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      powerShellExe,
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        withPowerShellUtf8Prelude("& 'C:\\work\\run tests.ps1' '-Name' 'Hana'"),
      ],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("routes default Windows shell commands through PowerShell without falling back to bash", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell-command", reason: "default-powershell" });
    const powerShellExe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("$PSVersionTable.PSVersion", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      powerShellExe,
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        withPowerShellUtf8Prelude("$PSVersionTable.PSVersion"),
      ],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("prefers a probed pwsh executable for default Windows shell commands", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell-command", reason: "default-powershell" });
    const pwshExe = "D:\\PowerShell\\7\\pwsh.exe";
    spawnSync.mockImplementation((command: any, args: any[]) => {
      if (command === "where" && args[0] === "pwsh.exe") {
        return { status: 0, stdout: `${pwshExe}\r\n`, stderr: "" };
      }
      if (command === pwshExe) {
        return { status: 0, stdout: "7\r\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("Write-Output 1", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "D:\\PowerShell\\7;C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      pwshExe,
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        withPowerShellUtf8Prelude("Write-Output 1"),
      ],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("routes sandboxed default PowerShell commands through the helper after a passing startup probe", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell-command", reason: "default-powershell" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    const powerShellExe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    existsSync.mockImplementation((candidate) => candidate === helper);
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: { readPaths: [], writePaths: ["C:\\work"] },
      },
    });

    await exec("Write-Output 1", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
    });

    expect(spawnAndStream).toHaveBeenCalledTimes(2);
    const probeArgs = spawnAndStream.mock.calls[0][1];
    expect(probeArgs).toEqual(expect.arrayContaining([
      "--", powerShellExe, "-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write('ok')",
    ]));
    const commandArgs = spawnAndStream.mock.calls[1][1];
    expect(commandArgs).toEqual(expect.arrayContaining([
      "--", powerShellExe, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command", withPowerShellUtf8Prelude("Write-Output 1"),
    ]));
  });

  it("caches a passing sandboxed PowerShell probe across repeated commands", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell-command", reason: "default-powershell" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((candidate) => candidate === helper);
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: { readPaths: [], writePaths: ["C:\\work"] },
      },
    });
    const opts = {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
    };

    await exec("Write-Output 1", "C:\\work", opts);
    await exec("Write-Output 2", "C:\\work", opts);

    // One probe call plus one command call per exec, and the second exec's
    // probe is skipped entirely because the first exec already cached "ok".
    expect(spawnAndStream).toHaveBeenCalledTimes(3);
  });

  it("probes the explicitly requested PowerShell executable before running it in the sandbox", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell", reason: "explicit-powershell-shell" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    const powerShellExe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    existsSync.mockImplementation((candidate) => candidate === helper);
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: { readPaths: [], writePaths: ["C:\\work"] },
      },
    });

    await exec('powershell -Command "Write-Output 1"', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
    });

    expect(spawnAndStream).toHaveBeenCalledTimes(2);
    expect(spawnAndStream.mock.calls[0][1]).toEqual(expect.arrayContaining([powerShellExe]));
    expect(spawnAndStream.mock.calls[1][1]).toEqual(expect.arrayContaining([powerShellExe]));
  });

  it("fails fast when the explicitly requested PowerShell executable fails its sandboxed startup probe", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell", reason: "explicit-powershell-shell" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    const configuredPowerShell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    existsSync.mockImplementation((candidate) => candidate === helper);
    spawnAndStream.mockImplementation(async (cmd, args, opts) => {
      opts?.onStderr?.(Buffer.from(
        'hana-win-sandbox: terminal-v1 status="exited" exitCode="1" timeoutMs="5000" win32Error="0"\n'
      ));
      return { exitCode: 1 };
    });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: { readPaths: [], writePaths: ["C:\\work"] },
      },
    });

    await expect(exec('pwsh -Command "Write-Output 1"', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: {
        HANA_POWERSHELL: configuredPowerShell,
        PATH: "C:\\Windows\\System32",
        SystemRoot: "C:\\Windows",
      },
    })).rejects.toMatchObject({
      code: "HANA_WIN32_SANDBOX_POWERSHELL_UNSUPPORTED",
      message: expect.stringContaining('sandbox_permissions="require_escalated"'),
    });
    // Only the probe ran; the explicitly requested shell never got a chance
    // to silently swap to a different PowerShell executable.
    expect(spawnAndStream).toHaveBeenCalledTimes(1);
  });

  it("falls back from pwsh to Windows PowerShell 5.1 when the sandboxed pwsh probe fails", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell-command", reason: "default-powershell" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    const pwshExe = "D:\\PowerShell\\7\\pwsh.exe";
    const legacyExe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    existsSync.mockImplementation((candidate) => candidate === helper);
    spawnSync.mockImplementation((command: any, args: any[]) => {
      if (command === "where" && args[0] === "pwsh.exe") {
        return { status: 0, stdout: `${pwshExe}\r\n`, stderr: "" };
      }
      if (command === pwshExe) {
        return { status: 0, stdout: "7\r\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    spawnAndStream.mockImplementation(async (cmd, args, opts) => {
      if (!/hana-win-sandbox\.exe$/i.test(String(cmd))) return { exitCode: 0 };
      const isProbe = Array.isArray(args) && args.includes("[Console]::Out.Write('ok')");
      const targetsPwsh = Array.isArray(args) && args.includes(pwshExe);
      if (isProbe && targetsPwsh) {
        opts?.onStderr?.(Buffer.from(
          'hana-win-sandbox: terminal-v1 status="exited" exitCode="1" timeoutMs="5000" win32Error="0"\n'
        ));
        return { exitCode: 1 };
      }
      if (isProbe) opts?.onStdout?.(Buffer.from("ok"));
      opts?.onStderr?.(Buffer.from(
        'hana-win-sandbox: terminal-v1 status="exited" exitCode="0" timeoutMs="5000" win32Error="0"\n'
      ));
      return { exitCode: 0 };
    });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: { readPaths: [], writePaths: ["C:\\work"] },
      },
    });

    await exec("Write-Output 1", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "D:\\PowerShell\\7;C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
    });

    // pwsh probe (failed), legacy probe (passed), then the actual command on legacy.
    expect(spawnAndStream).toHaveBeenCalledTimes(3);
    const commandArgs = spawnAndStream.mock.calls[2][1];
    expect(commandArgs).toEqual(expect.arrayContaining(["--", legacyExe]));
  });

  it("fails fast when both pwsh and Windows PowerShell 5.1 fail the sandboxed startup probe", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell-command", reason: "default-powershell" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    const pwshExe = "D:\\PowerShell\\7\\pwsh.exe";
    existsSync.mockImplementation((candidate) => candidate === helper);
    spawnSync.mockImplementation((command: any, args: any[]) => {
      if (command === "where" && args[0] === "pwsh.exe") {
        return { status: 0, stdout: `${pwshExe}\r\n`, stderr: "" };
      }
      if (command === pwshExe) {
        return { status: 0, stdout: "7\r\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    spawnAndStream.mockImplementation(async (cmd, _args, opts) => {
      if (!/hana-win-sandbox\.exe$/i.test(String(cmd))) return { exitCode: 0 };
      opts?.onStderr?.(Buffer.from(
        'hana-win-sandbox: terminal-v1 status="exited" exitCode="1" timeoutMs="5000" win32Error="0"\n'
      ));
      return { exitCode: 1 };
    });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: { readPaths: [], writePaths: ["C:\\work"] },
      },
    });

    await expect(exec("Write-Output 1", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "D:\\PowerShell\\7;C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
    })).rejects.toMatchObject({
      code: "HANA_WIN32_SANDBOX_POWERSHELL_UNSUPPORTED",
      message: expect.stringContaining('sandbox_permissions="require_escalated"'),
    });
    // pwsh probe, then legacy probe; both fail, route fails fast without
    // silently falling back to cmd.
    expect(spawnAndStream).toHaveBeenCalledTimes(2);
  });

  it("routes batch scripts through cmd call without bash", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd-script", reason: "cmd-script-file" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("C:\\work\\run-tests.bat --fast", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      systemCmdExe,
      ["/d", "/s", "/c", '"chcp 65001 >NUL & call C:\\work\\run-tests.bat --fast"'],
      expect.objectContaining({ cwd: "C:\\work", windowsVerbatimArguments: true })
    );
  });

  it("routes sandboxed relative batch scripts through cmd call", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd-script", reason: "cmd-script-file" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    await exec(".tmp\\sandbox-smoke\\test-bat.bat", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32", COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--verbatim-last-arg",
        "--",
        "C:\\Windows\\System32\\cmd.exe",
        "/d",
        "/s",
        "/c",
        '"chcp 65001 >NUL & call .tmp\\sandbox-smoke\\test-bat.bat"',
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("redirects sandbox runtime temp and cache env into the writable Hana scratch area", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "default-cmd" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
          optionalWritePaths: ["C:\\Users\\Hana\\.hanako\\.ephemeral"],
        },
      },
    });

    await exec("echo sandbox-env", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: {
        PATH: "C:\\Windows\\System32",
        SystemRoot: "C:\\Windows",
        USERPROFILE: "C:\\Users\\Hana",
        TEMP: "C:\\Users\\Hana\\AppData\\Local\\Temp",
        TMP: "C:\\Users\\Hana\\AppData\\Local\\Temp",
        LOCALAPPDATA: "C:\\Users\\Hana\\AppData\\Local",
        APPDATA: "C:\\Users\\Hana\\AppData\\Roaming",
      },
    });

    const envRoot = "C:\\Users\\Hana\\.hanako\\.ephemeral\\win32-sandbox-env";
    const tempDir = `${envRoot}\\Temp`;
    const localAppDataDir = `${envRoot}\\LocalAppData`;
    const appDataDir = `${envRoot}\\AppData\\Roaming`;
    const npmCacheDir = `${envRoot}\\npm-cache`;
    const pipCacheDir = `${envRoot}\\pip-cache`;
    const spawnOptions = spawnAndStream.mock.calls[0][2];

    for (const dir of [tempDir, localAppDataDir, appDataDir, npmCacheDir, pipCacheDir]) {
      expect(mkdirSync).toHaveBeenCalledWith(dir, { recursive: true });
    }
    // envRoot itself is also created and promoted to a required writable-root
    // (see the "promotes the Hana sandbox scratch root" test) so the
    // write-restricted token can actually write the Temp/LocalAppData/AppData
    // subdirectories underneath it.
    expect(mkdirSync).toHaveBeenCalledWith(envRoot, { recursive: true });
    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining(["--writable-root", envRoot]));
    expect(spawnOptions.env).toEqual(expect.objectContaining({
      USERPROFILE: "C:\\Users\\Hana",
      TEMP: tempDir,
      TMP: tempDir,
      LOCALAPPDATA: localAppDataDir,
      APPDATA: appDataDir,
      npm_config_cache: npmCacheDir,
      PIP_CACHE_DIR: pipCacheDir,
    }));
  });

  it("routes simple Git commands through bundled git.exe without bash", async () => {
    classifyWin32Command.mockReturnValue({ runner: "git", reason: "git-command" });
    const gitExe = "C:\\Hanako\\resources\\git\\cmd\\git.exe";
    existsSync.mockImplementation((p) => p === gitExe);

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    try {
      await exec('git -C "C:\\Users\\Me\\repo" status --short "src file.txt"', "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      gitExe,
      ["-C", "C:\\Users\\Me\\repo", "status", "--short", "src file.txt"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("routes sandboxed simple Git commands through bundled git.exe via the helper", async () => {
    classifyWin32Command.mockReturnValue({ runner: "git", reason: "git-command" });
    const gitExe = "C:\\Hanako\\resources\\git\\cmd\\git.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === gitExe || p === helper);

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("git status --short", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--writable-root",
      "C:\\work",
      "--",
      gitExe,
      "status",
      "--short",
    ]));
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      helperArgs,
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("rewrites sandboxed Git commands to the user-writable runtime cache", async () => {
    classifyWin32Command.mockReturnValue({ runner: "git", reason: "git-command" });
    const gitExe = "C:\\Hanako\\resources\\git\\cmd\\git.exe";
    const cachedRoot = "C:\\Users\\Hana\\.hanako\\.ephemeral\\win32-sandbox-runtime\\git-cache";
    const cachedGit = `${cachedRoot}\\cmd\\git.exe`;
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === gitExe || p === helper);
    prepareSandboxRuntime.mockImplementation((runtimeInfo, options) => {
      expect(options).toEqual(expect.objectContaining({
        kind: "git",
        hanakoHome: "C:\\Users\\Hana\\.hanako",
      }));
      return {
        ...runtimeInfo,
        bundledRoot: cachedRoot,
        git: cachedGit,
      };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("git status --short", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--writable-root",
      "C:\\work",
      "--",
      cachedGit,
      "status",
      "--short",
    ]));
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain(cachedRoot);
    expect(helperArgs).not.toContain("C:\\Hanako\\resources\\git");
    expect(helperArgs).not.toContain(gitExe);
  });

  it("grants sandboxed Python commands read-write access to the Python runtime", async () => {
    classifyWin32Command.mockReturnValue({ runner: "python", reason: "python-command" });
    const pythonExe = "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311\\python.exe";
    const pythonRoot = "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === pythonExe || p === pythonRoot || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "python") {
        return { status: 0, stdout: `${pythonExe}\r\n`, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    await exec("python tools\\make_doc.py", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311;C:\\Windows\\System32" },
    });

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--writable-root",
        "C:\\work",
        "--",
        pythonExe,
        "tools\\make_doc.py",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain("--grant-write-optional");
    expect(helperArgs).not.toContain(pythonRoot);
  });

  it("passes Python inline code as argv instead of routing it through bash", async () => {
    classifyWin32Command.mockReturnValue({ runner: "python", reason: "python-command" });
    const pythonExe = "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311\\python.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === pythonExe || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "python") {
        return { status: 0, stdout: `${pythonExe}\r\n`, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    await exec('python -c "import sys; print(sys.version)"', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Users\\Me\\AppData\\Local\\Programs\\Python\\Python311;C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--",
        pythonExe,
        "-c",
        "import sys; print(sys.version)",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("routes sandboxed simple Node commands through the current Node runtime via the helper", async () => {
    classifyWin32Command.mockReturnValue({ runner: "node", reason: "node-command" });
    const nodeExe = "C:\\Hanako\\resources\\server\\hana-server.exe";
    const nodeRoot = "C:\\Hanako\\resources\\server";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === nodeExe || p === nodeRoot || p === helper);

    const originalExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: nodeExe,
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("node server.js --port 3000", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "execPath", {
        value: originalExecPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--writable-root",
        "C:\\work",
        "--",
        nodeExe,
        "server.js",
        "--port",
        "3000",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain(nodeRoot);
  });

  it("prefers PATH Node over the packaged Hana server runtime for user node commands", async () => {
    classifyWin32Command.mockReturnValue({ runner: "node", reason: "node-command" });
    const hanaNodeExe = "C:\\Hanako\\resources\\server\\hana-server.exe";
    const pathNodeExe = "C:\\Program Files\\nodejs\\node.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === hanaNodeExe || p === pathNodeExe || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "node") {
        return { status: 0, stdout: `${pathNodeExe}\r\n`, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: hanaNodeExe,
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("node --version", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Program Files\\nodejs;C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "execPath", {
        value: originalExecPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--",
        pathNodeExe,
        "--version",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
    expect(spawnAndStream.mock.calls[0][1]).not.toContain(hanaNodeExe);
  });

  it("rewrites sandboxed Node commands to the user-writable runtime cache", async () => {
    classifyWin32Command.mockReturnValue({ runner: "node", reason: "node-command" });
    const nodeExe = "C:\\Hanako\\resources\\server\\hana-server.exe";
    const cachedRoot = "C:\\Users\\Hana\\.hanako\\.ephemeral\\win32-sandbox-runtime\\node-cache";
    const cachedNode = `${cachedRoot}\\hana-server.exe`;
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === nodeExe || p === helper);
    prepareSandboxRuntime.mockImplementation((runtimeInfo, options) => {
      expect(options).toEqual(expect.objectContaining({
        kind: "node",
        hanakoHome: "C:\\Users\\Hana\\.hanako",
      }));
      return {
        ...runtimeInfo,
        executable: cachedNode,
      };
    });

    const originalExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: nodeExe,
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("node server.js --port 3000", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "execPath", {
        value: originalExecPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--writable-root",
      "C:\\work",
      "--",
      cachedNode,
      "server.js",
      "--port",
      "3000",
    ]));
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain(cachedRoot);
    expect(helperArgs).not.toContain("C:\\Hanako\\resources\\server");
    expect(helperArgs).not.toContain(nodeExe);
  });

  it("rejects explicit Python executables outside the workspace when they are not on PATH", async () => {
    classifyWin32Command.mockReturnValue({ runner: "python", reason: "python-command" });
    const privatePython = "D:\\Secrets\\python.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === privatePython || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "python.exe") {
        return { status: 1, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    await expect(exec('"D:\\Secrets\\python.exe" tools\\make_doc.py', "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    })).rejects.toThrow("outside the workspace");

    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("keeps bash-routed commands on the bash fallback path", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    existsSync.mockImplementation((p) => p === "C:\\mock\\bash.exe");
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "bash.exe") {
        return { status: 0, stdout: "C:\\mock\\bash.exe\r\n", stderr: "" };
      }
      if (cmd === "C:\\mock\\bash.exe" && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("ls && pwd", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      "C:\\mock\\bash.exe",
      ["-c", "ls && pwd"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("prefers bundled POSIX runtime over system Git Bash when sandbox is disabled", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const systemBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === systemBash);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      if (cmd === systemBash && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    try {
      await exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: {
          PATH: "C:\\Windows\\System32",
          ProgramFiles: "C:\\Program Files",
        },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      bundledShell,
      ["-lc", "ls && pwd"],
      expect.objectContaining({
        cwd: "C:\\work",
        env: expect.objectContaining({
          PATH: expect.stringMatching(/^C:\\Hanako\\resources\\git\\bin;C:\\Hanako\\resources\\git\\usr\\bin;C:\\Hanako\\resources\\git\\mingw64\\bin;C:\\Hanako\\resources\\git\\cmd;/),
        }),
      })
    );
  });

  it("rejects CMD nul redirection before executing bash-routed commands", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    existsSync.mockImplementation((p) => p === "C:\\mock\\bash.exe");
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "bash.exe") {
        return { status: 0, stdout: "C:\\mock\\bash.exe\r\n", stderr: "" };
      }
      if (cmd === "C:\\mock\\bash.exe" && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await expect(exec("ipconfig /all > nul 2>&1", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    })).rejects.toThrow("/dev/null");

    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("routes sandbox-enabled bash commands through the restricted-token helper with write roots", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: ["C:\\outside\\reference.md"],
          optionalReadPaths: ["C:\\Users\\Hana\\.hanako\\agents\\hanako\\config.yaml"],
          writePaths: ["C:\\work"],
          optionalWritePaths: ["C:\\Users\\Hana\\.hanako\\agents\\hanako\\memory"],
        },
      },
    });

    try {
      await exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      expect.arrayContaining([
        "--cwd",
        "C:\\work",
        "--writable-root",
        "C:\\work",
        "--writable-root-optional",
        "C:\\Users\\Hana\\.hanako\\agents\\hanako\\memory",
        "--",
        bundledShell,
        "-lc",
        "ls && pwd",
      ]),
      expect.objectContaining({ cwd: "C:\\work" })
    );
    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain("C:\\outside\\reference.md");
    expect(helperArgs).not.toContain("C:\\Users\\Hana\\.hanako\\agents\\hanako\\config.yaml");
    expect(helperArgs).not.toContain("C:\\Hanako\\resources\\git");
  });

  it("keeps sandbox helper cwd separate from policy write roots", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-native-utility" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    const workspaceRoot = path.resolve("/workspace");
    existsSync.mockImplementation((p) => p === helper);
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        policy: {
          mode: "standard",
          workspaceRoots: ["/workspace"],
          writablePaths: ["/workspace", "/hana/.ephemeral"],
          protectedPaths: [],
        },
      },
    });

    await exec("echo hello", "C:\\read-only-reference", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--cwd",
      "C:\\read-only-reference",
      "--writable-root",
      workspaceRoot,
    ]));
    const writableRootIndexes = helperArgs
      .map((arg, index) => arg === "--writable-root" || arg === "--writable-root-optional" ? index + 1 : -1)
      .filter((index) => index >= 0);
    expect(writableRootIndexes.map((index) => helperArgs[index]))
      .not.toContain("C:\\read-only-reference");
  });

  it("holds a cleanup lease while sandboxed commands use writable roots", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-native-utility" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    const cleanupQueue = {
      beginRootUse: vi.fn(() => ({ id: "lease-1" })),
      endRootUse: vi.fn(),
      enqueueRoots: vi.fn(),
    };
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        legacyCleanupQueue: cleanupQueue,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
          optionalWritePaths: ["C:\\Users\\Hana\\.hanako\\.ephemeral"],
        },
      },
    });

    await exec("echo hello", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(cleanupQueue.beginRootUse).toHaveBeenCalledWith([
      "C:\\work",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
    ]);
    expect(cleanupQueue.endRootUse).toHaveBeenCalledWith({ id: "lease-1" });
    expect(cleanupQueue.enqueueRoots).toHaveBeenCalledWith([
      "C:\\work",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
    ]);
    expect(cleanupQueue.beginRootUse.mock.invocationCallOrder[0])
      .toBeLessThan(spawnAndStream.mock.invocationCallOrder[0]);
    expect(cleanupQueue.endRootUse.mock.invocationCallOrder[0])
      .toBeGreaterThan(spawnAndStream.mock.invocationCallOrder[0]);
    expect(cleanupQueue.endRootUse.mock.invocationCallOrder[0])
      .toBeLessThan(cleanupQueue.enqueueRoots.mock.invocationCallOrder[0]);
  });

  it("rewrites sandboxed Bash commands to the user-writable runtime cache", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const cachedRoot = "C:\\Users\\Hana\\.hanako\\.ephemeral\\win32-sandbox-runtime\\bash-cache";
    const cachedShell = `${cachedRoot}\\bin\\bash.exe`;
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    prepareSandboxRuntime.mockImplementation((runtimeInfo, options) => {
      expect(options).toEqual(expect.objectContaining({
        kind: "bash",
        hanakoHome: "C:\\Users\\Hana\\.hanako",
      }));
      return {
        ...runtimeInfo,
        bundledRoot: cachedRoot,
        shell: cachedShell,
      };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--writable-root",
      "C:\\work",
      "--",
      cachedShell,
      "-lc",
      "ls && pwd",
    ]));
    expect(helperArgs).not.toContain("--grant-read");
    expect(helperArgs).not.toContain("--grant-read-optional");
    expect(helperArgs).not.toContain(cachedRoot);
    expect(helperArgs).not.toContain("C:\\Hanako\\resources\\git");
    expect(helperArgs).not.toContain(bundledShell);
  });

  it("emits explicit bash sandbox diagnostics for STATUS_DLL_INIT_FAILED without rerouting default shells", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const cachedRoot = "C:\\Users\\Hana\\.hanako\\.ephemeral\\win32-sandbox-runtime\\bash-cache";
    const cachedShell = `${cachedRoot}\\bin\\bash.exe`;
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    spawnAndStream.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts.onStderr(Buffer.from(
        'hana-win-sandbox: terminal-v1 status="exited" exitCode="3221225794" timeoutMs="5000" win32Error="0"\n'
      ));
      return { exitCode: 3221225794 };
    });
    prepareSandboxRuntime.mockImplementation((runtimeInfo) => ({
      ...runtimeInfo,
      bundledRoot: cachedRoot,
      shell: cachedShell,
    }));

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const chunks = [];
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      const result = await exec("ls && pwd", "C:\\work", {
        onData: (data) => chunks.push(String(data)),
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
      expect(result.exitCode).toBe(3221225794);
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const diagnostic = chunks.join("");
    expect(diagnostic).toContain("STATUS_DLL_INIT_FAILED");
    expect(diagnostic).toContain("Executable: present=true length=");
    expect(diagnostic).toContain("Runtime root: present=true length=");
    expect(diagnostic).toContain("HANA_HOME: present=true length=");
    expect(diagnostic).not.toContain("C:\\Users\\Hana");
    expect(diagnostic).not.toContain(cachedShell);
    expect(diagnostic).not.toContain(cachedRoot);
    expect(diagnostic).toContain("Default PowerShell/cmd/terminal execution is not changed");
    expect(spawnAndStream).toHaveBeenCalledTimes(1);
  });

  it("emits STATUS_DLL_INIT_FAILED diagnostics for direct cmd without rerouting", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    spawnAndStream.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts.onData(Buffer.from("partial"));
      return { exitCode: 3221225794 };
    });
    const chunks = [];
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    const result = await exec("echo test", "C:\\work", {
      onData: (data) => chunks.push(String(data)),
      signal: undefined,
      timeout: 5,
      env: {
        PATH: "C:\\Windows\\System32;C:\\Hanako\\resources\\git\\bin",
        COMSPEC: systemCmdExe,
        SystemRoot: "C:\\Windows",
        USERPROFILE: "C:\\Users\\Hana",
      },
    });

    expect(result.exitCode).toBe(3221225794);
    const diagnostic = chunks.join("");
    expect(diagnostic).toContain("partial");
    expect(diagnostic).toContain("[win32-exec] cmd runner failed before command output");
    expect(diagnostic).toContain("Exit code: 3221225794 (0xC0000142)");
    expect(diagnostic).toContain("Route: runner=cmd reason=cmd-builtin mode=direct-cmd sandbox=false");
    expect(diagnostic).toContain("Executable: present=true length=");
    expect(diagnostic).toContain("Output bytes before failure: 7");
    expect(diagnostic).toContain("PATH System32 index: 0");
    expect(diagnostic).toContain("PATH bundled Git index: 1");
    expect(diagnostic).toContain("No fallback was attempted");
    expect(diagnostic).not.toContain("C:\\Users\\Hana");
    expect(spawnAndStream).toHaveBeenCalledTimes(1);
  });

  it("never includes command arguments, customer paths, or environment paths in DLL init diagnostics", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    spawnAndStream.mockResolvedValueOnce({ exitCode: 3221225794 });
    const secret = "CUSTOMER_SECRET_7f3b";
    const customerRoot = "D:\\Customers\\Acme Private\\Case 42";
    const command = `upload --api-key ${secret} "${customerRoot}\\records.json"`;
    const chunks = [];
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec(command, customerRoot, {
      onData: (data) => chunks.push(String(data)),
      signal: undefined,
      timeout: 5,
      env: {
        PATH: `C:\\Windows\\System32;${customerRoot}\\bin`,
        COMSPEC: `${customerRoot}\\cmd.exe`,
        SystemRoot: `${customerRoot}\\Windows`,
        TEMP: `${customerRoot}\\temp`,
        TMP: `${customerRoot}\\tmp`,
        LOCALAPPDATA: `${customerRoot}\\local`,
        APPDATA: `${customerRoot}\\roaming`,
        HANA_ROOT: `${customerRoot}\\hana`,
        HANA_SERVER_ENTRY: `${customerRoot}\\server.mjs`,
      },
    });

    const diagnostic = chunks.join("");
    expect(diagnostic).toContain("Args: count=");
    expect(diagnostic).toContain("CWD: present=true length=");
    expect(diagnostic).toContain("PATH entries: 2");
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain("--api-key");
    expect(diagnostic).not.toContain("upload");
    expect(diagnostic).not.toContain(customerRoot);
    expect(diagnostic).not.toContain("records.json");
  });

  it("emits STATUS_DLL_INIT_FAILED diagnostics for sandboxed cmd helper failures", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    spawnAndStream.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts.onStderr(Buffer.from(
        'hana-win-sandbox: terminal-v1 status="exited" exitCode="3221225794" timeoutMs="5000" win32Error="0"\n'
      ));
      return { exitCode: 3221225794 };
    });
    const chunks = [];
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    const result = await exec("echo test", "C:\\work", {
      onData: (data) => chunks.push(String(data)),
      signal: undefined,
      timeout: 5,
      env: {
        PATH: "C:\\Windows\\System32",
        COMSPEC: systemCmdExe,
        SystemRoot: "C:\\Windows",
        HANA_HOME: "C:\\Users\\Hana\\.hanako",
      },
    });

    expect(result.exitCode).toBe(3221225794);
    const diagnostic = chunks.join("");
    expect(diagnostic).toContain("Route: runner=cmd reason=cmd-builtin mode=sandbox-helper sandbox=true");
    expect(diagnostic).toContain("Helper: present=true length=");
    expect(diagnostic).toContain("HANA_HOME: present=true length=");
    expect(diagnostic).not.toContain("C:\\Users\\Hana");
    expect(spawnAndStream).toHaveBeenCalledTimes(1);
  });

  it("emits helper launch diagnostics for sandbox CreateProcessAsUserW failures", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    spawnAndStream.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts.onStderr(Buffer.from([
        "hana-win-sandbox: CreateProcessAsUserW failed: Access is denied.",
        "hana-win-sandbox: launch-failure error=\"5\" errorHex=\"0x00000005\"",
        "hana-win-sandbox: launch-failure-context executablePresent=\"true\" executableLength=\"31\" cwdPresent=\"true\" cwdLength=\"15\" argumentCount=\"4\" commandLineLength=\"38\"",
        "hana-win-sandbox: terminal-v1 status=\"launch_failed\" exitCode=\"\" timeoutMs=\"5000\" win32Error=\"5\"",
      ].join("\n")));
      return { exitCode: 1 };
    });
    const chunks = [];
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work\\project"],
        },
      },
    });

    const result = await exec("dir", "C:\\work\\project", {
      onData: (data) => chunks.push(String(data)),
      signal: undefined,
      timeout: 5,
      env: {
        PATH: "C:\\Windows\\System32",
        COMSPEC: systemCmdExe,
        SystemRoot: "C:\\Windows",
        HANA_HOME: "C:\\Users\\Hana\\.hanako",
        USERPROFILE: "C:\\Users\\Hana",
      },
    });

    expect(result.exitCode).toBe(1);
    const diagnostic = chunks.join("");
    expect(diagnostic).toContain("CreateProcessAsUserW failed");
    expect(diagnostic).toContain("[win32-exec] sandbox helper launch failed before command execution");
    expect(diagnostic).toContain("Route: runner=cmd reason=cmd-builtin mode=sandbox-helper sandbox=true");
    expect(diagnostic).toContain("Native helper reported CreateProcessAsUserW failure");
    expect(diagnostic).toContain("Helper: present=true length=");
    expect(diagnostic).not.toContain("terminal-v1");
    expect(diagnostic).not.toContain("C:\\Users\\Hana");
    expect(spawnAndStream).toHaveBeenCalledTimes(1);
  });

  it("never includes command arguments or customer paths in helper launch diagnostics", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "cmd-builtin" });
    const customerRoot = "D:\\Customers\\Private Tenant\\Incident 9";
    const helper = `${customerRoot}\\hana-win-sandbox.exe`;
    const secret = "HELPER_SECRET_c91e";
    existsSync.mockImplementation((p) => p === helper);
    spawnAndStream.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts.onStderr(Buffer.from([
        "hana-win-sandbox: CreateProcessAsUserW failed: Access is denied.",
        "hana-win-sandbox: launch-failure error=\"5\" errorHex=\"0x00000005\"",
        "hana-win-sandbox: launch-failure-context executablePresent=\"true\" executableLength=\"31\" cwdPresent=\"true\" cwdLength=\"42\" argumentCount=\"4\" commandLineLength=\"91\"",
        "hana-win-sandbox: terminal-v1 status=\"launch_failed\" exitCode=\"\" timeoutMs=\"5000\" win32Error=\"5\"",
      ].join("\n")));
      return { exitCode: 1 };
    });
    const chunks = [];
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: `${customerRoot}\\hana-home`,
        grants: { readPaths: [], writePaths: [customerRoot] },
      },
    });

    await exec(`upload --api-key ${secret} "${customerRoot}\\payload.bin"`, customerRoot, {
      onData: (data) => chunks.push(String(data)),
      signal: undefined,
      timeout: 5,
      env: {
        PATH: `C:\\Windows\\System32;${customerRoot}\\bin`,
        COMSPEC: `${customerRoot}\\cmd.exe`,
      },
    });

    const diagnostic = chunks.join("");
    expect(diagnostic).toContain("Helper: present=true length=");
    expect(diagnostic).toContain("Args: count=");
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain("--api-key");
    expect(diagnostic).not.toContain("upload");
    expect(diagnostic).not.toContain(customerRoot);
    expect(diagnostic).not.toContain("payload.bin");
  });

  it("does not leak the startup probe's own output into the caller's stream for unsupported sandboxed PowerShell", async () => {
    classifyWin32Command.mockReturnValue({ runner: "powershell", reason: "explicit-powershell-shell" });
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === helper);
    spawnAndStream.mockImplementation(async (cmd, _args, opts) => {
      opts?.onStderr?.(Buffer.from(
        'hana-win-sandbox: terminal-v1 status="exited" exitCode="1" timeoutMs="5000" win32Error="0"\n'
      ));
      return { exitCode: 1 };
    });
    const chunks = [];
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        hanakoHome: "C:\\Users\\Hana\\.hanako",
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    await expect(exec("powershell -Command Get-Location", "C:\\work", {
      onData: (data) => chunks.push(String(data)),
      signal: undefined,
      timeout: 5,
      env: {
        PATH: "C:\\Windows\\System32",
        SystemRoot: "C:\\Windows",
      },
    })).rejects.toMatchObject({ code: "HANA_WIN32_SANDBOX_POWERSHELL_UNSUPPORTED" });

    // The probe ran (and failed) but the caller's own onData never saw any
    // of the probe's internal stdio; the failed command itself never spawned.
    expect(chunks).toEqual([]);
    expect(spawnAndStream).toHaveBeenCalledTimes(1);
  });

  it("does not pass network capability flags for restricted-token sandboxed commands", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
        getSandboxNetworkEnabled: () => true,
      },
    });

    try {
      await exec("curl https://example.com", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).toEqual(expect.arrayContaining([
      "--",
      bundledShell,
      "-lc",
      "curl https://example.com",
    ]));
    expect(helperArgs).not.toContain("--network");
    expect(spawnAndStream).toHaveBeenCalledWith(
      helper,
      helperArgs,
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("keeps network unrestricted by default without helper network flags", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await exec("curl https://example.com", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(helperArgs).not.toContain("--network");
  });

  it("rejects sandboxed commands when Windows sandbox networking is explicitly disabled", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
        getSandboxNetworkEnabled: () => false,
      },
    });

    try {
      await expect(exec("curl https://example.com", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      })).rejects.toThrow("does not support network-off mode");
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("rejects sandboxed commands when Windows sandbox networking mode is none", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
        getSandboxNetworkMode: () => "none",
        getSandboxNetworkEnabled: () => true,
      },
    });

    try {
      await expect(exec("curl https://example.com", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      })).rejects.toThrow("does not support network-off mode");
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).not.toHaveBeenCalled();
  });

  it("does not call obsolete external read path projection for restricted-token grants", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const bundledShell = "C:\\Hanako\\resources\\git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    const getExternalReadPaths = vi.fn(() => ["C:\\outside\\secret.txt"]);
    existsSync.mockImplementation((p) => p === bundledShell || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === bundledShell && args?.[0] === "-lc") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        policy: {
          mode: "workspace-write",
          workspace: "C:\\work",
          workspaceRoots: ["C:\\work"],
          writablePaths: ["C:\\Users\\Hana\\.hanako\\.ephemeral"],
        },
        getExternalReadPaths,
      },
    });

    try {
      await exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: { PATH: "C:\\Windows\\System32" },
      });
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    const helperArgs = spawnAndStream.mock.calls[0][1];
    expect(getExternalReadPaths).not.toHaveBeenCalled();
    expect(helperArgs).not.toContain("C:\\outside\\secret.txt");
    expect(helperArgs).not.toContain("--grant-read");
  });

  it("does not fall back to system Git Bash for sandboxed POSIX commands", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    const systemBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const helper = "C:\\Hanako\\resources\\sandbox\\windows\\hana-win-sandbox.exe";
    existsSync.mockImplementation((p) => p === systemBash || p === helper);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === systemBash && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", {
      value: "C:\\Hanako\\resources",
      configurable: true,
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec({
      sandbox: {
        helperPath: helper,
        grants: {
          readPaths: [],
          writePaths: ["C:\\work"],
        },
      },
    });

    try {
      await expect(exec("ls && pwd", "C:\\work", {
        onData: () => {},
        signal: undefined,
        timeout: 5,
        env: {
          PATH: "C:\\Windows\\System32",
          ProgramFiles: "C:\\Program Files",
        },
      })).rejects.toThrow("Sandboxed POSIX commands require bundled");
    } finally {
      Object.defineProperty(process, "resourcesPath", {
        value: originalResourcesPath,
        configurable: true,
      });
    }

    expect(spawnAndStream).not.toHaveBeenCalled();
  });
});

describe("isShellSpawnError", () => {
  const shellPath = "C:\\Git\\bin\\bash.exe";

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    existsSync.mockReturnValue(false);
    mkdirSync.mockImplementation(() => undefined);
    statSync.mockImplementation(() => ({ isDirectory: () => true }));
    spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });
  });

  async function loadTesting() {
    const mod = await import("../lib/sandbox/win32-exec.ts");
    return mod.__testing as any;
  }

  it("treats ENOENT pointing at the shell as a shell failure when cwd exists", async () => {
    existsSync.mockImplementation((p: any) => p === "C:\\work");
    const { isShellSpawnError } = await loadTesting();
    const err = Object.assign(new Error("spawn bash.exe ENOENT"), { code: "ENOENT", path: shellPath });
    expect(isShellSpawnError(err, shellPath, "C:\\work")).toBe(true);
  });

  it("does NOT treat ENOENT as a shell failure when the cwd is missing", async () => {
    existsSync.mockReturnValue(false);
    const { isShellSpawnError } = await loadTesting();
    const err = Object.assign(new Error("spawn bash.exe ENOENT"), { code: "ENOENT", path: shellPath });
    expect(isShellSpawnError(err, shellPath, "C:\\gone")).toBe(false);
  });

  it("rejects ENOENT whose err.path points elsewhere", async () => {
    existsSync.mockReturnValue(true);
    const { isShellSpawnError } = await loadTesting();
    const err = Object.assign(new Error("spawn other.exe ENOENT"), { code: "ENOENT", path: "C:\\other.exe" });
    expect(isShellSpawnError(err, shellPath, "C:\\work")).toBe(false);
  });

  it("treats EACCES as a shell failure regardless of cwd", async () => {
    existsSync.mockReturnValue(false);
    const { isShellSpawnError } = await loadTesting();
    const err = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    expect(isShellSpawnError(err, shellPath, "C:\\gone")).toBe(true);
  });
});
