import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAnydocRuntimeSmokeScript,
  buildBetterSqliteRuntimeSmokeScript,
  buildExternalPackage,
  buildJiebaRuntimeSmokeScript,
  collectBareImportPackageNames,
  collectInstalledOptionalDependencyDirs,
  readPackageJsonWithRetry,
  verifyExternalEntrypoints,
} from "../scripts/build-server-deps.mjs";

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-server-deps-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("build-server external dependency packaging", () => {
  it("collects bare static import package names from the emitted server bundle", () => {
    const packages = collectBareImportPackageNames([
      "import fs from 'node:fs';",
      "import './local.js';",
      "import { completeSimple } from '@earendil-works/pi-ai/compat';",
      "import '@earendil-works/pi-agent-core';",
      "import qrcode from 'qrcode';",
    ].join("\n"));

    expect(packages).toEqual([
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "qrcode",
    ]);
  });

  it("pins server externals and selected runtime transitives to the root lock versions", () => {
    const rootPkg = {
      name: "hanako",
      version: "1.0.1",
    };
    const rootLock = {
      name: "hanako",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "hanako",
          version: "1.0.0",
          dependencies: {
            jsdom: "^29.0.2",
            vite: "^7.0.0",
          },
          devDependencies: {
            vite: "^7.0.0",
          },
        },
        "node_modules/jsdom": {
          version: "29.0.2",
          dependencies: {
            "lru-cache": "^11.2.7",
          },
        },
        "node_modules/lru-cache": {
          version: "11.2.7",
        },
        "node_modules/vite": {
          version: "7.3.0",
          dev: true,
        },
      },
    };

    const serverPkg = buildExternalPackage(
      rootPkg,
      {
        jsdom: "^29.0.2",
      },
      {
        rootLock,
        pinnedTransitiveDeps: ["lru-cache"],
      },
    );

    expect(serverPkg).toEqual({
      name: "hanako-server",
      version: "1.0.1",
      type: "module",
      dependencies: {
        jsdom: "29.0.2",
        "lru-cache": "11.2.7",
      },
    });
  });

  it("protects installed optional runtime packages owned by server externals", () => {
    const outDir = makeTempDir();
    const nmDir = path.join(outDir, "node_modules");
    const rootPackageDir = path.join(nmDir, "@node-rs", "jieba");
    const nativePackageDir = path.join(nmDir, "@node-rs", "jieba-darwin-arm64");
    fs.mkdirSync(rootPackageDir, { recursive: true });
    fs.mkdirSync(nativePackageDir, { recursive: true });
    fs.writeFileSync(path.join(rootPackageDir, "package.json"), JSON.stringify({
      name: "@node-rs/jieba",
      optionalDependencies: {
        "@node-rs/jieba-darwin-arm64": "2.0.1",
        "@node-rs/jieba-linux-x64-gnu": "2.0.1",
      },
    }));

    const dirs = collectInstalledOptionalDependencyDirs(nmDir, ["@node-rs/jieba"]);

    expect(dirs).toEqual([nativePackageDir]);
  });

  it("generates a runtime smoke script that requires jieba, dict, and custom dictionary terms", () => {
    const outDir = makeTempDir();
    const rootPackageDir = path.join(outDir, "node_modules", "@node-rs", "jieba");
    fs.mkdirSync(rootPackageDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(path.join(rootPackageDir, "dict.js"), "module.exports.dict = Buffer.from('dict')\n");
    fs.writeFileSync(path.join(rootPackageDir, "index.js"), [
      "class Jieba {",
      "  static withDict(dict) { if (!Buffer.isBuffer(dict)) throw new Error('missing dict'); return new Jieba(); }",
      "  loadDict(dict) { this.customDict = dict.toString('utf8'); }",
      "  cutForSearch() {",
      "    if (!this.customDict.includes('session_search')) throw new Error('missing custom dict');",
      "    return ['聊天记录', 'A2A通信', 'session_search'];",
      "  }",
      "}",
      "module.exports = { Jieba };",
    ].join("\n"));

    const scriptPath = path.join(outDir, ".jieba-smoke.mjs");
    fs.writeFileSync(scriptPath, buildJiebaRuntimeSmokeScript());

    expect(() => execFileSync(process.execPath, [scriptPath], { cwd: outDir }))
      .not.toThrow();
  });

  it("generates a better-sqlite3 smoke script that opens a database", () => {
    const outDir = makeTempDir();
    const packageDir = path.join(outDir, "node_modules", "better-sqlite3");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(path.join(packageDir, "index.js"), [
      "module.exports = class Database {",
      "  constructor(filename) { if (filename !== ':memory:') throw new Error('unexpected filename'); }",
      "  prepare(sql) {",
      "    if (sql !== 'select 1 as ok') throw new Error('unexpected sql');",
      "    return { get: () => ({ ok: 1 }) };",
      "  }",
      "  close() { this.closed = true; }",
      "}",
    ].join("\n"));
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
      name: "better-sqlite3",
      main: "index.js",
    }));

    const scriptPath = path.join(outDir, ".better-sqlite3-smoke.mjs");
    fs.writeFileSync(scriptPath, buildBetterSqliteRuntimeSmokeScript());

    expect(() => execFileSync(process.execPath, [scriptPath], { cwd: outDir }))
      .not.toThrow();
  });

  it("generates an anydoc smoke script that converts bytes through a dynamic import", () => {
    const outDir = makeTempDir();
    const packageDir = path.join(outDir, "node_modules", "@firecrawl", "anydoc");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }));
    // The stub asserts the call shape the packaged runtime depends on: the
    // source bytes arrive intact and signature-less CSV is named explicitly.
    fs.writeFileSync(path.join(packageDir, "index.js"), [
      "module.exports.toMarkdownBytes = async (bytes, format) => {",
      "  if (format !== 'csv') throw new Error('unexpected format');",
      "  const text = Buffer.from(bytes).toString('utf8');",
      "  if (text !== 'a,b\\n1,2') throw new Error('unexpected bytes');",
      "  return '| a | b |\\n| --- | --- |\\n| 1 | 2 |\\n';",
      "};",
    ].join("\n"));
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
      name: "@firecrawl/anydoc",
      main: "index.js",
    }));

    const scriptPath = path.join(outDir, ".anydoc-smoke.mjs");
    fs.writeFileSync(scriptPath, buildAnydocRuntimeSmokeScript());

    expect(() => execFileSync(process.execPath, [scriptPath], { cwd: outDir }))
      .not.toThrow();
  });

  it("generates an anydoc smoke script that fails when the native binding cannot load", () => {
    const outDir = makeTempDir();
    const packageDir = path.join(outDir, "node_modules", "@firecrawl", "anydoc");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }));
    // What a packaged server missing its platform binary actually does: the
    // napi loader throws while resolving the addon, so the build must stop.
    fs.writeFileSync(path.join(packageDir, "index.js"), [
      "throw new Error('Failed to load native binding');",
    ].join("\n"));
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
      name: "@firecrawl/anydoc",
      main: "index.js",
    }));

    const scriptPath = path.join(outDir, ".anydoc-smoke.mjs");
    fs.writeFileSync(scriptPath, buildAnydocRuntimeSmokeScript());

    expect(() => execFileSync(process.execPath, [scriptPath], { cwd: outDir, stdio: "pipe" }))
      .toThrow();
  });

  it("fails fast when an installed external package export resolves to a missing file", () => {
    const outDir = makeTempDir();
    const packageDir = path.join(outDir, "node_modules", "bad-export-package");
    fs.mkdirSync(path.join(packageDir, "dist", "commonjs"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(path.join(packageDir, "dist", "commonjs", "index.min.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
      name: "bad-export-package",
      version: "1.0.0",
      exports: {
        ".": {
          require: {
            node: {
              default: "./dist/commonjs/node/index.min.js",
            },
            default: "./dist/commonjs/index.min.js",
          },
        },
      },
    }));

    expect(() => verifyExternalEntrypoints(outDir, ["bad-export-package"])).toThrow(
      /bad-export-package.*dist\/commonjs\/node\/index\.min\.js/s,
    );
  });

  it("accepts import-only package exports when the runtime target exists", () => {
    const outDir = makeTempDir();
    const packageDir = path.join(outDir, "node_modules", "esm-only-package");
    fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "dist", "index.js"), "export const ok = true;\n");
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
      name: "esm-only-package",
      version: "1.0.0",
      type: "module",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
    }));

    expect(() => verifyExternalEntrypoints(outDir, ["esm-only-package"])).not.toThrow();
  });
});

