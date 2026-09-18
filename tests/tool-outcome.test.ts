import { describe, expect, it } from "vitest";
import {
  collectToolOutcomesByCallId,
  projectKnownLegacyToolFailures,
  projectLiveToolResultOutcome,
  projectToolResultOutcome,
} from "../shared/tool-outcome.ts";

describe("tool outcome projection", () => {
  it("recognizes explicit and known legacy Hana failures", () => {
    expect(projectToolResultOutcome({
      isError: true,
      content: [{ type: "text", text: "failed" }],
      details: {},
    })).toMatchObject({ status: "failed", error: "failed" });

    expect(projectToolResultOutcome({
      content: [{ type: "text", text: "context changed" }],
      details: { errorCode: "TOOL_SESSION_CONTEXT_CHANGED_BEFORE_EXECUTION" },
    })).toMatchObject({ status: "failed" });

    expect(projectToolResultOutcome({
      content: [{ type: "text", text: "old helper failure" }],
      details: { error: "old helper failure" },
    })).toMatchObject({ status: "failed", error: "old helper failure" });

    expect(projectToolResultOutcome({
      content: [{ type: "text", text: "command exited 1" }],
      details: { execCommand: { ok: false, exitCode: 1 } },
    })).toMatchObject({ status: "failed" });

    expect(projectToolResultOutcome({
      content: [{ type: "text", text: "terminal unavailable" }],
      details: { errorCode: "WRITE_STDIN_TERMINAL_UNAVAILABLE" },
    })).toMatchObject({ status: "failed" });
  });

  it("does not guess that arbitrary plugin details.error means failure", () => {
    expect(projectToolResultOutcome({
      content: [{ type: "text", text: "completed with diagnostics" }],
      details: { error: "a recoverable warning" },
    })).toEqual({ status: "succeeded", success: true });

    expect(projectLiveToolResultOutcome({
      content: [{ type: "text", text: "same diagnostic" }],
      details: { error: "same diagnostic" },
    })).toEqual({ status: "succeeded", success: true });
  });

  it("pairs repeated tool names by toolCallId and leaves missing results unknown", () => {
    const outcomes = collectToolOutcomesByCallId([
      { role: "toolResult", toolCallId: "call-b", toolName: "read", isError: true, content: [{ type: "text", text: "no b" }] },
      { role: "toolResult", toolCallId: "call-a", toolName: "read", isError: false, content: [{ type: "text", text: "a" }] },
    ]);

    expect(outcomes.get("call-a")).toMatchObject({ status: "succeeded" });
    expect(outcomes.get("call-b")).toMatchObject({ status: "failed", error: "no b" });
    expect(outcomes.has("call-missing")).toBe(false);
  });

  it("projects legacy failures for replay without mutating the stored messages", () => {
    const stored = [
      { role: "toolResult", toolCallId: "known", isError: false, content: [{ type: "text", text: "denied" }], details: { error: "denied" } },
      { role: "toolResult", toolCallId: "warning", isError: false, content: [{ type: "text", text: "ok" }], details: { error: "warning" } },
    ];

    const projected = projectKnownLegacyToolFailures(stored) as typeof stored;

    expect(projected).not.toBe(stored);
    expect(projected[0].isError).toBe(true);
    expect(projected[1]).toBe(stored[1]);
    expect(stored[0].isError).toBe(false);
  });
});
