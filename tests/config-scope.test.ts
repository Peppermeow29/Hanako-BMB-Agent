/**
 * config-scope.js + migrate-config-scope.js 单元测试
 *
 * 测试：splitByScope、injectGlobalFields、migrateConfigScope
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { splitByScope, injectGlobalFields } from "../shared/config-scope.ts";
import { migrateConfigScope } from "../shared/migrate-config-scope.ts";

// ---------------------------------------------------------------------------
// splitByScope
// ---------------------------------------------------------------------------

describe("splitByScope", () => {
  it("extracts top-level global fields while keeping agent fields (models)", () => {
    const partial = { locale: "zh-CN", sandbox: false, sandbox_network: true, hardware_acceleration: false, models: ["gpt-4"] };
    const { global: g, agent }: any = splitByScope(partial);

    expect(g).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "locale", value: "zh-CN" }),
      expect.objectContaining({ key: "sandbox", value: false }),
      expect.objectContaining({ key: "sandbox_network", value: true }),
      expect.objectContaining({ key: "hardware_acceleration", value: false }),
    ]));
    expect(agent.models).toEqual(["gpt-4"]);
    expect(agent.locale).toBeUndefined();
    expect(agent.sandbox).toBeUndefined();
    expect(agent.sandbox_network).toBeUndefined();
    expect(agent.hardware_acceleration).toBeUndefined();
  });

  it("extracts nested global fields (capabilities.learn_skills) while keeping sibling nested fields", () => {
    const partial = {
      capabilities: { learn_skills: true, other_cap: "keep" },
    };
    const { global: g, agent }: any = splitByScope(partial);

    expect(g).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "capabilities.learn_skills", value: true }),
    ]));
    expect(agent.capabilities).toBeDefined();
    expect(agent.capabilities.other_cap).toBe("keep");
    expect(agent.capabilities.learn_skills).toBeUndefined();
  });

  it("removes empty parent after extracting the only nested global child", () => {
    const partial = { capabilities: { learn_skills: false } };
    const { global: g, agent }: any = splitByScope(partial);

    expect(g).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "capabilities.learn_skills", value: false }),
    ]));
    expect(agent.capabilities).toBeUndefined();
  });

  it("desk.home_folder is agent-scoped, heartbeat_interval also agent-scoped", () => {
    const partial = {
      desk: { home_folder: "/home/user", heartbeat_interval: 30 },
    };
    const { global: g, agent }: any = splitByScope(partial);

    // home_folder is now agent scope — NOT extracted as global
    expect(g).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "desk.home_folder" }),
    ]));
    expect(agent.desk.home_folder).toBe("/home/user");
    expect(agent.desk.heartbeat_interval).toBe(30);
  });

  it("extracts desk.heartbeat_master as global", () => {
    const partial = {
      desk: { heartbeat_master: false, heartbeat_interval: 20 },
    };
    const { global: g, agent }: any = splitByScope(partial);

    expect(g).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "desk.heartbeat_master", value: false }),
    ]));
    expect(agent.desk.heartbeat_interval).toBe(20);
    expect(agent.desk.heartbeat_master).toBeUndefined();
  });

  it("extracts bridge permission globals while keeping platform config", () => {
    const partial = {
      bridge: {
        permissionMode: "auto",
        readOnly: true,
        receiptEnabled: false,
        richStreamingEnabled: false,
        telegram: { token: "tg-token" },
      },
    };
    const { global: g, agent }: any = splitByScope(partial);

    expect(g).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "bridge.permissionMode", value: "auto" }),
      expect.objectContaining({ key: "bridge.readOnly", value: true }),
      expect.objectContaining({ key: "bridge.receiptEnabled", value: false }),
      expect.objectContaining({ key: "bridge.richStreamingEnabled", value: false }),
    ]));
    expect(agent.bridge.telegram).toEqual({ token: "tg-token" });
    expect(agent.bridge.permissionMode).toBeUndefined();
    expect(agent.bridge.readOnly).toBeUndefined();
    expect(agent.bridge.receiptEnabled).toBeUndefined();
    expect(agent.bridge.richStreamingEnabled).toBeUndefined();
  });

  it("extracts automation permission mode as a global work setting", () => {
    const partial = {
      automation: { permissionMode: "auto", localDraft: true },
      desk: { heartbeat_interval: 20 },
    };
    const { global: g, agent }: any = splitByScope(partial);

    expect(g).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "automation.permissionMode", value: "auto" }),
    ]));
    expect(agent.automation).toEqual({ localDraft: true });
    expect(agent.desk.heartbeat_interval).toBe(20);
  });

  it("returns empty global array when no global fields present", () => {
    const partial = { models: ["qwen-plus"], name: "Alice" };
    const { global: g, agent }: any = splitByScope(partial);

    expect(g).toHaveLength(0);
    expect(agent.models).toEqual(["qwen-plus"]);
    expect(agent.name).toBe("Alice");
  });

  it("keeps tools.disabled in agent scope", () => {
    const partial = {
      tools: { disabled: ["browser", "cron"] },
      locale: "zh-CN",
    };
    const { global: g, agent }: any = splitByScope(partial);

    expect(g).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "locale", value: "zh-CN" }),
    ]));
    expect(g).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "tools.disabled" }),
    ]));
    expect(agent.tools).toEqual({ disabled: ["browser", "cron"] });
  });

  it("returns empty agent when only global fields present", () => {
    const partial = { locale: "en", sandbox: true, keep_awake: true };
    const { global: g, agent } = splitByScope(partial);

    expect(g.length).toBeGreaterThan(0);
    expect(g).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "keep_awake", value: true }),
    ]));
    expect(Object.keys(agent)).toHaveLength(0);
  });

  it("extracts network_proxy as a top-level global field", () => {
    const partial = {
      network_proxy: { mode: "manual", httpProxy: "http://127.0.0.1:7890" },
      models: { chat: { id: "gpt-4.1", provider: "openai" } },
    };
    const { global: g, agent }: any = splitByScope(partial);

    expect(g).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "network_proxy", value: partial.network_proxy }),
    ]));
    expect(agent.network_proxy).toBeUndefined();
    expect(agent.models).toEqual(partial.models);
  });

  it("handles empty partial", () => {
    const { global: g, agent } = splitByScope({});

    expect(g).toHaveLength(0);
    expect(agent).toEqual({});
  });

  it("does not mutate original partial nested objects", () => {
    const caps = { learn_skills: true, other: "x" };
    const partial = { capabilities: caps };
    splitByScope(partial);

    // The original nested object must remain untouched
    expect(caps.learn_skills).toBe(true);
    expect(caps.other).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// injectGlobalFields
// ---------------------------------------------------------------------------

describe("injectGlobalFields", () => {
  it("injects all global fields from engine getters", () => {
    const engine = {
      getLocale: () => "ja",
      getTimezone: () => "Asia/Tokyo",
      getSandbox: () => false,
      getSandboxNetwork: () => true,
      getHardwareAcceleration: () => false,
      getThinkingLevel: () => "high",
      getLearnSkills: () => true,
      getHeartbeatMaster: () => true,
      getBridgePermissionMode: () => "auto",
      getBridgeReadOnly: () => true,
      getBridgeReceiptEnabled: () => false,
      getBridgeRichStreamingEnabled: () => false,
      getAutomationPermissionMode: () => "auto",
      getNetworkProxy: () => ({ mode: "direct" }),
      getKeepAwake: () => true,
    };
    const config: any = {};
    injectGlobalFields(config, engine);

    expect(config.locale).toBe("ja");
    expect(config.timezone).toBe("Asia/Tokyo");
    expect(config.sandbox).toBe(false);
    expect(config.sandbox_network).toBe(true);
    expect(config.hardware_acceleration).toBe(false);
    expect(config.thinking_level).toBe("high");
    expect(config.capabilities?.learn_skills).toBe(true);
    expect(config.desk?.heartbeat_master).toBe(true);
    expect(config.bridge?.permissionMode).toBe("auto");
    expect(config.bridge?.readOnly).toBe(true);
    expect(config.bridge?.receiptEnabled).toBe(false);
    expect(config.bridge?.richStreamingEnabled).toBe(false);
    expect(config.automation?.permissionMode).toBe("auto");
    expect(config.network_proxy).toEqual({ mode: "direct" });
    expect(config.keep_awake).toBe(true);
  });

  it("skips getters that don't exist on engine (doesn't throw)", () => {
    // Engine only implements a subset of getters
    const engine = {
      getLocale: () => "en",
    };
    const config: any = {};
    expect(() => injectGlobalFields(config, engine)).not.toThrow();
    expect(config.locale).toBe("en");
    // Fields whose getters are absent should not appear
    expect(config.sandbox).toBeUndefined();
  });

  it("creates nested parent (capabilities, desk) if not present", () => {
    const engine = {
      getLearnSkills: () => false,
      getHeartbeatMaster: () => false,
      getBridgePermissionMode: () => "read_only",
      getBridgeReadOnly: () => false,
      getBridgeReceiptEnabled: () => true,
      getBridgeRichStreamingEnabled: () => true,
    };
    const config: any = {};
    injectGlobalFields(config, engine);

    expect(config.capabilities).toBeDefined();
    expect(config.capabilities.learn_skills).toBe(false);
    expect(config.desk).toBeDefined();
    expect(config.desk.heartbeat_master).toBe(false);
    expect(config.bridge).toBeDefined();
    expect(config.bridge.permissionMode).toBe("read_only");
    expect(config.bridge.readOnly).toBe(false);
    expect(config.bridge.receiptEnabled).toBe(true);
    expect(config.bridge.richStreamingEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// migrateConfigScope — helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-migrate-test-"));
}

function writeAgentConfig(agentsDir, agentId, cfgObj) {
  const dir = path.join(agentsDir, agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), YAML.dump(cfgObj, { lineWidth: -1 }), "utf-8");
}

function makeMockPrefs( initial: any = {}) {
  let store = { ...initial };
  return {
    getPreferences: () => store,
    savePreferences: (p) => { store = { ...p }; },
    _getStore: () => store,
  };
}

// ---------------------------------------------------------------------------
// migrateConfigScope
// ---------------------------------------------------------------------------

describe("migrateConfigScope", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("migrates global fields from agent config to preferences", () => {
    const agentsDir = path.join(tmpDir, "agents");
    writeAgentConfig(agentsDir, "agent-1", { locale: "zh-CN", sandbox: false, name: "Alice" });

    const prefs = makeMockPrefs({});
    migrateConfigScope({ agentsDir, prefs, primaryAgentId: "agent-1" });

    const store = prefs._getStore();
    expect(store.locale).toBe("zh-CN");
    expect(store.sandbox).toBe(false);
    // agent scope field must NOT be migrated to prefs
    expect(store.name).toBeUndefined();
    // migration marker
    expect(store._configScopeMigrated).toBe(true);
  });

  it("does not overwrite existing non-default preferences (the default is false so agent true wins)", () => {
    const agentsDir = path.join(tmpDir, "agents");
    // Agent wants keep-awake enabled.
    writeAgentConfig(agentsDir, "agent-1", { keep_awake: true });

    // Preferences already has the default false — agent value should win
    const prefs = makeMockPrefs({ keep_awake: false });
    migrateConfigScope({ agentsDir, prefs, primaryAgentId: "agent-1" });

    const store = prefs._getStore();
    expect(store.keep_awake).toBe(true);

    // Now run with a genuinely non-default prefs value
    const agentsDir2 = path.join(tmpDir, "agents2");
    writeAgentConfig(agentsDir2, "agent-2", { keep_awake: true });
    const prefs2 = makeMockPrefs({ keep_awake: true });
    migrateConfigScope({ agentsDir: agentsDir2, prefs: prefs2, primaryAgentId: "agent-2" });

    const store2 = prefs2._getStore();
    // prefs already had a non-default value — it must remain unchanged.
    expect(store2.keep_awake).toBe(true);
  });

  it("prefers primary agent value in multi-agent conflict", () => {
    const agentsDir = path.join(tmpDir, "agents");
    writeAgentConfig(agentsDir, "primary", { locale: "ja" });
    writeAgentConfig(agentsDir, "secondary", { locale: "ko" });

    const prefs = makeMockPrefs({});
    migrateConfigScope({ agentsDir, prefs, primaryAgentId: "primary" });

    expect(prefs._getStore().locale).toBe("ja");
  });

  it("is idempotent — second run is a no-op", () => {
    const agentsDir = path.join(tmpDir, "agents");
    writeAgentConfig(agentsDir, "agent-1", { locale: "zh-CN" });

    const prefs = makeMockPrefs({});
    migrateConfigScope({ agentsDir, prefs, primaryAgentId: "agent-1" });

    // Manually change prefs between runs to verify second run doesn't override
    const store = prefs._getStore();
    store.locale = "en";
    prefs.savePreferences(store);

    migrateConfigScope({ agentsDir, prefs, primaryAgentId: "agent-1" });

    // Second run must be skipped entirely — locale stays "en"
    expect(prefs._getStore().locale).toBe("en");
  });

  it("creates backup file before modifying config", () => {
    const agentsDir = path.join(tmpDir, "agents");
    writeAgentConfig(agentsDir, "agent-1", { locale: "zh-CN", name: "Alice" });

    const prefs = makeMockPrefs({});
    migrateConfigScope({ agentsDir, prefs, primaryAgentId: "agent-1" });

    const backupPath = path.join(agentsDir, "agent-1", "config.yaml.pre-scope-migration");
    expect(fs.existsSync(backupPath)).toBe(true);

    const backup = YAML.load(fs.readFileSync(backupPath, "utf-8"));
    expect(backup.locale).toBe("zh-CN");
  });

  it("does not clean agent sources when the destination preference write fails", () => {
    const agentsDir = path.join(tmpDir, "agents");
    writeAgentConfig(agentsDir, "agent-1", { locale: "zh-CN", name: "Alice" });
    const prefs = {
      getPreferences: () => ({}),
      savePreferences: () => { throw new Error("destination unavailable"); },
    };

    expect(() => migrateConfigScope({ agentsDir, prefs, primaryAgentId: "agent-1" }))
      .toThrow("destination unavailable");

    const stored = YAML.load(fs.readFileSync(path.join(agentsDir, "agent-1", "config.yaml"), "utf-8"));
    expect(stored).toMatchObject({ locale: "zh-CN", name: "Alice" });
  });

  it("migrates readable agents but keeps the receipt pending when another source is unreadable", () => {
    const agentsDir = path.join(tmpDir, "agents");
    writeAgentConfig(agentsDir, "good", { locale: "zh-CN", name: "Good" });
    const badPath = path.join(agentsDir, "bad", "config.yaml");
    fs.mkdirSync(path.dirname(badPath), { recursive: true });
    const corrupt = "models: [unterminated\n";
    fs.writeFileSync(badPath, corrupt, "utf-8");
    const prefs = makeMockPrefs({});

    expect(() => migrateConfigScope({ agentsDir, prefs, primaryAgentId: "good" }))
      .toThrow(/unreadable agent config/i);

    expect(prefs._getStore()).toMatchObject({ locale: "zh-CN" });
    expect(prefs._getStore()._configScopeMigrated).toBeUndefined();
    expect(YAML.load(fs.readFileSync(path.join(agentsDir, "good", "config.yaml"), "utf-8")))
      .toEqual({ name: "Good" });
    expect(fs.readFileSync(badPath, "utf-8")).toBe(corrupt);
  });

  it("handles nested global fields (capabilities.learn_skills)", () => {
    const agentsDir = path.join(tmpDir, "agents");
    writeAgentConfig(agentsDir, "agent-1", {
      capabilities: { learn_skills: true, other: "keep" },
      name: "Alice",
    });

    const prefs = makeMockPrefs({});
    migrateConfigScope({ agentsDir, prefs, primaryAgentId: "agent-1" });

    const store = prefs._getStore();
    expect(store.learn_skills).toBe(true);

    // The cleaned config.yaml should have other cap but not learn_skills
    const cfg = YAML.load(
      fs.readFileSync(path.join(agentsDir, "agent-1", "config.yaml"), "utf-8")
    );
    expect(cfg.capabilities?.learn_skills).toBeUndefined();
    expect(cfg.capabilities?.other).toBe("keep");
    // agent-scoped field must still be in config.yaml
    expect(cfg.name).toBe("Alice");
  });

  it("uses schema prefsPath/defaultValue when migrating bridge and heartbeat globals", () => {
    const agentsDir = path.join(tmpDir, "agents");
    writeAgentConfig(agentsDir, "primary", {
      bridge: { readOnly: false },
      desk: { heartbeat_master: true },
    });
    writeAgentConfig(agentsDir, "secondary", {
      bridge: { readOnly: true },
      desk: { heartbeat_master: false },
    });

    const prefs = makeMockPrefs({});
    migrateConfigScope({ agentsDir, prefs, primaryAgentId: "primary" });

    const store = prefs._getStore();
    expect(store.bridge?.readOnly).toBe(true);
    expect(store.heartbeat_master).toBe(false);

    const cfgPrimary = YAML.load(fs.readFileSync(path.join(agentsDir, "primary", "config.yaml"), "utf-8"));
    const cfgSecondary = YAML.load(fs.readFileSync(path.join(agentsDir, "secondary", "config.yaml"), "utf-8"));
    expect(cfgPrimary.bridge).toBeUndefined();
    expect(cfgSecondary.bridge).toBeUndefined();
    expect(cfgPrimary.desk).toBeUndefined();
    expect(cfgSecondary.desk).toBeUndefined();
  });
});
