import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSessionMock,
  repairInlineMediaMock,
  sessionManagerOpenMock,
} = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  repairInlineMediaMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: vi.fn(),
    open: sessionManagerOpenMock,
  },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
  estimateTokens: vi.fn(() => 0),
  findCutPoint: vi.fn(),
  generateSummary: vi.fn(),
  emitSessionShutdown: vi.fn(),
  refreshSessionModelFromRegistry: vi.fn(),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../core/session-inline-media-prune.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    repairSessionInlineMediaEntriesInFile: (...args: any[]) => repairInlineMediaMock(...args),
  };
});

import { SessionCoordinator } from "../core/session-coordinator.ts";

function makeTool(name) {
  return { name, execute: vi.fn() };
}

function makeAgent({ id, sessionDir }) {
  return {
    id,
    agentDir: path.dirname(sessionDir),
    sessionDir,
    tools: [makeTool(`${id}-tool`)],
    config: { locale: "en", tools: {} },
    memoryMasterEnabled: true,
    get memoryEnabled() { return true; },
    get sessionMemoryEnabled() { return true; },
    setMemoryEnabled: vi.fn(),
    getToolsSnapshot: vi.fn(() => [makeTool(`${id}-tool`)]),
    buildSystemPrompt: vi.fn(() => `${id.toUpperCase()} PROMPT`),
  };
}

function makeRestoredSession(sessionPath) {
  return {
    sessionManager: { getSessionFile: () => sessionPath },
    subscribe: vi.fn(() => vi.fn()),
    setActiveToolsByName: vi.fn(),
    model: { id: "restored-model", provider: "test" },
  };
}

function makeCoordinator({ agentsDir, ownerAgent, tempDir }) {
  return new SessionCoordinator({
    agentsDir,
    getAgent: () => ownerAgent,
    getActiveAgentId: () => "owner",
    getModels: () => ({
      currentModel: { id: "owner-model", provider: "test" },
      availableModels: [{ id: "restored-model", provider: "test" }],
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: () => "medium",
    }),
    getResourceLoader: () => ({
      getSystemPrompt: () => "BASE PROMPT",
      getAppendSystemPrompt: () => [],
      getExtensions: () => ({ extensions: [], errors: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
    }),
    getSkills: () => ({
      getSkillsForAgent: vi.fn(() => ({ skills: [], diagnostics: [] })),
    }),
    buildTools: (_cwd, customTools) => ({
      tools: [makeTool("read")],
      customTools,
    }),
    emitEvent: vi.fn(),
    getHomeCwd: () => tempDir,
    agentIdFromSessionPath: () => "owner",
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: (id) => (id === "owner" ? ownerAgent : null),
    listAgents: () => [],
  });
}

describe("SessionCoordinator ensureSessionLoaded concurrency", () => {
  let tempDir;
  let agentsDir;
  let ownerSessionDir;
  let sessionPath;
  let ownerAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    repairInlineMediaMock.mockReturnValue({
      repaired: false,
      stripped: 0,
      strippedImages: 0,
      strippedVideos: 0,
      strippedAudios: 0,
    });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-ensure-race-"));
    agentsDir = path.join(tempDir, "agents");
    ownerSessionDir = path.join(agentsDir, "owner", "sessions");
    fs.mkdirSync(ownerSessionDir, { recursive: true });
    sessionPath = path.join(ownerSessionDir, "shared.jsonl");
    fs.writeFileSync(
      path.join(ownerSessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(sessionPath)]: { memoryEnabled: true } }, null, 2),
    );
    ownerAgent = makeAgent({ id: "owner", sessionDir: ownerSessionDir });
    sessionManagerOpenMock.mockImplementation(() => ({ getCwd: () => tempDir }));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("deduplicates concurrent loads of the same session path into one AgentSession", async () => {
    // 每次 createAgentSession 都造一个新实例：如果双加载发生，两个 caller 会拿到不同对象
    let releaseFirstCreate;
    const firstCreateGate = new Promise((resolve) => { releaseFirstCreate = resolve; });
    createAgentSessionMock.mockImplementation(async () => {
      await firstCreateGate;
      return { session: makeRestoredSession(sessionPath) };
    });

    const coordinator = makeCoordinator({ agentsDir, ownerAgent, tempDir });

    const p1 = coordinator.ensureSessionLoaded(sessionPath);
    const p2 = coordinator.ensureSessionLoaded(sessionPath);
    releaseFirstCreate();
    const [s1, s2] = await Promise.all([p1, p2]);

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(s1).toBe(s2);
    expect(coordinator._sessions.size).toBe(1);
  });

  it("propagates a load failure to all concurrent callers and allows a fresh retry afterwards", async () => {
    createAgentSessionMock.mockRejectedValueOnce(new Error("provider exploded"));

    const coordinator = makeCoordinator({ agentsDir, ownerAgent, tempDir });

    const p1 = coordinator.ensureSessionLoaded(sessionPath);
    const p2 = coordinator.ensureSessionLoaded(sessionPath);
    await expect(p1).rejects.toThrow("provider exploded");
    await expect(p2).rejects.toThrow("provider exploded");

    // 失败后 in-flight 记录必须清除，后续调用可重新加载
    createAgentSessionMock.mockImplementation(async () => ({
      session: makeRestoredSession(sessionPath),
    }));
    const retried = await coordinator.ensureSessionLoaded(sessionPath);
    expect(retried.sessionManager.getSessionFile()).toBe(sessionPath);
    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
  });

  it("returns the cached entry without re-creating once a load has settled", async () => {
    createAgentSessionMock.mockImplementation(async () => ({
      session: makeRestoredSession(sessionPath),
    }));

    const coordinator = makeCoordinator({ agentsDir, ownerAgent, tempDir });

    const first = await coordinator.ensureSessionLoaded(sessionPath);
    const second = await coordinator.ensureSessionLoaded(sessionPath);
    expect(second).toBe(first);
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
  });
});
