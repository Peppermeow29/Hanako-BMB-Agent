import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCurrentSessionBranch } from "../lib/session-jsonl.ts";
import {
  applyStoredSessionBranchHead,
  syncSessionBranchHeadAfterAppend,
} from "../core/session-branch-head.ts";

function entry(id: string, parentId: string | null, text: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-07-16T08:00:0${id.length}.000Z`,
    message: { role: id.startsWith("u") ? "user" : "assistant", content: text },
  };
}

describe("readCurrentSessionBranch", () => {
  let tmpDir: string;
  let sessionPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-branch-reader-"));
    sessionPath = path.join(tmpDir, "tree.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(entries: any[]) {
    const header = { type: "session", version: 3, id: "tree", timestamp: "2026-07-16T08:00:00.000Z", cwd: tmpDir };
    fs.writeFileSync(sessionPath, [header, ...entries].map((item) => JSON.stringify(item)).join("\n") + "\n");
  }

  it("uses the physical tail for legacy sessions and returns lineage metadata", () => {
    write([
      entry("u1", null, "root"),
      entry("a1", "u1", "answer"),
    ]);

    const result = readCurrentSessionBranch(sessionPath);

    expect(result.selectedLeafId).toBe("a1");
    expect(result.physicalTailLeafId).toBe("a1");
    expect(result.messages.map((message) => message.content)).toEqual(["root", "answer"]);
    expect(result.lineage.map((item) => item.id)).toEqual(["u1", "a1"]);
    expect(result.lineageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.headResolution).toBe("legacy_tail");
  });

  it("keeps an explicit sibling head when the physical tail has not changed", () => {
    write([
      entry("u1", null, "root"),
      entry("a-old", "u1", "old answer"),
      entry("a-new", "u1", "new answer"),
    ]);

    const result = readCurrentSessionBranch(sessionPath, {
      branchHead: {
        sessionId: "sess-1",
        leafId: "a-old",
        observedTailLeafId: "a-new",
        revision: 1,
        reason: "explicit_select",
      },
    });

    expect(result.selectedLeafId).toBe("a-old");
    expect(result.messages.map((message) => message.content)).toEqual(["root", "old answer"]);
    expect(result.headResolution).toBe("persisted_head");
  });

  it("recovers an append that reached JSONL after the explicit-head write", () => {
    write([
      entry("u1", null, "root"),
      entry("a-old", "u1", "old answer"),
      entry("u-new", "u1", "replacement"),
      entry("a-new", "u-new", "replacement answer"),
    ]);

    const result = readCurrentSessionBranch(sessionPath, {
      branchHead: {
        sessionId: "sess-1",
        leafId: "u1",
        observedTailLeafId: "a-old",
        revision: 1,
        reason: "replay_rewind",
      },
    });

    expect(result.selectedLeafId).toBe("a-new");
    expect(result.messages.map((message) => message.content)).toEqual(["root", "replacement", "replacement answer"]);
    expect(result.headResolution).toBe("append_recovery");
    expect(result.recommendedHead).toMatchObject({
      leafId: "a-new",
      observedTailLeafId: "a-new",
    });
  });

  it("does not resurrect a stale writer that continued from the discarded observed tail", () => {
    write([
      entry("u1", null, "root"),
      entry("a-old", "u1", "discarded answer"),
      entry("a-stale", "a-old", "stale continuation"),
    ]);

    const result = readCurrentSessionBranch(sessionPath, {
      branchHead: {
        sessionId: "sess-1",
        leafId: "u1",
        observedTailLeafId: "a-old",
        revision: 1,
        reason: "replay_rewind",
      },
    });

    expect(result.selectedLeafId).toBe("u1");
    expect(result.messages.map((message) => message.content)).toEqual(["root"]);
    expect(result.headResolution).toBe("persisted_head");
  });

  it("preserves an explicit root while the observed physical tail is unchanged", () => {
    write([entry("u-old", null, "discarded")]);

    const result = readCurrentSessionBranch(sessionPath, {
      branchHead: {
        sessionId: "sess-1",
        leafId: null,
        observedTailLeafId: "u-old",
        revision: 1,
        reason: "replay_reset_root",
      },
    });

    expect(result.selectedLeafId).toBeNull();
    expect(result.messages).toEqual([]);
    expect(result.lineage).toEqual([]);
  });

  it("does not let a stale old-root writer override an explicit root selection", () => {
    write([
      entry("u-old", null, "discarded"),
      entry("a-stale", "u-old", "stale continuation"),
    ]);

    const result = readCurrentSessionBranch(sessionPath, {
      branchHead: {
        sessionId: "sess-1",
        leafId: null,
        observedTailLeafId: "u-old",
        revision: 1,
        reason: "replay_reset_root",
      },
    });

    expect(result.selectedLeafId).toBeNull();
    expect(result.messages).toEqual([]);
    expect(result.headResolution).toBe("persisted_head");
  });

  it.each([
    {
      name: "duplicate ids",
      entries: [entry("u1", null, "one"), entry("u1", null, "two")],
      code: "session_branch_duplicate_id",
    },
    {
      name: "dangling parents",
      entries: [entry("u1", "missing", "one")],
      code: "session_branch_dangling_parent",
    },
    {
      name: "cycles",
      entries: [entry("u1", "a1", "one"), entry("a1", "u1", "two")],
      code: "session_branch_cycle",
    },
  ])("rejects $name instead of silently choosing a branch", ({ entries, code }) => {
    write(entries);

    expect(() => readCurrentSessionBranch(sessionPath)).toThrow(expect.objectContaining({ code }));
  });

  it("never applies or persists synthetic ids for an id-less legacy manager", () => {
    const branch = () => { throw new Error("synthetic branch must not be applied"); };
    const resetLeaf = () => { throw new Error("legacy physical tail must remain selected"); };
    const setBranchHead = () => { throw new Error("synthetic head must not be persisted"); };
    const manager = {
      getEntries: () => [
        { type: "message", timestamp: "2026-07-16T08:00:01.000Z", message: { role: "user", content: "legacy" } },
      ],
      getSessionFile: () => sessionPath,
      branch,
      resetLeaf,
    };
    const store = {
      getBranchHead: () => null,
      setBranchHead,
    };

    const projection = applyStoredSessionBranchHead({
      store,
      sessionId: "legacy-session",
      sessionManager: manager,
    });

    expect(projection).toMatchObject({ legacySyntheticIds: true, selectedLeafId: "legacy-line-1" });
    expect(syncSessionBranchHeadAfterAppend({
      store,
      sessionId: "legacy-session",
      sessionManager: manager,
    })).toBeNull();
  });

  it("changes lineage hashes when message semantics change without changing ids", () => {
    write([entry("u1", null, "before")]);
    const before = readCurrentSessionBranch(sessionPath);
    write([entry("u1", null, "after")]);
    const after = readCurrentSessionBranch(sessionPath);

    expect(after.selectedLeafId).toBe(before.selectedLeafId);
    expect(after.lineageHash).not.toBe(before.lineageHash);
  });
});
