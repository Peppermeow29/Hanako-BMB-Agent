import { describe, expect, it } from "vitest";
import {
  cliChatMessageMatchesSession,
  createCliChatAbortMessage,
  createCliChatPromptMessage,
  formatSessionLine,
  reduceCliChatStreamIdentity,
  selectSession,
} from "../cli/chat.ts";

describe("CLI chat session helpers", () => {
  const sessions = [
    { path: "/a.json", title: "Alpha", agentName: "Hana", modified: "2026-05-19T10:00:00.000Z" },
    { path: "/b.json", firstMessage: "Beta first", agentId: "agent-b", modified: null },
  ];

  it("selects the latest session by default", () => {
    expect((selectSession as any)(sessions)).toBe(sessions[0]);
  });

  it("selects one-based session indices", () => {
    expect(selectSession(sessions, "2")).toBe(sessions[1]);
  });

  it("selects exact session paths", () => {
    expect(selectSession(sessions, "/b.json")).toBe(sessions[1]);
  });

  it("formats recent session rows for terminal display", () => {
    const line = formatSessionLine(sessions[0], 1);
    expect(line).toContain("Alpha");
    expect(line).toContain("Hana");
  });
});

describe("standalone CLI session stream contract", () => {
  const identity = {
    sessionId: "sess-a",
    sessionPath: "/tmp/a.jsonl",
    streamId: "stream-a",
    isStreaming: true,
  };

  it("includes the immutable session identity in prompts", () => {
    expect(createCliChatPromptMessage(identity, "hello")).toEqual({
      type: "prompt",
      text: "hello",
      sessionId: "sess-a",
      sessionPath: "/tmp/a.jsonl",
    });
    expect(createCliChatPromptMessage({ sessionPath: "/tmp/a.jsonl" }, "hello")).toBeNull();
  });

  it("only builds abort requests when sessionId, sessionPath, and streamId are all present", () => {
    expect(createCliChatAbortMessage(identity)).toEqual({
      type: "abort",
      sessionId: "sess-a",
      sessionPath: "/tmp/a.jsonl",
      streamId: "stream-a",
    });
    expect(createCliChatAbortMessage({ ...identity, sessionId: null })).toBeNull();
    expect(createCliChatAbortMessage({ ...identity, sessionPath: null })).toBeNull();
    expect(createCliChatAbortMessage({ ...identity, streamId: null })).toBeNull();
  });

  it("keeps the active stream after abort_rejected and only clears it on a matching terminal event", () => {
    const rejected = reduceCliChatStreamIdentity(identity, {
      type: "abort_rejected",
      sessionId: "sess-a",
      sessionPath: "/tmp/a.jsonl",
      streamId: "stream-new",
      reason: "stale_stream",
    });
    expect(rejected).toEqual({ ...identity, streamId: "stream-new", isStreaming: true });

    const staleEnd = reduceCliChatStreamIdentity(rejected, {
      type: "turn_end",
      sessionId: "sess-a",
      sessionPath: "/tmp/a.jsonl",
      streamId: "stream-a",
    });
    expect(staleEnd).toEqual(rejected);

    const ended = reduceCliChatStreamIdentity(staleEnd, {
      type: "status",
      sessionId: "sess-a",
      sessionPath: "/tmp/a.jsonl",
      streamId: "stream-new",
      isStreaming: false,
    });
    expect(ended).toEqual({ ...identity, streamId: null, isStreaming: false });
  });

  it("does not let another session mutate the tracked stream", () => {
    expect(cliChatMessageMatchesSession(identity, {
      sessionId: "sess-b",
      sessionPath: "/tmp/b.jsonl",
    })).toBe(false);
    expect(reduceCliChatStreamIdentity(identity, {
      type: "status",
      sessionId: "sess-b",
      sessionPath: "/tmp/b.jsonl",
      streamId: "stream-b",
      isStreaming: false,
    })).toEqual(identity);
  });
});
