import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import vm from "vm";
import { readDataEpochStamp, writeDataEpochStamp } from "../shared/data-epoch.cjs";
import { DATA_EPOCH } from "../shared/contract-versions.cjs";
import { createDataEpochCheckpointProvider } from "../core/data-epoch-checkpoint-provider.ts";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import type { StoreDescriptor } from "../shared/persistence/store-registry-types.ts";

// Mirrors tests/data-epoch-restore.test.ts's own testStore helper (not
// imported — that file does not export it, and this suite must not modify
// it to do so).
function testStore(overrides: Partial<StoreDescriptor> & { id: string; pathPatterns: string[] }): StoreDescriptor {
  return {
    ...PERSISTENT_STORES[0],
    ...overrides,
    pathPattern: overrides.pathPatterns[0],
    siteRules: overrides.siteRules ?? [],
  };
}

const root = process.cwd();

describe("server startup diagnostics contract", () => {
  it("enables Windows system CA trust in the independent server child environment", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const enableIndex = mainSource.indexOf("serverEnv = withWindowsSystemCaEnv(serverEnv);");
    const spawnIndex = mainSource.indexOf("serverProcess = spawn(launcherBin, launcherArgs", enableIndex);

    expect(mainSource).toContain('require("./src/shared/windows-system-ca.cjs")');
    expect(enableIndex).toBeGreaterThan(-1);
    expect(spawnIndex).toBeGreaterThan(enableIndex);
  });

  it("records child process identity when server startup times out without output", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toContain("Server PID:");
    expect(mainSource).toContain("Server command:");
    expect(mainSource).toContain("Server args:");
    expect(mainSource).toContain("Server child alive:");
  });

  it("keeps process diagnostics even when bootstrap already wrote output", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toContain("function buildServerCrashDiagnostics(");
    expect(mainSource).toContain("const diagnostics = buildServerCrashDiagnostics();");
    expect(mainSource).not.toContain("if (!logs) {\n    // production 时 server");
  });

  it("routes shutdown through the Windows guardian or POSIX signals without raw Windows PID killing", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toContain("SERVER_SHUTDOWN_GRACE_MS");
    expect(mainSource).toContain("waitForProcessExit(");
    expect(mainSource).toContain("requestWindowsServerGuardianStop(proc)");
    expect(mainSource).toContain("signalPidOnPosix(pid, true)");
    expect(mainSource).not.toContain("function killPid(");
    expect(mainSource).not.toContain("taskkill");
    expect(mainSource).not.toContain("setTimeout(done, 3000)");
  });

  it("launches Windows servers under the packaged native Job guardian", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toContain('require("./src/shared/windows-server-guardian.cjs")');
    expect(mainSource).toContain("resolveWindowsServerGuardian({");
    expect(mainSource).toContain("buildWindowsServerGuardianArgs({");
    expect(mainSource).toContain("parentPid: process.pid");
    expect(mainSource).toContain("launcherDetached = false");
    expect(mainSource).toContain("serverProcess = spawn(launcherBin, launcherArgs");
  });

  it("passes validated desktop resources and the resolved guardian to the server before spawn", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const resourcesIndex = mainSource.indexOf("serverEnv.HANA_DESKTOP_RESOURCES_PATH = process.resourcesPath;");
    const guardianIndex = mainSource.indexOf("const guardianBin = resolveWindowsServerGuardian({");
    const helperContractIndex = mainSource.indexOf("serverEnv.HANA_WIN32_SANDBOX_HELPER = guardianBin;", guardianIndex);
    const spawnIndex = mainSource.indexOf("serverProcess = spawn(launcherBin, launcherArgs", guardianIndex);

    expect(resourcesIndex).toBeGreaterThan(-1);
    expect(guardianIndex).toBeGreaterThan(resourcesIndex);
    expect(helperContractIndex).toBeGreaterThan(guardianIndex);
    expect(spawnIndex).toBeGreaterThan(helperContractIndex);
  });

  it("owned Windows shutdown uses token-auth grace then the guardian control pipe", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const shutdown = extractFunctionSource(mainSource, "shutdownServer");

    expect(shutdown).toContain('if (process.platform === "win32") {\n      await requestServerShutdown(serverPort, serverToken);');
    expect(shutdown).toContain("requestWindowsServerGuardianStop(proc);");
    expect(shutdown.indexOf("requestServerShutdown(serverPort, serverToken)")).toBeLessThan(
      shutdown.indexOf("requestWindowsServerGuardianStop(proc)"),
    );
  });

  it("owned POSIX shutdown uses TERM grace then KILL", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const shutdown = extractFunctionSource(mainSource, "shutdownServer");

    expect(shutdown).toContain('try { proc.kill("SIGTERM"); } catch {}');
    expect(shutdown).toContain("signalPidOnPosix(pid, true);");
  });

  it("reused Windows shutdown is token-auth only and never falls through to raw PID termination", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const shutdown = extractFunctionSource(mainSource, "shutdownServer");

    expect(shutdown).toContain("const shutdownRequested = await requestServerShutdown(serverPort, serverToken, 2000);");
    expect(shutdown).toContain('if (!shutdownRequested && process.platform !== "win32")');
    expect(shutdown).toContain('if (!exited && process.platform !== "win32")');
    expect(shutdown).toContain("不按裸 PID 终止");
  });

  it("reused POSIX shutdown can signal only after the authenticated request path", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const shutdown = extractFunctionSource(mainSource, "shutdownServer");
    const requestIndex = shutdown.indexOf("const shutdownRequested = await requestServerShutdown");
    const termIndex = shutdown.indexOf("signalPidOnPosix(pid);", requestIndex);
    const killIndex = shutdown.indexOf("signalPidOnPosix(pid, true);", termIndex);

    expect(requestIndex).toBeGreaterThan(-1);
    expect(termIndex).toBeGreaterThan(requestIndex);
    expect(killIndex).toBeGreaterThan(termIndex);
  });

  it("retains an unconfirmed owned guardian across repeated shutdown attempts", async () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const shutdown = extractFunctionSource(mainSource, "shutdownServer");
    const ownedProc = { pid: 4321, exitCode: null, signalCode: null };
    let controlStops = 0;
    const context = vm.createContext({
      ownedProc,
      process: { platform: "win32" },
      console: { log() {}, warn() {} },
      hasChildExitObserved: () => false,
      requestServerShutdown: async () => false,
      waitForProcessExit: async () => false,
      _intentionalServerStops: new WeakSet(),
      isWindowsServerGuardianShutdownConfirmed: (child: { exitCode: number | null }, exited: boolean) => exited && child.exitCode !== 125,
      requestWindowsServerGuardianStop: () => { controlStops++; return true; },
      signalPidOnPosix: () => { throw new Error("unexpected POSIX signal"); },
      SERVER_SHUTDOWN_GRACE_MS: 1,
      SERVER_FORCE_KILL_WAIT_MS: 1,
      fs: { unlinkSync() {} },
      path: { join: () => "server-info.json" },
      hanakoHome: "C:\\hana",
    });
    vm.runInContext(`
      let serverProcess = ownedProc;
      let reusedServerPid = null;
      let reusedServerOwned = false;
      let serverPort = 14500;
      let serverToken = "token";
      ${shutdown}
      function shutdownState() { return { serverProcess, reusedServerPid, reusedServerOwned }; }
    `, context);

    await expect(context.shutdownServer()).resolves.toMatchObject({ confirmed: false });
    expect(context.shutdownState().serverProcess).toBe(ownedProc);
    await expect(context.shutdownServer()).resolves.toMatchObject({ confirmed: false });
    expect(context.shutdownState().serverProcess).toBe(ownedProc);
    expect(controlStops).toBe(2);
  });

  it("retains an unconfirmed reused server across repeated shutdown attempts", async () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const shutdown = extractFunctionSource(mainSource, "shutdownServer");
    const context = vm.createContext({
      process: { platform: "win32" },
      console: { log() {}, warn() {} },
      hasChildExitObserved: () => false,
      requestServerShutdown: async () => false,
      waitForProcessExit: async () => false,
      _intentionalServerStops: new WeakSet(),
      isWindowsServerGuardianShutdownConfirmed: (child: { exitCode: number | null }, exited: boolean) => exited && child.exitCode !== 125,
      requestWindowsServerGuardianStop: () => { throw new Error("no guardian handle for reused server"); },
      signalPidOnPosix: () => { throw new Error("unexpected POSIX signal"); },
      SERVER_SHUTDOWN_GRACE_MS: 1,
      SERVER_FORCE_KILL_WAIT_MS: 1,
      fs: { unlinkSync() {} },
      path: { join: () => "server-info.json" },
      hanakoHome: "C:\\hana",
    });
    vm.runInContext(`
      let serverProcess = null;
      let reusedServerPid = 9876;
      let reusedServerOwned = true;
      let serverPort = 14500;
      let serverToken = "token";
      ${shutdown}
      function shutdownState() { return { serverProcess, reusedServerPid, reusedServerOwned }; }
    `, context);

    await expect(context.shutdownServer()).resolves.toMatchObject({ confirmed: false });
    expect(context.shutdownState().reusedServerPid).toBe(9876);
    await expect(context.shutdownServer()).resolves.toMatchObject({ confirmed: false });
    expect(context.shutdownState()).toMatchObject({ reusedServerPid: 9876, reusedServerOwned: true });
  });

  it("retains a guardian that exited with native convergence failure 125", async () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const shutdown = extractFunctionSource(mainSource, "shutdownServer");
    const failedGuardian = { pid: 4321, exitCode: 125, signalCode: null };
    const context = vm.createContext({
      failedGuardian,
      process: { platform: "win32" },
      console: { log() {}, warn() {} },
      hasChildExitObserved: (child: { exitCode: number | null }) => child.exitCode !== null,
      isWindowsServerGuardianShutdownConfirmed: (child: { exitCode: number | null }, exited: boolean) => exited && child.exitCode !== 125,
      _intentionalServerStops: new WeakSet(),
      requestServerShutdown: async () => false,
      waitForProcessExit: async () => true,
      requestWindowsServerGuardianStop: () => true,
      signalPidOnPosix: () => false,
      SERVER_SHUTDOWN_GRACE_MS: 1,
      SERVER_FORCE_KILL_WAIT_MS: 1,
      fs: { unlinkSync() {} },
      path: { join: () => "server-info.json" },
      hanakoHome: "C:\\hana",
    });
    vm.runInContext(`
      let serverProcess = failedGuardian;
      let reusedServerPid = null;
      let reusedServerOwned = false;
      let serverPort = 14500;
      let serverToken = "token";
      ${shutdown}
      function shutdownState() { return { serverProcess }; }
    `, context);

    await expect(context.shutdownServer()).resolves.toMatchObject({
      confirmed: false,
      reason: "Windows server guardian reported Job convergence failure",
    });
    expect(context.shutdownState().serverProcess).toBe(failedGuardian);
    await expect(context.shutdownServer()).resolves.toMatchObject({ confirmed: false });
  });

  it("suppresses a late intentional guardian exit after transient update flags reset", async () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const monitor = extractFunctionSource(mainSource, "monitorServer");
    let exitListener: ((code: number, signal: string | null) => Promise<void>) | null = null;
    let restartCalls = 0;
    const child = {
      on(event: string, listener: (code: number, signal: string | null) => Promise<void>) {
        if (event === "exit") exitListener = listener;
      },
    };
    const intentionalStops = new WeakSet<object>([child]);
    const context = vm.createContext({
      child,
      intentionalStops,
      console: { log() {}, error() {} },
      startServer: async () => { restartCalls++; },
    });
    vm.runInContext(`
      let serverProcess = child;
      const _intentionalServerStops = intentionalStops;
      let isQuitting = false;
      let _isUpdating = false;
      let isExitingServer = false;
      let _isApplyingTrainUpdate = false;
      let _serverRestartAttempts = 0;
      let mainWindow = null;
      let settingsWindow = null;
      function writeCrashLog() {}
      const dialog = { showErrorBox() {} };
      function mt() { return ""; }
      ${monitor}
      monitorServer();
    `, context);

    expect(exitListener).not.toBeNull();
    await exitListener!(125, null);
    expect(restartCalls).toBe(0);
  });

  it("uses the full graceful window for an authenticated stale Windows desktop server", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const startServer = extractFunctionSource(mainSource, "startServer");

    expect(startServer).toContain('process.platform === "win32" && isDesktopOwnedServerInfo(existingInfo)');
    expect(startServer).toContain("? SERVER_SHUTDOWN_GRACE_MS");
    expect(startServer).toContain(": STALE_SERVER_EXIT_GRACE_MS");
    expect(startServer).toContain("waitForProcessExit(null, existingInfo.pid, authenticatedShutdownGraceMs)");
  });

  it("bounds before-quit to one shutdown attempt before allowing Electron exit", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const runningIndex = mainSource.indexOf('_beforeQuitServerShutdownState = "running"');
    const shutdownIndex = mainSource.indexOf("await shutdownServer();", runningIndex);
    const completeIndex = mainSource.indexOf('_beforeQuitServerShutdownState = "complete"', shutdownIndex);
    const quitIndex = mainSource.indexOf("app.quit();", completeIndex);

    expect(mainSource).toContain("resolveBeforeQuitServerAction({");
    expect(mainSource).toContain('if (quitAction === "wait") return;');
    expect(runningIndex).toBeGreaterThan(-1);
    expect(shutdownIndex).toBeGreaterThan(runningIndex);
    expect(completeIndex).toBeGreaterThan(shutdownIndex);
    expect(quitIndex).toBeGreaterThan(completeIndex);
  });

  it("does not treat PID-only reused server shutdown as already exited", async () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const hasChildExitObserved = extractFunctionSource(mainSource, "hasChildExitObserved");
    const waitForProcessExit = extractFunctionSource(mainSource, "waitForProcessExit");
    let alive = true;
    let checks = 0;
    const context = vm.createContext({
      SERVER_SHUTDOWN_POLL_MS: 5,
      isPidAliveForDiagnostics: () => {
        checks++;
        return alive;
      },
      setTimeout,
      Promise,
    });

    vm.runInContext(`${hasChildExitObserved}\n${waitForProcessExit}`, context);
    // Keep the wait window far above a few poll ticks so a delayed setTimeout
    // under load cannot race past the deadline before the mid-wait assertion.
    const wait = context.waitForProcessExit(null, 12345, 500);
    let settled = false;
    wait.then(() => { settled = true; });

    const deadline = Date.now() + 200;
    while (checks === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(checks).toBeGreaterThan(0);
    expect(settled).toBe(false);

    alive = false;
    await expect(wait).resolves.toBe(true);
  });

  it("waits for the owned child exit event instead of losing guardian exit code to a PID probe", async () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const hasChildExitObserved = extractFunctionSource(mainSource, "hasChildExitObserved");
    const waitForProcessExit = extractFunctionSource(mainSource, "waitForProcessExit");
    let pidChecks = 0;
    const proc = {
      exitCode: null,
      signalCode: null,
      once() {},
      removeListener() {},
    };
    const context = vm.createContext({
      SERVER_SHUTDOWN_POLL_MS: 1,
      isPidAliveForDiagnostics: () => { pidChecks++; return false; },
      setTimeout,
      Promise,
    });

    vm.runInContext(`${hasChildExitObserved}\n${waitForProcessExit}`, context);
    await expect(context.waitForProcessExit(proc, 4321, 5)).resolves.toBe(false);
    expect(pidChecks).toBe(0);
  });

  it("keeps server-info when shutdown cannot confirm the server is gone", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toContain("let removeServerInfo = true");
    expect(mainSource).toContain("removeServerInfo = false");
    expect(mainSource).toContain("if (removeServerInfo)");
  });

  it("resolves packaged bootstrap default root to the bootstrap directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bootstrap-"));
    const serverRoot = path.join(tmp, "resources", "server");
    try {
      fs.mkdirSync(path.join(serverRoot, "bundle"), { recursive: true });
      fs.copyFileSync(path.join(root, "server", "bootstrap.ts"), path.join(serverRoot, "bootstrap.js"));
      fs.writeFileSync(path.join(serverRoot, "package.json"), JSON.stringify({ type: "module" }));
      fs.writeFileSync(
        path.join(serverRoot, "bundle", "index.js"),
        "process.stdout.write('[fixture] bundle imported\\n');\n",
      );

      const env = { ...process.env };
      delete env.HANA_ROOT;
      delete env.HANA_SERVER_ENTRY;
      const result = spawnSync(process.execPath, [path.join(serverRoot, "bootstrap.js")], {
        env,
        encoding: "utf-8",
      });

      expect(result.status).toBe(0);
      const realServerRoot = fs.realpathSync(serverRoot);
      expect(result.stdout).toContain(`[server-bootstrap] root=${realServerRoot}`);
      expect(result.stdout).toContain(path.join(realServerRoot, "bundle", "index.js"));
      expect(result.stdout).toContain("[fixture] bundle imported");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("lets desktop skip startup session creation so server readiness is not blocked by chat session warmup", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const serverSource = fs.readFileSync(path.join(root, "server", "index.ts"), "utf-8");

    expect(mainSource).toContain("HANA_CREATE_STARTUP_SESSION");
    expect(mainSource).toContain('"0"');
    expect(serverSource).toContain('process.env.HANA_CREATE_STARTUP_SESSION !== "0"');
    expect(serverSource).toContain("③ 跳过启动期 session 创建");
  });

  it("keeps waiting after the first server-info deadline while startup output is still progressing", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toContain("shouldKeepWaitingForServerInfo");
    expect(mainSource).toContain("_lastServerProgressAtMs");
    expect(mainSource).toContain("getLastProgressAtMs");
    expect(mainSource).not.toContain('timeout = 60000');
  });

  it("keeps bridge platform dependencies out of the server readiness path", () => {
    const serverSource = fs.readFileSync(path.join(root, "server", "index.ts"), "utf-8");
    const bridgeRouteSource = fs.readFileSync(path.join(root, "server", "routes", "bridge.ts"), "utf-8");

    expect(serverSource).not.toMatch(/^import\s+\{\s*BridgeManager\s*\}\s+from\s+["']\.\.\/lib\/bridge\/bridge-manager\.js["'];/m);
    expect(serverSource).toContain('await import("../lib/bridge/bridge-manager.ts")');

    const readyWriteIndex = serverSource.indexOf("fs.writeFileSync(serverInfoPath");
    const bridgeDeferIndex = serverSource.indexOf("setImmediate(() => {");
    const bridgeStartIndex = serverSource.indexOf("startBridgeManager({ autoStart: true })");
    const startupTryEndIndex = serverSource.indexOf("\n  } catch (err)", bridgeStartIndex);
    expect(readyWriteIndex).toBeGreaterThan(-1);
    expect(bridgeDeferIndex).toBeGreaterThan(-1);
    expect(bridgeStartIndex).toBeGreaterThan(-1);
    expect(startupTryEndIndex).toBeGreaterThan(bridgeStartIndex);
    expect(readyWriteIndex).toBeLessThan(bridgeDeferIndex);
    expect(bridgeDeferIndex).toBeLessThan(bridgeStartIndex);
    expect(serverSource).toMatch(/setImmediate\(\(\) => \{\s*void startBridgeManager\(\{ autoStart: true \}\);\s*\}\);/s);
    expect(serverSource.slice(bridgeDeferIndex, startupTryEndIndex)).not.toMatch(/\bawait\b/);

    expect(bridgeRouteSource).not.toContain('import { getWechatQrcode, pollWechatQrcodeStatus } from "../../lib/bridge/wechat-login.ts";');
    expect(bridgeRouteSource).toContain('await import("../../lib/bridge/wechat-login.ts")');
    expect(bridgeRouteSource).toContain("resolveBridgeManager");
  });

  it("reuses only trusted server-info after token health and server identity checks", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const serverSource = fs.readFileSync(path.join(root, "server", "index.ts"), "utf-8");

    expect(mainSource).toContain("verifyReusableServerInfo");
    expect(mainSource).toContain("/api/health");
    expect(mainSource).toContain("/api/server/identity");
    expect(mainSource).toContain("Authorization: `Bearer ${existingInfo.token}`");
    expect(mainSource).toContain("identity.studioId");
    expect(mainSource).toContain("readDesiredServerNetworkConfig");
    expect(mainSource).toContain("describeReusableServerNetworkMismatch");
    expect(mainSource).toContain("terminate: isDesktopOwnedServerInfo(existingInfo)");
    expect(serverSource).toContain("configuredPort: serverRuntimeState.configuredPort");
    expect(serverSource).toContain("network: createServerRuntimeNetworkSummary()");
  });

  it("does not terminate standalone servers that desktop only attached to", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const serverSource = fs.readFileSync(path.join(root, "server", "index.ts"), "utf-8");

    expect(serverSource).toContain('ownerKind: process.env.HANA_SERVER_OWNER === "desktop" ? "desktop" : "standalone"');
    expect(mainSource).toContain('HANA_SERVER_OWNER: "desktop"');
    expect(mainSource).toContain("HANA_SERVER_OWNER_PID: String(process.pid)");
    expect(mainSource).toContain("let reusedServerOwned = false");
    expect(mainSource).toContain("reusedServerOwned = isDesktopOwnedServerInfo(existingInfo)");
    expect(mainSource).toContain("if (!reusedServerOwned)");
    expect(mainSource).toContain("shutdownServer: detached from external server");
    expect(mainSource).toContain("removeServerInfo = false");
    expect(mainSource).toContain("|| (reusedServerPid && reusedServerOwned)");
  });

  it("surfaces structured port conflicts instead of burying them under GPU diagnostics", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toContain("parsePortInUseStartupError");
    expect(mainSource).toContain("extractRootServerStartupError");
    expect(mainSource).toContain("buildLaunchFailureDialogDetail");
    expect(mainSource).toContain('err?.code === "STALE_SERVER_UNCLEANED" ? err.message : null');
    // FOREIGN_SERVER_RUNNING (同宅互斥闸的桌面预判) joins STALE_SERVER_UNCLEANED
    // as a structured error surfaced ahead of raw log-scraping — see
    // tests/desktop-foreign-server-guard.test.ts for its own dedicated coverage.
    expect(mainSource).toContain('err?.code === "FOREIGN_SERVER_RUNNING" ? err.message : null');
    expect(mainSource).toContain("const rootServerError = structuredPortConflict || staleServerError || foreignServerError || extractRootServerStartupError(_serverLogs)");
    expect(mainSource).toContain("tail.trimStart().startsWith(rootServerError)");
    expect(mainSource).not.toContain("tail.includes(rootServerError)");
    expect(mainSource).toContain("return `${rootServerError}\\n\\n${tail}`");
  });

  it("keeps native SQLite out of the server static import graph", () => {
    const factStoreSource = fs.readFileSync(path.join(root, "lib", "memory", "fact-store.ts"), "utf-8");
    const agentSource = fs.readFileSync(path.join(root, "core", "agent.ts"), "utf-8");

    expect(factStoreSource).not.toMatch(/^import\s+.*better-sqlite3/m);
    expect(factStoreSource).toContain("loadBetterSqliteDatabase");
    expect(agentSource).toContain("[agent] 4. FactStore...");
    expect(agentSource.indexOf("[agent] 4. FactStore...")).toBeLessThan(
      agentSource.indexOf("new FactStore("),
    );
  });
});

