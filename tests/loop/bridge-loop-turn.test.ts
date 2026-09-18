/**
 * 桥接主动外呼轮（executeLoopTurn）与会话确保/解析（bridge-session-manager）。
 *
 * executeLoopTurn 用「借用方法 + 假 this」驱动：只验证外呼轮自身的编排
 * （互斥锁、平台定位、结果消费镜像入站路径），不拉起真实平台适配器。
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionManagerCreateMock = vi.fn();
const sessionManagerOpenMock = vi.fn();
const createAgentSessionMock = vi.fn();

vi.mock("../../lib/pi-sdk/index.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    createAgentSession: (...args: any[]) => createAgentSessionMock(...args),
    SessionManager: {
      ...actual.SessionManager,
      create: (...args: any[]) => sessionManagerCreateMock(...args),
      open: (...args: any[]) => sessionManagerOpenMock(...args),
    },
  };
});

import { BridgeManager } from "../../lib/bridge/bridge-manager.ts";
import { BridgeSessionManager } from "../../core/bridge-session-manager.ts";

function makeFakeThis(overrides: any = {}) {
  const sent: any[] = [];
  const finished: any[] = [];
  const failed: any[] = [];
  const pushed: any[] = [];
  const media: any[] = [];
  const adapter = { sendReply: vi.fn() };
  return {
    sent,
    finished,
    failed,
    pushed,
    media,
    adapter,
    _processing: new Set<string>(),
    _pending: new Map<string, any>(),
    engine: { isBridgeSessionStreaming: () => false, getAgent: () => ({ agentName: "A" }), agentName: "A" },
    _platformFromSessionKey: BridgeManager.prototype._platformFromSessionKey,
    _chatIdFromBridgeSessionKey: BridgeManager.prototype._chatIdFromBridgeSessionKey,
    _appendMediaItems: BridgeManager.prototype._appendMediaItems,
    _findPlatformEntry: () => ({ adapter }),
    _createStreamDelivery: vi.fn(() => ({
      mode: "batch",
      onDelta: () => {},
      finish: async (text: string) => { finished.push(text); return []; },
      fail: async (text: string) => { failed.push(text); },
    })),
    _cleanReplyForPlatform: (t: string) => t,
    _sendMediaItem: vi.fn(async (_adapter: any, chatId: string, item: any, context: any) => {
      media.push([chatId, item, context]);
    }),
    _sendAdapterReply: vi.fn(),
    _describeMediaSource: () => "media",
    _mediaDelivery: { sendFailureNotice: vi.fn() },
    _pushMessage: (entry: any) => { pushed.push(entry); },
    _hub: {
      send: vi.fn(async (text: string, opts: any) => {
        sent.push([text, opts]);
        return { text: "reply text", toolMedia: [] };
      }),
    },
    ...overrides,
  };
}

const exec = (fakeThis: any, ...args: any[]) =>
  (BridgeManager.prototype as any).executeLoopTurn.call(fakeThis, ...args);

describe("BridgeManager.executeLoopTurn", () => {
  it("runs a full outbound turn and returns triggerTurn", async () => {
    const ft = makeFakeThis();
    const r = await exec(ft, "tg_dm_1@a1", "<hana-loop wake>", { agentId: "a1" });
    expect(r).toEqual({ mode: "triggerTurn" });
    expect(ft.sent[0][0]).toBe("<hana-loop wake>");
    expect(ft.sent[0][1]).toMatchObject({ sessionKey: "tg_dm_1@a1", agentId: "a1", role: "owner" });
    expect(ft.finished).toEqual(["reply text"]);
    expect(ft._processing.size).toBe(0);           // 锁已释放
    expect(ft.pushed[0]).toMatchObject({ direction: "out", sessionKey: "tg_dm_1@a1", text: "reply text" });
  });

  it("passes the full stream delivery shape for a dm target", async () => {
    const ft = makeFakeThis();
    await exec(ft, "tg_dm_1@a1", "p", { agentId: "a1" });
    expect(ft._createStreamDelivery).toHaveBeenCalledWith({
      adapter: ft.adapter,
      chatId: "1",
      isGroup: false,
      platform: "tg",
      messageThreadId: null,
      replyContext: null,
    });
  });

  it("returns busy when the sessionKey is locked, buffered, or streaming", async () => {
    const locked = makeFakeThis();
    locked._processing.add("tg_dm_1@a1");
    expect(await exec(locked, "tg_dm_1@a1", "p", { agentId: "a1" })).toEqual({ mode: "busy" });

    const buffered = makeFakeThis();
    buffered._pending.set("tg_dm_1@a1", { lines: ["hi"], attachments: [] });
    expect(await exec(buffered, "tg_dm_1@a1", "p", { agentId: "a1" })).toEqual({ mode: "busy" });

    const queued = makeFakeThis();
    queued._pending.set("tg_dm_1@a1", { kind: "group-queue", batches: [{ lines: ["hi"] }] });
    expect(await exec(queued, "tg_dm_1@a1", "p", { agentId: "a1" })).toEqual({ mode: "busy" });

    const streaming = makeFakeThis({
      engine: { isBridgeSessionStreaming: () => true, getAgent: () => null, agentName: "A" },
    });
    expect(await exec(streaming, "tg_dm_1@a1", "p", { agentId: "a1" })).toEqual({ mode: "busy" });
  });

  it("ignores an emptied buffer left behind by a finished flush", async () => {
    const ft = makeFakeThis();
    ft._pending.set("tg_dm_1@a1", { lines: [], attachments: [] });
    expect(await exec(ft, "tg_dm_1@a1", "p", { agentId: "a1" })).toEqual({ mode: "triggerTurn" });
  });

  it("throws when the platform is unavailable", async () => {
    const ft = makeFakeThis({ _findPlatformEntry: () => null });
    await expect(exec(ft, "tg_dm_1@a1", "p", { agentId: "a1" })).rejects.toThrow(/unavailable/);
    expect(ft._processing.size).toBe(0);
  });

  it("releases the lock even when hub.send throws", async () => {
    const ft = makeFakeThis({
      _hub: { send: vi.fn(async () => { throw new Error("send boom"); }) },
    });
    await expect(exec(ft, "tg_dm_1@a1", "p", { agentId: "a1" })).rejects.toThrow(/send boom/);
    expect(ft._processing.size).toBe(0);
  });

  it("sends a failure notice instead of body text when the turn only produced an error", async () => {
    const ft = makeFakeThis({
      _hub: { send: vi.fn(async () => ({ text: null, toolMedia: [], error: "provider exploded" })) },
    });
    const r = await exec(ft, "tg_dm_1@a1", "p", { agentId: "a1" });
    expect(r).toEqual({ mode: "triggerTurn" });
    expect(ft.finished).toEqual([]);
    expect(ft.failed).toHaveLength(1);
    // 低层错误字符串只进日志，不作为聊天正文
    expect(ft.failed[0]).not.toContain("provider exploded");
  });

  it("delivers tool media with the inbound context shape", async () => {
    // 媒体项规范化会对 filePath 做 path.resolve，绝对路径的形态是平台相关的
    // （Windows 上 "/tmp/a.png" 会补上当前盘符）。先 resolve 一次再喂进去，
    // 断言就跟着平台走，且 resolve 幂等，不改变这条用例要验的编排行为。
    const mediaPath = path.resolve("/tmp/a.png");
    const ft = makeFakeThis({
      _hub: { send: vi.fn(async () => ({ text: "body", toolMedia: [{ type: "legacy_local_path", filePath: mediaPath }] })) },
    });
    await exec(ft, "tg_dm_1@a1", "p", { agentId: "a1" });
    expect(ft.media).toHaveLength(1);
    const [chatId, item, context] = ft.media[0];
    expect(chatId).toBe("1");
    expect(item).toMatchObject({ filePath: mediaPath });
    expect(context).toEqual({ platform: "tg", isGroup: false, agentId: "a1", replyContext: null });
  });
});

// ── bridge-session-manager：sessionKey → sessionId 解析与会话确保 ──

function makeAgent(rootDir, id = "agent-a") {
  const sessionDir = path.join(rootDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  return {
    id,
    agentName: "Agent A",
    sessionDir,
    config: { locale: "", models: { chat: { id: "gpt-4o", provider: "openai" } }, bridge: {} },
    buildSystemPrompt: () => "system prompt",
  };
}

function makeDeps(agent, rootCwd) {
  const sessionIdsByPath = new Map<string, string>();
  const ensureSessionRefForPath = vi.fn((sessionPath) => {
    const sessionId = sessionIdsByPath.get(sessionPath)
      || `sess_${path.basename(sessionPath, path.extname(sessionPath))}`;
    sessionIdsByPath.set(sessionPath, sessionId);
    return { sessionId, sessionPath };
  });
  return {
    sessionIdsByPath,
    getAgent: () => agent,
    getAgentById: (id) => (id === agent.id ? agent : null),
    getAgents: () => new Map([[agent.id, agent]]),
    getModelManager: () => ({ availableModels: [], authStorage: {}, modelRegistry: {} }),
    getResourceLoader: () => ({}),
    getPreferences: () => ({}),
    buildTools: () => ({ tools: [], customTools: [] }),
    getHomeCwd: () => rootCwd,
    ensureSessionRefForPath,
    getSessionIdForPath: vi.fn((sessionPath) => sessionIdsByPath.get(sessionPath) || null),
    applySessionBranchHead: vi.fn(),
    syncSessionBranchHead: vi.fn(),
  };
}

describe("BridgeSessionManager session identity by sessionKey", () => {
  let rootDir;
  let rootCwd;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-loop-session-"));
    rootCwd = path.join(rootDir, "cwd");
    fs.mkdirSync(rootCwd, { recursive: true });
    sessionManagerCreateMock.mockReset();
    sessionManagerOpenMock.mockReset();
    createAgentSessionMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function seedIndex(agent, entries) {
    const dir = path.join(agent.sessionDir, "bridge");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bridge-sessions.json"), JSON.stringify(entries, null, 2));
  }

  it("resolves the sessionId behind an index entry (string and object forms)", () => {
    const agent = makeAgent(rootDir);
    const deps = makeDeps(agent, rootCwd);
    const manager = new BridgeSessionManager(deps);
    const legacyPath = path.join(agent.sessionDir, "bridge", "owner", "legacy.jsonl");
    const objectPath = path.join(agent.sessionDir, "bridge", "owner", "modern.jsonl");
    deps.sessionIdsByPath.set(legacyPath, "sess_legacy");
    deps.sessionIdsByPath.set(objectPath, "sess_modern");
    seedIndex(agent, {
      "tg_dm_1@agent-a": "owner/legacy.jsonl",
      "tg_dm_2@agent-a": { file: "owner/modern.jsonl", role: "owner" },
    });

    expect(manager.resolveSessionIdForSessionKey("tg_dm_1@agent-a", agent)).toBe("sess_legacy");
    expect(manager.resolveSessionIdForSessionKey("tg_dm_2@agent-a", agent)).toBe("sess_modern");
  });

  it("returns null without touching the index when the key or file is unknown", () => {
    const agent = makeAgent(rootDir);
    const deps = makeDeps(agent, rootCwd);
    const manager = new BridgeSessionManager(deps);
    seedIndex(agent, { "tg_dm_3@agent-a": { role: "owner" } });

    expect(manager.resolveSessionIdForSessionKey("tg_dm_missing@agent-a", agent)).toBe(null);
    expect(manager.resolveSessionIdForSessionKey("tg_dm_3@agent-a", agent)).toBe(null);
    expect(manager.resolveSessionIdForSessionKey("", agent)).toBe(null);
    expect(manager.resolveSessionIdForSessionKey("tg_dm_1@agent-a", null)).toBe(null);
    // 未解析出 sessionId 时不得创建会话
    expect(sessionManagerCreateMock).not.toHaveBeenCalled();
  });

  it("resolves the absolute jsonl path behind an index entry, or null when absent", () => {
    const agent = makeAgent(rootDir);
    const deps = makeDeps(agent, rootCwd);
    const manager = new BridgeSessionManager(deps);
    seedIndex(agent, {
      "tg_dm_1@agent-a": "owner/legacy.jsonl",
      "tg_dm_2@agent-a": { file: "owner/modern.jsonl", role: "owner" },
      "tg_dm_3@agent-a": { role: "owner" },
    });

    expect(manager.resolveSessionPathForSessionKey("tg_dm_1@agent-a", agent))
      .toBe(path.join(agent.sessionDir, "bridge", "owner", "legacy.jsonl"));
    expect(manager.resolveSessionPathForSessionKey("tg_dm_2@agent-a", agent))
      .toBe(path.join(agent.sessionDir, "bridge", "owner", "modern.jsonl"));
    expect(manager.resolveSessionPathForSessionKey("tg_dm_3@agent-a", agent)).toBe(null);
    expect(manager.resolveSessionPathForSessionKey("tg_dm_missing@agent-a", agent)).toBe(null);
    expect(manager.resolveSessionPathForSessionKey("", agent)).toBe(null);
    expect(manager.resolveSessionPathForSessionKey("tg_dm_1@agent-a", null)).toBe(null);
    // 只读解析：不得创建会话
    expect(sessionManagerCreateMock).not.toHaveBeenCalled();
  });

  it("creates the session entity for an empty chat and returns its sessionId", async () => {
    const agent = makeAgent(rootDir);
    const deps = makeDeps(agent, rootCwd);
    const manager = new BridgeSessionManager(deps);
    const createdPath = path.join(agent.sessionDir, "bridge", "owner", "created.jsonl");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => createdPath });

    const sessionId = await manager.ensureSessionForSessionKey("tg_dm_9@agent-a", agent);

    expect(sessionId).toBe("sess_created");
    expect(sessionManagerCreateMock).toHaveBeenCalledWith(rootCwd, path.join(agent.sessionDir, "bridge", "owner"));
    // 不跑轮：不建 agent session
    expect(createAgentSessionMock).not.toHaveBeenCalled();
    const index = JSON.parse(fs.readFileSync(path.join(agent.sessionDir, "bridge", "bridge-sessions.json"), "utf8"));
    expect(index["tg_dm_9@agent-a"]).toMatchObject({ file: "owner/created.jsonl" });
    // 写回后可直接解析
    expect(manager.resolveSessionIdForSessionKey("tg_dm_9@agent-a", agent)).toBe("sess_created");
  });

  it("reuses an existing session file instead of creating a new one", async () => {
    const agent = makeAgent(rootDir);
    const deps = makeDeps(agent, rootCwd);
    const manager = new BridgeSessionManager(deps);
    const existingPath = path.join(agent.sessionDir, "bridge", "owner", "existing.jsonl");
    fs.mkdirSync(path.dirname(existingPath), { recursive: true });
    fs.writeFileSync(existingPath, "");
    deps.sessionIdsByPath.set(existingPath, "sess_existing");
    seedIndex(agent, { "tg_dm_7@agent-a": { file: "owner/existing.jsonl", role: "owner" } });
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => existingPath });

    const sessionId = await manager.ensureSessionForSessionKey("tg_dm_7@agent-a", agent);

    expect(sessionId).toBe("sess_existing");
    expect(sessionManagerOpenMock).toHaveBeenCalled();
    expect(sessionManagerCreateMock).not.toHaveBeenCalled();
  });
});
