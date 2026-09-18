import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "js-yaml";
import { AgentManager } from "../core/agent-manager.ts";

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

describe("AgentManager.listAgents 缓存", () => {
  let tempDir;
  let agentsDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-test-"));
    agentsDir = path.join(tempDir, "agents");
    fs.mkdirSync(agentsDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createTestAgent(id, name) {
    const dir = path.join(agentsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.yaml"),
      YAML.dump({ agent: { name, yuan: "hanako" } }),
    );
    fs.writeFileSync(path.join(dir, "identity.md"), `# ${name}\n这是 ${name} 的身份`);
  }

  function linkDirectory(target, linkPath) {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  }

  function createLinkedTestAgent(id, name) {
    const realDir = path.join(tempDir, `real-${id}`);
    const linkedDir = path.join(agentsDir, id);
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(
      path.join(realDir, "config.yaml"),
      YAML.dump({ agent: { name, yuan: "hanako" } }),
    );
    fs.writeFileSync(path.join(realDir, "identity.md"), `# ${name}\n这是 ${name} 的身份`);
    linkDirectory(realDir, linkedDir);
  }

  function makeMgr({ userName = "" } = {}) {
    return new AgentManager({
      agentsDir,
      productDir: tempDir,
      userDir: tempDir,
      channelsDir: tempDir,
      getEngine: () => ({ getUserName: () => userName }),
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

  it("listAgents 在 TTL 内使用缓存", () => {
    createTestAgent("alice", "Alice");
    const mgr = makeMgr();

    const first = mgr.listAgents();
    expect(first).toHaveLength(1);
    expect(first[0].name).toBe("Alice");

    // 在 TTL 内新建一个 agent 目录（不经过 createAgent，直接写磁盘模拟外部变更）
    createTestAgent("bob", "Bob");

    // 应该还是缓存结果
    const second = mgr.listAgents();
    expect(second).toHaveLength(1); // 还是 1，缓存未过期
  });

  it("invalidateAgentListCache 后立即反映变更", () => {
    createTestAgent("alice", "Alice");
    const mgr = makeMgr();

    const first = mgr.listAgents();
    expect(first).toHaveLength(1);

    // 修改 config（模拟 PUT /api/agents/:id/config）
    fs.writeFileSync(
      path.join(agentsDir, "alice", "config.yaml"),
      YAML.dump({ agent: { name: "AliceV2", yuan: "butter" } }),
    );

    // 不清缓存 → 看不到更新
    const stale = mgr.listAgents();
    expect(stale[0].name).toBe("Alice");

    // 清缓存后 → 立即看到
    mgr.invalidateAgentListCache();
    const fresh = mgr.listAgents();
    expect(fresh[0].name).toBe("AliceV2");
  });

  it("编辑 identity.md 后清缓存能反映", () => {
    createTestAgent("alice", "Alice");
    const mgr = makeMgr();

    const first = mgr.listAgents();
    expect(first[0].identity).toContain("Alice");

    // 修改 identity（模拟 PUT /api/agents/:id/identity）
    fs.writeFileSync(
      path.join(agentsDir, "alice", "identity.md"),
      "# Alice\n全新的身份描述",
    );

    mgr.invalidateAgentListCache();
    const fresh = mgr.listAgents();
    expect(fresh[0].identity).toBe("全新的身份描述");
  });

  it("renders identity placeholders in list previews from the agent config", () => {
    const dir = path.join(agentsDir, "hana");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.yaml"),
      YAML.dump({ agent: { name: "Hana", yuan: "hanako" } }),
    );
    fs.writeFileSync(
      path.join(dir, "identity.md"),
      "# {{agentName}}\n{{userName}}的个人助手",
      "utf-8",
    );
    // 用户的名字只有全局这一个来源，列表预览和 agent 自己用的必须是同一个
    const mgr = makeMgr({ userName: "黎" });

    const [agent] = mgr.listAgents();

    expect(agent.identity).toBe("黎的个人助手");
  });

  it("listAgents includes agents stored behind a filesystem link", () => {
    createLinkedTestAgent("linked", "Linked");
    const mgr = makeMgr();

    const agents = mgr.listAgents();

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: "linked", name: "Linked" });
  });

  it("excludes tombstoned agents from the active list and exposes deleted metadata", () => {
    createTestAgent("alive", "Alive");
    createTestAgent("deleted", "Deleted");
    fs.writeFileSync(
      path.join(agentsDir, "deleted", ".deleted-agent.json"),
      JSON.stringify({ deletedAt: "2026-06-03T01:00:00.000Z", agentName: "Deleted" }),
      "utf-8",
    );
    const mgr = makeMgr();

    expect(mgr.listAgents().map(a => a.id)).toEqual(["alive"]);
    expect(mgr.isAgentDeleted("deleted")).toBe(true);
    expect(mgr.listDeletedAgents()).toEqual([
      expect.objectContaining({
        id: "deleted",
        name: "Deleted",
        deletedAt: "2026-06-03T01:00:00.000Z",
      }),
    ]);
  });
});
