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
  };
});

import { runAgentSession, runAgentPhoneSession } from "../hub/agent-executor.ts";
import { getAgentPhoneProjectionPath, readAgentPhoneProjection, updateAgentPhoneProjectionMeta } from "../lib/conversations/agent-phone-projection.ts";
import { readAgentPhoneRuntime, updateAgentPhoneRuntime } from "../lib/conversations/agent-phone-runtime.ts";
import { getAgentPhoneSessionDir } from "../lib/conversations/agent-phone-session.ts";

let rootDir;

function makeAgent(root) {
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    id: "agent-a",
    agentDir,
    tools: [],
    personality: "personality",
    systemPrompt: "system prompt",
    config: {
      locale: "",
      workspace_context: {},
      models: { chat: { id: "gpt-4o", provider: "openai" } },
    },
  };
}

function makeEngine(agent, cwd) {
  const ensureSessionRefForPath = vi.fn((sessionPath, defaults = {}) => ({
    sessionId: `sess_${path.basename(sessionPath, path.extname(sessionPath))}`,
    sessionPath,
    defaults,
  }));
  return {
    getAgent: (id) => (id === agent.id ? agent : null),
    getHomeCwd: () => cwd,
    ensureSessionRefForPath,
    tombstoneSessionRef: vi.fn(),
    createSessionContext: () => ({
      resourceLoader: {},
      getSkillsForAgent: () => ({ skills: [], diagnostics: [] }),
      buildTools: (_cwd, customTools = [], opts: any = {}) => ({
        tools: [],
        customTools: [...customTools, ...(opts.extraCustomTools || [])],
      }),
      resolveModel: () => ({ id: "gpt-4o", provider: "openai", name: "GPT-4o" }),
      authStorage: {},
      modelRegistry: {},
    }),
  };
}

