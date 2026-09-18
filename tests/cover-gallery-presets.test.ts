import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  COVER_GALLERY_PRESETS,
  getCoverGalleryPreset,
} from "../shared/cover-gallery-presets.ts";
import { resolveCoverGalleryPresetImagePath } from "../plugins/beautify/lib/cover-gallery-assets.ts";

describe("cover gallery presets", () => {
  it("keeps built-in cover presets as plain bundled asset file names", () => {
    expect(COVER_GALLERY_PRESETS.length).toBeGreaterThan(0);

    for (const preset of COVER_GALLERY_PRESETS) {
      expect(preset.id).toMatch(/^[a-z0-9-]+$/);
      expect(preset.title).toBeTruthy();
      expect(preset.fileName).toMatch(/^[a-z0-9-]+\.(png|jpg|jpeg|webp)$/);
      expect(preset.fileName).not.toContain("/");
      expect(preset.fileName).not.toContain("\\");
    }
  });

  it("resolves a preset image under the cover gallery asset directory", () => {
    const preset = COVER_GALLERY_PRESETS[0];
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cover-gallery-root-"));
    const assetDir = path.join(rootDir, "desktop", "src", "assets", "cover-gallery");
    fs.mkdirSync(assetDir, { recursive: true });
    fs.writeFileSync(path.join(assetDir, preset.fileName), "image");

    try {
      expect(getCoverGalleryPreset(preset.id)).toEqual(preset);
      expect(resolveCoverGalleryPresetImagePath(preset.id, { rootDir }))
        .toBe(path.join(assetDir, preset.fileName));
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("fails loudly when a whitelisted preset asset is missing from the bundle", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cover-gallery-missing-"));
    try {
      expect(() => resolveCoverGalleryPresetImagePath(COVER_GALLERY_PRESETS[0].id, { rootDir }))
        .toThrow("cover gallery preset image missing");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown preset ids instead of treating them as paths", () => {
    expect(getCoverGalleryPreset("../private")).toBeNull();
    expect(() => resolveCoverGalleryPresetImagePath("../private", { rootDir: "/tmp/hana" }))
      .toThrow("unknown cover gallery preset");
  });
});
