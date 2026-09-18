import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deepMerge } from "../lib/memory/config-loader.ts";

// ── Mocks ──────────────────────────────────────────────────────
//
// We mock Agent entirely. Real Agent.init() exercises memory/session/desk/bridge
// init which we don't care about here. The mock only implements the minimum
// for createAgent's flow: init (read config.yaml), updateConfig (merge + write),
// and no-op setters.
vi.mock("../core/agent.js", () => ({
  Agent: vi.fn().mockImplementation(function (opts) {
    // 对齐真实 Agent 构造：id 是唯一信源，agentDir 从 agentsDir + id 派生
    this.id = opts.id;
    this.agentsDir = opts.agentsDir;
    this.agentDir = path.join(opts.agentsDir, opts.id);
    this.config = {};
    this.init = async () => {
      const cfgPath = path.join(this.agentDir, "config.yaml");
      if (fs.existsSync(cfgPath)) {
        this.config = YAML.load(fs.readFileSync(cfgPath, "utf-8")) || {};
      }
    };
    this.updateConfig = (partial) => {
      const cfgPath = path.join(this.agentDir, "config.yaml");
      const existing = fs.existsSync(cfgPath)
        ? YAML.load(fs.readFileSync(cfgPath, "utf-8")) || {}
        : {};
      const merged = deepMerge(existing, partial);
      fs.writeFileSync(cfgPath, YAML.dump(merged));
      this.config = merged;
    };
    this.setGetOwnerIds = vi.fn();
    this.setCallbacks = vi.fn();
    this.setOnInstallCallback = vi.fn();
    this.setNotifyHandler = vi.fn();
    this.setDescriptionRefreshHandler = vi.fn();
    this.dispose = vi.fn();
  }),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../lib/desk/activity-store.js", () => ({
  ActivityStore: vi.fn(),
}));

vi.mock("../lib/memory/config-loader.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, clearConfigCache: vi.fn() };
});

vi.mock("../core/llm-utils.js", () => ({
  generateAgentId: vi.fn().mockImplementation(async (_u: any, name: any) => `agent-${name.toLowerCase()}`),
  generateDescription: vi.fn(),
}));

// Import AFTER vi.mock calls so the mocks take effect.
import { AgentManager } from "../core/agent-manager.ts";
import { resolvePersonaSource } from "../core/persona-source.ts";

