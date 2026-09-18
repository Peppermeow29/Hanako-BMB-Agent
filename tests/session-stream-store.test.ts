import { describe, it, expect } from "vitest";
import {
  createSessionStreamState,
  beginSessionStream,
  finishSessionStream,
  appendSessionStreamEvent,
  resumeSessionStream,
} from "../server/session-stream-store.ts";

describe("session-stream-store", () => {
  it("按 seq 返回缺失事件", () => {
    const ss = createSessionStreamState();
    const streamId = beginSessionStream(ss, "stream_a");

    const e1 = appendSessionStreamEvent(ss, { type: "text_delta", delta: "Hello" });
    const e2 = appendSessionStreamEvent(ss, { type: "tool_start", name: "search" });
    const e3 = appendSessionStreamEvent(ss, { type: "mood_text", delta: "vibe1" });

    expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);

    const resumed = resumeSessionStream(ss, { streamId, sinceSeq: 1 });
    expect(resumed.streamId).toBe("stream_a");
    expect(resumed.events.map(x => x.seq)).toEqual([2, 3]);
    expect(resumed.events.map(x => x.event.type)).toEqual(["tool_start", "mood_text"]);
  });

  it("旧 streamId 恢复时，要求客户端重建为当前流", () => {
    const ss = createSessionStreamState();
    beginSessionStream(ss, "stream_a");
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "old" });
    finishSessionStream(ss);

    beginSessionStream(ss, "stream_b");
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "new" });

    const resumed = resumeSessionStream(ss, { streamId: "stream_a", sinceSeq: 99 });
    expect(resumed.reset).toBe(true);
    expect(resumed.streamId).toBe("stream_b");
    expect(resumed.events.map(x => x.seq)).toEqual([1]);
  });

  it("容量截断时会标记 truncated", () => {
    const ss = createSessionStreamState({ maxEvents: 3 });
    beginSessionStream(ss, "stream_a");
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "1" });
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "2" });
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "3" });
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "4" });

    const resumed = resumeSessionStream(ss, { streamId: "stream_a", sinceSeq: 0 });
    expect(resumed.truncated).toBe(true);
    expect(resumed.sinceSeq).toBe(1);
    expect(resumed.events.map(x => x.seq)).toEqual([2, 3, 4]);
  });

  it("按总字节上限截断旧事件", () => {
    const ss = createSessionStreamState({ maxEvents: 100, maxBytes: 1024, maxEventBytes: 1000 });
    beginSessionStream(ss, "stream_a");
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "a".repeat(400) });
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "b".repeat(400) });
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "c".repeat(400) });

    expect(ss.totalEventBytes).toBeLessThanOrEqual(1024);
    expect(ss.droppedEvents).toBeGreaterThan(0);

    const resumed = resumeSessionStream(ss, { streamId: "stream_a", sinceSeq: 0 });
    expect(resumed.truncated).toBe(true);
    expect(resumed.events.at(-1).event.delta).toBe("c".repeat(400));
  });

  it("压缩单个超大事件用于断线恢复缓冲", () => {
    const ss = createSessionStreamState({ maxEventBytes: 1024 });
    beginSessionStream(ss, "stream_a");
    appendSessionStreamEvent(ss, {
      type: "content_block",
      block: {
        type: "screenshot",
        base64: "x".repeat(20_000),
      },
    });

    expect(ss.compactedEvents).toBe(1);
    const resumed = resumeSessionStream(ss, { streamId: "stream_a", sinceSeq: 0 });
    expect(resumed.events).toHaveLength(1);
    expect(resumed.events[0].event).toMatchObject({
      type: "content_block",
      compacted: true,
    });
    expect(resumed.events[0].event.block.base64).toContain("omitted");
    expect(JSON.stringify(resumed.events[0].event)).not.toContain("x".repeat(1024));
  });

  it("开始新流时会重置旧状态", () => {
    const ss = createSessionStreamState();
    beginSessionStream(ss, "stream_a");
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "old" });
    beginSessionStream(ss, "stream_b");

    expect(ss.streamId).toBe("stream_b");
    expect(ss.nextSeq).toBe(1);
    expect(ss.events).toEqual([]);
    expect(ss.isStreaming).toBe(true);
  });

  it("finishSessionStream 会清空 events 释放内存", () => {
    const ss = createSessionStreamState();
    beginSessionStream(ss, "stream_a");
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "1" });
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "2" });
    expect(ss.events.length).toBe(2);

    finishSessionStream(ss);
    expect(ss.events).toEqual([]);
    expect(ss.isStreaming).toBe(false);
    expect(ss.endedAt).toBeGreaterThan(0);
  });

  it("DEFAULT_MAX_EVENTS 对正常 turn 不会触发 truncated", () => {
    const ss = createSessionStreamState();
    beginSessionStream(ss, "stream_a");
    // 正常 turn 的量级：~1~2k 事件；5000 的默认上限应留有足够 headroom
    for (let i = 0; i < 2500; i++) {
      appendSessionStreamEvent(ss, { type: "text_delta", delta: String(i) });
    }
    const resumed = resumeSessionStream(ss, { streamId: "stream_a", sinceSeq: 0 });
    expect(resumed.truncated).toBe(false);
    expect(resumed.events.length).toBe(2500);
  });

  it("无活跃流时返回空恢复结果", () => {
    const ss = createSessionStreamState();
    const resumed = resumeSessionStream(ss, { sinceSeq: 12 });

    expect(resumed).toMatchObject({
      streamId: null,
      sinceSeq: 12,
      nextSeq: 1,
      isStreaming: false,
      reset: false,
      truncated: false,
      events: [],
    });
  });
});
