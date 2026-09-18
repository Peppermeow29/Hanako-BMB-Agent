import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDataEpochCheckpointProvider,
  expandStorePathPattern,
  pruneDataEpochCheckpoints,
} from "../core/data-epoch-checkpoint-provider.ts";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import type { StoreDescriptor } from "../shared/persistence/store-registry-types.ts";
import { dataEpochJournalPath, writeDataEpochJournal } from "../shared/data-epoch.cjs";

const tempDirs: string[] = [];

function makeHomeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-epoch-checkpoint-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// Base descriptor fields (openEntry, schemaSource, phases, etc.) are
// irrelevant to the provider — it only reads id/format/pathKind/
// pathPatterns. Spreading a real descriptor for the rest keeps these
// fixtures short, mirroring tests/persistence-store-registry.test.ts's
// own dummyStore helper.
function testStore(overrides: Partial<StoreDescriptor> & { id: string; pathPatterns: string[] }): StoreDescriptor {
  return {
    ...PERSISTENT_STORES[0],
    ...overrides,
    pathPattern: overrides.pathPatterns[0],
    siteRules: overrides.siteRules ?? [],
  };
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

describe("expandStorePathPattern", () => {
  it("matches a single placeholder segment against real directory entries and skips wrong-type siblings", () => {
    const home = makeHomeDir();
    fs.mkdirSync(path.join(home, "agents", "abc", "desk"), { recursive: true });
    fs.writeFileSync(path.join(home, "agents", "abc", "desk", "activities.json"), "{}");
    fs.mkdirSync(path.join(home, "agents", "xyz", "desk"), { recursive: true });
    fs.writeFileSync(path.join(home, "agents", "xyz", "desk", "activities.json"), "{}");
    // A file where the placeholder expects a directory to descend through:
    // this must be silently skipped (zero-hit branch), never thrown.
    fs.writeFileSync(path.join(home, "agents", "not-a-dir"), "stray");

    const matches = expandStorePathPattern(home, "agents/{agentId}/desk/activities.json");
    expect(matches.map((match) => match.relPath)).toEqual([
      "agents/abc/desk/activities.json",
      "agents/xyz/desk/activities.json",
    ]);
    expect(matches.every((match) => !match.isDirectory)).toBe(true);
  });

  it("supports multiple placeholder segments plus a literal suffix sharing one segment", () => {
    const home = makeHomeDir();
    fs.mkdirSync(path.join(home, "agents", "abc", "memory", "summaries"), { recursive: true });
    fs.writeFileSync(path.join(home, "agents", "abc", "memory", "summaries", "sess-1.json"), "{}");
    fs.writeFileSync(path.join(home, "agents", "abc", "memory", "summaries", "sess-1.txt"), "not json");

    const matches = expandStorePathPattern(home, "agents/{agentId}/memory/summaries/{sessionId}.json");
    expect(matches.map((match) => match.relPath)).toEqual(["agents/abc/memory/summaries/sess-1.json"]);
  });

  it("returns zero matches without throwing when nothing on disk satisfies the pattern", () => {
    const home = makeHomeDir();
    expect(expandStorePathPattern(home, "agents/{agentId}/desk/activities.json")).toEqual([]);
    fs.mkdirSync(path.join(home, "agents"), { recursive: true });
    expect(expandStorePathPattern(home, "agents/{agentId}/desk/activities.json")).toEqual([]);
  });

  it("resolves a placeholder terminal segment to a directory match", () => {
    const home = makeHomeDir();
    fs.mkdirSync(path.join(home, "session-files", "hash1"), { recursive: true });
    fs.writeFileSync(path.join(home, "session-files", "hash1", "payload.bin"), "x");

    const matches = expandStorePathPattern(home, "session-files/{sessionHash}");
    expect(matches).toEqual([
      { absPath: path.join(home, "session-files", "hash1"), relPath: "session-files/hash1", isDirectory: true },
    ]);
  });

  it("fails closed on malformed pattern syntax", () => {
    const home = makeHomeDir();
    expect(() => expandStorePathPattern(home, "agents/{agentId")).toThrow('unmatched "{"');
    expect(() => expandStorePathPattern(home, "agents/agentId}")).toThrow('unmatched "}"');
    expect(() => expandStorePathPattern(home, "agents/{}")).toThrow("invalid placeholder name");
    expect(() => expandStorePathPattern(home, "agents/{agent-id}")).toThrow("invalid placeholder name");
    expect(() => expandStorePathPattern(home, "agents//foo.json")).toThrow("empty path segment");
    expect(() => expandStorePathPattern(home, "../etc/passwd")).toThrow("path traversal");
    expect(() => expandStorePathPattern(home, "/etc/passwd")).toThrow("relative POSIX path");
  });

  it("fails closed when traversal encounters a symbolic link", () => {
    if (process.platform === "win32") return; // symlink creation needs elevated rights on Windows CI
    const home = makeHomeDir();
    fs.mkdirSync(path.join(home, "real-dir"));
    fs.writeFileSync(path.join(home, "real-dir", "file.json"), "{}");
    fs.symlinkSync(path.join(home, "real-dir"), path.join(home, "agents"));
    expect(() => expandStorePathPattern(home, "agents/file.json")).toThrow("symbolic link");
  });
});

describe("createDataEpochCheckpointProvider: capture by format", () => {
  it("captures a single json file byte-for-byte with a matching sha256", async () => {
    const home = makeHomeDir();
    fs.mkdirSync(path.join(home, "user"), { recursive: true });
    const sourceBytes = Buffer.from(JSON.stringify({ locale: "zh" }));
    fs.writeFileSync(path.join(home, "user", "preferences.json"), sourceBytes);
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    const provider = createDataEpochCheckpointProvider({ stores: [store] });

    const receipt = await provider.create({
      homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "t-json", affectedStoreIds: ["json-store"],
    });

    expect(receipt.itemCount).toBe(1);
    expect(receipt.totalBytes).toBe(sourceBytes.length);
    const capturedPath = path.join(home, "data-epoch-checkpoints", "t-json", "stores", "json-store", "user", "preferences.json");
    expect(fs.readFileSync(capturedPath)).toEqual(sourceBytes);
    const metadata = JSON.parse(fs.readFileSync(path.join(home, "data-epoch-checkpoints", "t-json", "metadata.json"), "utf8"));
    expect(metadata).toMatchObject({ formatVersion: 1, transitionId: "t-json", complete: true });
    expect(metadata.items).toEqual([
      { storeId: "json-store", relPath: "user/preferences.json", bytes: sourceBytes.length, sha256: sha256Hex(sourceBytes) },
    ]);
    await expect(provider.verify(receipt)).resolves.toBeUndefined();
  });

  it("captures a real better-sqlite3 database including a row that only exists in the WAL", async () => {
    const home = makeHomeDir();
    fs.mkdirSync(path.join(home, "db"), { recursive: true });
    const dbPath = path.join(home, "db", "facts.db");
    const Database = (await import("better-sqlite3")).default;
    const writer = new Database(dbPath);
    writer.pragma("journal_mode = WAL");
    writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    writer.prepare("INSERT INTO t (v) VALUES (?)").run("wal-only-row");
    // Deliberately do not close/checkpoint the writer before capturing —
    // the row must exist only in the -wal sidecar at capture time.
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);

    const store = testStore({ id: "sqlite-store", format: "sqlite", pathKind: "file", pathPatterns: ["db/facts.db"] });
    const provider = createDataEpochCheckpointProvider({ stores: [store] });
    const receipt = await provider.create({
      homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "t-sqlite", affectedStoreIds: ["sqlite-store"],
    });
    writer.close();

    expect(receipt.itemCount).toBe(1);
    const capturedPath = path.join(home, "data-epoch-checkpoints", "t-sqlite", "stores", "sqlite-store", "db", "facts.db");
    expect(fs.existsSync(`${capturedPath}-wal`)).toBe(false); // backup publishes one self-contained file
    const check = new Database(capturedPath, { readonly: true });
    expect(check.prepare("SELECT * FROM t").all()).toEqual([{ id: 1, v: "wal-only-row" }]);
    expect(check.pragma("integrity_check", { simple: true })).toBe("ok");
    check.close();
    await expect(provider.verify(receipt)).resolves.toBeUndefined();
  });

  it("never captures sqlite -wal/-shm sidecar patterns as independent items", async () => {
    const home = makeHomeDir();
    fs.mkdirSync(path.join(home, "db"), { recursive: true });
    const dbPath = path.join(home, "db", "manifest.db");
    const Database = (await import("better-sqlite3")).default;
    const writer = new Database(dbPath);
    writer.pragma("journal_mode = WAL");
    writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    writer.prepare("INSERT INTO t DEFAULT VALUES").run();

    const store = testStore({
      id: "manifest-sqlite",
      format: "sqlite",
      pathKind: "file",
      pathPatterns: ["db/manifest.db", "db/manifest.db-wal", "db/manifest.db-shm"],
    });
    const provider = createDataEpochCheckpointProvider({ stores: [store] });
    const receipt = await provider.create({
      homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "t-sidecar", affectedStoreIds: ["manifest-sqlite"],
    });
    writer.close();

    expect(receipt.itemCount).toBe(1);
    const metadata = JSON.parse(fs.readFileSync(path.join(home, "data-epoch-checkpoints", "t-sidecar", "metadata.json"), "utf8"));
    expect(metadata.items.map((item: { relPath: string }) => item.relPath)).toEqual(["db/manifest.db"]);
  });

  it("captures every file under a matched directory-tree pattern with individual hashes", async () => {
    const home = makeHomeDir();
    fs.mkdirSync(path.join(home, "blobs", "bucket-1", "nested"), { recursive: true });
    fs.writeFileSync(path.join(home, "blobs", "bucket-1", "a.bin"), "aaa");
    fs.writeFileSync(path.join(home, "blobs", "bucket-1", "nested", "b.bin"), "bbbb");

    const store = testStore({ id: "tree-store", format: "mixed-directory", pathKind: "tree", pathPatterns: ["blobs/{bucketId}"] });
    const provider = createDataEpochCheckpointProvider({ stores: [store] });
    const receipt = await provider.create({
      homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "t-tree", affectedStoreIds: ["tree-store"],
    });

    expect(receipt.itemCount).toBe(2);
    const metadata = JSON.parse(fs.readFileSync(path.join(home, "data-epoch-checkpoints", "t-tree", "metadata.json"), "utf8"));
    const items = [...metadata.items].sort((left: { relPath: string }, right: { relPath: string }) => left.relPath.localeCompare(right.relPath));
    expect(items).toEqual([
      { storeId: "tree-store", relPath: "blobs/bucket-1/a.bin", bytes: 3, sha256: sha256Hex(Buffer.from("aaa")) },
      { storeId: "tree-store", relPath: "blobs/bucket-1/nested/b.bin", bytes: 4, sha256: sha256Hex(Buffer.from("bbbb")) },
    ]);
    await expect(provider.verify(receipt)).resolves.toBeUndefined();
  });

  it("throws when affectedStoreIds references an id absent from the injected registry", async () => {
    const home = makeHomeDir();
    const provider = createDataEpochCheckpointProvider({ stores: [] });
    await expect(provider.create({
      homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "t-unknown", affectedStoreIds: ["nope"],
    })).rejects.toThrow("unknown store id");
    expect(fs.existsSync(path.join(home, "data-epoch-checkpoints"))).toBe(false);
  });
});

