import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { copySplashAssets } from "../scripts/splash-assets.mjs";
import { YUAN_VISUALS } from "../shared/yuan-visuals.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Builds a desktop/src-shaped fixture with exactly what SplashApp.tsx references. */
function makeSrcFixture(root: string) {
  const srcDir = path.join(root, "desktop-src-fixture");
  fs.mkdirSync(path.join(srcDir, "modules"), { recursive: true });
  fs.writeFileSync(path.join(srcDir, "modules", "platform.js"), "window.platform = window.hana;\n");

  fs.mkdirSync(path.join(srcDir, "locales"), { recursive: true });
  fs.writeFileSync(path.join(srcDir, "locales", "zh.json"), JSON.stringify({ splash: {} }));
  fs.writeFileSync(path.join(srcDir, "locales", "en.json"), JSON.stringify({ splash: {} }));
  // A non-locale file that must NOT be copied (only *.json under locales/ is in scope).
  fs.writeFileSync(path.join(srcDir, "locales", "README.md"), "not a locale");

  fs.mkdirSync(path.join(srcDir, "assets"), { recursive: true });
  for (const visual of Object.values(YUAN_VISUALS)) {
    fs.writeFileSync(path.join(srcDir, "assets", visual.avatar), `fake-png-bytes-${visual.avatar}`);
  }
  // An unrelated asset (e.g. a character card image) that splash never
  // references — must NOT be swept into the splash bundle (that's the whole
  // point of not reusing dist-renderer's blanket copyLegacyFiles copy).
  fs.mkdirSync(path.join(srcDir, "assets", "character-cards"), { recursive: true });
  fs.writeFileSync(path.join(srcDir, "assets", "character-cards", "unrelated.png"), "unrelated");

  return srcDir;
}

describe("splash-assets: copySplashAssets census", () => {
  it("copies platform.js, all locale JSON files, and exactly the yuan avatar PNGs", () => {
    const root = makeTempDir("hana-splash-assets-");
    const srcDir = makeSrcFixture(root);
    const outDir = path.join(root, "dist-splash");

    const result = copySplashAssets({ srcDir, outDir });

    expect(fs.existsSync(path.join(outDir, "modules", "platform.js"))).toBe(true);
    expect(result.platformJs).toBe(true);

    expect(fs.existsSync(path.join(outDir, "locales", "zh.json"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "locales", "en.json"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "locales", "README.md"))).toBe(false);
    expect(result.locales.sort()).toEqual(["en.json", "zh.json"]);

    const expectedAvatars = Object.values(YUAN_VISUALS).map((v) => v.avatar).sort();
    expect(result.avatars.sort()).toEqual(expectedAvatars);
    for (const avatar of expectedAvatars) {
      expect(fs.existsSync(path.join(outDir, "assets", avatar))).toBe(true);
    }
    // The unrelated asset directory must NOT be dragged along.
    expect(fs.existsSync(path.join(outDir, "assets", "character-cards"))).toBe(false);
  });

  it("derives the avatar list from YUAN_VISUALS (single source of truth — no private list to drift)", () => {
    const root = makeTempDir("hana-splash-assets-");
    const srcDir = makeSrcFixture(root);
    const outDir = path.join(root, "dist-splash");

    const result = copySplashAssets({ srcDir, outDir });

    // If a new yuan is ever added to YUAN_VISUALS with a new avatar filename,
    // this test (via the fixture, which is ALSO built from YUAN_VISUALS)
    // proves copySplashAssets picks it up automatically — no hardcoded list
    // to update in two places.
    expect(result.avatars.length).toBe(Object.keys(YUAN_VISUALS).length);
  });
});
