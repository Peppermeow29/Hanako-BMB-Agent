/**
 * session-meta 运行期隔离记录：_quarantineOversizedSessionMeta 成功 rename 后
 * 必须把隔离详情记进内存态 _metaQuarantines，供 engine.getSessionMetadataRecoveryStatus()
 * 聚合成侧边栏"部分会话待恢复"提示。
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: vi.fn(),
  emitSessionShutdown: vi.fn(),
  SessionManager: {
    create: vi.fn(),
    list: vi.fn(),
    open: vi.fn(),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
  resizeModelImageInput: vi.fn(async (image) => image),
  formatModelImageDimensionNote: vi.fn(() => undefined),
  refreshSessionModelFromRegistry: vi.fn(),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { SessionCoordinator } from "../core/session-coordinator.ts";

function minimalCoordinator() {
  return new SessionCoordinator({
    agentsDir: "/tmp/agents",
    getAgent: () => null,
    getActiveAgentId: () => "hana",
    getModels: () => ({ currentModel: null, authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
    getResourceLoader: () => ({}),
    getSkills: () => null,
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: () => {},
    getHomeCwd: () => "/tmp/home",
    agentIdFromSessionPath: () => null,
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: () => null,
    listAgents: () => [],
  });
}

describe("SessionCoordinator meta quarantine bookkeeping", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-coord-meta-quarantine-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts with an empty quarantine list", () => {
    const coordinator = minimalCoordinator();
    expect(coordinator.listMetaQuarantines()).toEqual([]);
  });

  it("records metaPath/backupPath/quarantinedAt after a successful rename", async () => {
    const metaDir = path.join(tmpDir, "agents", "hana", "sessions");
    fs.mkdirSync(metaDir, { recursive: true });
    const metaPath = path.join(metaDir, "session-meta.json");
    fs.writeFileSync(metaPath, "{}");

    const coordinator = minimalCoordinator();
    await coordinator._quarantineOversizedSessionMeta(metaPath);

    const quarantines = coordinator.listMetaQuarantines();
    expect(quarantines).toHaveLength(1);
    expect(quarantines[0]).toMatchObject({ metaPath });
    expect(typeof quarantines[0].backupPath).toBe("string");
    expect(quarantines[0].backupPath).not.toBe(metaPath);
    expect(fs.existsSync(quarantines[0].backupPath)).toBe(true);
    expect(fs.existsSync(metaPath)).toBe(false);
    expect(typeof quarantines[0].quarantinedAt).toBe("string");
    expect(() => new Date(quarantines[0].quarantinedAt).toISOString()).not.toThrow();
  });

  it("does not record anything when the source file does not exist (rename ENOENT)", async () => {
    const coordinator = minimalCoordinator();
    await coordinator._quarantineOversizedSessionMeta(path.join(tmpDir, "does-not-exist.json"));
    expect(coordinator.listMetaQuarantines()).toEqual([]);
  });
});
