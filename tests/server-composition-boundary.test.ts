/**
 * Behavior lock — server composition boundary (route seam refactor).
 *
 * `server/index.ts` used to import all ~43 route factories directly and
 * mount them inline. It now statically imports
 * `server/composition/open-root.ts` (open) and accepts an optional
 * `root.registerClosedRoutes` hook (supplied by `server/main-full.ts` via
 * `server/composition/full-root.ts`, closed-product) instead. This file
 * locks the three properties the refactor must not change:
 *
 * 1. The exact set of mounted route factories (and their mount prefix) is
 *    unchanged — a pure "moved code between files" refactor, not a route
 *    behavior change.
 * 2. A real spawned full composition (`server/main-full.ts`) still serves
 *    both open-root and full-root routes behind the same global auth
 *    middleware, proven with real HTTP requests — not static assertions.
 * 3. `server/index.ts` alone boots nothing on mere import — only
 *    `server/main-full.ts` (or another composition entry that calls
 *    `startServer()`) does. This is the "no silent non-start" contract.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";

const root = process.cwd();

// ---------------------------------------------------------------------------
// Part 1 — sorted mount-call inventory snapshot.
//
// Golden list captured from server/index.ts *before* the composition
// split (43 `app.route(prefix, headExpression)` call sites, sorted), plus
// route factories added since. Every
// entry is `${prefix} :: ${firstIdentifierOfSecondArg}` — enough to prove
// "same factory mounted at the same prefix", independent of exactly how
// many lines its (unchanged) argument object spans or which file now
// contains the call.
// ---------------------------------------------------------------------------

const PRE_REFACTOR_MOUNT_CALLS = Object.freeze([
  '"" :: chatWsRoute',
  '"" :: createHtmlPreviewRoute',
  '"" :: createMobileStaticRoute',
  '"/api" :: chatRestRoute',
  '"/api" :: createAccessRoute',
  '"/api" :: createAgentsRoute',
  '"/api" :: createAuthRoute',
  '"/api" :: createAvatarRoute',
  '"/api" :: createBridgeRoute',
  '"/api" :: createCardsRoute',
  '"/api" :: createChannelsRoute',
  '"/api" :: createCharacterCardsRoute',
  '"/api" :: createCheckpointsRoute',
  '"/api" :: createCommandsRoute',
  '"/api" :: createConfigRoute',
  '"/api" :: createConfirmRoute',
  '"/api" :: createDeskRoute',
  '"/api" :: createDevicesRoute',
  '"/api" :: createDiaryRoute',
  '"/api" :: createDmRoute',
  '"/api" :: createExperimentsRoute',
  // 工作区文件历史的查询与还原面（挂载点 open-root，与 resource-io 同域）
  '"/api" :: createFileHistoryRoute',
  '"/api" :: createFsRoute',
  '"/api" :: createInputDraftsRoute',
  // Added after the split: the MCP surface used to reach the app through the
  // generic plugin route proxy, so it had no factory of its own here.
  '"/api" :: createMcpRoute',
  '"/api" :: createMemoryDreamRoute',
  '"/api" :: createMobileWorkbenchRoute',
  '"/api" :: createModelsRoute',
  '"/api" :: createPluginsRoute',
  '"/api" :: createPreferencesRoute',
  '"/api" :: createProvidersRoute',
  '"/api" :: createResourceIoRoute',
  '"/api" :: createResourcesRoute',
  '"/api" :: createServerIdentityRoute',
  '"/api" :: createSessionCollabRoute',
  '"/api" :: createSessionProjectsRoute',
  '"/api" :: createSessionsRoute',
  '"/api" :: createSettingsSnapshotRoute',
  '"/api" :: createSkillsRoute',
  '"/api" :: createSpeechRecognitionRoute',
  '"/api" :: createStudioWorkspacesRoute',
  '"/api" :: createUploadRoute',
  '"/api" :: createUsageRoute',
  '"/api" :: createWebAuthRoute',
  '"/api" :: createWebSocketAuthRoute',
]);

/** Extracts `app.route(prefix, headIdentifier` call-site pairs from one file. */
function extractMountCalls(filePath: string): string[] {
  const src = fs.readFileSync(filePath, "utf-8");
  const re = /app\.route\(\s*("(?:[^"]*)")\s*,\s*([A-Za-z0-9_]+)/g;
  const pairs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) pairs.push(`${m[1]} :: ${m[2]}`);
  return pairs;
}

