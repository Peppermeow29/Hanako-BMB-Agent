import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createAgentSessionMock = vi.fn();
const sessionManagerCreateMock = vi.fn();
const sessionManagerOpenMock = vi.fn();
const emitSessionShutdownMock = vi.fn(async (session) => {
  const runner = session?.extensionRunner;
  if (runner?.hasHandlers?.("session_shutdown")) {
    await runner.emit({ type: "session_shutdown" });
    return true;
  }
  return false;
});
const PNG_BASE64 = "iVBORw0KGgo=";

vi.mock("../lib/pi-sdk/index.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    createAgentSession: (...args: any[]) => createAgentSessionMock(...args),
    SessionManager: {
      ...actual.SessionManager,
      create: (...args: any[]) => sessionManagerCreateMock(...args),
      open: (...args: any[]) => sessionManagerOpenMock(...args),
    },
    emitSessionShutdown: (...args: any[]) => (emitSessionShutdownMock as any)(...args),
    resizeModelImageInput: async (image) => ({
      data: image.data,
      mimeType: image.mimeType,
      originalWidth: 1,
      originalHeight: 1,
      width: 1,
      height: 1,
      wasResized: false,
    }),
    formatModelImageDimensionNote: () => undefined,
  };
});

import { BridgeSessionManager } from "../core/bridge-session-manager.ts";
import { VisionBridge, VISION_CONTEXT_START } from "../core/vision-bridge.ts";
import { CORE_TOOL_NAMES } from "../shared/tool-categories.ts";

function makeAgent(rootDir, id = "agent-a") {
  const sessionDir = path.join(rootDir, "sessions");
  const agentDir = path.join(rootDir, "agent");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    id,
    agentName: "Agent A",
    sessionDir,
    agentDir,
    tools: [],
    yuanPrompt: "yuan",
    publicAgentsMd: "public persona",
    config: {
      locale: "",
      workspace_context: {},
      models: { chat: { id: "gpt-4o", provider: "openai" } },
      bridge: {},
    },
    buildSystemPrompt: () => "system prompt",
  };
}

function makeDeps(agent) {
  const sessionIdsByPath = new Map<string, string>();
  const ensureSessionRefForPath = vi.fn((sessionPath) => {
    const sessionId = sessionIdsByPath.get(sessionPath)
      || `sess_${path.basename(sessionPath, path.extname(sessionPath))}`;
    sessionIdsByPath.set(sessionPath, sessionId);
    return { sessionId, sessionPath };
  });
  return {
    getHanakoHome: () => rootDir,
    getAgent: () => agent,
    getAgentById: (id) => (id === agent.id ? agent : null),
    getAgents: () => new Map([[agent.id, agent]]),
    getModelManager: () => ({
      availableModels: [{ id: "gpt-4o", provider: "openai", name: "GPT-4o" }],
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: () => "medium",
    }),
    getResourceLoader: () => ({ getSystemPrompt: () => "fallback prompt" }),
    getPreferences: () => ({ thinking_level: "medium" }),
    buildTools: () => ({ tools: [], customTools: [] }),
    getHomeCwd: () => rootCwd,
    ensureSessionRefForPath,
    getSessionIdForPath: vi.fn((sessionPath) => sessionIdsByPath.get(sessionPath) || null),
    applySessionBranchHead: vi.fn(),
    syncSessionBranchHead: vi.fn(),
    registerSessionFile: vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_bridge_inbound",
      fileId: "sf_bridge_inbound",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: path.basename(filePath),
      label,
      ext: "png",
      mime: "image/png",
      size: 4,
      kind: "image",
      origin,
      storageKind,
      createdAt: 1,
    })),
  };
}

function makeTool(name) {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
  };
}

function makeDepsWithTools(agent, options: { toolNames?: string[]; customToolNames?: string[] } = {}) {
  const toolNames = options.toolNames || CORE_TOOL_NAMES;
  const customToolNames = options.customToolNames || ["todo_write"];
  const coreTools = toolNames.map(makeTool);
  const customTools = customToolNames.map(makeTool);
  return {
    ...makeDeps(agent),
    buildTools: () => ({ tools: coreTools, customTools }),
  };
}

function bridgeLiveToolSnapshot(names) {
  const denied = new Set(["computer", "browser", "hana_card_guide", "show_card"]);
  return names.filter((name) => !denied.has(name));
}

let rootDir;
let rootCwd;

