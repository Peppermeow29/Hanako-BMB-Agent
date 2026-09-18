import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowJournal } from "../lib/workflow/journal.ts";

function tmpJournalPath() {
  return path.join(os.tmpdir(), `hana-test-journal-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function cleanup(p) {
  try { if (p) fs.unlinkSync(p); } catch {}
}

describe("WorkflowJournal", () => {
  let paths = [];
  afterEach(() => { paths.forEach(cleanup); paths = []; });

  it("computeKey is deterministic for same input", () => {
    const k1 = WorkflowJournal.computeKey("hello", { model: "a" });
    const k2 = WorkflowJournal.computeKey("hello", { model: "a" });
    expect(k1).toBe(k2);
    expect(k1).toHaveLength(16);
  });

  it("computeKey differs for different prompts", () => {
    const k1 = WorkflowJournal.computeKey("hello", {});
    const k2 = WorkflowJournal.computeKey("world", {});
    expect(k1).not.toBe(k2);
  });

  it("computeKey ignores function and signal fields", () => {
    const k1 = WorkflowJournal.computeKey("p", { model: "x" });
    const k2 = WorkflowJournal.computeKey("p", { model: "x", signal: new AbortController().signal, onSessionReady: () => {} });
    expect(k1).toBe(k2);
  });

  it("in-memory journal: record and no self-replay", () => {
    const j = new WorkflowJournal(null);
    const key = WorkflowJournal.computeKey("p", {});
    j.record(1, key, "result-1");
    expect(j.totalEntries).toBe(1);
    // tryReplay doesn't work on self-recorded entries without load
    // because invalidatedAfter starts at Infinity but _entries is populated
    // This is fine: replay is designed for cross-run use via load()
    const cached = j.tryReplay(1, key);
    // In-memory journal CAN replay its own entries (Map-based lookup)
    expect(cached).toEqual({ hit: true, result: "result-1" });
  });

  it("persists to JSONL and loads back", () => {
    const p = tmpJournalPath();
    paths.push(p);
    const j = new WorkflowJournal(p);
    const key1 = WorkflowJournal.computeKey("a", {});
    const key2 = WorkflowJournal.computeKey("b", {});
    j.record(1, key1, "r1");
    j.record(2, key2, { data: 42 });

    const loaded = WorkflowJournal.load(p);
    expect(loaded.totalEntries).toBe(2);
    expect(loaded.tryReplay(1, key1)).toEqual({ hit: true, result: "r1" });
    expect(loaded.tryReplay(2, key2)).toEqual({ hit: true, result: { data: 42 } });
  });

  it("replay: key mismatch invalidates subsequent entries", () => {
    const p = tmpJournalPath();
    paths.push(p);
    const j = new WorkflowJournal(p);
    const k1 = WorkflowJournal.computeKey("a", {});
    const k2 = WorkflowJournal.computeKey("b", {});
    const k3 = WorkflowJournal.computeKey("c", {});
    j.record(1, k1, "r1");
    j.record(2, k2, "r2");
    j.record(3, k3, "r3");

    const replay = WorkflowJournal.load(p);
    // nodeSeq 1 matches
    expect(replay.tryReplay(1, k1)).toEqual({ hit: true, result: "r1" });
    // nodeSeq 2: different key → mismatch → invalidates 2+
    const differentKey = WorkflowJournal.computeKey("changed", {});
    expect(replay.tryReplay(2, differentKey)).toBeNull();
    // nodeSeq 3: even with correct key, invalidated
    expect(replay.tryReplay(3, k3)).toBeNull();
    expect(replay.replayHits).toBe(1);
  });

  it("replay: error entries are not replayed", () => {
    const p = tmpJournalPath();
    paths.push(p);
    const j = new WorkflowJournal(p);
    const key = WorkflowJournal.computeKey("fail", {});
    j.record(1, key, null, "error");

    const replay = WorkflowJournal.load(p);
    expect(replay.tryReplay(1, key)).toBeNull();
  });

  it("load handles missing file gracefully", () => {
    const j = WorkflowJournal.load("/nonexistent/path/journal.jsonl");
    expect(j.hasEntries).toBe(false);
    expect(j.totalEntries).toBe(0);
  });

  it("load handles corrupt file gracefully", () => {
    const p = tmpJournalPath();
    paths.push(p);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "not json\n{bad\n");
    const j = WorkflowJournal.load(p);
    expect(j.hasEntries).toBe(false);
  });

  it("cross-run resume: new journal copies cached entries", () => {
    const p1 = tmpJournalPath();
    const p2 = tmpJournalPath();
    paths.push(p1, p2);

    // Run 1: record 3 entries
    const run1 = new WorkflowJournal(p1);
    const k1 = WorkflowJournal.computeKey("a", {});
    const k2 = WorkflowJournal.computeKey("b", {});
    const k3 = WorkflowJournal.computeKey("c", {});
    run1.record(1, k1, "r1");
    run1.record(2, k2, "r2");
    run1.record(3, k3, "r3");

    // Run 2: resume from run 1, copy cached entries to new journal
    const replay = WorkflowJournal.load(p1);
    const run2 = new WorkflowJournal(p2);

    // Simulate host-api pattern: check replay, record to new journal
    const c1 = replay.tryReplay(1, k1);
    expect(c1.hit).toBe(true);
    run2.record(1, k1, c1.result);

    const c2 = replay.tryReplay(2, k2);
    expect(c2.hit).toBe(true);
    run2.record(2, k2, c2.result);

    // nodeSeq 3 changed → re-execute → record new result
    const newK3 = WorkflowJournal.computeKey("changed-c", {});
    expect(replay.tryReplay(3, newK3)).toBeNull();
    run2.record(3, newK3, "new-r3");

    // Verify run2 journal is complete and correct
    const run2Loaded = WorkflowJournal.load(p2);
    expect(run2Loaded.totalEntries).toBe(3);
    expect(run2Loaded.tryReplay(1, k1)).toEqual({ hit: true, result: "r1" });
    expect(run2Loaded.tryReplay(2, k2)).toEqual({ hit: true, result: "r2" });
    expect(run2Loaded.tryReplay(3, newK3)).toEqual({ hit: true, result: "new-r3" });
  });

  it("parallel agent order: nodeSeq is deterministic regardless of completion order", () => {
    const p = tmpJournalPath();
    paths.push(p);
    const j = new WorkflowJournal(p);

    // Simulate parallel: agents 1,2,3 complete in order 2,3,1 (JSONL order doesn't matter, keyed by nodeSeq)
    const k1 = WorkflowJournal.computeKey("agent-1", {});
    const k2 = WorkflowJournal.computeKey("agent-2", {});
    const k3 = WorkflowJournal.computeKey("agent-3", {});
    j.record(2, k2, "r2");
    j.record(3, k3, "r3");
    j.record(1, k1, "r1");

    const replay = WorkflowJournal.load(p);
    expect(replay.tryReplay(1, k1)).toEqual({ hit: true, result: "r1" });
    expect(replay.tryReplay(2, k2)).toEqual({ hit: true, result: "r2" });
    expect(replay.tryReplay(3, k3)).toEqual({ hit: true, result: "r3" });
  });

  it("record 支持 extra 字段（error/attempts），replay 读侧忽略未知字段", () => {
    const p = tmpJournalPath();
    paths.push(p);
    const j = new WorkflowJournal(p);
    j.record(1, "k1", null, "error", { error: "agent 失败: 502", attempts: 3 });
    j.record(2, "k2", "ok-result", "ok", { attempts: 1 });
    const lines = fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ nodeSeq: 1, status: "error", error: "agent 失败: 502", attempts: 3 });
    expect(lines[1]).toMatchObject({ nodeSeq: 2, status: "ok", attempts: 1 });
    const replay = WorkflowJournal.load(p);
    expect(replay.tryReplay(2, "k2")?.result).toBe("ok-result");
  });

  it("writeFolders 参与 agent() cache key：范围变化不得命中旧缓存", () => {
    const a = WorkflowJournal.computeKey("p", { writeFolders: ["/a"] });
    const b = WorkflowJournal.computeKey("p", { writeFolders: ["/b"] });
    const c = WorkflowJournal.computeKey("p", {});
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });
});
