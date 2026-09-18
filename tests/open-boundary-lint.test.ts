import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  REPOSITORY_ROOT,
  checkRatchet,
  collectImportSpecifiers,
  expandManifestPaths,
  findBoundaryViolations,
  readBaseline,
  readExportManifest,
  resolveRelativeSpecifier,
} from "../scripts/lint-open-boundary.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LINT_SCRIPT = path.join(ROOT, "scripts", "lint-open-boundary.mjs");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeFixtureRepo(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-boundary-lint-"));
  tempDirs.push(root);
  for (const [relPath, contents] of Object.entries(files)) {
    const absPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, contents, "utf-8");
  }
  return root;
}

describe("lint-open-boundary: manifest loading", () => {
  it("rejects a negation-pattern entry", () => {
    const manifest = { version: 1, paths: ["!node_modules/**"] };
    const root = makeFixtureRepo({});
    fs.writeFileSync(path.join(root, "export-manifest.json"), JSON.stringify(manifest));
    expect(() => readExportManifest({ rootDir: root })).toThrow(/negation pattern/);
  });

  it("throws when a manifest file entry does not exist on disk", () => {
    const root = makeFixtureRepo({ "export-manifest.json": JSON.stringify({ version: 1, paths: ["missing.ts"] }) });
    const manifest = readExportManifest({ rootDir: root });
    expect(() => expandManifestPaths({ rootDir: root, manifest })).toThrow(/does not exist/);
  });

  it("throws when a manifest directory entry does not exist on disk", () => {
    const root = makeFixtureRepo({ "export-manifest.json": JSON.stringify({ version: 1, paths: ["missing-dir/"] }) });
    const manifest = readExportManifest({ rootDir: root });
    expect(() => expandManifestPaths({ rootDir: root, manifest })).toThrow(/directory entry does not exist/);
  });

  it("expands a real git-tracked directory to its tracked files only (excludes gitignored generated output)", () => {
    const manifest = { version: 1, paths: ["packages/plugin-protocol/"] };
    const files = expandManifestPaths({ rootDir: REPOSITORY_ROOT, manifest });
    expect(files.has("packages/plugin-protocol/package.json")).toBe(true);
    expect([...files].some((f) => f.startsWith("packages/plugin-protocol/dist/"))).toBe(false);
  });
});

describe("lint-open-boundary: import specifier collection", () => {
  it("collects literal static and dynamic import/require specifiers with line numbers", () => {
    const sourceText = [
      'import { a } from "./a.ts";',
      'export { b } from "./b.ts";',
      'const c = require("./c.cjs");',
      'async function load() { return import("./d.ts"); }',
    ].join("\n");
    const specifiers = collectImportSpecifiers({ relPath: "fixture.ts", sourceText });
    expect(specifiers.map((s) => s.text)).toEqual(["./a.ts", "./b.ts", "./c.cjs", "./d.ts"]);
    expect(specifiers[0].line).toBe(1);
  });

  it("ignores bare specifiers and non-literal dynamic calls (out of this lint's scope)", () => {
    const sourceText = [
      'import { a } from "some-npm-package";',
      'function load(target) { return import(target); }',
    ].join("\n");
    const specifiers = collectImportSpecifiers({ relPath: "fixture.ts", sourceText });
    expect(specifiers).toEqual([{ text: "some-npm-package", line: 1 }]);
  });
});

describe("lint-open-boundary: relative specifier resolution", () => {
  it("returns null for a bare (non-relative) specifier", () => {
    expect(resolveRelativeSpecifier({ rootDir: REPOSITORY_ROOT, importerRelPath: "cli/entry.ts", specifierText: "hono" }))
      .toBeNull();
  });

  it("resolves a relative specifier with an explicit extension", () => {
    expect(resolveRelativeSpecifier({ rootDir: REPOSITORY_ROOT, importerRelPath: "cli/entry.ts", specifierText: "./args.ts" }))
      .toBe("cli/args.ts");
  });

  it("throws when a relative specifier cannot be resolved to any file", () => {
    expect(() => resolveRelativeSpecifier({
      rootDir: REPOSITORY_ROOT,
      importerRelPath: "cli/entry.ts",
      specifierText: "./this-does-not-exist-anywhere",
    })).toThrow(/cannot resolve import/);
  });
});