describe("createDataEpochCheckpointProvider: verify failure attribution", () => {
  it("throws an attributable error when a published byte is tampered with", async () => {
    const home = makeHomeDir();
    fs.mkdirSync(path.join(home, "user"), { recursive: true });
    fs.writeFileSync(path.join(home, "user", "preferences.json"), JSON.stringify({ a: 1 }));
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    const provider = createDataEpochCheckpointProvider({ stores: [store] });
    const receipt = await provider.create({
      homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "t-tamper", affectedStoreIds: ["json-store"],
    });
    await expect(provider.verify(receipt)).resolves.toBeUndefined();

    const capturedPath = path.join(receipt.dir, "stores", "json-store", "user", "preferences.json");
    const bytes = fs.readFileSync(capturedPath);
    bytes[0] = bytes[0] ^ 0xff;
    fs.writeFileSync(capturedPath, bytes);

    await expect(provider.verify(receipt)).rejects.toThrow("json-store");
    await expect(provider.verify(receipt)).rejects.toThrow("user/preferences.json");
  });

  it("throws when a captured file is missing entirely", async () => {
    const home = makeHomeDir();
    fs.mkdirSync(path.join(home, "user"), { recursive: true });
    fs.writeFileSync(path.join(home, "user", "preferences.json"), "{}");
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    const provider = createDataEpochCheckpointProvider({ stores: [store] });
    const receipt = await provider.create({
      homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "t-missing", affectedStoreIds: ["json-store"],
    });
    fs.rmSync(path.join(receipt.dir, "stores", "json-store", "user", "preferences.json"));

    await expect(provider.verify(receipt)).rejects.toThrow("json-store");
  });
});

