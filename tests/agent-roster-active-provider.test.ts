import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../core/agent-manager.ts";
import { Agent } from "../core/agent.ts";

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../lib/desk/activity-store.js", () => ({
  ActivityStore: vi.fn(),
}));

describe("active-agent roster provider（#1657 / #1633 删除残留）", () => {
  let tempDir;
  let agentsDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-roster-"));
    agentsDir = path.join(tempDir, "agents");
    fs.mkdirSync(agentsDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createAgentDir(id, { name = id, chatModel = null, description = null, tombstone = false } = {}) {
    const dir = path.join(agentsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const cfg: any = { agent: { name, yuan: "hanako" } };
    if (chatModel) cfg.models = { chat: chatModel };
    fs.writeFileSync(path.join(dir, "config.yaml"), YAML.dump(cfg));
    if (description) fs.writeFileSync(path.join(dir, "description.md"), description, "utf-8");
    if (tombstone) {
      fs.writeFileSync(
        path.join(dir, ".deleted-agent.json"),
        JSON.stringify({ version: 1, agentId: id, deletedAt: new Date().toISOString() }),
        "utf-8",
      );
    }
  }

  function makeMgr() {
    return new AgentManager({
      agentsDir,
      productDir: tempDir,
      userDir: tempDir,
      channelsDir: tempDir,
      getPrefs: () => ({
        getPrimaryAgent: () => null,
        getPreferences: () => ({}),
      }),
      getModels: () => ({}),
      getHub: () => null,
      getSkills: () => ({}),
      getSearchConfig: () => ({}),
      resolveUtilityConfig: () => ({}),
      getSharedModels: () => ({}),
      getChannelManager: () => ({ setupChannelsForNewAgent: vi.fn(), cleanupAgentFromChannels: vi.fn() }),
      getSessionCoordinator: () => ({}),
    });
  }

  it("excludes tombstoned and config-less directories from the roster", () => {
    createAgentDir("alive", { name: "Alive" });
    createAgentDir("ghost", { name: "Ghost", tombstone: true });
    fs.mkdirSync(path.join(agentsDir, "junk", "phone"), { recursive: true }); // 无 config.yaml 的脏目录

    const roster = makeMgr().listActiveAgentsForRoster();

    expect(roster.map((a) => a.id)).toEqual(["alive"]);
  });

  it("returns the legacy roster entry shape: id / name / summary / model", () => {
    createAgentDir("scholar", {
      name: "学者",
      chatModel: { id: "qwen-max", provider: "dashscope" },
      description: "<!-- hash:abc -->\n严谨的研究型助手",
    });
    createAgentDir("plain", { name: "Plain", chatModel: "gpt-4o-mini" });

    const roster = makeMgr().listActiveAgentsForRoster();
    const scholar = roster.find((a) => a.id === "scholar");
    const plain = roster.find((a) => a.id === "plain");

    expect(scholar).toEqual({
      id: "scholar",
      name: "学者",
      summary: "严谨的研究型助手",
      model: "qwen-max",
    });
    expect(plain).toEqual({ id: "plain", name: "Plain", summary: "", model: "gpt-4o-mini" });
  });

  it("injects the provider into Agent callbacks so the agent roster shares the same truth source", () => {
    createAgentDir("alive", { name: "Alive" });
    createAgentDir("ghost", { name: "Ghost", tombstone: true });

    const mgr = makeMgr();
    const ag = mgr._createAgentInstance("alive", () => ({}));

    const fromAgentCallback = ag._cb.listActiveAgents();
    expect(fromAgentCallback.map((a) => a.id)).toEqual(["alive"]);
  });

  it("builds the team roster from the injected provider instead of scanning the disk", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-roster-agent-"));
    const localAgentsDir = path.join(root, "agents");
    const productDir = path.join(root, "product");
    const userDir = path.join(root, "user");
    fs.mkdirSync(path.join(localAgentsDir, "hana"), { recursive: true });
    // 磁盘上放一个"幽灵"目录：有 config.yaml，但 provider 不会返回它
    fs.mkdirSync(path.join(localAgentsDir, "ghost"), { recursive: true });
    fs.writeFileSync(path.join(localAgentsDir, "ghost", "config.yaml"), "agent:\n  name: Ghost\n", "utf-8");
    fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(productDir, "yuan", "hanako.md"), "Yuan prompt", "utf-8");

    const agent = new Agent({
      id: "hana",
      agentsDir: localAgentsDir,
      productDir,
      userDir,
      channelsDir: path.join(root, "channels"),
    } as any);
    agent._config = { locale: "zh-CN", agent: { yuan: "hanako" } };
    agent._cb = {
      listActiveAgents: () => [
        { id: "hana", name: "Hana", summary: "", model: "" },
        { id: "butter", name: "Butter", summary: "面包师", model: "qwen-max" },
      ],
    };

    const roster = agent._formatTeamRoster(true);

    expect(roster).toContain("butter");
    expect(roster).toContain("面包师");
    expect(roster).not.toContain("ghost");
    expect(roster).not.toContain("Ghost");

    fs.rmSync(root, { recursive: true, force: true });
  });
});
