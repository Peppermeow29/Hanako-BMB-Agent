import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.ts";
import { runBestEffortStartupMigrationStep } from "../core/engine.ts";

const tempDirs: string[] = [];

function makeDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-prefs-resilience-"));
  tempDirs.push(root);
  return {
    root,
    userDir: path.join(root, "user"),
    agentsDir: path.join(root, "agents"),
    prefsPath: path.join(root, "user", "preferences.json"),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("PreferencesManager migration resilience", () => {
  it("does not overwrite unreadable preferences during constructor maintenance", () => {
    const dirs = makeDirs();
    fs.mkdirSync(dirs.userDir, { recursive: true });
    const corrupt = "{ this is not valid json\n";
    fs.writeFileSync(dirs.prefsPath, corrupt, "utf-8");

    const prefs = new PreferencesManager(dirs);

    expect(prefs.getPreferences()).toEqual({});
    expect(fs.readFileSync(dirs.prefsPath, "utf-8")).toBe(corrupt);
    expect(fs.readdirSync(dirs.userDir).filter((name) => name.includes(".corrupt-"))).toEqual([]);
  });

  it("preserves unreadable preference bytes before the first later write", () => {
    const dirs = makeDirs();
    fs.mkdirSync(dirs.userDir, { recursive: true });
    const corrupt = "{ broken preferences\n";
    fs.writeFileSync(dirs.prefsPath, corrupt, "utf-8");
    const prefs = new PreferencesManager(dirs);

    prefs.setLocale("en");

    const backups = fs.readdirSync(dirs.userDir)
      .filter((name) => name.startsWith("preferences.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dirs.userDir, backups[0]), "utf-8")).toBe(corrupt);
    expect(JSON.parse(fs.readFileSync(dirs.prefsPath, "utf-8"))).toMatchObject({ locale: "en" });
  });
});

describe("legacy startup migration isolation", () => {
  it("records a failed step without throwing out of application startup", () => {
    const logs: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = runBestEffortStartupMigrationStep("provider-source", () => {
        throw new Error("source is unreadable");
      }, (line) => logs.push(line));

      expect(result).toMatchObject({ ok: false });
      expect(logs.join("\n")).toContain("provider-source");
      expect(logs.join("\n")).toContain("应用继续启动");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