// ── Test suite ─────────────────────────────────────────────────
describe("AgentManager.createAgent default skills.enabled", () => {
  let tempDir;
  let agentsDir;
  let productDir;
  let mgr;
  let skillsMock;
  let prefsMock;

  function seedTemplate(enabledLiteral = '["skill-creator"]') {
    fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
    fs.writeFileSync(path.join(productDir, "yuan", "hanako.md"), "Hanako yuan\n", "utf-8");
    fs.writeFileSync(path.join(productDir, "yuan", "ming.md"), "Ming yuan\n", "utf-8");
    fs.writeFileSync(
      path.join(productDir, "config.example.yaml"),
      [
        "agent:",
        "  name: Hanako",
        "  yuan: hanako",
        "user:",
        '  name: ""',
        "api:",
        '  provider: ""',
        "models:",
        '  chat: ""',
        "skills:",
        `  enabled: ${enabledLiteral}`,
      ].join("\n"),
    );
  }

  function makeMgr() {
    return new AgentManager({
      agentsDir,
      productDir,
      userDir: tempDir,
      channelsDir: tempDir,
      getPrefs: () => prefsMock,
      getModels: () => ({
        resolveModelWithCredentials: vi.fn(),
        defaultModel: { id: "test-model", provider: "test-provider" },
        availableModels: [],
      }),
      getHub: () => ({
        scheduler: {
          startAgentCron: vi.fn(),
          startAgentHeartbeat: vi.fn(),
        },
        dmRouter: null,
      }),
      getSkills: () => skillsMock,
      getSearchConfig: () => ({}),
      resolveUtilityConfig: () => ({}),
      getSharedModels: () => ({}),
      getChannelManager: () => ({
        setupChannelsForNewAgent: vi.fn(),
        cleanupAgentFromChannels: vi.fn(),
      }),
      getSessionCoordinator: () => ({}),
    });
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-create-defaults-"));
    agentsDir = path.join(tempDir, "agents");
    productDir = tempDir;
    fs.mkdirSync(agentsDir);
    seedTemplate();

    skillsMock = {
      _allSkills: [],
      computeDefaultEnabledForNewAgent() {
        return this._allSkills
          .filter((s) => s.source !== "external" && s.defaultEnabled !== false)
          .map((s) => s.name);
      },
      syncAgentSkills: vi.fn(),
    };
    prefsMock = {
      getPrimaryAgent: vi.fn(() => null),
      getPreferences: vi.fn(() => ({})),
      savePrimaryAgent: vi.fn(),
    };

    mgr = makeMgr();
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it("writes snapshot of installed user skills to new agent config.yaml", async () => {
    skillsMock._allSkills = [
      { name: "pdf", source: "user" },
      { name: "docx", source: "user" },
      { name: "migrated-one", source: "user", defaultEnabled: false },
      { name: "ext-one", source: "external" },
    ];

    const { id: newId } = await mgr.createAgent({ name: "TestAgent", yuan: "hanako" });

    const cfgPath = path.join(agentsDir, newId, "config.yaml");
    const cfg = YAML.load(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.skills.enabled).toEqual(["pdf", "docx"]);
  });

  it("does not copy the user's name into the new agent's config", async () => {
    // 名字的正源是全局 preferences。新 agent 抄一份下来，用户改名后就会留下
    // 一个对不上的旧副本，而副本还会盖过全局值。
    mgr._agents.set("hana", { id: "hana", userName: "阿黎" });
    mgr._activeAgentId = "hana";

    const { id: newId } = await mgr.createAgent({ name: "TestAgent", yuan: "hanako" });

    const cfg = YAML.load(fs.readFileSync(path.join(agentsDir, newId, "config.yaml"), "utf-8"));
    expect(cfg.user).toBeUndefined();
  });

  it.each([
    "明",
    "agent😀",
    "agent name",
    "agent.name",
    "agent/name",
    "agent\\name",
    "",
    "___",
    "---",
    "CON",
  ])("rejects invalid explicit agent id %j before creating any files", async (id) => {
    await expect(mgr.createAgent({
      name: "Ming",
      id,
      yuan: "ming",
    })).rejects.toMatchObject({
      code: "INVALID_AGENT_ID",
      statusCode: 400,
    });

    expect(fs.readdirSync(agentsDir)).toEqual([]);
    expect(skillsMock.syncAgentSkills).not.toHaveBeenCalled();
  });

  it("falls back to seeded template default when snapshot is empty", async () => {
    skillsMock._allSkills = [];

    const { id: newId } = await mgr.createAgent({ name: "EmptyAgent", yuan: "hanako" });

    const cfgPath = path.join(agentsDir, newId, "config.yaml");
    const cfg = YAML.load(fs.readFileSync(cfgPath, "utf-8"));
    // The test seeds the template literally with ["skill-creator"], so that's
    // what should remain when our new fill code doesn't execute.
    expect(cfg.skills.enabled).toEqual(["skill-creator"]);
  });

  it("does not touch existing agents' config.yaml (regression for #419)", async () => {
    skillsMock._allSkills = [{ name: "pdf", source: "user" }];

    const { id: firstId } = await mgr.createAgent({ name: "First", yuan: "hanako" });
    const firstCfgPath = path.join(agentsDir, firstId, "config.yaml");
    const mtimeBefore = fs.statSync(firstCfgPath).mtimeMs;

    // Wait 20ms so filesystem mtime resolution can distinguish any write
    await new Promise((r) => setTimeout(r, 20));

    await mgr.createAgent({ name: "Second", yuan: "hanako" });

    const mtimeAfter = fs.statSync(firstCfgPath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("persists models.chat as composite ref for newly created agents", async () => {
    skillsMock._allSkills = [];

    const { id: newId } = await mgr.createAgent({ name: "CompositeAgent", yuan: "hanako" });

    const cfgPath = path.join(agentsDir, newId, "config.yaml");
    const cfg = YAML.load(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.models.chat).toEqual({ id: "test-model", provider: "test-provider" });
  });

  it("does not seed identity.md/AGENTS.md to disk for newly created agents (lazy materialization)", async () => {
    fs.mkdirSync(path.join(productDir, "identity-templates"), { recursive: true });
    fs.writeFileSync(
      path.join(productDir, "identity-templates", "hanako.md"),
      "# {{agentName}}\n\n{{userName}}的个人助手。\n",
      "utf-8",
    );
    fs.mkdirSync(path.join(productDir, "agents-templates"), { recursive: true });
    fs.writeFileSync(
      path.join(productDir, "agents-templates", "hanako.md"),
      "AGENTS.md template\n",
      "utf-8",
    );

    const { id: newId } = await mgr.createAgent({ name: "TemplateAgent", yuan: "hanako" });

    // identity.md / AGENTS.md 不再在创建时落盘：未定制人格靠运行时回落到
    // lib 模板（core/persona-source.ts），不是靠此刻就把模板拷进 agentDir。
    expect(fs.existsSync(path.join(agentsDir, newId, "identity.md"))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, newId, "AGENTS.md"))).toBe(false);

    // 运行时回落链仍必须解析到同一份模板内容（带原始占位符，留给
    // system-prompt 组装阶段渲染，不在这里提前替换）。
    const { content: identity, fromTemplate: identityFromTemplate } = resolvePersonaSource({
      agentDir: path.join(agentsDir, newId),
      productDir,
      yuanType: "hanako",
      locale: "zh-CN",
      kind: "identity",
    });
    expect(identityFromTemplate).toBe(true);
    expect(identity).toContain("# {{agentName}}");
    expect(identity).toContain("{{userName}}的个人助手");

    const { content: agentsMd, fromTemplate: agentsMdFromTemplate } = resolvePersonaSource({
      agentDir: path.join(agentsDir, newId),
      productDir,
      yuanType: "hanako",
      locale: "zh-CN",
      kind: "agents",
    });
    expect(agentsMdFromTemplate).toBe(true);
    expect(agentsMd).toContain("AGENTS.md template");
  });

  it("defaults patrol to disabled with a 31 minute interval for newly created agents", async () => {
    skillsMock._allSkills = [];

    const { id: newId } = await mgr.createAgent({ name: "DeskAgent", yuan: "hanako" });

    const cfgPath = path.join(agentsDir, newId, "config.yaml");
    const cfg = YAML.load(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.desk.heartbeat_enabled).toBe(false);
    expect(cfg.desk.heartbeat_interval).toBe(31);
  });

  it("defaults the memory master switch to enabled for newly created agents", async () => {
    skillsMock._allSkills = [];

    const { id: newId } = await mgr.createAgent({ name: "QuietMemoryAgent", yuan: "hanako" });

    const cfgPath = path.join(agentsDir, newId, "config.yaml");
    const cfg = YAML.load(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.memory.enabled).toBe(true);
  });

  it("uses an explicit skills.enabled override for imported character-card agents", async () => {
    skillsMock._allSkills = [
      { name: "global-one", source: "user" },
      { name: "global-two", source: "user" },
    ];

    const { id: newId } = await mgr.createAgent({
      name: "ImportedAgent",
      yuan: "ming",
      enabledSkills: ["card-skill"],
      initialFiles: {
        identity: "Imported identity",
        agents: "Imported persona",
        publicAgents: "Imported public persona",
      },
      initialMemory: {
        compiled: {
          facts: "用户喜欢短句。",
          today: "今天迁移角色卡。",
          week: "本周迁移 Project Hana。",
          longterm: "用户长期关注本地优先迁移。",
        },
        sourceId: "character-card-import-test",
        sourcePackage: "imported-package.zip",
      },
    });

    const cfgPath = path.join(agentsDir, newId, "config.yaml");
    const memoryDir = path.join(agentsDir, newId, "memory");
    const seed = JSON.parse(fs.readFileSync(path.join(memoryDir, "summaries", "character-card-import-test.json"), "utf-8"));
    const cfg = YAML.load(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.skills.enabled).toEqual(["card-skill"]);
    expect(fs.readFileSync(path.join(agentsDir, newId, "identity.md"), "utf-8")).toBe("Imported identity");
    expect(fs.readFileSync(path.join(agentsDir, newId, "AGENTS.md"), "utf-8")).toBe("Imported persona");
    expect(fs.readFileSync(path.join(agentsDir, newId, "AGENTS.public.md"), "utf-8")).toBe("Imported public persona");
    expect(fs.readFileSync(path.join(memoryDir, "today.md"), "utf-8")).toBe("今天迁移角色卡。");
    expect(fs.readFileSync(path.join(memoryDir, "memory.md"), "utf-8")).toContain("用户长期关注本地优先迁移。");
    expect(seed.imported.packageName).toBe("imported-package.zip");
    expect(seed.snapshot).toBe(seed.summary);
    expect(skillsMock.syncAgentSkills).toHaveBeenCalled();
  });

  it("includes each agent memory master state in the agent list", async () => {
    fs.mkdirSync(path.join(agentsDir, "memory-off"), { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "memory-off", "config.yaml"),
      [
        "agent:",
        "  name: Memory Off",
        "memory:",
        "  enabled: false",
      ].join("\n"),
    );
    fs.mkdirSync(path.join(agentsDir, "memory-on"), { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "memory-on", "config.yaml"),
      [
        "agent:",
        "  name: Memory On",
        "memory:",
        "  enabled: true",
      ].join("\n"),
    );

    const agents = mgr.listAgents();

    expect(agents.find(a => a.id === "memory-off").memoryMasterEnabled).toBe(false);
    expect(agents.find(a => a.id === "memory-on").memoryMasterEnabled).toBe(true);
    expect(agents.find(a => a.id === "memory-on").avatarRevision).toBeNull();
  });

  it("falls back to the template identity summary in the agent list when identity.md is not seeded", async () => {
    fs.mkdirSync(path.join(productDir, "identity-templates"), { recursive: true });
    fs.writeFileSync(
      path.join(productDir, "identity-templates", "hanako.md"),
      "# {{agentName}}\n\nA quiet template summary line.\n",
      "utf-8",
    );
    // 惰性材料化后新建 agent 不会有 identity.md 落盘；花名册摘要必须走同一条
    // 回落链解析出模板内容，不能因为 fs.readFileSync 抛 ENOENT 就留空。
    fs.mkdirSync(path.join(agentsDir, "no-identity-file"), { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "no-identity-file", "config.yaml"),
      "agent:\n  name: NoIdentityFile\n  yuan: hanako\n",
      "utf-8",
    );
    expect(fs.existsSync(path.join(agentsDir, "no-identity-file", "identity.md"))).toBe(false);

    const agents = mgr.listAgents();
    const entry = agents.find(a => a.id === "no-identity-file");

    expect(entry.identity).not.toBe("");
    expect(entry.identity).toContain("A quiet template summary line.");
  });

  it("returns a stable avatar revision and changes it only when avatar metadata changes", () => {
    const agentId = "avatar-agent";
    const agentDir = path.join(agentsDir, agentId);
    const avatarDir = path.join(agentDir, "avatars");
    const avatarPath = path.join(avatarDir, "agent.png");
    fs.mkdirSync(avatarDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Avatar Agent\n", "utf-8");
    fs.writeFileSync(avatarPath, Buffer.from("first-avatar"));
    fs.utimesSync(avatarPath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));

    const first = mgr.listAgents().find(agent => agent.id === agentId);
    const firstStat = fs.statSync(avatarPath);
    expect(first.hasAvatar).toBe(true);
    expect(first.avatarRevision).toBe(`${firstStat.mtimeMs}-${firstStat.size}`);

    mgr.invalidateAgentListCache();
    const unchanged = mgr.listAgents().find(agent => agent.id === agentId);
    expect(unchanged.avatarRevision).toBe(first.avatarRevision);

    fs.writeFileSync(avatarPath, Buffer.from("second-avatar-is-larger"));
    fs.utimesSync(avatarPath, new Date(1_700_000_001_000), new Date(1_700_000_001_000));
    mgr.invalidateAgentListCache();
    const changed = mgr.listAgents().find(agent => agent.id === agentId);
    expect(changed.avatarRevision).not.toBe(first.avatarRevision);
  });

  it("filters legacy non-ASCII agent directories from runtime discovery without deleting them", async () => {
    const legacyDir = path.join(agentsDir, "明");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "config.yaml"), "agent:\n  name: Legacy Ming\n", "utf-8");

    expect(mgr.listAgents()).toEqual([]);
    await expect(mgr.ensureAgentRuntime("明")).rejects.toMatchObject({ code: "INVALID_AGENT_ID" });
    expect(fs.existsSync(path.join(legacyDir, "config.yaml"))).toBe(true);
  });

  it("keeps safe legacy uppercase and underscore agent ids discoverable", () => {
    const legacyId = "Legacy_AGENT-1";
    const legacyDir = path.join(agentsDir, legacyId);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "config.yaml"), "agent:\n  name: Legacy Agent\n", "utf-8");

    expect(mgr.listAgents().map(agent => agent.id)).toEqual([legacyId]);
  });

  it("rejects an invalid primary agent id before writing preferences", () => {
    const invalidId = "中文助手";
    const invalidDir = path.join(agentsDir, invalidId);
    fs.mkdirSync(invalidDir, { recursive: true });
    fs.writeFileSync(path.join(invalidDir, "config.yaml"), "agent:\n  name: Invalid\n", "utf-8");

    let caught;
    try {
      mgr.setPrimaryAgent(invalidId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      code: "INVALID_AGENT_ID",
      statusCode: 400,
    });
    expect(prefsMock.savePrimaryAgent).not.toHaveBeenCalled();
  });

  it("persists an existing safe ASCII primary agent id", () => {
    const agentId = "Legacy_AGENT-1";
    const agentDir = path.join(agentsDir, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\n  name: Legacy\n", "utf-8");

    mgr.setPrimaryAgent(agentId);

    expect(prefsMock.savePrimaryAgent).toHaveBeenCalledWith(agentId);
  });
});
