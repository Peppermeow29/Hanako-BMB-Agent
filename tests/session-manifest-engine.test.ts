import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HanaEngine } from "../core/engine.ts";
import { SessionManifestResolver } from "../core/session-manifest/resolver.ts";
import { LEGACY_SESSION_MANIFEST_MIGRATION_KEY } from "../core/session-manifest/startup-migration.ts";
import { LEGACY_META_SCAN_LEDGER_KEY } from "../core/session-manifest/legacy-migration.ts";
import { SessionManifestStore } from "../core/session-manifest/store.ts";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";

describe("HanaEngine session manifest facade", () => {
  let tmpDir;
  let store;
  let engine;
  let nextId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-manifest-engine-"));
    nextId = 1;
    store = new SessionManifestStore({
      dbPath: path.join(tmpDir, "session-manifest.db"),
      idGenerator: () => `sess_engine_${String(nextId++).padStart(4, "0")}`,
      now: () => "2026-06-18T05:00:00.000Z",
    });
    engine = Object.create(HanaEngine.prototype);
    engine._sessionManifestStore = store;
    engine._sessionManifestResolver = new SessionManifestResolver({ store });
    engine._sessionFiles = new SessionFileRegistry({ now: () => 1234 });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves session refs without exposing the store implementation", () => {
    const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "alpha.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "");
    const manifest = store.createForPath({ sessionPath, ownerAgentId: "hana" });

    expect(engine.resolveSessionRef({ sessionPath }).sessionId).toBe(manifest.sessionId);
    expect(engine.getSessionManifest(manifest.sessionId)?.currentLocator.path).toBe(path.resolve(sessionPath));
    expect(engine.getSessionIdForPath(sessionPath)).toBe(manifest.sessionId);
  });

  it("establishes one explicit SessionRef before non-desktop runtimes start", () => {
    const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "bridge", "owner", "alpha.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "");

    const first = engine.ensureSessionRefForPath(sessionPath, {
      ownerAgentId: "hana",
      domain: "bridge",
      kind: "bridge_owner",
      provenance: { createdBy: "bridge" },
    });
    const second = engine.ensureSessionRefForPath(sessionPath, {
      ownerAgentId: "hana",
      domain: "bridge",
      kind: "bridge_owner",
    });

    expect(second).toEqual(first);
    expect(store.getBySessionId(first.sessionId)).toMatchObject({
      ownerAgentId: "hana",
      domain: "bridge",
      kind: "bridge_owner",
      currentLocator: { path: path.resolve(sessionPath) },
    });
  });

  it("tombstones short-lived runtime identity before its locator is removed", () => {
    const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "temp", "alpha.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "");
    const sessionRef = engine.ensureSessionRefForPath(sessionPath, {
      ownerAgentId: "hana",
      domain: "activity",
      kind: "hub_temporary",
    });

    expect(engine.tombstoneSessionRef(sessionRef, "test_cleanup")).toEqual(sessionRef);
    expect(store.getBySessionId(sessionRef.sessionId)).toMatchObject({ lifecycle: "deleted" });
  });

  it("treats conflicted path lookups as unavailable instead of throwing through nullable facades", () => {
    const firstPath = path.join(tmpDir, "agents", "hana", "sessions", "first.jsonl");
    const secondPath = path.join(tmpDir, "agents", "hana", "sessions", "second.jsonl");
    fs.mkdirSync(path.dirname(firstPath), { recursive: true });
    fs.writeFileSync(firstPath, "");
    fs.writeFileSync(secondPath, "");
    const first = store.createForPath({ sessionPath: firstPath, ownerAgentId: "hana" });
    const second = store.createForPath({ sessionPath: secondPath, ownerAgentId: "hana" });
    store.db.prepare(`
      INSERT INTO session_locator_history (
        session_id,
        locator_type,
        locator_path,
        locator_key,
        reason,
        created_at
      ) VALUES (?, 'jsonl', ?, ?, 'test_conflict', '2026-06-18T05:00:00.000Z')
    `).run(second.sessionId, first.currentLocator.path, first.currentLocator.key);

    expect(engine.getSessionIdForPath(firstPath)).toBeNull();
  });

  it("adds sessionId to session file registrations when callers still pass only sessionPath", () => {
    const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "alpha.jsonl");
    const filePath = path.join(tmpDir, "report.md");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "");
    fs.writeFileSync(filePath, "# report\n");
    const manifest = store.createForPath({ sessionPath, ownerAgentId: "hana" });

    const file = engine.registerSessionFile({
      sessionPath,
      filePath,
      origin: "stage_files",
    });

    expect(file.sessionId).toBe(manifest.sessionId);
  });

  it("resolves session files by sessionId through the manifest current locator", () => {
    const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "alpha.jsonl");
    const filePath = path.join(tmpDir, "report.md");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "");
    fs.writeFileSync(filePath, "# report\n");
    const manifest = store.createForPath({ sessionPath, ownerAgentId: "hana" });
    const file = engine.registerSessionFile({
      sessionPath,
      filePath,
      origin: "stage_files",
    });
    engine._sessionFiles = new SessionFileRegistry({ now: () => 5678 });

    const restored = engine.getSessionFile(file.fileId || file.id, { sessionId: manifest.sessionId });

    expect(restored).toMatchObject({
      id: file.id,
      sessionId: manifest.sessionId,
      sessionPath,
      filePath,
    });
  });

  it("resolveUtilityConfig 以 manifest 归属选择 agent 配置（不再从路径推导）", () => {
    const sessionPath = path.join(tmpDir, "agents", "bob", "sessions", "utility.jsonl");
    engine._agentMgr = { agentIdFromSessionPath: () => "bob" }; // 旧链路：路径口径
    engine._sessionCoord = {
      resolveSessionOwnership: () => ({ agentId: "hana", source: "manifest", agentDeleted: false }),
    };
    engine._configCoord = {
      resolveUtilityConfig: (opts) => ({ requestedAgentId: opts?.agentId || null }),
    };
    engine._usageLedger = null;

    const config = engine.resolveUtilityConfig({ sessionPath });

    expect(config.requestedAgentId).toBe("hana");
    expect(config.usageAgentId).toBe("hana");
  });
});

