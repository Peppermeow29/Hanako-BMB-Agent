import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  CREDENTIAL_BACKUP_MAX_AGE_MS,
  pruneStaleCredentialBackups,
} from "../core/credential-backup-retention.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-02T00:00:00.000Z");

let home: string | null = null;

function makeHome() {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-backup-retention-"));
  return home;
}

function writeHealthyCatalog(providers: Record<string, unknown> = { openai: { api_key: "value" } }) {
  fs.writeFileSync(
    path.join(home!, "provider-catalog.json"),
    JSON.stringify({ version: 2, providers, meta: {} }, null, 2),
  );
}

function makeBackup(name: string, ageDays: number) {
  const dir = path.join(home!, "migration-backups", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "added-models.yaml"), "providers: {}\n");
  const stamp = new Date(NOW - ageDays * DAY_MS);
  fs.utimesSync(dir, stamp, stamp);
  return dir;
}

afterEach(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = null;
});

describe("pruneStaleCredentialBackups", () => {
  it("removes a backup once it is older than the retention window and the live catalog is healthy", () => {
    makeHome();
    writeHealthyCatalog();
    const stale = makeBackup("provider-catalog-v1-old", 91);
    const lines: string[] = [];

    const result = pruneStaleCredentialBackups({ hanakoHome: home!, now: NOW, log: (l: string) => lines.push(l) });

    expect(fs.existsSync(stale)).toBe(false);
    expect(result.removed).toEqual(["provider-catalog-v1-old"]);
    expect(lines.join("\n")).toContain("provider-catalog-v1-old");
  });

  it("keeps a backup that is still inside the retention window", () => {
    makeHome();
    writeHealthyCatalog();
    const fresh = makeBackup("provider-catalog-v1-recent", 89);

    const result = pruneStaleCredentialBackups({ hanakoHome: home!, now: NOW });

    expect(fs.existsSync(fresh)).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.kept[0]).toMatchObject({ name: "provider-catalog-v1-recent", reason: "within-retention-window" });
  });

  it("keeps every backup when the live catalog is missing", () => {
    makeHome();
    const stale = makeBackup("provider-catalog-v1-old", 400);

    const result = pruneStaleCredentialBackups({ hanakoHome: home!, now: NOW });

    expect(fs.existsSync(stale)).toBe(true);
    expect(result.kept[0]).toMatchObject({ reason: "live-catalog-unusable" });
  });

  it("keeps every backup when the live catalog cannot be parsed", () => {
    makeHome();
    fs.writeFileSync(path.join(home!, "provider-catalog.json"), "{ not json");
    const stale = makeBackup("provider-catalog-v1-old", 400);

    const result = pruneStaleCredentialBackups({ hanakoHome: home!, now: NOW });

    expect(fs.existsSync(stale)).toBe(true);
    expect(result.kept[0]).toMatchObject({ reason: "live-catalog-unusable" });
  });

  it("keeps every backup when the live catalog carries no providers", () => {
    makeHome();
    writeHealthyCatalog({});
    const stale = makeBackup("provider-catalog-v1-old", 400);

    const result = pruneStaleCredentialBackups({ hanakoHome: home!, now: NOW });

    expect(fs.existsSync(stale)).toBe(true);
    expect(result.kept[0]).toMatchObject({ reason: "live-catalog-unusable" });
  });

  it("never reads the catalog through a loader that could rebuild it", () => {
    // A missing catalog must stay missing: pruning is not allowed to trigger
    // the legacy migration path as a side effect of its health check.
    makeHome();
    makeBackup("provider-catalog-v1-old", 400);

    pruneStaleCredentialBackups({ hanakoHome: home!, now: NOW });

    expect(fs.existsSync(path.join(home!, "provider-catalog.json"))).toBe(false);
  });

  it("refuses a missing data directory instead of reporting a clean run", () => {
    expect(() => pruneStaleCredentialBackups({ hanakoHome: "", now: NOW })).toThrowError(/data directory/);
  });

  it("does nothing when there are no backups at all", () => {
    makeHome();
    writeHealthyCatalog();

    const result = pruneStaleCredentialBackups({ hanakoHome: home!, now: NOW });

    expect(result).toEqual({ removed: [], kept: [] });
  });

  it("retains for ninety days", () => {
    expect(CREDENTIAL_BACKUP_MAX_AGE_MS).toBe(90 * DAY_MS);
  });
});
