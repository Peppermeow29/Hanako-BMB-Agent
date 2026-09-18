import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXPORT_DIR_NAME,
  EXPORT_SKELETON,
  exportOpenTree,
  planExportCopies,
} from "../scripts/export-open-tree.mjs";
import { runRehearsalStep } from "../scripts/rehearse-open-export.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPORT_SCRIPT = path.join(REPOSITORY_ROOT, "scripts", "export-open-tree.mjs");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function write(root: string, relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/**
 * Builds a fixture repo with a real git history, so directory-entry
 * expansion (git ls-files-based) behaves exactly like it does against the
 * real repository.
 */
function makeFixtureRepo(): string {
  const dir = tempDir("hana-export-fixture-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "fixture@test.local");
  git(dir, "config", "user.name", "fixture");
  git(dir, "config", "commit.gpgsign", "false");

  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, "pkg/index.ts", "export const b = 2;\n");
  write(dir, "tmpl/one.md", "hello\n");
  write(dir, ".gitignore", "pkg/dist/\ntmpl/*.tmp\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");

  // Untracked / gitignored content that must never be swept into a
  // directory-entry expansion.
  write(dir, "pkg/dist/generated.js", "// generated, gitignored\n");
  write(dir, "tmpl/ignored.tmp", "scratch\n");

  // A "node_modules"-style literal file entry that is intentionally never
  // committed to git at all (mirrors export-manifest.json's own
  // node_modules/@earendil-works/... file entries).
  write(dir, "vendor/lib.js", "module.exports = {};\n");

  return dir;
}

function writeManifest(root: string, paths: string[]): void {
  fs.writeFileSync(
    path.join(root, "export-manifest.json"),
    JSON.stringify({ version: 1, paths }, null, 2),
  );
}

describe("export-open-tree: planExportCopies path semantics", () => {
  it("expands a trailing-slash directory entry to git-tracked files only", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["pkg/"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    const files = planExportCopies({ rootDir: root, manifest, skeleton: [] });
    expect(files).toContain("pkg/index.ts");
    expect(files).not.toContain("pkg/dist/generated.js");
  });

  it("auto-detects a non-trailing-slash entry that is actually a directory and applies the same tracked-only filtering (ambiguous manifest entries like lib/yuan)", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["tmpl"]); // no trailing slash, but tmpl/ is a directory on disk
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    const files = planExportCopies({ rootDir: root, manifest, skeleton: [] });
    expect(files).toContain("tmpl/one.md");
    expect(files).not.toContain("tmpl/ignored.tmp");
  });

  it("treats a non-trailing-slash entry that is an actual file as a literal file", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    const files = planExportCopies({ rootDir: root, manifest, skeleton: [] });
    expect(files).toEqual(["src/a.ts"]);
  });

  it("copies a node_modules-style file entry verbatim without requiring git-tracked status", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["vendor/lib.js"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    const files = planExportCopies({ rootDir: root, manifest, skeleton: [] });
    expect(files).toEqual(["vendor/lib.js"]);
  });

  it("deduplicates when a manifest path and a skeleton path point at the same file", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    const files = planExportCopies({ rootDir: root, manifest, skeleton: [{ path: "src/a.ts" }] });
    expect(files).toEqual(["src/a.ts"]);
  });

  it("hard-errors when a manifest path does not exist in the repo", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["nope.ts"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    expect(() => planExportCopies({ rootDir: root, manifest, skeleton: [] })).toThrow(/does not exist/);
  });

  it("hard-errors when a manifest path resolves outside the repository root (path-escape guard)", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["../outside-secret.txt"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    expect(() => planExportCopies({ rootDir: root, manifest, skeleton: [] })).toThrow(/escapes repository root/);
  });

  it("hard-errors when a skeleton path resolves outside the repository root", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "export-manifest.json"), "utf-8"));
    expect(() => planExportCopies({ rootDir: root, manifest, skeleton: [{ path: "../../etc/passwd" }] }))
      .toThrow(/escapes repository root/);
  });
});

