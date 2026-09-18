import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/session-collab/delivery.ts", () => ({
  deliverAgentMessage: vi.fn(),
}));

import { createSessionTool } from "../lib/tools/session-tool.ts";
import { SessionCollabDraftStore } from "../lib/session-collab/draft-store.ts";
import { deliverAgentMessage } from "../lib/session-collab/delivery.ts";

// 沿用 tests/session-tool-read.test.ts 的 makeEngine/makeTool/CTX/run 模式，
// 差异：getDraftStore 返回真实 SessionCollabDraftStore 实例（不 mock，直接验 one-shot 链路），
// deliverAgentMessage 整体 mock 掉（跨 session 投递不是本文件的验证范围）。
function makeEngine(overrides: any = {}) {
  return {
    getSessionManifest: vi.fn().mockReturnValue({ currentLocator: { path: "/tmp/a.jsonl" }, ownerAgentId: "hana" }),
    resolveSessionOwnership: vi.fn().mockReturnValue({ agentId: "hana" }),
    getSessionIdForPath: vi.fn().mockReturnValue("sid-src"),
    isSessionStreaming: vi.fn().mockReturnValue(false),
    getAgent: vi.fn().mockReturnValue({ agentName: "Hana" }),
    availableModels: [
      { provider: "openai", id: "gpt-5", contextWindow: 128000 },
      { provider: "moonshot", id: "kimi-k2", contextWindow: 128000 },
    ],
    ...overrides,
  };
}

const DEFAULT_ROSTER = [{ id: "hana", name: "Hana" }, { id: "kimi", name: "Kimi" }];

function makeTool(engine: any, store: any, roster: any[] = DEFAULT_ROSTER) {
  return createSessionTool({
    getEngine: () => engine,
    getDraftStore: () => store,
    listAgents: () => roster,
    agentId: "hana",
    getAgentName: () => "Hana",
  });
}

const CTX = { sessionManager: { getSessionFile: () => "/tmp/src.jsonl" } };

async function run(tool: any, params: any) {
  return tool.execute("t1", params, undefined, undefined, CTX);
}

beforeEach(() => {
  vi.mocked(deliverAgentMessage).mockReset().mockResolvedValue({ accepted: true, targetSessionId: "x" } as any);
});