describe("composition boundary behavior lock: sorted mount-call inventory", () => {
  it("server/index.ts + composition/open-root.ts + composition/full-root.ts together mount exactly the expected route factories, at the same prefixes, as the pre-refactor server/index.ts", () => {
    const combined = [
      ...extractMountCalls(path.join(root, "server", "index.ts")),
      ...extractMountCalls(path.join(root, "server", "composition", "open-root.ts")),
      ...extractMountCalls(path.join(root, "server", "composition", "full-root.ts")),
    ].sort();

    expect(combined).toEqual([...PRE_REFACTOR_MOUNT_CALLS]);
  });

  it("mobile-workbench (evidence-needed) is mounted directly by server/index.ts itself, not absorbed into open-root.ts or full-root.ts", () => {
    const indexPairs = extractMountCalls(path.join(root, "server", "index.ts"));
    const openRootPairs = extractMountCalls(path.join(root, "server", "composition", "open-root.ts"));

    expect(indexPairs).toContain('"/api" :: createMobileWorkbenchRoute');
    expect(openRootPairs).not.toContain('"/api" :: createMobileWorkbenchRoute');
  });

  it("server/index.ts imports composition/open-root.ts unconditionally and imports no closed-product route file directly", () => {
    const indexSource = fs.readFileSync(path.join(root, "server", "index.ts"), "utf-8");

    expect(indexSource).toContain('import { registerOpenRoutes } from "./composition/open-root.ts";');
    for (const p2 of ["avatar", "cards", "character-cards", "desk", "diary"]) {
      expect(indexSource).not.toContain(`from "./routes/${p2}.ts"`);
    }
    expect(indexSource).not.toContain("composition/full-root.ts");
    expect(indexSource).not.toContain("main-full.ts");
  });
});