describe("HanaEngine session manifest startup migration", () => {
  let tmpDir;
  let engine;

  afterEach(() => {
    engine?._sessionManifestStore?.close?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("migrates legacy session files during engine construction", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-manifest-engine-startup-"));
    const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "alpha.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, `${JSON.stringify({
      type: "session",
      id: "alpha",
      timestamp: "2026-06-18T06:10:00.000Z",
    })}\n`);

    engine = new HanaEngine({
      hanakoHome: tmpDir,
      productDir: tmpDir,
      agentId: "hana",
      appVersion: "9.9.9",
    } as any);

    const sessionId = engine.getSessionIdForPath(sessionPath);
    const migrationState = engine._sessionManifestStore.getState(LEGACY_SESSION_MANIFEST_MIGRATION_KEY);

    expect(sessionId).toMatch(/^sess_/);
    expect(engine._sessionManifestMigration.status).toBe("completed");
    expect(migrationState).toMatchObject({
      completedAt: expect.any(String),
      result: { scanned: 1, created: 1, existing: 0, skipped: 0 },
    });
    expect(fs.existsSync(path.join(migrationState.checkpointDirectory, "checkpoint.json"))).toBe(true);
  });

  it("quarantines a corrupt manifest database and still starts with migrated legacy sessions", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-manifest-engine-corrupt-"));
    const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "alpha.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, `${JSON.stringify({
      type: "session",
      id: "alpha",
      timestamp: "2026-06-18T06:10:00.000Z",
    })}\n`);
    fs.writeFileSync(path.join(tmpDir, "session-manifest.db"), "not sqlite");
    fs.writeFileSync(path.join(tmpDir, "session-manifest.db-wal"), "bad wal");

    engine = new HanaEngine({
      hanakoHome: tmpDir,
      productDir: tmpDir,
      agentId: "hana",
      appVersion: "9.9.9",
    } as any);

    expect(engine.getSessionIdForPath(sessionPath)).toMatch(/^sess_/);
    expect(engine._sessionManifestMigration.status).toBe("completed");
    expect(fs.existsSync(path.join(tmpDir, "session-manifest.db"))).toBe(true);
    const manifestDbNames = fs.readdirSync(tmpDir);
    expect(manifestDbNames.some((name) => name.startsWith("session-manifest.db.quarantine-"))).toBe(true);

    const activeWalPath = path.join(tmpDir, "session-manifest.db-wal");
    const activeWalIsOriginalBadSidecar = fs.existsSync(activeWalPath)
      && fs.readFileSync(activeWalPath, "utf-8") === "bad wal";
    expect(
      manifestDbNames.some((name) => name.startsWith("session-manifest.db-wal.quarantine-"))
      || !activeWalIsOriginalBadSidecar,
    ).toBe(true);
  });
});

describe("HanaEngine getSessionMetadataRecoveryStatus", () => {
  let tmpDir;
  let store;
  let engine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-meta-recovery-"));
    store = new SessionManifestStore({
      dbPath: path.join(tmpDir, "session-manifest.db"),
      idGenerator: () => `sess_recovery_${Math.random()}`,
      now: () => "2026-07-23T00:00:00.000Z",
    });
    engine = Object.create(HanaEngine.prototype);
    engine._sessionManifestStore = store;
    engine._sessionManifestStoreRecovery = null;
    engine._sessionCoord = { listMetaQuarantines: () => [] };
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("three sources empty → not degraded", () => {
    expect(engine.getSessionMetadataRecoveryStatus()).toEqual({ degraded: false, reasons: [] });
  });

  it("runtime meta quarantine → degraded with meta_quarantined reason", () => {
    const metaPath = path.join(tmpDir, "agents", "hana", "sessions", "session-meta.json");
    engine._sessionCoord = {
      listMetaQuarantines: () => [{
        metaPath,
        backupPath: path.join(tmpDir, "agents", "hana", "sessions", "session-meta.oversized.111.json"),
        quarantinedAt: "2026-07-23T00:00:00.000Z",
      }],
    };

    const result = engine.getSessionMetadataRecoveryStatus();

    expect(result.degraded).toBe(true);
    expect(result.reasons).toEqual([
      { kind: "meta_quarantined", detail: "hana/session-meta.json" },
    ]);
  });

  it("unavailable session manifest store → degraded with store_unavailable reason", () => {
    engine._sessionManifestStoreRecovery = { status: "unavailable", error: new Error(`boom at ${tmpDir}`) };

    const result = engine.getSessionMetadataRecoveryStatus();

    expect(result.degraded).toBe(true);
    expect(result.reasons).toEqual([
      { kind: "store_unavailable", detail: expect.any(String) },
    ]);
    // 隐私契约：detail 不得携带 hanaHome 绝对路径（不能直接透传 error.message）。
    expect(result.reasons[0].detail).not.toContain(tmpDir);
  });

  it("quarantined session manifest store → degraded with store_quarantined reason", () => {
    engine._sessionManifestStoreRecovery = { status: "quarantined", error: new Error("corrupt") };

    const result = engine.getSessionMetadataRecoveryStatus();

    expect(result.degraded).toBe(true);
    expect(result.reasons).toEqual([
      { kind: "store_quarantined", detail: expect.any(String) },
    ]);
  });

  it("legacy scan ledger with too_large entries → degraded with meta_skipped reason", () => {
    const skippedPath = path.join(tmpDir, "agents", "bob", "sessions", "session-meta.json");
    store.setState(LEGACY_META_SCAN_LEDGER_KEY, {
      [skippedPath]: { size: 999_999_999, mtimeMs: 1, status: "too_large", recordedAt: "2026-07-23T00:00:00.000Z" },
    });

    const result = engine.getSessionMetadataRecoveryStatus();

    expect(result.degraded).toBe(true);
    expect(result.reasons).toEqual([
      { kind: "meta_skipped", detail: "bob/session-meta.json" },
    ]);
  });

  it("all three sources firing at once → all reasons present", () => {
    const quarantinedPath = path.join(tmpDir, "agents", "hana", "sessions", "session-meta.json");
    const skippedPath = path.join(tmpDir, "agents", "bob", "sessions", "session-titles.json");
    engine._sessionManifestStoreRecovery = { status: "unavailable", error: new Error("boom") };
    engine._sessionCoord = {
      listMetaQuarantines: () => [{
        metaPath: quarantinedPath,
        backupPath: `${quarantinedPath}.oversized.1.json`,
        quarantinedAt: "2026-07-23T00:00:00.000Z",
      }],
    };
    store.setState(LEGACY_META_SCAN_LEDGER_KEY, {
      [skippedPath]: { size: 1, mtimeMs: 1, status: "parse_error", recordedAt: "2026-07-23T00:00:00.000Z" },
    });

    const result = engine.getSessionMetadataRecoveryStatus();

    expect(result.degraded).toBe(true);
    expect(result.reasons.map((r) => r.kind).sort()).toEqual(
      ["meta_quarantined", "meta_skipped", "store_unavailable"].sort(),
    );
  });

  it("getter throwing does not propagate — caller (server route) is responsible for its own fallback, this only proves listSkippedMetaSources tolerates a null store", () => {
    engine._sessionManifestStore = null;
    expect(engine.getSessionMetadataRecoveryStatus()).toEqual({ degraded: false, reasons: [] });
  });
});