describe("session tool write side", () => {
  it("send 缺 message 报错文本含 send 用法段（draft card）", async () => {
    const store = new SessionCollabDraftStore();
    const result = await run(makeTool(makeEngine(), store), { action: "send", sessionId: "sid-a" });
    const text = result.content?.[0]?.text || "";
    expect(text).toContain("draft card");
  });

  it("send 目标=源 session 拒绝", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine({ getSessionIdForPath: vi.fn().mockReturnValue("sid-a") });
    const result = await run(makeTool(engine, store), { action: "send", sessionId: "sid-a", message: "hi" });
    const text = result.content?.[0]?.text || "";
    expect(text).toContain("current session");
  });

  it("send 成功：产草稿卡", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine();
    const result = await run(makeTool(engine, store), { action: "send", sessionId: "sid-a", message: "hi" });
    expect(result.details).toMatchObject({
      kind: "session_send_draft",
      target: { type: "session", sessionId: "sid-a" },
      draft: { targetSessionId: "sid-a", message: "hi" },
    });
    expect(typeof result.details.suggestionId).toBe("string");
    const entry = store.get(result.details.suggestionId);
    expect(entry).toBeTruthy();
    expect(entry.kind).toBe("send");
  });

  it("send 的 apply 闭包透传编辑值", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine();
    const result = await run(makeTool(engine, store), { action: "send", sessionId: "sid-a", message: "hi" });
    const suggestionId = result.details.suggestionId;
    await store.apply(suggestionId, { message: "edited" });
    expect(deliverAgentMessage).toHaveBeenCalledWith(engine, {
      targetSessionId: "sid-a",
      message: "edited",
      from: { agentId: "hana", agentName: "Hana" },
    });
  });

  it("create 的 agent 不存在", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine();
    const result = await run(makeTool(engine, store, DEFAULT_ROSTER), { action: "create", agent: "nope", message: "hi" });
    const text = result.content?.[0]?.text || "";
    expect(text).toContain("hana");
    expect(text).toContain("kimi");
  });

  it("create 成功：产草稿卡", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine();
    const result = await run(makeTool(engine, store), { action: "create", agent: "kimi", message: "hi" });
    expect(result.details).toMatchObject({
      kind: "session_create_draft",
      draft: { agentId: "kimi", model: null, title: null, firstMessage: "hi" },
    });
  });

  it("create 的 apply 闭包：建 session + 投递首条消息", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine({
      createSessionForAgent: vi.fn().mockResolvedValue({ sessionPath: "/tmp/new.jsonl", sessionId: "sid-new", agentId: "kimi" }),
      persistSessionMeta: vi.fn(),
    });
    const result = await run(makeTool(engine, store), { action: "create", agent: "kimi", message: "hi" });
    const suggestionId = result.details.suggestionId;
    const applied = await store.apply(suggestionId);
    expect(engine.createSessionForAgent).toHaveBeenCalledWith(
      "kimi", undefined, true, undefined, { workspaceFolders: [], visibleInSessionList: true },
    );
    expect(deliverAgentMessage).toHaveBeenCalledWith(engine, expect.objectContaining({ targetSessionId: "sid-new" }));
    // meta 显式落到刚建出来的会话上，不依赖调用时的焦点指针
    expect(engine.persistSessionMeta).toHaveBeenCalledWith("/tmp/new.jsonl");
    expect(applied.result).toEqual({ sessionId: "sid-new" });
  });

  it("确认时重新校验编辑后的 agent；无效值不会创建 session 或写元数据", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine({
      createSessionForAgent: vi.fn(),
      persistSessionMeta: vi.fn(),
      saveSessionTitle: vi.fn(),
    });
    const result = await run(makeTool(engine, store), { action: "create", agent: "kimi", message: "hi" });

    await expect(store.apply(result.details.suggestionId, { agentId: "deleted-agent" }))
      .rejects.toThrow("session_create_invalid_agent");

    expect(engine.createSessionForAgent).not.toHaveBeenCalled();
    expect(engine.persistSessionMeta).not.toHaveBeenCalled();
    expect(engine.saveSessionTitle).not.toHaveBeenCalled();
    expect(deliverAgentMessage).not.toHaveBeenCalled();
  });

  it("确认时重新校验 provider/id 模型；格式错误或已下线都不会创建 session", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine({
      createSessionForAgent: vi.fn(),
      persistSessionMeta: vi.fn(),
    });
    const malformed = await run(makeTool(engine, store), { action: "create", agent: "kimi", message: "hi" });
    await expect(store.apply(malformed.details.suggestionId, { model: "gpt-5" }))
      .rejects.toThrow("model must use provider/id");
    expect(engine.createSessionForAgent).not.toHaveBeenCalled();

    const unavailable = await run(makeTool(engine, store), { action: "create", agent: "kimi", message: "hi" });
    await expect(store.apply(unavailable.details.suggestionId, { model: "openai/missing" }))
      .rejects.toThrow("model is not currently available");
    expect(engine.createSessionForAgent).not.toHaveBeenCalled();
  });

  it("有效编辑模型按当前模型表解析成模型对象后再创建", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine({
      createSessionForAgent: vi.fn().mockResolvedValue({ sessionPath: "/tmp/new.jsonl", sessionId: "sid-new" }),
      persistSessionMeta: vi.fn(),
    });
    const result = await run(makeTool(engine, store), { action: "create", agent: "kimi", message: "hi" });
    await store.apply(result.details.suggestionId, { model: "moonshot/kimi-k2" });

    expect(engine.createSessionForAgent).toHaveBeenCalledWith(
      "kimi",
      undefined,
      true,
      expect.objectContaining({ provider: "moonshot", id: "kimi-k2" }),
      { workspaceFolders: [], visibleInSessionList: true },
    );
  });

  it("create 半成功：首条消息投递失败", async () => {
    const store = new SessionCollabDraftStore();
    const engine = makeEngine({
      createSessionForAgent: vi.fn().mockResolvedValue({ sessionPath: "/tmp/new.jsonl", sessionId: "sid-new", agentId: "kimi" }),
      persistSessionMeta: vi.fn(),
    });
    vi.mocked(deliverAgentMessage).mockReset().mockRejectedValue(new Error("session_busy"));
    const result = await run(makeTool(engine, store), { action: "create", agent: "kimi", message: "hi" });
    const suggestionId = result.details.suggestionId;
    const applying = store.apply(suggestionId);
    await expect(applying).rejects.toMatchObject({
      code: "first_message_failed",
      partialSuccess: true,
      sessionId: "sid-new",
      result: {
        sessionId: "sid-new",
        sessionCreated: true,
        firstMessageAccepted: false,
        retryMessage: "hi",
        retryable: true,
      },
    });
    expect(store.get(suggestionId)).toMatchObject({
      partialResult: { sessionId: "sid-new", retryable: true },
    });

    vi.mocked(deliverAgentMessage).mockResolvedValueOnce({ accepted: true, targetSessionId: "sid-new" } as any);
    await expect(store.apply(suggestionId, { firstMessage: "retry edited" }))
      .resolves.toMatchObject({ ok: true, result: { sessionId: "sid-new" } });
    expect(engine.createSessionForAgent).toHaveBeenCalledTimes(1);
    expect(deliverAgentMessage).toHaveBeenLastCalledWith(engine, expect.objectContaining({
      targetSessionId: "sid-new",
      message: "retry edited",
    }));
    expect(store.get(suggestionId)).toBeNull();
  });
});
