/**
 * Guard: credential files must be written through the owner-only primitive, and
 * every credential path a store owns must also be covered by the startup healer.
 *
 * Without this, a new call site added later would silently fall back to the
 * generic writer, and a newly registered credential path would never be healed
 * on machines that already have the file.
 *
 * What this guard does and does not cover, stated plainly so nobody reads more
 * into a green run than it earns: it pins the write shape of the files listed
 * below, and it pins the healer's coverage of the paths those stores own. It
 * does not decide which files belong on those lists. A credential written from
 * a file nobody added here passes this guard; what catches that one is the
 * persistence census, which forces every production write to be claimed by a
 * store descriptor.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { discoverSites } from "../scripts/scan-persistent-stores.mjs";
import { SECRET_TREES, TOP_LEVEL_SECRET_FILES } from "../core/credential-file-healer.ts";
import { LOCAL_PROVIDER_PLUGINS_DIR } from "../core/local-provider-plugin-store.ts";
import { SECURITY_DIR } from "../core/security-dir.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Source files whose file writes are credential writes without exception.
 * Every write in these files must use the owner-only primitive.
 */
const EXCLUSIVE_CREDENTIAL_WRITERS = [
  "core/provider-catalog.ts",
  "core/model-sync.ts",
  "core/provider-media-config.ts",
  "core/local-provider-plugin-store.ts",
  "core/device-registry.ts",
  "core/local-user-account.ts",
  "core/web-session-store.ts",
  "core/migrate-providers.ts",
  "core/plugin-config.ts",
  "lib/memory/config-loader.ts",
  "shared/migrate-config-scope.ts",
];

/**
 * Files that write credentials alongside unrelated state, so they are only
 * required to carry at least one owner-only write.
 */
const MIXED_CREDENTIAL_WRITERS = [
  "core/provider-registry.ts",
  "core/migrations.ts",
  "core/first-run.ts",
];

/**
 * Kinds that would put credential bytes on disk without the owner-only
 * primitive. "copy-file" is deliberately absent: migration backups copy the
 * source byte-for-byte and tighten the copy immediately afterwards, inside a
 * directory that is already owner-only.
 */
const PLAIN_WRITE_KINDS = new Set(["atomic-write", "write-file", "append-file"]);

function sitesByFile() {
  const grouped = new Map<string, Array<{ kind: string; line: number; excerpt: string }>>();
  for (const site of discoverSites(ROOT)) {
    const list = grouped.get(site.sourceFile) || [];
    list.push({ kind: site.kind, line: site.line, excerpt: site.excerpt });
    grouped.set(site.sourceFile, list);
  }
  return grouped;
}

describe("credential write custody", () => {
  const grouped = sitesByFile();

  it.each(EXCLUSIVE_CREDENTIAL_WRITERS)("%s writes credentials owner-only everywhere", (sourceFile) => {
    const sites = grouped.get(sourceFile) || [];
    const plainWrites = sites.filter((site) => PLAIN_WRITE_KINDS.has(site.kind));
    const secretWrites = sites.filter((site) => site.kind === "secret-write");

    expect(secretWrites.length).toBeGreaterThan(0);
    expect(
      plainWrites.map((site) => `${sourceFile}:${site.line} ${site.kind} ${site.excerpt}`),
    ).toEqual([]);
  });

  it.each(MIXED_CREDENTIAL_WRITERS)("%s keeps its credential writes owner-only", (sourceFile) => {
    const sites = grouped.get(sourceFile) || [];
    expect(sites.filter((site) => site.kind === "secret-write").length).toBeGreaterThan(0);
  });
});

describe("startup healer coverage", () => {
  // Asserted against the store's own constant, not a literal: a literal here
  // passes even when the healer and the store disagree on the directory name,
  // which is exactly how this tree went uncovered.
  it("covers the local provider plugin tree that holds per-provider keys", () => {
    expect(SECRET_TREES).toContain(LOCAL_PROVIDER_PLUGINS_DIR);
  });

  it("covers the migration backups that copy credentials aside", () => {
    expect(SECRET_TREES).toContain("migration-backups");
  });

  // Same reasoning as above: taken from the module the key services import, not
  // spelled again here.
  it("covers the security tree that holds signing keys and grant records", () => {
    expect(SECRET_TREES).toContain(SECURITY_DIR);
  });

  it.each([
    "provider-catalog.json",
    "added-models.yaml",
    "models.json",
    "auth.json",
    "device-credentials.json",
    "local-user-auth.json",
    "web-sessions.json",
  ])("heals %s", (fileName) => {
    expect(TOP_LEVEL_SECRET_FILES).toContain(fileName);
  });
});
