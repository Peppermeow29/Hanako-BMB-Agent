import { Hono } from "hono";
import { describe, it, expect, vi } from "vitest";
import { createSessionCollabRoute } from "../server/routes/session-collab.ts";
import { SessionCollabDraftStore } from "../lib/session-collab/draft-store.ts";
import {
  SESSION_COLLAB_DECISION_RECORD_TYPE,
  buildSessionCollabDecision,
} from "../lib/session-collab/decision-record.ts";
import {
  collectSessionCollabDecisions,
  overlaySessionCollabDecision,
} from "../core/message-utils.ts";

function makeApp(engine: any) {
  const app = new Hono();
  app.route("/", createSessionCollabRoute(engine));
  return app;
}

function post(app: Hono, path: string, body: any) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeEngineWithSession(appendCustomEntry: any, sessionPath = "/agents/hana/sessions/src.jsonl") {
  return {
    getSessionManifest: vi.fn(() => ({ currentLocator: { path: sessionPath } })),
    ensureSessionLoaded: vi.fn(async () => ({ sessionManager: { appendCustomEntry } })),
  };
}

describe("buildSessionCollabDecision", () => {
  it("approved 不带 resultSessionId：形态最小化", () => {
    const decision = buildSessionCollabDecision({ suggestionId: "s1", status: "approved" });
    expect(decision).toMatchObject({ suggestionId: "s1", status: "approved" });
    expect(decision.resultSessionId).toBeUndefined();
    expect(typeof decision.timestamp).toBe("number");
  });

  it("approved 带 resultSessionId（create 成功）", () => {
    const decision = buildSessionCollabDecision({
      suggestionId: "s2",
      status: "approved",
      resultSessionId: "new-sid",
    });
    expect(decision.resultSessionId).toBe("new-sid");
  });

  it("rejected：status 归一化为 rejected，忽略 resultSessionId", () => {
    const decision = buildSessionCollabDecision({
      suggestionId: "s3",
      status: "rejected",
      resultSessionId: "should-not-appear",
    } as any);
    expect(decision.status).toBe("rejected");
  });

  it("非法 status 一律归一化为 rejected（保守写侧）", () => {
    const decision = buildSessionCollabDecision({ suggestionId: "s4", status: "bogus" as any });
    expect(decision.status).toBe("rejected");
  });
});