describe("createDataEpochCheckpointProvider: idempotent create()", () => {
  it("reuses a previously published checkpoint for the same transitionId without recapturing", async () => {
    const home = makeHomeDir();
    fs.mkdirSync(path.join(home, "user"), { recursive: true });
    fs.writeFileSync(path.join(home, "user", "preferences.json"), "{}");
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    const provider = createDataEpochCheckpointProvider({ stores: [store] });

    const first = await provider.create({
      homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "t-idem", affectedStoreIds: ["json-store"],
    });
    fs.writeFileSync(path.join(home, "user", "preferences.json"), JSON.stringify({ changed: true }));
    const second = await provider.create({
      homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "t-idem", affectedStoreIds: ["json-store"],
    });

    expect(second).toEqual(first);
    const capturedPath = path.join(home, "data-epoch-checkpoints", "t-idem", "stores", "json-store", "user", "preferences.json");
    expect(fs.readFileSync(capturedPath, "utf8")).toBe("{}");
  });

  it("quarantines a corrupted published directory under an .invalid- suffix and rebuilds fresh, without deleting the original", async () => {
    const home = makeHomeDir();
    fs.mkdirSync(path.join(home, "user"), { recursive: true });
    fs.writeFileSync(path.join(home, "user", "preferences.json"), "{}");
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    const provider = createDataEpochCheckpointProvider({ stores: [store] });

    const first = await provider.create({
      homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "t-bad", affectedStoreIds: ["json-store"],
    });
    fs.writeFileSync(path.join(first.dir, "stores", "json-store", "user", "preferences.json"), "corrupted");

    const second = await provider.create({
      homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "t-bad", affectedStoreIds: ["json-store"],
    });
    expect(second.id).toBe(first.id);
    expect(fs.readFileSync(path.join(second.dir, "stores", "json-store", "user", "preferences.json"), "utf8")).toBe("{}");

    const checkpointsRoot = path.join(home, "data-epoch-checkpoints");
    const entries = fs.readdirSync(checkpointsRoot);
    expect(entries.some((name) => name.startsWith("t-bad.invalid-"))).toBe(true);
    await expect(provider.verify(second)).resolves.toBeUndefined();
  });

  it("cleans up a stale .tmp- staging directory left by an earlier crashed attempt before rebuilding", async () => {
    const home = makeHomeDir();
    fs.mkdirSync(path.join(home, "user"), { recursive: true });
    fs.writeFileSync(path.join(home, "user", "preferences.json"), "{}");
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    const provider = createDataEpochCheckpointProvider({ stores: [store] });

    const checkpointsRoot = path.join(home, "data-epoch-checkpoints");
    const staleTmp = path.join(checkpointsRoot, "t-crash.tmp-99999-deadbeef");
    fs.mkdirSync(staleTmp, { recursive: true });
    fs.writeFileSync(path.join(staleTmp, "partial.txt"), "leftover from a simulated crash");

    const receipt = await provider.create({
      homeDir: home, fromEpoch: 1, toEpoch: 2, transitionId: "t-crash", affectedStoreIds: ["json-store"],
    });

    expect(fs.existsSync(staleTmp)).toBe(false);
    expect(fs.readdirSync(checkpointsRoot)).toEqual(["t-crash"]);
    await expect(provider.verify(receipt)).resolves.toBeUndefined();
  });
});

