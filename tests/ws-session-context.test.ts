import { describe, expect, it, vi } from "vitest";

import { resolveWsSessionContext } from "../server/routes/ws-session-context.ts";

function makeEngine({
  pathSessionId = null,
  manifest = null,
  ownership = null,
}: {
  pathSessionId?: any;
  manifest?: any;
  ownership?: any;
} = {}) {
  return {
    getSessionIdForPath: vi.fn(() => pathSessionId),
    getSessionManifest: vi.fn(() => manifest),
    resolveSessionOwnership: vi.fn(() => ownership),
  };
}

describe("resolveWsSessionContext", () => {
  it("rejects a message that carries no identity at all as an internal contract violation", () => {
    const engine = makeEngine();

    expect(resolveWsSessionContext(engine, { type: "slash", text: "/stop" })).toEqual({
      ok: false,
      code: "internal_contract",
      message: "session identity required",
      sessionId: null,
      sessionPath: null,
    });
    expect(engine.getSessionIdForPath).not.toHaveBeenCalled();
  });

  it("resolves a bare path through the manifest current locator", () => {
    const engine = makeEngine({
      pathSessionId: "sess_a",
      manifest: { currentLocator: { path: "/sessions/current-a.jsonl" } },
    });

    expect(resolveWsSessionContext(engine, { sessionPath: "/sessions/legacy-a.jsonl" })).toMatchObject({
      ok: true,
      sessionId: "sess_a",
      sessionPath: "/sessions/current-a.jsonl",
    });
    expect(engine.getSessionManifest).toHaveBeenCalledWith("sess_a");
  });

  it("keeps a legacy path usable when the session has no manifest", () => {
    const engine = makeEngine();

    expect(resolveWsSessionContext(engine, { sessionPath: "/sessions/legacy.jsonl" })).toMatchObject({
      ok: true,
      sessionId: null,
      sessionPath: "/sessions/legacy.jsonl",
    });
  });

  it("refuses a legacy path when the caller demands a manifest locator", () => {
    const engine = makeEngine({ pathSessionId: "sess_a" });

    expect(resolveWsSessionContext(
      engine,
      { sessionPath: "/sessions/legacy.jsonl" },
      { requireManifestLocator: true },
    )).toEqual({
      ok: false,
      code: "session_identity_unresolved",
      message: "Unable to resolve current session locator",
      sessionId: "sess_a",
      sessionPath: null,
    });
  });

  it("rejects a path whose reverse lookup names a different session", () => {
    const engine = makeEngine({ pathSessionId: "sess_from_path" });

    expect(resolveWsSessionContext(engine, {
      sessionId: "sess_from_id",
      sessionPath: "/sessions/a.jsonl",
    })).toEqual({
      ok: false,
      code: "session_identity_mismatch",
      message: "sessionId and sessionPath refer to different sessions",
      sessionId: "sess_from_id",
      sessionPath: "/sessions/a.jsonl",
    });
  });

  it("rejects an explicit sessionId whose manifest is missing", () => {
    const engine = makeEngine({ pathSessionId: "sess_a", manifest: null });

    expect(resolveWsSessionContext(engine, {
      sessionId: "sess_a",
      sessionPath: "/sessions/a.jsonl",
    })).toMatchObject({
      ok: false,
      code: "session_identity_mismatch",
      sessionId: "sess_a",
      sessionPath: "/sessions/a.jsonl",
    });
  });

  it("rejects an explicit sessionId whose manifest locator points elsewhere", () => {
    const engine = makeEngine({
      pathSessionId: "sess_a",
      manifest: { currentLocator: { path: "/sessions/canonical.jsonl" } },
    });

    expect(resolveWsSessionContext(engine, {
      sessionId: "sess_a",
      sessionPath: "/sessions/stale.jsonl",
    })).toMatchObject({
      ok: false,
      code: "session_identity_mismatch",
      sessionId: "sess_a",
      sessionPath: "/sessions/stale.jsonl",
    });
  });

  it("resolves a bare sessionId through the manifest without touching the path index", () => {
    const engine = makeEngine({
      manifest: { currentLocator: { path: "/sessions/current-b.jsonl" } },
    });

    expect(resolveWsSessionContext(engine, { sessionId: "sess_b" })).toMatchObject({
      ok: true,
      sessionId: "sess_b",
      sessionPath: "/sessions/current-b.jsonl",
    });
    expect(engine.getSessionManifest).toHaveBeenCalledWith("sess_b");
  });

  it("reports an unresolved locator when a bare sessionId has no manifest locator", () => {
    const engine = makeEngine({ manifest: { currentLocator: null } });

    expect(resolveWsSessionContext(engine, { sessionId: "sess_b" })).toEqual({
      ok: false,
      code: "session_identity_unresolved",
      message: "Unable to resolve current session locator",
      sessionId: "sess_b",
      sessionPath: null,
    });
  });

  it("takes the agent from ownership and ignores the client's claim", () => {
    const engine = makeEngine({
      pathSessionId: "sess_legacy",
      manifest: { currentLocator: { path: "/sessions/legacy.jsonl" } },
      ownership: { agentId: "agent-owner", source: "manifest", agentDeleted: false },
    });

    expect(resolveWsSessionContext(engine, {
      sessionPath: "/sessions/legacy.jsonl",
      agentId: "agent-client",
    })).toMatchObject({
      ok: true,
      agentId: "agent-owner",
      agentIdSource: "ownership",
    });
    // 传 ref 而不是裸路径：协调器认 sessionId 时可以直接查 manifest，省一次按路径反查。
    expect(engine.resolveSessionOwnership).toHaveBeenCalledWith({
      sessionId: "sess_legacy",
      sessionPath: "/sessions/legacy.jsonl",
    });
  });

  it("falls back to the client's agent when the server does not know the session", () => {
    const engine = makeEngine({
      ownership: { agentId: null, source: "none", agentDeleted: false },
    });

    expect(resolveWsSessionContext(engine, {
      sessionPath: "/sessions/draft.jsonl",
      agentId: "agent-client",
    })).toMatchObject({
      ok: true,
      agentId: "agent-client",
      agentIdSource: "client",
    });
  });

  it("reports no agent when neither ownership nor the client supplies one", () => {
    const engine = makeEngine({
      ownership: { agentId: null, source: "none", agentDeleted: false },
    });

    expect(resolveWsSessionContext(engine, { sessionPath: "/sessions/draft.jsonl" })).toMatchObject({
      ok: true,
      agentId: null,
      agentIdSource: "none",
    });
  });

  it("carries the deleted-agent flag through from ownership", () => {
    const engine = makeEngine({
      ownership: { agentId: "agent-gone", source: "manifest", agentDeleted: true },
    });

    expect(resolveWsSessionContext(engine, { sessionPath: "/sessions/gone.jsonl" })).toMatchObject({
      ok: true,
      agentId: "agent-gone",
      agentDeleted: true,
    });
  });

  it("degrades to a legacy path, with a warning, when the path index throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = makeEngine();
    engine.getSessionIdForPath = vi.fn(() => { throw new Error("index corrupt"); });

    expect(resolveWsSessionContext(engine, { sessionPath: "/sessions/legacy.jsonl" })).toMatchObject({
      ok: true,
      sessionId: null,
      sessionPath: "/sessions/legacy.jsonl",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("index corrupt"));

    warn.mockRestore();
  });

  it("degrades to the given path, with a warning, when the manifest store throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = makeEngine({ pathSessionId: "sess_a" });
    engine.getSessionManifest = vi.fn(() => { throw new Error("store corrupt"); });

    expect(resolveWsSessionContext(engine, { sessionPath: "/sessions/legacy.jsonl" })).toMatchObject({
      ok: true,
      sessionId: "sess_a",
      sessionPath: "/sessions/legacy.jsonl",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("store corrupt"));

    warn.mockRestore();
  });

  // 归属查不出来和「查出来没有归属」是两回事。后者是草稿，客户端说自己属于谁就属于谁；
  // 前者是存储故障，这时候相信客户端等于把删除态门禁一起放行了，所以整条请求拒掉。
  it("fails closed, with a warning, when the ownership lookup throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = makeEngine({ pathSessionId: "sess_a" });
    engine.resolveSessionOwnership = vi.fn(() => { throw new Error("store corrupt"); });

    expect(resolveWsSessionContext(engine, {
      sessionPath: "/sessions/legacy.jsonl",
      agentId: "agent-client",
    })).toEqual({
      ok: false,
      code: "session_identity_unresolved",
      message: "Unable to resolve session ownership",
      sessionId: "sess_a",
      sessionPath: "/sessions/legacy.jsonl",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("store corrupt"));

    warn.mockRestore();
  });
});
