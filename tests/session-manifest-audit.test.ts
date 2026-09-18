import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLegacySessionManifests } from "../core/session-manifest/legacy-migration.ts";
import { SessionManifestStore } from "../core/session-manifest/store.ts";

describe("session manifest audit", () => {
  let hanaHome: string;
  let store: SessionManifestStore;

  beforeEach(() => {
    hanaHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-manifest-audit-"));
    store = new SessionManifestStore({ dbPath: path.join(hanaHome, "session-manifest.db") });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(hanaHome, { recursive: true, force: true });
  });

  function writeJsonl(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ type: "session", id: path.basename(filePath) })}\n`);
    return filePath;
  }

  it("reports discovered, manifested, missing, missing locators, and classification mismatches without writing", () => {
    const desktopPath = writeJsonl(path.join(hanaHome, "agents", "hana", "sessions", "desktop.jsonl"));
    const bridgeDir = path.join(hanaHome, "agents", "hana", "sessions", "bridge");
    const bridgePath = writeJsonl(path.join(bridgeDir, "owner", "bridge.jsonl"));
    fs.writeFileSync(path.join(bridgeDir, "bridge-sessions.json"), JSON.stringify({
      "tg_dm_owner@hana": { file: "owner/bridge.jsonl", role: "owner" },
    }));
    const activityPath = writeJsonl(path.join(hanaHome, "agents", "hana", "activity", "activity.jsonl"));
    const missingLocatorPath = writeJsonl(path.join(hanaHome, "agents", "hana", "sessions", "gone.jsonl"));
    const deletedLocatorPath = writeJsonl(path.join(hanaHome, "agents", "hana", "sessions", "deleted.jsonl"));

    store.createForPath({ sessionPath: desktopPath, ownerAgentId: "hana", domain: "desktop", kind: "chat" });
    store.createForPath({
      sessionPath: bridgePath,
      ownerAgentId: "butter",
      domain: "desktop",
      kind: "chat",
      lifecycle: "archived",
    });
    store.createForPath({ sessionPath: missingLocatorPath, ownerAgentId: "hana", domain: "desktop", kind: "chat" });
    const deleted = store.createForPath({ sessionPath: deletedLocatorPath, ownerAgentId: "hana", domain: "desktop", kind: "chat" });
    store.updateLocatorLifecycle(deleted.sessionId, deletedLocatorPath, "deleted", "test_tombstone");
    fs.unlinkSync(missingLocatorPath);
    fs.unlinkSync(deletedLocatorPath);
    const before = store.list();

    const report = auditLegacySessionManifests({ hanaHome, store });

    expect(report).toMatchObject({
      discovered: 3,
      manifested: 2,
      missing: 1,
      missingLocator: 1,
      domainMismatch: 1,
      ownerMismatch: 1,
      lifecycleMismatch: 1,
    });
    expect(report.details.missing).toEqual([
      expect.objectContaining({ sessionPath: path.resolve(activityPath), expectedDomain: "activity" }),
    ]);
    expect(report.details.missingLocators).toEqual([
      expect.objectContaining({ sessionPath: path.resolve(missingLocatorPath) }),
    ]);
    expect(report.details.domainMismatches).toEqual([
      expect.objectContaining({
        sessionPath: path.resolve(bridgePath),
        actualDomain: "desktop",
        expectedDomain: "bridge",
        expectedKind: "bridge_owner",
      }),
    ]);
    expect(report.details.ownerMismatches).toEqual([
      expect.objectContaining({
        sessionPath: path.resolve(bridgePath),
        actualOwnerAgentId: "butter",
        expectedOwnerAgentId: "hana",
      }),
    ]);
    expect(report.details.lifecycleMismatches).toEqual([
      expect.objectContaining({
        sessionPath: path.resolve(bridgePath),
        actualLifecycle: "archived",
        expectedLifecycle: "active",
      }),
    ]);
    expect(store.list()).toEqual(before);
  });

  it("counts a missing locator once when both the manifest and a legacy index reference it", () => {
    const bridgeDir = path.join(hanaHome, "agents", "hana", "sessions", "bridge");
    const bridgePath = writeJsonl(path.join(bridgeDir, "owner", "gone.jsonl"));
    fs.writeFileSync(path.join(bridgeDir, "bridge-sessions.json"), JSON.stringify({
      "tg_dm_owner@hana": { file: "owner/gone.jsonl", role: "owner" },
    }));
    const manifest = store.createForPath({
      sessionPath: bridgePath,
      ownerAgentId: "hana",
      domain: "bridge",
      kind: "bridge_owner",
    });
    fs.unlinkSync(bridgePath);

    const report = auditLegacySessionManifests({ hanaHome, store });

    expect(report.missingLocator).toBe(1);
    expect(report.details.missingLocators).toEqual([
      expect.objectContaining({
        sessionId: manifest.sessionId,
        sessionPath: path.resolve(bridgePath),
        source: "manifest_current_locator",
      }),
    ]);
    expect(report.details.discoveryWarnings).toEqual([
      expect.objectContaining({
        type: "missing_source_locator",
        sessionPath: path.resolve(bridgePath),
        source: "legacy_bridge_index",
      }),
    ]);
  });

  it("ignores temporary workflow sessions referenced by closed legacy thread records", () => {
    const existingEphemeralPath = writeJsonl(path.join(
      hanaHome,
      "agents",
      "hana",
      ".ephemeral",
      "existing.jsonl",
    ));
    const missingEphemeralPath = path.join(
      hanaHome,
      "agents",
      "hana",
      ".ephemeral",
      "gone.jsonl",
    );
    fs.writeFileSync(path.join(hanaHome, "subagent-threads.json"), JSON.stringify({
      schemaVersion: 1,
      threads: {
        "workflow-1::node-1": {
          kind: "workflow_node",
          status: "closed",
          childSessionPath: existingEphemeralPath,
        },
        "workflow-1::node-2": {
          kind: "workflow_node",
          status: "closed",
          childSessionPath: missingEphemeralPath,
        },
      },
    }));

    const report = auditLegacySessionManifests({ hanaHome, store });

    expect(report).toMatchObject({
      discovered: 0,
      manifested: 0,
      missing: 0,
      missingLocator: 0,
      domainMismatch: 0,
      ownerMismatch: 0,
      lifecycleMismatch: 0,
      details: { discoveryWarnings: [] },
    });
  });

  it("CLI fail gate includes owner and lifecycle mismatches", () => {
    const sessionPath = writeJsonl(path.join(hanaHome, "agents", "hana", "sessions", "identity.jsonl"));
    store.createForPath({
      sessionPath,
      ownerAgentId: "butter",
      domain: "desktop",
      kind: "chat",
      lifecycle: "archived",
    });
    store.close();
    store = null as any;

    const result = spawnSync(process.execPath, [
      "scripts/session-manifest-audit.mjs",
      "--hana-home",
      hanaHome,
      "--json",
      "--fail-on-anomaly",
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      discovered: 1,
      manifested: 1,
      missing: 0,
      missingLocator: 0,
      domainMismatch: 0,
      ownerMismatch: 1,
      lifecycleMismatch: 1,
    });

    const humanResult = spawnSync(process.execPath, [
      "scripts/session-manifest-audit.mjs",
      "--hana-home",
      hanaHome,
      "--fail-on-anomaly",
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(humanResult.status).toBe(1);
    expect(humanResult.stdout).toContain("owner mismatch: 1");
    expect(humanResult.stdout).toContain("lifecycle mismatch: 1");
    expect(humanResult.stdout).toContain("Owner mismatches:");
    expect(humanResult.stdout).toContain("Lifecycle mismatches:");
  });

  it("CLI opens the manifest database read-only and supports an anomaly exit gate", () => {
    writeJsonl(path.join(hanaHome, "agents", "hana", "activity", "missing.jsonl"));
    store.close();
    store = null as any;
    const dbPath = path.join(hanaHome, "session-manifest.db");
    const beforeStat = fs.statSync(dbPath);

    const result = spawnSync(process.execPath, [
      "scripts/session-manifest-audit.mjs",
      "--hana-home",
      hanaHome,
      "--json",
      "--fail-on-anomaly",
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ discovered: 1, manifested: 0, missing: 1 });
    const afterStat = fs.statSync(dbPath);
    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });
});
