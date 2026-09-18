import { describe, expect, it } from "vitest";

import { createLossyLocalCompactionResult } from "../core/lossy-local-compaction.ts";
import { computeSessionLineageMetadata } from "../lib/session-jsonl.ts";

function entry(id: string, parentId: string | null, role: string, content: any, timestamp: string) {
  return { id, parentId, type: "message", timestamp, message: { role, content, timestamp } };
}

function cursorThrough(entries: any[], coveredLeafId: string) {
  const lineage = computeSessionLineageMetadata(entries);
  return { coveredLeafId, lineageHash: lineage.prefixHashes[coveredLeafId] };
}

describe("createLossyLocalCompactionResult", () => {
  it("reuses an ancestral rolling summary, strips complete tool transactions, and keeps Pi's tail boundary", () => {
    const entries = [
      entry("u1", null, "user", [{ type: "text", text: "first question" }], "2026-08-07T00:00:00.000Z"),
      entry("a1", "u1", "assistant", [{ type: "text", text: "first answer" }], "2026-08-07T00:00:01.000Z"),
      entry("u2", "a1", "user", [{ type: "text", text: "inspect the project" }], "2026-08-07T00:00:02.000Z"),
      entry("a2", "u2", "assistant", [
        { type: "thinking", thinking: "private chain" },
        { type: "text", text: "I will inspect it." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
      ], "2026-08-07T00:00:03.000Z"),
      entry("t1", "a2", "toolResult", [{ type: "text", text: "VERY LARGE TOOL OUTPUT" }], "2026-08-07T00:00:04.000Z"),
      entry("a3", "t1", "assistant", [{ type: "text", text: "The relevant line is here." }], "2026-08-07T00:00:05.000Z"),
      entry("u3", "a3", "user", [{ type: "text", text: "retained request" }], "2026-08-07T00:00:06.000Z"),
      entry("a4", "u3", "assistant", [{ type: "text", text: "retained answer" }], "2026-08-07T00:00:07.000Z"),
    ];

    const result = createLossyLocalCompactionResult({
      branchEntries: entries,
      preparation: {
        firstKeptEntryId: "u3",
        tokensBefore: 98_765,
        fileOps: { read: new Set(["a.ts"]), written: new Set(), edited: new Set() },
      },
      summarySource: {
        summary: "Existing summary through the second user message.",
        cursor: cursorThrough(entries, "u2"),
        updatedAt: "2026-08-07T00:00:10.000Z",
      },
    });

    expect(result).toMatchObject({
      firstKeptEntryId: "u3",
      tokensBefore: 98_765,
      details: {
        strategy: "lossy_local",
        source: "rolling_summary",
        zeroModelRequest: true,
        readFiles: ["a.ts"],
        omitted: { toolResults: 1, toolCalls: 1, thinkingBlocks: 1 },
      },
    });
    expect(result.summary).toContain("Existing summary through the second user message.");
    expect(result.summary).toContain("I will inspect it.");
    expect(result.summary).toContain("The relevant line is here.");
    expect(result.summary).not.toContain("VERY LARGE TOOL OUTPUT");
    expect(result.summary).not.toContain("private chain");
    expect(result.summary).not.toContain("retained request");
    expect(result.summary).not.toContain("retained answer");
  });

  it("rejects a stale branch cursor and rebuilds the old region from current-branch text", () => {
    const entries = [
      entry("u1", null, "user", "current branch question", "2026-08-07T00:00:00.000Z"),
      entry("a1", "u1", "assistant", "current branch answer", "2026-08-07T00:00:01.000Z"),
      entry("u2", "a1", "user", "retained", "2026-08-07T00:00:02.000Z"),
    ];

    const result = createLossyLocalCompactionResult({
      branchEntries: entries,
      preparation: { firstKeptEntryId: "u2", tokensBefore: 100 },
      summarySource: {
        summary: "STALE SIBLING SUMMARY",
        cursor: { coveredLeafId: "a1", lineageHash: "not-the-current-lineage" },
        updatedAt: "2026-08-07T00:00:10.000Z",
      },
    });

    expect(result.details.source).toBe("branch_text");
    expect(result.summary).toContain("current branch question");
    expect(result.summary).toContain("current branch answer");
    expect(result.summary).not.toContain("STALE SIBLING SUMMARY");
  });

  it("preserves pre-reset text separately when the rolling summary only covers the post-reset period", () => {
    const entries = [
      entry("u1", null, "user", "before reset", "2026-08-07T00:00:00.000Z"),
      entry("u2", "u1", "user", "after reset and summarized", "2026-08-07T00:00:02.000Z"),
      entry("a2", "u2", "assistant", "after summary continuation", "2026-08-07T00:00:03.000Z"),
      entry("u3", "a2", "user", "retained", "2026-08-07T00:00:04.000Z"),
    ];

    const result = createLossyLocalCompactionResult({
      branchEntries: entries,
      preparation: { firstKeptEntryId: "u3", tokensBefore: 100 },
      summarySource: {
        summary: "Post-reset rolling summary.",
        cursor: cursorThrough(entries, "u2"),
        resetAt: "2026-08-07T00:00:01.000Z",
        updatedAt: "2026-08-07T00:00:05.000Z",
      },
    });

    expect(result.summary).toContain("Earlier Transcript Before Memory Reset");
    expect(result.summary).toContain("before reset");
    expect(result.summary).toContain("Post-reset rolling summary.");
    expect(result.summary).toContain("after summary continuation");
    expect(result.summary.match(/after reset and summarized/g)).toBeNull();
  });

  it("fails visibly when Pi's retained-tail boundary is absent", () => {
    expect(() => createLossyLocalCompactionResult({
      branchEntries: [entry("u1", null, "user", "only", "2026-08-07T00:00:00.000Z")],
      preparation: { firstKeptEntryId: "missing", tokensBefore: 10 },
    })).toThrow(/retained-tail boundary/);
  });
});
