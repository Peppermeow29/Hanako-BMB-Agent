import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.ts";

function makeUserDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-prefs-sandbox-network-"));
  return {
    userDir: path.join(root, "user"),
    agentsDir: path.join(root, "agents"),
  };
}

function makePrefs() {
  const dirs = makeUserDir();
  return new PreferencesManager(dirs);
}

function seedPrefsFile(dirs, contents) {
  fs.mkdirSync(dirs.userDir, { recursive: true });
  fs.writeFileSync(path.join(dirs.userDir, "preferences.json"), JSON.stringify(contents), "utf-8");
}

describe("PreferencesManager sandbox network preference", () => {
  it("defaults sandbox networking to enabled so sandboxed commands keep network functionality", () => {
    const prefs = makePrefs();

    expect(prefs.getSandboxNetwork()).toBe(true);
  });

  it("stores sandbox networking as an explicit boolean", () => {
    const prefs = makePrefs();

    prefs.setSandboxNetwork("true");
    expect(prefs.getSandboxNetwork()).toBe(true);
    expect(prefs.getPreferences().sandbox_network).toBe(true);

    prefs.setSandboxNetwork(false);
    expect(prefs.getSandboxNetwork()).toBe(false);
    expect(prefs.getPreferences().sandbox_network).toBe(false);
  });
});

describe("PreferencesManager legacy-default migration", () => {
  it("relaxes legacy sandbox_network=false from old defaults on first construct", () => {
    const dirs = makeUserDir();
    // 模拟老版本(51ecc435 前)无脑写入的 false，没有 marker
    seedPrefsFile(dirs, { sandbox_network: false, locale: "zh-CN" });

    const prefs = new PreferencesManager(dirs);

    expect(prefs.getSandboxNetwork()).toBe(true);
    const stored = prefs.getPreferences();
    expect(stored.sandbox_network).toBeUndefined();
    expect(stored._defaultsRelaxedMigrated).toBe(true);
    // 其他字段保留
    expect(stored.locale).toBe("zh-CN");
  });

  it("does NOT touch sandbox_network=false once migration marker is present (respects user's explicit choice)", () => {
    const dirs = makeUserDir();
    // 已经 migrate 过；用户后续显式关掉
    seedPrefsFile(dirs, { sandbox_network: false, _defaultsRelaxedMigrated: true });

    const prefs = new PreferencesManager(dirs);

    expect(prefs.getSandboxNetwork()).toBe(false);
    expect(prefs.getPreferences().sandbox_network).toBe(false);
  });

  it("leaves sandbox_network=true untouched and only writes the marker", () => {
    const dirs = makeUserDir();
    seedPrefsFile(dirs, { sandbox_network: true });

    const prefs = new PreferencesManager(dirs);

    expect(prefs.getPreferences().sandbox_network).toBe(true);
    expect(prefs.getPreferences()._defaultsRelaxedMigrated).toBe(true);
  });

  it("writes marker even when there are no legacy values to migrate", () => {
    const prefs = makePrefs();

    expect(prefs.getPreferences()._defaultsRelaxedMigrated).toBe(true);
    expect(prefs.getPreferences().sandbox_network).toBeUndefined();
  });

  it("is idempotent — second construct after migration is a no-op", () => {
    const dirs = makeUserDir();
    seedPrefsFile(dirs, { sandbox_network: false });

    new PreferencesManager(dirs);
    const afterFirst = JSON.parse(fs.readFileSync(path.join(dirs.userDir, "preferences.json"), "utf-8"));
    expect(afterFirst.sandbox_network).toBeUndefined();
    expect(afterFirst._defaultsRelaxedMigrated).toBe(true);

    // 第二次构造前手工塞一个显式 false 模拟用户再次关闭
    afterFirst.sandbox_network = false;
    fs.writeFileSync(path.join(dirs.userDir, "preferences.json"), JSON.stringify(afterFirst), "utf-8");

    new PreferencesManager(dirs);
    const afterSecond = JSON.parse(fs.readFileSync(path.join(dirs.userDir, "preferences.json"), "utf-8"));
    // marker 已存在 → 不再触发 migration → 用户的显式 false 被保留
    expect(afterSecond.sandbox_network).toBe(false);
  });
});