describe("BridgeSessionManager teardown", () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-session-teardown-"));
    rootCwd = path.join(rootDir, "cwd");
    fs.mkdirSync(rootCwd, { recursive: true });
    createAgentSessionMock.mockReset();
    sessionManagerCreateMock.mockReset();
    sessionManagerOpenMock.mockReset();
    emitSessionShutdownMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("refuses bridge work that does not say which agent it belongs to", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));

    // The deps still expose a focused agent. Bridge records are per-agent files,
    // so an operation that never named an agent must say so rather than write
    // into whichever agent happened to be in the foreground.
    expect(() => manager.isFreshCompactAlreadySatisfied("telegram:dm:owner", {}))
      .toThrow(/agentId required/);
    expect(() => manager.recordAssistantMessage("telegram:dm:owner", "hi", {}))
      .toThrow(/agentId required/);
    await expect(manager.markFreshCompactSatisfied("telegram:dm:owner", {}))
      .rejects.toThrow(/agentId required/);
    await expect(manager.compactSession("telegram:dm:owner", {}))
      .rejects.toThrow(/agentId required/);
  });

  it("refuses to locate a bridge index without an agent", () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));

    // Same reason: the index file lives under one agent's session directory.
    expect(() => manager.readIndex(undefined as any)).toThrow(/agent required/);
    expect(() => manager.writeIndex({}, undefined as any)).toThrow(/agent required/);
    // Naming the agent still works.
    expect(manager.readIndex(agent)).toEqual({});
  });

  it("passes bridge steer text to the SDK without adding an internal prefix", () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));
    const session = {
      isStreaming: true,
      steer: vi.fn(),
    };
    manager.activeSessions.set("telegram:dm:owner", session);

    expect(manager.steerSession("telegram:dm:owner", "先停一下，直接回答这个")).toBe(true);
    expect(session.steer).toHaveBeenCalledWith("先停一下，直接回答这个");
  });

  it("does not steer an active bridge session across role boundaries", () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));
    const sessionKey = "qq_dm_same-person@agent-a";
    const session = {
      isStreaming: true,
      steer: vi.fn(),
    };
    manager.activeSessions.set(sessionKey, session);
    manager._activeSessionRoles.set(sessionKey, "guest");

    expect(manager.isSessionStreaming(sessionKey, { role: "owner" })).toBe(false);
    expect(manager.steerSession(sessionKey, "owner message", { role: "owner" })).toBe(false);
    expect(session.steer).not.toHaveBeenCalled();
    expect(manager.steerSession(sessionKey, "guest message", { role: "guest" })).toBe(true);
    expect(session.steer).toHaveBeenCalledWith("guest message");
  });

  it("executeExternalMessage 结束后走 emit -> unsub -> dispose", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s1.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const callOrder = [];
    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => { callOrder.push("unsub"); }),
      dispose: vi.fn(() => { callOrder.push("dispose"); }),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: {
        hasHandlers: vi.fn(() => true),
        emit: vi.fn(async () => { callOrder.push("emit"); }),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "bridge-k1", null, { agentId: "agent-a" });

    expect(callOrder).toEqual(["emit", "unsub", "dispose"]);
    expect(emitSessionShutdownMock).toHaveBeenCalledWith(session);
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(manager.activeSessions.has("bridge-k1")).toBe(false);
  });

  it("emits normal bridge turns through the desktop chat stream contract", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "stream.jsonl");
    const deps = makeDeps(agent) as any;
    deps.emitEvent = vi.fn();
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const subscribers = [];
    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {
        for (const fn of subscribers) {
          fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } });
          fn({ type: "tool_execution_start", toolName: "read", args: { file_path: "/tmp/a.txt" } });
          fn({ type: "tool_execution_end", toolName: "read", isError: false, result: { details: {} } });
        }
      }),
      subscribe: vi.fn((fn) => {
        subscribers.push(fn);
        return vi.fn();
      }),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const reply = await manager.executeExternalMessage("model prompt", "tg_dm_owner@agent-a", null, {
      agentId: "agent-a",
      displayMessage: { text: "visible bridge message", source: "bridge" },
    });

    expect(reply).toEqual({ text: "Hello", toolMedia: [], error: null, truncated: false });
    expect(deps.emitEvent).toHaveBeenCalledWith(
      { type: "session_status", isStreaming: true },
      mgrPath,
    );
    expect(deps.emitEvent).toHaveBeenCalledWith(
      {
        type: "session_user_message",
        message: expect.objectContaining({
          text: "visible bridge message",
          source: "bridge",
          bridgeSessionKey: "tg_dm_owner@agent-a",
        }),
      },
      mgrPath,
    );
    expect(deps.emitEvent).toHaveBeenCalledWith(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } },
      mgrPath,
    );
    expect(deps.emitEvent).toHaveBeenCalledWith(
      { type: "tool_execution_start", toolName: "read", args: { file_path: "/tmp/a.txt" } },
      mgrPath,
    );
    expect(deps.emitEvent).toHaveBeenCalledWith(
      { type: "tool_execution_end", toolName: "read", isError: false, result: { details: {} } },
      mgrPath,
    );
    expect(deps.emitEvent).toHaveBeenLastCalledWith(
      { type: "session_status", isStreaming: false },
      mgrPath,
    );
  });

  it("adds Bridge-facing /apply details from automation suggestion tool results", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "automation-suggestion.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const subscribers = [];
    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {
        for (const fn of subscribers) {
          fn({
            type: "tool_execution_end",
            toolName: "automation",
            isError: false,
            result: {
              details: {
                automationSuggestion: {
                  suggestionId: "automation_suggestion_1",
                  shortCode: "3827",
                  operation: "create",
                  jobData: {
                    type: "cron",
                    schedule: "0 12 * * *",
                    label: "每日吃饭提醒",
                    prompt: "该吃饭啦！记得好好吃饭，照顾好自己。",
                    actorAgentId: "agent-a",
                  },
                },
              },
            },
          });
        }
      }),
      subscribe: vi.fn((fn) => {
        subscribers.push(fn);
        return vi.fn();
      }),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const reply = await manager.executeExternalMessage("create reminder", "tg_dm_owner@agent-a", null, { agentId: "agent-a" });

    expect(reply.error).toBeNull();
    expect(reply.text).toContain("我准备了一项自动任务建议");
    expect(reply.text).toContain("标题：每日吃饭提醒");
    expect(reply.text).toContain("建议ID：3827");
    expect(reply.text).toContain("回复 /apply 即可创建这个任务。");
    expect(reply.text).toContain("/apply 3827");
    expect(reply.text).not.toContain("/confirm");
  });

  it("notifies the owner bridge memory ticker after a successful external turn", async () => {
    const agent = makeAgent(rootDir) as any;
    agent.memoryTicker = {
      notifyTurn: vi.fn(),
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "memory-turn.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => vi.fn()),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "tg_dm_owner@agent-a", null, { agentId: "agent-a" });

    expect(agent.memoryTicker.notifyTurn).toHaveBeenCalledOnce();
    expect(agent.memoryTicker.notifyTurn).toHaveBeenCalledWith(mgrPath);
  });

  it("returns provider message_end errors as structured diagnostics instead of swallowing them", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "error.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const subscribers = [];
    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {
        for (const fn of subscribers) {
          fn({
            type: "message_end",
            message: {
              stopReason: "error",
              errorMessage: "400 Param Incorrect",
            },
          });
        }
      }),
      subscribe: vi.fn((fn) => {
        subscribers.push(fn);
        return vi.fn();
      }),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await expect(
      manager.executeExternalMessage("hello", "bridge-error", null, { agentId: "agent-a" }),
    ).resolves.toEqual({
      text: null,
      toolMedia: [],
      error: "400 Param Incorrect",
      truncated: false,
    });
  });

  it("preserves captured partial text alongside a provider message_end error (#1607)", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "partial-provider-error.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const subscribers = [];
    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {
        for (const fn of subscribers) {
          fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "我查到一半了，" } });
          fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "结论是" } });
          fn({ type: "message_end", message: { stopReason: "error", errorMessage: "terminated" } });
        }
      }),
      subscribe: vi.fn((fn) => {
        subscribers.push(fn);
        return vi.fn();
      }),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await expect(
      manager.executeExternalMessage("hello", "bridge-partial-provider-error", null, { agentId: "agent-a" }),
    ).resolves.toEqual({
      text: "我查到一半了，结论是",
      toolMedia: [],
      error: "terminated",
      truncated: true,
    });
  });

  it("preserves captured partial text when the transport throws mid-stream (#1607)", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "partial-transport-error.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const subscribers = [];
    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {
        for (const fn of subscribers) {
          fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "刚开了个头" } });
        }
        throw new TypeError("terminated");
      }),
      subscribe: vi.fn((fn) => {
        subscribers.push(fn);
        return vi.fn();
      }),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await expect(
      manager.executeExternalMessage("hello", "bridge-partial-transport-error", null, { agentId: "agent-a" }),
    ).resolves.toEqual({
      text: "刚开了个头",
      toolMedia: [],
      error: "terminated",
      truncated: true,
    });
  });

  it("freshCompactSession compacts with the current owner prompt and records freshness metadata", async () => {
    const agent = makeAgent(rootDir);
    agent.buildSystemPrompt = vi.fn(() => "system prompt v2");
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "fresh.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    manager.writeIndex({
      "tg_dm_fresh@agent-a": { file: "owner/fresh.jsonl", name: "Owner" },
    }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const usage = vi.fn()
      .mockReturnValueOnce({ tokens: 12000, contextWindow: 128000 })
      .mockReturnValueOnce({ tokens: 4200, contextWindow: 128000 });
    const session = {
      compact: vi.fn(async () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: usage,
      extensionRunner: { hasHandlers: vi.fn(() => true), emit: vi.fn(async () => {}) },
    };
    createAgentSessionMock.mockImplementation(async (options) => {
      expect(options.resourceLoader.getSystemPrompt()).toContain("system prompt v2");
      return { session };
    });

    const result = await manager.freshCompactSession("tg_dm_fresh@agent-a", {
      agentId: "agent-a",
      reason: "manual",
      now: new Date("2026-05-15T09:00:00.000Z"),
    });

    expect(session.compact).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      tokensBefore: 12000,
      tokensAfter: 4200,
      contextWindow: 128000,
      fresh: true,
      reason: "manual",
    });
    const index = manager.readIndex(agent);
    expect(index["tg_dm_fresh@agent-a"].freshCompact).toMatchObject({
      lastFreshCompactDate: "2026-05-15",
      freshCompactReason: "manual",
      freshCompactTokensBefore: 12000,
      freshCompactTokensAfter: 4200,
    });
    expect(index["tg_dm_fresh@agent-a"].name).toBe("Owner");
  });

  it("recomputes restored owner bridge tools from live tools and applies the Bridge deny-list", async () => {
    const agent = makeAgent(rootDir);
    const liveToolNames = [
      ...CORE_TOOL_NAMES,
      "todo_write",
      "media_generate-image",
      "media_generate-video",
      "computer",
      "browser",
      "hana_card_guide",
      "show_card",
    ];
    const manager = new BridgeSessionManager(makeDepsWithTools(agent, {
      toolNames: liveToolNames,
      customToolNames: [],
    }));
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "restore-tools.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    manager.writeIndex({
      "tg_dm_restore_tools@agent-a": {
        file: "owner/restore-tools.jsonl",
        toolNames: ["todo_write", "retired_tool", "todo_write"],
      },
    }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const setActiveToolsByName = vi.fn();
    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      extensionRunner: {
        assertActive: vi.fn(),
        hasHandlers: vi.fn((event) => event === "session_before_compact"),
        emit: vi.fn(async () => {}),
      },
      setActiveToolsByName,
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "tg_dm_restore_tools@agent-a", null, { agentId: "agent-a" });

    const expected = bridgeLiveToolSnapshot(liveToolNames);
    expect(setActiveToolsByName).toHaveBeenCalledWith(expected);
    const createArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    const exposedToolNames = [
      ...createArgs.tools.map((tool) => tool.name),
      ...createArgs.customTools.map((tool) => tool.name),
    ];
    expect(exposedToolNames).not.toContain("computer");
    expect(exposedToolNames).not.toContain("browser");
    expect(setActiveToolsByName.mock.calls[0][0]).not.toContain("retired_tool");
    expect(setActiveToolsByName.mock.calls[0][0]).toContain("media_generate-image");
    expect(setActiveToolsByName.mock.calls[0][0]).toContain("media_generate-video");
    expect(setActiveToolsByName.mock.calls[0][0]).not.toContain("computer");
    expect(setActiveToolsByName.mock.calls[0][0]).not.toContain("browser");
    expect(setActiveToolsByName.mock.calls[0][0]).not.toContain("hana_card_guide");
    expect(setActiveToolsByName.mock.calls[0][0]).not.toContain("show_card");
    expect(manager.readIndex(agent)["tg_dm_restore_tools@agent-a"].toolNames)
      .toEqual(expected);
  });

  it("recomputes bridge compact tool snapshots from live tools before reopening temporary owner sessions", async () => {
    const agent = makeAgent(rootDir);
    const liveToolNames = [
      ...CORE_TOOL_NAMES,
      "todo_write",
      "media_generate-image",
      "computer",
      "browser",
      "show_card",
    ];
    const manager = new BridgeSessionManager(makeDepsWithTools(agent, {
      toolNames: liveToolNames,
      customToolNames: [],
    }));
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "compact-tools.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    manager.writeIndex({
      "tg_dm_compact_tools@agent-a": {
        file: "owner/compact-tools.jsonl",
        toolNames: ["todo_write", "retired_tool"],
      },
    }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const setActiveToolsByName = vi.fn();
    const session = {
      isCompacting: false,
      compact: vi.fn(async () => {}),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: vi.fn()
        .mockReturnValueOnce({ tokens: 900, contextWindow: 128000 })
        .mockReturnValueOnce({ tokens: 300, contextWindow: 128000 }),
      dispose: vi.fn(),
      extensionRunner: {
        assertActive: vi.fn(),
        hasHandlers: vi.fn((event) => event === "session_before_compact"),
        emit: vi.fn(async () => {}),
      },
      setActiveToolsByName,
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.compactSession("tg_dm_compact_tools@agent-a", { agentId: "agent-a" });

    expect(manager._deps.ensureSessionRefForPath).toHaveBeenCalledWith(
      sessionFile,
      expect.objectContaining({
        ownerAgentId: "agent-a",
        domain: "bridge",
        kind: "bridge_owner",
      }),
    );

    const expected = bridgeLiveToolSnapshot(liveToolNames);
    expect(setActiveToolsByName).toHaveBeenCalledWith(expected);
    const createArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(createArgs.tools.map((tool) => tool.name)).not.toContain("browser");
    const indexEntry = manager.readIndex(agent)["tg_dm_compact_tools@agent-a"];
    expect(indexEntry.toolNames).toEqual(expected);
  });

  it("freshCompactSession records daily freshness when the bridge session is already compacted", async () => {
    const agent = makeAgent(rootDir);
    agent.buildSystemPrompt = vi.fn(() => "system prompt v3");
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "already.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: "message", role: "user", content: "hello" }),
      JSON.stringify({ type: "compaction", summary: "earlier bridge turns" }),
      "",
    ].join("\n"), "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    manager.writeIndex({
      "tg_dm_already@agent-a": {
        file: "owner/already.jsonl",
        name: "Owner",
        freshCompact: { lastFreshCompactDate: "2026-05-14" },
      },
    }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const usage = vi.fn(() => ({ tokens: 4200, contextWindow: 128000 }));
    const session = {
      compact: vi.fn(async () => { throw new Error("Already compacted"); }),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: usage,
      extensionRunner: { hasHandlers: vi.fn(() => true), emit: vi.fn(async () => {}) },
    };
    createAgentSessionMock.mockImplementation(async (options) => {
      expect(options.resourceLoader.getSystemPrompt()).toContain("system prompt v3");
      return { session };
    });

    const result = await manager.freshCompactSession("tg_dm_already@agent-a", {
      agentId: "agent-a",
      reason: "daily",
      now: new Date("2026-05-15T09:00:00.000Z"),
    });

    expect(session.compact).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      fresh: true,
      reason: "daily",
      noop: true,
      noopReason: "already_compacted",
      tokensBefore: 4200,
      tokensAfter: 4200,
      contextWindow: 128000,
    });
    const index = manager.readIndex(agent);
    expect(index["tg_dm_already@agent-a"].freshCompact).toMatchObject({
      lastFreshCompactDate: "2026-05-15",
      freshCompactReason: "daily",
      freshCompactTokensBefore: 4200,
      freshCompactTokensAfter: 4200,
    });
    expect(index["tg_dm_already@agent-a"].promptSnapshot.systemPrompt).toContain("system prompt v3");
  });

  it("freshCompactSession records daily freshness when the bridge session is too small to compact", async () => {
    const agent = makeAgent(rootDir);
    agent.buildSystemPrompt = vi.fn(() => "system prompt small");
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "small.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify({ type: "message", role: "user", content: "hi" }) + "\n", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    manager.writeIndex({
      "tg_dm_small@agent-a": {
        file: "owner/small.jsonl",
        freshCompact: { lastFreshCompactDate: "2026-05-14" },
      },
    }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const session = {
      compact: vi.fn(async () => { throw new Error("Nothing to compact (session too small)"); }),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: vi.fn(() => ({ tokens: 300, contextWindow: 128000 })),
      extensionRunner: { hasHandlers: vi.fn(() => true), emit: vi.fn(async () => {}) },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const result = await manager.freshCompactSession("tg_dm_small@agent-a", {
      agentId: "agent-a",
      reason: "daily",
      now: new Date("2026-05-15T09:00:00.000Z"),
    });

    expect(result).toMatchObject({
      fresh: true,
      noop: true,
      noopReason: "nothing_to_compact",
      tokensBefore: 300,
      tokensAfter: 300,
    });
    expect(manager.readIndex(agent)["tg_dm_small@agent-a"].freshCompact).toMatchObject({
      lastFreshCompactDate: "2026-05-15",
      freshCompactTokensBefore: 300,
      freshCompactTokensAfter: 300,
    });
  });

  it("executeExternalMessage does not fresh-compact inline for an existing owner bridge session", async () => {
    const agent = makeAgent(rootDir);
    agent.buildSystemPrompt = vi.fn(() => "system prompt current");
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "existing.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    manager.writeIndex({
      "tg_dm_existing@agent-a": {
        file: "owner/existing.jsonl",
        freshCompact: { lastFreshCompactDate: "2026-05-14" },
      },
    }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const liveSession = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    const compactSession = {
      compact: vi.fn(async () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: vi.fn()
        .mockReturnValueOnce({ tokens: 9000, contextWindow: 128000 })
        .mockReturnValueOnce({ tokens: 3600, contextWindow: 128000 }),
      extensionRunner: { hasHandlers: vi.fn(() => true), emit: vi.fn(async () => {}) },
    };
    createAgentSessionMock
      .mockResolvedValueOnce({ session: liveSession })
      .mockResolvedValueOnce({ session: compactSession });

    await manager.executeExternalMessage("hello", "tg_dm_existing@agent-a", null, { agentId: "agent-a" });

    expect(compactSession.compact).not.toHaveBeenCalled();
    const index = manager.readIndex(agent);
    expect(index["tg_dm_existing@agent-a"].freshCompact).toEqual({ lastFreshCompactDate: "2026-05-14" });
    expect(manager.listDailyFreshCompactTargets(agent, {
      now: new Date("2026-05-15T09:00:00"),
    })).toEqual([{ sessionKey: "tg_dm_existing@agent-a", sessionPath: sessionFile, reason: "daily" }]);
  });

  it("recordAssistantMessage records without fresh-compacting inline for an existing owner bridge session", async () => {
    const agent = makeAgent(rootDir);
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "assistant.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const deps = makeDeps(agent);
    const manager = new BridgeSessionManager(deps);
    manager.writeIndex({
      "tg_dm_assistant@agent-a": {
        file: "owner/assistant.jsonl",
        freshCompact: { lastFreshCompactDate: "2026-05-14" },
      },
    }, agent);

    const appendMessage = vi.fn();
    sessionManagerOpenMock
      .mockReturnValueOnce({ getSessionFile: () => sessionFile, appendMessage })
      .mockReturnValue({ getSessionFile: () => sessionFile });
    const compactSession = {
      compact: vi.fn(async () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: vi.fn()
        .mockReturnValueOnce({ tokens: 7000, contextWindow: 128000 })
        .mockReturnValueOnce({ tokens: 3000, contextWindow: 128000 }),
      extensionRunner: { hasHandlers: vi.fn(() => true), emit: vi.fn(async () => {}) },
    };
    createAgentSessionMock.mockResolvedValue({ session: compactSession });

    expect(manager.recordAssistantMessage("tg_dm_assistant@agent-a", "hello", {
      agentId: "agent-a",
    })).toBe(true);

    expect(appendMessage).toHaveBeenCalledOnce();
    expect(deps.applySessionBranchHead).toHaveBeenCalledWith(
      sessionFile,
      expect.objectContaining({ appendMessage }),
      expect.objectContaining({ reason: "bridge_assistant_record_restore" }),
    );
    expect(deps.syncSessionBranchHead).toHaveBeenCalledWith(
      sessionFile,
      expect.objectContaining({ appendMessage }),
      "bridge_assistant_record_append",
    );
    expect(compactSession.compact).not.toHaveBeenCalled();
    const index = manager.readIndex(agent);
    expect(index["tg_dm_assistant@agent-a"].freshCompact).toEqual({ lastFreshCompactDate: "2026-05-14" });
    expect(manager.listDailyFreshCompactTargets(agent, {
      now: new Date("2026-05-15T09:00:00"),
    })).toEqual([{ sessionKey: "tg_dm_assistant@agent-a", sessionPath: sessionFile, reason: "daily" }]);
  });

  it("records non-context custom entries into an existing bridge session file", () => {
    const agent = makeAgent(rootDir);
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "assistant.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const deps = makeDeps(agent);
    const manager = new BridgeSessionManager(deps);
    manager.writeIndex({
      "tg_dm_assistant@agent-a": { file: "owner/assistant.jsonl" },
    }, agent);

    const appendCustomEntry = vi.fn();
    sessionManagerOpenMock.mockReturnValueOnce({ appendCustomEntry });

    const result = manager.recordCustomEntryForSessionPath(
      sessionFile,
      "hana-deferred-result",
      { taskId: "task-img" },
      { agentId: "agent-a" },
    );

    expect(result).toMatchObject({ ok: true, mode: "bridge-file" });
    expect(sessionManagerOpenMock).toHaveBeenCalledWith(sessionFile, path.dirname(sessionFile));
    expect(deps.applySessionBranchHead).toHaveBeenCalledWith(
      sessionFile,
      expect.objectContaining({ appendCustomEntry }),
      expect.objectContaining({ reason: "bridge_custom_entry_file_open" }),
    );
    expect(appendCustomEntry).toHaveBeenCalledWith("hana-deferred-result", { taskId: "task-img" });
    expect(deps.syncSessionBranchHead).toHaveBeenCalledWith(
      sessionFile,
      expect.objectContaining({ appendCustomEntry }),
      "bridge_custom_entry_file_append",
    );
  });

  it("records non-context custom entries through the live bridge session manager when loaded", () => {
    const agent = makeAgent(rootDir);
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "assistant.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    manager.writeIndex({
      "tg_dm_assistant@agent-a": { file: "owner/assistant.jsonl" },
    }, agent);

    const appendCustomEntry = vi.fn();
    manager.activeSessions.set("tg_dm_assistant@agent-a", {
      sessionManager: {
        getSessionFile: () => sessionFile,
        appendCustomEntry,
      },
    });

    const result = manager.recordCustomEntryForSessionPath(
      sessionFile,
      "hana-deferred-result",
      { taskId: "task-img" },
      { agentId: "agent-a" },
    );

    expect(result).toMatchObject({ ok: true, mode: "bridge-live" });
    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
    expect(appendCustomEntry).toHaveBeenCalledWith("hana-deferred-result", { taskId: "task-img" });
  });

  it("registers bridge inbound image files after the bridge session path exists", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-inbound.jsonl");
    const deps = makeDeps(agent);
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = {
      model: { input: ["text", "image"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "bridge-inbound", null, {
      agentId: "agent-a",
      images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      inboundFiles: [{
        type: "image",
        filename: "photo.png",
        mimeType: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      }],
    });

    expect(deps.registerSessionFile).toHaveBeenCalledWith({
      sessionId: "sess_s-inbound",
      sessionPath: mgrPath,
      filePath: expect.stringContaining(path.join(rootDir, "session-files")),
      label: "photo.png",
      origin: "bridge_inbound",
      storageKind: "managed_cache",
    });
    expect(session.prompt).toHaveBeenCalledWith(
      `[attached_image: ${deps.registerSessionFile.mock.calls[0][0].filePath}]\nhello`,
      expect.objectContaining({
        images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
        imageAttachmentPaths: [deps.registerSessionFile.mock.calls[0][0].filePath],
      }),
    );
  });

  it("abortSession releases a bridge session immediately when provider abort never settles", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));
    const abort = vi.fn(() => new Promise(() => {}));
    const dispose = vi.fn();

    manager.activeSessions.set("bridge-k1", {
      isStreaming: true,
      abort,
      dispose,
    });

    const result = await Promise.race([
      manager.abortSession("bridge-k1"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 25)),
    ]);

    expect(result).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalled();
    expect(manager.activeSessions.has("bridge-k1")).toBe(false);
  });

  it("abortSession cancels pre-prompt vision prepare before bridge streaming starts", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "pre-vision.jsonl");
    let resolvePrepareStarted;
    const prepareStarted = new Promise((resolve) => { resolvePrepareStarted = resolve; });
    let prepareSignal;
    const deps = {
      ...makeDeps(agent),
      isVisionAuxiliaryEnabled: () => true,
      getVisionBridge: () => ({
        prepare: vi.fn(({ signal }) => {
          prepareSignal = signal;
          resolvePrepareStarted();
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              (err as any).type = "aborted";
              reject(err);
            }, { once: true });
          });
        }),
      }),
    };
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });
    const session = {
      model: { input: ["text"] },
      isStreaming: false,
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: {
        hasHandlers: vi.fn(() => false),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const task = manager.executeExternalMessage("hello", "bridge-pre", null, {
      agentId: "agent-a",
      images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
    });
    await prepareStarted;

    expect(manager.isSessionStreaming("bridge-pre")).toBe(true);
    await expect(manager.abortSession("bridge-pre")).resolves.toBe(true);
    await expect(task).resolves.toBeNull();
    expect(prepareSignal.aborted).toBe(true);
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalled();
    expect(manager.activeSessions.has("bridge-pre")).toBe(false);
  });

  it("owner bridge session prompt snapshot uses the same home cwd as execution", async () => {
    const agent = makeAgent(rootDir);
    agent.config.locale = "en-US";
    agent.config.workspace_context = { inject_agents_md: true };
    fs.mkdirSync(path.join(rootCwd, ".git"), { recursive: true });
    fs.writeFileSync(path.join(rootCwd, "AGENTS.md"), "BRIDGE_WORKSPACE_INSTRUCTION\n", "utf-8");
    agent.buildSystemPrompt = vi.fn(() => "stable owner prompt");
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-home.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: {
        hasHandlers: vi.fn(() => false),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "bridge-k-home", null, { agentId: "agent-a" });

    expect(agent.buildSystemPrompt).toHaveBeenCalledWith(expect.not.objectContaining({ cwdOverride: expect.anything() }));
    const createArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(createArgs.cwd).toBe(rootCwd);
    expect(createArgs.resourceLoader.getSystemPrompt()).toContain("stable owner prompt");
    const append = createArgs.resourceLoader.getAppendSystemPrompt().join("\n\n");
    expect(append).toContain(`Primary workbench: ${rootCwd}`);
    expect(append).toContain("BRIDGE_WORKSPACE_INSTRUCTION");
    expect(append).not.toContain("Current working directory");
  });

  it("owner bridge sessions persist and reuse their prompt snapshot", async () => {
    const agent = makeAgent(rootDir);
    agent.config.locale = "en-US";
    agent.buildSystemPrompt = vi.fn()
      .mockReturnValueOnce("owner prompt v1")
      .mockReturnValueOnce("owner prompt v2");
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "snapshot.jsonl");
    fs.mkdirSync(path.dirname(mgrPath), { recursive: true });
    fs.writeFileSync(mgrPath, "", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const makeSession = () => ({
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    });
    createAgentSessionMock
      .mockResolvedValueOnce({ session: makeSession() })
      .mockResolvedValueOnce({ session: makeSession() });

    await manager.executeExternalMessage("hello", "tg_dm_snapshot@agent-a", null, { agentId: "agent-a" });
    const snapshot = manager.readIndex(agent)["tg_dm_snapshot@agent-a"].promptSnapshot;
    expect(snapshot?.systemPrompt).toContain("owner prompt v1");
    expect(snapshot?.systemPrompt).not.toContain("owner prompt v2");
    expect(snapshot?.appendSystemPrompt.join("\n\n")).toContain(`Primary workbench: ${rootCwd}`);

    await manager.executeExternalMessage("hello again", "tg_dm_snapshot@agent-a", null, { agentId: "agent-a" });
    const secondCreateArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(secondCreateArgs.resourceLoader.getSystemPrompt()).toBe(snapshot.systemPrompt);
    expect(secondCreateArgs.resourceLoader.getAppendSystemPrompt()).toEqual(snapshot.appendSystemPrompt);
    expect(agent.buildSystemPrompt).toHaveBeenCalledTimes(1);
  });

  it("guest bridge sessions persist and reuse their prompt snapshot", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "guests", "guest-snapshot.jsonl");
    fs.mkdirSync(path.dirname(mgrPath), { recursive: true });
    fs.writeFileSync(mgrPath, "", "utf-8");
    const deps = makeDeps(agent);
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const makeSession = () => ({
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    });
    createAgentSessionMock
      .mockResolvedValueOnce({ session: makeSession() })
      .mockResolvedValueOnce({ session: makeSession() });

    await manager.executeExternalMessage("hello", "fs_group_guest-snapshot@agent-a", {
      userId: "guest-user",
      chatId: "guest-chat",
    }, { agentId: "agent-a", guest: true, contextTag: "group v1" });
    expect(deps.ensureSessionRefForPath).toHaveBeenCalledWith(
      mgrPath,
      expect.objectContaining({
        ownerAgentId: "agent-a",
        domain: "bridge",
        kind: "bridge_guest",
      }),
    );
    const snapshot = manager.readIndex(agent)["fs_group_guest-snapshot@agent-a"].promptSnapshot;
    expect(snapshot?.systemPrompt).toContain("public persona");
    expect(snapshot?.systemPrompt).toContain("group v1");

    agent.publicAgentsMd = "public persona v2";
    await manager.executeExternalMessage("hello again", "fs_group_guest-snapshot@agent-a", {
      userId: "guest-user",
      chatId: "guest-chat",
    }, { agentId: "agent-a", guest: true, contextTag: "group v2" });
    const secondCreateArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(secondCreateArgs.resourceLoader.getSystemPrompt()).toBe(snapshot.systemPrompt);
    expect(secondCreateArgs.resourceLoader.getSystemPrompt()).not.toContain("group v2");
  });

  it("creates a new owner bridge session when an existing guest session becomes owner", async () => {
    const agent = makeAgent(rootDir);
    agent.buildSystemPrompt = vi.fn(() => "owner prompt");
    const sessionKey = "qq_dm_c2c-openid@agent-a";
    const guestPath = path.join(agent.sessionDir, "bridge", "guests", "guest-first.jsonl");
    const ownerPath = path.join(agent.sessionDir, "bridge", "owner", "owner-after.jsonl");
    fs.mkdirSync(path.dirname(guestPath), { recursive: true });
    fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
    fs.writeFileSync(guestPath, "", "utf-8");
    fs.writeFileSync(ownerPath, "", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock
      .mockReturnValueOnce({ getSessionFile: () => guestPath })
      .mockReturnValueOnce({ getSessionFile: () => ownerPath });
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => guestPath });
    createAgentSessionMock.mockImplementation(async ({ sessionManager }) => ({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager,
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    }));

    await manager.executeExternalMessage("guest hello", sessionKey, {
      userId: "qq-user",
      chatId: "c2c-openid",
    }, { agentId: "agent-a", guest: true, contextTag: "guest context" });
    expect(manager.readIndex(agent)[sessionKey]).toMatchObject({
      file: "guests/guest-first.jsonl",
      role: "guest",
    });

    sessionManagerCreateMock.mockClear();
    sessionManagerOpenMock.mockClear();
    createAgentSessionMock.mockClear();

    await manager.executeExternalMessage("owner hello", sessionKey, {
      userId: "qq-user",
      chatId: "c2c-openid",
    }, { agentId: "agent-a" });

    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
    expect(sessionManagerCreateMock).toHaveBeenCalledOnce();
    const ownerCreateArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(ownerCreateArgs.resourceLoader.getSystemPrompt()).toContain("owner prompt");
    expect(ownerCreateArgs.resourceLoader.getSystemPrompt()).not.toContain("public persona");
    const entry = manager.readIndex(agent)[sessionKey];
    expect(entry).toMatchObject({
      file: "owner/owner-after.jsonl",
      role: "owner",
    });
    expect(entry.promptSnapshot.systemPrompt).toContain("owner prompt");
    expect(entry.promptSnapshot.systemPrompt).not.toContain("public persona");
  });

  it("adds a low-salience platform line and records bridge context metadata for owner sessions", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-wechat.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: {
        hasHandlers: vi.fn(() => false),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage(
      "hello",
      "wx_dm_wx-user@agent-a",
      { userId: "wx-user", chatId: "wx-user", name: "微信用户" },
      { agentId: "agent-a" },
    );

    const createArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(createArgs.resourceLoader.getSystemPrompt()).toContain(
      "当前用户正通过微信与你对话，仅在需要理解当前平台或“这里”等指代时参考。",
    );
    // #1619：文本平台的确认协议指引必须进 owner system prompt
    expect(createArgs.resourceLoader.getSystemPrompt()).toContain("回复 /apply 创建最新的自动任务建议");
    expect(createArgs.resourceLoader.getSystemPrompt()).toContain("不要让用户点击任何界面元素");
    expect(manager.readIndex(agent)["wx_dm_wx-user@agent-a"]).toMatchObject({
      file: "owner/s-wechat.jsonl",
      platform: "wechat",
      chatType: "dm",
      role: "owner",
      userId: "wx-user",
      chatId: "wx-user",
    });
    expect(manager.getBridgeContextForSessionPath(mgrPath, { agentId: "agent-a" })).toMatchObject({
      isBridgeSession: true,
      platform: "wechat",
      platformLabel: "微信",
      chatType: "dm",
      role: "owner",
      notificationHint: {
        channels: ["bridge_owner"],
        bridgePlatforms: ["wechat"],
        contextPolicy: "record_when_delivered",
      },
    });
  });

  it("infers guest bridge context from legacy guest session file location", () => {
    const agent = makeAgent(rootDir);
    const sessionFile = path.join(agent.sessionDir, "bridge", "guests", "legacy-group.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const manager = new BridgeSessionManager(makeDeps(agent));
    manager.writeIndex({
      "tg_group_g1@agent-a": {
        file: "guests/legacy-group.jsonl",
        userId: "guest-user",
        chatId: "g1",
      },
    }, agent);

    expect(manager.getBridgeContextForSessionPath(sessionFile, { agentId: "agent-a" })).toMatchObject({
      isBridgeSession: true,
      platform: "telegram",
      chatType: "group",
      role: "guest",
      notificationHint: null,
    });
  });

  it("caches bridge context by sessionId when the manifest resolver can provide it", () => {
    const agent = makeAgent(rootDir);
    const beforePath = path.join(agent.sessionDir, "bridge", "owner", "before.jsonl");
    const afterPath = path.join(agent.sessionDir, "bridge", "owner", "after.jsonl");
    const manager = new BridgeSessionManager({
      ...makeDeps(agent),
      getSessionIdForPath: vi.fn((sessionPath) => (
        sessionPath === beforePath || sessionPath === afterPath
          ? "sess_bridge_stable"
          : null
      )),
    });

    manager._rememberBridgeContext(beforePath, {
      isBridgeSession: true,
      platform: "wechat",
      chatType: "dm",
      role: "owner",
      sessionKey: "wx_dm_stable@agent-a",
      agentId: "agent-a",
      userId: "wx-user",
      chatId: "wx-user",
    });

    expect(manager._bridgeContextsBySessionIdentity.has("id:sess_bridge_stable")).toBe(true);
    expect(manager._bridgeContextsBySessionIdentity.has(`path:${path.resolve(beforePath)}`)).toBe(false);
    expect(manager._bridgeContextsBySessionIdentity.has(path.resolve(beforePath))).toBe(false);
    expect(manager.getBridgeContextForSessionPath(afterPath, { agentId: "agent-a" })).toMatchObject({
      isBridgeSession: true,
      platform: "wechat",
      chatType: "dm",
      role: "owner",
      sessionKey: "wx_dm_stable@agent-a",
    });
  });

  it("owner bridge tools follow the master memory switch instead of session memory state", async () => {
    const agent = makeAgent(rootDir) as any;
    agent.memoryMasterEnabled = true;
    const plainTool = { name: "plain_custom" };
    const memoryTool = { name: "search_memory" };
    agent.tools = [plainTool];
    agent.getToolsSnapshot = vi.fn(({ forceMemoryEnabled }: any = {}) => (
      forceMemoryEnabled ? [plainTool, memoryTool] : [plainTool]
    ));
    const buildTools = vi.fn((_cwd, customTools) => ({
      tools: [],
      customTools,
    }));
    const deps = {
      ...makeDeps(agent),
      buildTools,
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-master-tools.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => mgrPath },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await manager.executeExternalMessage("hello", "bridge-k-master-tools", null, { agentId: "agent-a" });

    expect(agent.getToolsSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      forceMemoryEnabled: true,
      surface: "bridge",
    }));
    expect(buildTools.mock.calls[0][1].map((tool) => tool.name)).toEqual([
      "plain_custom",
      "search_memory",
    ]);
    expect(createAgentSessionMock.mock.calls[0][0].customTools.map((tool) => tool.name)).toContain("search_memory");
  });

  it("owner bridge sessions default to auto permission mode when bridge read-only is off", async () => {
    const agent = makeAgent(rootDir);
    const buildTools = vi.fn(() => ({
      tools: [],
      customTools: [],
    }));
    const deps = {
      ...makeDeps(agent),
      getPreferences: () => ({ thinking_level: "medium", bridge: { readOnly: false } }),
      buildTools,
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-permission.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => mgrPath },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await manager.executeExternalMessage("hello", "bridge-k-permission", null, { agentId: "agent-a" });

    expect(buildTools).toHaveBeenCalledOnce();
    const buildOpts = (buildTools.mock.calls[0] as any)[2];
    expect(buildOpts!.getPermissionMode()).toBe("auto");
  });

  it("owner bridge sessions honor explicit bridge auto permission mode", async () => {
    const agent = makeAgent(rootDir);
    const buildTools = vi.fn(() => ({
      tools: [],
      customTools: [],
    }));
    const deps = {
      ...makeDeps(agent),
      getPreferences: () => ({ thinking_level: "medium", bridge: { permissionMode: "auto", readOnly: true } }),
      buildTools,
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-permission-auto.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => mgrPath },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await manager.executeExternalMessage("hello", "bridge-k-permission-auto", null, { agentId: "agent-a" });

    expect(buildTools).toHaveBeenCalledOnce();
    const buildOpts = (buildTools.mock.calls[0] as any)[2];
    expect(buildOpts!.getPermissionMode()).toBe("auto");
  });

  it("owner bridge tools expose the bridge session path instead of relying on desktop focus", async () => {
    const agent = makeAgent(rootDir);
    const buildTools = vi.fn(() => ({
      tools: [],
      customTools: [],
    }));
    const deps = {
      ...makeDeps(agent),
      buildTools,
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-owner-tools.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => mgrPath },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await manager.executeExternalMessage("hello", "bridge-k-owner-tools", null, { agentId: "agent-a" });

    expect(buildTools).toHaveBeenCalledOnce();
    const buildOpts = (buildTools.mock.calls[0] as any)[2];
    expect(buildOpts!.runtimeSessionRef).toEqual({
      sessionId: "sess_s-owner-tools",
      sessionPath: mgrPath,
    });
    expect(buildOpts!.requireSessionIdentity).toBe(true);
  });

  it("guest bridge sessions pass canonical off thinking level to the SDK", async () => {
    const agent = makeAgent(rootDir);
    agent.config.models.chat = { id: "minimax-m2.5", provider: "scnet" };
    const deps = {
      ...makeDeps(agent),
      getModelManager: () => ({
        availableModels: [{
          id: "minimax-m2.5",
          provider: "scnet",
          name: "MiniMax M2.5",
          api: "openai-completions",
          baseUrl: "https://example.test/v1",
          reasoning: true,
        }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "guests", "guest-thinking.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => mgrPath },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await manager.executeExternalMessage("hello", "fs_group_guest@agent-a", {
      userId: "guest-user",
      chatId: "guest-chat",
    }, { agentId: "agent-a", guest: true });

    const createArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(createArgs.thinkingLevel).toBe("off");
    expect(createArgs.tools).toEqual([]);
    expect(createArgs.customTools).toEqual([]);
  });

  it("owner bridge read-only sessions pass read-only permission mode to tool wrappers", async () => {
    const agent = makeAgent(rootDir);
    const buildTools = vi.fn(() => ({
      tools: [],
      customTools: [],
    }));
    const deps = {
      ...makeDeps(agent),
      getPreferences: () => ({ thinking_level: "medium", bridge: { readOnly: true } }),
      buildTools,
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-read-only.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => mgrPath },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await manager.executeExternalMessage("hello", "bridge-k-read-only", null, { agentId: "agent-a" });

    expect(buildTools).toHaveBeenCalledOnce();
    const buildOpts = (buildTools.mock.calls[0] as any)[2];
    expect(buildOpts!.getPermissionMode()).toBe("read_only");
  });

  it("owner bridge read-only sessions keep full schema and rely on permission wrappers", async () => {
    const agent = makeAgent(rootDir);
    agent.tools = [{ name: "search_memory" }, { name: "record_experience" }];
    const buildTools = vi.fn((_cwd, customTools) => ({
      tools: [{ name: "read" }, { name: "write" }],
      customTools,
    }));
    const deps = {
      ...makeDeps(agent),
      getPreferences: () => ({ thinking_level: "medium", bridge: { readOnly: true } }),
      buildTools,
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-read-only-full-tools.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => mgrPath },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await manager.executeExternalMessage("hello", "bridge-k-read-only-full-tools", null, { agentId: "agent-a" });

    const createArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(createArgs.tools.map((tool) => tool.name)).toEqual(["read", "write"]);
    expect(createArgs.customTools.map((tool) => tool.name)).toEqual([
      "search_memory",
      "record_experience",
    ]);
  });

  it("owner bridge text-only model prepares images through the vision bridge", async () => {
    const agent = makeAgent(rootDir);
    const visionBridge = {
      prepare: vi.fn(async ({ text }) => ({ text, images: undefined })),
      injectNotes: vi.fn(() => ({ injected: 0 })),
    };
    const deps = {
      ...makeDeps(agent),
      getVisionBridge: () => visionBridge,
      isVisionAuxiliaryEnabled: () => true,
      getModelManager: () => ({
        availableModels: [{ id: "gpt-4o", provider: "openai", name: "GPT-4o", input: ["text"] }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-vision.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = {
      model: { id: "gpt-4o", provider: "openai", input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });
    const images = [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }];

    await manager.executeExternalMessage("hello", "bridge-k-vision", null, {
      agentId: "agent-a",
      images,
      imageAttachmentPaths: ["/tmp/upload.png"],
    });

    expect(visionBridge.prepare).toHaveBeenCalledWith(expect.objectContaining({
      targetModel: expect.objectContaining({ input: ["text"] }),
      text: "hello",
      images,
      imageAttachmentPaths: ["/tmp/upload.png"],
    }));
    expect(session.prompt).toHaveBeenCalledWith("hello", undefined);
  });

  it("bridge vision context injection uses captured Hana refs when Pi context is stale", async () => {
    const agent = makeAgent(rootDir);
    const sessionFile = path.join(agent.sessionDir, "bridge", "owner", "s-vision-restore.jsonl");
    const imagePath = path.join(rootDir, "bridge-upload.png");
    const textOnlyModel = { id: "gpt-4o", provider: "openai", name: "GPT-4o", input: ["text"] };
    const callText = vi.fn(async () => [
      "image_overview: A bridge image with a red alert.",
      "user_request_answer: The alert is the important visual context.",
      "evidence: red alert.",
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
    const deps = {
      ...makeDeps(agent),
      getVisionBridge: () => visionBridge,
      isVisionAuxiliaryEnabled: () => true,
      getModelManager: () => ({
        availableModels: [textOnlyModel],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
    };
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });

    let injectedText = "";
    const session = {
      model: textOnlyModel,
      prompt: vi.fn(async () => {
        const resourceLoader = createAgentSessionMock.mock.calls.at(-1)[0].resourceLoader;
        const extension = resourceLoader.getExtensions().extensions
          .find((entry) => entry.path === "hana-vision-context-injection");
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
        injectedText = result.messages[0].content[0].text;
      }),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("what is this?", "bridge-k-vision-restore", null, { agentId: "agent-a" });

    expect(injectedText).toContain(VISION_CONTEXT_START);
    expect(injectedText).toContain("image_overview");
  });

  it("compactSession 的临时 owner session 结束后也会 shutdown + dispose", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const sessionFile = path.join(bridgeDir, "owner", "s1.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    manager.writeIndex({ "bridge-k2": { file: "owner/s1.jsonl" } }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const callOrder = [];
    const session = {
      isCompacting: false,
      compact: vi.fn(async () => {}),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: vi.fn()
        .mockReturnValueOnce({ tokens: 900, contextWindow: 128000 })
        .mockReturnValueOnce({ tokens: 300, contextWindow: 128000 }),
      dispose: vi.fn(() => { callOrder.push("dispose"); }),
      extensionRunner: {
        hasHandlers: vi.fn(() => true),
        emit: vi.fn(async () => { callOrder.push("emit"); }),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const result = await manager.compactSession("bridge-k2", { agentId: "agent-a" });

    expect(result).toEqual({ tokensBefore: 900, tokensAfter: 300, contextWindow: 128000 });
    expect(callOrder).toEqual(["emit", "dispose"]);
    expect(emitSessionShutdownMock).toHaveBeenCalledWith(session);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("compactSession 创建后的实际 locator 与 SessionRef 不一致时显式失败并释放 session", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const sessionFile = path.join(bridgeDir, "owner", "identity.jsonl");
    const runtimeFile = path.join(bridgeDir, "owner", "runtime.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    manager.writeIndex({ "bridge-locator-conflict": { file: "owner/identity.jsonl" } }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const session = {
      sessionManager: { getSessionFile: () => runtimeFile },
      dispose: vi.fn(),
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await expect(
      manager.compactSession("bridge-locator-conflict", { agentId: "agent-a" }),
    ).rejects.toMatchObject({ code: "session_identity_conflict" });

    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("open 旧 bridge session 失败后，会把索引自愈到新建文件并保留元数据", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const stalePath = path.join(bridgeDir, "owner", "stale.jsonl");
    const freshPath = path.join(bridgeDir, "owner", "fresh.jsonl");
    manager.writeIndex({
      "bridge-k3": { file: "owner/stale.jsonl", name: "Alice", userId: "u-1" },
    }, agent);

    sessionManagerOpenMock.mockImplementation(() => {
      throw new Error(`cannot open ${stalePath}`);
    });
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => freshPath });

    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => freshPath },
      extensionRunner: {
        hasHandlers: vi.fn(() => false),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await manager.executeExternalMessage("hello", "bridge-k3", null, { agentId: "agent-a" });
    } finally {
      warnSpy.mockRestore();
    }

    expect(sessionManagerOpenMock).toHaveBeenCalledOnce();
    expect(sessionManagerCreateMock).toHaveBeenCalledOnce();
    expect(manager.readIndex(agent)["bridge-k3"]).toMatchObject({
      file: "owner/fresh.jsonl",
      name: "Alice",
      userId: "u-1",
    });
  });

  it("explicit unresolved agentId errors instead of falling back to focus agent", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));

    await expect(
      manager.executeExternalMessage("hello", "bridge-missing", null, { agentId: "missing-agent" }),
    ).resolves.toMatchObject({
      text: null,
      error: expect.stringMatching(/agent "missing-agent" not found/),
      truncated: false,
    });
    expect(() => manager.injectMessage("bridge-missing", "note", { agentId: "missing-agent" }))
      .toThrow(/agent "missing-agent" not found/);
    await expect(
      manager.compactSession("bridge-missing", { agentId: "missing-agent" }),
    ).rejects.toThrow(/agent "missing-agent" not found/);
    expect(sessionManagerCreateMock).not.toHaveBeenCalled();
    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
  });

  it("recordAssistantMessage creates an owner bridge session when requested", () => {
    const agent = makeAgent(rootDir);
    const deps = makeDeps(agent);
    const manager = new BridgeSessionManager(deps);
    const sessionPath = path.join(agent.sessionDir, "bridge", "owner", "proactive.jsonl");
    const appendMessage = vi.fn();
    sessionManagerCreateMock.mockReturnValue({
      getSessionFile: () => sessionPath,
      appendMessage,
    });

    const recorded = manager.recordAssistantMessage(
      "wx_dm_owner@agent-a",
      "AI 日报\n\n今天有三条新闻。",
      {
        agentId: "agent-a",
        createIfMissing: true,
        meta: { userId: "owner", chatId: "owner", name: "Owner" },
      },
    );

    expect(recorded).toBe(true);
    expect(sessionManagerCreateMock).toHaveBeenCalledWith(
      rootCwd,
      path.join(agent.sessionDir, "bridge", "owner"),
    );
    expect(deps.ensureSessionRefForPath).toHaveBeenCalledWith(
      sessionPath,
      expect.objectContaining({
        ownerAgentId: "agent-a",
        domain: "bridge",
        kind: "bridge_owner",
      }),
    );
    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: "assistant",
      content: [{ type: "text", text: "AI 日报\n\n今天有三条新闻。" }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o",
      stopReason: "stop",
      timestamp: expect.any(Number),
      usage: expect.objectContaining({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: expect.objectContaining({ total: 0 }),
      }),
    }));
    expect(manager.readIndex(agent)["wx_dm_owner@agent-a"]).toMatchObject({
      file: "owner/proactive.jsonl",
      userId: "owner",
      chatId: "owner",
      name: "Owner",
    });
  });

  it("reconcile cleans bridge indexes for every agent, not just focus agent", () => {
    const focusAgent = makeAgent(path.join(rootDir, "focus"), "focus");
    const otherAgent = makeAgent(path.join(rootDir, "other"), "other");
    const deps = {
      ...makeDeps(focusAgent),
      getAgents: () => new Map([
        [focusAgent.id, focusAgent],
        [otherAgent.id, otherAgent],
      ]),
    };
    const manager = new BridgeSessionManager(deps);

    manager.writeIndex({ "focus-k": { file: "owner/missing-focus.jsonl", name: "Focus" } }, focusAgent);
    manager.writeIndex({ "other-k": { file: "owner/missing-other.jsonl", name: "Other" } }, otherAgent);

    manager.reconcile();

    expect(manager.readIndex(focusAgent)["focus-k"]).toEqual({ name: "Focus" });
    expect(manager.readIndex(otherAgent)["other-k"]).toEqual({ name: "Other" });
  });
});