describe("session-collab apply route：决策持久化", () => {
  it("apply 成功后调用 appendCustomEntry 写入 approved 决策，响应带 decisionPersisted:true", async () => {
    const appendCustomEntry = vi.fn();
    const engine: any = makeEngineWithSession(appendCustomEntry);
    const store = new SessionCollabDraftStore();
    engine.sessionCollabDraftStore = store;
    const entry = store.create({
      kind: "send",
      sourceSessionId: "sid-src",
      draft: { targetSessionId: "sid-a", message: "hi" },
      apply: async () => ({ accepted: true, targetSessionId: "sid-a" }),
    });
    const app = makeApp(engine);
    const res = await post(app, "/session-collab/apply", { suggestionId: entry.suggestionId });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, decisionPersisted: true });
    expect(engine.getSessionManifest).toHaveBeenCalledWith("sid-src");
    expect(appendCustomEntry).toHaveBeenCalledTimes(1);
    const [customType, payload] = appendCustomEntry.mock.calls[0];
    expect(customType).toBe(SESSION_COLLAB_DECISION_RECORD_TYPE);
    expect(payload).toMatchObject({ suggestionId: entry.suggestionId, status: "approved" });
  });

  it("apply 成功但 appendCustomEntry 抛错：响应仍 200，decisionPersisted:false", async () => {
    const appendCustomEntry = vi.fn(() => { throw new Error("disk full"); });
    const engine: any = makeEngineWithSession(appendCustomEntry);
    const store = new SessionCollabDraftStore();
    engine.sessionCollabDraftStore = store;
    const entry = store.create({
      kind: "send",
      sourceSessionId: "sid-src",
      draft: { targetSessionId: "sid-a", message: "hi" },
      apply: async () => ({ accepted: true }),
    });
    const app = makeApp(engine);
    const res = await post(app, "/session-collab/apply", { suggestionId: entry.suggestionId });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.decisionPersisted).toBe(false);
  });

  it("apply 成功且 create 产出 resultSessionId：决策记录带 resultSessionId", async () => {
    const appendCustomEntry = vi.fn();
    const engine: any = makeEngineWithSession(appendCustomEntry);
    const store = new SessionCollabDraftStore();
    engine.sessionCollabDraftStore = store;
    const entry = store.create({
      kind: "create",
      sourceSessionId: "sid-src",
      draft: { agentId: "kimi", firstMessage: "hi" },
      apply: async () => ({ sessionId: "sid-new" }),
    });
    const app = makeApp(engine);
    await post(app, "/session-collab/apply", { suggestionId: entry.suggestionId });
    const [, payload] = appendCustomEntry.mock.calls[0];
    expect(payload).toMatchObject({ status: "approved", resultSessionId: "sid-new" });
  });

  it("Fork child 的独立 handle 只把 approved 决策写入 child session", async () => {
    const sourceAppend = vi.fn();
    const childAppend = vi.fn();
    const engine: any = {
      getSessionManifest: vi.fn((sessionId) => ({
        currentLocator: {
          path: sessionId === "sid-child"
            ? "/agents/hana/sessions/child.jsonl"
            : "/agents/hana/sessions/source.jsonl",
        },
      })),
      ensureSessionLoaded: vi.fn(async (sessionPath) => ({
        sessionManager: {
          appendCustomEntry: sessionPath.endsWith("child.jsonl") ? childAppend : sourceAppend,
        },
      })),
    };
    const store = new SessionCollabDraftStore();
    engine.sessionCollabDraftStore = store;
    const source = store.create({
      kind: "send",
      sourceSessionId: "sid-source",
      draft: { targetSessionId: "sid-a", message: "hi" },
      apply: async () => ({ accepted: true }),
    });
    const forked = store.forkSessionDrafts({
      sourceSessionId: "sid-source",
      targetSessionId: "sid-child",
      targetSessionPath: "/agents/hana/sessions/child.jsonl",
      retainedEntries: [{ details: { suggestionId: source.suggestionId } }],
    });
    const childSuggestionId = forked.suggestionIdMap[source.suggestionId];

    const app = makeApp(engine);
    const res = await post(app, "/session-collab/apply", { suggestionId: childSuggestionId });

    expect(res.status).toBe(200);
    expect(engine.getSessionManifest).toHaveBeenCalledWith("sid-child");
    expect(childAppend).toHaveBeenCalledWith(
      SESSION_COLLAB_DECISION_RECORD_TYPE,
      expect.objectContaining({ suggestionId: childSuggestionId, status: "approved" }),
    );
    expect(sourceAppend).not.toHaveBeenCalled();
    expect(store.get(source.suggestionId)).toBeTruthy();
  });
});

