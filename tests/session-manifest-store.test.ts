import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_MANIFEST_DB_USER_VERSION,
  SessionManifestStore,
  loadBetterSqliteDatabase,
} from "../core/session-manifest/store.ts";
import { sessionLocatorKey } from "../core/session-manifest/path-normalizer.ts";

const SQLITE_HOOK_TIMEOUT_MS = 30_000;

describe("SessionManifestStore", () => {
  let tmpDir;
  let store;
  let nextId;
  let nowIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-manifest-"));
    nextId = 1;
    nowIndex = 0;
    store = new SessionManifestStore({
      dbPath: path.join(tmpDir, "session-manifest.db"),
      idGenerator: () => `sess_test_${String(nextId++).padStart(4, "0")}`,
      now: () => `2026-06-18T00:00:${String(nowIndex++).padStart(2, "0")}.000Z`,
    });
  }, SQLITE_HOOK_TIMEOUT_MS);

  afterEach(() => {
    store?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, SQLITE_HOOK_TIMEOUT_MS);

  function createSessionFile(name) {
    const sessionPath = path.join(tmpDir, "sessions", `${name}.jsonl`);
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "");
    return sessionPath;
  }

  function linkDirectory(target, linkPath) {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  }

  it("creates one durable session identity for a session file path", () => {
    const sessionPath = createSessionFile("alpha");

    const manifest = store.createForPath({ sessionPath, domain: "home", kind: "chat" });
    const repeated = store.createForPath({ sessionPath, domain: "home", kind: "chat" });

    expect(manifest.sessionId).toBe("sess_test_0001");
    expect(repeated.sessionId).toBe(manifest.sessionId);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.domain).toBe("home");
    expect(manifest.kind).toBe("chat");
    expect(manifest.currentLocator.path).toBe(path.resolve(sessionPath));
    expect(manifest.currentLocator.key).toBe(sessionLocatorKey(sessionPath));
    expect(manifest.memoryPolicy).toEqual({ mode: "inherit", inheritedFrom: "agent_default" });
    expect(manifest.permissionModeSnapshot.mode).toBe("auto");
    expect(store.getBySessionId(manifest.sessionId)?.sessionId).toBe(manifest.sessionId);
    expect(store.resolveByLocatorPath(sessionPath)?.sessionId).toBe(manifest.sessionId);
    expect(store.db.pragma("user_version", { simple: true })).toBe(SESSION_MANIFEST_DB_USER_VERSION);
  });

  it("keeps previous locators resolvable when the session file moves", () => {
    const oldPath = createSessionFile("move-before");
    const nextPath = path.join(tmpDir, "archive", "move-after.jsonl");
    const manifest = store.createForPath({ sessionPath: oldPath, domain: "home" });
    const oldLocatorPath = path.resolve(oldPath);
    fs.mkdirSync(path.dirname(nextPath), { recursive: true });
    fs.renameSync(oldPath, nextPath);

    const moved = store.updateLocator(manifest.sessionId, nextPath, "archive");

    expect(moved.currentLocator.path).toBe(path.resolve(nextPath));
    expect(moved.currentLocator.reason).toBe("archive");
    expect(store.resolveByLocatorPath(oldPath)?.sessionId).toBe(manifest.sessionId);
    expect(store.resolveByLocatorPath(nextPath)?.sessionId).toBe(manifest.sessionId);
    expect(store.getLocatorHistory(manifest.sessionId)).toEqual([
      expect.objectContaining({
        path: oldLocatorPath,
        reason: "archive",
      }),
    ]);
  });

  it("changes lifecycle classification atomically and preserves deleted locator history", () => {
    const activityPath = createSessionFile("activity-before-promotion");
    const desktopPath = path.join(tmpDir, "agents", "hana", "sessions", "promoted.jsonl");
    const manifest = store.createForPath({
      sessionPath: activityPath,
      domain: "activity",
      kind: "activity",
      lifecycle: "active",
    });

    const promoted = store.updateLocatorLifecycle(
      manifest.sessionId,
      desktopPath,
      "active",
      "activity_session_promoted",
      { domain: "desktop", kind: "chat" },
    );
    const deleted = store.updateLocatorLifecycle(
      manifest.sessionId,
      desktopPath,
      "deleted",
      "archived_session_deleted",
    );

    expect(promoted).toMatchObject({ domain: "desktop", kind: "chat", lifecycle: "active" });
    expect(deleted).toMatchObject({
      domain: "desktop",
      kind: "chat",
      lifecycle: "deleted",
      currentLocator: { path: path.resolve(desktopPath) },
    });
    expect(deleted.deletedAt).toMatch(/^2026-06-18T/);
    expect(store.resolveByLocatorPath(activityPath)?.sessionId).toBe(manifest.sessionId);
    expect(store.resolveByLocatorPath(desktopPath)?.sessionId).toBe(manifest.sessionId);
  });

  it("updates manifest-owned policy, workspace, plugin, and thinking fields by session id", () => {
    const sessionPath = createSessionFile("fields");
    const manifest = store.createForPath({ sessionPath, domain: "home", kind: "chat" });

    store.setMemoryPolicy(manifest.sessionId, { mode: "disabled", inheritedFrom: "session_override" });
    store.setPermissionModeSnapshot(manifest.sessionId, { mode: "operate", source: "session_override" });
    store.setThinkingLevel(manifest.sessionId, "high");
    store.setWorkspaceScope(manifest.sessionId, {
      primaryCwd: tmpDir,
      workspaceFolders: [path.join(tmpDir, "workspace")],
      authorizedFolders: [path.join(tmpDir, "allowed")],
    });
    store.setPlugin(manifest.sessionId, {
      ownerPluginId: "sample-plugin",
      kind: "media",
      visibility: "private",
    });

    expect(store.getBySessionId(manifest.sessionId)).toMatchObject({
      memoryPolicy: { mode: "disabled", inheritedFrom: "session_override" },
      permissionModeSnapshot: { mode: "operate", source: "session_override" },
      thinkingLevel: "high",
      workspaceScope: {
        primaryCwd: tmpDir,
        workspaceFolders: [path.join(tmpDir, "workspace")],
        authorizedFolders: [path.join(tmpDir, "allowed")],
      },
      plugin: {
        ownerPluginId: "sample-plugin",
        kind: "media",
        visibility: "private",
      },
    });
  });

  it("stores capability snapshots by session id", () => {
    const sessionPath = createSessionFile("capabilities");
    const manifest = store.createForPath({ sessionPath, domain: "desktop", kind: "chat" });

    store.setCapabilitySnapshot(manifest.sessionId, {
      toolNames: ["read", "media_generate-image"],
      promptSnapshot: {
        version: 1,
        systemPrompt: "frozen prompt",
        appendSystemPrompt: [],
        skillsResult: { skills: [], diagnostics: [] },
        agentsFilesResult: { agentsFiles: [] },
      },
      capabilityDriftDismissedFingerprint: "fp-old",
    }, { source: "session_create" });

    expect(store.getCapabilitySnapshot(manifest.sessionId)).toMatchObject({
      sessionId: manifest.sessionId,
      source: "session_create",
      toolNames: ["read", "media_generate-image"],
      promptSnapshot: {
        systemPrompt: "frozen prompt",
      },
      capabilityDriftDismissedFingerprint: "fp-old",
    });
  });

  it("stores executor metadata by session id", () => {
    const sessionPath = createSessionFile("executor");
    const manifest = store.createForPath({ sessionPath, domain: "desktop", kind: "chat" });

    store.setExecutorMetadata(manifest.sessionId, {
      executorAgentId: "butter",
      executorAgentNameSnapshot: "Butter",
      executorMetaVersion: 1,
    }, { source: "subagent_runtime" });

    expect(store.getExecutorMetadata(manifest.sessionId)).toMatchObject({
      sessionId: manifest.sessionId,
      executorAgentId: "butter",
      executorAgentNameSnapshot: "Butter",
      executorMetaVersion: 1,
      source: "subagent_runtime",
    });
  });

  it("reports repairable conflicts instead of assigning one locator to two sessions", () => {
    const firstPath = createSessionFile("first");
    const secondPath = createSessionFile("second");
    const first = store.createForPath({ sessionPath: firstPath, domain: "home" });
    const second = store.createForPath({ sessionPath: secondPath, domain: "home" });

    expect(() => store.updateLocator(second.sessionId, firstPath, "repair")).toThrow(
      expect.objectContaining({
        code: "session_locator_conflict",
      }),
    );

    expect(store.resolveByLocatorPath(firstPath)?.sessionId).toBe(first.sessionId);
    expect(store.getBySessionId(second.sessionId)?.currentLocator.path).toBe(path.resolve(secondPath));
  });

  it("keeps the app-facing locator path when a session is reached through a symlinked directory", () => {
    const realSessionsDir = path.join(tmpDir, "external-sessions");
    const logicalSessionsDir = path.join(tmpDir, "agents", "hana", "sessions");
    fs.mkdirSync(realSessionsDir, { recursive: true });
    fs.mkdirSync(path.dirname(logicalSessionsDir), { recursive: true });
    linkDirectory(realSessionsDir, logicalSessionsDir);
    const realSessionPath = path.join(realSessionsDir, "linked.jsonl");
    const logicalSessionPath = path.join(logicalSessionsDir, "linked.jsonl");
    fs.writeFileSync(realSessionPath, "");

    const manifest = store.createForPath({ sessionPath: logicalSessionPath, domain: "desktop" });

    expect(manifest.currentLocator.path).toBe(path.resolve(logicalSessionPath));
    expect(manifest.currentLocator.key).toBe(sessionLocatorKey(realSessionPath));
    expect(store.resolveByLocatorPath(realSessionPath)?.sessionId).toBe(manifest.sessionId);
    expect(store.resolveByLocatorPath(logicalSessionPath)?.sessionId).toBe(manifest.sessionId);
  });

  it("backfillOwnerAgentId 只补缺不覆盖", () => {
    const pathA = createSessionFile("backfill-a");
    const pathB = createSessionFile("backfill-b");
    const a = store.createForPath({ sessionPath: pathA, domain: "desktop", kind: "chat" }); // ownerAgentId null
    const b = store.createForPath({ sessionPath: pathB, ownerAgentId: "hana", domain: "desktop", kind: "chat" });

    expect(store.backfillOwnerAgentId(a.sessionId, "carol").ownerAgentId).toBe("carol");
    expect(store.backfillOwnerAgentId(b.sessionId, "carol").ownerAgentId).toBe("hana"); // 不覆盖
    expect(store.backfillOwnerAgentId(a.sessionId, "").ownerAgentId).toBe("carol");     // 空值 no-op
  });

  it("repairs only known legacy metadata without changing identity or user-owned state", () => {
    const sessionPath = createSessionFile("legacy-subagent");
    const manifest = store.createForPath({
      sessionPath,
      ownerAgentId: null,
      domain: "desktop",
      kind: "chat",
      lifecycle: "active",
      pinnedAt: "2026-06-18T00:10:00.000Z",
      workspaceScope: { primaryCwd: tmpDir, workspaceFolders: [tmpDir] },
      provenance: { legacyAgentId: "hana" },
      migration: {
        source: "legacy_scan",
        legacySessionPath: sessionPath,
        migratedAt: "2026-06-18T00:00:00.000Z",
      },
    });

    const repaired = store.repairLegacyScanMetadata(manifest.sessionId, {
      ownerAgentId: "butter",
      domain: "subagent",
      kind: "subagent_child",
      provenance: {
        createdBy: "subagent",
        threadId: "thread-1",
        threadKind: "direct",
      },
      migration: {
        source: "legacy_scan",
        legacySessionFileName: path.basename(sessionPath),
        legacySources: ["subagent_thread_store", "subagent_session_layout"],
      },
    });
    const repeated = store.repairLegacyScanMetadata(manifest.sessionId, {
      ownerAgentId: "butter",
      domain: "subagent",
      kind: "subagent_child",
      provenance: {
        createdBy: "subagent",
        threadId: "thread-1",
        threadKind: "direct",
      },
      migration: {
        source: "legacy_scan",
        legacySessionFileName: path.basename(sessionPath),
        legacySources: ["subagent_session_layout", "subagent_thread_store"],
      },
    });

    expect(repaired).toMatchObject({
      sessionId: manifest.sessionId,
      ownerAgentId: "butter",
      domain: "subagent",
      kind: "subagent_child",
      lifecycle: "active",
      pinnedAt: "2026-06-18T00:10:00.000Z",
      workspaceScope: { primaryCwd: tmpDir, workspaceFolders: [tmpDir] },
      currentLocator: { path: path.resolve(sessionPath) },
      provenance: {
        legacyAgentId: "hana",
        createdBy: "subagent",
        threadId: "thread-1",
        threadKind: "direct",
      },
      migration: {
        source: "legacy_scan",
        legacySessionPath: sessionPath,
        legacySessionFileName: path.basename(sessionPath),
        legacySources: ["subagent_session_layout", "subagent_thread_store"],
      },
    });
    expect(repeated).toEqual(repaired);
    expect(store.list()).toHaveLength(1);
    expect(store.getLocatorHistory(manifest.sessionId)).toEqual([]);
  });

  it("legacy metadata repair does not overwrite fresh or already-specific data", () => {
    const freshPath = createSessionFile("fresh-phone");
    const fresh = store.createForPath({
      sessionPath: freshPath,
      ownerAgentId: "hana",
      domain: "phone",
      kind: "phone_conversation",
      provenance: { createdBy: "agent_phone", conversationId: "dm_yui" },
      migration: {},
    });
    const legacySpecificPath = createSessionFile("legacy-specific");
    const legacySpecific = store.createForPath({
      sessionPath: legacySpecificPath,
      ownerAgentId: "hana",
      domain: "activity",
      kind: "activity",
      provenance: { createdBy: "activity", activityId: "hb_1" },
      migration: { source: "legacy_scan", legacySessionPath: legacySpecificPath },
    });

    expect(store.repairLegacyScanMetadata(fresh.sessionId, {
      ownerAgentId: "mallory",
      domain: "bridge",
      kind: "bridge_owner",
      provenance: { createdBy: "bridge", bridgeSessionKey: "tg_dm_x" },
      migration: { source: "legacy_scan", legacySources: ["bridge_index"] },
    })).toEqual(fresh);

    const kept = store.repairLegacyScanMetadata(legacySpecific.sessionId, {
      ownerAgentId: "mallory",
      domain: "subagent",
      kind: "subagent_child",
      provenance: { createdBy: "subagent", activityId: "wrong", threadId: "thread-x" },
      migration: { source: "legacy_scan", legacySources: ["subagent_thread_store"] },
    });
    expect(kept).toMatchObject({
      ownerAgentId: "hana",
      domain: "activity",
      kind: "activity",
      provenance: {
        createdBy: "activity",
        activityId: "hb_1",
      },
      migration: {
        source: "legacy_scan",
        legacySessionPath: legacySpecificPath,
      },
    });
  });

  it("repairs resolver-on-demand defaults but preserves its receipt", () => {
    const sessionPath = createSessionFile("resolver-bridge");
    const manifest = store.createForPath({
      sessionPath,
      domain: "home",
      kind: "chat",
      provenance: {},
      migration: {
        legacySessionPath: sessionPath,
        createdBy: "resolver_on_demand",
      },
    });

    const repaired = store.repairLegacyScanMetadata(manifest.sessionId, {
      ownerAgentId: "hana",
      domain: "bridge",
      kind: "bridge_owner",
      provenance: { createdBy: "bridge", bridgeSessionKey: "tg_dm_owner@hana" },
      migration: {
        source: "legacy_scan",
        legacySessionFileName: path.basename(sessionPath),
        legacySources: ["legacy_bridge_index"],
      },
    });

    expect(repaired).toMatchObject({
      sessionId: manifest.sessionId,
      ownerAgentId: "hana",
      domain: "bridge",
      kind: "bridge_owner",
      provenance: { createdBy: "bridge", bridgeSessionKey: "tg_dm_owner@hana" },
      migration: {
        createdBy: "resolver_on_demand",
        source: "legacy_scan",
        legacySessionPath: sessionPath,
        legacySessionFileName: path.basename(sessionPath),
        legacySources: ["legacy_bridge_index"],
      },
    });
  });

  it("persists migration state in the manifest database", () => {
    expect(store.getState("legacy-session-manifest-scan-v1")).toBeNull();

    store.setState("legacy-session-manifest-scan-v1", {
      checkpointDirectory: path.join(tmpDir, "checkpoints", "one"),
      completedAt: "2026-06-18T00:01:00.000Z",
      result: { scanned: 1, created: 1, existing: 0, skipped: 0 },
    });

    expect(store.getState("legacy-session-manifest-scan-v1")).toEqual({
      checkpointDirectory: path.join(tmpDir, "checkpoints", "one"),
      completedAt: "2026-06-18T00:01:00.000Z",
      result: { scanned: 1, created: 1, existing: 0, skipped: 0 },
    });
  });

  it("stores an explicit pin order alongside the pinned timestamp", () => {
    const sessionPath = createSessionFile("pin-order");
    const manifest = store.createForPath({ sessionPath, domain: "desktop", kind: "chat" });

    expect(manifest.pinOrder).toBeNull();

    const pinned = store.setPinnedAt(manifest.sessionId, "2026-06-18T00:10:00.000Z");
    const ordered = store.setPinOrder(manifest.sessionId, -1024);

    expect(pinned.pinnedAt).toBe("2026-06-18T00:10:00.000Z");
    expect(ordered.pinOrder).toBe(-1024);
    expect(store.getBySessionId(manifest.sessionId)?.pinOrder).toBe(-1024);

    expect(store.setPinOrder(manifest.sessionId, null).pinOrder).toBeNull();
    expect(store.getBySessionId(manifest.sessionId)?.pinOrder).toBeNull();
  });

  it("reports the smallest pin order among pinned sessions", () => {
    const first = store.createForPath({ sessionPath: createSessionFile("min-a"), domain: "desktop" });
    const second = store.createForPath({ sessionPath: createSessionFile("min-b"), domain: "desktop" });
    const unpinned = store.createForPath({ sessionPath: createSessionFile("min-c"), domain: "desktop" });

    expect(store.minPinOrder()).toBeNull();

    store.setPinnedAt(first.sessionId, "2026-06-18T00:10:00.000Z");
    store.setPinOrder(first.sessionId, 1024);
    store.setPinnedAt(second.sessionId, "2026-06-18T00:11:00.000Z");
    store.setPinOrder(second.sessionId, -2048);
    // Unpinned rows never contribute an order, even if one was left behind.
    store.setPinOrder(unpinned.sessionId, -9999);

    expect(store.minPinOrder()).toBe(-2048);
  });

  it("adds the pin order column to databases created before it existed", () => {
    const legacyDbPath = path.join(tmpDir, "legacy-pin-order.db");
    const Database = loadBetterSqliteDatabase();
    const legacyDb = new Database(legacyDbPath);
    legacyDb.exec(`
      CREATE TABLE session_manifests (
        session_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        owner_agent_id TEXT,
        domain TEXT NOT NULL,
        kind TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        health TEXT NOT NULL,
        current_locator_type TEXT NOT NULL,
        current_locator_path TEXT NOT NULL,
        current_locator_key TEXT NOT NULL UNIQUE,
        current_locator_reason TEXT,
        locator_updated_at TEXT NOT NULL,
        memory_policy_json TEXT NOT NULL,
        permission_mode_snapshot_json TEXT NOT NULL,
        thinking_level TEXT,
        pinned_at TEXT,
        workspace_scope_json TEXT NOT NULL,
        plugin_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        migration_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
    `);
    legacyDb.prepare(`
      INSERT INTO session_manifests (
        session_id, schema_version, owner_agent_id, domain, kind, lifecycle, health,
        current_locator_type, current_locator_path, current_locator_key, current_locator_reason,
        locator_updated_at, memory_policy_json, permission_mode_snapshot_json, thinking_level,
        pinned_at, workspace_scope_json, plugin_json, provenance_json, migration_json,
        created_at, updated_at, deleted_at
      ) VALUES (
        'sess_legacy_0001', 1, 'hana', 'desktop', 'chat', 'active', 'ok',
        'jsonl', '/tmp/agents/hana/sessions/legacy.jsonl', 'legacy-key', 'create',
        '2026-06-01T00:00:00.000Z', '{"mode":"inherit"}', '{"mode":"auto"}', NULL,
        '2026-06-01T00:05:00.000Z', '{}', 'null', '{}', '{}',
        '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', NULL
      )
    `).run();
    legacyDb.pragma("user_version = 4");
    legacyDb.close();

    const migrated = new SessionManifestStore({ dbPath: legacyDbPath });
    try {
      const columns = migrated.db.pragma("table_info(session_manifests)").map((column) => column.name);
      expect(columns).toContain("pin_order");
      const manifest = migrated.getBySessionId("sess_legacy_0001");
      expect(manifest).toMatchObject({
        sessionId: "sess_legacy_0001",
        ownerAgentId: "hana",
        pinnedAt: "2026-06-01T00:05:00.000Z",
        pinOrder: null,
      });
      expect(migrated.setPinOrder("sess_legacy_0001", 2048).pinOrder).toBe(2048);
    } finally {
      migrated.close();
    }
  });

  it("closes a partially opened database when initialization fails", () => {
    const dbPath = path.join(tmpDir, "broken-init.db");
    const close = vi.fn();
    class FailingDatabase {
      declare close: () => void;

      constructor(filePath: string) {
        expect(filePath).toBe(dbPath);
        this.close = close;
      }

      pragma() {
        throw new Error("file is not a database");
      }
    }

    expect(() => new SessionManifestStore({ dbPath, Database: FailingDatabase })).toThrow(
      "file is not a database",
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});
