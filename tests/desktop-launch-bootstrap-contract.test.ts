import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
const bootstrapPath = path.join(root, "desktop", "bootstrap.cjs");

describe("desktop launch bootstrap contract", () => {
  it("routes dev and packaged Electron through the pre-main bootstrap", () => {
    expect(packageJson.main).toBe("desktop/bootstrap.cjs");
    expect(packageJson.build).toBeUndefined();
  });

  it("registers diagnostics before loading the full desktop main", () => {
    expect(fs.existsSync(bootstrapPath)).toBe(true);
    if (!fs.existsSync(bootstrapPath)) return;

    const source = fs.readFileSync(bootstrapPath, "utf-8");
    const uncaughtIndex = source.indexOf("uncaughtException");
    const rejectionIndex = source.indexOf("unhandledRejection");
    const markerIndex = source.indexOf("writeLaunchMarker");
    const loadIndex = source.indexOf("loadDesktopMain");

    expect(uncaughtIndex).toBeGreaterThan(-1);
    expect(rejectionIndex).toBeGreaterThan(-1);
    expect(markerIndex).toBeGreaterThan(-1);
    expect(loadIndex).toBeGreaterThan(-1);
    expect(uncaughtIndex).toBeLessThan(loadIndex);
    expect(rejectionIndex).toBeLessThan(loadIndex);
    expect(markerIndex).toBeLessThan(loadIndex);
    expect(source).toContain("main.bundle.cjs");
    expect(source).toContain("main.cjs");
  });

  it("enables Windows system CAs before loading Electron or the full desktop main", () => {
    const source = fs.readFileSync(bootstrapPath, "utf-8");
    const enableIndex = source.indexOf("enableWindowsSystemCaForCurrentProcess();");
    const electronIndex = source.indexOf('require("electron")');
    const mainIndex = source.indexOf("loadDesktopMain();");

    expect(enableIndex).toBeGreaterThan(-1);
    expect(electronIndex).toBeGreaterThan(enableIndex);
    expect(mainIndex).toBeGreaterThan(enableIndex);
  });
});
