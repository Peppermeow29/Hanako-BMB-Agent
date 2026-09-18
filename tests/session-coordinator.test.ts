import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

const {
  createAgentSessionMock,
  sessionManagerCreateMock,
  sessionManagerListMock,
  emitSessionShutdownMock,
  estimateTokensMock,
  refreshSessionModelFromRegistryMock,
  runAgentLoopMock,
  moduleLogMock,
} = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  sessionManagerListMock: vi.fn(),
  emitSessionShutdownMock: vi.fn(),
  estimateTokensMock: vi.fn((message) => JSON.stringify(message).length),
  refreshSessionModelFromRegistryMock: vi.fn(),
  runAgentLoopMock: vi.fn(),
  moduleLogMock: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  emitSessionShutdown: emitSessionShutdownMock,
  estimateTokens: estimateTokensMock,
  runAgentLoop: runAgentLoopMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    list: sessionManagerListMock,
    open: vi.fn(),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
  resizeModelImageInput: vi.fn(async (image) => image),
  formatModelImageDimensionNote: vi.fn(() => undefined),
  refreshSessionModelFromRegistry: refreshSessionModelFromRegistryMock,
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => moduleLogMock,
}));

import { SessionCoordinator } from "../core/session-coordinator.ts";
import { EnvChangeLedger } from "../core/env-change-ledger.ts";
import { VisionBridge, VISION_CONTEXT_START } from "../core/vision-bridge.ts";
import { createUsageLedger } from "../lib/llm/usage-ledger.ts";
import { BrowserManager } from "../lib/browser/browser-manager.ts";
import { DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID } from "../lib/experiments/registry.ts";
import { SessionManager } from "../lib/pi-sdk/index.js";
import { SessionManifestStore } from "../core/session-manifest/store.ts";

const PNG_BASE64 = "iVBORw0KGgo=";

function createTestSessionManifestStore() {
  let nextId = 0;
  const manifestsByPath = new Map<string, any>();
  const manifestsById = new Map<string, any>();
  return {
    resolveByLocatorPath: vi.fn((sessionPath) => manifestsByPath.get(sessionPath) || null),
    getBySessionId: vi.fn((sessionId) => manifestsById.get(sessionId) || null),
    createForPath: vi.fn((input) => {
      const existing = manifestsByPath.get(input.sessionPath);
      if (existing) return existing;
      const manifest = {
        ...input,
        sessionId: `sess_test_${++nextId}`,
        lifecycle: input.lifecycle || "active",
        currentLocator: { path: input.sessionPath },
      };
      manifestsByPath.set(input.sessionPath, manifest);
      manifestsById.set(manifest.sessionId, manifest);
      return manifest;
    }),
    updateLocatorLifecycle: vi.fn((sessionId, sessionPath, lifecycle) => {
      const current = manifestsById.get(sessionId);
      if (!current) return null;
      if (current.currentLocator?.path) manifestsByPath.delete(current.currentLocator.path);
      const updated = { ...current, lifecycle, currentLocator: { path: sessionPath } };
      manifestsByPath.set(sessionPath, updated);
      manifestsById.set(sessionId, updated);
      return updated;
    }),
  };
}

