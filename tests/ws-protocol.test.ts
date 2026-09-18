import { describe, expect, it } from "vitest";

import * as wsProtocol from "../server/ws-protocol.ts";

type ProtocolHelper = (input: unknown) => unknown;

function protocolHelper(name: string) {
  const helper = (wsProtocol as Record<string, unknown>)[name];
  expect(helper).toBeTypeOf("function");
  return helper as ProtocolHelper;
}

describe("ws protocol session event builders", () => {
  it("wraps session stream events with routing and replay metadata", () => {
    const build = protocolHelper("createSessionStreamEventWsMessage");

    expect(build({
      sessionPath: "/sessions/a.jsonl",
      sessionId: "sess_ws_1",
      sessionEvent: { type: "text_delta", delta: "hello" },
      streamId: "stream_1",
      seq: 7,
    })).toEqual({
      type: "text_delta",
      delta: "hello",
      sessionPath: "/sessions/a.jsonl",
      sessionId: "sess_ws_1",
      sessionRefVersion: 2,
      streamId: "stream_1",
      seq: 7,
    });
  });

  it("rejects conflicting sessionId fields in session stream events", () => {
    const build = protocolHelper("createSessionStreamEventWsMessage");

    expect(() => build({
      sessionPath: "/sessions/a.jsonl",
      sessionId: "sess_ws_1",
      sessionEvent: { type: "text_delta", delta: "hello", sessionId: "sess_ws_2" },
      streamId: "stream_1",
      seq: 7,
    })).toThrow(/sessionEvent\.sessionId conflicts/);
  });

  it("rejects session stream events without an explicit sessionPath", () => {
    const build = protocolHelper("createSessionStreamEventWsMessage");

    expect(() => build({
      sessionPath: "",
      sessionEvent: { type: "text_delta", delta: "hello" },
      streamId: "stream_1",
      seq: 1,
    })).toThrow(/sessionPath.*non-empty string/);
  });

  it("rejects session stream events without an event type", () => {
    const build = protocolHelper("createSessionStreamEventWsMessage");

    expect(() => build({
      sessionPath: "/sessions/a.jsonl",
      sessionEvent: { delta: "hello" },
      streamId: "stream_1",
      seq: 1,
    })).toThrow(/sessionEvent\.type.*non-empty string/);
  });

  it("rejects session stream events with invalid replay metadata", () => {
    const build = protocolHelper("createSessionStreamEventWsMessage");

    expect(() => build({
      sessionPath: "/sessions/a.jsonl",
      sessionEvent: { type: "text_delta", delta: "hello" },
      streamId: "",
      seq: 1,
    })).toThrow(/streamId.*non-empty string/);

    expect(() => build({
      sessionPath: "/sessions/a.jsonl",
      sessionEvent: { type: "text_delta", delta: "hello" },
      streamId: "stream_1",
      seq: 0,
    })).toThrow(/seq.*positive integer/);
  });

  it("builds stream resume responses and validates replayed event shape", () => {
    const build = protocolHelper("createStreamResumeWsMessage");

    expect(build({
      sessionPath: "/sessions/a.jsonl",
      sessionId: "sess_resume_1",
      streamId: "stream_1",
      sinceSeq: 4,
      nextSeq: 8,
      reset: false,
      truncated: false,
      isStreaming: true,
      runtimeIsStreaming: true,
      events: [{
        seq: 5,
        ts: 123,
        event: { type: "text_delta", delta: "hello" },
      }],
    })).toEqual({
      type: "stream_resume",
      sessionPath: "/sessions/a.jsonl",
      sessionId: "sess_resume_1",
      sessionRefVersion: 2,
      streamId: "stream_1",
      sinceSeq: 4,
      nextSeq: 8,
      reset: false,
      truncated: false,
      isStreaming: true,
      runtimeIsStreaming: true,
      events: [{
        seq: 5,
        ts: 123,
        event: { type: "text_delta", delta: "hello" },
      }],
    });

    expect(() => build({
      sessionPath: "/sessions/a.jsonl",
      streamId: "stream_1",
      sinceSeq: 4,
      nextSeq: 8,
      reset: false,
      truncated: false,
      isStreaming: true,
      events: [{ seq: 5, event: { delta: "missing type" } }],
    })).toThrow(/events\[0\]\.event\.type.*non-empty string/);
  });
});