describe("pruneDataEpochCheckpoints", () => {
  function writeFakeCheckpoint(checkpointsRoot: string, id: string, createdAt: string, bytes: number) {
    const dir = path.join(checkpointsRoot, id);
    fs.mkdirSync(path.join(dir, "stores", "json-store", "user"), { recursive: true });
    fs.writeFileSync(path.join(dir, "stores", "json-store", "user", "preferences.json"), "{}");
    const metadata = {
      formatVersion: 1,
      transitionId: id,
      fromEpoch: 1,
      toEpoch: 2,
      affectedStoreIds: ["json-store"],
      createdAt,
      items: [{ storeId: "json-store", relPath: "user/preferences.json", bytes, sha256: "0".repeat(64) }],
      complete: true,
    };
    fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(metadata));
  }

  it("is a no-op when no checkpoints directory exists yet", async () => {
    const home = makeHomeDir();
    await expect(pruneDataEpochCheckpoints({ homeDir: home })).resolves.toEqual({ retained: [], removed: [] });
  });

  it("keeps the newest 2 published checkpoints plus any journal-referenced older one, deletes the rest", async () => {
    const home = makeHomeDir();
    const checkpointsRoot = path.join(home, "data-epoch-checkpoints");
    writeFakeCheckpoint(checkpointsRoot, "c0-oldest-unreferenced", "2026-01-01T00:00:00.000Z", 10);
    writeFakeCheckpoint(checkpointsRoot, "c1-old-but-referenced", "2026-01-02T00:00:00.000Z", 10);
    writeFakeCheckpoint(checkpointsRoot, "c2", "2026-01-03T00:00:00.000Z", 10);
    writeFakeCheckpoint(checkpointsRoot, "c3-newest", "2026-01-04T00:00:00.000Z", 10);

    await writeDataEpochJournal(home, {
      transitionId: "in-progress",
      fromEpoch: 1,
      toEpoch: 2,
      migrationIds: ["m-1"],
      affectedStoreIds: ["json-store"],
      recoveryModes: { "m-1": "restore-only" },
      phase: "checkpoint_complete",
      checkpointId: "c1-old-but-referenced",
      checkpointReceipt: { id: "c1-old-but-referenced" },
      lastVersion: "test",
    });

    const result = await pruneDataEpochCheckpoints({ homeDir: home });
    expect(new Set(result.retained)).toEqual(new Set(["c1-old-but-referenced", "c2", "c3-newest"]));
    expect(result.removed).toEqual(["c0-oldest-unreferenced"]);
    expect(fs.existsSync(path.join(checkpointsRoot, "c0-oldest-unreferenced"))).toBe(false);
    expect(fs.existsSync(path.join(checkpointsRoot, "c1-old-but-referenced"))).toBe(true);
  });

  it("never removes the checkpoint referenced by an incomplete journal, and leaves .tmp-/.invalid- entries untouched", async () => {
    const home = makeHomeDir();
    const checkpointsRoot = path.join(home, "data-epoch-checkpoints");
    writeFakeCheckpoint(checkpointsRoot, "protected", "2026-01-01T00:00:00.000Z", 10);
    fs.mkdirSync(path.join(checkpointsRoot, "protected.tmp-1-abc"), { recursive: true });
    fs.mkdirSync(path.join(checkpointsRoot, "protected.invalid-123"), { recursive: true });

    await writeDataEpochJournal(home, {
      transitionId: "in-progress",
      fromEpoch: 1,
      toEpoch: 2,
      migrationIds: ["m-1"],
      affectedStoreIds: ["json-store"],
      recoveryModes: { "m-1": "restore-only" },
      phase: "checkpoint_complete",
      checkpointId: "protected",
      checkpointReceipt: { id: "protected" },
      lastVersion: "test",
    });

    const result = await pruneDataEpochCheckpoints({ homeDir: home });
    expect(result.retained).toEqual(["protected"]);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(checkpointsRoot, "protected.tmp-1-abc"))).toBe(true);
    expect(fs.existsSync(path.join(checkpointsRoot, "protected.invalid-123"))).toBe(true);
  });

  it("evicts the older retained checkpoint once total size exceeds the 2 GiB cap, keeping at least one", async () => {
    const home = makeHomeDir();
    const checkpointsRoot = path.join(home, "data-epoch-checkpoints");
    const oneAndHalfGiB = Math.floor(1024 * 1024 * 1024 * 1.5);
    writeFakeCheckpoint(checkpointsRoot, "old", "2026-01-01T00:00:00.000Z", oneAndHalfGiB);
    writeFakeCheckpoint(checkpointsRoot, "new", "2026-01-02T00:00:00.000Z", oneAndHalfGiB);

    const result = await pruneDataEpochCheckpoints({ homeDir: home });
    expect(result.retained).toEqual(["new"]);
    expect(result.removed).toEqual(["old"]);
  });

  it("never evicts a journal-protected checkpoint for size, even if it alone exceeds the cap", async () => {
    const home = makeHomeDir();
    const checkpointsRoot = path.join(home, "data-epoch-checkpoints");
    const threeGiB = 3 * 1024 * 1024 * 1024;
    writeFakeCheckpoint(checkpointsRoot, "huge-protected", "2026-01-01T00:00:00.000Z", threeGiB);

    await writeDataEpochJournal(home, {
      transitionId: "in-progress",
      fromEpoch: 1,
      toEpoch: 2,
      migrationIds: ["m-1"],
      affectedStoreIds: ["json-store"],
      recoveryModes: { "m-1": "restore-only" },
      phase: "checkpoint_complete",
      checkpointId: "huge-protected",
      checkpointReceipt: { id: "huge-protected" },
      lastVersion: "test",
    });

    const result = await pruneDataEpochCheckpoints({ homeDir: home });
    expect(result.retained).toEqual(["huge-protected"]);
    expect(result.removed).toEqual([]);
  });

  it("refuses to prune while the transition journal is corrupt, rather than guess at protection", async () => {
    const home = makeHomeDir();
    fs.writeFileSync(dataEpochJournalPath(home), "not valid json{{{");
    await expect(pruneDataEpochCheckpoints({ homeDir: home })).rejects.toThrow("corrupt");
  });
});