describe("lint-open-boundary: violation detection", () => {
  it("reports an edge when a whitelisted file imports a non-whitelisted repo path", () => {
    const root = makeFixtureRepo({
      "open/a.ts": 'import { x } from "../closed/b.ts";\nexport const y = x;\n',
      "closed/b.ts": "export const x = 1;\n",
    });
    const manifest = { version: 1, paths: ["open/a.ts"] };
    const violations = findBoundaryViolations({ rootDir: root, manifest });
    expect(violations).toEqual([{ from: "open/a.ts", to: "closed/b.ts", line: 1 }]);
  });

  it("reports nothing when every import target is whitelisted", () => {
    const root = makeFixtureRepo({
      "open/a.ts": 'import { x } from "./b.ts";\nexport const y = x;\n',
      "open/b.ts": "export const x = 1;\n",
    });
    const manifest = { version: 1, paths: ["open/a.ts", "open/b.ts"] };
    const violations = findBoundaryViolations({ rootDir: root, manifest });
    expect(violations).toEqual([]);
  });

  it("does not scan non-JS/TS whitelisted files (e.g. markdown, JSON, HTML) for imports", () => {
    const root = makeFixtureRepo({
      "open/readme.md": "See [the closed doc](../closed/notes.md) for details.\n",
      "closed/notes.md": "internal\n",
    });
    const manifest = { version: 1, paths: ["open/readme.md"] };
    const violations = findBoundaryViolations({ rootDir: root, manifest });
    expect(violations).toEqual([]);
  });
});

describe("lint-open-boundary: ratchet check", () => {
  it("a violation already present in the baseline is ok (known debt)", () => {
    const violations = [{ from: "open/a.ts", to: "closed/b.ts", line: 1 }];
    const baseline = { edges: [{ from: "open/a.ts", to: "closed/b.ts", provenance: "x", classification: "closed-product" }] };
    const result = checkRatchet({ violations, baseline });
    expect(result.ok).toBe(true);
    expect(result.knownDebtCount).toBe(1);
    expect(result.newViolations).toEqual([]);
  });

  it("a violation NOT in the baseline fails closed and reports the exact from/to edge", () => {
    const violations = [{ from: "open/a.ts", to: "closed/b.ts", line: 1 }];
    const baseline = { edges: [] };
    const result = checkRatchet({ violations, baseline });
    expect(result.ok).toBe(false);
    expect(result.newViolations).toEqual(violations);
  });

  it("readBaseline throws a clear error when the baseline file is missing", () => {
    const root = makeFixtureRepo({});
    expect(() => readBaseline({ rootDir: root })).toThrow(/baseline not found/);
  });
});

describe("lint-open-boundary: real repo state (smoke)", () => {
  it("the committed export-manifest.json + baseline pass cleanly against real source", () => {
    const manifest = readExportManifest({ rootDir: REPOSITORY_ROOT });
    const violations = findBoundaryViolations({ rootDir: REPOSITORY_ROOT, manifest });
    const baseline = readBaseline({ rootDir: REPOSITORY_ROOT });
    const result = checkRatchet({ violations, baseline });
    expect(result.ok).toBe(true);
    expect(result.totalViolations).toBeGreaterThan(0); // known debt is expected to be non-zero right now
  }, 30_000);

  it("the CLI subprocess exits 0 against the real repo and reports the known-debt count", () => {
    const result = spawnSync(process.execPath, [LINT_SCRIPT], { cwd: REPOSITORY_ROOT, encoding: "utf-8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/lint:boundary ok/);
  }, 30_000);
});
