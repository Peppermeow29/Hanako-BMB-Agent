/**
 * Integration test for createSession tool snapshot behavior (Task 5).
 *
 * Covers the three branches:
 *   A. restore=true + meta has toolNames  → replay snapshot
 *   B. restore=true + meta missing        → legacy, keep all tools
 *   C. restore=false                       → fresh compute from config
 * Plus tampering protection: core tools survive even if listed in disabled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";

const { createAgentSessionMock, sessionManagerCreateMock, sessionManagerOpenMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    open: sessionManagerOpenMock,
  },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
  estimateTokens: vi.fn(() => 0),
  findCutPoint: vi.fn(),
  generateSummary: vi.fn(),
  emitSessionShutdown: vi.fn(),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { SessionCoordinator } from "../core/session-coordinator.ts";
import { EnvChangeLedger } from "../core/env-change-ledger.ts";
import { SessionManifestStore } from "../core/session-manifest/store.ts";
import { repairRestoredToolSnapshot } from "../core/tool-snapshot-repair.ts";
import { filterToolObjectsByAvailability } from "../core/tool-availability.ts";
import { isBeautifyEnabledForAgentConfig } from "../plugins/beautify/lib/availability.ts";
import { CORE_TOOL_NAMES } from "../shared/tool-categories.ts";

// Fake tool objects — only needs `.name` to satisfy `.map(t => t.name)` paths
function makeTool(name) {
  return { name, execute: vi.fn() };
}

// Pi SDK built-in tools — in production these come from
// createSandboxedTools().tools, NOT from agent.tools. Mirror that structure so
// tests exercise the real code paths.
const SDK_BUILTIN_OBJS = [
  "read", "write", "edit", "exec_command", "write_stdin", "grep", "find", "ls",
].map(makeTool);

// HanaAgent custom tools — in production these come from agent.tools getter
// and flow through buildTools.customTools.
const HANAKO_CUSTOM_OBJS = [
  "search_memory", "pin_memory", "unpin_memory", "web_search",
  "web_fetch", "todo_write", "notify",
  "stage_files", "subagent", "channel", "record_experience",
  "recall_experience", "check_pending_tasks", "current_status", "stop_task",
  "session_folders", "browser", "automation", "install_skill", "update_settings",
].map(makeTool);

function allNames() {
  return [
    ...SDK_BUILTIN_OBJS.map((t) => t.name),
    ...HANAKO_CUSTOM_OBJS.map((t) => t.name),
  ];
}

function defaultBaselineNames() {
  return allNames();
}

function restoredSnapshot(names, availableNames = allNames()) {
  return repairRestoredToolSnapshot(names, availableNames, { coreToolNames: CORE_TOOL_NAMES });
}

describe("session-coordinator tool snapshot (createSession)", () => {
  let tmpDir, agentDir, sessionDir, coord, fakeSessionPath, activeToolsSpy, buildSystemPromptSpy, currentAgentConfig, channelsEnabled, defaultModeSaveSpy, storedDefaultMode, storedThinkingLevel, lastSessionOptions, fakeEngine, focusAgent, onBeforeSessionCreateSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-snapshot-"));
    agentDir = path.join(tmpDir, "agents", "test");
    sessionDir = path.join(agentDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fakeSessionPath = path.join(sessionDir, "test-session.jsonl");

    currentAgentConfig = {}; // tests mutate this before calling createSession
    channelsEnabled = true;

    activeToolsSpy = vi.fn();
    buildSystemPromptSpy = vi.fn(() => "mock-prompt");
    defaultModeSaveSpy = vi.fn((mode) => {
      storedDefaultMode = mode;
      return mode;
    });
    storedDefaultMode = "ask";
    storedThinkingLevel = "auto";
    lastSessionOptions = null;
    fakeEngine = {
      getUiContext: vi.fn(() => null),
      isVisionAuxiliaryEnabled: vi.fn(() => false),
      getVisionBridge: vi.fn(() => null),
    };

    sessionManagerCreateMock.mockReturnValue({ getCwd: () => tmpDir });
    sessionManagerOpenMock.mockReturnValue({ getCwd: () => tmpDir });
    createAgentSessionMock.mockImplementation(async (options) => {
      lastSessionOptions = options;
      return {
      session: {
        sessionManager: { getSessionFile: () => fakeSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
      };
    });

    focusAgent = {
      id: "test",
      agentDir,
      sessionDir,
      tools: HANAKO_CUSTOM_OBJS,
      get config() { return currentAgentConfig; },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: buildSystemPromptSpy,
      memoryEnabled: true,
    };
    onBeforeSessionCreateSpy = vi.fn().mockResolvedValue(undefined);

    coord = new SessionCoordinator({
      agentsDir: path.join(tmpDir, "agents"),
      getAgent: () => focusAgent,
      getActiveAgentId: () => "test",
      getModels: () => ({
        currentModel: { id: "test-model", name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: (level) => level === "auto" ? "medium" : level,
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "mock-prompt",
        getAppendSystemPrompt: () => [],
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: SDK_BUILTIN_OBJS, customTools: HANAKO_CUSTOM_OBJS }),
      emitEvent: vi.fn(),
      emitDevLog: vi.fn(),
      getHomeCwd: () => tmpDir,
      agentIdFromSessionPath: () => "test",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({
        getThinkingLevel: () => storedThinkingLevel,
        getChannelsEnabled: () => channelsEnabled,
        getSessionPermissionModeDefault: () => storedDefaultMode,
        setSessionPermissionModeDefault: defaultModeSaveSpy,
      }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
      getDeferredResultStore: () => null,
      getEngine: () => fakeEngine,
      onBeforeSessionCreate: onBeforeSessionCreateSpy,
      envChangeLedger: new EnvChangeLedger(),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Case C tests ─────────────────────────────────────────────

  it("waits for the active Agent runtime before creating a session or reading capability snapshots", async () => {
    const callOrder = [];
    const runtimeWebSearch = makeTool("web_search");
    const coldAgent = {
      ...focusAgent,
      runtimeInitialized: false,
      buildSystemPrompt: vi.fn(() => {
        callOrder.push("prompt");
        return "cold prompt must not be read";
      }),
      tools: [],
    };
    const readyAgent = {
      ...focusAgent,
      runtimeInitialized: true,
      buildSystemPrompt: vi.fn(() => {
        callOrder.push("prompt");
        return "ready prompt";
      }),
      getToolsSnapshot: vi.fn(() => {
        callOrder.push("tools");
        return [runtimeWebSearch];
      }),
    };
    let resolveRuntime;
    const runtimeReady = new Promise((resolve) => {
      resolveRuntime = resolve;
    });
    const ensureAgentRuntime = vi.fn(() => {
      callOrder.push("ensure");
      return runtimeReady;
    });
    sessionManagerCreateMock.mockImplementation(() => {
      callOrder.push("session-manager");
      return { getCwd: () => tmpDir };
    });
    const buildTools = vi.fn((_cwd, customTools) => {
      callOrder.push("build-tools");
      return { tools: SDK_BUILTIN_OBJS, customTools };
    });
    coord._d.getAgent = () => coldAgent;
    coord._d.getAgentById = (agentId) => agentId === "test" ? coldAgent : null;
    coord._d.ensureAgentRuntime = ensureAgentRuntime;
    coord._d.buildTools = buildTools;
    const createManifest = vi.fn();
    coord._sessionManifestStore = {
      resolveByLocatorPath: vi.fn(() => null),
      createForPath: createManifest,
    };

    const creation = coord.createSession(null, tmpDir, true);
    await Promise.resolve();

    expect(ensureAgentRuntime).toHaveBeenCalledWith("test", {
      priority: "foreground",
      reason: "createSession",
    });
    expect(onBeforeSessionCreateSpy).not.toHaveBeenCalled();
    expect(sessionManagerCreateMock).not.toHaveBeenCalled();
    expect(coldAgent.buildSystemPrompt).not.toHaveBeenCalled();
    expect(readyAgent.buildSystemPrompt).not.toHaveBeenCalled();
    expect(buildTools).not.toHaveBeenCalled();
    expect(createAgentSessionMock).not.toHaveBeenCalled();
    expect(createManifest).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(sessionDir, "session-meta.json"))).toBe(false);

    coord._sessionManifestStore = null;
    resolveRuntime(readyAgent);
    const { sessionPath } = await creation;

    expect(onBeforeSessionCreateSpy).toHaveBeenCalledWith(tmpDir, {
      agent: readyAgent,
      agentId: "test",
    });
    expect(coldAgent.buildSystemPrompt).not.toHaveBeenCalled();
    expect(readyAgent.buildSystemPrompt).toHaveBeenCalledOnce();
    expect(readyAgent.getToolsSnapshot).toHaveBeenCalledOnce();
    expect(buildTools.mock.calls[0][1]).toEqual([runtimeWebSearch]);
    expect(callOrder).toEqual([
      "ensure",
      "session-manager",
      "prompt",
      "tools",
      "build-tools",
    ]);
    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)].toolNames).toContain("web_search");
  });

  it("fails without creating session state when active Agent runtime initialization fails", async () => {
    const coldAgent = {
      ...focusAgent,
      runtimeInitialized: false,
      buildSystemPrompt: vi.fn(() => "must not be read"),
      getToolsSnapshot: vi.fn(() => []),
    };
    let rejectRuntime;
    const runtimeReady = new Promise((_resolve, reject) => {
      rejectRuntime = reject;
    });
    const ensureAgentRuntime = vi.fn(() => runtimeReady);
    const buildTools = vi.fn(() => ({ tools: SDK_BUILTIN_OBJS, customTools: [] }));
    coord._d.getAgent = () => coldAgent;
    coord._d.getAgentById = (agentId) => agentId === "test" ? coldAgent : null;
    coord._d.ensureAgentRuntime = ensureAgentRuntime;
    coord._d.buildTools = buildTools;
    const createManifest = vi.fn();
    coord._sessionManifestStore = {
      resolveByLocatorPath: vi.fn(() => null),
      createForPath: createManifest,
    };

    const creation = coord.createSession(null, tmpDir, true);
    const settled = creation.catch((error) => error);
    await Promise.resolve();

    expect(sessionManagerCreateMock).not.toHaveBeenCalled();
    expect(onBeforeSessionCreateSpy).not.toHaveBeenCalled();
    expect(coldAgent.buildSystemPrompt).not.toHaveBeenCalled();
    expect(coldAgent.getToolsSnapshot).not.toHaveBeenCalled();
    expect(buildTools).not.toHaveBeenCalled();
    expect(createAgentSessionMock).not.toHaveBeenCalled();
    expect(createManifest).not.toHaveBeenCalled();

    rejectRuntime(new Error("runtime init failed"));
    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("runtime init failed");

    expect(createManifest).not.toHaveBeenCalled();
    expect(fs.existsSync(fakeSessionPath)).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, "session-meta.json"))).toBe(false);
  });

  it("refuses to create from a known-cold Agent when runtime activation is unavailable", async () => {
    const coldAgent = {
      ...focusAgent,
      runtimeInitialized: false,
      buildSystemPrompt: vi.fn(() => "must not be read"),
      getToolsSnapshot: vi.fn(() => []),
    };
    coord._d.getAgent = () => coldAgent;
    coord._d.getAgentById = (agentId) => agentId === "test" ? coldAgent : null;

    await expect(coord.createSession(null, tmpDir, true)).rejects.toThrow(/test/);

    expect(sessionManagerCreateMock).not.toHaveBeenCalled();
    expect(onBeforeSessionCreateSpy).not.toHaveBeenCalled();
    expect(coldAgent.buildSystemPrompt).not.toHaveBeenCalled();
    expect(coldAgent.getToolsSnapshot).not.toHaveBeenCalled();
    expect(createAgentSessionMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(sessionDir, "session-meta.json"))).toBe(false);
  });

  it("rejects a runtime instance that belongs to a different Agent", async () => {
    const coldAgent = {
      ...focusAgent,
      runtimeInitialized: false,
      buildSystemPrompt: vi.fn(() => "must not be read"),
    };
    const wrongAgent = {
      ...focusAgent,
      id: "other-agent",
      runtimeInitialized: true,
      buildSystemPrompt: vi.fn(() => "wrong owner prompt"),
    };
    coord._d.getAgent = () => coldAgent;
    coord._d.getAgentById = (agentId) => agentId === "test" ? coldAgent : null;
    coord._d.ensureAgentRuntime = vi.fn(async () => wrongAgent);

    await expect(coord.createSession(null, tmpDir, true)).rejects.toThrow(/identity mismatch/);

    expect(sessionManagerCreateMock).not.toHaveBeenCalled();
    expect(coldAgent.buildSystemPrompt).not.toHaveBeenCalled();
    expect(wrongAgent.buildSystemPrompt).not.toHaveBeenCalled();
    expect(createAgentSessionMock).not.toHaveBeenCalled();
  });

  it("rejects a mismatched supplied Agent before requesting runtime activation", async () => {
    const wrongAgent = {
      ...focusAgent,
      id: "other-agent",
      runtimeInitialized: false,
      buildSystemPrompt: vi.fn(() => "wrong owner prompt"),
    };
    const ensureAgentRuntime = vi.fn(async () => focusAgent);
    coord._d.ensureAgentRuntime = ensureAgentRuntime;

    await expect(coord.createSession(null, tmpDir, true, null, {
      agent: wrongAgent,
      agentId: "test",
    })).rejects.toThrow(/identity mismatch/);

    expect(ensureAgentRuntime).not.toHaveBeenCalled();
    expect(sessionManagerCreateMock).not.toHaveBeenCalled();
    expect(wrongAgent.buildSystemPrompt).not.toHaveBeenCalled();
    expect(createAgentSessionMock).not.toHaveBeenCalled();
  });

  it("keeps cached session switches as pure pointer changes without runtime activation", async () => {
    const cachedSession = {
      sessionManager: { getSessionFile: () => fakeSessionPath },
    };
    const cachedEntry = {
      session: cachedSession,
      sessionPath: fakeSessionPath,
      agentId: "test",
      memoryEnabled: true,
      lastTouchedAt: 0,
    };
    coord._sessions.set(fakeSessionPath, cachedEntry);
    focusAgent.runtimeInitialized = false;
    coord._d.getAgentById = (agentId) => agentId === "test" ? focusAgent : null;
    const ensureAgentRuntime = vi.fn(async () => {
      throw new Error("cached switch must not initialize runtime");
    });
    coord._d.ensureAgentRuntime = ensureAgentRuntime;

    const result = await coord.switchSession(fakeSessionPath);

    expect(result).toBe(cachedSession);
    expect(coord._session).toBe(cachedSession);
    expect(coord._currentSessionPath).toBe(fakeSessionPath);
    expect(ensureAgentRuntime).not.toHaveBeenCalled();
    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
  });

  it("preflights runtime readiness before reload tears down the existing runtime", async () => {
    const originalJsonl = `${JSON.stringify({ type: "session", id: "reload-original", cwd: tmpDir })}\n`;
    fs.writeFileSync(fakeSessionPath, originalJsonl, "utf-8");
    const originalSession = {
      sessionManager: { getSessionFile: () => fakeSessionPath },
      isStreaming: false,
      isCompacting: false,
    };
    const originalEntry = {
      session: originalSession,
      sessionPath: fakeSessionPath,
      agentId: "test",
      memoryEnabled: true,
      unsub: vi.fn(),
    };
    coord._sessions.set(fakeSessionPath, originalEntry);
    coord._session = originalSession;
    coord._currentSessionPath = fakeSessionPath;
    focusAgent.runtimeInitialized = false;
    coord._d.getAgentById = (agentId) => agentId === "test" ? focusAgent : null;
    let rejectRuntime;
    const runtimeReady = new Promise((_resolve, reject) => {
      rejectRuntime = reject;
    });
    const ensureAgentRuntime = vi.fn(() => runtimeReady);
    coord._d.ensureAgentRuntime = ensureAgentRuntime;
    const teardown = vi.spyOn(coord as any, "_teardownSessionEntry").mockResolvedValue(undefined);
    const health = vi.spyOn(coord as any, "_emitSessionHealthWarning").mockImplementation(() => {});
    const repairOrphans = vi.spyOn(coord as any, "_repairOrphanToolHistory").mockImplementation(() => {});
    const repairMedia = vi.spyOn(coord as any, "_repairInlineMediaHistory").mockImplementation(() => {});

    const reload = coord.reloadSessionRuntime(fakeSessionPath);
    const settled = reload.catch((error) => error);
    await vi.waitFor(() => expect(ensureAgentRuntime).toHaveBeenCalled());

    expect(teardown).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
    expect(repairOrphans).not.toHaveBeenCalled();
    expect(repairMedia).not.toHaveBeenCalled();
    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
    expect(coord._sessions.get(fakeSessionPath)).toBe(originalEntry);
    expect(coord._session).toBe(originalSession);
    expect(fs.readFileSync(fakeSessionPath, "utf-8")).toBe(originalJsonl);

    rejectRuntime(new Error("reload runtime failed"));
    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("reload runtime failed");
    expect(teardown).not.toHaveBeenCalled();
    expect(coord._sessions.get(fakeSessionPath)).toBe(originalEntry);
    expect(coord._session).toBe(originalSession);
    expect(fs.readFileSync(fakeSessionPath, "utf-8")).toBe(originalJsonl);
  });

  it.each([
    ["switch restore", (coordinator, sessionPath) => coordinator.switchSession(sessionPath)],
    ["background attach", (coordinator, sessionPath) => coordinator.ensureSessionLoaded(sessionPath)],
  ])("preflights runtime readiness before %s repairs or opens JSONL", async (_label, restoreSession) => {
    const originalJsonl = `${JSON.stringify({ type: "session", id: "restore-original", cwd: tmpDir })}\n`;
    fs.writeFileSync(fakeSessionPath, originalJsonl, "utf-8");
    focusAgent.runtimeInitialized = false;
    coord._d.getAgentById = (agentId) => agentId === "test" ? focusAgent : null;
    let rejectRuntime;
    const runtimeReady = new Promise((_resolve, reject) => {
      rejectRuntime = reject;
    });
    const ensureAgentRuntime = vi.fn(() => runtimeReady);
    coord._d.ensureAgentRuntime = ensureAgentRuntime;
    const health = vi.spyOn(coord as any, "_emitSessionHealthWarning").mockImplementation(() => {});
    const repairOversized = vi.spyOn(coord as any, "_repairOversizedSessionHistory").mockImplementation(() => {});
    const repairOrphans = vi.spyOn(coord as any, "_repairOrphanToolHistory").mockImplementation(() => {});
    const repairMedia = vi.spyOn(coord as any, "_repairInlineMediaHistory").mockImplementation(() => {});

    const restoring = restoreSession(coord, fakeSessionPath);
    const settled = restoring.catch((error) => error);
    await vi.waitFor(() => expect(ensureAgentRuntime).toHaveBeenCalled());

    expect(health).not.toHaveBeenCalled();
    expect(repairOversized).not.toHaveBeenCalled();
    expect(repairOrphans).not.toHaveBeenCalled();
    expect(repairMedia).not.toHaveBeenCalled();
    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(fakeSessionPath, "utf-8")).toBe(originalJsonl);

    rejectRuntime(new Error("restore runtime failed"));
    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("restore runtime failed");
    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
    expect(coord._sessions.size).toBe(0);
    expect(fs.readFileSync(fakeSessionPath, "utf-8")).toBe(originalJsonl);
  });

  it("selects workspace skills with the explicit non-focus Agent identity", async () => {
    const targetAgent = {
      ...focusAgent,
      id: "target",
      config: {
        workspace_context: {
          discover_project_skills: false,
          discover_compatible_project_skills: true,
        },
      },
    };
    const workspacePaths = [{
      dirPath: path.join(tmpDir, ".codex", "skills"),
      label: "Codex",
      scope: "workspace",
      category: "compatible",
    }];
    const getSkillsForAgent = vi.fn(() => ({ skills: [], diagnostics: [] }));
    coord._d.getSkills = () => ({ getSkillsForAgent });
    onBeforeSessionCreateSpy.mockResolvedValueOnce({ workspacePaths });

    await coord.createSession(null, tmpDir, true, null, {
      agent: targetAgent,
      agentId: "target",
    });

    expect(onBeforeSessionCreateSpy).toHaveBeenCalledWith(tmpDir, {
      agent: targetAgent,
      agentId: "target",
    });
    expect(getSkillsForAgent).toHaveBeenCalledWith(targetAgent, { workspacePaths });
  });

  it("Case C: new session with NO tools config does not expose retired dm and keeps update_settings on", async () => {
    currentAgentConfig = {}; // fresh agent or upgrade, tools field absent
    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toContain("update_settings");
    expect(appliedList).not.toContain("dm");
    // everything else still on
    expect(appliedList).toContain("browser");
    expect(appliedList).toContain("automation");
    expect(appliedList).toContain("install_skill");
    expect(appliedList).toContain("read"); // SDK built-in preserved
    expect(coord.getAccessMode()).toBe("operate");

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)].accessMode).toBe("operate");
  });

  it("includes enabled MCP tools in fresh session runtime options and snapshots", async () => {
    const mcpTool = { ...makeTool("mcp_github_search"), _pluginId: "mcp" };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, mcpTool],
    });
    currentAgentConfig = { tools: { disabled: [] } };

    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    expect(lastSessionOptions.customTools.map((tool) => tool.name)).toContain("mcp_github_search");
    expect(activeToolsSpy.mock.calls[0][0]).toContain("mcp_github_search");
    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)].toolNames).toContain("mcp_github_search");
  });

  it("starts fresh sessions from the persisted global permission default", async () => {
    storedDefaultMode = "operate";
    currentAgentConfig = { tools: { disabled: [] } };

    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    expect(coord.getPermissionModeDefault()).toBe("operate");
    expect(coord.getPermissionMode(sessionPath)).toBe("operate");
    expect(coord.getAccessMode(sessionPath)).toBe("operate");
    expect(defaultModeSaveSpy).not.toHaveBeenCalled();

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)]).toMatchObject({
      permissionMode: "operate",
      accessMode: "operate",
      planMode: false,
    });
  });

  it("projects persisted permission mode for cold sessions in the session list", async () => {
    fs.writeFileSync(fakeSessionPath, [
      JSON.stringify({
        type: "session",
        id: "cold-auto",
        cwd: tmpDir,
        timestamp: "2026-06-08T08:00:00.000Z",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "hello",
          timestamp: "2026-06-08T08:01:00.000Z",
        },
      }),
    ].join("\n") + "\n");
    fs.writeFileSync(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(fakeSessionPath)]: {
          permissionMode: "auto",
          accessMode: "operate",
          planMode: false,
        },
      }, null, 2),
    );
    coord._d.listAgents = () => [{ id: "test", name: "Test" }];

    const sessions = await coord.listSessions();

    expect(coord._sessions.has(fakeSessionPath)).toBe(false);
    expect(sessions).toEqual([
      expect.objectContaining({
        path: fakeSessionPath,
        permissionMode: "auto",
      }),
    ]);
  });

  it("keeps active-session permission changes out of the global new-session default", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath: firstPath } = await coord.createSession(null, tmpDir, true);

    coord.setPermissionMode("operate");

    const secondSessionPath = path.join(sessionDir, "second-session.jsonl");
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => secondSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
    });
    const { sessionPath: secondPath } = await coord.createSession(null, tmpDir, true);

    expect(coord.getPermissionMode(firstPath)).toBe("operate");
    expect(coord.getPermissionMode(secondPath)).toBe("ask");
    expect(coord.getPermissionModeDefault()).toBe("ask");
    expect(defaultModeSaveSpy).not.toHaveBeenCalled();
  });

  it("can stage a pending new-session permission mode without mutating the active session", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath: activePath } = await coord.createSession(null, tmpDir, true);

    const result = coord.setPendingPermissionMode("read_only");

    expect(result).toMatchObject({ ok: true, mode: "read_only", enabled: true });
    expect(coord.getPermissionMode(activePath)).toBe("ask");
    expect(coord.getPermissionModeDefault()).toBe("read_only");
    expect(defaultModeSaveSpy).toHaveBeenCalledWith("read_only");

    const secondSessionPath = path.join(sessionDir, "pending-read-only.jsonl");
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => secondSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
    });
    const { sessionPath: nextPath } = await coord.createSession(null, tmpDir, true);

    expect(coord.getPermissionMode(nextPath)).toBe("read_only");
  });

  it("creates detached sessions without changing the focused session", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath: focusedPath } = await coord.createSession(null, tmpDir, true);

    const detachedSessionPath = path.join(sessionDir, "quick-chat-detached.jsonl");
    createAgentSessionMock.mockImplementationOnce(async (options) => {
      lastSessionOptions = options;
      return {
      session: {
        sessionManager: { getSessionFile: () => detachedSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
      };
    });

    const { sessionPath: detachedPath } = await coord.createDetachedSession({
      cwd: tmpDir,
      memoryEnabled: true,
      visibleInSessionList: true,
    });

    expect(detachedPath).toBe(detachedSessionPath);
    expect(coord.currentSessionPath).toBe(focusedPath);
    expect(coord.session.sessionManager.getSessionFile()).toBe(focusedPath);
    expect(coord._sessions.get(detachedPath)?.visibleInSessionList).toBe(true);
    expect(coord.getPermissionMode(detachedPath)).toBe("ask");
  });

  it("persists the resolved thinking level as session-owned state when creating a session", async () => {
    storedThinkingLevel = "high";
    currentAgentConfig = { tools: { disabled: [] } };

    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    expect(lastSessionOptions.thinkingLevel).toBe("high");
    expect(coord.getSessionThinkingLevel(sessionPath)).toBe("high");

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)]).toMatchObject({
      thinkingLevel: "high",
    });
  });

  it("can switch only the current session permission mode without mutating the runtime default", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath: firstPath } = await coord.createSession(null, tmpDir, true);

    const result = coord.setCurrentSessionPermissionMode("operate");

    expect(result).toMatchObject({ ok: true, mode: "operate", enabled: false });
    expect(coord.getPermissionMode(firstPath)).toBe("operate");
    expect(coord.getPermissionModeDefault()).toBe("ask");

    const secondSessionPath = path.join(sessionDir, "second-ask-session.jsonl");
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => secondSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
    });
    const { sessionPath: secondPath } = await coord.createSession(null, tmpDir, true);

    expect(coord.getPermissionMode(secondPath)).toBe("ask");
    expect(defaultModeSaveSpy).not.toHaveBeenCalled();

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(firstPath)]).toMatchObject({
      permissionMode: "operate",
      accessMode: "operate",
      planMode: false,
    });
    expect(meta[path.basename(secondPath)]).toMatchObject({
      permissionMode: "ask",
      accessMode: "operate",
      planMode: false,
    });
  });

  it("does not let explicit loaded-session permission changes rewrite the global default", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    const result = coord.setSessionPermissionMode(sessionPath, "auto", { persistDefault: true });

    expect(result).toMatchObject({ ok: true, mode: "auto", enabled: false });
    expect(coord.getPermissionMode(sessionPath)).toBe("auto");
    expect(coord.getPermissionModeDefault()).toBe("ask");
    expect(defaultModeSaveSpy).not.toHaveBeenCalled();
  });

  it("can switch an explicit loaded session permission mode without relying on focus", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath: firstPath } = await coord.createSession(null, tmpDir, true);
    coord.setPermissionMode("read_only");

    const secondSessionPath = path.join(sessionDir, "focused-session.jsonl");
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => secondSessionPath },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
        setActiveToolsByName: activeToolsSpy,
      },
    });
    const { sessionPath: secondPath } = await coord.createSession(null, tmpDir, true);
    expect(coord.currentSessionPath).toBe(secondPath);

    const result = coord.setSessionPermissionMode(firstPath, "operate");

    expect(result).toMatchObject({ ok: true, mode: "operate", enabled: false });
    expect(coord.getPermissionMode(firstPath)).toBe("operate");
    expect(coord.getPermissionMode(secondPath)).toBe("ask");
    expect(coord.getPermissionModeDefault()).toBe("ask");
  });

  it("new session with pending read-only access mode keeps tool schema stable", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    coord.setPendingAccessMode("read_only");

    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toEqual(allNames());

    const entry = coord._sessions.get(sessionPath);
    expect(entry.accessMode).toBe("read_only");
    expect(entry.permissionMode).toBe("read_only");
    expect(entry.planMode).toBe(true);

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionPath)].permissionMode).toBe("read_only");
    expect(meta[path.basename(sessionPath)].accessMode).toBe("read_only");
  });

  it("Case C: new session with EXPLICIT empty disabled includes all tools in snapshot", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    // setActiveToolsByName should have been called with the full list
    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toEqual(allNames());

    // sessionEntry.toolNames should match
    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).toEqual(allNames());

    // Persisted to meta
    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].toolNames).toEqual(allNames());
  });

  it("Case C: fresh session hides channel when the global phone feature is disabled", async () => {
    channelsEnabled = false;
    currentAgentConfig = { tools: { disabled: [] } };

    const { sessionPath } = await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("channel");
    expect(appliedList).not.toContain("dm");
    expect(appliedList).toContain("browser");

    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).not.toContain("channel");
    expect(entry.toolNames).not.toContain("dm");
  });

  it("Case A: restore applies the global phone gate without rewriting frozen toolNames", async () => {
    channelsEnabled = false;
    currentAgentConfig = { tools: { disabled: [] } };
    const replayList = ["read", "channel", "dm", "browser"];
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toEqual(restoredSnapshot(["read", "browser"]));
    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).toEqual(restoredSnapshot(replayList, [...allNames(), "dm"]));
    expect(entry.unavailableToolNames).toEqual(["channel", "dm"]);
  });

  it("Case C: snapshot includes sandbox built-ins (regression for P1 — bundle must carry command/file tools)", async () => {
    currentAgentConfig = { tools: { disabled: ["browser"] } };
    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    // Sandbox-provided built-ins must be in the active set even though agent.tools
    // doesn't contain them — they come from sessionTools. Without the P1 fix,
    // setActiveToolsByName would receive only custom tool names and silently
    // disable read/edit/write/grep/find/ls/exec_command/write_stdin for every fresh session.
    for (const name of ["read", "write", "edit", "exec_command", "write_stdin", "grep", "find", "ls"]) {
      expect(appliedList).toContain(name);
    }
    expect(appliedList).not.toContain("bash");
  });

  it("Case C: browser disabled is excluded from snapshot", async () => {
    currentAgentConfig = { tools: { disabled: ["browser"] } };
    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("browser");
    expect(appliedList).toContain("automation");
    expect(appliedList).toContain("read");
  });

  it("Case C: fresh sessions exclude plugin tools disabled by runtime agent config", async () => {
    const mcpTool = {
      ...makeTool("mcp_github_search"),
      isEnabledForAgentConfig: (config) => config?.mcp?.servers?.github?.enabled === true,
    };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, mcpTool],
    });
    currentAgentConfig = { tools: { disabled: [] }, mcp: { servers: { github: { enabled: false } } } };

    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("mcp_github_search");
    expect(appliedList).toContain("read");
    expect(appliedList).toContain("browser");
  });

  it("Case C: computes fresh tools from Agent settings and the explicit session kind", async () => {
    const availability = vi.fn((_config, context) => (
      context?.ownerPluginId === "tavern" && context?.sessionKind === "tavern"
    ));
    const tavernTool = {
      ...makeTool("tavern_scene"),
      _pluginId: "tavern",
      isEnabledForAgentConfig: availability,
    };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, tavernTool],
    });
    currentAgentConfig = { tools: { disabled: [] } };

    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, {
      ownerPluginId: "tavern",
      sessionKind: "tavern",
      sessionVisibility: "plugin_private",
    });

    expect(availability).toHaveBeenCalledWith(
      currentAgentConfig,
      expect.objectContaining({
        agentId: "test",
        restore: false,
        ownerPluginId: "tavern",
        sessionKind: "tavern",
        sessionVisibility: "plugin_private",
      }),
    );
    expect(activeToolsSpy.mock.calls[0][0]).toContain("tavern_scene");
    expect(coord._sessions.get(sessionPath)).toMatchObject({
      ownerPluginId: "tavern",
      sessionKind: "tavern",
      sessionVisibility: "plugin_private",
    });
  });

  it("Case C: fresh sessions exclude computer when its global experiment gate is closed", async () => {
    const computerTool = {
      ...makeTool("computer"),
      isEnabledForAgentConfig: () => false,
    };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, computerTool],
    });
    currentAgentConfig = { tools: { disabled: [] } };

    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("computer");
    expect(appliedList).toContain("read");
    expect(appliedList).toContain("browser");
  });

  it("Case C: beautify plugin tools are default-on for fresh configs (0.375.x 毕业)", async () => {
    const beautifyTool = {
      ...makeTool("beautify_create-cover"),
      _pluginId: "beautify",
      isEnabledForAgentConfig: isBeautifyEnabledForAgentConfig,
    };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, beautifyTool],
    });
    currentAgentConfig = {};

    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toContain("beautify_create-cover");
    expect(appliedList).toContain("read");
  });

  it("Case C: beautify plugin tools stay off after explicit opt-out", async () => {
    const beautifyTool = {
      ...makeTool("beautify_create-cover"),
      _pluginId: "beautify",
      isEnabledForAgentConfig: isBeautifyEnabledForAgentConfig,
    };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, beautifyTool],
    });
    currentAgentConfig = { tools: { disabled: ["dm", "beautify"] } };

    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("beautify_create-cover");
    expect(appliedList).not.toContain("dm");
  });

  it("Case C: tampering with core tool name still keeps it (subset tamper protection)", async () => {
    currentAgentConfig = { tools: { disabled: ["browser", "read"] } };
    await coord.createSession(null, tmpDir, true);

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toContain("read");  // core tool preserved
    expect(appliedList).not.toContain("browser");  // optional tool excluded
  });

  it("Case C: persists toolNames to session-meta.json", async () => {
    currentAgentConfig = { tools: { disabled: ["browser", "automation"] } };
    await coord.createSession(null, tmpDir, true);

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    const persisted = meta[path.basename(fakeSessionPath)].toolNames;
    expect(persisted).not.toContain("browser");
    expect(persisted).not.toContain("automation");
    expect(persisted).not.toContain("dm");
    expect(persisted).toContain("install_skill");
  });

  // ── Case A tests ─────────────────────────────────────────────

  it("Case A: restore with legacy bash in toolNames maps it to exec_command", async () => {
    const replayList = ["read", "bash", "edit", "todo_write"];
    const metaPath = path.join(sessionDir, "session-meta.json");
    await fsp.writeFile(
      metaPath,
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).toEqual(restoredSnapshot(replayList));
    expect(activeToolsSpy.mock.calls[0][0]).toContain("exec_command");
    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("bash");
  });

  it("Case A: restore deduplicates frozen toolNames before applying them", async () => {
    const replayList = ["read", "bash", "read", "todo_write", "bash"];
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).toEqual(restoredSnapshot(["read", "bash", "todo_write"]));
    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("bash");

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].toolNames).toEqual(restoredSnapshot(["read", "bash", "todo_write"]));
  });

  it("Case A: restore maps legacy terminal to exec_command and write_stdin", async () => {
    const replayList = ["read", "terminal", "todo_write"];
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).toEqual(restoredSnapshot(replayList));
    expect(activeToolsSpy.mock.calls[0][0]).toContain("exec_command");
    expect(activeToolsSpy.mock.calls[0][0]).toContain("write_stdin");
    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("terminal");
  });

  it("Case A: restore repairs missing core tools without deleting unavailable frozen names", async () => {
    currentAgentConfig = { tools: { disabled: ["browser", "dm"] } };
    const replayList = ["todo_write", "retired_tool", "todo_write"];
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    const expected = restoredSnapshot(["todo_write"]);
    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).toEqual(expected);
    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("retired_tool");
    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("browser");
    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("dm");

    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).toEqual(restoredSnapshot(replayList, [...allNames(), "retired_tool"]));
    expect(entry.unavailableToolNames).toEqual(["retired_tool"]);

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].toolNames).toEqual(entry.toolNames);
  });

  it("Case A: restore keeps newly registered tools inactive when they are absent from the frozen snapshot", async () => {
    const dynamicTool = { ...makeTool("mcp_new_dynamic_tool"), _pluginId: "mcp" };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, dynamicTool],
    });
    const replayList = ["read", "bash", "todo_write"];
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).toEqual(
      restoredSnapshot(replayList, [...allNames(), "mcp_new_dynamic_tool"]),
    );
    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("mcp_new_dynamic_tool");
  });

  it("Case A: restore preserves a disabled MCP tool in the contract but not the active runtime", async () => {
    const mcpTool = {
      ...makeTool("mcp_github_search"),
      isEnabledForAgentConfig: () => false,
    };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, mcpTool],
    });
    const replayList = ["read", "mcp_github_search"];
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("mcp_github_search");
    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).toContain("mcp_github_search");
    expect(entry.unavailableToolNames).toEqual(["mcp_github_search"]);
  });

  it("reminds from the owning session frozen-minus-live inventory without activating new live tools", async () => {
    let oldToolAvailable = false;
    const oldMcpTool = {
      ...makeTool("mcp_old_search"),
      _pluginId: "mcp",
      metadata: {
        reminderLiveAvailabilityProbe: () => ({
          available: oldToolAvailable,
          reason: oldToolAvailable ? undefined : "runtime_stopped",
        }),
      },
    };
    const newlyAddedTool = { ...makeTool("mcp_new_search"), _pluginId: "mcp" };
    focusAgent.getToolsSnapshot = () => [...HANAKO_CUSTOM_OBJS, oldMcpTool, newlyAddedTool];
    coord._d.buildTools = (_cwd, customTools) => ({
      tools: SDK_BUILTIN_OBJS,
      customTools,
    });
    currentAgentConfig = { tools: { disabled: [] } };
    const replayList = ["read", "mcp_old_search"];
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });
    const ownerAgent = focusAgent;
    const focusedOtherAgent = {
      id: "focused-other",
      config: { tools: { disabled: [] } },
      tools: [{ ...oldMcpTool, metadata: { reminderLiveAvailabilityProbe: () => true } }],
      getToolsSnapshot() { return this.tools; },
    };
    coord._d.getAgent = () => focusedOtherAgent;
    coord._d.getAgentById = (id) => (id === "test" ? ownerAgent : focusedOtherAgent);
    const entry = coord._sessions.get(sessionPath);
    const frozenBefore = [...entry.toolNames];
    const activeCallCount = activeToolsSpy.mock.calls.length;
    const renewSpy = vi.spyOn(coord as any, "_renewCachePrefixContract");

    const rendered = coord.renderSessionReminderBlock(sessionPath)!;

    expect(rendered.block).toContain("mcp_old_search");
    expect(rendered.block).not.toContain("mcp_new_search");
    expect(rendered.receipt.unavailableToolNames).toEqual(["mcp_old_search"]);
    expect(entry.toolNames).toEqual(frozenBefore);
    expect(activeToolsSpy).toHaveBeenCalledTimes(activeCallCount);
    expect(renewSpy).not.toHaveBeenCalled();

    coord.consumeRenderedSessionReminderBlock(sessionPath, rendered.receipt);
    expect(coord.renderSessionReminderBlock(sessionPath)).toBeNull();
    oldToolAvailable = true;
    const recovered = coord.renderSessionReminderBlock(sessionPath)!;
    expect(recovered.block).toBe("");
    coord.consumeRenderedSessionReminderBlock(sessionPath, recovered.receipt);
    oldToolAvailable = false;
    expect(coord.renderSessionReminderBlock(sessionPath)?.block).toContain("mcp_old_search");
  });

  it("carries accepted unavailable-tool state through real hibernate and restore", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    coord._d.getAgentById = (id) => (id === "test" ? focusAgent : null);
    const { sessionPath } = await coord.createSession(null, tmpDir, true);
    const entry = coord._sessions.get(sessionPath);
    entry.reminderAcceptedUnavailableToolNames = ["mcp_calendar"];
    entry.reminderUnavailableRevision = 3;

    await expect(coord.hibernateSessionRuntime(sessionPath, "test")).resolves.toBe(true);
    expect(coord._hibernatedSessionMeta.get(sessionPath)).toMatchObject({
      reminderAcceptedUnavailableToolNames: ["mcp_calendar"],
      reminderUnavailableRevision: 3,
    });

    await coord.reloadSessionRuntime(sessionPath);
    expect(coord._sessions.get(sessionPath)).toMatchObject({
      reminderAcceptedUnavailableToolNames: ["mcp_calendar"],
      reminderUnavailableRevision: 3,
    });
  });

  it("Case A: a production-filtered temporary plugin outage does not rewrite the frozen contract", async () => {
    let pluginAvailable = false;
    const mcpTool = {
      ...makeTool("mcp_github_search"),
      _pluginId: "mcp",
      isEnabledForAgentConfig: () => pluginAvailable,
    };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: filterToolObjectsByAvailability(
        [...HANAKO_CUSTOM_OBJS, mcpTool],
        currentAgentConfig,
        { agentId: "test", channelsEnabled },
      ),
    });
    coord._d.getAgentById = (id) => (id === "test" ? focusAgent : null);
    currentAgentConfig = { tools: { disabled: [] } };
    const replayList = ["read", "mcp_github_search"];
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("mcp_github_search");
    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).toContain("mcp_github_search");
    expect(entry.unavailableToolNames).toEqual(["mcp_github_search"]);
    expect(coord.renderSessionReminderBlock(sessionPath)?.block).toContain("mcp_github_search");
    let meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].toolNames).toContain("mcp_github_search");

    pluginAvailable = true;
    await coord.reloadSessionRuntime(sessionPath);

    const restoredTools = activeToolsSpy.mock.calls.at(-1)[0];
    expect(restoredTools).toContain("mcp_github_search");
    meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].toolNames).toContain("mcp_github_search");
  });

  it("Case A: restore preserves a gated computer tool in the contract but not the active runtime", async () => {
    const computerTool = {
      ...makeTool("computer"),
      isEnabledForAgentConfig: () => false,
    };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, computerTool],
    });
    const replayList = ["read", "computer"];
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(fakeSessionPath)]: { toolNames: replayList } }, null, 2),
    );

    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("computer");
    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).toContain("computer");
    expect(entry.unavailableToolNames).toEqual(["computer"]);
  });

  // ── Case B tests ─────────────────────────────────────────────

  it("Case B: restore with meta missing toolNames creates a stable non-plugin baseline snapshot", async () => {
    // Pre-write meta WITHOUT toolNames
    const metaPath = path.join(sessionDir, "session-meta.json");
    await fsp.writeFile(
      metaPath,
      JSON.stringify({ [path.basename(fakeSessionPath)]: { memoryEnabled: true } }, null, 2),
    );
    const dynamicTool = { ...makeTool("mcp_new_dynamic_tool"), _pluginId: "mcp" };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, dynamicTool],
    });

    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(activeToolsSpy.mock.calls[0][0]).not.toContain("mcp_new_dynamic_tool");
    expect(activeToolsSpy.mock.calls[0][0]).toEqual(defaultBaselineNames());

    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).not.toContain("mcp_new_dynamic_tool");
    expect(entry.toolNames).toEqual(defaultBaselineNames());

    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].toolNames).toEqual(entry.toolNames);
  });

  it("Case B: restore when session-meta.json doesn't exist also creates a baseline snapshot", async () => {
    // No meta file on disk
    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).toEqual(defaultBaselineNames());

    const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].toolNames).toEqual(defaultBaselineNames());
  });

  // ── Meta read-failure fallback (P2) ──────────────────────────

  it("restore with unreadable session-meta.json recomputes from current config (fallback) instead of enabling all tools", async () => {
    // Write malformed JSON to trigger a parse error (non-ENOENT)
    await fsp.writeFile(path.join(sessionDir, "session-meta.json"), "{ not valid json ]", "utf-8");
    currentAgentConfig = { tools: { disabled: ["browser"] } };

    const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

    // Snapshot must have been applied (not silent Case B fallback)
    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).not.toContain("browser"); // current disabled list honored
    expect(appliedList).toContain("automation");
    expect(appliedList).toContain("read");

    const entry = coord._sessions.get(sessionPath);
    expect(entry.toolNames).not.toContain("browser");
  });

  // ── Runtime permission mode after session creation ─────────────────────

  it("updates setPlanMode after session creation without changing the default or active tools", async () => {
    currentAgentConfig = { tools: { disabled: ["browser"] } };
    const { sessionPath } = await coord.createSession(null, tmpDir, true);
    expect(activeToolsSpy).toHaveBeenCalledTimes(1); // initial snapshot apply

    const result = coord.setPlanMode(true, SDK_BUILTIN_OBJS.map((t) => t.name));

    expect(result).toMatchObject({ ok: true, mode: "read_only", enabled: true });
    expect(activeToolsSpy).toHaveBeenCalledTimes(1);
    expect(defaultModeSaveSpy).not.toHaveBeenCalled();
    expect(coord.getPermissionModeDefault()).toBe("ask");
    expect(coord.getAccessMode()).toBe("read_only");
    expect(coord.getPermissionMode(sessionPath)).toBe("read_only");
  });

  it("keeps runtime permission changes out of dynamic append system prompt", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    await coord.createSession(null, tmpDir, true);

    const before = lastSessionOptions.resourceLoader.getAppendSystemPrompt();
    coord.setPermissionMode("read_only");
    const after = lastSessionOptions.resourceLoader.getAppendSystemPrompt();

    expect(after).toEqual(before);
    expect(after.join("\n")).not.toMatch(/READ-ONLY MODE|ASK MODE|只读模式|先问模式/);
  });

  it("does not inject passive UI context into the last user message", async () => {
    currentAgentConfig = { tools: { disabled: [] } };
    fakeEngine.getUiContext.mockReturnValue({
      currentViewed: tmpDir,
      activeFile: path.join(tmpDir, "diary.md"),
      activePreview: null,
      pinnedFiles: [],
    });
    await coord.createSession(null, tmpDir, true);

    const extensions = lastSessionOptions.resourceLoader.getExtensions().extensions;
    const contextHandlers = extensions.flatMap((extension) => extension.handlers?.get?.("context") || []);
    const messages = [{ role: "user", content: "跑一遍测试" }];
    for (const handler of contextHandlers) {
      await handler({ messages }, {
        cwd: tmpDir,
        sessionManager: { getSessionFile: () => fakeSessionPath },
      });
    }

    expect(messages).toEqual([{ role: "user", content: "跑一遍测试" }]);
  });

  it("restores accessMode from session meta before applying tools", async () => {
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(fakeSessionPath)]: {
          memoryEnabled: true,
          accessMode: "read_only",
          toolNames: allNames(),
        },
      }, null, 2),
    );
    await coord.createSession(null, tmpDir, true, null, { restore: true });

    const appliedList = activeToolsSpy.mock.calls[0][0];
    expect(appliedList).toContain("browser");
    expect(appliedList).toContain("web_search");
    expect(appliedList).toContain("exec_command");
    expect(appliedList).not.toContain("bash");
    expect(coord.getAccessMode()).toBe("read_only");
  });

  it("restores plugin tools from the sessionId capability snapshot even when legacy meta is partial", async () => {
    const manifestStore = new SessionManifestStore({
      dbPath: path.join(tmpDir, "session-manifest.db"),
      idGenerator: () => "sess_media_restore",
      now: () => "2026-06-20T10:00:00.000Z",
    });
    coord._sessionManifestStore = manifestStore;
    const mediaTool = { ...makeTool("media_generate-image"), _pluginId: "media" };
    coord._d.buildTools = () => ({
      tools: SDK_BUILTIN_OBJS,
      customTools: [...HANAKO_CUSTOM_OBJS, mediaTool],
    });
    const manifest = manifestStore.createForPath({
      sessionPath: fakeSessionPath,
      ownerAgentId: "test",
      domain: "desktop",
      permissionModeSnapshot: { mode: "auto", source: "test" },
    });
    manifestStore.setCapabilitySnapshot(manifest.sessionId, {
      toolNames: [...defaultBaselineNames(), "media_generate-image"],
    }, { source: "legacy_session_meta_backup" });
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(fakeSessionPath)]: {
          toolNames: defaultBaselineNames(),
        },
      }, null, 2),
    );

    try {
      const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

      const appliedList = activeToolsSpy.mock.calls[0][0];
      expect(appliedList).toContain("media_generate-image");
      expect(coord.getPermissionMode(sessionPath)).toBe("auto");
      const entry = coord._sessions.get(manifest.sessionId);
      expect(entry.toolNames).toContain("media_generate-image");
    } finally {
      manifestStore.close();
    }
  });

  it("restores permission from manifest when legacy session-meta lacks permission fields", async () => {
    const manifestStore = new SessionManifestStore({
      dbPath: path.join(tmpDir, "session-manifest.db"),
      idGenerator: () => "sess_permission_restore",
      now: () => "2026-06-20T10:00:00.000Z",
    });
    coord._sessionManifestStore = manifestStore;
    manifestStore.createForPath({
      sessionPath: fakeSessionPath,
      ownerAgentId: "test",
      domain: "desktop",
      permissionModeSnapshot: { mode: "auto", source: "legacy_session_meta" },
    });
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(fakeSessionPath)]: {
          toolNames: allNames(),
        },
      }, null, 2),
    );

    try {
      const { sessionPath } = await coord.createSession(null, tmpDir, true, null, { restore: true });

      expect(coord.getPermissionMode(sessionPath)).toBe("auto");
      expect(coord.getAccessMode(sessionPath)).toBe("operate");
    } finally {
      manifestStore.close();
    }
  });

  it("maps legacy planMode meta to read-only access mode", async () => {
    await fsp.writeFile(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({
        [path.basename(fakeSessionPath)]: {
          memoryEnabled: true,
          planMode: true,
          toolNames: allNames(),
        },
      }, null, 2),
    );
    await coord.createSession(null, tmpDir, true, null, { restore: true });

    const planList = activeToolsSpy.mock.calls[0][0];
    expect(planList).toContain("read");
    expect(planList).toContain("browser");
    expect(planList).toContain("exec_command");
    expect(planList).not.toContain("bash");
    expect(planList).toContain("automation");
    expect(coord.getAccessMode()).toBe("read_only");
  });

  // ── Frozen capability snapshots ──

  describe("frozen capability snapshots", () => {
    function promptSnapshotEntry(systemPrompt, appendSystemPrompt = []) {
      return {
        version: 1,
        systemPrompt,
        appendSystemPrompt,
        skillsResult: { skills: [], diagnostics: [] },
        agentsFilesResult: { agentsFiles: [] },
      };
    }

    it("restore keeps the frozen prompt and tool snapshots", async () => {
      sessionManagerCreateMock.mockReturnValue({
        getCwd: () => tmpDir,
        getSessionFile: () => fakeSessionPath,
      });
      const newTool = { ...makeTool("office"), _pluginId: "office" };
      coord._d.buildTools = () => ({
        tools: SDK_BUILTIN_OBJS,
        customTools: [...HANAKO_CUSTOM_OBJS, newTool],
      });
      currentAgentConfig = { tools: { disabled: [] } };
      const frozen = restoredSnapshot(allNames());
      await fsp.writeFile(
        path.join(sessionDir, "session-meta.json"),
        JSON.stringify({
          [path.basename(fakeSessionPath)]: {
            toolNames: frozen,
            promptSnapshot: promptSnapshotEntry("mock-prompt", ["legacy frozen workspace scope"]),
          },
        }, null, 2),
      );

      buildSystemPromptSpy.mockClear();
      await coord.createSession(null, tmpDir, true, null, { restore: true });

      // active 工具仍是冻结快照，restore 不额外构造 live prompt。
      expect(activeToolsSpy.mock.calls[0][0]).not.toContain("office");
      expect(buildSystemPromptSpy).not.toHaveBeenCalled();
      const resourceLoader = createAgentSessionMock.mock.calls.at(-1)[0].resourceLoader;
      expect(resourceLoader.getAppendSystemPrompt()).toEqual(["legacy frozen workspace scope"]);
    });

  });

  // ── Explicit refresh (fresh compact rebuilds both snapshots) ──

  describe("refreshCapabilitySnapshots", () => {
    it("rebuilds the tool snapshot with Case C semantics (plugin tools included) and persists it", async () => {
      const pluginTool = { ...makeTool("office"), _pluginId: "office" };
      coord._d.buildTools = () => ({
        tools: SDK_BUILTIN_OBJS,
        customTools: [...HANAKO_CUSTOM_OBJS, pluginTool],
      });
      currentAgentConfig = { tools: { disabled: [] } };
      await fsp.writeFile(
        path.join(sessionDir, "session-meta.json"),
        JSON.stringify({
          [path.basename(fakeSessionPath)]: {
            toolNames: ["read", "bash"],
            promptSnapshot: {
              version: 1,
              systemPrompt: "an older persona prompt",
              appendSystemPrompt: [],
              skillsResult: { skills: [], diagnostics: [] },
              agentsFilesResult: { agentsFiles: [] },
            },
          },
        }, null, 2),
      );

      const { sessionPath } = await coord.createSession(null, tmpDir, true, null, {
        restore: true,
        refreshCapabilitySnapshots: true,
      });

      // 工具快照按当前配置重算，含插件工具
      const appliedList = activeToolsSpy.mock.calls[0][0];
      expect(appliedList).toContain("office");
      expect(appliedList).toContain("browser");

      // session-meta 同步更新：toolNames + promptSnapshot 重建
      // promptSnapshot 一律外置为 sidecar 引用，需经 hydrate 才能看到实际内容
      const metaPath = path.join(sessionDir, "session-meta.json");
      const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
      const entry = meta[path.basename(fakeSessionPath)];
      expect(entry.toolNames).toContain("office");
      expect(entry.promptSnapshot).toMatchObject({
        kind: "session-meta-payload",
        field: "promptSnapshot",
      });
      const hydrated = await coord._readMetaCached(metaPath);
      expect(hydrated[path.basename(fakeSessionPath)].promptSnapshot.systemPrompt).toBe("mock-prompt");
    });

    it("reloadSessionRuntime passes the refresh flag through", async () => {
      const pluginTool = { ...makeTool("office"), _pluginId: "office" };
      coord._d.buildTools = () => ({
        tools: SDK_BUILTIN_OBJS,
        customTools: [...HANAKO_CUSTOM_OBJS, pluginTool],
      });
      coord._d.getAgentById = (id) => (id === "test" ? coord._d.getAgent() : null);
      currentAgentConfig = { tools: { disabled: [] } };
      await fsp.writeFile(
        path.join(sessionDir, "session-meta.json"),
        JSON.stringify({
          [path.basename(fakeSessionPath)]: { toolNames: ["read", "bash"] },
        }, null, 2),
      );
      sessionManagerOpenMock.mockReturnValue({ getCwd: () => tmpDir });

      await coord.createSession(null, tmpDir, true, null, { restore: true });
      expect(activeToolsSpy.mock.calls[0][0]).not.toContain("office");

      await coord.reloadSessionRuntime(fakeSessionPath, { refreshCapabilitySnapshots: true });

      const lastApplied = activeToolsSpy.mock.calls[activeToolsSpy.mock.calls.length - 1][0];
      expect(lastApplied).toContain("office");
      const meta = JSON.parse(await fsp.readFile(path.join(sessionDir, "session-meta.json"), "utf-8"));
      expect(meta[path.basename(fakeSessionPath)].toolNames).toContain("office");
    });
  });
});
