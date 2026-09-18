import { describe, expect, it, vi } from "vitest";

import { resolveSessionThinkingLevelState } from "../server/session-thinking-level-state.ts";

describe("session thinking level state", () => {
  it("reads pending new-session drafts from the model default instead of the active session", () => {
    const engine = {
      currentModel: { id: "plain-model", provider: "test" },
      getSessionThinkingLevel: vi.fn(() => "max"),
      getDefaultThinkingLevel: vi.fn(() => "high"),
      getThinkingLevel: vi.fn(() => "medium"),
    };

    expect(resolveSessionThinkingLevelState(engine, { pendingNewSession: true })).toEqual({
      thinkingLevel: "high",
      thinkingLevels: ["off", "medium", "high"],
    });
    expect(engine.getSessionThinkingLevel).not.toHaveBeenCalled();
  });

  it("normalizes active session levels against the active session model", () => {
    const sessionPath = "/sessions/plain.jsonl";
    const engine = {
      currentModel: { id: "fallback-model", provider: "test", xhigh: true },
      getSessionByPath: vi.fn(() => ({ model: { id: "plain-model", provider: "test" } })),
      getSessionThinkingLevel: vi.fn(() => "max"),
      getDefaultThinkingLevel: vi.fn(() => "medium"),
      getThinkingLevel: vi.fn(() => "medium"),
    };

    expect(resolveSessionThinkingLevelState(engine, { sessionPath })).toEqual({
      thinkingLevel: "high",
      thinkingLevels: ["off", "medium", "high"],
    });
    expect(engine.getSessionThinkingLevel).toHaveBeenCalledWith(sessionPath);
  });

  it("exposes the Kimi four-level capability and High model default for a new session", () => {
    const engine = {
      currentModel: {
        id: "kimi-for-coding",
        provider: "kimi-coding",
        thinkingLevels: ["off", "low", "high", "max"],
        defaultThinkingLevel: "high",
        thinkingLevelMap: { xhigh: "max" },
      },
      getDefaultThinkingLevel: vi.fn(() => "high"),
      getThinkingLevel: vi.fn(() => "medium"),
    };

    expect(resolveSessionThinkingLevelState(engine, { pendingNewSession: true })).toEqual({
      thinkingLevel: "high",
      thinkingLevels: ["off", "low", "high", "max"],
    });
  });
});
