import { spawnSync as defaultSpawnSync } from "node:child_process";
import defaultFs from "node:fs";
import path from "node:path";

function envValue(env, name) {
  const match = Object.entries(env || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1] ? String(match[1]) : "";
}

export function createRestrictedTokenSmokeRuntimeEnv({
  workDir,
  hanaHome,
  helperPath,
  layoutRoot,
  env = process.env,
} = {}) {
  if (!workDir) throw new Error("workDir is required");
  if (!hanaHome) throw new Error("hanaHome is required");
  if (!helperPath) throw new Error("helperPath is required");
  if (!layoutRoot) throw new Error("layoutRoot is required");

  const systemRoot = envValue(env, "SystemRoot") || envValue(env, "WINDIR") || "C:\\Windows";
  const runtimeEnvRoot = path.win32.join(workDir, ".ephemeral", "win32-sandbox-env");
  const tempDir = path.win32.join(runtimeEnvRoot, "Temp");
  const localAppDataDir = path.win32.join(runtimeEnvRoot, "LocalAppData");
  const appDataDir = path.win32.join(runtimeEnvRoot, "AppData", "Roaming");
  const profileDir = path.win32.join(workDir, "Profile");
  const smokeEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: envValue(env, "ComSpec") || path.win32.join(systemRoot, "System32", "cmd.exe"),
    PATHEXT: envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD",
    Path: path.win32.join(systemRoot, "System32"),
    TEMP: tempDir,
    TMP: tempDir,
    LOCALAPPDATA: localAppDataDir,
    APPDATA: appDataDir,
    USERPROFILE: profileDir,
    HOME: profileDir,
    HANA_HOME: hanaHome,
    HANA_ROOT: path.win32.join(layoutRoot, "server"),
    HANA_SERVER_ENTRY: path.win32.join(layoutRoot, "server", "bundle", "index.js"),
    HANA_WIN32_SANDBOX_HELPER: helperPath,
    HANA_WIN32_SANDBOX_DEBUG: "1",
  };

  for (const key of [
    "SystemDrive",
    "USERNAME",
    "USERDOMAIN",
    "USERDOMAIN_ROAMINGPROFILE",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "OS",
    "COMPUTERNAME",
    "PUBLIC",
    "ProgramData",
  ]) {
    const value = envValue(env, key);
    if (value) smokeEnv[key] = value;
  }

  return {
    env: smokeEnv,
    runtimeDirs: [tempDir, localAppDataDir, appDataDir, profileDir],
  };
}

export function restrictedTokenSmokeSpec({
  layoutRoot,
  workDir,
  hanaHome,
  helperPath = path.win32.join(layoutRoot, "sandbox", "windows", "hana-win-sandbox.exe"),
  env = process.env,
} = {}) {
  const { env: smokeEnv, runtimeDirs } = createRestrictedTokenSmokeRuntimeEnv({
    workDir,
    hanaHome,
    helperPath,
    layoutRoot,
    env,
  });
  const markerFileName = "hana-restricted-token-smoke.txt";
  const blockedDirName = "blocked";
  const deniedFileName = "hana-deny-write-smoke.txt";
  const shellCommand =
    `echo HANA_RESTRICTED_TOKEN_OK>${markerFileName}`
    + ` && type ${markerFileName}`
    + ` && (echo SHOULD_NOT_WRITE>${blockedDirName}\\${deniedFileName})`
    + " && exit 73"
    + " || echo HANA_DENY_WRITE_OK";
  return {
    helperPath,
    markerPath: path.win32.join(workDir, markerFileName),
    blockedDir: path.win32.join(workDir, blockedDirName),
    deniedMarkerPath: path.win32.join(workDir, blockedDirName, deniedFileName),
    runtimeDirs,
    env: smokeEnv,
    args: [
      "--cwd", workDir,
      "--writable-root", workDir,
      "--deny-write", path.win32.join(workDir, blockedDirName),
      "--timeout-ms", "30000",
      "--",
      smokeEnv.ComSpec,
      "/d", "/s", "/c",
      shellCommand,
    ],
  };
}

export function restrictedTokenSmokeSpawnOptions({ cwd, env, timeout }) {
  return {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  };
}

export function runRestrictedTokenHelperSmoke({
  layoutRoot,
  workDir,
  hanaHome,
  helperPath,
  env = process.env,
  spawnSyncImpl = defaultSpawnSync,
  fs = defaultFs,
} = {}) {
  const spec = restrictedTokenSmokeSpec({ layoutRoot, workDir, hanaHome, helperPath, env });
  fs.mkdirSync(spec.blockedDir, { recursive: true });
  for (const dir of spec.runtimeDirs || []) fs.mkdirSync(dir, { recursive: true });
  const result = spawnSyncImpl(
    spec.helperPath,
    spec.args,
    restrictedTokenSmokeSpawnOptions({ cwd: workDir, env: spec.env, timeout: 45_000 }),
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      "[windows-sandbox] restricted-token smoke failed"
        + ` (status=${String(result.status)}, signal=${String(result.signal)})`
        + (result.error ? `: ${result.error.message}` : "")
        + (result.stderr ? `\nstderr: ${result.stderr.trim()}` : ""),
    );
  }
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  if (!stdout.includes("HANA_RESTRICTED_TOKEN_OK")) throw new Error("[windows-sandbox] writable marker missing");
  if (!stdout.includes("HANA_DENY_WRITE_OK")) throw new Error("[windows-sandbox] deny-write marker missing");
  const terminalRecord = 'hana-win-sandbox: terminal-v1 status="exited" exitCode="0" timeoutMs="30000" win32Error="0"';
  if (!stderr.includes(terminalRecord)) throw new Error(`[windows-sandbox] successful terminal record missing\nstderr: ${stderr.trim()}`);
  if (fs.readFileSync(spec.markerPath, "utf8").trim() !== "HANA_RESTRICTED_TOKEN_OK") {
    throw new Error("[windows-sandbox] writable-root marker mismatch");
  }
  if (fs.existsSync(spec.deniedMarkerPath)) throw new Error("[windows-sandbox] deny-write path was modified");
  return spec;
}