// ── readPackageJsonWithRetry: errno distinction contract ──────────────────────
// These tests verify the core contract that separates the #1307 root cause:
//   - EMFILE/ENFILE (transient handle exhaustion) → retry, then re-throw as I/O error
//   - ENOENT (file genuinely absent) → propagate immediately as product failure
//   - JSON SyntaxError (corrupt file) → propagate immediately as product failure
//
// Because EMFILE is hard to produce deterministically without kernel cooperation,
// we test by directly stubbing fs.readFileSync, which is the exact seam that
// the Windows build fails at during nft trace's file handle exhaustion.
describe("readPackageJsonWithRetry errno contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed JSON on first successful read", () => {
    const outDir = makeTempDir();
    const filePath = path.join(outDir, "package.json");
    fs.writeFileSync(filePath, JSON.stringify({ name: "ok-pkg", version: "1.0.0" }));

    const result = readPackageJsonWithRetry(filePath);
    expect(result).toEqual({ name: "ok-pkg", version: "1.0.0" });
  });

  it("retries on EMFILE and returns the value when a later attempt succeeds", () => {
    const outDir = makeTempDir();
    const filePath = path.join(outDir, "package.json");
    const content = JSON.stringify({ name: "retry-pkg", version: "2.0.0" });
    fs.writeFileSync(filePath, content);

    const original = fs.readFileSync.bind(fs);
    let callCount = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      callCount++;
      if (callCount <= 2) {
        const err = Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
        throw err;
      }
      return original(...args);
    });

    // Should not throw — succeeds on 3rd attempt.
    const result = readPackageJsonWithRetry(filePath, { maxRetries: 5, baseDelayMs: 1 });
    expect(result).toEqual({ name: "retry-pkg", version: "2.0.0" });
    expect(callCount).toBe(3);
  });

  it("re-throws EMFILE after exhausting all retries (does NOT silently swallow or misreport as missing)", () => {
    const outDir = makeTempDir();
    const filePath = path.join(outDir, "package.json");
    fs.writeFileSync(filePath, JSON.stringify({ name: "pkg" }));

    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      const err = Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
      throw err;
    });

    // Must re-throw with code EMFILE, not silently return undefined or fold into failures.
    expect(() => readPackageJsonWithRetry(filePath, { maxRetries: 2, baseDelayMs: 1 }))
      .toThrow(expect.objectContaining({ code: "EMFILE" }));
  });

  it("re-throws ENFILE after exhausting all retries", () => {
    const outDir = makeTempDir();
    const filePath = path.join(outDir, "package.json");
    fs.writeFileSync(filePath, JSON.stringify({ name: "pkg" }));

    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      const err = Object.assign(new Error("ENFILE: file table overflow"), { code: "ENFILE" });
      throw err;
    });

    expect(() => readPackageJsonWithRetry(filePath, { maxRetries: 2, baseDelayMs: 1 }))
      .toThrow(expect.objectContaining({ code: "ENFILE" }));
  });

  it("propagates ENOENT immediately without retry (file truly absent)", () => {
    const outDir = makeTempDir();
    const missingPath = path.join(outDir, "nonexistent.json");

    let callCount = 0;
    const spy = vi.spyOn(fs, "readFileSync");
    spy.mockImplementation((...args) => {
      callCount++;
      // Let the real implementation run — it will throw ENOENT
      return (fs.readFileSync as any).wrappedImplementation?.(...args)
        ?? (() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); })();
    });

    // Use real fs (no mock) to get genuine ENOENT — spy just counts calls.
    vi.restoreAllMocks();
    let thrown;
    try {
      readPackageJsonWithRetry(missingPath, { maxRetries: 5, baseDelayMs: 1 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe("ENOENT");
  });

  it("propagates JSON SyntaxError immediately (corrupt package.json)", () => {
    const outDir = makeTempDir();
    const filePath = path.join(outDir, "package.json");
    fs.writeFileSync(filePath, "{ this is: not valid json !!!");

    expect(() => readPackageJsonWithRetry(filePath, { maxRetries: 5, baseDelayMs: 1 }))
      .toThrow(SyntaxError);
  });
});