describe("export-open-tree: exportOpenTree materialization", () => {
  it("copies exactly the planned file set into destDir, byte-identical content", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts", "pkg/"]);
    const dest = path.join(root, "out");
    const result = exportOpenTree({ rootDir: root, destDir: dest, skeleton: [] });

    expect(result.fileCount).toBe(2);
    expect(fs.readFileSync(path.join(dest, "src", "a.ts"), "utf-8"))
      .toBe(fs.readFileSync(path.join(root, "src", "a.ts"), "utf-8"));
    expect(fs.existsSync(path.join(dest, "pkg", "dist", "generated.js"))).toBe(false);
  });

  it("refuses to write into a non-empty destDir without --force", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const dest = path.join(root, "out");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "leftover.txt"), "stale\n");

    expect(() => exportOpenTree({ rootDir: root, destDir: dest, skeleton: [] })).toThrow(/non-empty/);
    // Untouched: the stale file is still there.
    expect(fs.existsSync(path.join(dest, "leftover.txt"))).toBe(true);
  });

  it("with force: true, wipes a non-empty destDir and re-exports cleanly (idempotent rerun)", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    const dest = path.join(root, "out");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "leftover.txt"), "stale\n");

    const result = exportOpenTree({ rootDir: root, destDir: dest, force: true, skeleton: [] });
    expect(result.fileCount).toBe(1);
    expect(fs.existsSync(path.join(dest, "leftover.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "src", "a.ts"))).toBe(true);

    // Second run with force is idempotent.
    const second = exportOpenTree({ rootDir: root, destDir: dest, force: true, skeleton: [] });
    expect(second.fileCount).toBe(1);
  });

  it("refuses when destDir resolves to the repository root itself", () => {
    const root = makeFixtureRepo();
    writeManifest(root, ["src/a.ts"]);
    expect(() => exportOpenTree({ rootDir: root, destDir: root, skeleton: [] })).toThrow(/must not be the repository root/);
  });
});

describe("export-open-tree: real repository (smoke)", () => {
  it("materializes the real export-manifest.json + EXPORT_SKELETON, is idempotent under --force", () => {
    const dest = path.join(tempDir("hana-export-real-"), "out");
    const first = exportOpenTree({ rootDir: REPOSITORY_ROOT, destDir: dest, log: () => {} });
    expect(first.fileCount).toBeGreaterThan(0);
    for (const expected of ["package.json", "server/main-open.ts", "scripts/build-server-open.mjs", "package-lock.json"]) {
      expect(first.files).toContain(expected);
    }

    const second = exportOpenTree({ rootDir: REPOSITORY_ROOT, destDir: dest, force: true, log: () => {} });
    expect(second.fileCount).toBe(first.fileCount);
  }, 30_000);

  it("EXPORT_SKELETON entries are all real, existing repo-relative paths", () => {
    for (const { path: relPath, reason } of EXPORT_SKELETON) {
      expect(fs.existsSync(path.join(REPOSITORY_ROOT, relPath)), `${relPath} should exist`).toBe(true);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("the CLI subprocess exports into a given destination directory and exits 0", () => {
    const dest = path.join(tempDir("hana-export-cli-"), "out");
    const result = spawnSync(process.execPath, [EXPORT_SCRIPT, dest, "--force"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(dest, "package.json"))).toBe(true);
  }, 30_000);

  it("the CLI subprocess exits non-zero on an unknown flag", () => {
    const dest = path.join(tempDir("hana-export-cli-bad-"), "out");
    const result = spawnSync(process.execPath, [EXPORT_SCRIPT, dest, "--not-a-real-flag"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf-8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unknown argument/);
  });
});

describe("rehearse-open-export: DEFAULT_EXPORT_DIR_NAME", () => {
  it("matches the .gitignore-registered export directory name", () => {
    const gitignore = fs.readFileSync(path.join(REPOSITORY_ROOT, ".gitignore"), "utf-8");
    expect(gitignore).toMatch(new RegExp(`${DEFAULT_EXPORT_DIR_NAME}/`));
  });
});

describe("rehearse-open-export: runRehearsalStep exit-code propagation", () => {
  it("resolves without throwing when the command exits 0", () => {
    expect(() => runRehearsalStep({
      step: "ok-step",
      cmd: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: REPOSITORY_ROOT,
      log: () => {},
    })).not.toThrow();
  });

  it("throws with the step name and exit code when the command exits non-zero", () => {
    expect(() => runRehearsalStep({
      step: "failing-step",
      cmd: process.execPath,
      args: ["-e", "process.exit(3)"],
      cwd: REPOSITORY_ROOT,
      log: () => {},
    })).toThrow(/failing-step.*non-zero code 3/s);
  });

  it("throws when the command cannot be spawned at all", () => {
    expect(() => runRehearsalStep({
      step: "unspawnable-step",
      cmd: "this-binary-does-not-exist-anywhere",
      args: [],
      cwd: REPOSITORY_ROOT,
      log: () => {},
    })).toThrow(/failed to spawn/);
  });
});
