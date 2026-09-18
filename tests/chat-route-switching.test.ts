import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DISCONNECT_ABORT_GRACE_MS,
  createChatRoute,
  resolveDisconnectAbortGraceMs,
} from "../server/routes/chat.ts";
import { TURN_INPUT_CONSUMPTION_EVENT_TYPE } from "../lib/turn-input-presentation.ts";

describe("chat route model switch guard", () => {
  it("uses a minute-scale default WS disconnect abort grace and allows disabling it", () => {
    expect(DEFAULT_DISCONNECT_ABORT_GRACE_MS).toBeGreaterThanOrEqual(60_000);
    expect(resolveDisconnectAbortGraceMs(undefined)).toBe(DEFAULT_DISCONNECT_ABORT_GRACE_MS);
    expect(resolveDisconnectAbortGraceMs("0")).toBe(0);
    expect(resolveDisconnectAbortGraceMs("45000")).toBe(45_000);
    expect(resolveDisconnectAbortGraceMs("-1")).toBe(DEFAULT_DISCONNECT_ABORT_GRACE_MS);
    expect(resolveDisconnectAbortGraceMs("bad")).toBe(DEFAULT_DISCONNECT_ABORT_GRACE_MS);
  });

  it("adds persisted user and assistant entry ids to turn_end", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const sessionPath = "/tmp/persisted-turn.jsonl";
    const branch = [
      { type: "message", id: "entry-user", parentId: null, message: { role: "user", content: "hello" } },
      { type: "message", id: "entry-assistant", parentId: "entry-user", message: { role: "assistant", content: "hi" } },
    ];
    const hub = {
      subscribe: vi.fn((fn) => { subscriber = fn; }),
      send: vi.fn(async () => {}),
      eventBus: { emit: vi.fn() },
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({
        entries: [],
        sessionManager: { getBranch: () => branch },
      })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);
    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }, sessionPath);
    subscriber?.({ type: "turn_end" }, sessionPath);

    const turnEnd = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find((payload) => payload.type === "turn_end");
    expect(turnEnd).toMatchObject({
      sessionPath,
      turnInputEntryId: "entry-user",
      userEntryId: "entry-user",
      assistantEntryId: "entry-assistant",
    });
  });

  it("broadcasts entry ids on an aborted turn_end without a false empty-reply error", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const sessionPath = "/tmp/aborted-turn.jsonl";
    const branch = [
      { type: "message", id: "entry-user", parentId: null, message: { role: "user", content: "hello" } },
    ];
    const hub = {
      subscribe: vi.fn((fn) => { subscriber = fn; }),
      send: vi.fn(async () => {}),
      eventBus: { emit: vi.fn() },
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({
        entries: [],
        sessionManager: { getBranch: () => branch },
      })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);
    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({ type: "turn_end", aborted: true }, sessionPath);

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const turnEnd = payloads.find((payload) => payload.type === "turn_end");
    expect(turnEnd).toMatchObject({
      sessionPath,
      turnInputEntryId: "entry-user",
      userEntryId: "entry-user",
      assistantEntryId: null,
    });
    expect(payloads.find((payload) => payload.type === "error")).toBeUndefined();
  });

  it("does not count a length-limited thinking-only reply as a normal success", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const sessionPath = "/tmp/thinking-only-length.jsonl";
    const hub = {
      subscribe: vi.fn((fn) => { subscriber = fn; }),
      send: vi.fn(async () => {}),
      eventBus: { emit: vi.fn() },
    };
    const deliverNotification = vi.fn(async () => ({ ok: true }));
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getNotificationPreferences: vi.fn(() => ({ chatCompletion: "always" })),
      getSessionIdForPath: vi.fn(() => "session-thinking-only"),
      getSessionManifest: vi.fn(() => ({
        sessionId: "session-thinking-only",
        ownerAgentId: "agent-1",
        domain: "desktop",
        kind: "chat",
      })),
      deliverNotification,
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta: "still reasoning" },
    }, sessionPath);
    subscriber?.({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "still reasoning" }], stopReason: "length" },
    }, sessionPath);
    subscriber?.({ type: "turn_end" }, sessionPath);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads.some((payload) => payload.type === "error")).toBe(true);
    expect(payloads.find((payload) => payload.type === "turn_end")).toMatchObject({
      truncated: true,
      stopReason: "length",
    });
    expect(deliverNotification).not.toHaveBeenCalled();
    handlers.onClose({}, ws);
  });

  it("marks a visible partial reply as truncated without adding a generic error", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const sessionPath = "/tmp/partial-length.jsonl";
    const hub = {
      subscribe: vi.fn((fn) => { subscriber = fn; }),
      send: vi.fn(async () => {}),
      eventBus: { emit: vi.fn() },
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "visible partial reply" },
    }, sessionPath);
    subscriber?.({
      type: "message_end",
      message: { role: "assistant", content: "visible partial reply", stopReason: "length" },
    }, sessionPath);
    subscriber?.({ type: "turn_end" }, sessionPath);

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads.some((payload) => payload.type === "error")).toBe(false);
    expect(payloads.find((payload) => payload.type === "turn_end")).toMatchObject({
      truncated: true,
      stopReason: "length",
    });
    handlers.onClose({}, ws);
  });

  it("does not re-log a previous turn's usage on an aborted turn_end", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const sessionPath = "/tmp/aborted-turn-usage.jsonl";
    const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };
    const previousAssistant = {
      type: "message",
      id: "entry-assistant-prev",
      parentId: "entry-user-prev",
      message: { role: "assistant", content: "hi", usage },
    };
    const branch = [
      { type: "message", id: "entry-user-prev", parentId: null, message: { role: "user", content: "hello" } },
      previousAssistant,
      { type: "message", id: "entry-user-now", parentId: "entry-assistant-prev", message: { role: "user", content: "again" } },
    ];
    const hub = {
      subscribe: vi.fn((fn) => { subscriber = fn; }),
      send: vi.fn(async () => {}),
      eventBus: { emit: vi.fn() },
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({
        entries: [previousAssistant],
        sessionManager: { getBranch: () => branch },
      })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);
    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_end", aborted: true }, sessionPath);

    const usageEmits = hub.eventBus.emit.mock.calls
      .filter(([event]) => event?.type === "token_usage");
    expect(usageEmits).toHaveLength(0);
  });

  it("still logs usage on a normally completed turn_end", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const sessionPath = "/tmp/completed-turn-usage.jsonl";
    const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };
    const assistant = {
      type: "message",
      id: "entry-assistant-now",
      parentId: "entry-user-now",
      message: { role: "assistant", content: "done", usage },
    };
    const branch = [
      { type: "message", id: "entry-user-now", parentId: null, message: { role: "user", content: "again" } },
      assistant,
    ];
    const hub = {
      subscribe: vi.fn((fn) => { subscriber = fn; }),
      send: vi.fn(async () => {}),
      eventBus: { emit: vi.fn() },
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({
        entries: [assistant],
        sessionManager: { getBranch: () => branch },
      })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);
    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }, sessionPath);
    subscriber?.({ type: "turn_end" }, sessionPath);

    const usageEmits = hub.eventBus.emit.mock.calls
      .filter(([event]) => event?.type === "token_usage");
    expect(usageEmits).toHaveLength(1);
  });

  it("keeps hidden background turn input separate from the nearest visible user on turn_end", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const sessionPath = "/tmp/hidden-turn-input.jsonl";
    const branch = [
      { type: "message", id: "visible-user", parentId: null, message: { role: "user", content: "hello" } },
      { type: "message", id: "visible-assistant", parentId: "visible-user", message: { role: "assistant", content: "hi" } },
      {
        type: "custom_message",
        id: "hidden-input",
        parentId: "visible-assistant",
        customType: "hana-background-result",
        content: '<hana-background-result task-id="task-1" status="success" type="subagent">done</hana-background-result>',
        display: false,
        details: { deliveryId: "delivery-1" },
      },
      { type: "message", id: "background-assistant", parentId: "hidden-input", message: { role: "assistant", content: "handled" } },
    ];
    const hub = {
      subscribe: vi.fn((fn) => { subscriber = fn; }),
      send: vi.fn(async () => {}),
      eventBus: { emit: vi.fn() },
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [], sessionManager: { getBranch: () => branch } })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);
    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "handled" } }, sessionPath);
    subscriber?.({ type: "turn_end" }, sessionPath);

    const turnEnd = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find((payload) => payload.type === "turn_end");
    expect(turnEnd).toMatchObject({
      turnInputEntryId: "hidden-input",
      userEntryId: null,
      assistantEntryId: "background-assistant",
    });
  });

  it("rejects prompts through the engine public switching API", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn(),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => null),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => true),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };

    handlers.onMessage({
      data: JSON.stringify({
        type: "prompt",
        text: "hello",
        sessionPath: "/tmp/session.jsonl",
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.isSessionSwitching).toHaveBeenCalledWith("/tmp/session.jsonl");
    expect(hub.send).not.toHaveBeenCalled();
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: "error",
      message: "正在切换模型，请稍候",
      sessionPath: "/tmp/session.jsonl",
    });
  });

  it("rejects prompt routing when sessionId and sessionPath disagree (#2078)", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = { subscribe: vi.fn(), send: vi.fn(async () => {}) };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionIdForPath: vi.fn(() => "sess_path"),
      getSessionManifest: vi.fn(() => ({ currentLocator: { path: "/tmp/canonical.jsonl" } })),
      getSessionByPath: vi.fn(() => null),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onMessage({
      data: JSON.stringify({
        type: "prompt",
        text: "hello",
        sessionId: "sess_other",
        sessionPath: "/tmp/path.jsonl",
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.send).not.toHaveBeenCalled();
    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toContainEqual(expect.objectContaining({
      type: "error",
      code: "session_identity_mismatch",
    }));
  });

  // 身份解析排在媒体校验之前：一条没有身份的消息不该先把附件量一遍再拒，
  // 而且媒体校验的错误回包也要报在解析出来的会话上，而不是客户端原样送来的字段。
  it("rejects a prompt with no identity before it validates the attachments", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = { subscribe: vi.fn(), send: vi.fn(async () => {}) };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionIdForPath: vi.fn(() => null),
      getSessionManifest: vi.fn(() => null),
      getSessionByPath: vi.fn(() => null),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onMessage({
      data: JSON.stringify({
        type: "prompt",
        text: "hello",
        images: Array.from({ length: 11 }, () => ({ mimeType: "image/png", data: "AAAA" })),
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.send).not.toHaveBeenCalled();
    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads).toEqual([{
      type: "error",
      code: "internal_contract",
      message: "session identity required",
    }]);
  });

  it("reports attachment problems against the resolved session locator", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = { subscribe: vi.fn(), send: vi.fn(async () => {}) };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionIdForPath: vi.fn(() => "sess_moved"),
      getSessionManifest: vi.fn(() => ({ currentLocator: { path: "/tmp/canonical.jsonl" } })),
      getSessionByPath: vi.fn(() => null),
      resolveSessionOwnership: vi.fn(() => ({ agentId: "agent-a", source: "manifest", agentDeleted: false })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onMessage({
      data: JSON.stringify({
        type: "prompt",
        text: "hello",
        sessionPath: "/tmp/stale.jsonl",
        images: [{ mimeType: "image/tiff", data: "AAAA" }],
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.send).not.toHaveBeenCalled();
    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toContainEqual(expect.objectContaining({
      type: "error",
      sessionPath: "/tmp/canonical.jsonl",
    }));
  });

  it("rejects mismatched steer and resume targets before touching runtime state (#2078)", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = { subscribe: vi.fn(), send: vi.fn(async () => {}) };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionIdForPath: vi.fn(() => "sess_path"),
      getSessionManifest: vi.fn(() => ({ currentLocator: { path: "/tmp/canonical.jsonl" } })),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => true),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    for (const message of [
      { type: "steer", text: "wrong", sessionId: "sess_other", sessionPath: "/tmp/path.jsonl" },
      { type: "resume_stream", sessionId: "sess_other", sessionPath: "/tmp/path.jsonl", sinceSeq: 0 },
    ]) {
      handlers.onMessage({ data: JSON.stringify(message) }, ws);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(engine.steerSession).not.toHaveBeenCalled();
    expect(engine.isSessionStreaming).not.toHaveBeenCalled();
    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads.filter((payload) => payload.code === "session_identity_mismatch")).toHaveLength(2);
    expect(payloads.some((payload) => payload.type === "stream_resume")).toBe(false);
  });

  it("routes compact by sessionId through the manifest current locator", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const session = {
      isCompacting: false,
      extensionRunner: {
        assertActive: vi.fn(),
        hasHandlers: vi.fn(() => true),
      },
      compact: vi.fn(async () => { throw new Error("Nothing to compact"); }),
    };
    const hub = { subscribe: vi.fn(), send: vi.fn(async () => {}) };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionManifest: vi.fn(() => ({ currentLocator: { path: "/tmp/current-b.jsonl" } })),
      getSessionByPath: vi.fn((path) => path === "/tmp/current-b.jsonl" ? session : null),
      isDeletedAgentSession: vi.fn(() => false),
      isSessionStreaming: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onMessage({
      data: JSON.stringify({ type: "compact", sessionId: "sess_a" }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.getSessionManifest).toHaveBeenCalledWith("sess_a");
    expect(engine.getSessionByPath).toHaveBeenCalledWith("/tmp/current-b.jsonl");
    expect(session.compact).toHaveBeenCalledTimes(1);
    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      expect.objectContaining({
        type: "compaction_accepted",
        sessionId: "sess_a",
        sessionPath: "/tmp/current-b.jsonl",
      }),
      expect.objectContaining({
        type: "compaction_result",
        sessionId: "sess_a",
        sessionPath: "/tmp/current-b.jsonl",
        status: "noop",
        reason: "nothing_to_compact",
      }),
    ]);
  });

  it("runs instant simple compaction as an enabled one-shot method without changing ordinary compaction", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const session = {
      isCompacting: false,
      compact: vi.fn(),
    };
    const summarySource = { summary: "rolling" };
    const runInstantSimpleCompaction = vi.fn(async (_session, options) => {
      expect(await options.getSummarySource()).toEqual(summarySource);
      return { summary: "local checkpoint" };
    });
    const hub = { subscribe: vi.fn(), send: vi.fn(async () => {}) };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      preferences: {
        getExperimentValue: vi.fn((id) => (
          id === "session.instant_simple_compaction" ? true : undefined
        )),
      },
      getLossyLocalCompactionSummarySource: vi.fn(() => summarySource),
      getSessionManifest: vi.fn(() => ({ currentLocator: { path: "/tmp/current-b.jsonl" } })),
      getSessionByPath: vi.fn(() => session),
      isDeletedAgentSession: vi.fn(() => false),
      isSessionStreaming: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket, runInstantSimpleCompaction });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onMessage({
      data: JSON.stringify({
        type: "compact",
        sessionId: "sess_a",
        method: "instant_simple",
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runInstantSimpleCompaction).toHaveBeenCalledWith(session, expect.objectContaining({
      getSummarySource: expect.any(Function),
      lifecycleReason: "manual",
    }));
    expect(session.compact).not.toHaveBeenCalled();
    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      expect.objectContaining({
        type: "compaction_accepted",
        mode: "lossy_local",
      }),
      expect.objectContaining({
        type: "compaction_result",
        mode: "lossy_local",
        status: "succeeded",
      }),
    ]);
  });

  it("rejects the one-shot instant method while its experiment is disabled", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const session = { isCompacting: false, compact: vi.fn() };
    const runInstantSimpleCompaction = vi.fn();
    const hub = { subscribe: vi.fn(), send: vi.fn(async () => {}) };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      preferences: { getExperimentValue: vi.fn(() => false) },
      getSessionManifest: vi.fn(() => ({ currentLocator: { path: "/tmp/current-b.jsonl" } })),
      getSessionByPath: vi.fn(() => session),
      isDeletedAgentSession: vi.fn(() => false),
      isSessionStreaming: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket, runInstantSimpleCompaction });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onMessage({
      data: JSON.stringify({
        type: "compact",
        sessionId: "sess_a",
        method: "instant_simple",
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runInstantSimpleCompaction).not.toHaveBeenCalled();
    expect(session.compact).not.toHaveBeenCalled();
    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
      expect.objectContaining({
        type: "compaction_result",
        mode: "lossy_local",
        status: "failed",
        reason: "experiment_disabled",
      }),
    ]);
  });

  it("converts legacy compact paths at the boundary and never executes against the stale locator", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const session = { isCompacting: true };
    const hub = { subscribe: vi.fn(), send: vi.fn(async () => {}) };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionIdForPath: vi.fn((path) => path === "/tmp/legacy-a.jsonl" ? "sess_a" : null),
      getSessionManifest: vi.fn(() => ({ currentLocator: { path: "/tmp/current-b.jsonl" } })),
      getSessionByPath: vi.fn((path) => path === "/tmp/current-b.jsonl" ? session : null),
      isDeletedAgentSession: vi.fn(() => false),
      isSessionStreaming: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onMessage({
      data: JSON.stringify({ type: "compact", sessionPath: "/tmp/legacy-a.jsonl" }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.getSessionIdForPath).toHaveBeenCalledWith("/tmp/legacy-a.jsonl");
    expect(engine.getSessionByPath).toHaveBeenCalledWith("/tmp/current-b.jsonl");
    expect(engine.getSessionByPath).not.toHaveBeenCalledWith("/tmp/legacy-a.jsonl");
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: "compaction_result",
      sessionId: "sess_a",
      sessionPath: "/tmp/current-b.jsonl",
      status: "failed",
      reason: "already_compacting",
    });
  });

  it("routes streaming interject messages through the desktop interjection contract", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn(),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      ensureSessionLoaded: vi.fn(async () => ({})),
      emitEvent: vi.fn(),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      setUiContext: vi.fn(),
      steerSession: vi.fn(() => true),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };

    handlers.onMessage({
      data: JSON.stringify({
        type: "interject",
        text: "插一句",
        sessionPath: "/tmp/session.jsonl",
        displayMessage: { text: "插一句" },
        uiContext: { currentTab: "chat" },
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.send).not.toHaveBeenCalled();
    expect(engine.steerSession).toHaveBeenCalledWith("/tmp/session.jsonl", "插一句");
    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session_user_message",
        message: expect.objectContaining({ text: "插一句" }),
      }),
      "/tmp/session.jsonl",
    );
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: "steered",
      sessionPath: "/tmp/session.jsonl",
    });
  });

  it("keeps shared stream state attached to the session id when the session path moves", () => {
    let createHandlers;
    let subscriber;
    const originalPath = "/tmp/original-stream.jsonl";
    const movedPath = "/tmp/archived/renamed-stream.jsonl";
    const sessionId = "sess_chat_stream";
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      getSessionIdForPath: vi.fn((sessionPath) => (
        sessionPath === originalPath || sessionPath === movedPath ? sessionId : null
      )),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "一" },
    }, originalPath);
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "二" },
    }, movedPath);

    const deltas = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((payload) => payload.type === "text_delta");

    expect(deltas.map((payload) => payload.seq)).toEqual([1, 2]);
    expect(deltas[1]).toMatchObject({
      sessionPath: movedPath,
      streamId: deltas[0].streamId,
    });

    handlers.onClose({}, ws);
  });

  it("renders structured reasoning_content thinking deltas from OpenAI-compatible providers", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        reasoning_content: "先判断 DeepSeek 的结构化推理字段。",
      },
    }, "/tmp/deepseek-thinking.jsonl");

    const thinkingEvents = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((payload) => payload.type === "thinking_start" || payload.type === "thinking_delta");

    expect(thinkingEvents).toEqual([
      expect.objectContaining({ type: "thinking_start" }),
      expect.objectContaining({
        type: "thinking_delta",
        delta: "先判断 DeepSeek 的结构化推理字段。",
      }),
    ]);

    handlers.onClose({}, ws);
  });

  it("buffers OpenAI Responses text until text_end and suppresses commentary phase", () => {
    let createHandlers;
    let subscriber;
    const commentarySignature = JSON.stringify({
      v: 1,
      id: "msg_commentary",
      phase: "commentary",
    });
    const finalSignature = JSON.stringify({
      v: 1,
      id: "msg_final",
      phase: "final_answer",
    });
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    const sessionPath = "/tmp/openai-phase-session.jsonl";
    const commentaryPartial = {
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.5",
      content: [{ type: "text", text: "I need to inspect the current state." }],
    };
    const finalContent = [
      {
        type: "text",
        text: "I need to inspect the current state.",
        textSignature: commentarySignature,
      },
      {
        type: "text",
        text: "已经查到状态。",
        textSignature: finalSignature,
      },
    ];

    subscriber?.({
      type: "message_update",
      message: commentaryPartial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "I need to inspect the current state.",
        partial: commentaryPartial,
      },
    }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { ...commentaryPartial, content: [finalContent[0]] },
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "I need to inspect the current state.",
        partial: { ...commentaryPartial, content: [finalContent[0]] },
      },
    }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { ...commentaryPartial, content: finalContent },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "已经查到状态。",
        partial: { ...commentaryPartial, content: finalContent },
      },
    }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { ...commentaryPartial, content: finalContent },
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 1,
        content: "已经查到状态。",
        partial: { ...commentaryPartial, content: finalContent },
      },
    }, sessionPath);

    const deltas = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((payload) => payload.type === "text_delta");

    expect(deltas.map((payload) => payload.delta)).toEqual(["已经查到状态。"]);

    handlers.onClose({}, ws);
  });

  it("reports engine runtime streaming separately when resume replay state is missing", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn(),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      getSessionIdForPath: vi.fn(() => "sess_running"),
      getSessionManifest: vi.fn(() => ({ currentLocator: { path: "/tmp/running-session.jsonl" } })),
      isSessionStreaming: vi.fn((sessionPath) => sessionPath === "/tmp/running-session.jsonl"),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };
    handlers.onOpen({}, ws);

    handlers.onMessage({
      data: JSON.stringify({
        type: "resume_stream",
        sessionPath: "/tmp/running-session.jsonl",
        sessionId: "sess_running",
        sinceSeq: 42,
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.isSessionStreaming).toHaveBeenCalledWith("/tmp/running-session.jsonl");
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: "stream_resume",
      sessionPath: "/tmp/running-session.jsonl",
      sessionId: "sess_running",
      sessionRefVersion: 2,
      streamId: null,
      sinceSeq: 42,
      nextSeq: 1,
      isStreaming: false,
      runtimeIsStreaming: true,
      events: [],
    });

    handlers.onClose({}, ws);
  });

  it("includes the active streamId on status start and finish messages", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/identity-session.jsonl");
    subscriber?.({ type: "session_status", isStreaming: false }, "/tmp/identity-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const start = payloads.find((payload) => payload.type === "status" && payload.isStreaming === true);
    const finish = payloads.find((payload) => payload.type === "status" && payload.isStreaming === false);
    expect(start).toMatchObject({
      type: "status",
      sessionPath: "/tmp/identity-session.jsonl",
      isStreaming: true,
    });
    expect(start.streamId).toEqual(expect.any(String));
    expect(start.streamId.length).toBeGreaterThan(0);
    expect(finish).toMatchObject({
      type: "status",
      sessionPath: "/tmp/identity-session.jsonl",
      isStreaming: false,
      streamId: start.streamId,
    });

    handlers.onClose({}, ws);
  });

  it("preserves abort metadata on session status broadcasts", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/reason-session.jsonl");
    subscriber?.({
      type: "session_status",
      isStreaming: false,
      aborted: true,
      reason: "turn_stall_timeout",
    }, "/tmp/reason-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const finish = payloads.find((payload) => payload.type === "status" && payload.isStreaming === false);
    expect(finish).toMatchObject({
      type: "status",
      sessionPath: "/tmp/reason-session.jsonl",
      isStreaming: false,
      aborted: true,
      reason: "turn_stall_timeout",
    });

    handlers.onClose({}, ws);
  });

  it("keeps remote and host clients on the same server-side session stream", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const hostWs = { readyState: 1, send: vi.fn() };
    const phoneWs = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, hostWs);
    handlers.onOpen({}, phoneWs);

    handlers.onMessage({
      data: JSON.stringify({
        type: "prompt",
        text: "hello from phone",
        sessionPath: "/tmp/shared-session.jsonl",
        clientMessageId: "client-user-1",
      }),
    }, phoneWs);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.send).toHaveBeenCalledWith("hello from phone", expect.objectContaining({
      sessionPath: "/tmp/shared-session.jsonl",
      clientMessageId: "client-user-1",
    }));

    subscriber?.({
      type: "session_user_message",
      clientMessageId: "client-user-1",
      message: { id: "u1", text: "hello from phone" },
    }, "/tmp/shared-session.jsonl");

    for (const ws of [hostWs, phoneWs]) {
      expect(ws.send).toHaveBeenCalledWith(expect.any(String));
      const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(payloads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "session_user_message",
          sessionPath: "/tmp/shared-session.jsonl",
          clientMessageId: "client-user-1",
          message: { id: "u1", text: "hello from phone" },
        }),
      ]));
    }

    handlers.onClose({}, hostWs);
    handlers.onClose({}, phoneWs);
  });

  it("passes @Session references to the Agent as resolvable IDs without linking Session metadata", async () => {
    let createHandlers;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn(),
      send: vi.fn<(text: string, opts: Record<string, unknown>) => Promise<void>>(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionIdForPath: vi.fn(() => "sess_parent"),
      getSessionManifest: vi.fn(() => ({ currentLocator: { path: "/tmp/parent.jsonl" } })),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onMessage({
      data: JSON.stringify({
        type: "prompt",
        text: "Compare @Earlier plan",
        sessionId: "sess_parent",
        sessionPath: "/tmp/parent.jsonl",
        sessionRefs: [{ sessionId: "sess_context", label: "Earlier plan" }],
      }),
    }, ws);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(hub.send).toHaveBeenCalledTimes(1);
    const [prompt, opts] = hub.send.mock.calls[0];
    expect(prompt).toContain("sess_context");
    expect(prompt).toContain("是否读取由你根据任务自行判断");
    expect(opts).toMatchObject({ sessionId: "sess_parent", sessionPath: "/tmp/parent.jsonl" });
    expect(prompt).not.toMatch(/parentSessionId|childSessionId|relationId/);
  });

  it("emits file content blocks for deferred result session files", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "deferred_result",
      taskId: "img-task-1",
      status: "success",
      result: {
        files: ["abc.png"],
        sessionFiles: [{
          fileId: "sf_generated",
          filePath: "/tmp/generated/abc.png",
          label: "abc.png",
          ext: "png",
          mime: "image/png",
          kind: "image",
          storageKind: "plugin_data",
          status: "available",
        }],
      },
      meta: { type: "image-generation" },
    }, "/tmp/image-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "deferred_result",
        sessionPath: "/tmp/image-session.jsonl",
        taskId: "img-task-1",
        status: "success",
      }),
      expect.objectContaining({
        type: "content_block",
        sessionPath: "/tmp/image-session.jsonl",
        block: expect.objectContaining({
          type: "file",
          fileId: "sf_generated",
          filePath: "/tmp/generated/abc.png",
          label: "abc.png",
          ext: "png",
          mime: "image/png",
          kind: "image",
          storageKind: "plugin_data",
          status: "available",
        }),
      }),
    ]));

    handlers.onClose({}, ws);
  });

  it("removes already queued discarded-task content when the retry reset arrives", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const sessionPath = "/tmp/retry-queued-deferred.jsonl";
    const hub = {
      subscribe: vi.fn((fn) => { subscriber = fn; }),
      send: vi.fn(async () => {}),
      eventBus: { emit: vi.fn() },
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      deferredResults: { query: vi.fn(() => ({ deliverySuppressed: false })) },
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "deferred_result",
      taskId: "task-tail",
      status: "success",
      result: {
        sessionFiles: [{
          fileId: "sf-task-tail",
          filePath: "/tmp/task-tail.png",
          label: "task-tail.png",
          ext: "png",
        }],
      },
      meta: { type: "image-generation" },
    }, sessionPath);
    subscriber?.({
      type: "session_branch_reset",
      messageId: "retry-user",
      discardedTaskIds: ["task-tail"],
      todos: [],
      sessionFiles: [],
    }, sessionPath);
    subscriber?.({ type: "turn_end" }, sessionPath);

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads.some((payload) => (
      payload.type === "content_block"
      && (payload.block?.taskId === "task-tail" || payload.block?.replacesTaskId === "task-tail")
    ))).toBe(false);

    handlers.onClose({}, ws);
  });

  it("renders deferred interludes only when the actual hidden custom message is consumed", () => {
    let createHandlers;
    let subscriber;
    const persistedBranch: any[] = [];
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hanako",
      abortAllStreaming: vi.fn(async () => {}),
      deferredResults: {
        query: vi.fn(() => ({
          status: "resolved",
          result: "回来了。",
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "Hanako",
            label: "凌晨诗行",
            summary: "写一首关于凌晨五点三十九分的三行短诗。要求：不要使用常见意象。",
          },
        })),
      },
      getSessionByPath: vi.fn(() => ({
        entries: [],
        sessionManager: { getBranch: () => persistedBranch },
      })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      recordSessionCustomEntry: vi.fn(),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/interlude-session.jsonl");
    subscriber?.({ type: "turn_start" }, "/tmp/interlude-session.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "派出去了。\n" },
    }, "/tmp/interlude-session.jsonl");
    subscriber?.({
      type: "deferred_result",
      taskId: "subagent-fast",
      status: "success",
      result: "回来了。",
      meta: {
        type: "subagent",
        interlude: true,
        executorAgentNameSnapshot: "Hanako",
        label: "凌晨诗行",
        summary: "写一首关于凌晨五点三十九分的三行短诗。要求：不要使用常见意象。",
      },
    }, "/tmp/interlude-session.jsonl");
    subscriber?.({
      type: "turn_input_presentation",
      presentation: {
        kind: "pre_reply_interlude",
        deliveryId: "delivery-subagent-fast",
        taskId: "subagent-fast",
        status: "success",
        resultType: "subagent",
        result: "回来了。",
        deliveryMode: "followUp",
      },
    }, "/tmp/interlude-session.jsonl");

    let payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads.some((payload) => payload.type === "deferred_result")).toBe(true);
    expect(payloads.some((payload) => payload.type === "content_block" && payload.block?.type === "interlude")).toBe(false);

    subscriber?.({ type: "turn_end" }, "/tmp/interlude-session.jsonl");

    payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const turnEndIndex = payloads.findIndex((payload) => payload.type === "turn_end");
    expect(turnEndIndex).toBeGreaterThanOrEqual(0);
    expect(payloads.some((payload) => payload.type === "content_block" && payload.block?.type === "interlude")).toBe(false);

    subscriber?.({ type: "turn_start" }, "/tmp/interlude-session.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "这不是后台结果回复。\n" },
    }, "/tmp/interlude-session.jsonl");

    payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads.some((payload) => payload.type === "content_block" && payload.block?.type === "interlude")).toBe(false);
    expect(engine.recordSessionCustomEntry).not.toHaveBeenCalled();

    subscriber?.({ type: "turn_end" }, "/tmp/interlude-session.jsonl");
    subscriber?.({ type: "turn_start" }, "/tmp/interlude-session.jsonl");
    subscriber?.({
      type: "message_end",
      message: {
        role: "custom",
        customType: "hana-background-result",
        display: false,
        content: "<hana-background-result task-id=\"subagent-fast\" status=\"success\" type=\"subagent\">\n回来了。\n</hana-background-result>",
        details: { deliveryId: "delivery-subagent-fast" },
      },
    }, "/tmp/interlude-session.jsonl");
    persistedBranch.push({
      type: "custom_message",
      id: "custom-subagent-fast",
      parentId: null,
      customType: "hana-background-result",
      display: false,
      content: "<hana-background-result task-id=\"subagent-fast\" status=\"success\" type=\"subagent\">\n回来了。\n</hana-background-result>",
      details: { deliveryId: "delivery-subagent-fast" },
    });
    subscriber?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "收到，正在处理。\n" },
    }, "/tmp/interlude-session.jsonl");

    payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const interludeIndex = payloads.findIndex((payload) => payload.type === "content_block" && payload.block?.type === "interlude");
    const nextTextIndex = payloads.findIndex((payload) => payload.type === "text_delta" && payload.delta === "收到，正在处理。\n");
    expect(interludeIndex).toBeGreaterThan(turnEndIndex);
    expect(interludeIndex).toBeLessThan(nextTextIndex);
    expect(payloads[interludeIndex].block).toMatchObject({
      type: "interlude",
      taskId: "subagent-fast",
      deliveryId: "delivery-subagent-fast",
      sourceLabel: "Hanako · 凌晨诗行",
    });
    expect(engine.recordSessionCustomEntry).not.toHaveBeenCalled();
    persistedBranch.push({
      type: "message",
      id: "assistant-subagent-fast",
      parentId: "custom-subagent-fast",
      message: { role: "assistant", content: "收到，正在处理。" },
    });
    subscriber?.({ type: "turn_end" }, "/tmp/interlude-session.jsonl");

    expect(engine.recordSessionCustomEntry).toHaveBeenCalledWith(
      "/tmp/interlude-session.jsonl",
      TURN_INPUT_CONSUMPTION_EVENT_TYPE,
      expect.objectContaining({
        schemaVersion: 1,
        input: expect.objectContaining({
          entryId: "custom-subagent-fast",
          customType: "hana-background-result",
          deliveryId: "delivery-subagent-fast",
          taskId: "subagent-fast",
        }),
        assistant: expect.objectContaining({
          entryId: "assistant-subagent-fast",
          parentId: "custom-subagent-fast",
        }),
        block: expect.objectContaining({
          type: "interlude",
          deliveryId: "delivery-subagent-fast",
          taskId: "subagent-fast",
        }),
      }),
    );

    subscriber?.({
      type: "session_branch_reset",
      messageId: "custom-subagent-fast",
      projectionMessageId: "assistant-subagent-fast",
      discardedTaskIds: [],
    }, "/tmp/interlude-session.jsonl");
    persistedBranch.splice(0);
    subscriber?.({ type: "turn_start" }, "/tmp/interlude-session.jsonl");
    subscriber?.({
      type: "message_end",
      message: {
        role: "custom",
        customType: "hana-background-result",
        display: false,
        content: "<hana-background-result task-id=\"subagent-fast\" status=\"success\" type=\"subagent\">\n回来了。\n</hana-background-result>",
        details: { deliveryId: "delivery-subagent-fast" },
      },
    }, "/tmp/interlude-session.jsonl");
    persistedBranch.push({
      type: "custom_message",
      id: "custom-subagent-fast-retry",
      parentId: null,
      customType: "hana-background-result",
      display: false,
      content: "<hana-background-result task-id=\"subagent-fast\" status=\"success\" type=\"subagent\">\n回来了。\n</hana-background-result>",
      details: { deliveryId: "delivery-subagent-fast" },
    });
    subscriber?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "重试后再次处理。\n" },
    }, "/tmp/interlude-session.jsonl");

    payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads.filter((payload) => (
      payload.type === "content_block"
      && payload.block?.type === "interlude"
      && payload.block?.deliveryId === "delivery-subagent-fast"
    ))).toHaveLength(2);

    handlers.onClose({}, ws);
  });

  it("orders deferred interludes by actual custom-message consumption order", () => {
    let createHandlers;
    let subscriber;
    const sessionPath = "/tmp/interlude-followup-one-by-one.jsonl";
    const taskMeta: Record<string, { label: string; summary: string }> = {
      "task-a": { label: "A", summary: "first task" },
      "task-b": { label: "B", summary: "second task" },
    };
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hanako",
      abortAllStreaming: vi.fn(async () => {}),
      deferredResults: {
        query: vi.fn((taskId) => ({
          status: "resolved",
          result: `${taskId} done`,
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "Hanako",
            label: taskMeta[taskId]?.label,
            summary: taskMeta[taskId]?.summary,
          },
        })),
      },
      getSessionByPath: vi.fn(() => ({ entries: [], followUpMode: "one-at-a-time" })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    for (const taskId of ["task-b", "task-a"]) {
      subscriber?.({
        type: "turn_input_presentation",
        presentation: {
          kind: "pre_reply_interlude",
          deliveryId: `delivery-${taskId}`,
          taskId,
          status: "success",
          resultType: "subagent",
          result: `${taskId} done`,
          deliveryMode: "followUp",
        },
      }, sessionPath);
    }

    subscriber?.({ type: "turn_end" }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "message_end",
      message: {
        id: "custom-task-a",
        role: "custom",
        customType: "hana-background-result",
        display: false,
        content: "<hana-background-result task-id=\"task-a\" status=\"success\" type=\"subagent\">\ntask-a done\n</hana-background-result>",
        details: { deliveryId: "delivery-task-a" },
      },
    }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { id: "assistant-task-a", parentId: "custom-task-a", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "first follow-up reply" },
    }, sessionPath);
    subscriber?.({ type: "turn_end" }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "message_end",
      message: {
        id: "custom-task-b",
        role: "custom",
        customType: "hana-background-result",
        display: false,
        content: "<hana-background-result task-id=\"task-b\" status=\"success\" type=\"subagent\">\ntask-b done\n</hana-background-result>",
        details: { deliveryId: "delivery-task-b" },
      },
    }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { id: "assistant-task-b", parentId: "custom-task-b", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "second follow-up reply" },
    }, sessionPath);

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const firstTextIndex = payloads.findIndex((payload) => payload.type === "text_delta" && payload.delta === "first follow-up reply");
    const secondTextIndex = payloads.findIndex((payload) => payload.type === "text_delta" && payload.delta === "second follow-up reply");
    const interludes = payloads
      .map((payload, index) => ({ payload, index }))
      .filter(({ payload }) => payload.type === "content_block" && payload.block?.type === "interlude");

    expect(interludes).toHaveLength(2);
    expect(interludes[0].payload.block.taskId).toBe("task-a");
    expect(interludes[0].index).toBeLessThan(firstTextIndex);
    expect(interludes[1].payload.block.taskId).toBe("task-b");
    expect(interludes[1].index).toBeGreaterThan(firstTextIndex);
    expect(interludes[1].index).toBeLessThan(secondTextIndex);

    handlers.onClose({}, ws);
  });

  it("keeps repeated consumed custom messages for the same task as distinct interludes", () => {
    let createHandlers;
    let subscriber;
    const sessionPath = "/tmp/interlude-repeated-task.jsonl";
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hanako",
      abortAllStreaming: vi.fn(async () => {}),
      deferredResults: {
        query: vi.fn(() => ({
          status: "resolved",
          result: "same task result",
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "Hanako",
            label: "same-task",
            summary: "same task delivered twice",
          },
        })),
      },
      getSessionByPath: vi.fn(() => ({ entries: [], followUpMode: "one-at-a-time" })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    for (let i = 0; i < 2; i += 1) {
      subscriber?.({
        type: "turn_input_presentation",
        presentation: {
          kind: "pre_reply_interlude",
          deliveryId: `delivery-task-a-${i}`,
          taskId: "task-a",
          status: "success",
          resultType: "subagent",
          result: "same task result",
          deliveryMode: "followUp",
        },
      }, sessionPath);
    }

    subscriber?.({ type: "turn_end" }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "message_end",
      message: {
        id: "custom-task-a-0",
        role: "custom",
        customType: "hana-background-result",
        display: false,
        content: "<hana-background-result task-id=\"task-a\" status=\"success\" type=\"subagent\">\nsame task result\n</hana-background-result>",
        details: { deliveryId: "delivery-task-a-0" },
      },
    }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { id: "assistant-task-a-0", parentId: "custom-task-a-0", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "first repeated delivery reply" },
    }, sessionPath);
    subscriber?.({ type: "turn_end" }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "message_end",
      message: {
        id: "custom-task-a-1",
        role: "custom",
        customType: "hana-background-result",
        display: false,
        content: "<hana-background-result task-id=\"task-a\" status=\"success\" type=\"subagent\">\nsame task result\n</hana-background-result>",
        details: { deliveryId: "delivery-task-a-1" },
      },
    }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { id: "assistant-task-a-1", parentId: "custom-task-a-1", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "second repeated delivery reply" },
    }, sessionPath);

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const firstTextIndex = payloads.findIndex((payload) => payload.type === "text_delta" && payload.delta === "first repeated delivery reply");
    const secondTextIndex = payloads.findIndex((payload) => payload.type === "text_delta" && payload.delta === "second repeated delivery reply");
    const interludes = payloads
      .map((payload, index) => ({ payload, index }))
      .filter(({ payload }) => payload.type === "content_block" && payload.block?.type === "interlude");

    expect(interludes).toHaveLength(2);
    expect(interludes.map(({ payload }) => payload.block.taskId)).toEqual(["task-a", "task-a"]);
    expect(new Set(interludes.map(({ payload }) => payload.block.id)).size).toBe(2);
    expect(interludes[0].index).toBeLessThan(firstTextIndex);
    expect(interludes[1].index).toBeGreaterThan(firstTextIndex);
    expect(interludes[1].index).toBeLessThan(secondTextIndex);

    handlers.onClose({}, ws);
  });

  it("persists a turn input consumption record only when the consumed custom input receives an assistant reply", () => {
    let createHandlers;
    let subscriber;
    const sessionPath = "/tmp/interlude-persist-on-consume.jsonl";
    const persistedBranch: any[] = [];
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hanako",
      abortAllStreaming: vi.fn(async () => {}),
      deferredResults: {
        query: vi.fn(() => ({
          status: "resolved",
          result: "done",
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "Hanako",
            label: "queued-task",
          },
        })),
      },
      getSessionByPath: vi.fn(() => ({
        entries: [],
        followUpMode: "one-at-a-time",
        sessionManager: { getBranch: () => persistedBranch },
      })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      recordSessionCustomEntry: vi.fn(),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "turn_input_presentation",
      presentation: {
        kind: "pre_reply_interlude",
        deliveryId: "delivery-consumed-later",
        taskId: "task-a",
        status: "success",
        resultType: "subagent",
        result: "done",
        deliveryMode: "followUp",
      },
    }, sessionPath);

    expect(engine.recordSessionCustomEntry).not.toHaveBeenCalled();

    subscriber?.({ type: "turn_end" }, sessionPath);
    expect(engine.recordSessionCustomEntry).not.toHaveBeenCalled();

    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "message_update",
      message: { id: "assistant-unrelated", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "unrelated reply" },
    }, sessionPath);
    expect(engine.recordSessionCustomEntry).not.toHaveBeenCalled();

    subscriber?.({ type: "turn_end" }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    subscriber?.({
      type: "message_end",
      message: {
        role: "custom",
        customType: "hana-background-result",
        display: false,
        content: "<hana-background-result task-id=\"task-a\" status=\"success\" type=\"subagent\">\ndone\n</hana-background-result>",
        details: { deliveryId: "delivery-consumed-later" },
      },
    }, sessionPath);
    persistedBranch.push({
      type: "custom_message",
      id: "custom-consumed-later",
      parentId: null,
      customType: "hana-background-result",
      display: false,
      content: "<hana-background-result task-id=\"task-a\" status=\"success\" type=\"subagent\">\ndone\n</hana-background-result>",
      details: { deliveryId: "delivery-consumed-later" },
    });
    expect(engine.recordSessionCustomEntry).not.toHaveBeenCalled();

    subscriber?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "收到 task-a" },
    }, sessionPath);

    expect(engine.recordSessionCustomEntry).not.toHaveBeenCalled();
    persistedBranch.push({
      type: "message",
      id: "assistant-consumes-task-a",
      parentId: "custom-consumed-later",
      message: { role: "assistant", content: "收到 task-a" },
    });
    subscriber?.({ type: "turn_end" }, sessionPath);

    expect(engine.recordSessionCustomEntry).toHaveBeenCalledTimes(1);
    expect(engine.recordSessionCustomEntry).toHaveBeenCalledWith(
      sessionPath,
      TURN_INPUT_CONSUMPTION_EVENT_TYPE,
      expect.objectContaining({
        schemaVersion: 1,
        deliveryId: "delivery-consumed-later",
        input: expect.objectContaining({
          entryId: "custom-consumed-later",
          customType: "hana-background-result",
          taskId: "task-a",
          deliveryId: "delivery-consumed-later",
        }),
        assistant: expect.objectContaining({
          entryId: "assistant-consumes-task-a",
          parentId: "custom-consumed-later",
        }),
        block: expect.objectContaining({
          type: "interlude",
          deliveryId: "delivery-consumed-later",
          taskId: "task-a",
        }),
      }),
    );

    handlers.onClose({}, ws);
  });

  it("renders consecutive consumed custom messages before the assistant reply that consumes them", () => {
    let createHandlers;
    let subscriber;
    const sessionPath = "/tmp/interlude-followup-all.jsonl";
    const persistedBranch: any[] = [];
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hanako",
      abortAllStreaming: vi.fn(async () => {}),
      deferredResults: {
        query: vi.fn((taskId) => ({
          status: "resolved",
          result: `${taskId} done`,
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "Hanako",
            label: taskId,
            summary: taskId,
          },
        })),
      },
      getSessionByPath: vi.fn(() => ({
        entries: [],
        followUpMode: "all",
        sessionManager: { getBranch: () => persistedBranch },
      })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      recordSessionCustomEntry: vi.fn(),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    for (const taskId of ["task-a", "task-b"]) {
      subscriber?.({
        type: "turn_input_presentation",
        presentation: {
          kind: "pre_reply_interlude",
          deliveryId: `delivery-${taskId}`,
          taskId,
          status: "success",
          resultType: "subagent",
          result: `${taskId} done`,
          deliveryMode: "followUp",
        },
      }, sessionPath);
    }

    subscriber?.({ type: "turn_end" }, sessionPath);
    subscriber?.({ type: "turn_start" }, sessionPath);
    for (const taskId of ["task-a", "task-b"]) {
      subscriber?.({
        type: "message_end",
        message: {
          role: "custom",
          customType: "hana-background-result",
          display: false,
          content: `<hana-background-result task-id="${taskId}" status="success" type="subagent">\n${taskId} done\n</hana-background-result>`,
          details: { deliveryId: `delivery-${taskId}` },
        },
      }, sessionPath);
      persistedBranch.push({
        type: "custom_message",
        id: `custom-${taskId}`,
        parentId: persistedBranch.at(-1)?.id || null,
        customType: "hana-background-result",
        display: false,
        content: `<hana-background-result task-id="${taskId}" status="success" type="subagent">\n${taskId} done\n</hana-background-result>`,
        details: { deliveryId: `delivery-${taskId}` },
      });
    }
    subscriber?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "combined follow-up reply" },
    }, sessionPath);

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const textIndex = payloads.findIndex((payload) => payload.type === "text_delta" && payload.delta === "combined follow-up reply");
    const interludes = payloads
      .map((payload, index) => ({ payload, index }))
      .filter(({ payload }) => payload.type === "content_block" && payload.block?.type === "interlude");

    expect(interludes.map(({ payload }) => payload.block.taskId)).toEqual(["task-a", "task-b"]);
    expect(interludes.every(({ index }) => index < textIndex)).toBe(true);
    expect(engine.recordSessionCustomEntry).not.toHaveBeenCalled();

    persistedBranch.push({
      type: "message",
      id: "assistant-combined",
      parentId: "custom-task-b",
      message: { role: "assistant", content: "combined follow-up reply" },
    });
    subscriber?.({ type: "turn_end" }, sessionPath);

    expect(engine.recordSessionCustomEntry).toHaveBeenCalledTimes(2);
    const records = engine.recordSessionCustomEntry.mock.calls.map(([, , record]) => record);
    expect(records.map((record) => record.input.entryId)).toEqual(["custom-task-a", "custom-task-b"]);
    expect(records.map((record) => record.assistant.entryId)).toEqual([
      "assistant-combined",
      "assistant-combined",
    ]);

    handlers.onClose({}, ws);
  });

  it("delivers a turn completion desktop notification when the preference is enabled", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
    };
    const deliverNotification = vi.fn(async () => ({ ok: true }));
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getNotificationPreferences: vi.fn(() => ({ chatCompletion: "when_unfocused" })),
      getSessionIdForPath: vi.fn(() => "session-notified"),
      getSessionManifest: vi.fn(() => ({
        sessionId: "session-notified",
        ownerAgentId: "agent-2",
        domain: "desktop",
        kind: "chat",
      })),
      deliverNotification,
      getSessionByPath: vi.fn(() => ({
        entries: [],
        agentId: "agent-2",
        agentName: "小蓝",
      })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/notified-session.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "完成了。" },
    }, "/tmp/notified-session.jsonl");
    subscriber?.({ type: "turn_end" }, "/tmp/notified-session.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "小蓝",
        body: expect.any(String),
        channels: ["desktop"],
        desktopFocusPolicy: "when_unfocused",
        idempotencyKey: expect.stringContaining("chat-completion:session-notified:"),
      }),
      { agentId: "agent-2" },
    );

    handlers.onClose({}, ws);
  });

  it("fails closed for internal and missing session manifests", async () => {
    for (const manifest of [
      { sessionId: "activity-session", ownerAgentId: "agent-2", domain: "activity", kind: "activity" },
      { sessionId: "subagent-session", ownerAgentId: "agent-2", domain: "subagent", kind: "subagent_child" },
      { sessionId: "bridge-session", ownerAgentId: "agent-2", domain: "bridge", kind: "bridge_owner" },
      { sessionId: "plugin-session", ownerAgentId: "agent-2", domain: "desktop", kind: "plugin_private" },
      null,
    ]) {
      let createHandlers;
      let subscriber;
      const upgradeWebSocket = vi.fn((factory) => {
        createHandlers = factory;
        return () => new Response(null);
      });
      const hub = {
        subscribe: vi.fn((fn) => {
          subscriber = fn;
        }),
        send: vi.fn(async () => {}),
        abort: vi.fn(async () => true),
      };
      const deliverNotification = vi.fn(async () => ({ ok: true }));
      const engine = {
        agentName: "Hana",
        abortAllStreaming: vi.fn(async () => {}),
        getNotificationPreferences: vi.fn(() => ({ chatCompletion: "when_unfocused" })),
        getSessionIdForPath: vi.fn(() => "activity-session"),
        getSessionManifest: vi.fn(() => manifest),
        deliverNotification,
        getSessionByPath: vi.fn(() => ({ entries: [], agentId: "agent-2", agentName: "小蓝" })),
        isSessionStreaming: vi.fn(() => false),
        isSessionSwitching: vi.fn(() => false),
        steerSession: vi.fn(() => false),
        slashDispatcher: null,
      };

      createChatRoute(engine, hub, { upgradeWebSocket });
      const handlers = createHandlers({});
      const ws = { readyState: 1, send: vi.fn() };
      handlers.onOpen({}, ws);

      const sessionPath = manifest ? `/tmp/${manifest.sessionId}.jsonl` : "/tmp/missing-manifest.jsonl";
      subscriber?.({ type: "session_status", isStreaming: true }, sessionPath);
      subscriber?.({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "done" },
      }, sessionPath);
      subscriber?.({ type: "turn_end" }, sessionPath);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(deliverNotification).not.toHaveBeenCalled();
      handlers.onClose({}, ws);
    }
  });

  it("delivers a session-aware turn completion notification with the completed sessionPath", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
    };
    const deliverNotification = vi.fn(async () => ({ ok: true }));
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getNotificationPreferences: vi.fn(() => ({ chatCompletion: "when_session_unfocused" })),
      getSessionIdForPath: vi.fn(() => "session-aware"),
      getSessionManifest: vi.fn(() => ({
        sessionId: "session-aware",
        ownerAgentId: "agent-2",
        domain: "desktop",
        kind: "chat",
      })),
      deliverNotification,
      getSessionByPath: vi.fn(() => ({
        entries: [],
        agentId: "agent-2",
        agentName: "小蓝",
      })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/session-aware.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "完成了。" },
    }, "/tmp/session-aware.jsonl");
    subscriber?.({ type: "turn_end" }, "/tmp/session-aware.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "小蓝",
        sessionPath: "/tmp/session-aware.jsonl",
        desktopFocusPolicy: "when_session_unfocused",
      }),
      { agentId: "agent-2" },
    );

    handlers.onClose({}, ws);
  });

  it("defers turn completion notifications until the session is no longer streaming", async () => {
    let createHandlers;
    let subscriber;
    let runtimeStreaming = true;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
    };
    const deliverNotification = vi.fn(async () => ({ ok: true }));
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getNotificationPreferences: vi.fn(() => ({ chatCompletion: "when_unfocused" })),
      getSessionIdForPath: vi.fn(() => "session-deferred"),
      getSessionManifest: vi.fn(() => ({
        sessionId: "session-deferred",
        ownerAgentId: "agent-2",
        domain: "desktop",
        kind: "chat",
      })),
      deliverNotification,
      getSessionByPath: vi.fn(() => ({
        entries: [],
        agentId: "agent-2",
        agentName: "小蓝",
      })),
      isSessionStreaming: vi.fn(() => runtimeStreaming),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/deferred-notification.jsonl");
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "工具前输出。" },
    }, "/tmp/deferred-notification.jsonl");
    subscriber?.({ type: "turn_end" }, "/tmp/deferred-notification.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverNotification).not.toHaveBeenCalled();

    runtimeStreaming = false;
    subscriber?.({ type: "session_status", isStreaming: false }, "/tmp/deferred-notification.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "小蓝",
        sessionPath: "/tmp/deferred-notification.jsonl",
        desktopFocusPolicy: "when_unfocused",
      }),
      { agentId: "agent-2" },
    );

    handlers.onClose({}, ws);
  });

  it("does not deliver turn completion notification after an aborted turn", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
    };
    const deliverNotification = vi.fn(async () => ({ ok: true }));
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getNotificationPreferences: vi.fn(() => ({ chatCompletion: "when_unfocused" })),
      deliverNotification,
      getSessionByPath: vi.fn(() => ({ entries: [], agentId: "agent-2", agentName: "小蓝" })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/aborted-session.jsonl");
    const abortStreamId = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find((payload) => payload.type === "status" && payload.isStreaming === true)?.streamId;
    subscriber?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "一半" },
    }, "/tmp/aborted-session.jsonl");
    handlers.onMessage({
      data: JSON.stringify({ type: "abort", sessionPath: "/tmp/aborted-session.jsonl", streamId: abortStreamId }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));
    subscriber?.({ type: "turn_end" }, "/tmp/aborted-session.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverNotification).not.toHaveBeenCalled();

    handlers.onClose({}, ws);
  });

  it("aborts a streaming session only after the turn has been idle past the stall timeout", async () => {
    vi.useFakeTimers();
    const prevTimeout = process.env.HANA_TURN_STALL_ABORT_MS;
    process.env.HANA_TURN_STALL_ABORT_MS = "100";
    try {
      let createHandlers;
      let subscriber;
      const upgradeWebSocket = vi.fn((factory) => {
        createHandlers = factory;
        return () => new Response(null);
      });
      const hub = {
        subscribe: vi.fn((fn) => {
          subscriber = fn;
        }),
        send: vi.fn(async () => {}),
        abort: vi.fn(async () => true),
      };
      const engine = {
        agentName: "Hana",
        abortAllStreaming: vi.fn(async () => {}),
        getNotificationPreferences: vi.fn(() => ({ chatCompletion: "never" })),
        getSessionByPath: vi.fn(() => ({ entries: [] })),
        isSessionStreaming: vi.fn(() => true),
        isSessionSwitching: vi.fn(() => false),
        steerSession: vi.fn(() => false),
        slashDispatcher: null,
      };

      createChatRoute(engine, hub, { upgradeWebSocket });
      const handlers = createHandlers({});
      const ws = { readyState: 1, send: vi.fn() };
      handlers.onOpen({}, ws);

      subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/stall-watchdog.jsonl");
      vi.advanceTimersByTime(90);
      expect(hub.abort).not.toHaveBeenCalled();

      subscriber?.({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "还在输出" },
      }, "/tmp/stall-watchdog.jsonl");
      vi.advanceTimersByTime(90);
      expect(hub.abort).not.toHaveBeenCalled();

      vi.advanceTimersByTime(10);
      await Promise.resolve();
      expect(hub.abort).toHaveBeenCalledWith("/tmp/stall-watchdog.jsonl", {
        reason: "turn_stall_timeout",
      });

      handlers.onClose({}, ws);
    } finally {
      if (prevTimeout === undefined) delete process.env.HANA_TURN_STALL_ABORT_MS;
      else process.env.HANA_TURN_STALL_ABORT_MS = prevTimeout;
      vi.useRealTimers();
    }
  });

  it("passes a user abort reason through the websocket stop path", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => false),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/user-abort.jsonl");
    const activeStreamId = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find((payload) => payload.type === "status" && payload.isStreaming === true)?.streamId;
    handlers.onMessage({
      data: JSON.stringify({ type: "abort", sessionPath: "/tmp/user-abort.jsonl", streamId: activeStreamId }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.abort).toHaveBeenCalledWith("/tmp/user-abort.jsonl", { reason: "user_abort" });
    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    const finish = payloads.find((payload) => payload.type === "status" && payload.isStreaming === false);
    expect(finish).toMatchObject({
      type: "status",
      sessionPath: "/tmp/user-abort.jsonl",
      isStreaming: false,
      aborted: true,
      reason: "user_abort",
    });
    expect(payloads).toContainEqual(expect.objectContaining({
      type: "abort_result",
      status: "already_stopped",
      sessionPath: "/tmp/user-abort.jsonl",
      streamId: activeStreamId,
    }));

    handlers.onClose({}, ws);
  });

  it("binds Stop without client stream metadata to the current server stream and replies explicitly", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => { subscriber = fn; }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);
    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/metadata-gap.jsonl");
    const activeStreamId = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find((payload) => payload.type === "status" && payload.isStreaming === true)?.streamId;

    handlers.onMessage({
      data: JSON.stringify({ type: "abort", sessionPath: "/tmp/metadata-gap.jsonl" }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.abort).toHaveBeenCalledWith("/tmp/metadata-gap.jsonl", { reason: "user_abort" });
    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toContainEqual(expect.objectContaining({
      type: "abort_result",
      status: "accepted",
      sessionPath: "/tmp/metadata-gap.jsonl",
      streamId: activeStreamId,
    }));

    handlers.onClose({}, ws);
  });

  it("rejects a delayed Stop request that names an older stream (#2078)", async () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => { subscriber = fn; }),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => true),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => true),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);
    subscriber?.({ type: "session_status", isStreaming: true }, "/tmp/stream-guard.jsonl");
    const activeStreamId = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find((payload) => payload.type === "status" && payload.isStreaming === true)?.streamId;

    handlers.onMessage({
      data: JSON.stringify({
        type: "abort",
        sessionPath: "/tmp/stream-guard.jsonl",
        streamId: "stream-older",
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hub.abort).not.toHaveBeenCalled();
    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toContainEqual(expect.objectContaining({
      type: "abort_result",
      status: "rejected",
      reason: "stale_stream",
      streamId: activeStreamId,
    }));
    expect(ws.send.mock.calls.map(([raw]) => JSON.parse(raw))).toContainEqual(expect.objectContaining({
      type: "abort_rejected",
      reason: "stale_stream",
      streamId: activeStreamId,
    }));

    handlers.onMessage({
      data: JSON.stringify({
        type: "abort",
        sessionPath: "/tmp/stream-guard.jsonl",
        streamId: activeStreamId,
      }),
    }, ws);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hub.abort).toHaveBeenCalledTimes(1);
    handlers.onClose({}, ws);
  });

  it("does not render interludes directly from standalone deferred result notifications", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    for (const taskId of ["standalone-1", "standalone-2"]) {
      subscriber?.({
        type: "deferred_result",
        taskId,
        status: "success",
        result: `result ${taskId}`,
        meta: { type: "subagent", interlude: true, executorAgentNameSnapshot: "明", label: "回执" },
      }, "/tmp/standalone-deferred.jsonl");
    }

    const interludeTaskIds = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((payload) => payload.type === "content_block" && payload.block?.type === "interlude")
      .map((payload) => payload.block.taskId);

    expect(interludeTaskIds).toEqual([]);

    handlers.onClose({}, ws);
  });

  it("emits plugin_card blocks from extension custom messages", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "message_end",
      message: {
        role: "custom",
        customType: "finance-market",
        content: "",
        display: true,
        details: {
          card: {
            pluginId: "finance-market",
            route: "/card?id=quote",
            title: "Quote",
          },
        },
      },
    }, "/tmp/plugin-card-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "content_block",
        sessionPath: "/tmp/plugin-card-session.jsonl",
        block: {
          type: "plugin_card",
          card: {
            pluginId: "finance-market",
            route: "/card?id=quote",
            title: "Quote",
            type: "iframe",
          },
        },
      }),
    ]));

    handlers.onClose({}, ws);
  });

  it("normalizes live plugin chat surface blocks before broadcasting", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      getSessionManifest: vi.fn((sessionId) => sessionId === "sess_tavern"
        ? {
          sessionId,
          currentLocator: { path: "/tmp/plugin-owned-current.jsonl" },
          plugin: { ownerPluginId: "tavern", visibility: "private" },
        }
        : null),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "message_end",
      message: {
        role: "custom",
        customType: "tavern",
        content: "",
        display: true,
        details: {
          card: {
            pluginId: "tavern",
            type: "chat.surface",
            sessionId: "sess_tavern",
            title: "Tavern run",
          },
        },
      },
    }, "/tmp/root-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "content_block",
        sessionPath: "/tmp/root-session.jsonl",
        block: {
          type: "plugin_card",
          card: {
            pluginId: "tavern",
            type: "chat.surface",
            sessionId: "sess_tavern",
            sessionPath: "/tmp/plugin-owned-current.jsonl",
            sessionRef: {
              sessionId: "sess_tavern",
              sessionPath: "/tmp/plugin-owned-current.jsonl",
            },
            title: "Tavern run",
          },
        },
      }),
    ]));

    handlers.onClose({}, ws);
  });

  it("broadcasts browser_status events emitted outside tool execution", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "browser_status",
      running: false,
      url: null,
    }, "/tmp/browser-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "browser_status",
        running: false,
        url: null,
        sessionPath: "/tmp/browser-session.jsonl",
      }),
    ]));

    handlers.onClose({}, ws);
  });

  it("broadcasts session metadata updates emitted outside tool execution", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const ws = { readyState: 1, send: vi.fn() };
    handlers.onOpen({}, ws);

    subscriber?.({
      type: "session_metadata_updated",
      metadata: { pinnedAt: "2026-04-29T08:00:00.000Z", thinkingLevel: "high" },
    }, "/tmp/metadata-session.jsonl");

    const payloads = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "session_metadata_updated",
        sessionPath: "/tmp/metadata-session.jsonl",
        metadata: {
          pinnedAt: "2026-04-29T08:00:00.000Z",
          thinkingLevel: "high",
        },
      }),
    ]));

    handlers.onClose({}, ws);
  });

  it("does not serialize broadcast payloads for closed clients", () => {
    let createHandlers;
    let subscriber;
    const upgradeWebSocket = vi.fn((factory) => {
      createHandlers = factory;
      return () => new Response(null);
    });
    const hub = {
      subscribe: vi.fn((fn) => {
        subscriber = fn;
      }),
      send: vi.fn(async () => {}),
    };
    const engine = {
      agentName: "Hana",
      abortAllStreaming: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ entries: [] })),
      isSessionStreaming: vi.fn(() => false),
      isSessionSwitching: vi.fn(() => false),
      steerSession: vi.fn(() => false),
      slashDispatcher: null,
    };

    createChatRoute(engine, hub, { upgradeWebSocket });
    const handlers = createHandlers({});
    const closedWs = { readyState: 3, send: vi.fn() };
    handlers.onOpen({}, closedWs);

    const toxicSession = {
      toJSON() {
        throw new Error("closed clients must not force serialization");
      },
    };

    expect(() => {
      subscriber?.({
        type: "session_created",
        session: toxicSession,
      }, "/tmp/closed-client-session.jsonl");
    }).not.toThrow();
    expect(closedWs.send).not.toHaveBeenCalled();

    handlers.onClose({}, closedWs);
  });
});
