/**
 * The persistence scan is what forces every production write to be claimed by a
 * store. A write it cannot see is a write that escapes that requirement
 * entirely, so the set of call shapes it recognizes is itself a contract.
 *
 * Descriptor-based writes are the same operation as the whole-file helpers,
 * expressed through a file descriptor. These cases pin them down so a write
 * spelled that way cannot slip past the census.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PRODUCTION_ROOTS, discoverSites } from "../scripts/scan-persistent-stores.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeFixtureRepo(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-scan-fd-"));
  tempDirs.push(root);
  // The source walker requires every production root to exist.
  for (const dir of PRODUCTION_ROOTS) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const [relPath, contents] of Object.entries(files)) {
    const absPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, contents, "utf-8");
  }
  return root;
}

function sitesIn(root: string, sourceFile: string) {
  return discoverSites(root).filter((site: any) => site.sourceFile === sourceFile);
}

describe("persistence scan: descriptor-based writes", () => {
  it("counts a descriptor opened for writing as a file write", () => {
    const root = makeFixtureRepo({
      "core/opener.ts": [
        'import fs from "node:fs";',
        "",
        "export function open(target: string) {",
        '  return fs.openSync(target, "w");',
        "}",
      ].join("\n"),
    });

    expect(sitesIn(root, "core/opener.ts").map((site: any) => site.kind)).toEqual(["write-file"]);
  });

  it("counts writes through a descriptor as file writes", () => {
    const root = makeFixtureRepo({
      "core/writer.ts": [
        'import fs from "node:fs";',
        "",
        "export function save(fd: number, data: Buffer, chunks: Buffer[]) {",
        "  fs.writeSync(fd, data);",
        "  fs.writevSync(fd, chunks);",
        "}",
      ].join("\n"),
    });

    expect(sitesIn(root, "core/writer.ts").map((site: any) => site.kind)).toEqual([
      "write-file",
      "write-file",
    ]);
  });

  it("ignores a descriptor opened only for reading", () => {
    const root = makeFixtureRepo({
      "core/reader.ts": [
        'import fs from "node:fs";',
        "",
        "export function load(target: string) {",
        '  const fd = fs.openSync(target, "r");',
        "  fs.closeSync(fd);",
        "  return fd;",
        "}",
      ].join("\n"),
    });

    expect(sitesIn(root, "core/reader.ts")).toEqual([]);
  });
});
