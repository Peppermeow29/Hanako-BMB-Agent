import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { healCredentialFileModes } from "../core/credential-file-healer.ts";
import { LOCAL_PROVIDER_PLUGINS_DIR } from "../core/local-provider-plugin-store.ts";
import { PLUGIN_CONFIG_FILENAME, PLUGIN_DATA_DIRNAME } from "../core/plugin-config.ts";
import { SECURITY_DIR } from "../core/security-dir.ts";
import { SECRET_TMP_SUFFIX } from "../shared/secret-fs.ts";

const POSIX = process.platform !== "win32";

let home: string | null = null;

function makeHome() {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-credential-healer-"));
  return home;
}

function writeOpen(relativePath: string, content = "{}\n") {
  const target = path.join(home!, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  fs.chmodSync(target, 0o644);
  return target;
}

function modeOf(target: string) {
  return fs.statSync(target).mode & 0o777;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = null;
});

describe.skipIf(!POSIX)("healCredentialFileModes", () => {
  it("tightens the data directory itself", () => {
    const root = makeHome();
    fs.chmodSync(root, 0o755);

    const result = healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(root)).toBe(0o700);
    expect(result.healed).toContain(".");
  });

  it("tightens every known credential file at the top level", () => {
    const root = makeHome();
    const targets = [
      "provider-catalog.json",
      "models.json",
      "added-models.yaml",
      "auth.json",
      "device-credentials.json",
      "devices.json",
      "pairing-sessions.json",
      "local-user-auth.json",
      "users.json",
      "web-sessions.json",
    ];
    for (const name of targets) writeOpen(name);

    const result = healCredentialFileModes({ hanakoHome: root });

    for (const name of targets) {
      expect(modeOf(path.join(root, name))).toBe(0o600);
      expect(result.healed).toContain(name);
    }
  });

  it("tightens per-agent configuration files", () => {
    const root = makeHome();
    writeOpen(path.join("agents", "hanako", "config.yaml"), "api:\n  api_key: value\n");
    writeOpen(path.join("agents", "second", "config.yaml"), "api:\n  api_key: value\n");

    healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(path.join(root, "agents", "hanako", "config.yaml"))).toBe(0o600);
    expect(modeOf(path.join(root, "agents", "second", "config.yaml"))).toBe(0o600);
  });

  // The scope migration writes this backup once and never rewrites it, so a
  // file left behind by an older version would otherwise keep its mode forever.
  it("tightens the scope-migration backups kept beside agent configuration files", () => {
    const root = makeHome();
    const live = path.join("agents", "hanako", "config.yaml.pre-scope-migration");
    const inCheckpoint = path.join(
      "checkpoints", "session-manifest", "cp-1", "agents", "hanako", "config.yaml.pre-scope-migration",
    );
    writeOpen(live, "api:\n  api_key: value\n");
    writeOpen(inCheckpoint, "api:\n  api_key: value\n");

    const result = healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(path.join(root, live))).toBe(0o600);
    expect(modeOf(path.join(root, inCheckpoint))).toBe(0o600);
    expect(result.healed).toContain(live);
  });

  // Older versions rewrote agent configuration through a temporary copy written
  // with default permissions. A crash before the rename leaves that copy behind
  // with the full configuration in it, and nothing ever rewrites it, so the
  // credentials would stay readable forever.
  it("tightens a leftover temporary copy of an agent configuration", () => {
    const root = makeHome();
    const live = path.join("agents", "hanako", `config.yaml${SECRET_TMP_SUFFIX}`);
    const inCheckpoint = path.join(
      "checkpoints", "session-manifest", "cp-1", "agents", "hanako", `config.yaml${SECRET_TMP_SUFFIX}`,
    );
    writeOpen(live, "api:\n  api_key: value\n");
    writeOpen(inCheckpoint, "api:\n  api_key: value\n");

    const result = healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(path.join(root, live))).toBe(0o600);
    expect(modeOf(path.join(root, inCheckpoint))).toBe(0o600);
    expect(result.healed).toContain(live);
    expect(result.healed).toContain(inCheckpoint);
  });

  it("tightens migration backup directories and everything inside them", () => {
    const root = makeHome();
    const backupDir = path.join(root, "migration-backups", "provider-catalog-v1-2026-01-01");
    writeOpen(path.join("migration-backups", "provider-catalog-v1-2026-01-01", "added-models.yaml"));
    writeOpen(path.join("migration-backups", "provider-catalog-v1-2026-01-01", "models.json"));
    fs.chmodSync(backupDir, 0o755);
    fs.chmodSync(path.join(root, "migration-backups"), 0o755);

    healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(path.join(root, "migration-backups"))).toBe(0o700);
    expect(modeOf(backupDir)).toBe(0o700);
    expect(modeOf(path.join(backupDir, "added-models.yaml"))).toBe(0o600);
    expect(modeOf(path.join(backupDir, "models.json"))).toBe(0o600);
  });

  // The tree is located through LOCAL_PROVIDER_PLUGINS_DIR rather than a
  // literal, because the healer reads a directory name that the store owns.
  // A guard that only asserts a string is in SECRET_TREES passes even when the
  // two names have drifted apart and the healer walks a path that never exists.
  it("tightens locally defined provider plugins, whose files carry that provider's key", () => {
    const root = makeHome();
    const pluginRoot = path.join(root, LOCAL_PROVIDER_PLUGINS_DIR);
    const providerDir = path.join(pluginRoot, "acme");
    const keyFile = path.join(LOCAL_PROVIDER_PLUGINS_DIR, "acme", "providers", "acme.json");
    writeOpen(keyFile, JSON.stringify({ api_key: "value" }));
    fs.chmodSync(providerDir, 0o755);
    fs.chmodSync(pluginRoot, 0o755);

    const result = healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(pluginRoot)).toBe(0o700);
    expect(modeOf(providerDir)).toBe(0o700);
    expect(modeOf(path.join(root, keyFile))).toBe(0o600);
    expect(result.healed).toContain(keyFile);
  });

  // The signing keys here are written owner-only, but a restored backup or a
  // copied data directory reintroduces the permissions the copy was made with,
  // and nothing rewrites a key file afterwards. Located through the constant the
  // services use, so a rename cannot leave this walking a path that never exists.
  it("tightens the security directory that holds signing keys and grant records", () => {
    const root = makeHome();
    const securityRoot = path.join(root, SECURITY_DIR);
    const keyFile = path.join(SECURITY_DIR, "resource-ticket-key");
    const grantsFile = path.join(SECURITY_DIR, "grants.json");
    writeOpen(keyFile, "key-material\n");
    writeOpen(grantsFile, "{}\n");
    fs.chmodSync(securityRoot, 0o755);

    const result = healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(securityRoot)).toBe(0o700);
    expect(modeOf(path.join(root, keyFile))).toBe(0o600);
    expect(modeOf(path.join(root, grantsFile))).toBe(0o600);
    expect(result.healed).toContain(keyFile);
    expect(result.healed).toContain(grantsFile);
  });

  // Only the configuration file is corrected. The rest of a plugin's data
  // directory belongs to other stores and may legitimately carry other modes,
  // so the negative assertion below is as much the contract as the positive
  // ones: this pass must not flatten a neighbour it does not own.
  it("tightens plugin configuration files without touching the rest of a plugin's data", () => {
    const root = makeHome();
    const mcpConfig = path.join(PLUGIN_DATA_DIRNAME, "mcp", PLUGIN_CONFIG_FILENAME);
    const imageConfig = path.join(PLUGIN_DATA_DIRNAME, "image-gen", PLUGIN_CONFIG_FILENAME);
    const neighbour = path.join(PLUGIN_DATA_DIRNAME, "image-gen", "helper.bin");
    writeOpen(mcpConfig);
    writeOpen(imageConfig);
    writeOpen(neighbour);
    fs.chmodSync(path.join(root, neighbour), 0o755);

    const result = healCredentialFileModes({ hanakoHome: root });

    expect(modeOf(path.join(root, mcpConfig))).toBe(0o600);
    expect(modeOf(path.join(root, imageConfig))).toBe(0o600);
    expect(result.healed).toContain(mcpConfig);
    expect(modeOf(path.join(root, neighbour))).toBe(0o755);
  });

  it("tightens agent configuration captured inside migration checkpoints", () => {
    const root = makeHome();
    writeOpen(
      path.join("checkpoints", "session-manifest", "cp-1", "agents", "hanako", "config.yaml"),
      "api:\n  api_key: value\n",
    );

    healCredentialFileModes({ hanakoHome: root });

    expect(
      modeOf(path.join(root, "checkpoints", "session-manifest", "cp-1", "agents", "hanako", "config.yaml")),
    ).toBe(0o600);
  });

  it("reports each correction so the run leaves a trace", () => {
    const root = makeHome();
    writeOpen("provider-catalog.json");
    const lines: string[] = [];

    const result = healCredentialFileModes({ hanakoHome: root, log: (line: string) => lines.push(line) });

    expect(result.healed).toContain("provider-catalog.json");
    expect(lines.join("\n")).toContain("provider-catalog.json");
  });

  it("stays quiet when everything is already owner-only", () => {
    const root = makeHome();
    fs.chmodSync(root, 0o700);
    const target = path.join(root, "provider-catalog.json");
    fs.writeFileSync(target, "{}\n");
    fs.chmodSync(target, 0o600);
    const lines: string[] = [];

    const result = healCredentialFileModes({ hanakoHome: root, log: (line: string) => lines.push(line) });

    expect(result.healed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("refuses a missing data directory instead of reporting a clean run", () => {
    expect(() => healCredentialFileModes({ hanakoHome: "" })).toThrowError(/data directory/);
  });

  it("skips files that are absent instead of failing", () => {
    const root = makeHome();
    fs.chmodSync(root, 0o700);

    const result = healCredentialFileModes({ hanakoHome: root });

    expect(result.failed).toEqual([]);
  });

  it("reports a file it could not correct and still handles the rest", () => {
    const root = makeHome();
    fs.chmodSync(root, 0o700);
    writeOpen("provider-catalog.json");
    writeOpen("models.json");
    const realChmod = fs.chmodSync;
    vi.spyOn(fs, "chmodSync").mockImplementation((target: any, mode: any) => {
      if (String(target).endsWith("provider-catalog.json")) {
        const err: any = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return realChmod(target, mode);
    });
    const lines: string[] = [];

    const result = healCredentialFileModes({ hanakoHome: root, log: (line: string) => lines.push(line) });

    expect(result.failed).toContain("provider-catalog.json");
    expect(result.healed).toContain("models.json");
    expect(modeOf(path.join(root, "models.json"))).toBe(0o600);
    expect(lines.join("\n")).toContain("provider-catalog.json");
  });
});
