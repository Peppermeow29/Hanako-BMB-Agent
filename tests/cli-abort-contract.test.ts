import { describe, expect, it } from "vitest";

import { cliMessageMatchesSession, createCliAbortMessage, reduceCliStreamIdentity } from "../server/cli.ts";

describe("CLI abort stream identity contract", () => {
  it("builds abort only when sessionId, sessionPath, and streamId are all known", () => {
    expect(createCliAbortMessage({
      sessionId: "sess_cli",
      sessionPath: "/session/cli.jsonl",
      streamId: "stream_cli",
    })).toEqual({
      type: "abort",
      sessionId: "sess_cli",
      sessionPath: "/session/cli.jsonl",
      streamId: "stream_cli",
    });
    expect(createCliAbortMessage({
      sessionId: "sess_cli",
      sessionPath: "/session/cli.jsonl",
      streamId: null,
    })).toBeNull();
  });

  it("tracks the current stream and ignores a stale terminal status", () => {
    const base = {
      sessionId: "sess_cli",
      sessionPath: "/session/cli.jsonl",
      streamId: null,
      isStreaming: false,
    };
    const running = reduceCliStreamIdentity(base, {
      type: "status",
      sessionId: "sess_cli",
      sessionPath: "/session/cli.jsonl",
      streamId: "stream_new",
      isStreaming: true,
    });
    expect(running).toMatchObject({ streamId: "stream_new", isStreaming: true });

    const afterStale = reduceCliStreamIdentity(running, {
      type: "status",
      sessionId: "sess_cli",
      sessionPath: "/session/cli.jsonl",
      streamId: "stream_old",
      isStreaming: false,
    });
    expect(afterStale).toEqual(running);
    expect(reduceCliStreamIdentity(running, {
      type: "status",
      sessionId: "sess_cli",
      sessionPath: "/session/cli.jsonl",
      isStreaming: false,
    })).toEqual(running);

    expect(reduceCliStreamIdentity(running, {
      type: "turn_end",
      sessionId: "sess_cli",
      sessionPath: "/session/cli.jsonl",
      streamId: "stream_new",
    })).toMatchObject({ streamId: null, isStreaming: false });
  });

  it("does not adopt a stream event from another session", () => {
    const current = {
      sessionId: "sess_cli",
      sessionPath: "/session/cli.jsonl",
      streamId: "stream_cli",
      isStreaming: true,
    };
    expect(reduceCliStreamIdentity(current, {
      type: "text_delta",
      sessionId: "sess_other",
      sessionPath: "/session/other.jsonl",
      streamId: "stream_other",
      delta: "wrong target",
    })).toEqual(current);
    expect(cliMessageMatchesSession(current, {
      sessionId: "sess_other",
      sessionPath: "/session/other.jsonl",
    })).toBe(false);
  });
});
