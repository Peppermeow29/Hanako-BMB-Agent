import { describe, expect, it } from "vitest";
import { reconcileTerminalText } from "../lib/pi-sdk/stream-text-reconciler.ts";

describe("stream text reconciler", () => {
  it("returns no remainder when normalized terminal text matches streamed text", () => {
    expect(reconcileTerminalText(
      "Paragraph 1.\n\nParagraph 2.  ",
      "Paragraph 1. Paragraph 2.",
    )).toBe("");
  });

  it("returns only the unseen extension when terminal text continues streamed text", () => {
    expect(reconcileTerminalText("first second", "first")).toBe(" second");
  });

  it("does not append a shared suffix when providers normalize earlier prose", () => {
    expect(reconcileTerminalText("First. Second!", "First, Second!")).toBe("");
  });

  it("does not duplicate a long terminal prefix already represented by a streamed suffix", () => {
    const streamed = "Thinking intro. ";
    const terminal = "Final answer with several words. Continuation.";
    expect(reconcileTerminalText(terminal, streamed)).toBe(terminal);
  });

  it("reconciles a meaningful overlap without making short prose disappear", () => {
    const streamed = "The model emitted a completed answer already. ";
    const terminal = "already. The next unique continuation.";
    expect(reconcileTerminalText(terminal, streamed)).toBe("The next unique continuation.");
  });
});
