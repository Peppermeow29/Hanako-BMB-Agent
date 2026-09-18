import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_MANIFEST_DB_USER_VERSION,
  SessionManifestStore,
} from "../core/session-manifest/store.ts";

describe("SessionManifestStore branch heads", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SessionManifestStore | null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-branch-head-"));
    dbPath = path.join(tmpDir, "session-manifest.db");
    store = new SessionManifestStore({
      dbPath,
      idGenerator: () => "sess_branch_0001",
      now: () => "2026-07-16T08:00:00.000Z",
    });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("distinguishes a legacy missing row from an explicit root head", () => {
    const sessionPath = path.join(tmpDir, "alpha.jsonl");
    fs.writeFileSync(sessionPath, "");
    const manifest = store!.createForPath({ sessionPath, ownerAgentId: "hana" });

    expect(store!.getBranchHead(manifest.sessionId)).toBeNull();

    const root = store!.setBranchHead(manifest.sessionId, {
      leafId: null,
      observedTailLeafId: "old-tail",
      reason: "replay_reset_root",
    });

    expect(root).toMatchObject({
      sessionId: manifest.sessionId,
      leafId: null,
      observedTailLeafId: "old-tail",
      revision: 1,
      reason: "replay_reset_root",
    });
    expect(store!.getBranchHead(manifest.sessionId)).toEqual(root);
  });

  it("updates one session-keyed head atomically and increments its revision", () => {
    const sessionPath = path.join(tmpDir, "alpha.jsonl");
    fs.writeFileSync(sessionPath, "");
    const manifest = store!.createForPath({ sessionPath, ownerAgentId: "hana" });

    store!.setBranchHead(manifest.sessionId, {
      leafId: "a",
      observedTailLeafId: "tail-a",
      reason: "restore",
    });
    const next = store!.setBranchHead(manifest.sessionId, {
      leafId: "b",
      observedTailLeafId: "tail-b",
      reason: "append",
    });

    expect(next).toMatchObject({
      sessionId: manifest.sessionId,
      leafId: "b",
      observedTailLeafId: "tail-b",
      revision: 2,
      reason: "append",
    });
  });

  it("migrates a v3 database without losing manifests", () => {
    const sessionPath = path.join(tmpDir, "legacy.jsonl");
    fs.writeFileSync(sessionPath, "");
    const manifest = store!.createForPath({ sessionPath, ownerAgentId: "hana" });
    store!.close();
    store = null;

    const legacy = new Database(dbPath);
    legacy.exec("DROP TABLE IF EXISTS session_branch_heads");
    legacy.pragma("user_version = 3");
    legacy.close();

    store = new SessionManifestStore({ dbPath });

    expect(store.db.pragma("user_version", { simple: true })).toBe(SESSION_MANIFEST_DB_USER_VERSION);
    expect(SESSION_MANIFEST_DB_USER_VERSION).toBe(5);
    expect(store.getBySessionId(manifest.sessionId)).toMatchObject({
      sessionId: manifest.sessionId,
      ownerAgentId: "hana",
    });
    expect(store.getBranchHead(manifest.sessionId)).toBeNull();
  });
});
