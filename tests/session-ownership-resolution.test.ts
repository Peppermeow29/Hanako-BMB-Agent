import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: vi.fn(),
  emitSessionShutdown: vi.fn(async () => false),
  SessionManager: { create: vi.fn(), list: vi.fn(async () => []), open: vi.fn() },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
  resizeModelImageInput: vi.fn(async (image) => image),
  formatModelImageDimensionNote: vi.fn(() => undefined),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { SessionCoordinator } from "../core/session-coordinator.ts";
import { SessionManifestStore } from "../core/session-manifest/store.ts";

describe("resolveSessionOwnership", () => {
  let tempDir;
  let agentsDir;
  let store;
  let deletedAgents;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-ownership-"));
    agentsDir = path.join(tempDir, "agents");
    deletedAgents = new Set();
    store = new SessionManifestStore({
      dbPath: path.join(tempDir, "session-manifest.db"),
    });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeSessionFile(agentId, name) {
    const sessionPath = path.join(agentsDir, agentId, "sessions", name);
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify({ type: "session", version: 3, id: name }) + "\n");
    return sessionPath;
  }

  function createCoordinator() {
    return new SessionCoordinator({
      agentsDir,
      getAgent: () => ({ id: "hana", sessionDir: path.join(agentsDir, "hana", "sessions") }),
      getActiveAgentId: () => "hana",
      agentIdFromSessionPath: (p) => {
        const rel = path.relative(agentsDir, p || "");
        if (!rel || rel.startsWith("..")) return null;
        return rel.split(path.sep)[0] || null;
      },
      isAgentDeleted: (id) => deletedAgents.has(id),
      emitEvent: vi.fn(),
      getPrefs: () => ({}),
      sessionManifestStore: store,
    });
  }

  it("以 manifest.ownerAgentId 为准，路径目录段不一致时不误判", () => {
    // 物理位置在已删除 agent "bob" 的目录，但 manifest 权威归属是存活的 "hana"
    // （模拟 spec 的 locatorReason: "repair"/"move" 跨目录重定位场景）
    const sessionPath = makeSessionFile("bob", "alpha.jsonl");
    deletedAgents.add("bob");
    store.createForPath({ sessionPath, ownerAgentId: "hana", domain: "desktop", kind: "chat" });

    const coordinator = createCoordinator();
    const ownership = coordinator.resolveSessionOwnership(sessionPath);

    expect(ownership).toEqual({ agentId: "hana", source: "manifest", agentDeleted: false });
    expect(coordinator._isDeletedAgentSessionPath(sessionPath)).toBe(false);
  });

  it("manifest 归属指向已删除 agent 时拦截，即使路径在存活 agent 目录", () => {
    const sessionPath = makeSessionFile("hana", "beta.jsonl");
    deletedAgents.add("bob");
    store.createForPath({ sessionPath, ownerAgentId: "bob", domain: "desktop", kind: "chat" });

    const coordinator = createCoordinator();
    const ownership = coordinator.resolveSessionOwnership(sessionPath);

    expect(ownership).toEqual({ agentId: "bob", source: "manifest", agentDeleted: true });
    expect(coordinator._isDeletedAgentSessionPath(sessionPath)).toBe(true);
  });

  it("无 manifest 时回退路径推导（读时兼容，老行为不变）", () => {
    const sessionPath = makeSessionFile("carol", "gamma.jsonl");
    const coordinator = createCoordinator();

    expect(coordinator.resolveSessionOwnership(sessionPath)).toEqual({
      agentId: "carol", source: "path", agentDeleted: false,
    });
  });

  it("manifest 存在但 ownerAgentId 为空时回退路径推导", () => {
    const sessionPath = makeSessionFile("dave", "delta.jsonl");
    store.createForPath({ sessionPath, domain: "desktop", kind: "chat" }); // 不传 ownerAgentId → null

    const coordinator = createCoordinator();
    expect(coordinator.resolveSessionOwnership(sessionPath)).toEqual({
      agentId: "dave", source: "path", agentDeleted: false,
    });
  });

  it("sessionId 引用同样解析归属", () => {
    const sessionPath = makeSessionFile("hana", "epsilon.jsonl");
    const manifest = store.createForPath({ sessionPath, ownerAgentId: "hana", domain: "desktop", kind: "chat" });

    const coordinator = createCoordinator();
    expect(coordinator.resolveSessionOwnership({ sessionId: manifest.sessionId })).toEqual({
      agentId: "hana", source: "manifest", agentDeleted: false,
    });
  });

  it("既无 manifest 又不在 agentsDir 下时返回 none", () => {
    const coordinator = createCoordinator();
    expect(coordinator.resolveSessionOwnership(path.join(tempDir, "outside.jsonl"))).toEqual({
      agentId: null, source: "none", agentDeleted: false,
    });
  });

  it("isRunnableSessionPath 以 manifest 归属判定删除态", () => {
    const sessionPath = makeSessionFile("hana", "zeta.jsonl");
    deletedAgents.add("bob");
    store.createForPath({ sessionPath, ownerAgentId: "bob", domain: "desktop", kind: "chat" });

    const coordinator = createCoordinator();
    expect(coordinator.isRunnableSessionPath(sessionPath)).toBe(false);
  });

  it("continueDeletedAgentSession 以 manifest 归属判定 source agent", async () => {
    // 路径在存活 agent 目录、manifest 归属已删除 agent → 应视为可续（不再报 not deleted）
    const sessionPath = makeSessionFile("hana", "eta.jsonl");
    deletedAgents.add("bob");
    store.createForPath({ sessionPath, ownerAgentId: "bob", domain: "desktop", kind: "chat" });

    const coordinator = createCoordinator();
    // 走到 source 判定之后的深层依赖（getPrefs.getPrimaryAgent 等）即可视为通过归属检查：
    // 断言错误信息不再是 'is not deleted'
    await expect(coordinator.continueDeletedAgentSession(sessionPath))
      .rejects.not.toThrow(/is not deleted/);
  });

  it("store 查询抛错时按路径回退且不向调用方抛错（显式契约）", () => {
    const sessionPath = makeSessionFile("hana", "corrupt.jsonl");
    const coordinator = createCoordinator();
    // 模拟 SQLite 页损坏类查询期故障
    coordinator._sessionManifestStore = {
      resolveByLocatorPath: () => { throw new Error("database disk image is malformed"); },
      getBySessionId: () => { throw new Error("database disk image is malformed"); },
    };

    expect(() => coordinator.resolveSessionOwnership(sessionPath)).not.toThrow();
    expect(coordinator.resolveSessionOwnership(sessionPath)).toEqual({
      agentId: "hana", source: "path", agentDeleted: false,
    });
    expect(() => coordinator.resolveSessionOwnership({ sessionId: "sess_broken" })).not.toThrow();
    expect(coordinator.resolveSessionOwnership({ sessionId: "sess_broken" })).toEqual({
      agentId: null, source: "none", agentDeleted: false,
    });
  });
});
