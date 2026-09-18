import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_META_SCAN_LEDGER_KEY,
  listSkippedMetaSources,
  migrateLegacySessions,
} from "../core/session-manifest/legacy-migration.ts";
import { SessionManifestStore } from "../core/session-manifest/store.ts";

describe("session manifest legacy migration", () => {
  let hanaHome;
  let store;
  let nextId;

  beforeEach(() => {
    hanaHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-manifest-migration-"));
    nextId = 1;
    store = new SessionManifestStore({
      dbPath: path.join(hanaHome, "session-manifest.db"),
      idGenerator: () => `sess_migrate_${String(nextId++).padStart(4, "0")}`,
      now: () => "2026-06-18T03:00:00.000Z",
    });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(hanaHome, { recursive: true, force: true });
  });

  function writeSession(agentId, fileName, { archived = false } = {}) {
    const sessionDir = path.join(hanaHome, "agents", agentId, "sessions");
    const targetDir = archived ? path.join(sessionDir, "archived") : sessionDir;
    const sessionPath = path.join(targetDir, fileName);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", version: 3, id: fileName, timestamp: "2026-06-18T03:00:00.000Z", cwd: hanaHome }),
      "",
    ].join("\n"));
    return { sessionDir, sessionPath };
  }

  function writeSubagentSession(agentId, fileName) {
    const sessionDir = path.join(hanaHome, "agents", agentId, "subagent-sessions");
    const sessionPath = path.join(sessionDir, fileName);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", version: 3, id: fileName, timestamp: "2026-06-18T03:00:00.000Z", cwd: hanaHome }),
      "",
    ].join("\n"));
    return { sessionDir, sessionPath };
  }

  function writeJsonl(sessionPath) {
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", version: 3, id: path.basename(sessionPath), timestamp: "2026-06-18T03:00:00.000Z", cwd: hanaHome }),
      "",
    ].join("\n"));
    return sessionPath;
  }

  function linkDirectory(target, linkPath) {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  }

  function insertConflictingHistoryLocator(firstPath, secondSessionId) {
    const locatorPath = fs.realpathSync.native(firstPath);
    const locatorKey = process.platform === "win32"
      ? locatorPath.toLocaleLowerCase("en-US")
      : locatorPath;
    store.db.prepare(`
      INSERT INTO session_locator_history (
        session_id,
        locator_type,
        locator_path,
        locator_key,
        reason,
        created_at
      ) VALUES (?, 'jsonl', ?, ?, 'test_conflict', '2026-06-18T03:01:00.000Z')
    `).run(secondSessionId, locatorPath, locatorKey);
  }

  it("creates manifests for active and archived legacy sessions with sidecar semantics", () => {
    const active = writeSession("hana", "active.jsonl");
    const archived = writeSession("hana", "old.jsonl", { archived: true });
    fs.writeFileSync(path.join(active.sessionDir, "session-meta.json"), JSON.stringify({
      "active.jsonl": {
        pinnedAt: "2026-06-18T03:01:00.000Z",
        memoryEnabled: false,
        permissionMode: "auto",
        thinkingLevel: "high",
        workspaceFolders: ["/workspace/a"],
        plugin: {
          ownerPluginId: "sample-plugin",
          kind: "media",
          visibility: "private",
        },
      },
      "old.jsonl": {
        memoryEnabled: true,
        accessMode: "read_only",
      },
    }, null, 2));
    fs.writeFileSync(path.join(active.sessionDir, "session-titles.json"), JSON.stringify({
      [active.sessionPath]: "Active title",
      [path.join(active.sessionDir, "old.jsonl")]: "Archived title",
    }, null, 2));

    const result = migrateLegacySessions({
      hanaHome,
      store,
      migratedAt: "2026-06-18T03:02:00.000Z",
    });

    expect(result).toEqual({ scanned: 2, created: 2, existing: 0, skipped: 0, skippedDetails: [], skippedMetaSources: [] });
    const activeManifest = store.resolveByLocatorPath(active.sessionPath);
    const archivedManifest = store.resolveByLocatorPath(archived.sessionPath);

    expect(activeManifest).toMatchObject({
      sessionId: "sess_migrate_0001",
      ownerAgentId: "hana",
      domain: "desktop",
      kind: "media",
      lifecycle: "active",
      pinnedAt: "2026-06-18T03:01:00.000Z",
      memoryPolicy: { mode: "disabled", inheritedFrom: "legacy_session_meta" },
      permissionModeSnapshot: {
        mode: "auto",
        source: "legacy_session_meta",
        capturedAt: "2026-06-18T03:02:00.000Z",
      },
      thinkingLevel: "high",
      workspaceScope: {
        workspaceFolders: ["/workspace/a"],
      },
      plugin: {
        ownerPluginId: "sample-plugin",
        kind: "media",
        visibility: "private",
      },
      provenance: {
        legacyTitle: "Active title",
        legacyAgentId: "hana",
      },
      migration: {
        legacySessionPath: active.sessionPath,
        source: "legacy_scan",
      },
    });
    expect(archivedManifest).toMatchObject({
      sessionId: "sess_migrate_0002",
      ownerAgentId: "hana",
      lifecycle: "archived",
      memoryPolicy: { mode: "enabled", inheritedFrom: "legacy_session_meta" },
      permissionModeSnapshot: {
        mode: "read_only",
        source: "legacy_session_meta",
      },
      provenance: {
        legacyTitle: "Archived title",
      },
    });

    const titles = JSON.parse(fs.readFileSync(path.join(active.sessionDir, "session-titles.json"), "utf-8"));
    expect(titles[activeManifest.sessionId]).toBe("Active title");
    expect(titles[archivedManifest.sessionId]).toBe("Archived title");
  });

  it("imports capability snapshots and repairs permission from oversized session-meta backups", () => {
    const active = writeSession("hana", "media.jsonl");
    fs.writeFileSync(path.join(active.sessionDir, "session-meta.json"), JSON.stringify({
      "media.jsonl": {
        toolNames: ["read", "bash"],
      },
    }, null, 2));
    fs.writeFileSync(path.join(active.sessionDir, "session-meta.oversized.1781913830749.json"), JSON.stringify({
      "media.jsonl": {
        permissionMode: "auto",
        accessMode: "operate",
        planMode: false,
        toolNames: ["read", "bash", "media_generate-image", "media_generate-video"],
        promptSnapshot: {
          version: 1,
          systemPrompt: "prompt with media tools",
          appendSystemPrompt: [],
          skillsResult: { skills: [], diagnostics: [] },
          agentsFilesResult: { agentsFiles: [] },
        },
      },
    }, null, 2));

    const result = migrateLegacySessions({
      hanaHome,
      store,
      migratedAt: "2026-06-18T03:02:00.000Z",
    });

    expect(result).toMatchObject({
      scanned: 1,
      created: 1,
      existing: 0,
      skipped: 0,
    });
    const manifest = store.resolveByLocatorPath(active.sessionPath);
    expect(manifest.permissionModeSnapshot).toMatchObject({
      mode: "auto",
      source: "legacy_session_meta_backup",
    });
    expect(store.getCapabilitySnapshot(manifest.sessionId)).toMatchObject({
      toolNames: ["read", "bash", "media_generate-image", "media_generate-video"],
      promptSnapshot: {
        systemPrompt: "prompt with media tools",
      },
      source: "legacy_session_meta_backup",
    });
  });

  it("imports subagent executor metadata from legacy subagent sidecars", () => {
    const child = writeSubagentSession("hana", "child.jsonl");
    fs.writeFileSync(path.join(child.sessionDir, "session-meta.json"), JSON.stringify({
      "child.jsonl": {
        executorAgentId: "butter",
        executorAgentNameSnapshot: "Butter",
        executorMetaVersion: 1,
      },
    }, null, 2));

    const result = migrateLegacySessions({
      hanaHome,
      store,
      migratedAt: "2026-06-18T03:02:00.000Z",
    });

    expect(result).toMatchObject({
      scanned: 1,
      created: 1,
      existing: 0,
      skipped: 0,
    });
    const manifest = store.resolveByLocatorPath(child.sessionPath);
    expect(manifest).toMatchObject({
      ownerAgentId: "hana",
      lifecycle: "active",
    });
    expect(store.getExecutorMetadata(manifest.sessionId)).toMatchObject({
      executorAgentId: "butter",
      executorAgentNameSnapshot: "Butter",
      executorMetaVersion: 1,
      source: "legacy_session_meta",
    });
  });

  it("migrates bridge, activity, phone, direct-subagent, and workflow-node sources with explicit classification", () => {
    const agentDir = path.join(hanaHome, "agents", "hana");
    const bridgeDir = path.join(agentDir, "sessions", "bridge");
    const bridgeOwner = writeJsonl(path.join(bridgeDir, "owner", "owner.jsonl"));
    const bridgeGuest = writeJsonl(path.join(bridgeDir, "guests", "guest.jsonl"));
    fs.writeFileSync(path.join(bridgeDir, "bridge-sessions.json"), JSON.stringify({
      "tg_dm_owner@hana": {
        file: "owner/owner.jsonl",
        role: "owner",
        platform: "telegram",
        chatType: "dm",
        promptSnapshot: { version: 1, systemPrompt: "bridge prompt" },
        toolNames: ["read", "media_generate-image"],
      },
      "tg_group_guest@hana": {
        file: "guests/guest.jsonl",
        role: "guest",
        platform: "telegram",
        chatType: "group",
      },
    }, null, 2));

    const activityPath = writeJsonl(path.join(agentDir, "activity", "heartbeat.jsonl"));
    fs.mkdirSync(path.join(agentDir, "desk"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "desk", "activities.json"), JSON.stringify([{
      id: "hb_1",
      type: "heartbeat",
      sessionFile: "heartbeat.jsonl",
    }], null, 2));

    const phonePath = writeJsonl(path.join(agentDir, "phone", "sessions", "dm_yui-a1b2c3d4", "phone.jsonl"));
    fs.mkdirSync(path.join(agentDir, "phone", "session-runtime"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "phone", "session-runtime", "dm_yui-a1b2c3d4.json"), JSON.stringify({
      agentId: "hana",
      conversationId: "dm_yui",
      conversationType: "dm",
      phoneSessionFile: "phone/sessions/dm_yui-a1b2c3d4/phone.jsonl",
      promptSnapshot: { version: 1, systemPrompt: "phone prompt" },
    }, null, 2));

    const directPath = writeJsonl(path.join(agentDir, "subagent-sessions", "direct", "child.jsonl"));
    const workflowPath = writeJsonl(path.join(agentDir, "workflow-sessions", "workflow-1", "node.jsonl"));
    fs.writeFileSync(path.join(hanaHome, "subagent-threads.json"), JSON.stringify({
      schemaVersion: 1,
      threads: {
        "thread-direct": {
          kind: "direct",
          agentId: "butter",
          parentSessionId: "sess_parent_direct",
          childSessionPath: directPath,
          childSessionId: null,
        },
        "workflow-1::node-1": {
          kind: "workflow_node",
          agentId: "hana",
          parentSessionId: "sess_parent_workflow",
          parentTaskId: "workflow-1",
          childSessionPath: workflowPath,
          childSessionId: null,
        },
      },
    }, null, 2));

    const result = migrateLegacySessions({
      hanaHome,
      store,
      migratedAt: "2026-06-18T03:02:00.000Z",
    });

    expect(result).toEqual({ scanned: 6, created: 6, existing: 0, skipped: 0, skippedDetails: [], skippedMetaSources: [] });
    expect(store.resolveByLocatorPath(bridgeOwner)).toMatchObject({
      ownerAgentId: "hana",
      domain: "bridge",
      kind: "bridge_owner",
      provenance: {
        createdBy: "bridge",
        bridgeSessionKey: "tg_dm_owner@hana",
        bridgeRole: "owner",
        platform: "telegram",
      },
    });
    expect(store.resolveByLocatorPath(bridgeGuest)).toMatchObject({
      ownerAgentId: "hana",
      domain: "bridge",
      kind: "bridge_guest",
      provenance: {
        createdBy: "bridge",
        bridgeSessionKey: "tg_group_guest@hana",
        bridgeRole: "guest",
      },
    });
    expect(store.getCapabilitySnapshot(store.resolveByLocatorPath(bridgeOwner).sessionId)).toMatchObject({
      toolNames: ["read", "media_generate-image"],
      promptSnapshot: { systemPrompt: "bridge prompt" },
      source: "legacy_bridge_index",
    });
    expect(store.resolveByLocatorPath(activityPath)).toMatchObject({
      ownerAgentId: "hana",
      domain: "activity",
      kind: "activity",
      provenance: { createdBy: "activity", activityId: "hb_1", activityType: "heartbeat" },
    });
    expect(store.resolveByLocatorPath(phonePath)).toMatchObject({
      ownerAgentId: "hana",
      domain: "phone",
      kind: "phone_conversation",
      provenance: { createdBy: "agent_phone", conversationId: "dm_yui", conversationType: "dm" },
    });
    expect(store.resolveByLocatorPath(directPath)).toMatchObject({
      ownerAgentId: "butter",
      domain: "subagent",
      kind: "subagent_child",
      provenance: {
        createdBy: "subagent",
        parentSessionId: "sess_parent_direct",
        threadId: "thread-direct",
        threadKind: "direct",
      },
    });
    expect(store.resolveByLocatorPath(workflowPath)).toMatchObject({
      ownerAgentId: "hana",
      domain: "subagent",
      kind: "subagent_child",
      provenance: {
        createdBy: "subagent",
        parentSessionId: "sess_parent_workflow",
        parentRunId: "workflow-1",
        threadId: "workflow-1::node-1",
        threadKind: "workflow_node",
      },
    });
  });

  it("preserves sessionId while repairing manifests misclassified by the previous legacy scan", () => {
    const directPath = writeJsonl(path.join(hanaHome, "agents", "hana", "subagent-sessions", "direct", "legacy-child.jsonl"));
    fs.writeFileSync(path.join(hanaHome, "subagent-threads.json"), JSON.stringify({
      schemaVersion: 1,
      threads: {
        "legacy-thread": {
          kind: "direct",
          agentId: "butter",
          childSessionPath: directPath,
        },
      },
    }, null, 2));
    const existing = store.createForPath({
      sessionPath: directPath,
      ownerAgentId: "hana",
      domain: "desktop",
      kind: "chat",
      provenance: { legacyAgentId: "hana" },
      migration: { source: "legacy_scan", legacySessionPath: directPath },
    });

    const first = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });
    const second = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:03:00.000Z" });

    expect(first).toEqual({ scanned: 1, created: 0, existing: 1, skipped: 0, skippedDetails: [], skippedMetaSources: [] });
    expect(second).toEqual({ scanned: 1, created: 0, existing: 1, skipped: 0, skippedDetails: [], skippedMetaSources: [] });
    expect(store.resolveByLocatorPath(directPath)).toMatchObject({
      sessionId: existing.sessionId,
      ownerAgentId: "butter",
      domain: "subagent",
      kind: "subagent_child",
      provenance: { legacyAgentId: "hana", createdBy: "subagent" },
    });
    expect(store.list()).toHaveLength(1);
  });

  it("is idempotent when rerun over the same legacy files", () => {
    const active = writeSession("hana", "active.jsonl");

    const first = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });
    const second = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:03:00.000Z" });

    expect(first).toEqual({ scanned: 1, created: 1, existing: 0, skipped: 0, skippedDetails: [], skippedMetaSources: [] });
    expect(second).toEqual({ scanned: 1, created: 0, existing: 1, skipped: 0, skippedDetails: [], skippedMetaSources: [] });
    expect(store.resolveByLocatorPath(active.sessionPath)?.sessionId).toBe("sess_migrate_0001");
    expect(store.list()).toHaveLength(1);
  });

  it("does not overwrite an existing sessionId title while backfilling legacy title keys", () => {
    const active = writeSession("hana", "active-title.jsonl");
    const existing = store.createForPath({ sessionPath: active.sessionPath, ownerAgentId: "hana" });
    fs.writeFileSync(path.join(active.sessionDir, "session-titles.json"), JSON.stringify({
      [active.sessionPath]: "Legacy title",
      [existing.sessionId]: "Current title",
    }, null, 2));

    const result = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });

    expect(result).toEqual({ scanned: 1, created: 0, existing: 1, skipped: 0, skippedDetails: [], skippedMetaSources: [] });
    const titles = JSON.parse(fs.readFileSync(path.join(active.sessionDir, "session-titles.json"), "utf-8"));
    expect(titles[existing.sessionId]).toBe("Current title");
  });

  it("scans legacy sessions through symlinked agent directories", () => {
    const realAgentDir = path.join(hanaHome, "real-hana-agent");
    const linkedAgentDir = path.join(hanaHome, "agents", "hana");
    fs.mkdirSync(path.join(realAgentDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.dirname(linkedAgentDir), { recursive: true });
    linkDirectory(realAgentDir, linkedAgentDir);
    const logicalSessionPath = path.join(linkedAgentDir, "sessions", "linked.jsonl");
    fs.writeFileSync(path.join(realAgentDir, "sessions", "linked.jsonl"), `${JSON.stringify({
      type: "session",
      id: "linked",
      timestamp: "2026-06-18T03:00:00.000Z",
    })}\n`);

    const result = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });

    expect(result).toEqual({ scanned: 1, created: 1, existing: 0, skipped: 0, skippedDetails: [], skippedMetaSources: [] });
    expect(store.resolveByLocatorPath(logicalSessionPath)).toMatchObject({
      sessionId: "sess_migrate_0001",
      ownerAgentId: "hana",
      currentLocator: {
        path: path.resolve(logicalSessionPath),
      },
    });
  });

  it("skips a conflicted locator without aborting the whole legacy migration", () => {
    const first = writeSession("hana", "first.jsonl");
    const second = writeSession("hana", "second.jsonl");
    const firstManifest = store.createForPath({ sessionPath: first.sessionPath, ownerAgentId: "hana" });
    const secondManifest = store.createForPath({ sessionPath: second.sessionPath, ownerAgentId: "hana" });
    insertConflictingHistoryLocator(first.sessionPath, secondManifest.sessionId);

    const result = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });

    expect(result).toMatchObject({ scanned: 2, created: 0, existing: 1, skipped: 1 });
    expect(result.skippedDetails).toHaveLength(1);
    expect(result.skippedDetails[0]).toMatchObject({ sessionPath: first.sessionPath });
    expect(typeof result.skippedDetails[0].error).toBe("string");
    expect(store.getBySessionId(firstManifest.sessionId)?.sessionId).toBe(firstManifest.sessionId);
    expect(store.getBySessionId(secondManifest.sessionId)?.sessionId).toBe(secondManifest.sessionId);
  });

  it("rescan 回填 ownerAgentId 为空的存量 manifest（老数据读时兼容）", () => {
    const { sessionPath } = writeSession("hana", "missing-owner.jsonl");
    // 模拟历史缺失写入：manifest 已存在但 ownerAgentId 为 null
    store.createForPath({ sessionPath, domain: "desktop", kind: "chat" });

    const result = migrateLegacySessions({ hanaHome, store });

    expect(result.existing).toBe(1);
    expect(store.resolveByLocatorPath(sessionPath)).toMatchObject({
      ownerAgentId: "hana",
    });
  });

  it("rescan 不覆盖已有 ownerAgentId", () => {
    const { sessionPath } = writeSession("hana", "owned-elsewhere.jsonl");
    store.createForPath({ sessionPath, ownerAgentId: "bob", domain: "desktop", kind: "chat" });

    migrateLegacySessions({ hanaHome, store });

    expect(store.resolveByLocatorPath(sessionPath)).toMatchObject({
      ownerAgentId: "bob",
    });
  });

  it("repairs realpath locator paths back to the app-facing legacy path during rescan", () => {
    const realSessionsDir = path.join(hanaHome, "real-sessions");
    const logicalSessionsDir = path.join(hanaHome, "agents", "hana", "sessions");
    fs.mkdirSync(realSessionsDir, { recursive: true });
    fs.mkdirSync(path.dirname(logicalSessionsDir), { recursive: true });
    linkDirectory(realSessionsDir, logicalSessionsDir);
    const realSessionPath = path.join(realSessionsDir, "alpha.jsonl");
    const logicalSessionPath = path.join(logicalSessionsDir, "alpha.jsonl");
    fs.writeFileSync(realSessionPath, `${JSON.stringify({
      type: "session",
      id: "alpha",
      timestamp: "2026-06-18T03:00:00.000Z",
    })}\n`);
    const existing = store.createForPath({ sessionPath: realSessionPath, ownerAgentId: "hana" });

    const result = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });

    expect(result).toEqual({ scanned: 1, created: 0, existing: 1, skipped: 0, skippedDetails: [], skippedMetaSources: [] });
    expect(store.getBySessionId(existing.sessionId)?.currentLocator.path).toBe(path.resolve(logicalSessionPath));
  });

  describe("meta source gate: stat-signature ledger", () => {
    it("跳过超过大小闸门的 session-meta 源文件（当前文件与 oversized 备份），账本记 too_large，会话行仍从 JSONL 发现", () => {
      const active = writeSession("hana", "big.jsonl");
      const currentMetaPath = path.join(active.sessionDir, "session-meta.json");
      const currentPayload = JSON.stringify({
        "big.jsonl": { pinnedAt: "2026-06-18T03:01:00.000Z" },
      });
      fs.writeFileSync(currentMetaPath, currentPayload);
      const backupMetaPath = path.join(active.sessionDir, "session-meta.oversized.1781913830749.json");
      const backupPayload = JSON.stringify({
        "big.jsonl": { toolNames: ["read", "bash"] },
      });
      fs.writeFileSync(backupMetaPath, backupPayload);

      const result = migrateLegacySessions({
        hanaHome,
        store,
        migratedAt: "2026-06-18T03:02:00.000Z",
        // 强制一切超过闸门，验证跳过路径，不需要真的造 64MB 文件
        metaSourceMaxBytes: 4,
      });

      expect(result.scanned).toBe(1);
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.skippedMetaSources).toEqual(
        expect.arrayContaining([
          { path: currentMetaPath, reason: "too_large", size: Buffer.byteLength(currentPayload) },
          { path: backupMetaPath, reason: "too_large", size: Buffer.byteLength(backupPayload) },
        ]),
      );
      expect(result.skippedMetaSources).toHaveLength(2);
      expect(result.skippedDetails).toEqual(
        expect.arrayContaining([
          { type: "meta_source_skipped", sourcePath: currentMetaPath, reason: "too_large" },
          { type: "meta_source_skipped", sourcePath: backupMetaPath, reason: "too_large" },
        ]),
      );

      // 会话行仍能从 JSONL 文件发现并建档，只是丢失了被跳过的 legacy 属性候选。
      const manifest = store.resolveByLocatorPath(active.sessionPath);
      expect(manifest).toMatchObject({ ownerAgentId: "hana", lifecycle: "active" });
      expect(manifest.pinnedAt).toBeNull();
    });

    it("损坏的 session-meta.json 记为 parse_error，第二次迁移不再对其 readFileSync", () => {
      const active = writeSession("hana", "broken-meta.jsonl");
      const metaPath = path.join(active.sessionDir, "session-meta.json");
      const brokenPayload = "{not valid json";
      fs.writeFileSync(metaPath, brokenPayload);

      const first = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });
      expect(first.created).toBe(1);
      expect(first.skippedMetaSources).toEqual([
        { path: metaPath, reason: "parse_error", size: Buffer.byteLength(brokenPayload) },
      ]);

      const readSpy = vi.spyOn(fs, "readFileSync");
      const second = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:03:00.000Z" });
      const metaPathReadCount = readSpy.mock.calls.filter((call) => call[0] === metaPath).length;
      readSpy.mockRestore();

      expect(metaPathReadCount).toBe(0);
      expect(second.existing).toBe(1);
      expect(second.skippedMetaSources).toEqual([]);
    });

    it("UTF-8 BOM 前缀的合法 session-meta.json 被正常消费，不记 parse_error", () => {
      const active = writeSession("hana", "bom-meta.jsonl");
      const metaPath = path.join(active.sessionDir, "session-meta.json");
      const payload = {
        "bom-meta.jsonl": { pinnedAt: "2026-06-18T03:01:00.000Z" },
      };
      fs.writeFileSync(metaPath, `\uFEFF${JSON.stringify(payload)}`);

      const result = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });

      expect(result.created).toBe(1);
      expect(result.skippedMetaSources).toEqual([]);
      expect(store.resolveByLocatorPath(active.sessionPath)).toMatchObject({
        pinnedAt: "2026-06-18T03:01:00.000Z",
      });
      const ledger: any = store.getState(LEGACY_META_SCAN_LEDGER_KEY);
      expect(ledger[metaPath]).toMatchObject({ status: "consumed" });
    });

    it("旧账本把 BOM 文件误记为 parse_error 后，即使 size/mtime 未变也会重验并消费", () => {
      const active = writeSession("hana", "bom-stale-ledger.jsonl");
      const metaPath = path.join(active.sessionDir, "session-meta.json");
      const payload = {
        "bom-stale-ledger.jsonl": { pinnedAt: "2026-06-18T03:01:00.000Z" },
      };
      fs.writeFileSync(metaPath, `\uFEFF${JSON.stringify(payload)}`);
      const stat = fs.statSync(metaPath);

      // 模拟 BOM-unaware 旧运行留下的死刑账本（无 verdictSchema / 旧 schema）
      store.setState(LEGACY_META_SCAN_LEDGER_KEY, {
        [metaPath]: {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          status: "parse_error",
          recordedAt: "2026-06-18T02:00:00.000Z",
        },
      });

      const result = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });

      expect(result.created).toBe(1);
      expect(result.skippedMetaSources).toEqual([]);
      expect(store.resolveByLocatorPath(active.sessionPath)).toMatchObject({
        pinnedAt: "2026-06-18T03:01:00.000Z",
      });
      const ledger: any = store.getState(LEGACY_META_SCAN_LEDGER_KEY);
      expect(ledger[metaPath]).toMatchObject({ status: "consumed" });
      expect(listSkippedMetaSources(store)).toEqual([]);
    });

    it("签名未变的 consumed session-meta.json 第二次迁移仍照常重读（consumed 不做免读优化）", () => {
      // 裁定：账本只对判死刑的文件（too_large / parse_error）做跳过记忆。健康文件（consumed）
      // 体积已被运行时 1MB compact 闸门收窄过，重读是毫秒级开销；免读会让"同目录多行共享一份
      // meta、其中一行因无关原因晚一轮才重试"的场景永久拿不到 legacy 属性（见下面的回归用例）。
      const active = writeSession("hana", "steady.jsonl");
      const metaPath = path.join(active.sessionDir, "session-meta.json");
      fs.writeFileSync(metaPath, JSON.stringify({
        "steady.jsonl": { pinnedAt: "2026-06-18T03:01:00.000Z" },
      }, null, 2));

      const first = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });
      expect(first.skippedMetaSources).toEqual([]);
      expect(store.resolveByLocatorPath(active.sessionPath)).toMatchObject({
        pinnedAt: "2026-06-18T03:01:00.000Z",
      });

      const readSpy = vi.spyOn(fs, "readFileSync");
      const second = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:03:00.000Z" });
      const metaPathReadCount = readSpy.mock.calls.filter((call) => call[0] === metaPath).length;
      readSpy.mockRestore();

      expect(metaPathReadCount).toBeGreaterThan(0);
      expect(second.existing).toBe(1);
      expect(second.skippedMetaSources).toEqual([]);
    });

    it("回归：同目录多行共享一份 session-meta.json，一行因无关原因首轮建档失败，rescan 后仍能拿到 legacy 属性", () => {
      // 复现质量审查报出的 critical bug：A、B 两会话行共享同一份 session-meta.json。
      // 第一轮迁移里 meta 文件本身读取成功（记为 consumed），A 建档成功；B 因为跟 meta
      // 内容毫无关系的瞬时原因（这里用 store.createForPath 抛错模拟）建档失败。
      // 第二轮 rescan 时 meta 文件签名未变——如果 gate 对 consumed 也做跳过，B 就会永久
      // 拿不到 pinnedAt / capability 等 legacy 属性，且没有任何 skippedMetaSources 记录
      // 能提示这件事。修复后 consumed 一律重读，B 第二轮应正确拿到这些属性。
      const a = writeSession("hana", "shared-a.jsonl");
      const b = writeSession("hana", "shared-b.jsonl");
      fs.writeFileSync(path.join(a.sessionDir, "session-meta.json"), JSON.stringify({
        "shared-a.jsonl": { pinnedAt: "2026-06-18T03:01:00.000Z" },
        "shared-b.jsonl": {
          pinnedAt: "2026-06-18T03:01:30.000Z",
          toolNames: ["read", "bash"],
        },
      }, null, 2));

      let bHasFailedOnce = false;
      const realCreateForPath = store.createForPath.bind(store);
      const createForPathSpy = vi.spyOn(store, "createForPath").mockImplementation((input: any) => {
        if (input.sessionPath === b.sessionPath && !bHasFailedOnce) {
          bHasFailedOnce = true;
          throw new Error("simulated transient createForPath failure unrelated to session-meta content");
        }
        return realCreateForPath(input);
      });

      const first = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });
      expect(first.created).toBe(1);
      expect(first.skipped).toBe(1);
      expect(first.skippedDetails).toContainEqual(expect.objectContaining({ sessionPath: b.sessionPath }));
      expect(store.resolveByLocatorPath(a.sessionPath)).toMatchObject({ pinnedAt: "2026-06-18T03:01:00.000Z" });
      expect(store.resolveByLocatorPath(b.sessionPath)).toBeNull();

      const second = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:03:00.000Z" });
      createForPathSpy.mockRestore();

      expect(second.created).toBe(1);
      expect(second.skipped).toBe(0);
      const bManifest = store.resolveByLocatorPath(b.sessionPath);
      expect(bManifest).toMatchObject({ pinnedAt: "2026-06-18T03:01:30.000Z" });
      expect(store.getCapabilitySnapshot(bManifest.sessionId)).toMatchObject({
        toolNames: ["read", "bash"],
      });
    });

    it("stat 失败（文件被删除）时清掉账本里对应路径的旧记录", () => {
      const active = writeSession("hana", "vanishing.jsonl");
      const metaPath = path.join(active.sessionDir, "session-meta.json");
      fs.writeFileSync(metaPath, JSON.stringify({
        "vanishing.jsonl": { pinnedAt: "2026-06-18T03:01:00.000Z" },
      }, null, 2));

      migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });
      const ledgerAfterFirst: any = store.getState(LEGACY_META_SCAN_LEDGER_KEY);
      expect(ledgerAfterFirst[metaPath]).toMatchObject({ status: "consumed" });

      fs.unlinkSync(metaPath);
      migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:03:00.000Z" });

      const ledgerAfterSecond: any = store.getState(LEGACY_META_SCAN_LEDGER_KEY);
      expect(ledgerAfterSecond[metaPath]).toBeUndefined();
    });

    it("session-meta.json 签名变化（内容与 mtime 都变化）后按新内容重新生效", () => {
      const active = writeSession("hana", "capability-refresh.jsonl");
      const metaPath = path.join(active.sessionDir, "session-meta.json");
      fs.writeFileSync(metaPath, JSON.stringify({
        "capability-refresh.jsonl": { toolNames: ["read"] },
      }, null, 2));

      const first = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });
      expect(first.skippedMetaSources).toEqual([]);
      const manifest = store.resolveByLocatorPath(active.sessionPath);
      expect(store.getCapabilitySnapshot(manifest.sessionId)).toMatchObject({ toolNames: ["read"] });

      fs.writeFileSync(metaPath, JSON.stringify({
        "capability-refresh.jsonl": { toolNames: ["read", "bash", "media_generate-image"] },
      }, null, 2));
      const futureMtime = new Date(Date.now() + 5000);
      fs.utimesSync(metaPath, futureMtime, futureMtime);

      const second = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:03:00.000Z" });

      expect(second.skippedMetaSources).toEqual([]);
      expect(store.getCapabilitySnapshot(manifest.sessionId)).toMatchObject({
        toolNames: ["read", "bash", "media_generate-image"],
      });
    });

    it("账本状态损坏（getState 返回非对象垃圾）时按空账本重建，不 throw", () => {
      const active = writeSession("hana", "ledger-corrupt.jsonl");
      fs.writeFileSync(path.join(active.sessionDir, "session-meta.json"), JSON.stringify({
        "ledger-corrupt.jsonl": { pinnedAt: "2026-06-18T03:01:00.000Z" },
      }, null, 2));

      store.setState(LEGACY_META_SCAN_LEDGER_KEY, "garbage");

      let result;
      expect(() => {
        result = migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });
      }).not.toThrow();

      expect(result.created).toBe(1);
      expect(result.skippedMetaSources).toEqual([]);
      expect(store.resolveByLocatorPath(active.sessionPath)).toMatchObject({
        pinnedAt: "2026-06-18T03:01:00.000Z",
      });
    });

    it("listSkippedMetaSources 汇总账本中全部 too_large/parse_error 条目；store 无 getState 或账本损坏时返回空数组", () => {
      const oversized = writeSession("agent-a", "oversized.jsonl");
      const oversizedMetaPath = path.join(oversized.sessionDir, "session-meta.json");
      const oversizedPayload = JSON.stringify({
        "oversized.jsonl": { pinnedAt: "2026-06-18T03:01:00.000Z" },
      });
      fs.writeFileSync(oversizedMetaPath, oversizedPayload);

      migrateLegacySessions({
        hanaHome,
        store,
        migratedAt: "2026-06-18T03:02:00.000Z",
        metaSourceMaxBytes: 4,
      });

      const broken = writeSession("agent-b", "broken.jsonl");
      const brokenMetaPath = path.join(broken.sessionDir, "session-meta.json");
      const brokenPayload = "{not valid json";
      fs.writeFileSync(brokenMetaPath, brokenPayload);

      migrateLegacySessions({ hanaHome, store, migratedAt: "2026-06-18T03:03:00.000Z" });

      const entries = listSkippedMetaSources(store);
      expect(entries).toEqual(expect.arrayContaining([
        {
          path: oversizedMetaPath,
          reason: "too_large",
          size: Buffer.byteLength(oversizedPayload),
          recordedAt: expect.any(String),
        },
        {
          path: brokenMetaPath,
          reason: "parse_error",
          size: Buffer.byteLength(brokenPayload),
          recordedAt: expect.any(String),
        },
      ]));
      expect(entries).toHaveLength(2);

      expect(listSkippedMetaSources(null)).toEqual([]);
      expect(listSkippedMetaSources({})).toEqual([]);
      expect(listSkippedMetaSources({ getState: () => "garbage" })).toEqual([]);
      expect(listSkippedMetaSources({
        getState: () => {
          throw new Error("boom");
        },
      })).toEqual([]);
    });
  });
});
