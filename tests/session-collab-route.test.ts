import { Hono } from "hono";
import { describe, it, expect } from "vitest";
import { createSessionCollabRoute } from "../server/routes/session-collab.ts";
import {
  SessionCollabDraftStore,
  SessionCollabPartialSuccessError,
} from "../lib/session-collab/draft-store.ts";

function makeApp(store: SessionCollabDraftStore) {
  const engine = { sessionCollabDraftStore: store };
  const app = new Hono();
  app.route("/", createSessionCollabRoute(engine));
  return app;
}

function post(app: Hono, body: any) {
  return app.request("/session-collab/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("session-collab apply route", () => {
  it("成功：200 ok + result，条目已删", async () => {
    const store = new SessionCollabDraftStore();
    const entry = store.create({
      kind: "send",
      sourceSessionId: "sid-src",
      draft: { targetSessionId: "sid-a", message: "hi" },
      apply: async () => ({ accepted: true, targetSessionId: "sid-a" }),
    });
    const app = makeApp(store);
    const res = await post(app, { suggestionId: entry.suggestionId });
    expect(res.status).toBe(200);
    // decisionPersisted:false 是预期的——这里的 engine mock 没有 getSessionManifest/
    // ensureSessionLoaded，决策持久化优雅降级（灰测修复 C）。持久化成功路径的覆盖
    // 见 tests/session-collab-decision.test.ts（带完整 engine mock）。
    expect(await res.json()).toEqual({
      ok: true,
      result: { accepted: true, targetSessionId: "sid-a" },
      decisionPersisted: false,
    });
    expect(store.get(entry.suggestionId)).toBeNull();
  });

  it("未知 suggestionId：404 draft_expired", async () => {
    const store = new SessionCollabDraftStore();
    const app = makeApp(store);
    const res = await post(app, { suggestionId: "nope" });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("draft_expired");
  });

  it("闭包抛普通错：500 apply_failed，条目仍在（可重试）", async () => {
    const store = new SessionCollabDraftStore();
    const entry = store.create({
      kind: "send",
      sourceSessionId: "sid-src",
      draft: { targetSessionId: "sid-a", message: "hi" },
      apply: async () => { throw new Error("boom"); },
    });
    const app = makeApp(store);
    const res = await post(app, { suggestionId: entry.suggestionId });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.code).toBe("apply_failed");
    expect(json.error).toBe("boom");
    expect(store.get(entry.suggestionId)).toBeTruthy();
  });

  it("闭包抛 first_message_failed:sid-new:xxx：500 first_message_failed 带 sessionId", async () => {
    const store = new SessionCollabDraftStore();
    const entry = store.create({
      kind: "create",
      sourceSessionId: "sid-src",
      draft: { agentId: "kimi", firstMessage: "hi" },
      apply: async () => { throw new Error("first_message_failed:sid-new:session_busy"); },
    });
    const app = makeApp(store);
    const res = await post(app, { suggestionId: entry.suggestionId });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.code).toBe("first_message_failed");
    expect(json.sessionId).toBe("sid-new");
  });

  it("结构化部分成功响应带新 session，并把同一草稿安全切换成消息重试", async () => {
    const store = new SessionCollabDraftStore();
    const retry = async () => ({ sessionId: "sid-new" });
    const entry = store.create({
      kind: "create",
      sourceSessionId: "sid-src",
      draft: { agentId: "kimi", firstMessage: "please retry" },
      apply: async () => {
        throw new SessionCollabPartialSuccessError(
          "sid-new",
          new Error("prompt preflight rejected"),
          "please retry",
          retry,
        );
      },
    });
    const app = makeApp(store);
    const res = await post(app, { suggestionId: entry.suggestionId });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      ok: false,
      partialSuccess: true,
      code: "first_message_failed",
      sessionId: "sid-new",
      result: {
        sessionId: "sid-new",
        sessionCreated: true,
        firstMessageAccepted: false,
        retryMessage: "please retry",
        retryable: true,
      },
    });
    expect(store.get(entry.suggestionId)).toMatchObject({
      partialResult: { sessionId: "sid-new", retryable: true },
    });
    const retried = await post(app, { suggestionId: entry.suggestionId, draft: { firstMessage: "please retry" } });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ ok: true, result: { sessionId: "sid-new" } });
    expect(store.get(entry.suggestionId)).toBeNull();
  });

  it("in-flight 并发：409 draft_in_flight", async () => {
    const store = new SessionCollabDraftStore();
    let releasePending: () => void = () => {};
    const pending = new Promise<void>((resolve) => { releasePending = resolve; });
    const entry = store.create({
      kind: "send",
      sourceSessionId: "sid-src",
      draft: { targetSessionId: "sid-a", message: "hi" },
      apply: async () => { await pending; return { accepted: true, targetSessionId: "sid-a" }; },
    });
    const app = makeApp(store);
    const firstReq = post(app, { suggestionId: entry.suggestionId });
    // 让第一个请求先进入 store.apply 并挂起（entry._applying 置位）再发第二个请求
    await new Promise((r) => setTimeout(r, 10));
    const res2 = await post(app, { suggestionId: entry.suggestionId });
    expect(res2.status).toBe(409);
    expect((await res2.json()).code).toBe("draft_in_flight");
    releasePending();
    const res1 = await firstReq;
    expect(res1.status).toBe(200);
  });

  it("body 非 JSON：400", async () => {
    const store = new SessionCollabDraftStore();
    const app = makeApp(store);
    const res = await app.request("/session-collab/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    expect(res.status).toBe(400);
  });
});
