import { describe, expect, it, vi } from "vitest";

import {
  resolveCompactSessionTarget,
  toCompactionLifecycleWsMessage,
} from "../server/routes/chat.ts";

describe("chat route compaction lifecycle messages", () => {
  it("normalizes SDK compaction_start into the frontend protocol", () => {
    expect(toCompactionLifecycleWsMessage(
      { type: "compaction_start", reason: "threshold" },
      "/session/a.jsonl",
      () => null,
      () => "sess_a",
    )).toEqual({
      type: "compaction_start",
      sessionId: "sess_a",
      sessionPath: "/session/a.jsonl",
      reason: "threshold",
    });
  });

  it("normalizes SDK compaction_end and reads usage from the session", () => {
    const getSessionByPath = vi.fn(() => ({
      getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
    }));

    expect(toCompactionLifecycleWsMessage(
      { type: "compaction_end", reason: "manual", aborted: false, willRetry: false },
      "/session/a.jsonl",
      getSessionByPath,
      () => "sess_a",
    )).toEqual({
      type: "compaction_end",
      sessionId: "sess_a",
      sessionPath: "/session/a.jsonl",
      reason: "manual",
      aborted: false,
      willRetry: false,
      tokens: null,
      contextWindow: 200_000,
      percent: null,
    });
    expect(getSessionByPath).toHaveBeenCalledWith("/session/a.jsonl");
  });

  it("includes the resolved compaction mode so the session ring can label local compaction", () => {
    expect(toCompactionLifecycleWsMessage(
      { type: "compaction_start", reason: "threshold" },
      "/session/a.jsonl",
      () => null,
      () => "sess_a",
      () => "lossy_local",
    )).toEqual({
      type: "compaction_start",
      sessionId: "sess_a",
      sessionPath: "/session/a.jsonl",
      reason: "threshold",
      mode: "lossy_local",
    });
  });

  it("prefers the mode carried by the compaction event", () => {
    expect(toCompactionLifecycleWsMessage(
      { type: "compaction_start", reason: "threshold", mode: "lossy_local" },
      "/session/a.jsonl",
      () => null,
      () => "sess_a",
      () => "auto",
    )).toMatchObject({ mode: "lossy_local" });
  });

  it("ignores non-compaction events", () => {
    expect(toCompactionLifecycleWsMessage(
      { type: "turn_end" },
      "/session/a.jsonl",
      () => null,
      () => "sess_a",
    )).toBeNull();
  });

  it("resolves a sessionId through the manifest current locator", () => {
    const engine = {
      getSessionManifest: vi.fn(() => ({ currentLocator: { path: "/session/current-b.jsonl" } })),
      getSessionIdForPath: vi.fn(),
    };

    expect(resolveCompactSessionTarget(engine, { sessionId: "sess_a" })).toEqual({
      ok: true,
      sessionId: "sess_a",
      sessionPath: "/session/current-b.jsonl",
    });
    expect(engine.getSessionManifest).toHaveBeenCalledWith("sess_a");
    expect(engine.getSessionIdForPath).not.toHaveBeenCalled();
  });

  it("converts a legacy path once, then uses the manifest current locator", () => {
    const engine = {
      getSessionIdForPath: vi.fn(() => "sess_a"),
      getSessionManifest: vi.fn(() => ({ currentLocator: { path: "/session/current-b.jsonl" } })),
    };

    expect(resolveCompactSessionTarget(engine, { sessionPath: "/session/legacy-a.jsonl" })).toEqual({
      ok: true,
      sessionId: "sess_a",
      sessionPath: "/session/current-b.jsonl",
    });
  });

  it("rejects conflicting identity claims", () => {
    const engine = {
      getSessionIdForPath: vi.fn(() => "sess_from_path"),
      getSessionManifest: vi.fn(),
    };

    expect(resolveCompactSessionTarget(engine, {
      sessionId: "sess_from_id",
      sessionPath: "/session/a.jsonl",
    })).toMatchObject({
      ok: false,
      code: "session_identity_mismatch",
      sessionId: "sess_from_id",
    });
    expect(engine.getSessionManifest).not.toHaveBeenCalled();
  });

  it("returns an explicit unresolved error for unknown legacy paths", () => {
    expect(resolveCompactSessionTarget({
      getSessionIdForPath: vi.fn(() => null),
      getSessionManifest: vi.fn(),
    }, { sessionPath: "/session/unknown.jsonl" })).toMatchObject({
      ok: false,
      code: "session_identity_unresolved",
      sessionId: null,
    });
  });
});
