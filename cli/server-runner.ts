import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { readLocalServerInfo, resolveCliHanaHome } from "./local-server.ts";
import { describeForeignServerBlock, isForeignServerBlocking, probeServerInfo } from "../shared/server-info-probe.cjs";
import { ansi } from "./terminal-theme.ts";

export async function resolveServerSpawnSpec({
  projectRoot,
  env = process.env,
  extraArgs = [],
}: { projectRoot?: string; env?: NodeJS.ProcessEnv; extraArgs?: string[] } = {}) {
  const root = projectRoot || path.resolve(import.meta.dirname, "..");
  const explicitRoot = env.HANA_ROOT && fs.existsSync(path.join(env.HANA_ROOT, "bootstrap.js"))
    ? env.HANA_ROOT
    : null;
  const packagedRoot = explicitRoot || (
    fs.existsSync(path.join(root, "bootstrap.js"))
    && fs.existsSync(path.join(root, "bundle", "index.js"))
      ? root
      : null
  );

  if (packagedRoot) {
    const spawnEnv: NodeJS.ProcessEnv = {
      ...env,
      HANA_ROOT: packagedRoot,
      HANA_SERVER_ENTRY: path.join(packagedRoot, "bundle", "index.js"),
    };
    return {
      mode: "packaged",
      command: process.execPath,
      args: [path.join(packagedRoot, "bootstrap.js"), ...extraArgs],
      env: spawnEnv,
    };
  }

  const spawnEnv: NodeJS.ProcessEnv = { ...env };
  return {
    mode: "source",
    command: process.execPath,
    // server/main-full.ts is the thin closed composition entry: it
    // statically imports server/index.ts's startServer() plus
    // server/composition/full-root.ts's registerClosedRoutes hook and
    // calls one with the other. server/index.ts itself only exports
    // startServer and is not a spawnable entry on its own anymore.
    args: [path.join(root, "server", "main-full.ts"), ...extraArgs],
    env: spawnEnv,
  };
}

/**
 * Pre-spawn check for the "同宅互斥" gate's CLI-side entry point. Reads
 * whatever server-info.json is on disk for `hanaHome` (regardless of
 * whether its recorded PID looks alive — `probeImpl` is the actual source
 * of truth, not the PID) and probes it with the shared token-authenticated
 * probe. Returns a structured decision instead of printing/exiting itself
 * so this is directly unit-testable without spawning a real process; the
 * one real caller (`spawnServerForeground`) does the printing/exit.
 *
 * This is a friendlier, earlier check than the one server/index.ts itself
 * performs at startup — server/index.ts's own gate is still the real
 * backstop (e.g. for `--url` bypassing the CLI's auto-start path
 * entirely), this one just gives the CLI user a clean message before it
 * even spawns a child process.
 */
export async function guardAgainstForeignServer({
  hanaHome,
  probeImpl = probeServerInfo,
}: { hanaHome: string; probeImpl?: typeof probeServerInfo }): Promise<{ blocked: boolean; message: string | null }> {
  const local = readLocalServerInfo({ hanaHome, checkProcess: false });
  if (!local.ok) return { blocked: false, message: null };
  const probe = await probeImpl({ info: local.info });
  if (!isForeignServerBlocking(probe.status)) return { blocked: false, message: null };
  return { blocked: true, message: describeForeignServerBlock({ status: probe.status, info: local.info }) };
}

/**
 * Builds the env object `hana serve` spawns its server child with, applying
 * the `--allow-data-downgrade` override (threaded to the child as
 * `HANA_ALLOW_DATA_DOWNGRADE=1`, which server/index.ts's data-epoch gate
 * reads) and printing the accompanying warning. Pure aside from the `warn`
 * side channel, which is injectable so this is testable without capturing
 * real stdout.
 */
export function buildServeSpawnEnv({
  env,
  allowDataDowngrade,
  warn = (msg: string) => console.warn(msg),
}: { env: NodeJS.ProcessEnv; allowDataDowngrade: boolean; warn?: (msg: string) => void }): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = { ...env };
  if (allowDataDowngrade) {
    spawnEnv.HANA_ALLOW_DATA_DOWNGRADE = "1";
    warn(
      `${ansi.yellow}--allow-data-downgrade: 已显式接受数据损坏风险，旧内核将放行打开被更高数据 epoch 触碰过的目录。\n`
      + `--allow-data-downgrade: explicitly accepting the data-corruption risk — this older kernel will be `
      + `allowed to open a data directory a higher data epoch has touched.${ansi.reset}`
    );
  }
  return spawnEnv;
}

export async function spawnServerForeground({
  projectRoot,
  extraArgs = [],
  env = process.env,
  allowDataDowngrade = false,
  probeImpl = probeServerInfo,
  exit = process.exit,
}: {
  projectRoot?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  allowDataDowngrade?: boolean;
  probeImpl?: typeof probeServerInfo;
  exit?: (code?: number) => any;
} = {}) {
  const guard = await guardAgainstForeignServer({ hanaHome: resolveCliHanaHome(env), probeImpl });
  if (guard.blocked) {
    console.error(`${ansi.red}${guard.message}${ansi.reset}`);
    return exit(1);
  }

  const spawnEnv = buildServeSpawnEnv({ env, allowDataDowngrade });
  const spec = await resolveServerSpawnSpec({ projectRoot, env: spawnEnv, extraArgs });
  const child = spawn(spec.command, spec.args, {
    stdio: "inherit",
    env: spec.env,
  });
  child.on("exit", (code) => process.exit(code ?? 1));
  return child;
}

export async function startLocalServerAndWait({
  projectRoot,
  env = process.env,
  timeoutMs = 30000,
  intervalMs = 250,
}: { projectRoot?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; intervalMs?: number } = {}) {
  const hanaHome = resolveCliHanaHome(env);
  const existing = readLocalServerInfo({ hanaHome });
  if (existing.ok) return existing;

  const spec = await resolveServerSpawnSpec({ projectRoot, env, extraArgs: [] });
  const child = spawn(spec.command, spec.args, {
    stdio: "ignore",
    detached: true,
    env: spec.env,
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const info = readLocalServerInfo({ hanaHome });
    if (info.ok) return { ...info, started: true, serverMode: spec.mode };
    await delay(intervalMs);
  }

  throw new Error(`HanaAgent Server did not become ready within ${Math.round(timeoutMs / 1000)}s`);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