describe("composition boundary behavior lock: full bootstrap", () => {
  it("main-full.ts only forwards closed routes into startServer", () => {
    const mainFullSource = fs.readFileSync(path.join(root, "server", "main-full.ts"), "utf-8");

    expect(mainFullSource).toContain('from "./composition/full-root.ts"');
    expect(mainFullSource).toMatch(/startServer\(\{\s*registerClosedRoutes\s*\}\)/);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — bootstrap contract: importing server/index.ts alone must not
// start anything; only server/main-full.ts (or an equivalent caller of
// startServer()) does.
// ---------------------------------------------------------------------------

describe("composition boundary behavior lock: bootstrap contract (no silent non-start)", () => {
  it("importing server/index.ts alone defines startServer but starts nothing (no port bind, no server-info.json, clean exit)", async () => {
    const hanaHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-index-only-import-"));
    try {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", 'import("./server/index.ts").then((m) => { process.stdout.write(`exports: ${Object.keys(m).sort().join(",")}\\n`); process.exit(0); })'],
        {
          cwd: root,
          env: { ...process.env, HANA_HOME: hanaHome },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const result: any = await new Promise((resolve) => {
        const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve({ timeout: true }); }, 15000);
        child.once("close", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
      });

      expect(result.timeout).not.toBe(true);
      expect(result).toMatchObject({ code: 0, signal: null });
      // 除了 startServer 本身，还导出 resolveSessionMetadataRecoveryStatusForHealth
      // ——/api/health 的 sessionStore 兜底逻辑单测直接覆盖它，不需要真的拉起服务器。
      expect(stdout).toContain("exports: resolveSessionMetadataRecoveryStatusForHealth,startServer");
      // No engine/store side effects: no server-info.json written, no
      // agents/user directory seeded by ensureFirstRun.
      expect(fs.existsSync(path.join(hanaHome, "server-info.json"))).toBe(false);
      expect(fs.existsSync(path.join(hanaHome, "agents"))).toBe(false);
      expect(stderr).not.toContain("ensureFirstRun");
    } finally {
      // The timeout/assertion-failure paths reach here right after a SIGKILL,
      // so this rm needs the same Windows handle-latency tolerance as Part 3.
      fs.rmSync(hanaHome, TEMP_HOME_RM_OPTIONS);
    }
  }, 20000);
});

// ---------------------------------------------------------------------------
// Part 3 — real request smoke against a real spawned full composition
// (server/main-full.ts), including the global auth middleware. Proves the
// open-root and full-root routes are both live and both still
// gated by the same auth check, end to end — not by static source
// inspection.
// ---------------------------------------------------------------------------

// Windows cleanup contract for tests that SIGKILL a spawned server: kill() is
// TerminateProcess and returns before the process dies, and the dying process
// (plus antivirus/search-indexer scans) can briefly hold handles inside the
// temp HANA_HOME without FILE_SHARE_DELETE. Removing the directory therefore
// has to happen after the real exit event, with retries for transient
// EPERM/EBUSY — otherwise cleanup itself fails the test on Windows CI.
const TEMP_HOME_RM_OPTIONS = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 } as const;

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function waitForServerInfo(serverInfoPath: string, child: ReturnType<typeof spawn>, timeoutMs = 60000): Promise<any> {
  return new Promise((resolve, reject) => {
    let exited = false;
    let exitInfo: any = null;
    child.once("exit", (code, signal) => { exited = true; exitInfo = { code, signal }; });
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (exited) {
        reject(new Error(`server exited before writing server-info.json: ${JSON.stringify(exitInfo)}`));
        return;
      }
      try {
        const raw = fs.readFileSync(serverInfoPath, "utf-8");
        resolve(JSON.parse(raw));
        return;
      } catch {
        // not written yet
      }
      if (Date.now() > deadline) {
        reject(new Error("timed out waiting for server-info.json"));
        return;
      }
      setTimeout(poll, 200);
    };
    poll();
  });
}

describe("composition boundary behavior lock: real request smoke against the full composition (server/main-full.ts)", () => {
  it("serves an open-root route and a full-root (closed-product) route behind the same global auth middleware", async () => {
    const hanaHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-composition-smoke-"));
    const serverInfoPath = path.join(hanaHome, "server-info.json");
    const child = spawn(process.execPath, ["server/bootstrap.ts"], {
      cwd: root,
      env: {
        ...process.env,
        HANA_HOME: hanaHome,
        HANA_PORT: "0",
        HANA_ROOT: root,
        HANA_SERVER_ENTRY: path.join(root, "server", "main-full.ts"),
        HANA_CREATE_STARTUP_SESSION: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    try {
      const info = await waitForServerInfo(serverInfoPath, child);
      const base = `http://127.0.0.1:${info.port}`;
      const authHeaders = { Authorization: `Bearer ${info.token}` };

      // Public-shaped route (/api/health) still requires the loopback
      // token (route-security.ts classifies it AUTHENTICATED_ONLY, not
      // public) — proves the global middleware still runs before it.
      const healthNoAuth = await fetch(`${base}/api/health`);
      expect(healthNoAuth.status).toBe(403);

      const healthAuth = await fetch(`${base}/api/health`, { headers: authHeaders });
      expect(healthAuth.status).toBe(200);
      const healthBody = await healthAuth.json();
      expect(healthBody.status).toBe("ok");

      // Open route mounted via composition/open-root.ts (createAgentsRoute).
      const agentsNoAuth = await fetch(`${base}/api/agents`);
      expect(agentsNoAuth.status).toBe(403);
      const agentsAuth = await fetch(`${base}/api/agents`, { headers: authHeaders });
      expect(agentsAuth.status).toBe(200);
      const agentsBody = await agentsAuth.json();
      expect(Array.isArray(agentsBody.agents)).toBe(true);

      // Closed-product route mounted via composition/full-root.ts (createDiaryRoute) —
      // only reachable at all because server/main-full.ts supplied
      // registerClosedRoutes to startServer().
      const diaryNoAuth = await fetch(`${base}/api/diary/list`);
      expect(diaryNoAuth.status).toBe(403);
      const diaryAuth = await fetch(`${base}/api/diary/list`, { headers: authHeaders });
      expect(diaryAuth.status).toBe(200);
      const diaryBody = await diaryAuth.json();
      expect(Array.isArray(diaryBody.files)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await waitForExit(child);
      fs.rmSync(hanaHome, TEMP_HOME_RM_OPTIONS);
      if (process.env.HANA_TEST_DEBUG) process.stderr.write(stderr);
    }
  }, 60000);
});