describe("session-collab reject route", () => {
  it("Fork child 的独立 handle 只把 rejected 决策写入 child session", async () => {
    const sourceAppend = vi.fn();
    const childAppend = vi.fn();
    const engine: any = {
      getSessionManifest: vi.fn((sessionId) => ({
        currentLocator: {
          path: sessionId === "sid-child"
            ? "/agents/hana/sessions/child.jsonl"
            : "/agents/hana/sessions/source.jsonl",
        },
      })),
      ensureSessionLoaded: vi.fn(async (sessionPath) => ({
        sessionManager: {
          appendCustomEntry: sessionPath.endsWith("child.jsonl") ? childAppend : sourceAppend,
        },
      })),
    };
    const store = new SessionCollabDraftStore();
    engine.sessionCollabDraftStore = store;
    const source = store.create({
      kind: "send",
      sourceSessionId: "sid-source",
      draft: { targetSessionId: "sid-a", message: "hi" },
      apply: vi.fn(),
    });
    const forked = store.forkSessionDrafts({
      sourceSessionId: "sid-source",
      targetSessionId: "sid-child",
      targetSessionPath: "/agents/hana/sessions/child.jsonl",
      retainedEntries: [{ details: { suggestionId: source.suggestionId } }],
    });
    const childSuggestionId = forked.suggestionIdMap[source.suggestionId];

    const app = makeApp(engine);
    const res = await post(app, "/session-collab/reject", { suggestionId: childSuggestionId });

    expect(res.status).toBe(200);
    expect(engine.getSessionManifest).toHaveBeenCalledWith("sid-child");
    expect(childAppend).toHaveBeenCalledWith(
      SESSION_COLLAB_DECISION_RECORD_TYPE,
      expect.objectContaining({ suggestionId: childSuggestionId, status: "rejected" }),
    );
    expect(sourceAppend).not.toHaveBeenCalled();
    expect(store.get(source.suggestionId)).toBeTruthy();
  });

  it("有条目：discard 被调用，决策 rejected 落到 appendCustomEntry", async () => {
    const appendCustomEntry = vi.fn();
    const engine: any = makeEngineWithSession(appendCustomEntry);
    const store = new SessionCollabDraftStore();
    engine.sessionCollabDraftStore = store;
    const entry = store.create({
      kind: "send",
      sourceSessionId: "sid-src",
      draft: { targetSessionId: "sid-a", message: "hi" },
      apply: vi.fn(),
    });
    const app = makeApp(engine);
    const res = await post(app, "/session-collab/reject", { suggestionId: entry.suggestionId });
    expect(res.status).toBe(200);
    expect((await res.json())).toMatchObject({ ok: true, decisionPersisted: true });
    expect(store.get(entry.suggestionId)).toBeNull();
    const [customType, payload] = appendCustomEntry.mock.calls[0];
    expect(customType).toBe(SESSION_COLLAB_DECISION_RECORD_TYPE);
    expect(payload).toMatchObject({ suggestionId: entry.suggestionId, status: "rejected" });
  });

  it("无条目（过期卡）但带 sourceSessionId：仍记录决策", async () => {
    const appendCustomEntry = vi.fn();
    const engine: any = makeEngineWithSession(appendCustomEntry);
    engine.sessionCollabDraftStore = new SessionCollabDraftStore();
    const app = makeApp(engine);
    const res = await post(app, "/session-collab/reject", { suggestionId: "expired-1", sourceSessionId: "sid-src" });
    expect(res.status).toBe(200);
    expect(engine.getSessionManifest).toHaveBeenCalledWith("sid-src");
    expect(appendCustomEntry).toHaveBeenCalledTimes(1);
  });

  it("无条目且无 sourceSessionId：400", async () => {
    const engine: any = { sessionCollabDraftStore: new SessionCollabDraftStore() };
    const app = makeApp(engine);
    const res = await post(app, "/session-collab/reject", { suggestionId: "expired-2" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("expired draft reject requires sourceSessionId");
  });

  it("in-flight 条目：409 draft_in_flight，决策不写入", async () => {
    const appendCustomEntry = vi.fn();
    const engine: any = makeEngineWithSession(appendCustomEntry);
    const store = new SessionCollabDraftStore();
    engine.sessionCollabDraftStore = store;
    let releasePending: () => void = () => {};
    const pending = new Promise<void>((resolve) => { releasePending = resolve; });
    const entry = store.create({
      kind: "send",
      sourceSessionId: "sid-src",
      draft: { targetSessionId: "sid-a", message: "hi" },
      apply: async () => { await pending; return { accepted: true }; },
    });
    const app = makeApp(engine);
    const applyReq = post(app, "/session-collab/apply", { suggestionId: entry.suggestionId });
    await new Promise((r) => setTimeout(r, 10));
    const rejectRes = await post(app, "/session-collab/reject", { suggestionId: entry.suggestionId });
    expect(rejectRes.status).toBe(409);
    expect((await rejectRes.json()).code).toBe("draft_in_flight");
    expect(appendCustomEntry).not.toHaveBeenCalled();
    releasePending();
    await applyReq;
  });

  it("body 非 JSON：400", async () => {
    const engine: any = { sessionCollabDraftStore: new SessionCollabDraftStore() };
    const app = makeApp(engine);
    const res = await app.request("/session-collab/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    expect(res.status).toBe(400);
  });

  it("draft store unavailable：500", async () => {
    const app = makeApp({});
    const res = await post(app, "/session-collab/reject", { suggestionId: "x" });
    expect(res.status).toBe(500);
  });
});

describe("suggestion_card 决策覆盖（历史重建，pure function）", () => {
  it("collectSessionCollabDecisions 从消息流收集决策，按 suggestionId 建索引", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "custom",
        customType: SESSION_COLLAB_DECISION_RECORD_TYPE,
        display: false,
        data: buildSessionCollabDecision({ suggestionId: "s1", status: "approved", resultSessionId: "sid-new" }),
      },
      { role: "assistant", content: "ok" },
    ];
    const map = collectSessionCollabDecisions(messages);
    expect(map.get("s1")).toMatchObject({ status: "approved", resultSessionId: "sid-new" });
    expect(map.has("s2")).toBe(false);
  });

  it("collectSessionCollabDecisions 忽略非本类型的 custom 消息", () => {
    const map = collectSessionCollabDecisions([
      { role: "custom", customType: "some-other-type", data: { suggestionId: "s1" } },
    ]);
    expect(map.size).toBe(0);
  });

  it("overlaySessionCollabDecision 命中时覆盖 status 并附 resultSessionId", () => {
    const decisions = collectSessionCollabDecisions([
      {
        role: "custom",
        customType: SESSION_COLLAB_DECISION_RECORD_TYPE,
        data: buildSessionCollabDecision({ suggestionId: "s1", status: "approved", resultSessionId: "sid-new" }),
      },
    ]);
    const block = { type: "suggestion_card", suggestionId: "s1", status: "pending", kind: "session_create_draft" };
    const overlaid = overlaySessionCollabDecision(block, decisions);
    expect(overlaid).toMatchObject({ status: "approved", resultSessionId: "sid-new", kind: "session_create_draft" });
  });

  it("overlaySessionCollabDecision 命中 rejected 时覆盖 status，无 resultSessionId 字段", () => {
    const decisions = collectSessionCollabDecisions([
      {
        role: "custom",
        customType: SESSION_COLLAB_DECISION_RECORD_TYPE,
        data: buildSessionCollabDecision({ suggestionId: "s1", status: "rejected" }),
      },
    ]);
    const block = { type: "suggestion_card", suggestionId: "s1", status: "pending" };
    const overlaid = overlaySessionCollabDecision(block, decisions);
    expect(overlaid.status).toBe("rejected");
    expect(overlaid).not.toHaveProperty("resultSessionId");
  });

  it("overlaySessionCollabDecision 未命中决策时原样返回", () => {
    const decisions = collectSessionCollabDecisions([]);
    const block = { type: "suggestion_card", suggestionId: "s1", status: "pending" };
    expect(overlaySessionCollabDecision(block, decisions)).toBe(block);
  });

  it("overlaySessionCollabDecision 对非 suggestion_card block 原样返回", () => {
    const decisions = collectSessionCollabDecisions([
      {
        role: "custom",
        customType: SESSION_COLLAB_DECISION_RECORD_TYPE,
        data: buildSessionCollabDecision({ suggestionId: "s1", status: "approved" }),
      },
    ]);
    const block = { type: "subagent", suggestionId: "s1" };
    expect(overlaySessionCollabDecision(block, decisions)).toBe(block);
  });
});