describe("SessionCoordinator", () => {
  let tempDir;

  beforeEach(() => {
    vi.clearAllMocks();
    refreshSessionModelFromRegistryMock.mockImplementation((session, allowedModel) => {
      if (allowedModel !== undefined) {
        if (session?.agent?.state) session.agent.state.model = allowedModel;
        if (session && Object.prototype.hasOwnProperty.call(session, "model")) session.model = allowedModel;
      }
      return true;
    });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-coordinator-"));
    sessionManagerCreateMock.mockReturnValue({ getCwd: () => "/tmp/workspace" });
    sessionManagerListMock.mockResolvedValue([]);
    emitSessionShutdownMock.mockResolvedValue(false);
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("builds the session prompt with path-scoped memory without mutating the agent session flag", async () => {
    const agent = {
      sessionDir: "/tmp/agent-sessions",
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: ({ forceMemoryEnabled }: any = {}) =>
        forceMemoryEnabled ? "MEMORY ON" : "MEMORY OFF",
    };

    const resourceLoader = {
      getSystemPrompt: () => "BASE",
    };

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => resourceLoader,
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

    await coordinator.createSession(null, "/tmp/workspace", false);

    expect(agent.setMemoryEnabled).not.toHaveBeenCalled();
    expect(createAgentSessionMock).toHaveBeenCalledOnce();
    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("MEMORY OFF");
  });

  it("keeps the base prompt cwd-free and appends the fresh workspace scope and instructions", async () => {
    const newCwd = path.join(tempDir, "new-workspace");
    const oldCwd = path.join(tempDir, "old-workspace");
    const externalFolder = path.join(tempDir, "external-reference");
    fs.mkdirSync(path.join(newCwd, ".git"), { recursive: true });
    fs.mkdirSync(oldCwd, { recursive: true });
    fs.mkdirSync(externalFolder, { recursive: true });
    fs.writeFileSync(path.join(newCwd, "AGENTS.md"), "SESSION_INSTRUCTION_BEACON\n", "utf-8");

    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      config: {
        locale: "zh-CN",
        workspace_context: { inject_agents_md: true },
      },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => "stable agent base"),
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "m", provider: "test" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      getHomeCwd: () => oldCwd,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, newCwd, true, null, {
      workspaceFolders: [externalFolder],
    });

    expect(agent.buildSystemPrompt).toHaveBeenCalledWith(expect.not.objectContaining({
      cwdOverride: expect.anything(),
    }));
    const createArgs = createAgentSessionMock.mock.calls[0][0];
    expect(createArgs.resourceLoader.getSystemPrompt()).toBe("stable agent base");
    const append = createArgs.resourceLoader.getAppendSystemPrompt();
    const joinedAppend = append.join("\n\n");
    expect(joinedAppend).toContain("## 工作区范围");
    expect(joinedAppend).toContain(`主工作台：${newCwd}`);
    expect(joinedAppend).toContain("外部工作区文件夹");
    expect(joinedAppend).toContain(externalFolder);
    expect(joinedAppend).toContain("## 工作区说明");
    expect(joinedAppend).toContain("SESSION_INSTRUCTION_BEACON");
    expect(joinedAppend.indexOf("## 工作区范围")).toBeLessThan(joinedAppend.indexOf("## 工作区说明"));
    expect(joinedAppend).not.toContain("当前工作目录");
    expect(joinedAppend).not.toContain("相对路径");
  });

  it("restores the missing default workspace only for fresh sessions using the configured home cwd", async () => {
    const homeDir = path.join(tempDir, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    try {
      const defaultPath = path.join(homeDir, "Desktop", "OH-WorkSpace");
      const movedHome = path.join(tempDir, "moved-home");
      fs.mkdirSync(movedHome, { recursive: true });

      const agent = {
        id: "hana",
        agentDir: path.join(tempDir, "agents", "hana"),
        sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
        memoryMasterEnabled: true,
        sessionMemoryEnabled: true,
        setMemoryEnabled: vi.fn(),
        buildSystemPrompt: () => "BASE",
        config: {},
        tools: [],
      };
      fs.mkdirSync(agent.sessionDir, { recursive: true });

      const model = { id: "m", provider: "test" };
      const getHomeCwd = vi.fn(() => defaultPath);
      const coordinator = new SessionCoordinator({
        agentsDir: path.join(tempDir, "agents"),
        getAgent: () => agent,
        getActiveAgentId: () => "hana",
        getModels: () => ({
          currentModel: model,
          authStorage: {},
          modelRegistry: {},
          resolveThinkingLevel: (level) => level,
        }),
        getResourceLoader: () => ({
          getSystemPrompt: () => "BASE",
          getAppendSystemPrompt: () => [],
          getExtensions: () => ({ extensions: [], errors: [] }),
          getSkills: () => ({ skills: [], diagnostics: [] }),
          getAgentsFiles: () => ({ agentsFiles: [] }),
        }),
        getSkills: () => null,
        buildTools: () => ({ tools: [], customTools: [] }),
        emitEvent: vi.fn(),
        getHomeCwd,
        agentIdFromSessionPath: () => "hana",
        switchAgentOnly: async () => {},
        getConfig: () => ({}),
        getPrefs: () => ({ getThinkingLevel: () => "medium" }),
        getAgents: () => new Map([["hana", agent]]),
        getActivityStore: () => null,
        getAgentById: () => agent,
        listAgents: () => [],
      });
      const makeSessionManager = (name: string) => ({
        getCwd: () => defaultPath,
        getSessionFile: () => path.join(agent.sessionDir, name),
      });

      await coordinator.createSession(null, null, true);
      expect(fs.existsSync(defaultPath)).toBe(true);
      expect(sessionManagerCreateMock).toHaveBeenCalledWith(defaultPath, agent.sessionDir);

      fs.rmSync(path.join(homeDir, "Desktop"), { recursive: true, force: true });

      await coordinator.createSession(makeSessionManager("legacy-default.jsonl"), defaultPath, true, null, { restore: true });
      expect(fs.existsSync(defaultPath)).toBe(false);
      expect(createAgentSessionMock.mock.calls.at(-1)?.[0]?.cwd).toBe(defaultPath);

      getHomeCwd.mockReturnValue(movedHome);

      await coordinator.createSession(makeSessionManager("legacy-default-moved.jsonl"), defaultPath, true, null, { restore: true });
      expect(fs.existsSync(defaultPath)).toBe(false);
      expect(createAgentSessionMock.mock.calls.at(-1)?.[0]?.cwd).toBe(defaultPath);
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it("refreshes agent appearance after the fresh session exists instead of blocking prompt snapshot", async () => {
    const order: string[] = [];
    const agent = {
      sessionDir: "/tmp/agent-sessions",
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      refreshAppearanceSummary: vi.fn(async () => {
        order.push("refresh");
        return "你的形象安静而专注。";
      }),
      buildSystemPrompt: vi.fn(() => {
        order.push("prompt");
        return "BASE";
      }),
    };

    createAgentSessionMock.mockImplementationOnce(async (opts) => {
      order.push("create");
      return {
        session: {
          sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
          model: opts.model,
        },
      };
    });

    const model = { id: "vision-chat", provider: "test", input: ["text", "image"] };
    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: model,
        availableModels: [model],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agent.refreshAppearanceSummary).toHaveBeenCalledWith({
      targetModel: model,
      rebuildSystemPrompt: true,
    });
    expect(order).toEqual(["prompt", "create", "refresh"]);
  });

  it("keeps different cached session memory flags without mutating the agent session flag on switch", async () => {
    const agentDir = path.join(tempDir, "agents", "hana");
    const sessionDir = path.join(agentDir, "sessions");
    const firstSessionPath = path.join(sessionDir, "memory-on.jsonl");
    const secondSessionPath = path.join(sessionDir, "memory-off.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });

    const agent = {
      id: "hana",
      agentDir,
      sessionDir,
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      config: { tools: {} },
      setMemoryEnabled: vi.fn(),
      getToolsSnapshot: vi.fn(({ forceMemoryEnabled }: any = {}) =>
        forceMemoryEnabled ? [{ name: "search_memory" }] : [{ name: "todo_write" }],
      ),
      buildSystemPrompt: vi.fn(({ forceMemoryEnabled }: any = {}) =>
        forceMemoryEnabled ? "MEMORY ON" : "MEMORY OFF",
      ),
      tools: [],
      _memoryTicker: { notifySessionEnd: vi.fn(async () => undefined) },
    };
    const model = { id: "m", provider: "test", name: "M" };
    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: model,
        availableModels: [model],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level) => level,
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: (_cwd, customTools) => ({ tools: [], customTools }),
      emitEvent: vi.fn(),
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map([["hana", agent]]),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    sessionManagerCreateMock
      .mockReturnValueOnce({ getCwd: () => tempDir, getSessionFile: () => firstSessionPath })
      .mockReturnValueOnce({ getCwd: () => tempDir, getSessionFile: () => secondSessionPath });
    createAgentSessionMock
      .mockResolvedValueOnce({
        session: {
          sessionManager: { getSessionFile: () => firstSessionPath, getCwd: () => tempDir },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
          isStreaming: false,
          isCompacting: false,
          model,
        },
      })
      .mockResolvedValueOnce({
        session: {
          sessionManager: { getSessionFile: () => secondSessionPath, getCwd: () => tempDir },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
          isStreaming: false,
          isCompacting: false,
          model,
        },
      });

    await coordinator.createSession(null, tempDir, true);
    await coordinator.createSession(null, tempDir, false);
    agent.setMemoryEnabled.mockClear();

    await coordinator.switchSession(firstSessionPath);
    expect(coordinator.getSessionMemoryEnabled(firstSessionPath)).toBe(true);
    expect(coordinator.getSessionMemoryEnabled(secondSessionPath)).toBe(false);
    expect(agent.setMemoryEnabled).not.toHaveBeenCalled();
    expect(agent.sessionMemoryEnabled).toBe(true);

    await coordinator.switchSession(secondSessionPath);
    expect(coordinator.getSessionMemoryEnabled(firstSessionPath)).toBe(true);
    expect(coordinator.getSessionMemoryEnabled(secondSessionPath)).toBe(false);
    expect(agent.setMemoryEnabled).not.toHaveBeenCalled();
    expect(agent.sessionMemoryEnabled).toBe(true);
  });

  it("uses explicit new-session thinking without changing the global default", async () => {
    const agentDir = path.join(tempDir, "agents", "hana");
    const sessionDir = path.join(agentDir, "sessions");
    const firstSessionPath = path.join(sessionDir, "first.jsonl");
    const secondSessionPath = path.join(sessionDir, "second.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });

    const agent = {
      id: "hana",
      agentDir,
      sessionDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: {},
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    const prefs = { getThinkingLevel: vi.fn(() => "medium") };
    const model = { id: "m", provider: "test" };
    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: model,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level) => level,
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => prefs,
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    sessionManagerCreateMock
      .mockReturnValueOnce({ getCwd: () => tempDir, getSessionFile: () => firstSessionPath })
      .mockReturnValueOnce({ getCwd: () => tempDir, getSessionFile: () => secondSessionPath });
    createAgentSessionMock
      .mockResolvedValueOnce({
        session: {
          sessionManager: { getSessionFile: () => firstSessionPath },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
          setThinkingLevel: vi.fn(),
          model,
        },
      })
      .mockResolvedValueOnce({
        session: {
          sessionManager: { getSessionFile: () => secondSessionPath },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
          setThinkingLevel: vi.fn(),
          model,
        },
      });

    await coordinator.createSession(null, tempDir, true, null, { thinkingLevel: "high" });
    await coordinator.createSession(null, tempDir, true);

    expect(createAgentSessionMock.mock.calls[0][0].thinkingLevel).toBe("high");
    expect(createAgentSessionMock.mock.calls[1][0].thinkingLevel).toBe("medium");
    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta["first.jsonl"].thinkingLevel).toBe("high");
    expect(meta["second.jsonl"].thinkingLevel).toBe("medium");
  });

  it("persists a new session before the first assistant response and keeps the prefix non-duplicated", async () => {
    const agentDir = path.join(tempDir, "agents", "hana");
    const sessionDir = path.join(agentDir, "sessions");
    const sessionPath = path.join(sessionDir, "first-turn-failure.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });

    const header = {
      type: "session",
      version: 3,
      id: "sess-first-turn",
      timestamp: "2026-06-14T12:00:00.000Z",
      cwd: tempDir,
    };
    const sessionManager: any = {
      fileEntries: [header],
      flushed: false,
      getCwd: () => tempDir,
      getSessionFile: () => sessionPath,
      _rewriteFile: vi.fn(function () {
        fs.writeFileSync(
          sessionPath,
          `${this.fileEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
          "utf-8",
        );
      }),
    };
    let listener: any = null;
    const model = { id: "m", provider: "test" };
    const agent = {
      id: "hana",
      name: "Hana",
      agentName: "Hana",
      agentDir,
      sessionDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: {},
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: model,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level) => level,
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map([["hana", agent]]),
      listAgents: () => [agent],
      getActivityStore: () => null,
      getAgentById: () => agent,
    });

    sessionManagerCreateMock.mockReturnValueOnce(sessionManager);
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager,
        subscribe: vi.fn((fn) => {
          listener = fn;
          return vi.fn();
        }),
        setActiveToolsByName: vi.fn(),
        setThinkingLevel: vi.fn(),
        model,
      },
    });

    await coordinator.createSession(null, tempDir, true);

    expect(fs.existsSync(sessionPath)).toBe(true);
    expect(sessionManager.flushed).toBe(true);
    expect(JSON.parse(fs.readFileSync(sessionPath, "utf-8").trim())).toMatchObject({
      type: "session",
      id: "sess-first-turn",
    });
    expect((await coordinator.listSessions()).some((session) => session.path === sessionPath)).toBe(true);

    const userEntry = {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-06-14T12:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "look at this image" }],
        timestamp: Date.now(),
      },
    };
    listener?.({ type: "message_end", message: userEntry.message });
    sessionManager.fileEntries.push(userEntry);
    sessionManager.flushed = false;
    await Promise.resolve();

    let lines = fs.readFileSync(sessionPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.filter((entry) => entry.type === "session")).toHaveLength(1);
    expect(lines.filter((entry) => entry.type === "message")).toHaveLength(1);
    expect(sessionManager.flushed).toBe(true);

    const assistantEntry = {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-06-14T12:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        timestamp: Date.now(),
      },
    };
    sessionManager.fileEntries.push(assistantEntry);
    if (sessionManager.flushed) {
      fs.appendFileSync(sessionPath, `${JSON.stringify(assistantEntry)}\n`, "utf-8");
    } else {
      sessionManager._rewriteFile();
    }

    lines = fs.readFileSync(sessionPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.filter((entry) => entry.type === "session")).toHaveLength(1);
    expect(lines.filter((entry) => entry.type === "message")).toHaveLength(2);
  });

  it("uses the model-level thinking default for new sessions without an explicit draft", async () => {
    const agentDir = path.join(tempDir, "agents", "hana");
    const sessionDir = path.join(agentDir, "sessions");
    const sessionPath = path.join(sessionDir, "model-default.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });

    const agent = {
      id: "hana",
      agentDir,
      sessionDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: {},
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    const prefs = { getThinkingLevel: vi.fn(() => "medium") };
    const model = { id: "m", provider: "test", defaultThinkingLevel: "high" };
    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: model,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level) => level,
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => prefs,
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    sessionManagerCreateMock.mockReturnValueOnce({ getCwd: () => tempDir, getSessionFile: () => sessionPath });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionPath },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        setThinkingLevel: vi.fn(),
        model,
      },
    });

    await coordinator.createSession(null, tempDir, true);

    expect(createAgentSessionMock.mock.calls[0][0].thinkingLevel).toBe("high");
    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta["model-default.jsonl"].thinkingLevel).toBe("high");
  });

  it("freezes the DeepSeek roleplay reasoning patch experiment per session", async () => {
    const agentDir = path.join(tempDir, "agents", "hana");
    const sessionDir = path.join(agentDir, "sessions");
    const sessionPath = path.join(sessionDir, "deepseek-experiment.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "description.md"),
      "<!-- sourceHash: abc -->\n沉静细腻的文学型助手，擅长写作、翻译和情感分析。\n",
      "utf-8",
    );

    const agent = {
      id: "hana",
      agentName: "青岚",
      agentDir,
      sessionDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    const prefs = {
      getThinkingLevel: vi.fn(() => "high"),
      getExperimentValue: vi.fn((id) => (
        id === DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID ? true : undefined
      )),
    };
    const model = { id: "deepseek-v4-pro", provider: "deepseek", reasoning: true };
    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: model,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level) => level,
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => prefs,
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    sessionManagerCreateMock.mockReturnValueOnce({ getCwd: () => tempDir, getSessionFile: () => sessionPath });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionPath },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        setThinkingLevel: vi.fn(),
        model,
      },
    });

    await coordinator.createSession(null, tempDir, true);

    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta["deepseek-experiment.jsonl"].experiments).toEqual({
      deepseekRoleplayReasoningPatch: true,
      deepseekRoleplayReasoningContext: {
        locale: "zh-CN",
        agentName: "青岚",
        agentDescription: "沉静细腻的文学型助手，擅长写作、翻译和情感分析。",
      },
    });
    expect(coordinator.isDeepSeekRoleplayReasoningPatchEnabled(sessionPath)).toBe(true);
    expect(coordinator.getDeepSeekRoleplayReasoningContext(sessionPath)).toEqual({
      locale: "zh-CN",
      agentName: "青岚",
      agentDescription: "沉静细腻的文学型助手，擅长写作、翻译和情感分析。",
    });

    const offSessionPath = path.join(sessionDir, "deepseek-experiment-off.jsonl");
    prefs.getExperimentValue.mockReturnValue(undefined);
    sessionManagerCreateMock.mockReturnValueOnce({ getCwd: () => tempDir, getSessionFile: () => offSessionPath });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => offSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        setThinkingLevel: vi.fn(),
        model,
      },
    });

    await coordinator.createSession(null, tempDir, true);

    const updatedMeta = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(updatedMeta["deepseek-experiment-off.jsonl"].experiments).toBeUndefined();
    expect(coordinator.isDeepSeekRoleplayReasoningPatchEnabled(offSessionPath)).toBe(false);

    const noDescriptionSessionPath = path.join(sessionDir, "deepseek-experiment-no-description.jsonl");
    fs.rmSync(path.join(agentDir, "description.md"), { force: true });
    (agent.config as any).agent = { description: "不应替代花名册简介" };
    prefs.getExperimentValue.mockImplementation((id) => (
      id === DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID ? true : undefined
    ));
    sessionManagerCreateMock.mockReturnValueOnce({ getCwd: () => tempDir, getSessionFile: () => noDescriptionSessionPath });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => noDescriptionSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        setThinkingLevel: vi.fn(),
        model,
      },
    });

    await coordinator.createSession(null, tempDir, true);

    const noDescriptionMeta = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(noDescriptionMeta["deepseek-experiment-no-description.jsonl"].experiments).toEqual({
      deepseekRoleplayReasoningPatch: true,
      deepseekRoleplayReasoningContext: {
        locale: "zh-CN",
        agentName: "青岚",
      },
    });

    const restoredCoordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: model,
        authStorage: {},
        modelRegistry: {},
        availableModels: [model],
        resolveThinkingLevel: (level) => level,
      }),
      getResourceLoader: () => ({ getAppendSystemPrompt: () => [] }),
      getPrefs: () => ({ getThinkingLevel: () => "high" }),
      agentIdFromSessionPath: () => "hana",
    });
    expect(restoredCoordinator.isDeepSeekRoleplayReasoningPatchEnabled(sessionPath)).toBe(true);
    expect(restoredCoordinator.getDeepSeekRoleplayReasoningContext(sessionPath)).toEqual({
      locale: "zh-CN",
      agentName: "青岚",
      agentDescription: "沉静细腻的文学型助手，擅长写作、翻译和情感分析。",
    });

    const legacySessionPath = path.join(sessionDir, "legacy.jsonl");
    expect(restoredCoordinator.isDeepSeekRoleplayReasoningPatchEnabled(legacySessionPath)).toBe(false);
  });

  it("persists authorized folders without adding them to the session prompt snapshot", async () => {
    const agentDir = path.join(tempDir, "hana");
    const sessionDir = path.join(agentDir, "sessions");
    const sessionPath = path.join(sessionDir, "authorized-folders.jsonl");
    const cwd = path.join(tempDir, "project");
    const workspaceFolder = path.join(tempDir, "reference");
    const authorizedFolder = path.join(tempDir, "assets");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(workspaceFolder, { recursive: true });
    fs.mkdirSync(authorizedFolder, { recursive: true });
    sessionManagerCreateMock.mockReturnValueOnce({
      getCwd: () => cwd,
      getSessionFile: () => sessionPath,
    });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionPath },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        model: { id: "model-a", provider: "provider-a" },
      },
    });
    const buildTools = vi.fn(() => ({ tools: [], customTools: [] }));
    const agent = {
      id: "hana",
      agentDir,
      sessionDir,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "model-a", provider: "provider-a" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => cwd,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, cwd, true, null, {
      workspaceFolders: [workspaceFolder],
      authorizedFolders: [authorizedFolder],
    });

    const buildOpts = (buildTools.mock.calls as any)[0][2];
    expect(buildOpts!.workspaceFolders).toEqual([workspaceFolder]);
    expect(buildOpts!.authorizedFolders).toEqual([authorizedFolder]);
    expect(buildOpts!.getAuthorizedFolders()).toEqual([authorizedFolder]);
    expect(coordinator.getSessionAuthorizedFolders(sessionPath)).toEqual([authorizedFolder]);
    expect(coordinator.getSessionFolderScope(sessionPath)).toMatchObject({
      cwd,
      workspaceFolders: [workspaceFolder],
      authorizedFolders: [authorizedFolder],
      sandboxFolders: [cwd, workspaceFolder, authorizedFolder],
    });

    const resourceLoader = createAgentSessionMock.mock.calls.at(-1)[0].resourceLoader;
    const appendPrompt = resourceLoader.getAppendSystemPrompt().join("\n");
    expect(appendPrompt).toContain(workspaceFolder);
    expect(appendPrompt).not.toContain(authorizedFolder);

    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)].authorizedFolders).toEqual([authorizedFolder]);
  });

  it("attributes assistant usage to the model recorded on the message after a session model switch", async () => {
    const sessionPath = path.join(tempDir, "usage-model-switch.jsonl");
    const initialModel = {
      id: "model-a",
      provider: "provider-a",
      api: "openai-completions",
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    };
    const switchedModel = {
      id: "model-b",
      provider: "provider-b",
      api: "openai-completions",
      cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
    };
    const subscribers = [];
    const ledger = createUsageLedger({ requestIdFactory: () => `usage-${subscribers.length}` });
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      config: {},
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionPath },
        subscribe: vi.fn((fn) => {
          subscribers.push(fn);
          return vi.fn();
        }),
        setActiveToolsByName: vi.fn(),
        model: initialModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: initialModel,
        availableModels: [initialModel, switchedModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      getUsageLedger: () => ledger,
    });

    await coordinator.createSession(null, tempDir, true, initialModel);
    subscribers[0]({
      type: "message_end",
      message: {
        role: "assistant",
        api: "openai-completions",
        provider: "provider-b",
        model: "model-b",
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        stopReason: "stop",
      },
    });

    const entry = ledger.list({}).entries[0];
    expect(entry).toMatchObject({
      model: {
        provider: "provider-b",
        modelId: "model-b",
        api: "openai-completions",
      },
      usage: {
        input: { totalTokens: 100 },
        output: { totalTokens: 10 },
        costTotal: 0.00023,
      },
    });
  });

  it("does not use the fallback model cost when the assistant message model cannot be resolved", async () => {
    const sessionPath = path.join(tempDir, "usage-unresolved-message-model.jsonl");
    const initialModel = {
      id: "model-a",
      provider: "provider-a",
      api: "openai-completions",
      cost: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
    };
    const subscribers = [];
    const ledger = createUsageLedger({ requestIdFactory: () => `usage-unresolved-${subscribers.length}` });
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      config: {},
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionPath },
        subscribe: vi.fn((fn) => {
          subscribers.push(fn);
          return vi.fn();
        }),
        setActiveToolsByName: vi.fn(),
        model: initialModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: initialModel,
        availableModels: [initialModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      getUsageLedger: () => ledger,
    });

    await coordinator.createSession(null, tempDir, true, initialModel);
    subscribers[0]({
      type: "message_end",
      message: {
        role: "assistant",
        api: "openai-completions",
        provider: "provider-b",
        model: "model-b",
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        stopReason: "stop",
      },
    });

    const entry = ledger.list({}).entries[0];
    expect(entry).toMatchObject({
      model: {
        provider: "provider-b",
        modelId: "model-b",
        api: "openai-completions",
      },
      usage: {
        input: { totalTokens: 100 },
        output: { totalTokens: 10 },
        costTotal: null,
      },
    });
  });

  it("injects restored vision sidecar notes without reading stale Pi context getters", async () => {
    const sessionFile = path.join(tempDir, "vision-restore.jsonl");
    const imagePath = path.join(tempDir, "upload.png");
    const textOnlyModel = { id: "deepseek-chat", provider: "deepseek", input: ["text"] };
    const callText = vi.fn(async () => [
      "image_overview: A screenshot with a red error banner.",
      "user_request_answer: The error banner is the relevant visual detail.",
      "evidence: red banner.",
      "uncertainty: none.",
    ].join("\n"));
    const visionBridge = new VisionBridge({
      resolveVisionConfig: () => ({
        model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
        api: "openai-completions",
        api_key: "sk-test",
        base_url: "https://example.test/v1",
      }),
      callText,
    });
    await visionBridge.prepare({
      sessionPath: sessionFile,
      targetModel: textOnlyModel,
      text: `[attached_image: ${imagePath}]\nwhat is this?`,
      images: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
      imageAttachmentPaths: [imagePath],
    });
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        model: textOnlyModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: textOnlyModel,
        availableModels: [textOnlyModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      getEngine: () => ({
        isVisionAuxiliaryEnabled: () => true,
        getVisionBridge: () => visionBridge,
        getSessionFile: vi.fn(),
        getSessionFileByPath: vi.fn(),
      }),
    });

    await coordinator.createSession(null, tempDir, true);

    const resourceLoader = createAgentSessionMock.mock.calls.at(-1)[0].resourceLoader;
    const extension = resourceLoader.getExtensions().extensions
      .find((entry) => entry.path === "hana-desktop-vision-context-injection");
    const handler = extension.handlers.get("context")[0];
    const staleCtx = {
      get sessionManager() {
        throw new Error("stale session manager");
      },
      get model() {
        throw new Error("stale model");
      },
    };

    const result = await handler({
      messages: [{
        role: "user",
        content: [{ type: "text", text: `[attached_image: ${imagePath}]\nwhat is this?` }],
      }],
    }, staleCtx);

    expect(result.messages[0].content[0].text).toContain(VISION_CONTEXT_START);
    expect(result.messages[0].content[0].text).toContain("image_overview");
  });

  it("passes desktop steer text to the SDK without adding an internal prefix", () => {
    const sessionPath = path.join(tempDir, "steer.jsonl");
    const session = {
      isStreaming: true,
      steer: vi.fn(),
    };
    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => null,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => null,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });
    const entry = {
      session,
      agentId: "hana",
      lastTouchedAt: 0,
      visibleInSessionList: true,
    };
    coordinator._sessions.set(sessionPath, entry);
    coordinator._renewCachePrefixContract(sessionPath, entry, "test_setup");

    expect(coordinator.steerSession(sessionPath, "先别展开，直接给结论")).toBe(true);
    expect(session.steer).toHaveBeenCalledWith("先别展开，直接给结论");
  });

  it("late-initializes the cache contract for legacy focus prompt and steer instead of failing them", async () => {
    const sessionPath = path.join(tempDir, "focus-preflight.jsonl");
    const model = { id: "test-model", provider: "test", name: "test-model" };
    const session = {
      isStreaming: true,
      model,
      prompt: vi.fn(),
      steer: vi.fn(),
      sessionManager: { getSessionFile: () => sessionPath },
      agent: { state: { model, systemPrompt: "BASE", tools: [] } },
    };
    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => null,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: model,
        availableModels: [model],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => null,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });
    coordinator._sessions.set(sessionPath, {
      session,
      agentId: "hana",
      lastTouchedAt: 0,
      modelAvailability: { available: true },
    });
    coordinator._session = session;
    coordinator._currentSessionPath = sessionPath;

    const entry = coordinator._sessions.get(sessionPath);
    expect(entry.cachePrefixContract).toBeUndefined();

    // 契约缺失只是还没签过，不是用户的错：preflight 就地补签并放行。
    await coordinator.prompt("hello", undefined);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(entry.cachePrefixContract).toBeTruthy();
    expect(entry.cachePrefixContractRenewReason).toBe("late_init");

    expect(() => coordinator.steer("interrupt")).not.toThrow();
    expect(session.steer).toHaveBeenCalledWith("interrupt");
  });

  it("lists sessions from a lightweight projection without delegating to the Pi SDK full scan", async () => {
    const agentsDir = path.join(tempDir, "agents");
    const agentDir = path.join(agentsDir, "hana");
    const sessionDir = path.join(agentDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, "projection.jsonl");
    fs.writeFileSync(sessionFile, [
      JSON.stringify({
        type: "session",
        id: "projection",
        timestamp: "2026-05-17T08:00:00.000Z",
        cwd: "/tmp/projection-workspace",
      }),
      JSON.stringify({
        type: "message",
        id: "u1",
        timestamp: "2026-05-17T08:01:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello projection" }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        timestamp: "2026-05-17T08:02:00.000Z",
        message: {
          role: "assistant",
          content: "hello back",
        },
      }),
      "",
    ].join("\n"));
    fs.writeFileSync(
      path.join(sessionDir, "session-titles.json"),
      JSON.stringify({ [sessionFile]: "Cached title" }, null, 2),
    );
    fs.writeFileSync(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(sessionFile)]: {
          pinnedAt: "2026-05-17T08:03:00.000Z",
          model: { id: "gpt-test", provider: "openai" },
        },
      }, null, 2),
    );

    const coordinator = new SessionCoordinator({
      agentsDir,
      getAgent: () => ({ agentName: "Hana", sessionDir }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [{ id: "hana", name: "Hana" }],
    });

    const first = await coordinator.listSessions();
    const second = await coordinator.listSessions();

    expect(sessionManagerListMock).not.toHaveBeenCalled();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      path: sessionFile,
      title: "Cached title",
      firstMessage: "hello projection",
      messageCount: 2,
      cwd: "/tmp/projection-workspace",
      agentId: "hana",
      agentName: "Hana",
      pinnedAt: "2026-05-17T08:03:00.000Z",
      modelId: "gpt-test",
      modelProvider: "openai",
    });
    expect(first[0].modified.toISOString()).toBe("2026-05-17T08:02:00.000Z");
    expect(second).toEqual(first);
  });

  it("refreshes only the changed session projection when one JSONL file changes", async () => {
    const agentsDir = path.join(tempDir, "agents");
    const sessionDir = path.join(agentsDir, "hana", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, "changing.jsonl");
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", id: "changing", timestamp: "2026-05-17T08:00:00.000Z", cwd: "/tmp/work" }),
      JSON.stringify({ type: "message", id: "u1", timestamp: "2026-05-17T08:01:00.000Z", message: { role: "user", content: "first" } }),
      "",
    ].join("\n"));

    const coordinator = new SessionCoordinator({
      agentsDir,
      getAgent: () => ({ agentName: "Hana", sessionDir }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [{ id: "hana", name: "Hana" }],
    });

    expect((await coordinator.listSessions())[0].messageCount).toBe(1);
    fs.appendFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        id: "a1",
        timestamp: "2026-05-17T08:02:00.000Z",
        message: { role: "assistant", content: "second" },
      }) + "\n",
    );

    const sessions = await coordinator.listSessions();

    expect(sessionManagerListMock).not.toHaveBeenCalled();
    expect(sessions[0].messageCount).toBe(2);
    expect(sessions[0].modified.toISOString()).toBe("2026-05-17T08:02:00.000Z");
  });

  it("passes ownerPluginId through when listing plugin-private sessions", async () => {
    const agentsDir = path.join(tempDir, "agents");
    const sessionDir = path.join(agentsDir, "plugin-agent", "sessions");
    const sessionPath = path.join(sessionDir, "tavern.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });

    const listAgents = vi.fn((options: any = {}) => (
      options.ownerPluginId === "tavern"
        ? [{ id: "plugin-agent", name: "Tavern Agent", plugin: { ownerPluginId: "tavern", visibility: "plugin_private" } }]
        : []
    ));

    const coordinator = Object.create(SessionCoordinator.prototype);
    coordinator._d = {
      agentsDir,
      listAgents,
      listDeletedAgents: () => [],
    };
    coordinator._sessionListProjectionCache = {
      list: vi.fn(async () => [{
        path: sessionPath,
        title: null,
        firstMessage: "",
        modified: new Date("2026-06-07T00:00:00.000Z"),
        messageCount: 0,
        cwd: "/workspace",
      }]),
    };
    coordinator._loadSessionTitlesFor = vi.fn(async () => ({}));
    coordinator._readMetaCached = vi.fn(async () => ({
      [path.basename(sessionPath)]: {
        plugin: {
          ownerPluginId: "tavern",
          kind: "tavern",
          visibility: "plugin_private",
        },
      },
    }));
    coordinator._sessions = new Map();
    coordinator._hibernatedSessionMeta = new Map();
    coordinator._prePromptAbortControllers = new Map();
    coordinator._currentSessionPath = null;
    coordinator._sessionStarted = false;

    const sessions = await coordinator.listSessions({ ownerPluginId: "tavern" });

    expect(listAgents).toHaveBeenCalledWith(expect.objectContaining({ ownerPluginId: "tavern" }));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      path: sessionPath,
      agentId: "plugin-agent",
      ownerPluginId: "tavern",
      sessionKind: "tavern",
      visibility: "plugin_private",
    });
  });

  it("lists user-created pending sessions before their JSONL projection exists", async () => {
    const agentsDir = path.join(tempDir, "agents");
    const sessionDir = path.join(agentsDir, "hana", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "pending.jsonl");
    const sessionManager = {
      getCwd: () => "/tmp/workspace",
      getSessionFile: () => sessionPath,
    };
    const model = { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek Chat" };
    const agent = {
      id: "hana",
      name: "Hana",
      agentName: "Hana",
      sessionDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
      config: {},
    };
    sessionManagerCreateMock.mockReturnValue(sessionManager);
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager,
        model,
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: model,
        availableModels: [model],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [{ id: "hana", name: "Hana" }],
    });

    await coordinator.createSession(null, "/tmp/workspace", true, null, {
      visibleInSessionList: true,
    });

    const sessions = await coordinator.listSessions();

    expect(sessionManagerListMock).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      path: sessionPath,
      title: null,
      firstMessage: "",
      messageCount: 0,
      cwd: "/tmp/workspace",
      agentId: "hana",
      agentName: "Hana",
      modelId: "deepseek-chat",
      modelProvider: "deepseek",
      pinnedAt: null,
    });
  });

  it("logs DeepSeek reasoning visibility only at assistant message_end", async () => {
    const agentsDir = path.join(tempDir, "agents");
    const sessionDir = path.join(agentsDir, "hana", "sessions");
    const sessionPath = path.join(sessionDir, "deepseek-log.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    let listener: any = null;
    const sessionManager = {
      getCwd: () => tempDir,
      getSessionFile: () => sessionPath,
    };
    const model = { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek Chat" };
    const agent = {
      id: "hana",
      name: "Hana",
      agentName: "Hana",
      agentDir: path.join(agentsDir, "hana"),
      sessionDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
      config: {},
    };

    sessionManagerCreateMock.mockReturnValueOnce(sessionManager);
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager,
        model,
        subscribe: vi.fn((fn) => {
          listener = fn;
          return vi.fn();
        }),
        setActiveToolsByName: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: model,
        availableModels: [model],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map([["hana", agent]]),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [agent],
    });

    await coordinator.createSession(null, tempDir, true);
    moduleLogMock.log.mockClear();

    listener?.({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "逐帧思考" },
    });

    expect(moduleLogMock.log).not.toHaveBeenCalled();

    listener?.({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "一次性汇总" }],
        usage: { reasoning_tokens: 7 },
        stopReason: "stop",
      },
    });

    expect(moduleLogMock.log).toHaveBeenCalledTimes(1);
    expect(moduleLogMock.log).toHaveBeenCalledWith(expect.stringContaining("event=message_end"));
    expect(moduleLogMock.log).toHaveBeenCalledWith(expect.stringContaining("thinkingBlocks=1"));
    expect(moduleLogMock.log).toHaveBeenCalledWith(expect.stringContaining("reasoningTokens=7"));
  });

  it("treats auxiliary vision preparation as streaming before provider prompt starts", async () => {
    const agentsDir = path.join(tempDir, "agents");
    const sessionDir = path.join(agentsDir, "hana", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "vision-pending.jsonl");
    const sessionManager = {
      getCwd: () => "/tmp/workspace",
      getSessionFile: () => sessionPath,
    };
    const model = {
      id: "text-only-model",
      provider: "custom",
      name: "Text Only Model",
      input: ["text"],
    };
    const session = {
      sessionManager,
      model,
      isStreaming: false,
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
    };
    const agent = {
      id: "hana",
      name: "Hana",
      agentName: "Hana",
      sessionDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
      config: {},
    };
    let releasePrepare;
    const prepareStarted = new Promise((resolve) => {
      releasePrepare = resolve;
    });
    let finishPrepare;
    const prepareCanFinish = new Promise((resolve) => {
      finishPrepare = resolve;
    });
    const visionBridge = {
      prepare: vi.fn(async () => {
        releasePrepare();
        await prepareCanFinish;
        return { text: "prepared image context", images: [] };
      }),
    };

    sessionManagerCreateMock.mockReturnValue(sessionManager);
    createAgentSessionMock.mockResolvedValueOnce({ session });

    const coordinator = new SessionCoordinator({
      agentsDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: model,
        availableModels: [model],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      getEngine: () => ({
        isVisionAuxiliaryEnabled: () => true,
        getVisionBridge: () => visionBridge,
        log: { warn: vi.fn() },
      }),
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [{ id: "hana", name: "Hana" }],
    });
    await coordinator.createSession(null, "/tmp/workspace", true, null, {
      visibleInSessionList: true,
    });

    const promptPromise = coordinator.promptSession(sessionPath, "describe image", {
      images: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
    });
    await prepareStarted;

    const streamingDuringPrepare = coordinator.isSessionStreaming(sessionPath);
    const listedDuringPrepare = (await coordinator.listSessions()).some((s) => s.path === sessionPath);

    finishPrepare();
    await promptPromise;
    expect(streamingDuringPrepare).toBe(true);
    expect(listedDuringPrepare).toBe(true);
    expect(session.prompt).toHaveBeenCalledWith("prepared image context", undefined);
  });

  it("builds session tools with sandbox workspace pinned to the effective cwd", async () => {
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [{ name: "write" }],
    };
    const buildTools = vi.fn((_cwd, customTools) => ({ tools: [], customTools }));
    const homeCwd = path.join(tempDir, "agent-home");
    const sessionCwd = path.join(tempDir, "session-cwd");

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => homeCwd,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, sessionCwd, true);

    expect(buildTools).toHaveBeenCalledWith(
      sessionCwd,
      agent.tools,
      expect.objectContaining({
        agentDir: agent.agentDir,
        workspace: sessionCwd,
      }),
    );
  });

  it("passes the frozen experience state into the agent tool snapshot", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "experience.jsonl");
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      memoryEnabled: true,
      experienceEnabled: false,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      getToolsSnapshot: vi.fn(() => []),
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: vi.fn(() => ({ tools: [], customTools: [] })),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);

    expect(agent.getToolsSnapshot).toHaveBeenCalledWith({
      forceMemoryEnabled: true,
      forceExperienceEnabled: false,
      model: { name: "test-model" },
    });
  });


  it("threads extra workspace folders into tools, prompt context, and session meta", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "scope.jsonl");
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [{ name: "read" }],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    });
    const buildTools = vi.fn((_cwd, customTools) => ({ tools: [], customTools }));
    const sessionCwd = path.join(tempDir, "main-workspace");
    const extra = path.join(tempDir, "reference");

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => sessionCwd,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, sessionCwd, true, null, {
      workspaceFolders: [extra, sessionCwd, extra],
    });

    expect(buildTools).toHaveBeenCalledWith(
      sessionCwd,
      agent.tools,
      expect.objectContaining({
        workspace: sessionCwd,
        workspaceFolders: [extra],
      }),
    );
    const appendPrompt = createAgentSessionMock.mock.calls[0][0].resourceLoader.getAppendSystemPrompt();
    expect(appendPrompt.join("\n")).toContain("外部工作区文件夹");
    expect(appendPrompt.join("\n")).toContain(extra);

    const meta = JSON.parse(fs.readFileSync(path.join(agent.sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionFile)].workspaceFolders).toEqual([extra]);
    expect(coordinator.getSessionWorkspaceFolders(sessionFile)).toEqual([extra]);
  });

  it("freezes the DeepSeek prompt patch when the session is created with a DeepSeek reasoning model", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "deepseek.jsonl");
    const deepseekModel = {
      id: "deepseek/deepseek-v4-pro",
      provider: "openrouter",
      reasoning: true,
      name: "DeepSeek V4 Pro",
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        model: deepseekModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: deepseekModel,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "high",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => ["BASE APPEND"],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "high" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);

    const appendPrompt = createAgentSessionMock.mock.calls[0][0].resourceLoader.getAppendSystemPrompt();
    expect(appendPrompt.join("\n")).toContain("如果你使用的是 DeepSeek 模型");
    expect(appendPrompt.join("\n")).toContain("DeepSeek 输出契约");
  });

  it("restores the original prompt snapshot instead of rebuilding from current agent state", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "frozen-prompt.jsonl");
    let currentAgentPrompt = "SYSTEM PROMPT V1";
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => currentAgentPrompt),
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    const freshSession = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
      _baseSystemPrompt: "FINAL PROMPT V1",
      agent: { state: { systemPrompt: "FINAL PROMPT V1" } },
    };
    const restoredSession = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(function () {
        this._baseSystemPrompt = "FINAL PROMPT CURRENT";
        this.agent.state.systemPrompt = "FINAL PROMPT CURRENT";
      }),
      _baseSystemPrompt: "FINAL PROMPT CURRENT",
      agent: { state: { systemPrompt: "FINAL PROMPT CURRENT" } },
    };
    createAgentSessionMock
      .mockResolvedValueOnce({ session: freshSession })
      .mockResolvedValueOnce({ session: restoredSession });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "claude-opus-4-5", provider: "anthropic", name: "Claude" },
        availableModels: [{ id: "claude-opus-4-5", provider: "anthropic", name: "Claude" }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => ["BASE APPEND V1"],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [{ name: "skill-v1" }], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [{ path: "/AGENTS.md", content: "rules v1" }] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);
    currentAgentPrompt = "SYSTEM PROMPT V2";
    await coordinator.createSession(
      {
        getCwd: () => tempDir,
        getSessionFile: () => sessionFile,
        buildSessionContext: () => ({ model: { provider: "anthropic", modelId: "claude-opus-4-5" } }),
      },
      tempDir,
      true,
      null,
      { restore: true },
    );

    const restoreOptions = createAgentSessionMock.mock.calls[1][0];
    expect(restoreOptions.resourceLoader.getSystemPrompt()).toBe("SYSTEM PROMPT V1");
    const restoredAppend = restoreOptions.resourceLoader.getAppendSystemPrompt().join("\n");
    expect(restoredAppend).toContain("BASE APPEND V1");
    expect(restoredAppend).not.toContain("BASE APPEND V2");
    expect(restoreOptions.resourceLoader.getSkills()).toEqual({ skills: [{ name: "skill-v1" }], diagnostics: [] });
    expect(restoreOptions.resourceLoader.getAgentsFiles()).toEqual({ agentsFiles: [{ path: "/AGENTS.md", content: "rules v1" }] });
    expect(restoredSession._baseSystemPrompt).toBe("FINAL PROMPT V1");
    expect(restoredSession.agent.state.systemPrompt).toBe("FINAL PROMPT V1");
    // context ring refresh keeps restore cheap: old sessions keep frozen prompt snapshots,
    // while explicit refresh/fresh compact is responsible for rebuilding capability snapshots.
    expect(agent.buildSystemPrompt).toHaveBeenCalledTimes(1);
  });

  it("restores a prompt-snapshotted session with xhigh before the SDK model is available", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "xhigh-restore.jsonl");
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => "CURRENT BASE"),
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(agent.sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(sessionFile)]: {
          thinkingLevel: "xhigh",
          promptSnapshot: {
            version: 1,
            systemPrompt: "FROZEN BASE",
            appendSystemPrompt: [],
            skillsResult: { skills: [], diagnostics: [] },
            agentsFilesResult: { agentsFiles: [] },
          },
        },
      }),
    );
    const setThinkingLevel = vi.fn();
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        setThinkingLevel,
        model: { id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek V4 Pro" },
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek V4 Pro" },
        availableModels: [{ id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek V4 Pro" }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level) => level,
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "xhigh" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(
      {
        getCwd: () => tempDir,
        getSessionFile: () => sessionFile,
      },
      tempDir,
      true,
      null,
      { restore: true },
    );

    expect(createAgentSessionMock).toHaveBeenCalledOnce();
    expect(createAgentSessionMock.mock.calls[0][0].thinkingLevel).toBe("high");
    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("FROZEN BASE");
    expect(setThinkingLevel).toHaveBeenCalledWith("xhigh");

    const meta = JSON.parse(fs.readFileSync(path.join(agent.sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionFile)].thinkingLevel).toBe("xhigh");
  });

  it("stores skill pointers for a session and omits restored skills whose source was deleted", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "skill-snapshot.jsonl");
    const skillDir = path.join(tempDir, "skills", "stable-skill");
    fs.mkdirSync(path.join(skillDir, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: stable-skill\ndescription: Stable skill.\n---\n\noriginal body\n",
      "utf-8",
    );
    fs.writeFileSync(path.join(skillDir, "assets", "note.txt"), "asset v1\n", "utf-8");

    const skill = {
      name: "stable-skill",
      description: "Stable skill.",
      filePath: path.join(skillDir, "SKILL.md"),
      baseDir: skillDir,
      source: "user",
      sourceInfo: {
        path: path.join(skillDir, "SKILL.md"),
        baseDir: skillDir,
        source: "local",
      },
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    const freshSession = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
      _baseSystemPrompt: "FINAL PROMPT WITH SKILL",
      agent: { state: { systemPrompt: "FINAL PROMPT WITH SKILL" } },
    };
    const restoredSession = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
      _baseSystemPrompt: "FINAL PROMPT CURRENT",
      agent: { state: { systemPrompt: "FINAL PROMPT CURRENT" } },
    };
    createAgentSessionMock
      .mockResolvedValueOnce({ session: freshSession })
      .mockResolvedValueOnce({ session: restoredSession });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "claude-opus-4-5", provider: "anthropic", name: "Claude" },
        availableModels: [{ id: "claude-opus-4-5", provider: "anthropic", name: "Claude" }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => ({
        getSkillsForAgent: () => ({ skills: [skill], diagnostics: [] }),
      }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    const sessionMgr = {
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
      buildSessionContext: () => ({ model: { provider: "anthropic", modelId: "claude-opus-4-5" } }),
    };

    await coordinator.createSession(sessionMgr, tempDir, true);
    const freshSkill = createAgentSessionMock.mock.calls[0][0].resourceLoader.getSkills().skills[0];
    expect(freshSkill.filePath).toBe(skill.filePath);
    expect(freshSkill.runtimeIdentity).toMatchObject({
      kind: "skill_pointer",
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      readonly: true,
    });
    expect(fs.readFileSync(freshSkill.filePath, "utf-8")).toContain("original body");
    expect(fs.readFileSync(path.join(freshSkill.baseDir, "assets", "note.txt"), "utf-8")).toBe("asset v1\n");

    fs.rmSync(skillDir, { recursive: true, force: true });

    await coordinator.createSession(sessionMgr, tempDir, true, null, { restore: true });
    const restoredSkills = createAgentSessionMock.mock.calls[1][0].resourceLoader.getSkills();
    expect(restoredSkills.skills).toEqual([]);
    expect(restoredSkills.diagnostics).toEqual([
      expect.objectContaining({
        type: "warning",
        message: 'skill "stable-skill" source is no longer available',
        path: skill.filePath,
      }),
    ]);
  });

  it("restores frozen append prompts so provider prompt patches survive cold restore", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "deepseek-restore.jsonl");
    const deepseekModel = {
      id: "deepseek/deepseek-v4-pro",
      provider: "openrouter",
      reasoning: true,
      name: "DeepSeek V4 Pro",
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    createAgentSessionMock
      .mockResolvedValueOnce({
        session: {
          sessionManager: { getSessionFile: () => sessionFile },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
          _baseSystemPrompt: "FINAL DEEPSEEK",
          agent: { state: { systemPrompt: "FINAL DEEPSEEK" } },
          model: deepseekModel,
        },
      })
      .mockResolvedValueOnce({
        session: {
          sessionManager: { getSessionFile: () => sessionFile },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
          _baseSystemPrompt: "FINAL CURRENT",
          agent: { state: { systemPrompt: "FINAL CURRENT" } },
          model: deepseekModel,
        },
      });
    let baseAppend = ["BASE APPEND V1"];

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: deepseekModel,
        availableModels: [deepseekModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "high",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => baseAppend,
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "high" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);
    baseAppend = ["BASE APPEND V2"];
    await coordinator.createSession(
      {
        getCwd: () => tempDir,
        getSessionFile: () => sessionFile,
        buildSessionContext: () => ({ model: { provider: "openrouter", modelId: "deepseek/deepseek-v4-pro" } }),
      },
      tempDir,
      true,
      null,
      { restore: true },
    );

    const appendPrompt = createAgentSessionMock.mock.calls[1][0].resourceLoader.getAppendSystemPrompt().join("\n");
    expect(appendPrompt).toContain("BASE APPEND V1");
    expect(appendPrompt).toContain("DeepSeek 输出契约");
    expect(appendPrompt).not.toContain("BASE APPEND V2");
  });

  it("does not add the DeepSeek prompt patch when a non-DeepSeek session later switches models", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "non-deepseek.jsonl");
    const qwenModel = { id: "qwen3.6-max-preview", provider: "dashscope", reasoning: true };
    const deepseekModel = { id: "deepseek-v4-pro", provider: "deepseek", reasoning: true };
    let currentModel = qwenModel;
    const session = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
      model: qwenModel,
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    createAgentSessionMock.mockResolvedValueOnce({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "high",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => ["BASE APPEND"],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "high" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);
    currentModel = deepseekModel;
    session.model = deepseekModel;

    const appendPrompt = createAgentSessionMock.mock.calls[0][0].resourceLoader.getAppendSystemPrompt();
    expect(appendPrompt.join("\n")).not.toContain("DeepSeek 输出契约");
  });

  it("blocks image prompts for text-only models when auxiliary vision is disabled", async () => {
    const sessionFile = path.join(tempDir, "text-only-images.jsonl");
    const sessionPrompt = vi.fn();
    const prepare = vi.fn(async () => ({
      text: "vision notes",
      images: [],
    }));
    const textOnlyModel = { id: "deepseek-v4-pro", provider: "deepseek", input: ["text"] };
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        prompt: sessionPrompt,
        model: textOnlyModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: textOnlyModel,
        availableModels: [textOnlyModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      getEngine: () => ({
        isVisionAuxiliaryEnabled: () => false,
        getVisionBridge: () => ({ prepare }),
      }),
    });

    await coordinator.createSession(null, tempDir, true);

    await expect(coordinator.prompt("看一下", {
      images: [{ type: "image", data: "abc", mimeType: "image/png" }],
    })).rejects.toThrow(/vision auxiliary is disabled/);
    expect(prepare).not.toHaveBeenCalled();
    expect(sessionPrompt).not.toHaveBeenCalled();
  });

  it("blocks video prompts unless the model explicitly declares video input", async () => {
    const sessionFile = path.join(tempDir, "text-only-video.jsonl");
    const sessionPrompt = vi.fn();
    const textOnlyModel = { id: "deepseek-v4-pro", provider: "deepseek", input: ["text"] };
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        prompt: sessionPrompt,
        model: textOnlyModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: textOnlyModel,
        availableModels: [textOnlyModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);

    await expect(coordinator.prompt("看一下", {
      videos: [{ type: "video", data: "abc", mimeType: "video/mp4" }],
    })).rejects.toThrow(/current model does not support video input/);
    expect(sessionPrompt).not.toHaveBeenCalled();
  });

  it("blocks video prompts when the provider transport cannot carry video", async () => {
    const sessionFile = path.join(tempDir, "kimi-coding-video.jsonl");
    const sessionPrompt = vi.fn();
    const kimiCodingModel = {
      id: "kimi-for-coding",
      provider: "kimi-coding",
      api: "anthropic-messages",
      input: ["text", "image"],
      compat: { hanaVideoInput: true },
    };
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        prompt: sessionPrompt,
        model: kimiCodingModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: kimiCodingModel,
        availableModels: [kimiCodingModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);

    await expect(coordinator.prompt("看一下", {
      videos: [{ type: "video", data: "abc", mimeType: "video/mp4" }],
    })).rejects.toThrow(/current provider does not support direct video input/);
    expect(sessionPrompt).not.toHaveBeenCalled();
  });

  it("blocks audio prompts unless the model explicitly declares direct audio input", async () => {
    const sessionFile = path.join(tempDir, "text-only-audio.jsonl");
    const sessionPrompt = vi.fn();
    const textOnlyModel = { id: "deepseek-v4-pro", provider: "deepseek", input: ["text"] };
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        prompt: sessionPrompt,
        model: textOnlyModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: textOnlyModel,
        availableModels: [textOnlyModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);

    await expect(coordinator.prompt("听一下", {
      audios: [{ type: "audio", data: "abc", mimeType: "audio/wav" }],
    })).rejects.toThrow(/current model does not support audio input/);
    expect(sessionPrompt).not.toHaveBeenCalled();
  });

  it("forwards direct audio prompts through the existing Pi SDK media option", async () => {
    const sessionFile = path.join(tempDir, "mimo-audio.jsonl");
    const sessionPrompt = vi.fn();
    const beginCurrentTurnNativeMedia = vi.fn(() => ({ id: 1, sessionPath: sessionFile }));
    const endCurrentTurnNativeMedia = vi.fn();
    const mimoAudioModel = {
      id: "mimo-v2.5",
      provider: "mimo",
      api: "openai-completions",
      baseUrl: "https://api.xiaomimimo.com/v1",
      input: ["text", "audio"],
    };
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        prompt: sessionPrompt,
        model: mimoAudioModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: mimoAudioModel,
        availableModels: [mimoAudioModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      getEngine: () => ({
        beginCurrentTurnNativeMedia,
        endCurrentTurnNativeMedia,
      }),
    });

    await coordinator.createSession(null, tempDir, true);

    await coordinator.prompt("听一下", {
      audios: [{ type: "audio", data: "abc", mimeType: "audio/wav" }],
      audioAttachmentPaths: ["/tmp/voice.wav"],
    });

    expect(sessionPrompt).toHaveBeenCalledWith("听一下", {
      images: [{ type: "audio", data: "abc", mimeType: "audio/wav" }],
      audioAttachmentPaths: ["/tmp/voice.wav"],
    });
    expect(beginCurrentTurnNativeMedia).toHaveBeenCalledWith(sessionFile, {
      audios: [{ type: "audio", data: "abc", mimeType: "audio/wav" }],
      audioAttachmentPaths: ["/tmp/voice.wav"],
    });
    expect(endCurrentTurnNativeMedia).toHaveBeenCalledWith({ id: 1, sessionPath: sessionFile });
  });

  it("fresh session freezes the effective memory state into meta for cache safety", async () => {
    const sessionFile = path.join(tempDir, "frozen-memory.jsonl");
    let sessionMemoryEnabled = true;
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      memoryMasterEnabled: false,
      get sessionMemoryEnabled() { return sessionMemoryEnabled; },
      get memoryEnabled() { return this.memoryMasterEnabled && sessionMemoryEnabled; },
      setMemoryEnabled: vi.fn((enabled) => {
        sessionMemoryEnabled = !!enabled;
      }),
      getToolsSnapshot: vi.fn(({ forceMemoryEnabled }: any = {}) =>
        forceMemoryEnabled ? [{ name: "search_memory" }] : [{ name: "todo_write" }],
      ),
      buildSystemPrompt: vi.fn(({ forceMemoryEnabled }: any = {}) =>
        forceMemoryEnabled ? "MEMORY ON" : "MEMORY OFF",
      ),
      buildMemoryReflectionSnapshot: vi.fn(({ forceMemoryEnabled }: any = {}) => ({
        version: 1,
        agentName: "Hana",
        userName: "测试用户",
        existingMemory: forceMemoryEnabled ? "已有长期记忆" : "",
      })),
      config: { tools: {} },
      tools: [{ name: "todo_write" }],
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => "/tmp/workspace",
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        model: { id: "test-model", provider: "test" },
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "test-model", provider: "test", name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: (_cwd, customTools) => ({ tools: [], customTools }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);

    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("MEMORY OFF");
    const meta = JSON.parse(fs.readFileSync(path.join(tempDir, "hana", "sessions", "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionFile)].memoryEnabled).toBe(false);
    expect(agent.buildMemoryReflectionSnapshot).toHaveBeenCalledWith({
      forceMemoryEnabled: false,
    });
    // memoryReflectionSnapshot 一律外置为 sidecar 引用，需经 hydrate 才能看到实际内容
    expect(meta[path.basename(sessionFile)].memoryReflectionSnapshot).toMatchObject({
      kind: "session-meta-payload",
      field: "memoryReflectionSnapshot",
    });
    const metaPath = path.join(tempDir, "hana", "sessions", "session-meta.json");
    const hydrated = await coordinator._readMetaCached(metaPath);
    expect(hydrated[path.basename(sessionFile)].memoryReflectionSnapshot).toEqual({
      version: 1,
      agentName: "Hana",
      userName: "测试用户",
      existingMemory: "",
    });
  });

  it("records and auto-renews cache prefix drift instead of failing the turn", async () => {
    const emittedEvents: any[] = [];
    const violations = () => emittedEvents.filter((event) => event?.type === "cache_contract_violation");
    const sessionFile = path.join(tempDir, "hana", "sessions", "cache-contract.jsonl");
    const model = {
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 1000000,
      maxTokens: 32000,
    };
    const readTool = { name: "read", description: "Read files", parameters: { type: "object" } };
    const execCommandTool = { name: "exec_command", description: "Run command", parameters: { type: "object" } };
    const activeTools = new Map([["read", readTool], ["exec_command", execCommandTool]]);
    const originalStreamFn = vi.fn(async () => "ok");
    const session = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      isCompacting: false,
      isStreaming: false,
      steer: vi.fn(),
      model,
      getContextUsage: () => ({ tokens: 0 }),
      prompt: vi.fn(async (_text, opts) => {
        opts?.preflightResult?.(true);
        return "ok";
      }),
      setActiveToolsByName: vi.fn((names) => {
        session.agent.state.tools = names.map((name) => activeTools.get(name)).filter(Boolean);
      }),
      agent: {
        streamFn: originalStreamFn,
        state: {
          model,
          systemPrompt: "FINAL CACHE PREFIX",
          tools: [readTool, execCommandTool],
          messages: [],
        },
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "FROZEN BASE",
      getToolsSnapshot: () => [],
      config: { tools: {} },
      tools: [],
    };
    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: model,
        availableModels: [model],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [readTool, execCommandTool], customTools: [] }),
      emitEvent: (event: any) => { emittedEvents.push(event); },
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);

    const entry = coordinator._getSessionEntryByPath(sessionFile);
    const renewSpy = vi.spyOn(coordinator as any, "_renewCachePrefixContract");
    const requestCountBeforePreflight = entry.cachePrefixContractRequestCount;
    const promptOrder: string[] = [];
    session.prompt.mockImplementationOnce(async (_text, opts) => {
      opts?.preflightResult?.(true);
      promptOrder.push("pi-prompt");
      return "ok";
    });
    await coordinator.promptSession(sessionFile, "hello", undefined, {
      afterCachePreflight: () => {
        promptOrder.push("post-preflight-hook");
      },
      afterInputAccepted: () => {
        promptOrder.push("input-accepted");
      },
    });
    expect(promptOrder).toEqual(["post-preflight-hook", "input-accepted", "pi-prompt"]);
    expect(entry.cachePrefixContractRequestCount).toBe(requestCountBeforePreflight);
    expect(renewSpy).not.toHaveBeenCalled();

    expect(violations()).toHaveLength(0);

    // 输入前有人重建了 system prompt 却没续签：漂移必须被记下来，但请求照常发出。
    session.agent.state.systemPrompt = "MUTATED BEFORE INPUT";
    const driftHook = vi.fn();
    await coordinator.promptSession(sessionFile, "drifted", undefined, {
      afterCachePreflight: driftHook,
    });
    expect(driftHook).toHaveBeenCalled();
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(violations()).toHaveLength(1);
    const inputViolation = violations()[0];
    expect(inputViolation.action).toBe("renewed");
    expect(inputViolation.diffs.map((d: any) => d.field)).toContain("systemPromptHash");
    expect(inputViolation.drift.systemPrompt.expectedExcerpt).toContain("FINAL CACHE PREFIX");
    expect(inputViolation.drift.systemPrompt.actualExcerpt).toContain("MUTATED BEFORE INPUT");
    // 事件只带摘要，整段 prompt 不外泄
    expect(inputViolation.expected.systemPrompt).toBeUndefined();
    expect(renewSpy).toHaveBeenCalledWith(sessionFile, entry, "drift_auto_renew", expect.anything());

    // 契约已按现状续签：同一份 prompt 再来一次不再报漂移
    renewSpy.mockClear();
    await coordinator.promptSession(sessionFile, "settled", undefined, {
      afterCachePreflight: vi.fn(),
    });
    expect(violations()).toHaveLength(1);
    expect(renewSpy).not.toHaveBeenCalled();

    // steer 路径同理：漂移不再打断用户的插话
    session.isStreaming = true;
    session.steer.mockClear();
    session.agent.state.systemPrompt = "MUTATED BEFORE STEER";
    expect(() => coordinator.steerSession(sessionFile, "steered")).not.toThrow();
    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(violations()).toHaveLength(2);
    expect(violations()[1].action).toBe("renewed");
    session.isStreaming = false;
    session.agent.state.systemPrompt = "FINAL CACHE PREFIX";

    // 契约放行不改变 preflight 钩子本身的同步契约
    await expect(coordinator.promptSession(sessionFile, "async hook", undefined, {
      afterCachePreflight: () => Promise.resolve(),
    })).rejects.toThrow(/must be synchronous/);
    expect(session.prompt).toHaveBeenCalledTimes(4);

    await expect((session.agent.streamFn as any)(model, {
      systemPrompt: "FINAL CACHE PREFIX",
      tools: [readTool, execCommandTool],
      messages: [{ role: "user", content: "hello" }],
    }, {})).resolves.toBe("ok");
    expect(originalStreamFn).toHaveBeenCalledTimes(1);
    expect(violations()).toHaveLength(3);

    // 请求发出那一刻才漂移：记录 + 续签 + 照常发给 provider
    await expect((session.agent.streamFn as any)(model, {
      systemPrompt: "MUTATED CACHE PREFIX",
      tools: [readTool, execCommandTool],
      messages: [
        { role: "user", content: "hello" },
        { role: "toolResult", content: [{ type: "text", text: "dynamic" }] },
      ],
    }, {})).resolves.toBe("ok");
    expect(originalStreamFn).toHaveBeenCalledTimes(2);
    expect(violations()).toHaveLength(4);
    expect(violations()[3].drift.systemPrompt.actualExcerpt).toContain("MUTATED CACHE PREFIX");

    // 续签之后同一个前缀不再重复告警
    await expect((session.agent.streamFn as any)(model, {
      systemPrompt: "MUTATED CACHE PREFIX",
      tools: [readTool, execCommandTool],
      messages: [{ role: "user", content: "hello again" }],
    }, {})).resolves.toBe("ok");
    expect(originalStreamFn).toHaveBeenCalledTimes(3);
    expect(violations()).toHaveLength(4);

    session.isCompacting = true;
    await expect((session.agent.streamFn as any)(model, {
      systemPrompt: "INDEPENDENT SUMMARIZATION PROMPT",
      tools: [],
      messages: [{ role: "user", content: "Summarize the conversation" }],
    }, {})).resolves.toBe("ok");
    expect(originalStreamFn).toHaveBeenCalledTimes(4);
    expect(violations()).toHaveLength(4);

    // 工具表漂移同样只留证据，并按名字点出增删改
    session.isCompacting = false;
    await expect((session.agent.streamFn as any)(model, {
      systemPrompt: "MUTATED CACHE PREFIX",
      tools: [readTool],
      messages: [{ role: "user", content: "fewer tools" }],
    }, {})).resolves.toBe("ok");
    expect(originalStreamFn).toHaveBeenCalledTimes(5);
    expect(violations()).toHaveLength(5);
    expect(violations()[4].drift.tools.removed).toEqual(["exec_command"]);

    // 契约缺失（late init）不再是错误，续签后照常发出
    entry.cachePrefixContract = null;
    renewSpy.mockClear();
    await coordinator.promptSession(sessionFile, "late init", undefined, {
      afterCachePreflight: vi.fn(),
    });
    expect(renewSpy).toHaveBeenCalledWith(sessionFile, entry, "late_init", expect.anything());
    expect(session.prompt).toHaveBeenCalledTimes(5);

    let finishAcceptedTurn!: () => void;
    const acceptedTurnGate = new Promise<void>((resolve) => { finishAcceptedTurn = resolve; });
    const acceptedHook = vi.fn();
    session.prompt.mockImplementationOnce(async (_text, opts) => {
      opts?.preflightResult?.(true);
      await acceptedTurnGate;
      return "ok";
    });
    const acceptedTurn = coordinator.promptSession(sessionFile, "accepted before completion", undefined, {
      afterCachePreflight: vi.fn(),
      afterInputAccepted: acceptedHook,
    });
    await vi.waitFor(() => expect(acceptedHook).toHaveBeenCalledTimes(1));
    let turnCompleted = false;
    void acceptedTurn.finally(() => { turnCompleted = true; });
    expect(turnCompleted).toBe(false);
    finishAcceptedTurn();
    await acceptedTurn;

    let finishRejectedPreflight!: () => void;
    const rejectedPreflightGate = new Promise<void>((resolve) => { finishRejectedPreflight = resolve; });
    const rejectedSideEffects = vi.fn();
    const rejectedAcceptedHook = vi.fn();
    session.prompt.mockImplementationOnce(async (_text, opts) => {
      await rejectedPreflightGate;
      opts?.preflightResult?.(false);
      throw new Error("Pi preflight rejected");
    });
    const rejectedTurn = coordinator.promptSession(sessionFile, "reject after delay", undefined, {
      afterCachePreflight: rejectedSideEffects,
      afterInputAccepted: rejectedAcceptedHook,
    });
    await Promise.resolve();
    expect(rejectedSideEffects).not.toHaveBeenCalled();
    expect(rejectedAcceptedHook).not.toHaveBeenCalled();
    finishRejectedPreflight();
    await expect(rejectedTurn).rejects.toThrow("Pi preflight rejected");
    expect(rejectedSideEffects).not.toHaveBeenCalled();
    expect(rejectedAcceptedHook).not.toHaveBeenCalled();
  });

  it("renews the cache prefix contract for an explicit model switch", async () => {
    const sessionFile = path.join(tempDir, "hana", "sessions", "cache-contract-model-switch.jsonl");
    const initialModel = {
      id: "deepseek-v4-flash",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 1000000,
      maxTokens: 32000,
    };
    const nextModel = { ...initialModel, id: "deepseek-v4-pro" };
    const readTool = { name: "read", description: "Read files", parameters: { type: "object" } };
    const originalStreamFn = vi.fn(async () => "ok");
    const session = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      model: initialModel,
      getContextUsage: () => ({ tokens: 0 }),
      setActiveToolsByName: vi.fn((names) => {
        session.agent.state.tools = names.includes("read") ? [readTool] : [];
      }),
      setModel: vi.fn(async (model) => {
        session.model = model;
        session.agent.state.model = model;
      }),
      setThinkingLevel: vi.fn(),
      agent: {
        streamFn: originalStreamFn,
        state: {
          model: initialModel,
          systemPrompt: "FINAL CACHE PREFIX",
          tools: [readTool],
          messages: [],
        },
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "FROZEN BASE",
      getToolsSnapshot: () => [],
      config: { tools: {} },
      tools: [],
    };
    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: initialModel,
        availableModels: [initialModel, nextModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level) => level,
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [readTool], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);
    await coordinator.switchSessionModel(sessionFile, nextModel);

    await expect((session.agent.streamFn as any)(nextModel, {
      systemPrompt: "FINAL CACHE PREFIX",
      tools: [readTool],
      messages: [{ role: "user", content: "hello" }],
    }, {})).resolves.toBe("ok");
  });

  it("builds a keyed session cache snapshot from session-owned active tool definitions", () => {
    const sessionPath = path.join(tempDir, "hana", "sessions", "snapshot.jsonl");
    const readTool = { name: "read", description: "Read files", parameters: { type: "object" } };
    const execCommandTool = { name: "exec_command", description: "Run command", parameters: { type: "object" } };
    const coordinator = Object.create(SessionCoordinator.prototype);
    coordinator._sessions = new Map([
      [sessionPath, {
        session: {
          model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
          agent: {
            state: {
              systemPrompt: "stable system",
              messages: [
                { role: "user", content: [{ type: "text", text: "hello" }, { type: "input_audio", audio_url: "file://voice.wav" }] },
              ],
            },
          },
        },
        thinkingLevel: "medium",
        activeToolDefinitions: [readTool, execCommandTool],
      }],
    ]);

    const snapshot = coordinator.buildSessionCacheSnapshot(sessionPath, { reason: "compaction.history" });

    expect(snapshot).toMatchObject({
      strategy: "session_snapshot",
      sessionPath,
      toolNames: ["read", "exec_command"],
      cacheKeyParams: { thinkingLevel: "medium" },
    });
    expect(snapshot.tools).toEqual([
      { name: "read", description: "Read files", parameters: { type: "object" } },
      { name: "exec_command", description: "Run command", parameters: { type: "object" } },
    ]);
    expect(snapshot.messages[0].content[1]).toEqual({ type: "input_audio", audio_url: "file://voice.wav" });
  });

  it("returns the transform context owned by the keyed session runtime", () => {
    const sessionPath = path.join(tempDir, "hana", "sessions", "transform.jsonl");
    const transformContext = vi.fn(async (messages) => messages);
    const coordinator = Object.create(SessionCoordinator.prototype);
    coordinator._sessions = new Map([
      [sessionPath, {
        session: {
          agent: { transformContext },
        },
      }],
    ]);

    expect(coordinator.getSessionTransformContext(sessionPath)).toBe(transformContext);
  });

  it("returns the complete AgentRun runtime owned by the keyed session", () => {
    const sessionPath = path.join(tempDir, "hana", "sessions", "agent-run-runtime.jsonl");
    const streamFn = vi.fn();
    const onPayload = vi.fn();
    const onResponse = vi.fn();
    const prepareArguments = vi.fn((args) => args);
    const execute = vi.fn();
    const tools = [{
      name: "read",
      label: "Read",
      description: "Read files",
      parameters: { type: "object" },
      prepareArguments,
      execute,
    }];
    const coordinator = Object.create(SessionCoordinator.prototype);
    coordinator._sessions = new Map([
      [sessionPath, {
        session: {
          sessionManager: { getSessionId: () => "session-runtime-1" },
          agent: {
            streamFn,
            onPayload,
            onResponse,
            transport: "sse",
            thinkingBudgets: { high: 8192 },
            maxRetryDelayMs: 1234,
            state: { tools },
          },
        },
      }],
    ]);

    const runtime = coordinator.getSessionAgentRunRuntime(sessionPath);
    expect(runtime).toEqual({
      streamFn,
      tools,
      streamOptions: {
        sessionId: "session-runtime-1",
        onPayload,
        onResponse,
        transport: "sse",
        thinkingBudgets: { high: 8192 },
        maxRetryDelayMs: 1234,
      },
    });
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.tools)).toBe(true);
    expect(Object.isFrozen(runtime.streamOptions)).toBe(true);
    expect(runtime.tools[0]).not.toBe(tools[0]);
  });

  it.each([
    ["unknown session", false, undefined],
    ["missing streamFn", true, undefined],
  ])("throws a typed AgentRun runtime error for %s", (_name, includeSession, streamFn) => {
    const sessionPath = path.join(tempDir, "hana", "sessions", "missing-agent-run-runtime.jsonl");
    const coordinator = Object.create(SessionCoordinator.prototype);
    coordinator._sessions = new Map(includeSession
      ? [[sessionPath, { session: { agent: { streamFn, state: { tools: [] } } } }]]
      : []);

    let caught = null;
    try {
      coordinator.getSessionAgentRunRuntime(sessionPath);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: "SessionAgentRunRuntimeResolutionError",
      code: "SESSION_AGENT_RUN_RUNTIME_UNKNOWN",
      sessionPath,
    });
  });

  it("returns an explicit identity transform for a resolved session without one", async () => {
    const sessionPath = path.join(tempDir, "hana", "sessions", "identity.jsonl");
    const coordinator = Object.create(SessionCoordinator.prototype);
    coordinator._sessions = new Map([
      [sessionPath, {
        session: {
          agent: {},
        },
      }],
    ]);

    const identityTransform = coordinator.getSessionTransformContext(sessionPath);
    expect(typeof identityTransform).toBe("function");
    const messages = [{ role: "user", content: "hello" }];
    await expect(identityTransform(messages)).resolves.toBe(messages);
  });

  it("throws a typed ownership error for an unknown session path", () => {
    const coordinator = Object.create(SessionCoordinator.prototype);
    coordinator._sessions = new Map();
    const missingPath = path.join(tempDir, "missing.jsonl");
    let caught = null;
    try {
      coordinator.getSessionTransformContext(missingPath);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: "SessionTransformContextResolutionError",
      code: "SESSION_TRANSFORM_CONTEXT_UNKNOWN",
      sessionPath: missingPath,
    });
  });

  it("cleans up the temporary session file when aborted after session creation", async () => {
    const sessionFile = path.join(tempDir, "isolated.jsonl");
    fs.writeFileSync(sessionFile, "temp");

    const controller = new AbortController();
    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockImplementation(async () => {
      controller.abort();
      return {
        session: {
          sessionManager: { getSessionFile: () => sessionFile },
          subscribe: vi.fn(() => vi.fn()),
          abort: vi.fn(),
        },
      };
    });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: tempDir,
        sessionDir: tempDir,
        agentName: "test-agent",
        config: { models: { chat: { id: "default-model", provider: "test" } } },
        tools: [],
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
      sessionManifestStore: createTestSessionManifestStore(),
    });

    const result = await coordinator.executeIsolated("subagent task", {
      signal: controller.signal,
    });

    expect(result).toEqual({
      sessionPath: null,
      replyText: "",
      error: "aborted",
    });
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it("keeps a deleted-agent continuation session when fresh compact fails", async () => {
    const agentsDir = path.join(tempDir, "agents");
    const sourcePath = path.join(agentsDir, "deleted", "sessions", "old.jsonl");
    const createdPath = path.join(agentsDir, "hana", "sessions", "continued.jsonl");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(createdPath), { recursive: true });
    fs.writeFileSync(sourcePath, "source", "utf-8");
    fs.writeFileSync(createdPath, "created", "utf-8");

    (SessionManager.open as any).mockReturnValue({
      getCwd: () => tempDir,
      getBranch: () => [{
        type: "message",
        message: { role: "user", content: "old hello", timestamp: "2026-06-17T00:00:00.000Z" },
      }],
    });

    const targetAgent = { id: "hana", agentName: "Hana" };
    const manager = {
      getCwd: () => tempDir,
      appendMessage: vi.fn(),
      appendModelChange: vi.fn(),
      _rewriteFile: vi.fn(),
    };
    const coordinator = Object.create(SessionCoordinator.prototype);
    coordinator._assertActiveDesktopSessionPath = vi.fn();
    coordinator._d = {
      agentIdFromSessionPath: vi.fn(() => "deleted"),
      isAgentDeleted: vi.fn((agentId) => agentId === "deleted"),
      getPrefs: vi.fn(() => ({ getPrimaryAgent: () => "hana" })),
      getAgentById: vi.fn(() => targetAgent),
      getAgent: vi.fn(() => targetAgent),
      getHomeCwd: vi.fn(() => tempDir),
    };
    coordinator.createSession = vi.fn(async () => ({
      sessionPath: createdPath,
      session: { sessionManager: manager, model: null },
    }));
    coordinator.writeSessionMeta = vi.fn(async () => {});
    coordinator._freshCompactDeletedAgentContinuation = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    coordinator.setSessionPinned = vi.fn(async () => null);
    coordinator.discardSessionRuntime = vi.fn(async () => {});
    coordinator.getSessionWorkspaceFolders = vi.fn(() => []);
    coordinator.applySessionBranchHead = vi.fn();

    const result = await coordinator.continueDeletedAgentSession(sourcePath);

    expect(result).toMatchObject({
      sessionPath: createdPath,
      agentId: "hana",
      compacted: false,
      compactionError: "model unavailable",
    });
    expect(manager.appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: "user",
      content: [{ type: "text", text: "old hello" }],
    }));
    expect(coordinator.discardSessionRuntime).not.toHaveBeenCalled();
    expect(coordinator.setSessionPinned).toHaveBeenCalledWith(sourcePath, false);
    expect(fs.existsSync(createdPath)).toBe(true);
  });

  it("summarizes a deleted-agent continuation through the explicit cold utility lane", async () => {
    const summary = `## Goal
Continue the restored transcript.

## Constraints & Preferences
- Keep the continuation self-contained.

## Progress
### Done
- [x] Summarized the deleted Agent transcript.

### In Progress
- [ ] Continue in the primary Agent.

### Blocked
- (none)

## Key Decisions
- Use a cold utility summary.

## Next Steps
1. Continue the work.

## Critical Context
- The source Agent runtime is unavailable.`;
    const transcriptMessages = [
      { role: "user", content: [{ type: "text", text: "old user transcript" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "old assistant transcript" }], timestamp: 2 },
    ];
    const providerContexts: any[] = [];
    runAgentLoopMock.mockImplementationOnce(async (
      prompts,
      context,
      config,
      emit,
      signal,
      streamFn,
    ) => {
      const providerContext = {
        systemPrompt: context.systemPrompt,
        messages: [...context.messages, ...prompts],
        tools: context.tools,
      };
      providerContexts.push(providerContext);
      const stream = await streamFn(config.model, providerContext, { signal });
      const message = await stream.result();
      await emit({ type: "message_end", message });
      return [...prompts, message];
    });
    const streamFn = vi.fn(async () => ({
      async result() {
        return {
          role: "assistant",
          content: [{ type: "text", text: summary }],
          stopReason: "stop",
          usage: {
            input: 20,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 30,
          },
        };
      },
    }));
    const appendCompaction = vi.fn(() => "cold-compaction-entry");
    const compactedMessages = [{ role: "compactionSummary", summary }];
    const emit = vi.fn();
    const replaceMessages = vi.fn();
    const ledger = createUsageLedger({ requestIdFactory: () => "deleted-agent-cold-1" });
    const session = {
      model: {
        id: "test-model",
        provider: "test-provider",
        api: "openai-completions",
        reasoning: false,
      },
      thinkingLevel: "off",
      _emit: emit,
      settingsManager: {
        getCompactionSettings: () => ({ reserveTokens: 1000, keepRecentTokens: 0 }),
      },
      sessionManager: {
        getSessionFile: () => "/sessions/continued.jsonl",
        appendCompaction,
        buildSessionContext: () => ({ messages: compactedMessages }),
      },
      agent: {
        id: "hana",
        state: {
          systemPrompt: "primary Agent system prompt",
          tools: [{ name: "dangerous-live-tool", execute: vi.fn() }],
        },
        streamFn,
        convertToLlm: async (messages) => messages,
        replaceMessages,
      },
    };
    const coordinator = Object.create(SessionCoordinator.prototype);
    coordinator._d = { getUsageLedger: () => ledger };
    coordinator._createSettings = vi.fn();
    coordinator._sessionIdForPath = vi.fn(() => "sess-continued");
    coordinator._markSessionCompacted = vi.fn();

    const result = await coordinator._freshCompactDeletedAgentContinuation(
      session,
      transcriptMessages,
      {
        sourceSessionPath: "/deleted/session.jsonl",
        sourceAgentId: "deleted-agent",
      },
    );

    expect(result).toMatchObject({
      summary,
      firstKeptEntryId: null,
    });
    expect(providerContexts).toHaveLength(1);
    expect(providerContexts[0].messages.slice(0, -1)).toEqual(transcriptMessages);
    expect(providerContexts[0].tools).toEqual([]);
    expect(appendCompaction).toHaveBeenCalledWith(
      summary,
      null,
      expect.any(Number),
      { readFiles: [], modifiedFiles: [] },
      false,
    );
    expect(replaceMessages).toHaveBeenCalledWith(compactedMessages);
    expect(emit.mock.calls).toEqual([
      [{ type: "compaction_start", reason: "deleted_agent_continue" }],
      [{
        type: "compaction_end",
        reason: "deleted_agent_continue",
        result: expect.objectContaining({ summary }),
        aborted: false,
        willRetry: false,
      }],
    ]);
    expect(coordinator._markSessionCompacted).toHaveBeenCalledWith("/sessions/continued.jsonl");
    expect(ledger.list({ operation: "deleted_agent_continue" }).entries[0]).toMatchObject({
      metadata: {
        cacheStrategy: "utility_template",
        cacheGroup: "compaction.deleted-agent-continuation",
        strict: false,
      },
      usage: {
        cache: { readTokens: 0, hit: false },
      },
    });
  });

  it("uses compaction summaries as transcript material when continuing a deleted-agent session", async () => {
    const agentsDir = path.join(tempDir, "agents");
    const sourcePath = path.join(agentsDir, "deleted", "sessions", "old-compacted.jsonl");
    const createdPath = path.join(agentsDir, "hana", "sessions", "continued-compacted.jsonl");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(createdPath), { recursive: true });
    fs.writeFileSync(sourcePath, "source", "utf-8");
    fs.writeFileSync(createdPath, "created", "utf-8");

    (SessionManager.open as any).mockReturnValue({
      getCwd: () => tempDir,
      getBranch: () => [{
        type: "compaction",
        summary: "old compacted context",
        timestamp: "2026-06-17T00:00:00.000Z",
      }],
    });

    const manager = {
      getCwd: () => tempDir,
      appendMessage: vi.fn(),
      appendModelChange: vi.fn(),
      _rewriteFile: vi.fn(),
    };
    const coordinator = Object.create(SessionCoordinator.prototype);
    coordinator._assertActiveDesktopSessionPath = vi.fn();
    coordinator._d = {
      agentIdFromSessionPath: vi.fn(() => "deleted"),
      isAgentDeleted: vi.fn((agentId) => agentId === "deleted"),
      getPrefs: vi.fn(() => ({ getPrimaryAgent: () => "hana" })),
      getAgentById: vi.fn(() => ({ id: "hana", agentName: "Hana" })),
      getAgent: vi.fn(() => ({ id: "hana", agentName: "Hana" })),
      getHomeCwd: vi.fn(() => tempDir),
    };
    coordinator.createSession = vi.fn(async () => ({
      sessionPath: createdPath,
      session: { sessionManager: manager, model: null },
    }));
    coordinator.writeSessionMeta = vi.fn(async () => {});
    coordinator._freshCompactDeletedAgentContinuation = vi.fn(async () => {});
    coordinator.setSessionPinned = vi.fn(async () => null);
    coordinator.discardSessionRuntime = vi.fn(async () => {});
    coordinator.getSessionWorkspaceFolders = vi.fn(() => []);
    coordinator.applySessionBranchHead = vi.fn();

    await coordinator.continueDeletedAgentSession(sourcePath);

    expect(manager.appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: "assistant",
      content: [{ type: "text", text: "[历史压缩摘要]\nold compacted context" }],
    }));
    expect(coordinator.setSessionPinned).toHaveBeenCalledWith(sourcePath, false);
  });

  it("throws a typed 422 when a deleted-agent source session has no displayable transcript", async () => {
    const agentsDir = path.join(tempDir, "agents");
    const sourcePath = path.join(agentsDir, "deleted", "sessions", "empty.jsonl");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "source", "utf-8");

    (SessionManager.open as any).mockReturnValue({
      getCwd: () => tempDir,
      getBranch: () => [{ type: "message", message: { role: "assistant", content: "<think>private</think>" } }],
    });

    const coordinator = Object.create(SessionCoordinator.prototype);
    coordinator._assertActiveDesktopSessionPath = vi.fn();
    coordinator._d = {
      agentIdFromSessionPath: vi.fn(() => "deleted"),
      isAgentDeleted: vi.fn((agentId) => agentId === "deleted"),
      getPrefs: vi.fn(() => ({ getPrimaryAgent: () => "hana" })),
      getAgentById: vi.fn(() => ({ id: "hana", agentName: "Hana" })),
      getAgent: vi.fn(() => ({ id: "hana", agentName: "Hana" })),
      getHomeCwd: vi.fn(() => tempDir),
    };
    coordinator.createSession = vi.fn();
    coordinator.applySessionBranchHead = vi.fn();

    await expect(coordinator.continueDeletedAgentSession(sourcePath)).rejects.toMatchObject({
      code: "SESSION_TRANSCRIPT_EMPTY",
      status: 422,
    });
    expect(coordinator.createSession).not.toHaveBeenCalled();
  });

  const isoDeps = () => ({
    agentsDir: "/tmp/agents",
    getAgent: () => ({ agentDir: tempDir, sessionDir: tempDir, agentName: "test-agent", config: { models: { chat: { id: "default-model", provider: "test" } } }, tools: [] }),
    getActiveAgentId: () => "hana",
    getModels: () => ({ authStorage: {}, modelRegistry: {}, defaultModel: { id: "default-model", provider: "test" }, availableModels: [{ id: "default-model", provider: "test" }], resolveExecutionModel: (m) => m, resolveThinkingLevel: () => "medium" }),
    getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
    getSkills: () => ({ getSkillsForAgent: () => [] }),
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: () => {},
    getHomeCwd: () => tempDir,
    agentIdFromSessionPath: () => null,
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: () => null,
    listAgents: () => [],
    sessionManifestStore: createTestSessionManifestStore(),
  });

  it("executeIsolated: resumeSessionPath 存在时 open 续接而非 create，并先修孤儿 toolResult", async () => {
    const resumeFile = path.join(tempDir, "reuse-instance.jsonl");
    fs.writeFileSync(resumeFile, '{"type":"user","content":"hi"}\n');
    const existingManifest = {
      sessionId: "sess_resumed_identity",
      ownerAgentId: "hana",
      domain: "subagent",
      kind: "subagent_child",
      lifecycle: "active",
      currentLocator: { path: resumeFile },
    };
    const sessionManifestStore = {
      resolveByLocatorPath: vi.fn((candidate) => candidate === resumeFile ? existingManifest : null),
      getBySessionId: vi.fn((sessionId) => sessionId === existingManifest.sessionId ? existingManifest : null),
      getBranchHead: vi.fn(() => null),
      setBranchHead: vi.fn(),
      createForPath: vi.fn(),
      updateLocatorLifecycle: vi.fn(),
    };
    const buildTools = vi.fn((_cwd, customTools, options) => {
      expect(options.runtimeSessionRef).toEqual({
        sessionId: existingManifest.sessionId,
        sessionPath: resumeFile,
      });
      expect(options.requireSessionIdentity).toBe(true);
      return { tools: [], customTools };
    });
    const piSdk = await import("../lib/pi-sdk/index.ts");
    (piSdk.SessionManager.open as any).mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => resumeFile,
      getEntries: () => [],
      resetLeaf: vi.fn(),
    });
    createAgentSessionMock.mockResolvedValue({
      session: { sessionManager: { getSessionFile: () => resumeFile }, subscribe: vi.fn(() => vi.fn()), abort: vi.fn() },
    });
    const coordinator = new SessionCoordinator({
      ...isoDeps(),
      buildTools,
      sessionManifestStore,
    });
    const repairSpy = vi.spyOn(coordinator, "_repairOrphanToolHistory").mockImplementation(() => {});
    await coordinator.executeIsolated("continue task", { resumeSessionPath: resumeFile, persist: tempDir });
    expect(piSdk.SessionManager.open).toHaveBeenCalledWith(resumeFile, tempDir);
    expect(sessionManagerCreateMock).not.toHaveBeenCalled();
    expect(repairSpy).toHaveBeenCalledWith(resumeFile);
    expect(buildTools).toHaveBeenCalledOnce();
    expect(sessionManifestStore.createForPath).not.toHaveBeenCalled();
    expect(sessionManifestStore.updateLocatorLifecycle).not.toHaveBeenCalled();
  });

  it("executeIsolated resumes a forked child with shared cache lineage and an independent Pi identity", async () => {
    const resumeFile = path.join(tempDir, "forked-child.jsonl");
    fs.writeFileSync(resumeFile, '{"type":"user","content":"hi"}\n');
    fs.writeFileSync(path.join(tempDir, "session-meta.json"), JSON.stringify({
      [path.basename(resumeFile)]: {
        providerCacheAffinityKey: "pi-source-lineage",
      },
    }));
    const existingManifest = {
      sessionId: "sess_forked_child",
      ownerAgentId: "hana",
      domain: "subagent",
      kind: "subagent_child",
      lifecycle: "active",
      currentLocator: { path: resumeFile },
    };
    const sessionManifestStore = {
      resolveByLocatorPath: vi.fn((candidate) => candidate === resumeFile ? existingManifest : null),
      getBySessionId: vi.fn((sessionId) => sessionId === existingManifest.sessionId ? existingManifest : null),
      getBranchHead: vi.fn(() => null),
      setBranchHead: vi.fn(),
      createForPath: vi.fn(),
      updateLocatorLifecycle: vi.fn(),
    };
    const manager = {
      getCwd: () => tempDir,
      getSessionFile: () => resumeFile,
      getSessionId: () => "pi-child",
      getBranch: () => [],
      getEntries: () => [],
      getLeafId: () => null,
      resetLeaf: vi.fn(),
      branch: vi.fn(),
    };
    const piSdk = await import("../lib/pi-sdk/index.ts");
    (piSdk.SessionManager.open as any).mockReturnValue(manager);
    const codexModel = {
      id: "gpt-test",
      provider: "openai-codex",
      api: "openai-codex-responses",
    };
    let capturedOptions: any = null;
    const originalStreamFn = vi.fn((_model, _context, options) => {
      capturedOptions = options;
      return {};
    });
    const session: any = {
      agent: { streamFn: originalStreamFn },
      sessionManager: manager,
      subscribe: vi.fn(() => vi.fn()),
      abort: vi.fn(),
    };
    session.prompt = vi.fn(async () => {
      await session.agent.streamFn(codexModel, { messages: [] }, {
        sessionId: "pi-child",
        headers: { "x-test": "1" },
      });
    });
    createAgentSessionMock.mockResolvedValue({ session });
    const coordinator = new SessionCoordinator({
      ...isoDeps(),
      sessionManifestStore,
    });
    vi.spyOn(coordinator, "_repairOrphanToolHistory").mockImplementation(() => {});

    await coordinator.executeIsolated("continue task", {
      resumeSessionPath: resumeFile,
      persist: tempDir,
      model: codexModel,
    });

    expect(originalStreamFn).toHaveBeenCalledOnce();
    expect(capturedOptions.sessionId).toBe("pi-child");
    expect(capturedOptions.headers).toEqual({ "x-test": "1" });
    await expect(capturedOptions.onPayload({
      prompt_cache_key: "pi-child",
      input: [],
    }, codexModel)).resolves.toMatchObject({
      prompt_cache_key: "pi-source-lineage",
      input: [],
    });
  });

  it("executeIsolated backfills a missing legacy identity once and reuses it", async () => {
    const resumeFile = path.join(tempDir, "legacy-without-manifest.jsonl");
    fs.writeFileSync(resumeFile, '{"type":"user","content":"hi"}\n');
    let manifest = null;
    const sessionManifestStore = {
      resolveByLocatorPath: vi.fn((candidate) => (
        manifest?.currentLocator?.path === candidate ? manifest : null
      )),
      getBySessionId: vi.fn((sessionId) => manifest?.sessionId === sessionId ? manifest : null),
      getBranchHead: vi.fn(() => null),
      setBranchHead: vi.fn(),
      createForPath: vi.fn((input) => {
        manifest = {
          ...input,
          sessionId: "sess_legacy_backfilled",
          lifecycle: "active",
          currentLocator: { path: input.sessionPath },
        };
        return manifest;
      }),
      updateLocatorLifecycle: vi.fn(),
    };
    const assembledRefs = [];
    const buildTools = vi.fn((_cwd, customTools, options) => {
      assembledRefs.push(options.runtimeSessionRef);
      expect(options.requireSessionIdentity).toBe(true);
      return { tools: [], customTools };
    });
    const piSdk = await import("../lib/pi-sdk/index.ts");
    (piSdk.SessionManager.open as any).mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => resumeFile,
      getEntries: () => [],
      resetLeaf: vi.fn(),
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => resumeFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });
    const coordinator = new SessionCoordinator({
      ...isoDeps(),
      buildTools,
      sessionManifestStore,
    });
    vi.spyOn(coordinator, "_repairOrphanToolHistory").mockImplementation(() => {});

    await coordinator.executeIsolated("first run", { resumeSessionPath: resumeFile, persist: tempDir });
    await coordinator.executeIsolated("second run", { resumeSessionPath: resumeFile, persist: tempDir });

    expect(sessionManifestStore.createForPath).toHaveBeenCalledOnce();
    expect(assembledRefs).toEqual([
      { sessionId: "sess_legacy_backfilled", sessionPath: resumeFile },
      { sessionId: "sess_legacy_backfilled", sessionPath: resumeFile },
    ]);
  });

  it("executeIsolated: resume 实例被 abort 不删持久文件（cleanup 保护，对照临时 session 会删）", async () => {
    const resumeFile = path.join(tempDir, "reuse-keep.jsonl");
    fs.writeFileSync(resumeFile, '{"type":"user","content":"hi"}\n');
    const piSdk = await import("../lib/pi-sdk/index.ts");
    (piSdk.SessionManager.open as any).mockReturnValue({ getCwd: () => tempDir, getSessionFile: () => resumeFile });
    const controller = new AbortController();
    createAgentSessionMock.mockImplementation(async () => {
      controller.abort();
      return { session: { sessionManager: { getSessionFile: () => resumeFile }, subscribe: vi.fn(() => vi.fn()), abort: vi.fn() } };
    });
    const coordinator = new SessionCoordinator(isoDeps());
    vi.spyOn(coordinator, "_repairOrphanToolHistory").mockImplementation(() => {});
    await coordinator.executeIsolated("continue task", { resumeSessionPath: resumeFile, persist: tempDir, signal: controller.signal });
    expect(fs.existsSync(resumeFile)).toBe(true); // 持久实例文件保留（cleanup 保护生效）
  });

  it("executeIsolated registers a stable identity before building activity tools", async () => {
    const sessionFile = path.join(tempDir, "heartbeat-identity.jsonl");
    let manifest = null;
    const sessionManifestStore = {
      resolveByLocatorPath: vi.fn((candidate) => manifest?.currentLocator?.path === candidate ? manifest : null),
      getBySessionId: vi.fn((sessionId) => manifest?.sessionId === sessionId ? manifest : null),
      createForPath: vi.fn((input) => {
        manifest = {
          sessionId: "sess_activity_identity",
          lifecycle: input.lifecycle,
          domain: input.domain,
          kind: input.kind,
          currentLocator: { path: input.sessionPath },
        };
        return manifest;
      }),
      updateLocatorLifecycle: vi.fn(),
    };
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      agentName: "Hana",
      memoryMasterEnabled: true,
      systemPrompt: "BACKGROUND PROMPT",
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      tools: [],
    };
    const buildTools = vi.fn((_cwd, customTools, options) => {
      expect(options.runtimeSessionRef).toEqual({
        sessionId: "sess_activity_identity",
        sessionPath: sessionFile,
      });
      expect(options.requireSessionIdentity).toBe(true);
      expect(options.getAgentId()).toBe("hana");
      expect(sessionManifestStore.resolveByLocatorPath(sessionFile)?.sessionId)
        .toBe("sess_activity_identity");
      return { tools: [], customTools };
    });
    sessionManagerCreateMock.mockReturnValue({ getCwd: () => tempDir, getSessionFile: () => sessionFile });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      ...isoDeps(),
      getAgent: () => agent,
      getAgentById: () => agent,
      buildTools,
      sessionManifestStore,
    });
    const result = await coordinator.executeIsolated("background check", {
      persist: tempDir,
      activityType: "heartbeat",
    });

    expect(result.error).toBeNull();
    expect(sessionManifestStore.createForPath).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: sessionFile,
      ownerAgentId: "hana",
      domain: "activity",
      kind: "activity",
    }));
  });

  it("executeIsolated tombstones a fresh identity before removing a failed initialization file", async () => {
    const sessionFile = path.join(tempDir, "heartbeat-build-failure.jsonl");
    fs.writeFileSync(sessionFile, "", "utf-8");
    let manifest = null;
    const sessionManifestStore = {
      resolveByLocatorPath: vi.fn((candidate) => manifest?.currentLocator?.path === candidate ? manifest : null),
      getBySessionId: vi.fn((sessionId) => manifest?.sessionId === sessionId ? manifest : null),
      createForPath: vi.fn((input) => {
        manifest = {
          sessionId: "sess_activity_failure",
          lifecycle: "active",
          currentLocator: { path: input.sessionPath },
        };
        return manifest;
      }),
      updateLocatorLifecycle: vi.fn((sessionId, nextPath, lifecycle) => {
        manifest = { ...manifest, sessionId, lifecycle, currentLocator: { path: nextPath } };
        return manifest;
      }),
    };
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      agentName: "Hana",
      memoryMasterEnabled: true,
      systemPrompt: "BACKGROUND PROMPT",
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      tools: [],
    };
    sessionManagerCreateMock.mockReturnValue({ getCwd: () => tempDir, getSessionFile: () => sessionFile });
    const coordinator = new SessionCoordinator({
      ...isoDeps(),
      getAgent: () => agent,
      getAgentById: () => agent,
      buildTools: vi.fn(() => { throw new Error("tool assembly failed"); }),
      sessionManifestStore,
    });

    const result = await coordinator.executeIsolated("background check", {
      persist: tempDir,
      activityType: "heartbeat",
    });

    expect(result.error).toBe("tool assembly failed");
    expect(sessionManifestStore.updateLocatorLifecycle).toHaveBeenCalledWith(
      "sess_activity_failure",
      sessionFile,
      "deleted",
      "isolated_initialization_failed",
    );
    expect(fs.existsSync(sessionFile)).toBe(false);
    expect(createAgentSessionMock).not.toHaveBeenCalled();
  });

  it("executeIsolated rejects an SDK runtime whose locator differs from the assembled SessionRef", async () => {
    const identityPath = path.join(tempDir, "identity-before-sdk.jsonl");
    const runtimePath = path.join(tempDir, "different-runtime.jsonl");
    const prompt = vi.fn(async () => {});
    const dispose = vi.fn();
    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => identityPath,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => runtimePath },
        subscribe: vi.fn(() => vi.fn()),
        prompt,
        dispose,
      },
    });
    const coordinator = new SessionCoordinator(isoDeps());

    const result = await coordinator.executeIsolated("background check", { persist: tempDir });

    expect(result.error).toMatch(/runtime locator does not match/);
    expect(prompt).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("releases a streaming session immediately when the provider abort never settles", async () => {
    const sessionFile = path.join(tempDir, "stuck-stream.jsonl");
    const emitEvent = vi.fn();
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    const abort = vi.fn(() => new Promise(() => {}));
    const stuckSession = {
      isStreaming: true,
      sessionManager: { getSessionFile: () => sessionFile },
      abort,
      dispose,
      extensionRunner: null,
    };

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => ({
        id: "hana",
        agentDir: tempDir,
        sessionDir: tempDir,
        _memoryTicker: { notifySessionEnd: vi.fn(() => Promise.resolve()) },
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent,
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });
    coordinator.sessions.set(sessionFile, {
      session: stuckSession,
      agentId: "hana",
      lastTouchedAt: Date.now(),
      unsub: unsubscribe,
    });
    coordinator._session = stuckSession;

    const result = await Promise.race([
      coordinator.abortSession(sessionFile),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 25)),
    ]);

    expect(result).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalled();
    expect(coordinator.isSessionStreaming(sessionFile)).toBe(false);
    expect(coordinator.session).toBeNull();
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_status", isStreaming: false, aborted: true }),
      sessionFile,
    );
  });

  it("emits a synthetic turn_end before releasing an aborted streaming session", async () => {
    const sessionFile = path.join(tempDir, "aborted-turn-end.jsonl");
    let coordinator: any;
    const events: any[] = [];
    const emitEvent = vi.fn((event: any, sp: any) => {
      events.push({
        type: event.type,
        aborted: event.aborted,
        isStreaming: event.isStreaming,
        sp,
        sessionAlive: coordinator?.getSessionByPath(sessionFile) != null,
      });
    });
    const unsubscribe = vi.fn();
    const stuckSession = {
      isStreaming: true,
      sessionManager: { getSessionFile: () => sessionFile },
      abort: vi.fn(),
      dispose: vi.fn(),
      extensionRunner: null,
    };

    coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => ({
        id: "hana",
        agentDir: tempDir,
        sessionDir: tempDir,
        _memoryTicker: { notifySessionEnd: vi.fn(() => Promise.resolve()) },
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent,
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });
    coordinator.sessions.set(sessionFile, {
      session: stuckSession,
      agentId: "hana",
      lastTouchedAt: Date.now(),
      unsub: unsubscribe,
    });

    await coordinator.abortSession(sessionFile);

    const turnEndIndex = events.findIndex(
      (e) => e.type === "turn_end" && e.aborted === true && e.sp === sessionFile,
    );
    const statusIndex = events.findIndex(
      (e) => e.type === "session_status" && e.isStreaming === false,
    );
    expect(turnEndIndex).toBeGreaterThanOrEqual(0);
    expect(statusIndex).toBeGreaterThanOrEqual(0);
    expect(turnEndIndex).toBeLessThan(statusIndex);
    expect(events[turnEndIndex].sessionAlive).toBe(true);
  });

  it("aborts session-owned sidecars when the user cancels a streaming session", async () => {
    const sessionFile = path.join(tempDir, "cancel-sidecars.jsonl");
    const taskRegistry = { abortByParentSession: vi.fn() };
    const subagentRuns = { abortByParentSession: vi.fn() };
    const subagentThreads = { removeBySession: vi.fn() };
    const deferredStore = { suppressBySession: vi.fn() };
    const confirmStore = { abortBySession: vi.fn() };
    const closeTerminalsForSession = vi.fn();
    const closeBrowserForSession = vi.fn(async () => undefined);
    const browserSpy = vi.spyOn(BrowserManager, "instance").mockReturnValue({
      closeBrowserForSession,
    } as any);
    const stuckSession = {
      isStreaming: true,
      sessionManager: { getSessionFile: () => sessionFile },
      abort: vi.fn(),
      dispose: vi.fn(),
      extensionRunner: null,
    };
    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => ({
        id: "hana",
        agentDir: tempDir,
        sessionDir: tempDir,
        _memoryTicker: { notifySessionEnd: vi.fn(() => Promise.resolve()) },
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
      taskRegistry,
      subagentRuns,
      subagentThreads,
      getDeferredResultStore: () => deferredStore,
      getConfirmStore: () => confirmStore,
      closeTerminalsForSession,
    });
    coordinator.sessions.set(sessionFile, {
      session: stuckSession,
      agentId: "hana",
      lastTouchedAt: Date.now(),
      unsub: vi.fn(),
    });

    try {
      await coordinator.abortSession(sessionFile);

      expect(taskRegistry.abortByParentSession).toHaveBeenCalledWith(sessionFile, "abort");
      expect(subagentRuns.abortByParentSession).toHaveBeenCalledWith(sessionFile, "abort");
      expect(subagentThreads.removeBySession).toHaveBeenCalledWith(sessionFile);
      expect(deferredStore.suppressBySession).toHaveBeenCalledWith(sessionFile, "abort");
      expect(confirmStore.abortBySession).toHaveBeenCalledWith(sessionFile);
      expect(closeTerminalsForSession).toHaveBeenCalledWith(sessionFile);
      expect(closeBrowserForSession).toHaveBeenCalledWith(sessionFile);
    } finally {
      browserSpy.mockRestore();
    }
  });

  it("cleans session-owned execution even when the main session no longer reports streaming", async () => {
    const sessionFile = path.join(tempDir, "cancel-detached-execution.jsonl");
    const abortToolExecutionsForSession = vi.fn(() => ({ matched: 1, aborted: 1 }));
    const taskRegistry = { abortByParentSession: vi.fn() };
    const idleSession = {
      isStreaming: false,
      sessionManager: { getSessionFile: () => sessionFile },
      abort: vi.fn(),
      dispose: vi.fn(),
      extensionRunner: null,
    };
    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => ({
        id: "hana",
        agentDir: tempDir,
        sessionDir: tempDir,
        _memoryTicker: { notifySessionEnd: vi.fn(() => Promise.resolve()) },
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
      getSessionIdForPath: () => "session-1",
      abortToolExecutionsForSession,
      taskRegistry,
    });
    coordinator.sessions.set(sessionFile, {
      session: idleSession,
      agentId: "hana",
      lastTouchedAt: Date.now(),
      unsub: vi.fn(),
    });

    await expect(coordinator.abortSession(sessionFile, { reason: "user_abort" })).resolves.toBe(false);
    expect(abortToolExecutionsForSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      sessionPath: sessionFile,
    }, "user_abort");
    expect(taskRegistry.abortByParentSession).toHaveBeenCalledWith(sessionFile, "user_abort");
    expect(idleSession.abort).not.toHaveBeenCalled();
  });

  it("immediately publishes a terminal status when stopping pre-prompt preparation", async () => {
    const sessionFile = path.join(tempDir, "cancel-pre-prompt.jsonl");
    const emitEvent = vi.fn();
    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => null,
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent,
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });
    const pending = new AbortController();
    coordinator._setRuntimeValueForPath(coordinator._prePromptAbortControllers, sessionFile, pending);

    await expect(coordinator.abortSession(sessionFile, { reason: "user_abort" })).resolves.toBe(true);

    expect(pending.signal.aborted).toBe(true);
    expect(emitEvent).toHaveBeenCalledWith({
      type: "session_status",
      isStreaming: false,
      aborted: true,
      reason: "user_abort",
    }, sessionFile);
  });

  it("executeIsolated builds non-session tools from the master memory switch, not the focused session switch", async () => {
    const sessionFile = path.join(tempDir, "isolated-master-tools.jsonl");
    const builtinTool = { name: "read" };
    const plainTool = { name: "plain_custom" };
    const memoryTool = { name: "search_memory" };
    const getToolsSnapshot = vi.fn(({ forceMemoryEnabled }: any = {}) => (
      forceMemoryEnabled ? [plainTool, memoryTool] : [plainTool]
    ));
    const buildTools = vi.fn((_cwd, customTools) => ({
      tools: [builtinTool],
      customTools,
    }));
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      agentName: "hana",
      memoryMasterEnabled: true,
      sessionMemoryEnabled: false,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      systemPrompt: "MEMORY MASTER PROMPT",
      tools: [plainTool],
      getToolsSnapshot,
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
      sessionManifestStore: createTestSessionManifestStore(),
    });

    await coordinator.executeIsolated("background check");

    expect(getToolsSnapshot).toHaveBeenCalledWith({
      forceMemoryEnabled: true,
      model: { id: "default-model", provider: "test" },
    });
    expect(buildTools.mock.calls[0][1].map((tool) => tool.name)).toEqual([
      "plain_custom",
      "search_memory",
    ]);
    expect(createAgentSessionMock.mock.calls[0][0].customTools.map((tool) => tool.name)).toContain("search_memory");
  });

  it("executeIsolated closes the browser owned by its temporary session without sweeping other sessions", async () => {
    const sessionFile = path.join(tempDir, "isolated-browser.jsonl");
    const otherSessionFile = path.join(tempDir, "other-session.jsonl");
    const bm = BrowserManager.instance();
    const hasAnyRunningSpy = vi.spyOn(bm, "hasAnyRunning", "get").mockReturnValue(true);
    const isRunningSpy = vi.spyOn(bm, "isRunning").mockImplementation((sp) => sp === sessionFile);
    const setHeadlessSpy = vi.spyOn(bm, "setHeadless").mockImplementation(() => {});
    const closeBrowserSpy = (vi.spyOn(bm, "closeBrowserForSession").mockResolvedValue as any)();

    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      agentName: "hana",
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      systemPrompt: "BACKGROUND PROMPT",
      tools: [],
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
      sessionManifestStore: createTestSessionManifestStore(),
    });

    try {
      await coordinator.executeIsolated("background browser task");

      expect(closeBrowserSpy).toHaveBeenCalledWith(sessionFile);
      expect(closeBrowserSpy).not.toHaveBeenCalledWith(otherSessionFile);
      expect(setHeadlessSpy).toHaveBeenCalledWith(true);
      expect(setHeadlessSpy).toHaveBeenCalledWith(false);
    } finally {
      hasAnyRunningSpy.mockRestore();
      isRunningSpy.mockRestore();
      setHeadlessSpy.mockRestore();
      closeBrowserSpy.mockRestore();
    }
  });

  it("executeIsolated activates a cold target agent before reading its runtime tools", async () => {
    const sessionFile = path.join(tempDir, "isolated-cold-agent.jsonl");
    const calls = [];
    const getToolsSnapshot = vi.fn(() => {
      calls.push("tools");
      return [{ name: "write" }];
    });
    const agent = {
      id: "cold-agent",
      agentDir: path.join(tempDir, "agents", "cold-agent"),
      sessionDir: path.join(tempDir, "agents", "cold-agent", "sessions"),
      agentName: "cold-agent",
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      systemPrompt: "BACKGROUND PROMPT",
      getToolsSnapshot,
    };
    const ensureAgentRuntime = vi.fn(async (agentId) => {
      calls.push("ensure");
      expect(agentId).toBe("cold-agent");
      return agent;
    });

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => ({ id: "focus" }),
      getActiveAgentId: () => "focus",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: (_cwd, customTools) => ({ tools: [], customTools }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map([["cold-agent", agent]]),
      getActivityStore: () => null,
      getAgentById: (agentId) => (agentId === "cold-agent" ? agent : null),
      ensureAgentRuntime,
      listAgents: () => [],
      sessionManifestStore: createTestSessionManifestStore(),
    });

    await coordinator.executeIsolated("background check", { agentId: "cold-agent" });

    expect(ensureAgentRuntime).toHaveBeenCalledOnce();
    expect(getToolsSnapshot).toHaveBeenCalledOnce();
    expect(calls).toEqual(["ensure", "tools"]);
  });

  it("executeIsolated runs background tools in operate mode instead of ask mode", async () => {
    const sessionFile = path.join(tempDir, "isolated-operate-permission.jsonl");
    let getPermissionMode;
    const buildTools = vi.fn((_cwd, customTools, opts) => {
      getPermissionMode = opts.getPermissionMode;
      return { tools: [], customTools };
    });
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      agentName: "hana",
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      systemPrompt: "BACKGROUND PROMPT",
      tools: [{ name: "write" }],
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      sessionManifestStore: createTestSessionManifestStore(),
    });

    const result = await coordinator.executeIsolated("background check");

    expect(result.error).toBeNull();
    expect(buildTools).toHaveBeenCalledOnce();
    expect(getPermissionMode).toEqual(expect.any(Function));
    expect(getPermissionMode()).toBe("operate");
    expect(getPermissionMode(sessionFile)).toBe("operate");
  });

  it("executeIsolated appends execution-scoped custom tools", async () => {
    const sessionFile = path.join(tempDir, "isolated-extra-tool.jsonl");
    const buildTools = vi.fn((_cwd, customTools, buildOpts: any = {}) => ({
      tools: [],
      customTools: [...customTools, ...(buildOpts.extraCustomTools || [])],
    }));
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      agentName: "hana",
      memoryMasterEnabled: true,
      config: {
        models: { chat: { id: "default-model", provider: "test" } },
        desk: { patrol_tools: [] },
      },
      systemPrompt: "BACKGROUND PROMPT",
      tools: [{ name: "write" }],
    };
    const scopedTool = { name: "jian_update_status", execute: vi.fn() };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      ensureAgentRuntime: async () => agent,
      listAgents: () => [],
      sessionManifestStore: createTestSessionManifestStore(),
    });

    const result = await coordinator.executeIsolated("background check", {
      activityType: "heartbeat",
      extraCustomTools: [scopedTool],
    });

    expect(result.error).toBeNull();
    expect(createAgentSessionMock.mock.calls[0][0].customTools.map((tool) => tool.name)).toEqual(["jian_update_status"]);
  });

  it("executeIsolated snapshots tools into session-meta for promotable activity sessions", async () => {
    const agentDir = path.join(tempDir, "agents", "hana");
    const activityDir = path.join(agentDir, "activity");
    const sessionDir = path.join(agentDir, "sessions");
    const sessionFile = path.join(activityDir, "heartbeat-session.jsonl");
    const buildTools = vi.fn((_cwd, _customTools, buildOpts: any = {}) => ({
      tools: [{ name: "read" }],
      customTools: [
        { name: "todo_write" },
        { name: "mcp_github_search", _pluginId: "github" },
        { name: "cron" },
        ...(buildOpts.extraCustomTools || []),
      ],
    }));
    const agent = {
      id: "hana",
      agentDir,
      sessionDir,
      agentName: "hana",
      memoryMasterEnabled: true,
      config: {
        models: { chat: { id: "default-model", provider: "test" } },
        desk: { patrol_tools: "*" },
      },
      systemPrompt: "BACKGROUND PROMPT",
      tools: [{ name: "write" }],
    };
    const scopedTool = { name: "patrol_update_log", execute: vi.fn() };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: (sessionPath) => sessionPath.includes(`${path.sep}sessions${path.sep}`) ? "hana" : null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      ensureAgentRuntime: async () => agent,
      listAgents: () => [],
      sessionManifestStore: createTestSessionManifestStore(),
    });

    const result = await coordinator.executeIsolated("background check", {
      persist: activityDir,
      activityType: "heartbeat",
      extraCustomTools: [scopedTool],
    });

    expect(result.error).toBeNull();
    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta["heartbeat-session.jsonl"].toolNames).toEqual([
      "read",
      "todo_write",
      "mcp_github_search",
      "patrol_update_log",
    ]);
  });

  it("promoteActivitySession backfills missing tool snapshots for legacy activity sessions", async () => {
    const agentDir = path.join(tempDir, "agents", "hana");
    const activityDir = path.join(agentDir, "activity");
    const sessionDir = path.join(agentDir, "sessions");
    const activityFile = path.join(activityDir, "legacy-activity.jsonl");
    fs.mkdirSync(activityDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(activityFile, "", "utf-8");
    const manifestStore = new SessionManifestStore({
      dbPath: path.join(tempDir, "promotion-manifest.db"),
      idGenerator: () => "sess_activity_promoted",
      now: () => "2026-07-14T01:00:00.000Z",
    });
    const activityManifest = manifestStore.createForPath({
      sessionPath: activityFile,
      ownerAgentId: "hana",
      domain: "activity",
      kind: "activity",
      lifecycle: "active",
    });

    const agent = {
      id: "hana",
      agentDir,
      sessionDir,
      agentName: "hana",
      memoryMasterEnabled: true,
      experienceEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      tools: [{ name: "write" }],
    };
    const buildTools = vi.fn(() => ({
      tools: [{ name: "read" }],
      customTools: [{ name: "mcp_github_search", _pluginId: "github" }],
    }));

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: (sessionPath) => sessionPath.includes(`${path.sep}sessions${path.sep}`) ? "hana" : null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      ensureAgentRuntime: async () => agent,
      listAgents: () => [],
      sessionManifestStore: manifestStore,
    });

    try {
      const promotedPath = await coordinator.promoteActivitySession("legacy-activity.jsonl", "hana");

      expect(promotedPath).toBe(path.join(sessionDir, "legacy-activity.jsonl"));
      expect(fs.existsSync(promotedPath)).toBe(true);
      const promotedManifest = manifestStore.getBySessionId(activityManifest.sessionId);
      expect(promotedManifest).toMatchObject({
        sessionId: "sess_activity_promoted",
        domain: "desktop",
        kind: "chat",
        lifecycle: "active",
        currentLocator: { path: path.resolve(promotedPath) },
      });
      expect(manifestStore.resolveByLocatorPath(activityFile)?.sessionId).toBe(activityManifest.sessionId);
      const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf-8"));
      expect(meta["legacy-activity.jsonl"].toolNames).toEqual(["read", "mcp_github_search"]);
    } finally {
      manifestStore.close();
    }
  });

  it("executeIsolated builds sandboxed tools against the inherited execution cwd", async () => {
    const sessionFile = path.join(tempDir, "isolated-cwd-tools.jsonl");
    const buildTools = vi.fn((_cwd, customTools) => ({ tools: [], customTools }));
    const homeCwd = path.join(tempDir, "agent-home");
    const inheritedCwd = path.join(tempDir, "inherited-session-cwd");
    const parentSessionPath = path.join(tempDir, "agents", "hana", "sessions", "parent.jsonl");
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      agentName: "hana",
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      tools: [{ name: "write" }],
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => inheritedCwd,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => homeCwd,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      sessionManifestStore: createTestSessionManifestStore(),
    });

    await coordinator.executeIsolated("background check", {
      cwd: inheritedCwd,
      fileReadSessionPaths: [parentSessionPath],
    });

    expect(buildTools).toHaveBeenCalledWith(
      inheritedCwd,
      agent.tools,
      expect.objectContaining({
        agentDir: agent.agentDir,
        workspace: inheritedCwd,
        runtimeSessionRef: {
          sessionId: expect.any(String),
          sessionPath: sessionFile,
        },
        requireSessionIdentity: true,
        fileReadSessionPaths: [parentSessionPath],
      }),
    );
  });

  it("executeIsolated keeps the subagent base cwd-free and appends its inherited workspace scope", async () => {
    const sessionFile = path.join(tempDir, "isolated-cwd-prompt.jsonl");
    const inheritedCwd = path.join(tempDir, "inherited-session-cwd");
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      agentName: "hana",
      memoryMasterEnabled: true,
      config: { locale: "en-US", models: { chat: { id: "default-model", provider: "test" } } },
      tools: [{ name: "write" }],
      buildSystemPrompt: vi.fn(() => "SUBAGENT PROMPT"),
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => inheritedCwd,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => path.join(tempDir, "agent-home"),
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      sessionManifestStore: createTestSessionManifestStore(),
    });

    await coordinator.executeIsolated("background check", {
      cwd: inheritedCwd,
      subagentContext: true,
    });

    expect(agent.buildSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        forSubagent: true,
      }),
    );
    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt())
      .toBe("SUBAGENT PROMPT");
    const append = createAgentSessionMock.mock.calls[0][0].resourceLoader.getAppendSystemPrompt();
    expect(append.join("\n\n")).toContain(`Primary workbench: ${inheritedCwd}`);
    expect(append.join("\n\n")).not.toContain("Current working directory");
  });

  it("executeIsolated reports incomplete final assistant stop reasons", async () => {
    const sessionFile = path.join(tempDir, "isolated-length.jsonl");
    let subscriber;
    const session = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn((fn) => {
        subscriber = fn;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } });
        subscriber?.({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "length",
            content: [{ type: "text", text: "partial" }],
          },
        });
      }),
      abort: vi.fn(),
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      agentName: "hana",
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      tools: [{ name: "write" }],
      buildSystemPrompt: () => "SUBAGENT PROMPT",
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      sessionManifestStore: createTestSessionManifestStore(),
    });

    const result = await coordinator.executeIsolated("background check", {
      subagentContext: true,
      persist: path.join(tempDir, "subagent-sessions"),
    });

    expect(result.replyText).toBe("partial");
    expect(result.stopReason).toBe("length");
    expect(result.error).toMatch(/length|limit|未完成|截断/);
  });

  it("executeIsolated strips closed internal narration blocks from returned reply text", async () => {
    const sessionFile = path.join(tempDir, "isolated-internal-narration.jsonl");
    let subscriber;
    const session = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn((fn) => {
        subscriber = fn;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "<mood>\nVibe: working\nWill: report cleanly\n</mood>\n调研结论：A 可以复现。",
          },
        });
        subscriber?.({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "<mood>\nVibe: working\n</mood>\n调研结论：A 可以复现。" }],
          },
        });
      }),
      abort: vi.fn(),
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      agentName: "hana",
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      tools: [{ name: "write" }],
      buildSystemPrompt: () => "SUBAGENT PROMPT",
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      sessionManifestStore: createTestSessionManifestStore(),
    });

    const result = await coordinator.executeIsolated("background check", {
      subagentContext: true,
      persist: path.join(tempDir, "subagent-sessions"),
    });

    expect(result.replyText).toBe("调研结论：A 可以复现。");
  });

  it("executeIsolated preserves text after an unclosed internal narration opener", async () => {
    const sessionFile = path.join(tempDir, "isolated-unclosed-internal-narration.jsonl");
    let subscriber;
    const rawText = "<mood>\nVibe: started but never closed\n真正正文不能被吞掉。";
    const session = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn((fn) => {
        subscriber = fn;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: rawText },
        });
        subscriber?.({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: rawText }],
          },
        });
      }),
      abort: vi.fn(),
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      agentName: "hana",
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      tools: [{ name: "write" }],
      buildSystemPrompt: () => "SUBAGENT PROMPT",
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      sessionManifestStore: createTestSessionManifestStore(),
    });

    const result = await coordinator.executeIsolated("background check", {
      subagentContext: true,
      persist: path.join(tempDir, "subagent-sessions"),
    });

    expect(result.replyText).toBe(rawText);
  });

  it("executeIsolated returns session files produced by write/edit tools", async () => {
    const sessionFile = path.join(tempDir, "isolated-files.jsonl");
    const producedFile = { filePath: path.join(tempDir, "report.md"), label: "report.md" };
    let subscriber;
    const session = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn((fn) => {
        subscriber = fn;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscriber?.({
          type: "tool_execution_end",
          toolName: "write",
          isError: false,
          result: { details: { sessionFile: producedFile } },
        });
        subscriber?.({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [],
          },
        });
      }),
      abort: vi.fn(),
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      agentName: "hana",
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      tools: [{ name: "write" }],
      buildSystemPrompt: () => "SUBAGENT PROMPT",
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt", getAppendSystemPrompt: () => [] }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      sessionManifestStore: createTestSessionManifestStore(),
    });

    const result = await coordinator.executeIsolated("write a report", {
      subagentContext: true,
      persist: path.join(tempDir, "subagent-sessions"),
    });

    expect(result.error).toBeNull();
    expect(result.stopReason).toBe("stop");
    expect(result.sessionFiles).toEqual([producedFile]);
  });

  it("switchSession 拒绝 subagent-sessions/activity/.ephemeral 等旁路路径", async () => {
    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({ sessionDir: "/tmp/agents/hana/sessions" }),
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "BASE" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await expect(
      coordinator.switchSession("/tmp/agents/hana/subagent-sessions/child.jsonl"),
    ).rejects.toThrow(/path must be in/);
    await expect(
      coordinator.switchSession("/tmp/agents/hana/activity/tick.jsonl"),
    ).rejects.toThrow(/path must be in/);
    await expect(
      coordinator.switchSession("/tmp/agents/hana/.ephemeral/iso.jsonl"),
    ).rejects.toThrow(/path must be in/);
  });

  it("listSessions 不给旁路路径（subagent-sessions 等）伪造占位条目", async () => {
    const agent = {
      id: "hana",
      agentName: "小花",
      sessionDir: path.join(tempDir, "hana", "sessions"),
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "BASE" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [{ id: "hana", name: "小花" }],
    });

    // 模拟焦点被污染到 subagent-sessions 下
    const subagentPath = path.join(tempDir, "hana", "subagent-sessions", "child.jsonl");
    coordinator._session = {
      sessionManager: {
        getSessionFile: () => subagentPath,
        getCwd: () => "/tmp/home",
      },
    };
    coordinator._sessionStarted = true;

    const sessions = await coordinator.listSessions();
    expect(sessions.find((s) => s.path === subagentPath)).toBeUndefined();
  });

  it("discardSessionRuntime clears live and hibernated entries plus focus state", async () => {
    const agent = {
      id: "hana",
      agentName: "小花",
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      _memoryTicker: { notifySessionEnd: vi.fn(async () => undefined) },
    };
    const livePath = path.join(agent.sessionDir, "live.jsonl");
    const hibernatedPath = path.join(agent.sessionDir, "hibernated.jsonl");
    fs.mkdirSync(agent.sessionDir, { recursive: true });

    const session = {
      isStreaming: false,
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => livePath },
    };
    const unsub = vi.fn();
    const confirmStore = { abortBySession: vi.fn() };
    const deferredStore = { clearBySession: vi.fn() };
    const closeTerminalsForSession = vi.fn();
    const onSessionRuntimeDiscarded = vi.fn();
    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "BASE" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [{ id: "hana", name: "小花" }],
      getConfirmStore: () => confirmStore,
      getDeferredResultStore: () => deferredStore,
      closeTerminalsForSession,
      onSessionRuntimeDiscarded,
    });

    coordinator._sessions.set(livePath, { session, agentId: "hana", unsub });
    coordinator._hibernatedSessionMeta.set(hibernatedPath, { agentId: "hana" });
    coordinator._session = session;
    coordinator._currentSessionPath = livePath;
    coordinator._sessionStarted = true;

    await expect(coordinator.discardSessionRuntime(livePath, "archive")).resolves.toBe(true);
    await expect(coordinator.discardSessionRuntime(hibernatedPath, "archive")).resolves.toBe(true);
    await expect(coordinator.discardSessionRuntime(path.join(agent.sessionDir, "missing.jsonl"), "archive")).resolves.toBe(false);

    expect(coordinator._sessions.has(livePath)).toBe(false);
    expect(coordinator._hibernatedSessionMeta.has(hibernatedPath)).toBe(false);
    expect(coordinator.currentSessionPath).toBe(null);
    expect(coordinator._sessionStarted).toBe(false);
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(confirmStore.abortBySession).toHaveBeenCalledWith(livePath);
    expect(confirmStore.abortBySession).toHaveBeenCalledWith(hibernatedPath);
    expect(deferredStore.clearBySession).toHaveBeenCalledWith(livePath);
    expect(deferredStore.clearBySession).toHaveBeenCalledWith(hibernatedPath);
    expect(closeTerminalsForSession).toHaveBeenCalledWith(livePath);
    expect(closeTerminalsForSession).toHaveBeenCalledWith(hibernatedPath);
    expect(onSessionRuntimeDiscarded).toHaveBeenCalledTimes(2);
    expect(onSessionRuntimeDiscarded).toHaveBeenNthCalledWith(1, livePath, "archive");
    expect(onSessionRuntimeDiscarded).toHaveBeenNthCalledWith(2, hibernatedPath, "archive");
  });

  it("discardSessionRuntime can skip memory session-end notification for archived sessions", async () => {
    const notifySessionEnd = vi.fn(async () => {});
    const agent = {
      id: "hana",
      agentName: "小花",
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      _memoryTicker: { notifySessionEnd },
    };
    const livePath = path.join(agent.sessionDir, "skip-memory.jsonl");
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    const session = {
      isStreaming: false,
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => livePath },
    };
    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "BASE" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [{ id: "hana", name: "小花" }],
      getConfirmStore: () => ({ abortBySession: vi.fn() }),
      getDeferredResultStore: () => ({ clearBySession: vi.fn() }),
      closeTerminalsForSession: vi.fn(),
    });
    coordinator._sessions.set(livePath, { session, agentId: "hana", unsub: vi.fn() });

    await expect(coordinator.discardSessionRuntime(livePath, "parent session archived", { skipMemory: true })).resolves.toBe(true);

    expect(notifySessionEnd).not.toHaveBeenCalled();
  });

  it("discardSessionRuntime keeps a completed discard successful when the discard hook rejects", async () => {
    const agent = {
      id: "hana",
      agentName: "小花",
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
    };
    const hibernatedPath = path.join(agent.sessionDir, "hook-reject.jsonl");
    fs.mkdirSync(agent.sessionDir, { recursive: true });

    const confirmStore = { abortBySession: vi.fn() };
    const deferredStore = { clearBySession: vi.fn() };
    const closeTerminalsForSession = vi.fn();
    const onSessionRuntimeDiscarded = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "BASE" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [{ id: "hana", name: "小花" }],
      getConfirmStore: () => confirmStore,
      getDeferredResultStore: () => deferredStore,
      closeTerminalsForSession,
      onSessionRuntimeDiscarded,
    });

    coordinator._hibernatedSessionMeta.set(hibernatedPath, { agentId: "hana" });

    await expect(coordinator.discardSessionRuntime(hibernatedPath, "archive")).resolves.toBe(true);

    expect(coordinator._hibernatedSessionMeta.has(hibernatedPath)).toBe(false);
    expect(confirmStore.abortBySession).toHaveBeenCalledWith(hibernatedPath);
    expect(deferredStore.clearBySession).toHaveBeenCalledWith(hibernatedPath);
    expect(closeTerminalsForSession).toHaveBeenCalledWith(hibernatedPath);
    expect(onSessionRuntimeDiscarded).toHaveBeenCalledWith(hibernatedPath, "archive");
  });
});

describe("SessionCoordinator session reminders", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-reminders-"));
    sessionManagerListMock.mockResolvedValue([]);
    emitSessionShutdownMock.mockResolvedValue(false);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeAgent() {
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: vi.fn(() => "BASE"),
      config: { locale: "zh-CN" },
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    return agent;
  }

  function makeCoordinator(agent: any, envChangeLedger: EnvChangeLedger, activeAgentId = "hana") {
    return new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => activeAgentId,
      getModels: () => ({
        currentModel: { id: "m", provider: "test" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level: any) => level || "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({
        getThinkingLevel: () => "medium",
        getTimezone: () => "UTC",
      }),
      getAgents: () => new Map([["hana", agent]]),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [{ id: "hana", name: "Hana" }],
      envChangeLedger,
    });
  }

  function mockSessionAt(sessionPath: string, sessionManagerOverride: any = null) {
    const sessionManager = sessionManagerOverride || {
      getSessionFile: () => sessionPath,
      getCwd: () => "/tmp/workspace",
    };
    sessionManagerCreateMock.mockReturnValue(sessionManager);
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager,
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    });
    return sessionManager;
  }

  it("initializes fresh reminder state at the current ledger baseline and prompt-build time", async () => {
    const ledger = new EnvChangeLedger();
    ledger.append({
      type: "memory_facts",
      scope: { kind: "agent", agentId: "hana" },
      payload: { addedLines: ["before"] },
    });
    const agent = makeAgent();
    const sessionPath = path.join(agent.sessionDir, "fresh.jsonl");
    mockSessionAt(sessionPath);
    const coordinator = makeCoordinator(agent, ledger);

    await coordinator.createSession(null, "/tmp/workspace", false);

    const entry = coordinator._getSessionEntryByPath(sessionPath);
    expect(entry).toMatchObject({
      reminderEnvCursor: 1,
      reminderEnvStartSeq: 1,
      reminderCompactionRevision: 0,
      reminderConsumedCompactionRevision: 0,
      reminderAcceptedUnavailableToolNames: [],
      reminderUnavailableRevision: 0,
    });
    expect(coordinator.renderSessionReminderBlock(sessionPath)).toBeNull();
  });

  it("routes memory reminders by the session owner instead of the active agent", async () => {
    const ledger = new EnvChangeLedger();
    const agent = makeAgent();
    const sessionPath = path.join(agent.sessionDir, "owned-by-hana.jsonl");
    mockSessionAt(sessionPath);
    const coordinator = makeCoordinator(agent, ledger, "other-agent");
    await coordinator.createSession(null, "/tmp/workspace", false);
    ledger.append({
      type: "memory_facts",
      scope: { kind: "agent", agentId: "hana" },
      payload: { addedLines: ["hana-owned fact"] },
    });
    ledger.append({
      type: "memory_facts",
      scope: { kind: "agent", agentId: "other-agent" },
      payload: { addedLines: ["active-agent fact"] },
    });

    const rendered = coordinator.renderSessionReminderBlock(sessionPath);

    expect(coordinator._getSessionEntryByPath(sessionPath).agentId).toBe("hana");
    expect(rendered?.block).toContain("hana-owned fact");
    expect(rendered?.block).not.toContain("active-agent fact");
  });

  it("uses a receipt without advancing state until explicit consumption", async () => {
    const ledger = new EnvChangeLedger();
    const agent = makeAgent();
    const sessionPath = path.join(agent.sessionDir, "receipt.jsonl");
    mockSessionAt(sessionPath);
    const coordinator = makeCoordinator(agent, ledger);
    await coordinator.createSession(null, "/tmp/workspace", false);
    ledger.append({
      type: "memory_facts",
      scope: { kind: "agent", agentId: "hana" },
      payload: { addedLines: ["demo"] },
    });

    const rendered = coordinator.renderSessionReminderBlock(sessionPath);
    expect(rendered?.block).toContain("demo");
    expect(coordinator._getSessionEntryByPath(sessionPath).reminderEnvCursor).toBe(0);
    expect(coordinator.renderSessionReminderBlock(sessionPath)?.block).toContain("demo");

    expect(coordinator.consumeRenderedSessionReminderBlock(sessionPath, rendered!.receipt)).toBe(true);
    expect(coordinator.renderSessionReminderBlock(sessionPath)).toBeNull();
  });

  it("keeps a newer compaction revision when consuming an older receipt", async () => {
    const ledger = new EnvChangeLedger();
    const agent = makeAgent();
    const sessionPath = path.join(agent.sessionDir, "monotonic.jsonl");
    mockSessionAt(sessionPath);
    const coordinator = makeCoordinator(agent, ledger);
    await coordinator.createSession(null, "/tmp/workspace", false);
    const entry = coordinator._getSessionEntryByPath(sessionPath);
    coordinator._markSessionCompacted(sessionPath);
    const rendered = coordinator.renderSessionReminderBlock(sessionPath)!;

    coordinator._markSessionCompacted(sessionPath);
    coordinator.consumeRenderedSessionReminderBlock(sessionPath, rendered.receipt);

    expect(entry.reminderCompactionRevision).toBe(2);
    expect(entry.reminderConsumedCompactionRevision).toBe(1);
    expect(coordinator.renderSessionReminderBlock(sessionPath)?.block).toContain("上下文已压缩");
  });

  it("preserves same-process cursors and revisions for a frozen runtime", async () => {
    const ledger = new EnvChangeLedger();
    const agent = makeAgent();
    const sessionPath = path.join(agent.sessionDir, "hibernated.jsonl");
    const sessionManager = mockSessionAt(sessionPath);
    const coordinator = makeCoordinator(agent, ledger);
    vi.spyOn(coordinator as any, "_readSessionCapabilitySnapshot").mockReturnValue({
      toolNames: [],
      promptSnapshot: {
        version: 1,
        systemPrompt: "FROZEN",
        appendSystemPrompt: [],
        skillsResult: { skills: [], diagnostics: [] },
        agentsFilesResult: { agentsFiles: [] },
      },
    });
    const reminderState = {
      reminderEnvCursor: 4,
      reminderEnvStartSeq: 2,
      reminderCompactionRevision: 5,
      reminderConsumedCompactionRevision: 3,
      reminderAcceptedUnavailableToolNames: ["mcp_calendar"],
      reminderUnavailableRevision: 2,
    };

    await coordinator.createSession(sessionManager, "/tmp/workspace", false, null, {
      restore: true,
      reminderState,
    });

    expect(coordinator._getSessionEntryByPath(sessionPath)).toMatchObject(reminderState);
  });

  it("keeps a valid reminder ahead of provider-only beforeUser context", async () => {
    const ledger = new EnvChangeLedger();
    const agent = makeAgent();
    const sessionPath = path.join(agent.sessionDir, "context.jsonl");
    mockSessionAt(sessionPath);
    const coordinator = makeCoordinator(agent, ledger);
    await coordinator.createSession(null, "/tmp/workspace", false);
    coordinator._setRuntimeValueForPath(coordinator._turnContextBySession, sessionPath, {
      beforeUser: "world lore",
      metadata: { pluginId: "tavern" },
    });
    const extension = createAgentSessionMock.mock.calls[0][0]
      .resourceLoader.getExtensions().extensions[0];
    const handler = extension.handlers.get("context")[0];
    const reminder = "[hana_reminder]\n- Current time: 2026-07-05 14:05\n[/hana_reminder]";

    const result = await handler({
      messages: [{ role: "user", content: `${reminder}\n\nhello` }],
    });
    const content = result.messages[0].content;

    expect(content.startsWith(reminder)).toBe(true);
    expect(content.indexOf("[Hana turn context: before_user]")).toBeGreaterThan(reminder.length);
    expect(content.indexOf("world lore")).toBeLessThan(content.indexOf("hello"));
  });

  it("keeps a legacy timestamped reminder ahead of provider-only beforeUser context", async () => {
    const ledger = new EnvChangeLedger();
    const agent = makeAgent();
    const sessionPath = path.join(agent.sessionDir, "context.jsonl");
    mockSessionAt(sessionPath);
    const coordinator = makeCoordinator(agent, ledger);
    await coordinator.createSession(null, "/tmp/workspace", false);
    coordinator._setRuntimeValueForPath(coordinator._turnContextBySession, sessionPath, {
      beforeUser: "world lore",
      metadata: { pluginId: "tavern" },
    });
    const extension = createAgentSessionMock.mock.calls[0][0]
      .resourceLoader.getExtensions().extensions[0];
    const handler = extension.handlers.get("context")[0];
    const reminder = "[hana_reminder at 2026-07-05 14:05]\n- Current time: 2026-07-05 14:05\n[/hana_reminder]";

    const result = await handler({
      messages: [{ role: "user", content: `${reminder}\n\nhello` }],
    });
    const content = result.messages[0].content;

    expect(content.startsWith(reminder)).toBe(true);
    expect(content.indexOf("[Hana turn context: before_user]")).toBeGreaterThan(reminder.length);
    expect(content.indexOf("world lore")).toBeLessThan(content.indexOf("hello"));
  });

  it("returns false for reminder state operations on an unknown session path", () => {
    const coordinator = makeCoordinator(makeAgent(), new EnvChangeLedger());
    expect(coordinator.consumeRenderedSessionReminderBlock("/missing.jsonl", {
      throughSeq: 0,
      compactionRevision: 0,
    })).toBe(false);
  });
});
