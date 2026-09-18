import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

import {
  assertOpenBuildInputsWhitelisted,
  declaredOpenBuildInputPaths,
  OPEN_BUNDLE_ENTRY,
  OPEN_LIB_DATA_FILES,
  OPEN_LIB_TEMPLATE_DIRS,
} from "../scripts/build-server-open.mjs";
import * as buildServerPhases from "../scripts/build-server-phases.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Strips block (/** *\/) and line (//) comments so source-scanning
 * assertions below check actual code, not prose documentation that
 * legitimately *names* the thing it says the code doesn't do (e.g. this
 * file's own module docstrings explain "no isOpen flag" / "never imports
 * build-server-artifact.mjs" — a naive substring search over the raw
 * source would flag its own documentation as a violation).
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("build-server-open: whitelist assertion (unit-level, no real build)", () => {
  it("passes for the real declared open build input list against the committed export-manifest.json", () => {
    expect(() => assertOpenBuildInputsWhitelisted({
      rootDir: ROOT,
      declaredPaths: declaredOpenBuildInputPaths(),
    })).not.toThrow();
  });

  it("does not include lib/pinned.example.md in the open data file list (no runtime-asset evidence)", () => {
    // See build/cli-runtime-closure.json's runtime-asset census: only the
    // files lib/i18n.ts et al. actually fs.readFileSync() at declared,
    // discoverable call sites are listed. pinned.example.md is read lazily
    // by lib/tools/pinned-memory.ts at tool-call time, which the census
    // does not (and structurally cannot) treat as a startup-required asset.
    expect(OPEN_LIB_DATA_FILES).not.toContain("pinned.example.md");
  });

  it("rejects a closed-product route path with an attributable error listing it", () => {
    expect(() => assertOpenBuildInputsWhitelisted({
      rootDir: ROOT,
      declaredPaths: ["server/routes/desk.ts"],
    })).toThrow(/server\/routes\/desk\.ts/);
  });

  it("rejects a fabricated path that exists in neither the whitelist nor runtime-asset evidence", () => {
    expect(() => assertOpenBuildInputsWhitelisted({
      rootDir: ROOT,
      declaredPaths: ["lib/pinned.example.md", "desktop/src/locales"],
    })).toThrow(/lib\/pinned\.example\.md/);
  });

  it("accepts a fixture manifest + fixture runtime-asset list without touching the real repo", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-open-whitelist-fixture-"));
    try {
      fs.writeFileSync(
        path.join(tempDir, "export-manifest.json"),
        JSON.stringify({ version: 1, paths: ["only/whitelisted.ts"] }),
      );
      expect(() => assertOpenBuildInputsWhitelisted({
        rootDir: tempDir,
        declaredPaths: ["only/whitelisted.ts"],
      })).not.toThrow();
      expect(() => assertOpenBuildInputsWhitelisted({
        rootDir: tempDir,
        declaredPaths: ["not/whitelisted.ts"],
      })).toThrow(/not\/whitelisted\.ts/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("build-server-phases.mjs: open/full parameter separation (no hidden behavior switches)", () => {
  it("does not export or reference an isOpen/isFull-style identity flag anywhere in its code", () => {
    const rawSource = fs.readFileSync(path.join(ROOT, "scripts", "build-server-phases.mjs"), "utf-8");
    const code = stripComments(rawSource);
    // Every open/full difference must be expressed by caller-supplied data
    // (entry paths, file lists, extra package names, nft roots) — never by
    // this module branching on which composition is being built. The raw
    // source's own docstring legitimately *names* "isOpen"/"isFull" while
    // explaining their absence, so this checks comment-stripped code only.
    expect(code).not.toMatch(/is[OoO]pen\b/i);
    expect(code).not.toMatch(/is[Ff]ull\b/i);
    expect(code).not.toMatch(/composition\s*===?\s*["'`](open|full)["'`]/i);
  });

  it("every exported primitive takes explicit parameters and no boolean named after a composition", () => {
    const exportNames = Object.keys(buildServerPhases).filter((name) => typeof buildServerPhases[name] === "function");
    expect(exportNames.length).toBeGreaterThan(0);
    const source = fs.readFileSync(path.join(ROOT, "scripts", "build-server-phases.mjs"), "utf-8");
    for (const name of exportNames) {
      // Locate this export's parameter destructuring block and make sure it
      // never spells out a composition-identity parameter name.
      const exportIndex = source.indexOf(`export function ${name}(`);
      const exportAsyncIndex = source.indexOf(`export async function ${name}(`);
      const start = exportIndex >= 0 ? exportIndex : exportAsyncIndex;
      expect(start).toBeGreaterThanOrEqual(0);
      const signatureSlice = source.slice(start, start + 400);
      expect(signatureSlice).not.toMatch(/\bopen\s*[:,]/i);
      expect(signatureSlice).not.toMatch(/\bfull\s*[:,]/i);
    }
  });
});

describe("server/main-open.ts: open composition entry (static check)", () => {
  const mainOpenPath = path.join(ROOT, "server", "main-open.ts");
  const source = fs.readFileSync(mainOpenPath, "utf-8");

  it("exists and imports only server/index.ts", () => {
    expect(fs.existsSync(mainOpenPath)).toBe(true);
    const importSpecifiers = [...source.matchAll(/^import\s+.*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(importSpecifiers).toEqual(["./index.ts"]);
  });

  it("calls startServer with an empty composition root (no registerClosedRoutes, no builtinMediaAdapters)", () => {
    const code = stripComments(source);
    expect(code).toMatch(/startServer\(\s*\{\s*\}\s*\)/);
    // The docstring explains, in prose, that there is no registerClosedRoutes
    // hook / builtinMediaAdapters / full-root import — checked against
    // comment-stripped code so that explanation doesn't trip its own check.
    expect(code).not.toMatch(/registerClosedRoutes/);
    expect(code).not.toMatch(/builtinMediaAdapters/);
    expect(code).not.toMatch(/full-root/);
  });

  it("is listed in export-manifest.json's whitelist", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "export-manifest.json"), "utf-8"));
    expect(manifest.paths).toContain("server/main-open.ts");
  });

  it("OPEN_BUNDLE_ENTRY matches the actual file used as the Vite bundle entry override", () => {
    expect(OPEN_BUNDLE_ENTRY).toBe("server/main-open.ts");
  });
});

describe("build-server-open.mjs: never imports build-server-artifact.mjs or reads HANA_SIGN_KEY", () => {
  const rawSource = fs.readFileSync(path.join(ROOT, "scripts", "build-server-open.mjs"), "utf-8");
  // The module docstring explains, in prose, everything this file
  // deliberately does NOT do (naming build-server-artifact.mjs,
  // HANA_SIGN_KEY, plugins/, skills2set/ to say so) — check comment-stripped
  // code so that explanation doesn't trip its own check.
  const source = stripComments(rawSource);

  it("does not import scripts/build-server-artifact.mjs", () => {
    expect(source).not.toMatch(/build-server-artifact\.mjs/);
  });

  it("does not reference HANA_SIGN_KEY or HANA_SIGN_KEYSET", () => {
    expect(source).not.toMatch(/HANA_SIGN_KEY/);
  });

  it("does not copy plugins/, skills2set/, or desktop runtime brand/renderer assets", () => {
    expect(source).not.toMatch(/["']plugins["']/);
    expect(source).not.toMatch(/skills2set/);
    expect(source).not.toMatch(/copyServerRuntimeAssets/);
  });

  it("declares the same lib/ template dirs list used for the whitelist assertion", () => {
    expect(OPEN_LIB_TEMPLATE_DIRS).toEqual([
      "identity-templates",
      "agents-templates",
      "agents-public-templates",
      "yuan",
    ]);
  });
});
