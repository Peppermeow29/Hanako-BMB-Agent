import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneRuntimeDeadFiles, shouldPruneRuntimeDeadFile } from "../scripts/build-server-prune.mjs";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-server-prune-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("shouldPruneRuntimeDeadFile", () => {
  it("flags TypeScript source and declaration files", () => {
    expect(shouldPruneRuntimeDeadFile("foo.ts")).toBe(true);
    expect(shouldPruneRuntimeDeadFile("foo.d.ts")).toBe(true);
  });

  it("flags source maps", () => {
    expect(shouldPruneRuntimeDeadFile("index.js.map")).toBe(true);
  });

  it("flags markdown files", () => {
    expect(shouldPruneRuntimeDeadFile("README.md")).toBe(true);
  });

  it("keeps license and notice files", () => {
    expect(shouldPruneRuntimeDeadFile("LICENSE.md")).toBe(false);
    expect(shouldPruneRuntimeDeadFile("LICENSE")).toBe(false);
    expect(shouldPruneRuntimeDeadFile("NOTICE")).toBe(false);
  });

  it("keeps runtime-relevant files", () => {
    expect(shouldPruneRuntimeDeadFile("index.js")).toBe(false);
    expect(shouldPruneRuntimeDeadFile("package.json")).toBe(false);
    expect(shouldPruneRuntimeDeadFile("addon.node")).toBe(false);
  });

  it("flags .mts and .cts extensions", () => {
    expect(shouldPruneRuntimeDeadFile("foo.mts")).toBe(true);
    expect(shouldPruneRuntimeDeadFile("foo.cts")).toBe(true);
  });

  it("is case-insensitive for extension and prefix matching", () => {
    expect(shouldPruneRuntimeDeadFile("README.MD")).toBe(true);
    expect(shouldPruneRuntimeDeadFile("License.Md")).toBe(false);
  });

  it("keeps additional protected legal prefixes regardless of extension", () => {
    expect(shouldPruneRuntimeDeadFile("licence.md")).toBe(false);
    expect(shouldPruneRuntimeDeadFile("COPYING.md")).toBe(false);
    expect(shouldPruneRuntimeDeadFile("NOTICE.md")).toBe(false);
  });

  it("only protects exact prefix matches, not arbitrary words containing them", () => {
    expect(shouldPruneRuntimeDeadFile("licenses.md")).toBe(false);
  });

  it("keeps .cjs and .mjs files (not in the dead extension set)", () => {
    expect(shouldPruneRuntimeDeadFile("foo.cjs")).toBe(false);
    expect(shouldPruneRuntimeDeadFile("foo.mjs")).toBe(false);
  });
});

describe("pruneRuntimeDeadFiles", () => {
  it("deletes runtime dead files, keeps protected/runtime files, and removes emptied directories", () => {
    const root = makeTempDir();
    const nmDir = path.join(root, "node_modules");

    // top-level package with dead files mixed with runtime files
    const pkgA = path.join(nmDir, "pkg-a");
    fs.mkdirSync(pkgA, { recursive: true });
    fs.writeFileSync(path.join(pkgA, "index.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(pkgA, "index.js.map"), "{}");
    fs.writeFileSync(path.join(pkgA, "package.json"), JSON.stringify({ name: "pkg-a" }));
    fs.writeFileSync(path.join(pkgA, "LICENSE.md"), "MIT License text");

    // a subdirectory that should be entirely removed once its only file (a .ts) is pruned
    const pkgADeadSubdir = path.join(pkgA, "src-types");
    fs.mkdirSync(pkgADeadSubdir, { recursive: true });
    fs.writeFileSync(path.join(pkgADeadSubdir, "types.d.ts"), "export type Foo = string;\n");

    // nested node_modules (vendored subdependency) with its own dead weight
    const nestedPkg = path.join(nmDir, "@scope", "pkg-b", "node_modules", "vendored-dep");
    fs.mkdirSync(nestedPkg, { recursive: true });
    fs.writeFileSync(path.join(nestedPkg, "index.mjs"), "export default {};\n");
    fs.writeFileSync(path.join(nestedPkg, "README.md"), "# vendored-dep\n");
    fs.writeFileSync(path.join(nestedPkg, "notes.mts"), "export const x = 1;\n");

    const result = pruneRuntimeDeadFiles(nmDir);

    // dead files gone
    expect(fs.existsSync(path.join(pkgA, "index.js.map"))).toBe(false);
    expect(fs.existsSync(path.join(pkgADeadSubdir, "types.d.ts"))).toBe(false);
    expect(fs.existsSync(path.join(nestedPkg, "README.md"))).toBe(false);
    expect(fs.existsSync(path.join(nestedPkg, "notes.mts"))).toBe(false);

    // emptied directory removed
    expect(fs.existsSync(pkgADeadSubdir)).toBe(false);

    // kept files remain
    expect(fs.existsSync(path.join(pkgA, "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(pkgA, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(pkgA, "LICENSE.md"))).toBe(true);
    expect(fs.existsSync(path.join(nestedPkg, "index.mjs"))).toBe(true);

    // removedFiles count: index.js.map, types.d.ts, README.md, notes.mts = 4
    expect(result.removedFiles).toBe(4);
    expect(result.removedSize).toBeGreaterThan(0);
  });
});
