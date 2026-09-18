import { describe, expect, it } from "vitest";
import { createVisibleTextAccumulator } from "../lib/bridge/visible-text-accumulator.ts";

/**
 * Simulates the Bridge subscribe event sequence used by executeExternalMessage /
 * RC mirror / rc-router / desktop-session-submit visible-text capture.
 */
function feedBridgeEvents(events) {
  const acc = createVisibleTextAccumulator();
  const streamed = [];
  for (const event of events) {
    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub?.type === "text_delta") {
        const { emittedDelta, text } = acc.appendTextDelta(sub.delta || "");
        if (emittedDelta) streamed.push({ delta: emittedDelta, text });
      }
    } else if (event.type === "tool_execution_start") {
      acc.markHiddenToolBoundary();
    } else if (event.type === "tool_execution_end" && !event.isError) {
      let appendedDetail = false;
      const card = event.result?.details?.card;
      if (card?.description) {
        acc.appendVisibleDetail(card.description);
        appendedDetail = true;
      }
      if (!appendedDetail) acc.markHiddenToolBoundary();
    }
  }
  return { text: acc.getText(), streamed };
}

describe("createVisibleTextAccumulator — hidden tool paragraph boundary (#2356)", () => {
  it("inserts a paragraph break between prose segments separated only by a hidden tool", () => {
    const { text, streamed } = feedBridgeEvents([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "工具前输出。" } },
      { type: "tool_execution_start", toolName: "read" },
      { type: "tool_execution_end", toolName: "read", isError: false, result: { details: {} } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "工具后输出。" } },
    ]);

    expect(text).toBe("工具前输出。\n\n工具后输出。");
    expect(streamed.map((s) => s.delta)).toEqual(["工具前输出。", "\n\n工具后输出。"]);
    expect(streamed.at(-1)?.text).toBe("工具前输出。\n\n工具后输出。");
  });

  it("does not glue across a tool_execution_start alone before the next delta", () => {
    const { text } = feedBridgeEvents([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Before." } },
      { type: "tool_execution_start", toolName: "bash" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "After." } },
    ]);
    expect(text).toBe("Before.\n\nAfter.");
  });

  it("does not double blank lines when prose already ends with a paragraph break", () => {
    const { text } = feedBridgeEvents([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Before.\n\n" } },
      { type: "tool_execution_start", toolName: "read" },
      { type: "tool_execution_end", toolName: "read", isError: false, result: {} },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "After." } },
    ]);
    expect(text).toBe("Before.\n\nAfter.");
  });

  it("does not double blank lines when the next delta already starts with newlines", () => {
    const { text } = feedBridgeEvents([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Before." } },
      { type: "tool_execution_start", toolName: "read" },
      { type: "tool_execution_end", toolName: "read", isError: false, result: {} },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "\n\nAfter." } },
    ]);
    expect(text).toBe("Before.\n\nAfter.");
  });

  it("keeps consecutive text deltas glued when no tool intervenes", () => {
    const { text, streamed } = feedBridgeEvents([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo." } },
    ]);
    expect(text).toBe("Hello.");
    expect(streamed.map((s) => s.delta)).toEqual(["Hel", "lo."]);
  });

  it("preserves existing visible-detail separators and still breaks after a later hidden tool", () => {
    const { text } = feedBridgeEvents([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Intro." } },
      {
        type: "tool_execution_end",
        toolName: "card",
        isError: false,
        result: { details: { card: { description: "Card body." } } },
      },
      { type: "tool_execution_start", toolName: "read" },
      { type: "tool_execution_end", toolName: "read", isError: false, result: {} },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Outro." } },
    ]);
    expect(text).toBe("Intro.\n\nCard body.\n\nOutro.");
  });

  it("does not insert a leading paragraph break before the first prose", () => {
    const { text } = feedBridgeEvents([
      { type: "tool_execution_start", toolName: "read" },
      { type: "tool_execution_end", toolName: "read", isError: false, result: {} },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Only after tool." } },
    ]);
    expect(text).toBe("Only after tool.");
  });
});