describe("runAgentSession teardown", () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-executor-teardown-"));
    createAgentSessionMock.mockReset();
    sessionManagerCreateMock.mockReset();
    sessionManagerOpenMock.mockReset();
    emitSessionShutdownMock.mockClear();
    vi.useRealTimers();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("hub 临时 session 结束后走 emit -> unsub -> dispose", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    const engine = makeEngine(agent, cwd);
    const sessionFile = path.join(agent.agentDir, "sessions", "temp", "s1.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const callOrder = [];
    const session = {
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => { callOrder.push("unsub"); }),
      dispose: vi.fn(() => { callOrder.push("dispose"); }),
      sessionManager: { getSessionFile: () => sessionFile },
      extensionRunner: {
        hasHandlers: vi.fn(() => true),
        emit: vi.fn(async () => { callOrder.push("emit"); }),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await runAgentSession("agent-a", [{ text: "hello", capture: true }], { engine });

    expect(engine.ensureSessionRefForPath).toHaveBeenCalledWith(
      sessionFile,
      expect.objectContaining({
        ownerAgentId: "agent-a",
        domain: "activity",
        kind: "hub_temporary",
      }),
    );
    expect(engine.tombstoneSessionRef).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess_s1", sessionPath: sessionFile }),
      "hub_temporary_cleanup",
    );
    expect(callOrder).toEqual(["emit", "unsub", "dispose"]);
    expect(emitSessionShutdownMock).toHaveBeenCalledWith(session);
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it("hub 临时 session 的 tombstone 失败仍会删除 JSONL 并显式报错", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    const engine = makeEngine(agent, cwd);
    engine.tombstoneSessionRef.mockImplementation(() => {
      throw new Error("manifest tombstone failed");
    });
    const sessionFile = path.join(agent.agentDir, "sessions", "temp", "s-tombstone-fail.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const session = {
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await expect(
      runAgentSession("agent-a", [{ text: "hello", capture: true }], { engine }),
    ).rejects.toThrow("manifest tombstone failed");

    expect(session.dispose).toHaveBeenCalledOnce();
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it("hub 临时 session tools follow the master memory switch instead of session memory state", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    (agent as any).memoryMasterEnabled = true;
    const plainTool = { name: "plain_custom" };
    const memoryTool = { name: "search_memory" };
    agent.tools = [plainTool];
    (agent as any).getToolsSnapshot = vi.fn(({ forceMemoryEnabled }: any = {}) => (
      forceMemoryEnabled ? [plainTool, memoryTool] : [plainTool]
    ));

    const buildTools = vi.fn((_cwd, customTools) => ({
      tools: [],
      customTools,
    }));
    const engine = {
      ...makeEngine(agent, cwd),
      createSessionContext: () => ({
        resourceLoader: {},
        getSkillsForAgent: () => ({ skills: [], diagnostics: [] }),
        buildTools,
        resolveModel: () => ({ id: "gpt-4o", provider: "openai", name: "GPT-4o" }),
        authStorage: {},
        modelRegistry: {},
      }),
    };
    const sessionFile = path.join(agent.agentDir, "sessions", "temp", "s-master-tools.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });
    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => sessionFile },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await runAgentSession("agent-a", [{ text: "hello", capture: true }], { engine });

    expect((agent as any).getToolsSnapshot).toHaveBeenCalledWith({ forceMemoryEnabled: true });
    expect(buildTools.mock.calls[0][1].map((tool) => tool.name)).toEqual([
      "plain_custom",
      "search_memory",
    ]);
    expect((buildTools.mock.calls[0] as any)[2].runtimeSessionRef).toMatchObject({
      sessionId: "sess_s-master-tools",
      sessionPath: sessionFile,
    });
    expect((buildTools.mock.calls[0] as any)[2].requireSessionIdentity).toBe(true);
    expect(createAgentSessionMock.mock.calls[0][0].customTools.map((tool) => tool.name)).toContain("search_memory");
  });

  it("hub read-only temp sessions keep full schema and enforce read-only at execution time", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    agent.tools = [{ name: "search_memory" }, { name: "record_experience" }];

    const buildTools = vi.fn((_cwd, customTools, opts: any = {}) => ({
      tools: [{ name: "read" }, { name: "write" }],
      customTools: [...customTools, ...(opts.extraCustomTools || [])],
    }));
    const engine = {
      ...makeEngine(agent, cwd),
      createSessionContext: () => ({
        resourceLoader: {},
        getSkillsForAgent: () => ({ skills: [], diagnostics: [] }),
        buildTools,
        resolveModel: () => ({ id: "gpt-4o", provider: "openai", name: "GPT-4o" }),
        authStorage: {},
        modelRegistry: {},
      }),
    };
    const sessionFile = path.join(agent.agentDir, "sessions", "temp", "s-read-only-tools.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });
    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => sessionFile },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await runAgentSession("agent-a", [{ text: "hello", capture: true }], { engine, readOnly: true });

    const buildOpts = (buildTools.mock.calls[0] as any)[2];
    expect(buildOpts!.getPermissionMode()).toBe("read_only");
    expect(buildOpts!.runtimeSessionRef).toMatchObject({
      sessionId: "sess_s-read-only-tools",
      sessionPath: sessionFile,
    });
    expect(buildOpts!.requireSessionIdentity).toBe(true);
    expect(createAgentSessionMock.mock.calls[0][0].tools.map((tool) => tool.name)).toEqual([
      "read",
      "write",
    ]);
    expect(createAgentSessionMock.mock.calls[0][0].customTools.map((tool) => tool.name)).toEqual([
      "search_memory",
      "record_experience",
    ]);
  });

  it("phone session exposes its session path and mirrors live stream events", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    const emitEvent = vi.fn();
    const engine = {
      ...makeEngine(agent, cwd),
      emitEvent,
    };
    const sessionFile = path.join(agent.agentDir, "phone", "sessions", "ch_crew", "phone.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });

    let subscriber = null;
    const session = {
      prompt: vi.fn(async () => {
        subscriber?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "hi" },
        });
        subscriber?.({ type: "turn_end" });
      }),
      subscribe: vi.fn((cb) => {
        subscriber = cb;
        return () => {};
      }),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: vi.fn(() => ({ tokens: 10, contextWindow: 200000 })),
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });
    const onSessionReady = vi.fn();

    const text = await runAgentPhoneSession("agent-a", [{ text: "hello", capture: true }], {
      engine,
      conversationId: "ch_crew",
      conversationType: "channel",
      emitEvents: true,
      onSessionReady,
    });

    expect(text).toBe("hi");
    expect(engine.ensureSessionRefForPath).toHaveBeenCalledWith(
      sessionFile,
      expect.objectContaining({
        ownerAgentId: "agent-a",
        domain: "phone",
        kind: "phone_conversation",
        provenance: expect.objectContaining({
          conversationId: "ch_crew",
          conversationType: "channel",
        }),
      }),
    );
    expect(onSessionReady).toHaveBeenCalledWith(sessionFile);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message_update",
        isolated: true,
      }),
      sessionFile,
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn_end", isolated: true }),
      sessionFile,
    );
    expect(fs.existsSync(sessionFile)).toBe(true);
  });

  it("phone session locator 校验失败时仍释放已创建的 SDK session", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    const engine = makeEngine(agent, cwd);
    const identityFile = path.join(agent.agentDir, "phone", "sessions", "ch_locator", "identity.jsonl");
    const runtimeFile = path.join(agent.agentDir, "phone", "sessions", "ch_locator", "runtime.jsonl");
    fs.mkdirSync(path.dirname(identityFile), { recursive: true });
    fs.writeFileSync(identityFile, "", "utf-8");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => identityFile });

    const session = {
      setActiveToolsByName: vi.fn(),
      sessionManager: { getSessionFile: () => runtimeFile },
      dispose: vi.fn(),
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await expect(
      runAgentPhoneSession("agent-a", [{ text: "hello", capture: true }], {
        engine,
        conversationId: "ch_locator",
      }),
    ).rejects.toMatchObject({ code: "session_identity_conflict" });

    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("phone runtime metadata 写入失败时注销 abort handler 并释放 SDK session", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    const unregisterPhoneAbort = vi.fn();
    const registerAgentPhoneAbortHandler = vi.fn(() => unregisterPhoneAbort);
    const engine = {
      ...makeEngine(agent, cwd),
      registerAgentPhoneAbortHandler,
    };
    const sessionFile = path.join(agent.agentDir, "phone", "sessions", "ch_metadata", "phone.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const session = {
      setActiveToolsByName: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      dispose: vi.fn(),
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });
    const renameSpy = vi.spyOn(fs.promises, "rename")
      .mockRejectedValueOnce(new Error("runtime metadata failed"));

    try {
      await expect(
        runAgentPhoneSession("agent-a", [{ text: "hello", capture: true }], {
          engine,
          conversationId: "ch_metadata",
        }),
      ).rejects.toThrow("runtime metadata failed");
    } finally {
      renameSpy.mockRestore();
    }

    expect(registerAgentPhoneAbortHandler).toHaveBeenCalledOnce();
    expect(unregisterPhoneAbort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("phone session can return diagnostics without changing the default text contract", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    const sessionFile = path.join(agent.agentDir, "phone", "sessions", "ch_crew", "phone-diagnostics.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });

    let subscriber = null;
    const session = {
      prompt: vi.fn(async () => {
        subscriber?.({ type: "tool_execution_start", toolName: "channel_reply" });
        subscriber?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "raw text" },
        });
        return { stopReason: "end_turn" };
      }),
      subscribe: vi.fn((cb) => {
        subscriber = cb;
        return () => {};
      }),
      dispose: vi.fn(),
      setActiveToolsByName: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: vi.fn(() => ({ tokens: 10, contextWindow: 200000 })),
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const result = await runAgentPhoneSession("agent-a", [{ text: "hello", capture: true }], {
      engine: makeEngine(agent, cwd),
      conversationId: "ch_crew",
      conversationType: "channel",
      extraCustomTools: [{ name: "channel_reply", execute: vi.fn() }],
      returnDiagnostics: true,
    });

    expect(result).toMatchObject({
      text: "raw text",
      diagnostics: {
        activeToolNames: ["channel_reply"],
        toolCallCount: 1,
        toolCallNames: ["channel_reply"],
        ordinaryTextLength: 8,
        rawTextLength: 8,
        stopReason: "end_turn",
      },
    });
  });

  it("phone session appends channel-scoped custom tools after applying phone tool policy", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    agent.tools = [{ name: "channel" }, { name: "search_memory" }, { name: "record_experience" }];
    (agent as any).getToolsSnapshot = vi.fn(() => agent.tools);

    const buildTools = vi.fn((_cwd, customTools, opts: any = {}) => ({
      tools: [{ name: "read" }, { name: "write" }],
      customTools: [...customTools, ...(opts.extraCustomTools || [])],
    }));
    const engine = {
      ...makeEngine(agent, cwd),
      createSessionContext: () => ({
        resourceLoader: {},
        getSkillsForAgent: () => ({ skills: [], diagnostics: [] }),
        buildTools,
        resolveModel: () => ({ id: "gpt-4o", provider: "openai", name: "GPT-4o" }),
        authStorage: {},
        modelRegistry: {},
      }),
    };
    const sessionFile = path.join(agent.agentDir, "phone", "sessions", "ch_crew", "phone-tools.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });
    const setActiveToolsByName = vi.fn();
    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        setActiveToolsByName,
        sessionManager: { getSessionFile: () => sessionFile },
        getContextUsage: vi.fn(() => ({ tokens: 10, contextWindow: 200000 })),
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await runAgentPhoneSession("agent-a", [{ text: "hello", capture: true }], {
      engine,
      conversationId: "ch_crew",
      conversationType: "channel",
      toolMode: "read_only",
      extraCustomTools: [
        {
          name: "channel_reply",
          sessionPermission: {
            resolveInvocation: () => ({
              action: "post",
              kind: "routine",
              capability: "channel_reply.post",
            }),
          },
          execute: vi.fn(),
        },
        {
          name: "channel_pass",
          sessionPermission: {
            resolveInvocation: () => ({
              action: "decide",
              kind: "routine",
              capability: "channel_pass.decide",
            }),
          },
          execute: vi.fn(),
        },
      ],
    });

    const buildOpts = (buildTools.mock.calls[0] as any)[2];
    expect(buildOpts!.getPermissionMode()).toBe("read_only");
    expect(buildOpts!.runtimeSessionRef).toMatchObject({
      sessionId: "sess_phone-tools",
      sessionPath: sessionFile,
    });
    expect(buildOpts!.requireSessionIdentity).toBe(true);
    expect(createAgentSessionMock.mock.calls[0][0].tools.map((tool) => tool.name)).toEqual([
      "read",
      "write",
    ]);
    expect(createAgentSessionMock.mock.calls[0][0].customTools.map((tool) => tool.name)).toEqual([
      "search_memory",
      "record_experience",
      "channel_reply",
      "channel_pass",
    ]);
    const sessionCustomTools = createAgentSessionMock.mock.calls[0][0].customTools;
    expect(sessionCustomTools.find((tool) => tool.name === "channel_reply")
      .sessionPermission.resolveInvocation()).toMatchObject({
      kind: "routine",
      capability: "channel_reply.post",
    });
    expect(sessionCustomTools.find((tool) => tool.name === "channel_pass")
      .sessionPermission.resolveInvocation()).toMatchObject({
      kind: "routine",
      capability: "channel_pass.decide",
    });
    expect(setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "write",
      "search_memory",
      "record_experience",
      "channel_reply",
      "channel_pass",
    ]);
  });

  it("phone sessions recompute active tools instead of reusing stored projection toolNames", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    agent.tools = [{ name: "channel" }, { name: "search_memory" }, { name: "record_experience" }, { name: "web_fetch" }];
    (agent as any).getToolsSnapshot = vi.fn(() => agent.tools);

    const buildTools = vi.fn((_cwd, customTools, opts: any = {}) => ({
      tools: [{ name: "read" }, { name: "write" }],
      customTools: [...customTools, ...(opts.extraCustomTools || [])],
    }));
    const engine = {
      ...makeEngine(agent, cwd),
      createSessionContext: () => ({
        resourceLoader: {},
        getSkillsForAgent: () => ({ skills: [], diagnostics: [] }),
        buildTools,
        resolveModel: () => ({ id: "gpt-4o", provider: "openai", name: "GPT-4o" }),
        authStorage: {},
        modelRegistry: {},
      }),
    };
    const sessionFile = path.join(agent.agentDir, "phone", "sessions", "ch_crew", "phone-tools.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    await updateAgentPhoneProjectionMeta({
      agentDir: agent.agentDir,
      agentId: "agent-a",
      conversationId: "ch_crew",
      conversationType: "channel",
      patch: {
        phoneSessionFile: path.relative(agent.agentDir, sessionFile).split(path.sep).join("/"),
        lastPhoneSessionUsedAt: "2026-05-25T11:55:00.000Z",
        toolNames: ["read", "write", "search_memory"],
      },
    });
    await updateAgentPhoneRuntime({
      agentDir: agent.agentDir,
      agentId: "agent-a",
      conversationId: "ch_crew",
      conversationType: "channel",
      patch: {
        phoneSessionFile: path.relative(agent.agentDir, sessionFile).split(path.sep).join("/"),
        lastPhoneSessionUsedAt: "2026-05-25T11:55:00.000Z",
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T12:00:00.000Z"));
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });
    const setActiveToolsByName = vi.fn();
    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        setActiveToolsByName,
        sessionManager: { getSessionFile: () => sessionFile },
        getContextUsage: vi.fn(() => ({ tokens: 10, contextWindow: 200000 })),
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await runAgentPhoneSession("agent-a", [{ text: "hello", capture: true }], {
      engine,
      conversationId: "ch_crew",
      conversationType: "channel",
      extraCustomTools: [
        { name: "channel_reply", execute: vi.fn() },
        { name: "channel_pass", execute: vi.fn() },
      ],
    });

    expect(createAgentSessionMock.mock.calls[0][0].tools.map((tool) => tool.name)).toEqual([
      "read",
      "write",
    ]);
    expect(createAgentSessionMock.mock.calls[0][0].customTools.map((tool) => tool.name)).toEqual([
      "search_memory",
      "record_experience",
      "web_fetch",
      "channel_reply",
      "channel_pass",
    ]);
    expect(setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "write",
      "search_memory",
      "record_experience",
      "web_fetch",
      "channel_reply",
      "channel_pass",
    ]);
  });

  it("registers a live phone abort handler and unregisters it after teardown", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    const sessionFile = path.join(agent.agentDir, "phone", "sessions", "dm_yui", "phone-abort.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });

    let abortHandler = null;
    let resolvePrompt = null;
    const unregister = vi.fn();
    const session = {
      abort: vi.fn(),
      prompt: vi.fn(() => new Promise((resolve) => { resolvePrompt = resolve; })),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: vi.fn(() => ({ tokens: 10, contextWindow: 200000 })),
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });
    const engine = {
      ...makeEngine(agent, cwd),
      registerAgentPhoneAbortHandler: vi.fn((handler) => {
        abortHandler = handler;
        return unregister;
      }),
    };

    const running = runAgentPhoneSession("agent-a", [{ text: "hello", capture: true }], {
      engine,
      conversationId: "dm:yui",
      conversationType: "dm",
    });
    await vi.waitFor(() => expect(engine.registerAgentPhoneAbortHandler).toHaveBeenCalledOnce());

    abortHandler?.("phone-disabled");
    expect(session.abort).toHaveBeenCalledOnce();

    resolvePrompt?.();
    await running;
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("phone session can use a channel-scoped model override without mutating the agent default", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    const agentDefaultModel = { id: "gpt-4o", provider: "openai", name: "GPT-4o" };
    const channelModel = { id: "deepseek-v4-flash", provider: "deepseek", name: "DeepSeek V4 Flash" };
    const resolveModel = vi.fn(() => agentDefaultModel);
    const engine = {
      ...makeEngine(agent, cwd),
      availableModels: [agentDefaultModel, channelModel],
      createSessionContext: () => ({
        resourceLoader: {},
        getSkillsForAgent: () => ({ skills: [], diagnostics: [] }),
        buildTools: () => ({ tools: [], customTools: [] }),
        resolveModel,
        authStorage: {},
        modelRegistry: {},
      }),
    };
    const sessionFile = path.join(agent.agentDir, "phone", "sessions", "ch_crew", "phone-model.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });
    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => sessionFile },
        getContextUsage: vi.fn(() => ({ tokens: 10, contextWindow: 200000 })),
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await runAgentPhoneSession("agent-a", [{ text: "hello", capture: true }], {
      engine,
      conversationId: "ch_crew",
      conversationType: "channel",
      modelOverride: { id: "deepseek-v4-flash", provider: "deepseek" },
    });

    expect(createAgentSessionMock.mock.calls[0][0].model).toBe(channelModel);
    const runtime = readAgentPhoneRuntime(agent.agentDir, "ch_crew");
    expect(runtime).toMatchObject({
      effectiveModel: {
        id: "deepseek-v4-flash",
        provider: "deepseek",
        name: "DeepSeek V4 Flash",
      },
      modelOverrideApplied: true,
      modelOverrideRequested: { id: "deepseek-v4-flash", provider: "deepseek" },
    });
    const projection = readAgentPhoneProjection(getAgentPhoneProjectionPath(agent.agentDir, "ch_crew"));
    expect((projection.meta as any).effectiveModel).toMatchObject({
      id: "deepseek-v4-flash",
      provider: "deepseek",
    });
    expect(agent.config.models.chat).toEqual({ id: "gpt-4o", provider: "openai" });
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it("records phone assistant usage with the actual override model attribution", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    const agentDefaultModel = { id: "gpt-4o", provider: "openai", name: "GPT-4o" };
    const channelModel = {
      id: "deepseek-v4-flash",
      provider: "deepseek",
      name: "DeepSeek V4 Flash",
      api: "openai-completions",
      cost: { input: 1, output: 2 },
    };
    const usageLedger = { record: vi.fn() };
    const engine = {
      ...makeEngine(agent, cwd),
      usageLedger,
      availableModels: [agentDefaultModel, channelModel],
      createSessionContext: () => ({
        resourceLoader: {},
        getSkillsForAgent: () => ({ skills: [], diagnostics: [] }),
        buildTools: () => ({ tools: [], customTools: [] }),
        resolveModel: () => agentDefaultModel,
        authStorage: {},
        modelRegistry: {},
      }),
    };
    const sessionFile = path.join(agent.agentDir, "phone", "sessions", "ch_crew", "phone-usage.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });
    let subscriber = null;
    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt: vi.fn(async () => {
          subscriber?.({
            type: "message_end",
            message: {
              role: "assistant",
              provider: "deepseek",
              model: "deepseek-v4-flash",
              usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
            },
          });
        }),
        subscribe: vi.fn((fn) => {
          subscriber = fn;
          return vi.fn();
        }),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => sessionFile },
        getContextUsage: vi.fn(() => ({ tokens: 10, contextWindow: 200000 })),
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await runAgentPhoneSession("agent-a", [{ text: "hello", capture: true }], {
      engine,
      conversationId: "ch_crew",
      conversationType: "channel",
      modelOverride: { id: "deepseek-v4-flash", provider: "deepseek" },
    });

    expect(usageLedger.record).toHaveBeenCalledWith(expect.objectContaining({
      model: {
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        api: "openai-completions",
      },
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      costRates: channelModel.cost,
      usageContext: {
        source: {
          subsystem: "session",
          operation: "phone_reply",
          surface: "channel",
          trigger: "delivery",
        },
        attribution: {
          kind: "phone",
          agentId: "agent-a",
          conversationId: "ch_crew",
          conversationType: "channel",
          sessionPath: sessionFile,
        },
      },
    }));
  });

  it("phone sessions persist and reuse their prompt snapshot", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    agent.config.locale = "en-US";
    agent.config.workspace_context = { inject_agents_md: true };
    fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "PHONE_WORKSPACE_INSTRUCTION\n", "utf-8");
    const engine = makeEngine(agent, cwd);
    const sessionFile = path.join(agent.agentDir, "phone", "sessions", "ch_crew", "phone-snapshot.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const makeSession = () => ({
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => sessionFile },
      getContextUsage: vi.fn(() => ({ tokens: 10, contextWindow: 200000 })),
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    });
    createAgentSessionMock
      .mockResolvedValueOnce({ session: makeSession() })
      .mockResolvedValueOnce({ session: makeSession() });

    await runAgentPhoneSession("agent-a", [{ text: "hello", capture: true }], {
      engine,
      conversationId: "ch_crew",
      conversationType: "channel",
    });
    let runtime = readAgentPhoneRuntime(agent.agentDir, "ch_crew");
    const snapshot = runtime.promptSnapshot;
    expect(snapshot?.systemPrompt).toBe("system prompt");
    expect(snapshot?.appendSystemPrompt.join("\n\n")).toContain(`Primary workbench: ${cwd}`);
    expect(snapshot?.appendSystemPrompt.join("\n\n")).toContain("PHONE_WORKSPACE_INSTRUCTION");
    expect(snapshot?.appendSystemPrompt.join("\n\n")).not.toContain("Current working directory");

    agent.systemPrompt = "system prompt v2";
    await runAgentPhoneSession("agent-a", [{ text: "hello again", capture: true }], {
      engine,
      conversationId: "ch_crew",
      conversationType: "channel",
    });
    const secondCreateArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(secondCreateArgs.resourceLoader.getSystemPrompt()).toBe("system prompt");
    expect(secondCreateArgs.resourceLoader.getAppendSystemPrompt()).toEqual(snapshot.appendSystemPrompt);
    runtime = readAgentPhoneRuntime(agent.agentDir, "ch_crew");
    expect(runtime.promptSnapshot.systemPrompt).toBe("system prompt");
  });

  it("starts a new phone session with the current prompt after the active window expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T10:00:00.000Z"));
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    agent.systemPrompt = "current system prompt";
    const engine = makeEngine(agent, cwd);

    const phoneSessionDir = getAgentPhoneSessionDir(agent.agentDir, "ch_crew");
    const oldSessionFile = path.join(phoneSessionDir, "old.jsonl");
    const newSessionFile = path.join(phoneSessionDir, "new.jsonl");
    fs.mkdirSync(path.dirname(oldSessionFile), { recursive: true });
    fs.writeFileSync(oldSessionFile, "old", "utf-8");
    await updateAgentPhoneRuntime({
      agentDir: agent.agentDir,
      agentId: "agent-a",
      conversationId: "ch_crew",
      conversationType: "channel",
      patch: {
        phoneSessionFile: path.relative(agent.agentDir, oldSessionFile).split(path.sep).join("/"),
        lastPhoneSessionUsedAt: "2026-05-12T09:00:00.000Z",
        promptSnapshot: { version: 1, systemPrompt: "stale system prompt" },
      },
    });

    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => newSessionFile });
    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => newSessionFile },
        getContextUsage: vi.fn(() => ({ tokens: 10, contextWindow: 200000 })),
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await runAgentPhoneSession("agent-a", [{ text: "hello", capture: true }], {
      engine,
      conversationId: "ch_crew",
      conversationType: "channel",
    });

    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
    expect(sessionManagerCreateMock).toHaveBeenCalledWith(cwd, phoneSessionDir);
    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("current system prompt");
  });

  it("phone replies leave regular compaction to the SDK auto-compaction path", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    const engine = makeEngine(agent, cwd);
    const sessionFile = path.join(agent.agentDir, "phone", "sessions", "ch_crew", "phone-auto-compact.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });
    const compact = vi.fn(async () => {});
    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => sessionFile },
        getContextUsage: vi.fn(() => ({ tokens: 200000, contextWindow: 272000 })),
        compact,
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await runAgentPhoneSession("agent-a", [{ text: "hello", capture: true }], {
      engine,
      conversationId: "ch_crew",
      conversationType: "channel",
    });

    expect(compact).not.toHaveBeenCalled();
  });

  it("starts a new phone session after the active window instead of fresh-compacting the old one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T10:00:00.000Z"));
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    const engine = makeEngine(agent, cwd);

    const phoneSessionDir = getAgentPhoneSessionDir(agent.agentDir, "ch_crew");
    const oldSessionFile = path.join(phoneSessionDir, "old.jsonl");
    const newSessionFile = path.join(phoneSessionDir, "new.jsonl");
    fs.mkdirSync(path.dirname(oldSessionFile), { recursive: true });
    fs.writeFileSync(oldSessionFile, "old", "utf-8");
    await updateAgentPhoneRuntime({
      agentDir: agent.agentDir,
      agentId: "agent-a",
      conversationId: "ch_crew",
      conversationType: "channel",
      patch: {
        phoneSessionFile: path.relative(agent.agentDir, oldSessionFile).split(path.sep).join("/"),
        lastPhoneSessionUsedAt: "2026-05-12T09:00:00.000Z",
      },
    });

    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => newSessionFile });
    const compact = vi.fn(async () => {});
    createAgentSessionMock.mockImplementation(async (options) => ({
      session: {
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: options.sessionManager,
        getContextUsage: vi.fn(() => ({ tokens: 130000, contextWindow: 200000 })),
        compact,
        extensionRunner: { hasHandlers: vi.fn(() => true), emit: vi.fn(async () => {}) },
      },
    }));

    await runAgentPhoneSession("agent-a", [{ text: "hello", capture: true }], {
      engine,
      conversationId: "ch_crew",
      conversationType: "channel",
    });

    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
    expect(sessionManagerCreateMock).toHaveBeenCalledWith(cwd, phoneSessionDir);
    expect(compact).not.toHaveBeenCalled();
    let runtime = readAgentPhoneRuntime(agent.agentDir, "ch_crew");
    expect(runtime.phoneSessionFile).toBe(path.relative(agent.agentDir, newSessionFile).split(path.sep).join("/"));
    expect(runtime.lastPhoneSessionUsedAt).toBe("2026-05-12T10:00:00.000Z");
    expect(runtime.lastFreshCompactDate).toBeUndefined();
    expect(fs.existsSync(oldSessionFile)).toBe(true);

    fs.writeFileSync(newSessionFile, "new", "utf-8");
    sessionManagerOpenMock.mockClear();
    sessionManagerCreateMock.mockClear();
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => newSessionFile });
    compact.mockClear();
    vi.setSystemTime(new Date("2026-05-12T10:10:00.000Z"));
    await runAgentPhoneSession("agent-a", [{ text: "hello again", capture: true }], {
      engine,
      conversationId: "ch_crew",
      conversationType: "channel",
    });

    expect(sessionManagerOpenMock).toHaveBeenCalledWith(newSessionFile, phoneSessionDir);
    expect(sessionManagerCreateMock).not.toHaveBeenCalled();
    runtime = readAgentPhoneRuntime(agent.agentDir, "ch_crew");
    expect(runtime.phoneSessionFile).toBe(path.relative(agent.agentDir, newSessionFile).split(path.sep).join("/"));
    expect(runtime.lastPhoneSessionUsedAt).toBe("2026-05-12T10:10:00.000Z");
    expect(compact).not.toHaveBeenCalled();
  });
});
