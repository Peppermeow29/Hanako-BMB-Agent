import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const MAIN_PATH = path.join(process.cwd(), "desktop", "main.cjs");

describe("desktop main GPU startup contract", () => {
  it("applies GPU startup policy before Electron ready", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    const applyIndex = source.indexOf("applyGpuStartupPolicy(app, gpuStartupPolicy");
    const pendingIndex = source.indexOf("markGpuStartupPending({");
    const readyIndex = source.indexOf("app.whenReady()");

    expect(applyIndex).toBeGreaterThan(-1);
    expect(pendingIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeGreaterThan(-1);
    expect(applyIndex).toBeLessThan(readyIndex);
    expect(pendingIndex).toBeLessThan(readyIndex);
  });

  it("records the active GPU policy in the pending startup marker", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const pendingIndex = source.indexOf("markGpuStartupPending({");
    const pendingCall = source.slice(pendingIndex, source.indexOf("});", pendingIndex) + 3);

    expect(pendingIndex).toBeGreaterThan(-1);
    expect(pendingCall).toContain("policy: gpuStartupPolicy");
  });

  it("records splash phases before server phases through the shared startup marker", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const splashReadyIndex = source.indexOf('phase: "splash-ready"');
    const serverStartingIndex = source.indexOf('phase: "server-starting"');
    const serverReadyIndex = source.indexOf('phase: "server-ready"');

    expect(splashReadyIndex).toBeGreaterThan(-1);
    expect(serverStartingIndex).toBeGreaterThan(-1);
    expect(serverReadyIndex).toBeGreaterThan(-1);
    expect(splashReadyIndex).toBeLessThan(serverStartingIndex);
    expect(serverStartingIndex).toBeLessThan(serverReadyIndex);

    for (const phaseIndex of [splashReadyIndex, serverStartingIndex, serverReadyIndex]) {
      const callStart = source.lastIndexOf("markGpuStartupPhase({", phaseIndex);
      const phaseCall = source.slice(callStart, source.indexOf("});", phaseIndex) + 3);

      expect(callStart).toBeGreaterThan(-1);
      expect(phaseCall).toContain("startupId: desktopStartupId");
    }
  });

  it("settles legacy GPU preference cleanup only after the local server is ready", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const startupBlockIndex = source.indexOf('console.log("[desktop] 启动 HanaAgent Server...")');
    const serverStartIndex = source.indexOf("await startServer();", startupBlockIndex);
    const settleIndex = source.indexOf("await settleLegacyGpuPreferenceAfterServerStart();", serverStartIndex);
    const serverReadyIndex = source.indexOf('phase: "server-ready"', settleIndex);

    expect(startupBlockIndex).toBeGreaterThan(-1);
    expect(serverStartIndex).toBeGreaterThan(startupBlockIndex);
    expect(settleIndex).toBeGreaterThan(serverStartIndex);
    expect(serverReadyIndex).toBeGreaterThan(settleIndex);
  });

  it("records Windows window-starting phases before BrowserWindow creation can fail", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const mainStartingIndex = source.indexOf('phase: "main-window-starting"');
    const mainCreateIndex = source.indexOf("createMainWindow();");
    const mainCreatedIndex = source.indexOf('phase: "main-window-created"');
    const onboardingStartingIndex = source.indexOf('phase: "onboarding-window-starting"');
    const onboardingCreateIndex = source.indexOf('createOnboardingWindow({ skipToTutorial: "1" });');
    const onboardingCreatedIndex = source.indexOf('phase: "onboarding-window-created"');

    expect(mainStartingIndex).toBeGreaterThan(-1);
    expect(mainCreateIndex).toBeGreaterThan(-1);
    expect(mainCreatedIndex).toBeGreaterThan(-1);
    expect(mainStartingIndex).toBeLessThan(mainCreateIndex);
    expect(mainCreateIndex).toBeLessThan(mainCreatedIndex);
    expect(onboardingStartingIndex).toBeGreaterThan(-1);
    expect(onboardingCreateIndex).toBeGreaterThan(-1);
    expect(onboardingCreatedIndex).toBeGreaterThan(-1);
    expect(onboardingStartingIndex).toBeLessThan(onboardingCreateIndex);
    expect(onboardingCreateIndex).toBeLessThan(onboardingCreatedIndex);
  });

  it("creates the main BrowserWindow through the Windows diagnostic wrapper", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const helperIndex = source.indexOf("function createBrowserWindowWithDiagnostics");
    const mainCreateIndex = source.indexOf('createBrowserWindowWithDiagnostics("main", opts, { windowsMinimalRetry: true })');
    const directCreateIndex = source.indexOf("mainWindow = new BrowserWindow(opts)");

    expect(helperIndex).toBeGreaterThan(-1);
    expect(mainCreateIndex).toBeGreaterThan(helperIndex);
    expect(directCreateIndex).toBe(-1);
  });

  it("listens for GPU child process exits instead of deprecated GPU crash hooks", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).toContain('app.on("child-process-gone"');
    expect(source).not.toContain("gpu-process-crashed");
  });

  it("does not bake unsafe GPU recovery switches into startup", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).not.toContain("disable-software-rasterizer");
    expect(source).not.toContain("disable-gpu-sandbox");
    expect(source).not.toContain("no-sandbox");
  });

  it("runs the install ACL heal before resolving the GPU startup policy", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const requireIndex = source.indexOf('require("./src/shared/win32-install-acl-heal.cjs")');
    const healIndex = source.indexOf("maybeHealWin32InstallAcl({");
    const resolveIndex = source.indexOf("const gpuStartupPolicy = resolveGpuStartupPolicy({");

    expect(requireIndex).toBeGreaterThan(-1);
    expect(healIndex).toBeGreaterThan(-1);
    expect(resolveIndex).toBeGreaterThan(-1);
    expect(healIndex).toBeLessThan(resolveIndex);

    const healCall = source.slice(healIndex, source.indexOf("});", healIndex) + 3);
    expect(healCall).toContain("installDir: path.dirname(process.execPath)");
    expect(healCall).toContain("isPackaged: app.isPackaged");
  });

  it("appends install ACL heal diagnostics next to the GPU startup diagnostics", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const gpuDiagIndex = source.indexOf("items.push(buildGpuStartupDiagnostics({ hanakoHome, policy: gpuStartupPolicy, app }));");
    const healDiagIndex = source.indexOf("items.push(buildInstallAclHealDiagnostics({ hanakoHome }));");

    expect(gpuDiagIndex).toBeGreaterThan(-1);
    expect(healDiagIndex).toBeGreaterThan(gpuDiagIndex);
  });
});
