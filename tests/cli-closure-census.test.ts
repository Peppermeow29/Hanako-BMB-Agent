import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  REPOSITORY_ROOT,
  RUNTIME_ASSETS,
  classifyRepoPath,
  computeCliRuntimeClosure,
  computeOpenBoundaryBaseline,
  normalizeNftTraceFiles,
  scanAndValidateDynamicCallSites,
  scanDynamicCallSites,
  traceSourceGraph,
  validateRuntimeAssets,
  writeCliRuntimeClosure,
  writeOpenBoundaryBaseline,
} from "../scripts/compute-cli-closure.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLOSURE_PATH = path.join(ROOT, "build", "cli-runtime-closure.json");
const BASELINE_PATH = path.join(ROOT, "build", "open-boundary-baseline.json");

function makeTempFile(contents: string, extension = ".ts") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-closure-fixture-"));
  const filePath = path.join(dir, `fixture${extension}`);
  fs.writeFileSync(filePath, contents, "utf-8");
  return { dir, filePath, relPath: path.relative(dir, filePath) };
}

describe("compute-cli-closure: fail-closed validation", () => {
  it("throws when a declared root does not exist on disk", async () => {
    await expect(
      traceSourceGraph({
        rootDir: REPOSITORY_ROOT,
        root: { id: "missing-root", path: "cli/this-file-does-not-exist.ts", inputType: "source-graph", reason: "test" },
      }),
    ).rejects.toThrow(/does not exist on disk/);
  });

  it("throws when a declared runtime asset does not exist on disk", () => {
    expect(() => validateRuntimeAssets({
      rootDir: REPOSITORY_ROOT,
      assets: [...RUNTIME_ASSETS, { path: "lib/this-asset-does-not-exist.json", kind: "file", reason: "test" }],
    })).toThrow(/declared runtime asset\(s\) do not exist/);
  });

  it("does not throw when every declared runtime asset exists", () => {
    expect(() => validateRuntimeAssets({ rootDir: REPOSITORY_ROOT })).not.toThrow();
  });

  it("keeps nft closure output stable whether a local native binding exists", () => {
    const scratchRel = "build/.cli-closure-nft-scratch-test.mjs";
    const commonFiles = [
      scratchRel,
      "package.json",
      "node_modules/better-sqlite3/lib/database.js",
      "node_modules/better-sqlite3/package.json",
    ];
    const nativeBinding = "node_modules/better-sqlite3/build/Release/better_sqlite3.node";

    const withoutBinding = normalizeNftTraceFiles({ fileList: new Set(commonFiles), scratchRel });
    const withBinding = normalizeNftTraceFiles({
      fileList: new Set([...commonFiles, nativeBinding]),
      scratchRel,
    });

    expect(withBinding).toEqual(withoutBinding);
    expect(withBinding).toContain("node_modules/better-sqlite3/lib/database.js");
    expect(withBinding).toContain("node_modules/better-sqlite3/package.json");
    expect(withBinding).not.toContain(nativeBinding);
  });

  it("keeps nft closure output stable across the host's platform-variant native package", () => {
    const scratchRel = "build/.cli-closure-nft-scratch-test.mjs";
    // A napi-rs style package ships one npm package per platform, selected
    // through optionalDependencies, so the host's platform shows up in the
    // package *name* rather than inside a file the .node filter can reach.
    const commonFiles = [
      scratchRel,
      "package.json",
      "node_modules/@firecrawl/anydoc/index.js",
      "node_modules/@firecrawl/anydoc/package.json",
    ];

    const onMacOS = normalizeNftTraceFiles({
      fileList: new Set([
        ...commonFiles,
        "node_modules/@firecrawl/anydoc-darwin-arm64/package.json",
        "node_modules/@firecrawl/anydoc-darwin-arm64/anydoc.darwin-arm64.node",
      ]),
      scratchRel,
    });
    const onWindows = normalizeNftTraceFiles({
      fileList: new Set([
        ...commonFiles,
        "node_modules/@firecrawl/anydoc-win32-x64-msvc/package.json",
        "node_modules/@firecrawl/anydoc-win32-x64-msvc/anydoc.win32-x64-msvc.node",
      ]),
      scratchRel,
    });

    expect(onWindows).toEqual(onMacOS);
    // The variant package still has to leave evidence that it is required;
    // only the host-specific part of its name is folded away.
    expect(onMacOS).toContain("node_modules/@firecrawl/anydoc-<platform>/package.json");
    expect(onMacOS).toContain("node_modules/@firecrawl/anydoc/index.js");
    expect(onMacOS).not.toContain("node_modules/@firecrawl/anydoc-darwin-arm64/package.json");
  });

  it("does not fold a package that merely looks platform-suffixed but ships real code", () => {
    const scratchRel = "build/.cli-closure-nft-scratch-test.mjs";
    // Same name shape as a platform variant, but it contributes real modules
    // rather than a lone package.json, so folding it would erase real files.
    const files = [
      scratchRel,
      "package.json",
      "node_modules/some-tool-linux-x64/index.js",
      "node_modules/some-tool-linux-x64/lib/run.js",
      "node_modules/some-tool-linux-x64/package.json",
    ];

    const normalized = normalizeNftTraceFiles({ fileList: new Set(files), scratchRel });

    expect(normalized).toContain("node_modules/some-tool-linux-x64/index.js");
    expect(normalized).toContain("node_modules/some-tool-linux-x64/lib/run.js");
    expect(normalized).toContain("node_modules/some-tool-linux-x64/package.json");
  });

  it("flags a non-literal dynamic import() as a hit", () => {
    const hits = scanDynamicCallSites({
      relPath: "fixture.ts",
      sourceText: 'export async function load(target) { return import(target); }\n',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ callee: "import", kind: "dynamic-import", argText: "target" });
  });

  it("flags a non-literal require() as a hit but ignores a .require() method call", () => {
    const hits = scanDynamicCallSites({
      relPath: "fixture.ts",
      sourceText: [
        "const registry = { require(id) { return id; } };",
        "export function load(name) {",
        "  registry.require(name);", // method call, not the global require -- must NOT be flagged
        "  return require(name);", // real, non-literal require() -- must be flagged
        "}",
      ].join("\n"),
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ callee: "require", kind: "require-call", argText: "name" });
  });

  it("flags a non-literal child_process spawn-family call", () => {
    const hits = scanDynamicCallSites({
      relPath: "fixture.ts",
      sourceText: 'import { spawn } from "child_process";\nexport function run(cmd, args) { return spawn(cmd, args); }\n',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ callee: "spawn", kind: "process-spawn", argText: "cmd" });
  });

  it("does not flag literal import()/require()/spawn calls, including JSDoc-only import() type references", () => {
    const hits = scanDynamicCallSites({
      relPath: "fixture.ts",
      sourceText: [
        "/** @type {import('./types.ts').Foo} */",
        'const a = require("./literal.cjs");',
        'async function load() { return import("./literal.ts"); }',
        'import { spawn } from "child_process";',
        'function run() { return spawn("git", ["status"]); }',
      ].join("\n"),
    });
    expect(hits).toEqual([]);
  });

  it("scanAndValidateDynamicCallSites throws on a non-literal call with no allowlist entry", () => {
    const { dir, relPath } = makeTempFile('export function load(target) { return import(target); }\n');
    try {
      expect(() => scanAndValidateDynamicCallSites({ rootDir: dir, relPaths: [relPath], allowlist: [] }))
        .toThrow(/no\s+DYNAMIC_CALL_ALLOWLIST entry/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scanAndValidateDynamicCallSites succeeds when the call matches an allowlist entry exactly", () => {
    const { dir, relPath } = makeTempFile('export function load(target) { return import(target); }\n');
    try {
      const allowlist = [{ file: relPath, callee: "import", argText: "target", reason: "test fixture" }];
      expect(() => scanAndValidateDynamicCallSites({ rootDir: dir, relPaths: [relPath], allowlist })).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scanAndValidateDynamicCallSites throws when an allowlist entry matches no real call site (stale entry)", () => {
    const { dir, relPath } = makeTempFile("export const clean = 1;\n");
    try {
      const allowlist = [{ file: relPath, callee: "import", argText: "target", reason: "test fixture" }];
      expect(() => scanAndValidateDynamicCallSites({ rootDir: dir, relPaths: [relPath], allowlist }))
        .toThrow(/matched no real call site/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("compute-cli-closure: open/closed classification", () => {
  it("classifies confirmed closed-product routes", () => {
    expect(classifyRepoPath("server/routes/desk.ts")).toMatchObject({ classification: "closed-product" });
    expect(classifyRepoPath("server/routes/diary.ts")).toMatchObject({ classification: "closed-product" });
  });

  it("classifies closed-content (built-in plugins/skills)", () => {
    expect(classifyRepoPath("plugins/beautify/index.ts")).toMatchObject({ classification: "closed-content" });
    expect(classifyRepoPath("skills2set/whatever.md")).toMatchObject({ classification: "closed-content" });
  });

  it("classifies evidence-needed and provisional paths distinctly from closed-product/closed-content", () => {
    expect(classifyRepoPath("server/routes/mobile-workbench.ts")).toMatchObject({ classification: "evidence-needed" });
    expect(classifyRepoPath("desktop/src/shared/server-readiness.cjs")).toMatchObject({ classification: "provisional" });
  });

  it("treats the resolved theme-registry and suggestion-blocks rulings as redistributable", () => {
    // Resolved 2026-07-17: the theme registry manifest + lookup logic and
    // the automation suggestion wire-format builder carry no closed
    // product logic; both are listed in export-manifest.json.
    expect(classifyRepoPath("desktop/src/shared/theme-registry.cjs")).toBeNull();
    expect(classifyRepoPath("desktop/src/shared/theme-registry-data.json")).toBeNull();
    expect(classifyRepoPath("server/suggestion-blocks.ts")).toBeNull();
  });

  it("does not classify ordinary open source files", () => {
    expect(classifyRepoPath("cli/entry.ts")).toBeNull();
    expect(classifyRepoPath("core/engine.ts")).toBeNull();
    expect(classifyRepoPath("server/index.ts")).toBeNull();
  });
});

describe("compute-cli-closure: full generation (real esbuild + nft, slow)", () => {
  it("matches the committed deterministic closure and baseline", async () => {
    const generatedClosure = await computeCliRuntimeClosure({ rootDir: REPOSITORY_ROOT, includeNftTrace: true });
    const committedClosure = JSON.parse(fs.readFileSync(CLOSURE_PATH, "utf-8"));
    expect(generatedClosure).toEqual(committedClosure);
    expect(JSON.stringify(generatedClosure)).not.toMatch(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)/);

    const generatedBaseline = computeOpenBoundaryBaseline({ closure: generatedClosure });
    const committedBaseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"));
    expect(generatedBaseline).toEqual(committedBaseline);

    // Sanity bounds on scale, so a catastrophic under/over-count would fail
    // even if the exact numbers above ever legitimately drift with source
    // changes and this assertion needs a manual bump.
    expect(generatedClosure.stats.byInputType["source-graph"]).toBeGreaterThan(500);
    expect(generatedClosure.stats.byInputType["nft-runtime-trace"]).toBeGreaterThan(5000);
    expect(generatedBaseline.stats.totalEdges).toBeGreaterThan(0);
  }, 120_000);

  it("is idempotent: two independent full runs produce identical output", async () => {
    const first = await computeCliRuntimeClosure({ rootDir: REPOSITORY_ROOT, includeNftTrace: true });
    const second = await computeCliRuntimeClosure({ rootDir: REPOSITORY_ROOT, includeNftTrace: true });
    expect(second).toEqual(first);

    const baselineFirst = computeOpenBoundaryBaseline({ closure: first });
    const baselineSecond = computeOpenBoundaryBaseline({ closure: second });
    expect(baselineSecond).toEqual(baselineFirst);
  }, 180_000);

  it("writeCliRuntimeClosure/writeOpenBoundaryBaseline regenerate the exact committed files in place", async () => {
    const before = fs.readFileSync(CLOSURE_PATH, "utf-8");
    const beforeBaseline = fs.readFileSync(BASELINE_PATH, "utf-8");
    // Reuses the closure writeCliRuntimeClosure already computed (rather
    // than calling computeCliRuntimeClosure a second time) to avoid paying
    // for a second full esbuild+nft pass in an already-slow test file.
    const { closure, outPath } = await writeCliRuntimeClosure({ rootDir: REPOSITORY_ROOT });
    const { outPath: baselineOutPath } = await writeOpenBoundaryBaseline({ rootDir: REPOSITORY_ROOT, closure });
    expect(outPath).toBe(CLOSURE_PATH);
    expect(baselineOutPath).toBe(BASELINE_PATH);
    const after = fs.readFileSync(CLOSURE_PATH, "utf-8");
    const afterBaseline = fs.readFileSync(BASELINE_PATH, "utf-8");
    expect(after).toBe(before);
    expect(afterBaseline).toBe(beforeBaseline);
  }, 120_000);
});
