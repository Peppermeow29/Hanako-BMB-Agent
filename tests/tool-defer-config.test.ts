import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { normalizeMcpConfig } from "../core/mcp/manager.ts";
import { PreferencesManager } from "../core/preferences-manager.ts";

function makeDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-defer-prefs-"));
  return {
    userDir: path.join(root, "user"),
    agentsDir: path.join(root, "agents"),
    prefsPath: path.join(root, "user", "preferences.json"),
  };
}

function freshManager() {
  const dirs = makeDirs();
  fs.mkdirSync(dirs.userDir, { recursive: true });
  return new PreferencesManager({ userDir: dirs.userDir, agentsDir: dirs.agentsDir });
}

describe("mcp defer configuration", () => {
  it("defaults deferEnabled to true and deferThreshold to 10 for a config that predates them", () => {
    const config = normalizeMcpConfig({ enabled: true, connectors: [] });
    expect(config.deferEnabled).toBe(true);
    expect(config.deferThreshold).toBe(10);
  });

  it("honours an explicit deferEnabled false", () => {
    expect(normalizeMcpConfig({ deferEnabled: false }).deferEnabled).toBe(false);
  });

  it("only an explicit false disables defer", () => {
    expect(normalizeMcpConfig({ deferEnabled: 0 }).deferEnabled).toBe(true);
    expect(normalizeMcpConfig({ deferEnabled: "no" }).deferEnabled).toBe(true);
  });

  it("keeps a positive integer threshold", () => {
    expect(normalizeMcpConfig({ deferThreshold: 25 }).deferThreshold).toBe(25);
    expect(normalizeMcpConfig({ deferThreshold: 1 }).deferThreshold).toBe(1);
  });

  it("falls back to 10 for every non positive integer threshold", () => {
    for (const value of [0, -3, 2.5, "12", null, NaN, Infinity, {}]) {
      expect(normalizeMcpConfig({ deferThreshold: value }).deferThreshold).toBe(10);
    }
  });

  it("defaults connector pinnedTools to an empty map", () => {
    const config = normalizeMcpConfig({
      connectors: [{ id: "github", url: "https://example.test/mcp" }],
    });
    expect(config.connectors[0].pinnedTools).toEqual({});
  });

  it("keeps only explicitly pinned tools and drops malformed entries", () => {
    const config = normalizeMcpConfig({
      connectors: [{
        id: "github",
        url: "https://example.test/mcp",
        pinnedTools: {
          create_issue: true,
          list_issues: false,
          search_code: "yes",
          "": true,
        },
      }],
    });
    expect(config.connectors[0].pinnedTools).toEqual({ create_issue: true });
  });

  it("leaves an untouched legacy config semantically unchanged apart from the new defaults", () => {
    const legacy = {
      enabled: true,
      connectors: [{
        id: "github",
        url: "https://example.test/mcp",
        permissionMode: "allowlist",
        toolPermissions: { create_issue: "allow" },
      }],
    };
    const config = normalizeMcpConfig(legacy);
    expect(config.connectors[0].permissionMode).toBe("allowlist");
    expect(config.connectors[0].toolPermissions).toEqual({ create_issue: "allow" });
    expect(config.connectors[0].pinnedTools).toEqual({});
    expect(config.deferEnabled).toBe(true);
    expect(config.deferThreshold).toBe(10);
  });
});

describe("builtin tool defer preference", () => {
  it("is off by default", () => {
    expect(freshManager().getBuiltinToolDeferEnabled()).toBe(false);
  });

  it("round trips through the setter", () => {
    const manager = freshManager();
    expect(manager.setBuiltinToolDeferEnabled(true)).toBe(true);
    expect(manager.getBuiltinToolDeferEnabled()).toBe(true);
    manager.setBuiltinToolDeferEnabled(false);
    expect(manager.getBuiltinToolDeferEnabled()).toBe(false);
  });

  it("treats a truthy non boolean as opting out", () => {
    const manager = freshManager();
    manager.setBuiltinToolDeferEnabled("yes");
    expect(manager.getBuiltinToolDeferEnabled()).toBe(false);
  });

  it("persists across manager instances", () => {
    const dirs = makeDirs();
    fs.mkdirSync(dirs.userDir, { recursive: true });
    new PreferencesManager({ userDir: dirs.userDir, agentsDir: dirs.agentsDir }).setBuiltinToolDeferEnabled(true);
    expect(new PreferencesManager({ userDir: dirs.userDir, agentsDir: dirs.agentsDir }).getBuiltinToolDeferEnabled()).toBe(true);
  });
});
