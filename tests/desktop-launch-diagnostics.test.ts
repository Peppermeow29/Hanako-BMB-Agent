import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = process.cwd();

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
}

describe("desktop launch diagnostics", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("writes redacted startup events to a stable desktop-launch log path", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-launch-diagnostics-"));
    const mod = await import("../desktop/src/shared/desktop-launch-diagnostics.cjs");
    const { createDesktopLaunchDiagnostics } = mod.default || mod;
    let tick = 0;
    const diagnostics = createDesktopLaunchDiagnostics({
      hanakoHome: tmpDir,
      startupId: "startup-1",
      appVersion: "1.2.3",
      platform: "win32",
      arch: "x64",
      now: () => `2026-05-28T00:00:0${tick++}.000Z`,
      redactText: (value) => String(value).replaceAll("secret-value", "<redacted>"),
    });

    diagnostics.reset({ argv: ["hana", "secret-value"] });
    diagnostics.append("console-message", {
      message: "token=secret-value",
      nested: { path: "secret-value" },
    });

    expect(diagnostics.rendererLogPath).toBe(path.join(tmpDir, "diagnostics", "desktop-launch", "renderer.log"));
    const lines = fs.readFileSync(diagnostics.rendererLogPath, "utf-8").trim().split("\n").map(JSON.parse as any);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      event: "desktop-launch-start",
      startupId: "startup-1",
      appVersion: "1.2.3",
      platform: "win32",
      arch: "x64",
      details: { argv: ["hana", "<redacted>"] },
    });
    expect(lines[1]).toMatchObject({
      event: "console-message",
      details: {
        message: "token=<redacted>",
        nested: { path: "<redacted>" },
      },
    });
  });

  it("keeps main-process window lifecycle coverage for blank-launch diagnostics", () => {
    const source = readSource("desktop/main.cjs");

    for (const required of [
      "createDesktopLaunchDiagnostics",
      "attachRendererLaunchDiagnostics",
      "desktop-launch-diagnostics.cjs",
      '"window-created"',
      '"dom-ready"',
      '"did-finish-load"',
      '"did-fail-load"',
      '"render-process-gone"',
      '"console-message"',
      '"app-ready-timeout"',
      '"app-ready"',
      '"desktop-launch-failed"',
    ]) {
      expect(source).toContain(required);
    }

    for (const label of [
      'attachRendererLaunchDiagnostics(splashWindow, "splash")',
      'attachRendererLaunchDiagnostics(mainWindow, "main")',
      'attachRendererLaunchDiagnostics(onboardingWindow, "onboarding")',
      'attachRendererLaunchDiagnostics(settingsWindow, "settings")',
    ]) {
      expect(source).toContain(label);
    }
  });

  it("marks renderer bootstrap phases in console for persisted main-process capture", () => {
    const main = readSource("desktop/src/main.tsx");
    const app = readSource("desktop/src/react/App.tsx");
    const init = readSource("desktop/src/react/app-init.ts");

    expect(main).toContain("renderer-entry");
    expect(main).toContain("securitypolicyviolation");
    expect(main).toContain("root-mount-start");
    expect(main).toContain("root-mounted");
    expect(main).toContain("react-root-missing");
    expect(app).toContain("init-start");
    expect(app).toContain("init-finished");
    expect(app).toContain("init-failed");
    expect(init).toContain("markRendererLaunch('app-ready'");
  });
});