// ── verifyExternalEntrypoints EMFILE contract ─────────────────────────────────
// Verifies that EMFILE from readPackageJsonWithRetry causes verifyExternalEntrypoints
// to re-throw as an I/O error rather than adding to failures as "missing entrypoint".
describe("verifyExternalEntrypoints EMFILE contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-throws EMFILE as I/O error, not as entrypoint verification failure", () => {
    const outDir = makeTempDir();
    const packageDir = path.join(outDir, "node_modules", "my-pkg");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
      name: "my-pkg",
      version: "1.0.0",
      main: "./index.js",
    }));
    fs.writeFileSync(path.join(packageDir, "index.js"), "module.exports = {};\n");

    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      const err = Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
      throw err;
    });

    // Must re-throw EMFILE rather than report "[build-server] external package entrypoint verification failed"
    let thrown;
    try {
      verifyExternalEntrypoints(outDir, ["my-pkg"], { readRetries: 0, readBaseDelayMs: 1 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    // The thrown error must be the EMFILE I/O error, not the product-integrity message.
    // If this assertion fails, the errno-discrimination fix is broken.
    expect(thrown.code).toBe("EMFILE");
    expect(thrown.message).not.toMatch(/entrypoint verification failed/);
  });

  it("still reports ENOENT as a genuine entrypoint failure (package not installed)", () => {
    const outDir = makeTempDir();
    // Note: node_modules/missing-pkg directory does not exist at all.

    expect(() => verifyExternalEntrypoints(outDir, ["missing-pkg"]))
      .toThrow(/entrypoint verification failed/);
  });
});