describe("desktop launch failure dialog: data-epoch dedicated branches (C7 E4)", () => {
  function buildDataEpochDialogContext(homeDir: string) {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const detectDataEpochLaunchMarker = extractFunctionSource(mainSource, "detectDataEpochLaunchMarker");
    const countAvailableDataEpochCheckpoints = extractFunctionSource(mainSource, "countAvailableDataEpochCheckpoints");
    const buildDataEpochBlockedDetail = extractFunctionSource(mainSource, "buildDataEpochBlockedDetail");
    const buildDataEpochTransitionIncompleteDetail = extractFunctionSource(mainSource, "buildDataEpochTransitionIncompleteDetail");
    const formatPortInUseStartupError = extractFunctionSource(mainSource, "formatPortInUseStartupError");
    const buildLaunchFailureDialogDetail = extractFunctionSource(mainSource, "buildLaunchFailureDialogDetail");

    const context = vm.createContext({
      fs,
      path,
      hanakoHome: homeDir,
      readDataEpochStamp,
      DATA_EPOCH,
      _serverLogs: [] as string[],
      extractRootServerStartupError: (_logs: string[]) => null,
      console,
    });
    vm.runInContext(
      [
        detectDataEpochLaunchMarker,
        countAvailableDataEpochCheckpoints,
        buildDataEpochBlockedDetail,
        buildDataEpochTransitionIncompleteDetail,
        formatPortInUseStartupError,
        buildLaunchFailureDialogDetail,
      ].join("\n\n"),
      context,
    );
    return context;
  }

  function makeHomeDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "hana-desktop-epoch-dialog-"));
  }

  it("recognizes the HANA_DATA_EPOCH_BLOCKED marker and ignores unrelated crash text", () => {
    const context = buildDataEpochDialogContext(makeHomeDir());
    expect(context.detectDataEpochLaunchMarker("[stderr] HANA_DATA_EPOCH_BLOCKED reason=epoch-downgrade-blocked\n")).toMatchObject({
      kind: "blocked",
      reason: "epoch-downgrade-blocked",
    });
    expect(context.detectDataEpochLaunchMarker("[stderr] HANA_DATA_EPOCH_TRANSITION_INCOMPLETE reason=incomplete-transition\n")).toMatchObject({
      kind: "incomplete",
      reason: "incomplete-transition",
    });
    expect(context.detectDataEpochLaunchMarker("Error: Cannot find module 'foo'\n")).toBeNull();
    expect(context.detectDataEpochLaunchMarker("")).toBeNull();
  });

  it("renders a bilingual BLOCKED detail with own/stamped epoch, last version, and checkpoint availability read only through shared/data-epoch.cjs", async () => {
    const homeDir = makeHomeDir();
    try {
      await writeDataEpochStamp(homeDir, { minimumReaderEpoch: 5, committedDataEpoch: 5, lastVersion: "9.9.9" });
      const context = buildDataEpochDialogContext(homeDir);

      const crashInfo = `=== HanaAgent Crash Log ===\n--- Server Output ---\n[stderr] HANA_DATA_EPOCH_BLOCKED reason=epoch-downgrade-blocked\n[stderr] [data-epoch] 数据安全闸拒绝启动\n`;
      const detail = context.buildLaunchFailureDialogDetail({ code: undefined, message: "" }, crashInfo);

      expect(detail).toContain("数据已被更新的版本使用");
      expect(detail).toContain("Your data was upgraded by a newer version");
      expect(detail).toContain(`本安装能理解的数据纪元：${DATA_EPOCH}`);
      expect(detail).toContain("数据当前纪元：5");
      expect(detail).toContain("最后写入数据的版本：9.9.9");
      expect(detail).toContain("可用恢复点：无");
      expect(detail).toContain("Recovery point available: None found");
      expect(detail).toContain("安装更新版本");
      expect(detail).toContain("恢复工具");
      // Full stderr tail is still appended for diagnosability, same pattern
      // as the STALE_SERVER_UNCLEANED / FOREIGN_SERVER_RUNNING branches.
      expect(detail).toContain("HANA_DATA_EPOCH_BLOCKED reason=epoch-downgrade-blocked");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("shows 未知/unknown for BLOCKED fields when the stamp cannot be read, instead of guessing", () => {
    const homeDir = makeHomeDir();
    try {
      const context = buildDataEpochDialogContext(homeDir); // no stamp written: status "missing"
      const crashInfo = "HANA_DATA_EPOCH_BLOCKED reason=epoch-downgrade-blocked\n";
      const detail = context.buildLaunchFailureDialogDetail({}, crashInfo);

      expect(detail).toContain("数据当前纪元：未知/unknown");
      expect(detail).toContain("最后写入数据的版本：未知/unknown");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("counts an available checkpoint into the BLOCKED detail and never re-verifies its bytes/hashes", async () => {
    const homeDir = makeHomeDir();
    try {
      await writeDataEpochStamp(homeDir, { minimumReaderEpoch: 2, committedDataEpoch: 2, lastVersion: "2.0.0" });
      const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
      fs.mkdirSync(path.join(homeDir, "user"), { recursive: true });
      fs.writeFileSync(path.join(homeDir, "user", "preferences.json"), JSON.stringify({ locale: "zh" }));
      const provider = createDataEpochCheckpointProvider({ stores: [store] });
      await provider.create({ homeDir, fromEpoch: 1, toEpoch: 2, transitionId: "t-dialog", affectedStoreIds: [store.id] });
      // A stray .tmp-* staging sibling must not be counted.
      fs.mkdirSync(path.join(homeDir, "data-epoch-checkpoints", "t-dialog.tmp-999"), { recursive: true });

      const context = buildDataEpochDialogContext(homeDir);
      const detail = context.buildLaunchFailureDialogDetail({}, "HANA_DATA_EPOCH_BLOCKED reason=epoch-downgrade-blocked\n");

      expect(detail).toContain("可用恢复点：有，共 1 个");
      expect(detail).toContain("Recovery point available: Available, 1 found");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("renders a generic bilingual TRANSITION_INCOMPLETE detail without epoch/version fields", () => {
    const context = buildDataEpochDialogContext(makeHomeDir());
    const detail = context.buildLaunchFailureDialogDetail({}, "HANA_DATA_EPOCH_TRANSITION_INCOMPLETE reason=incomplete-transition\n");

    expect(detail).toContain("数据迁移未完成");
    expect(detail).toContain("A data migration did not finish");
    expect(detail).toContain("打开最新版本以继续或恢复".slice(0, 4)); // 打开最新
    expect(detail).toMatch(/install the latest version/i);
  });

  it("leaves STALE_SERVER_UNCLEANED / FOREIGN_SERVER_RUNNING / plain-crash behavior unchanged when no data-epoch marker is present", () => {
    const context = buildDataEpochDialogContext(makeHomeDir());

    const staleErr = { code: "STALE_SERVER_UNCLEANED", message: "STALE_SERVER_UNCLEANED: residual server still running" };
    const staleDetail = context.buildLaunchFailureDialogDetail(staleErr, "some crash text\n");
    expect(staleDetail).toContain("STALE_SERVER_UNCLEANED: residual server still running");
    expect(staleDetail).not.toContain("数据已被更新的版本使用");
    expect(staleDetail).not.toContain("数据迁移未完成");

    const plainDetail = context.buildLaunchFailureDialogDetail({}, "plain crash text with no markers\n");
    expect(plainDetail).toBe("plain crash text with no markers\n");
  });
});

// crash.log 的版本头是热更新后唯一能分辨"崩的是哪份代码"的地方，而
// desktop/main.cjs 既不在 eslint 覆盖面（全局 ignores 含 **/*.cjs）也不在
// tsconfig include 内，这两行没有其它自动化保护，只能由本组契约测试盯住。
describe("desktop crash log version header", () => {
  function runWriteCrashLog(getCurrentContentVersion: () => string) {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const writeCrashLog = extractFunctionSource(mainSource, "writeCrashLog");
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desktop-crash-log-"));
    try {
      const context = vm.createContext({
        fs,
        path,
        process,
        console: { error() {} },
        // 壳版本刻意取一个明显早于内容版本的值：两行若被改回同源，断言立刻红。
        app: { getVersion: () => "0.421.24" },
        hanakoHome: homeDir,
        getCurrentContentVersion,
        _serverLogs: ["[stderr] boom\n"],
        buildServerCrashDiagnostics: () => "--- Diagnostics ---",
        redactMainLogText: (text: string) => text,
      });
      const returned = vm.runInContext(`${writeCrashLog}\nwriteCrashLog("simulated crash");`, context) as string;
      const onDisk = fs.readFileSync(path.join(homeDir, "crash.log"), "utf-8");
      return { returned, onDisk, header: onDisk.split("\n").slice(0, 3) };
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }

  it("writes the shell identity and the hot-updated content version as two separate lines", () => {
    const { returned, onDisk, header } = runWriteCrashLog(() => "0.442.0");

    expect(header).toEqual([
      "=== HanaAgent Crash Log ===",
      "HanaAgent shell: v0.421.24",
      "Content: v0.442.0",
    ]);
    // 单行时代的旧格式不得复活：只报壳版本会把新内容里的崩溃标成老版本。
    expect(onDisk).not.toMatch(/^HanaAgent: v/m);
    expect(returned).toBe(onDisk);
  });

  it("falls back to unknown for the content line without borrowing the shell version", () => {
    const { header } = runWriteCrashLog(() => {
      throw new Error("content version accessor unavailable");
    });

    expect(header[1]).toBe("HanaAgent shell: v0.421.24");
    expect(header[2]).toBe("Content: vunknown");
  });
});

function extractFunctionSource(source: string, name: string) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const plainStart = source.indexOf(`function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : plainStart;
  if (start < 0) throw new Error(`missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  if (bodyStart < 0) throw new Error(`missing body for function ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}
