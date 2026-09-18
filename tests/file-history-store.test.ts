import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { FileHistoryStore } from "../lib/file-history/history-store.ts";

const tmpDirs: string[] = [];
function makeStore(overrides: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-file-history-"));
  tmpDirs.push(dir);
  return new FileHistoryStore({ dbPath: path.join(dir, "history.sqlite"), ...overrides });
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("FileHistoryStore", () => {
  it("inserts a snapshot and reads it back losslessly", () => {
    const store = makeStore();
    const res = store.recordSnapshot({
      relPath: "notes/a.md", content: Buffer.from("hello 世界"), origin: "event",
      opContext: "agent_tool", capturedAt: 1000,
    });
    expect(res.status).toBe("inserted");
    const got = store.getSnapshotContent(res.snapshotId);
    expect(got.content.toString("utf-8")).toBe("hello 世界");
    expect(got.relPath).toBe("notes/a.md");
    store.close();
  });

  it("dedupes identical content by hash", () => {
    const store = makeStore();
    store.recordSnapshot({ relPath: "a.md", content: Buffer.from("x"), origin: "event", capturedAt: 1000 });
    const res = store.recordSnapshot({ relPath: "a.md", content: Buffer.from("x"), origin: "watcher", capturedAt: 999_000 });
    expect(res.status).toBe("unchanged");
    expect(store.listVersions("a.md")).toHaveLength(1);
    store.close();
  });

  it("merges snapshots inside the merge window and keeps them apart outside it", () => {
    const store = makeStore({ mergeWindowMs: 60_000 });
    store.recordSnapshot({ relPath: "a.md", content: Buffer.from("v1"), origin: "event", capturedAt: 1000 });
    const merged = store.recordSnapshot({ relPath: "a.md", content: Buffer.from("v2"), origin: "event", capturedAt: 30_000 });
    expect(merged.status).toBe("merged");
    const apart = store.recordSnapshot({ relPath: "a.md", content: Buffer.from("v3"), origin: "event", capturedAt: 200_000 });
    expect(apart.status).toBe("inserted");
    const versions = store.listVersions("a.md");
    expect(versions).toHaveLength(2);
    expect(store.getSnapshotContent(versions[0].id).content.toString()).toBe("v3");
    expect(store.getSnapshotContent(versions[1].id).content.toString()).toBe("v2");
    store.close();
  });

  it("never merges into or over a restore snapshot", () => {
    const store = makeStore({ mergeWindowMs: 60_000 });
    store.recordSnapshot({ relPath: "a.md", content: Buffer.from("v1"), origin: "restore", capturedAt: 1000 });
    const res = store.recordSnapshot({ relPath: "a.md", content: Buffer.from("v2"), origin: "event", capturedAt: 2000 });
    expect(res.status).toBe("inserted");
    store.close();
  });

  it("marks deletion without dropping snapshots, and un-deletes on new capture", () => {
    const store = makeStore();
    store.recordSnapshot({ relPath: "a.md", content: Buffer.from("v1"), origin: "event", capturedAt: 1000 });
    store.markDeleted("a.md", 2000);
    expect(store.listFiles().find(f => f.relPath === "a.md")?.deletedAt).toBe(2000);
    store.recordSnapshot({ relPath: "a.md", content: Buffer.from("v2"), origin: "watcher", capturedAt: 100_000 });
    expect(store.listFiles().find(f => f.relPath === "a.md")?.deletedAt).toBeNull();
    store.close();
  });

  it("follows renames", () => {
    const store = makeStore();
    store.recordSnapshot({ relPath: "old.md", content: Buffer.from("v1"), origin: "event", capturedAt: 1000 });
    store.renamePath("old.md", "new.md");
    expect(store.listVersions("new.md")).toHaveLength(1);
    expect(store.listVersions("old.md")).toHaveLength(0);
    store.close();
  });

  it("latestHash reflects the newest snapshot", () => {
    const store = makeStore();
    expect(store.latestHash("a.md")).toBeNull();
    store.recordSnapshot({ relPath: "a.md", content: Buffer.from("v1"), origin: "sweep", capturedAt: 1000 });
    const first = store.latestHash("a.md");
    expect(typeof first).toBe("string");
    store.recordSnapshot({ relPath: "a.md", content: Buffer.from("v2"), origin: "sweep", capturedAt: 200_000 });
    expect(store.latestHash("a.md")).not.toBe(first);
    store.close();
  });

  it("enforceRetention drops expired snapshots and stays under the byte budget", () => {
    const store = makeStore({ mergeWindowMs: 0 });
    const day = 24 * 3600 * 1000;
    store.recordSnapshot({ relPath: "a.md", content: Buffer.from("ancient"), origin: "event", capturedAt: 0 });
    store.recordSnapshot({ relPath: "a.md", content: Buffer.from("recent"), origin: "event", capturedAt: 40 * day });
    store.enforceRetention({ maxAgeMs: 30 * day, maxTotalBytes: 500 * 1024 * 1024, now: 41 * day });
    expect(store.listVersions("a.md")).toHaveLength(1);

    const big1 = Buffer.from(Array.from({ length: 3000 }, () => Math.floor(Math.random() * 256)));
    const big2 = Buffer.from(Array.from({ length: 3000 }, () => Math.floor(Math.random() * 256)));
    store.recordSnapshot({ relPath: "b.bin", content: big1, origin: "event", capturedAt: 40 * day + 1 });
    store.recordSnapshot({ relPath: "b.bin", content: big2, origin: "event", capturedAt: 40 * day + 2 });
    store.enforceRetention({ maxAgeMs: 365 * day, maxTotalBytes: 3500, now: 41 * day });
    expect(store.totalStoredBytes()).toBeLessThanOrEqual(3500);
    store.close();
  });

  it("refuses to open a database from a newer schema", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-file-history-"));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, "history.sqlite");
    const first = new FileHistoryStore({ dbPath });
    first.close();
    const requireHere = createRequire(import.meta.url);
    const DatabaseMod = requireHere("better-sqlite3");
    const Database = DatabaseMod?.default || DatabaseMod;
    const raw = new Database(dbPath);
    raw.prepare("UPDATE meta SET value='999' WHERE key='schema_version'").run();
    raw.close();
    expect(() => new FileHistoryStore({ dbPath })).toThrow(/schema/i);
  });
});
