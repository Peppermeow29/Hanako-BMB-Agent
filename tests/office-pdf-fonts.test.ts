import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HANA_PDF_FONT_FAMILIES,
  assertOfficePdfFontAssets,
  buildFontInjectionCss,
  locateThemesDir,
  resolveThemesDir,
} from "../desktop/src/office-pdf-fonts.cjs";

const FONTS_CSS = "new-warm-paper-fonts.css";
const SELECTED_FONT_FILES = [
  "ebgaramond-aaa.woff2",
  "notoserifsc-bbb.woff2",
  "jetbrainsmono-ccc.woff2",
];

const SAMPLE_CSS = `/* latin */
@font-face {
  font-family: 'EB Garamond';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('./fonts/ebgaramond-aaa.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+2000-206F;
}
@font-face {
  font-family: 'Noto Serif SC';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('./fonts/notoserifsc-bbb.woff2') format('woff2');
  unicode-range: U+4E00-9FFF;
}
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('./fonts/jetbrainsmono-ccc.woff2') format('woff2');
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 300;
  font-display: swap;
  src: url('./fonts/inter-ddd.woff2') format('woff2');
}
`;

describe("office pdf font injection css", () => {
  let tempDir: string;
  let themesDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-pdf-fonts-"));
    themesDir = path.join(tempDir, "themes");
    fs.mkdirSync(path.join(themesDir, "fonts"), { recursive: true });
    fs.writeFileSync(path.join(themesDir, FONTS_CSS), SAMPLE_CSS, "utf-8");
    for (const fileName of SELECTED_FONT_FILES) {
      fs.writeFileSync(path.join(themesDir, "fonts", fileName), Buffer.from("wOF2fixture"));
    }
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps only the whitelisted Hana families and drops the rest", () => {
    const css = buildFontInjectionCss({ themesDir });
    expect(css).toContain("'EB Garamond'");
    expect(css).toContain("'Noto Serif SC'");
    expect(css).toContain("'JetBrains Mono'");
    expect(css).not.toContain("Inter");
  });

  it("rewrites relative font urls to absolute file:// urls under themes/fonts", () => {
    const css = buildFontInjectionCss({ themesDir });
    const fontsDirUrl = pathToFileURL(path.join(themesDir, "fonts")).href;
    expect(css).toContain(`url('${fontsDirUrl}/ebgaramond-aaa.woff2')`);
    expect(css).toContain(`url('${fontsDirUrl}/notoserifsc-bbb.woff2')`);
    expect(css).not.toContain("url('./fonts/");
  });

  it("preserves unicode-range and other descriptors verbatim", () => {
    const css = buildFontInjectionCss({ themesDir });
    expect(css).toContain("unicode-range: U+0000-00FF, U+2000-206F;");
    expect(css).toContain("unicode-range: U+4E00-9FFF;");
    expect(css).toContain("font-display: swap;");
  });

  it("fails loudly when a required family is missing from the css", () => {
    const withoutSerif = SAMPLE_CSS.replace(/'Noto Serif SC'/g, "'Some Other Font'");
    fs.writeFileSync(path.join(themesDir, FONTS_CSS), withoutSerif, "utf-8");
    expect(() => buildFontInjectionCss({ themesDir })).toThrow(/Noto Serif SC/);
  });

  it("exposes the family whitelist as the single source for callers and tests", () => {
    expect(HANA_PDF_FONT_FAMILIES).toEqual(["EB Garamond", "Noto Serif SC", "JetBrains Mono"]);
  });

  it("fails loudly when a selected font file is missing", () => {
    fs.unlinkSync(path.join(themesDir, "fonts", "notoserifsc-bbb.woff2"));
    expect(() => buildFontInjectionCss({ themesDir })).toThrow(/missing font file.*notoserifsc-bbb\.woff2/i);
  });

  it("fails loudly when a selected font file is empty", () => {
    fs.writeFileSync(path.join(themesDir, "fonts", "jetbrainsmono-ccc.woff2"), Buffer.alloc(0));
    expect(() => assertOfficePdfFontAssets({ themesDir })).toThrow(/not a non-empty file.*jetbrainsmono-ccc\.woff2/i);
  });

  it("rejects selected font urls that escape themes/fonts", () => {
    const escapedCss = SAMPLE_CSS.replace(
      "./fonts/ebgaramond-aaa.woff2",
      "./fonts/../escaped.woff2",
    );
    fs.writeFileSync(path.join(themesDir, FONTS_CSS), escapedCss, "utf-8");
    fs.writeFileSync(path.join(themesDir, "escaped.woff2"), Buffer.from("wOF2fixture"));
    expect(() => buildFontInjectionCss({ themesDir })).toThrow(/outside themes\/fonts.*EB Garamond/i);
  });

  describe("locateThemesDir", () => {
    it("returns the first candidate containing the fonts css", () => {
      const empty = path.join(tempDir, "empty");
      fs.mkdirSync(empty, { recursive: true });
      expect(locateThemesDir([empty, themesDir])).toBe(themesDir);
      expect(locateThemesDir([themesDir, empty])).toBe(themesDir);
    });

    it("fails loudly when no candidate has the fonts css", () => {
      const empty = path.join(tempDir, "empty");
      fs.mkdirSync(empty, { recursive: true });
      expect(() => locateThemesDir([empty])).toThrow(/new-warm-paper-fonts\.css/);
    });
  });

  describe("resolveThemesDir", () => {
    it("uses HANA_RENDERER_DIST/themes as the authoritative production source", () => {
      const fallbackDir = path.join(tempDir, "fallback", "themes");
      fs.mkdirSync(fallbackDir, { recursive: true });
      fs.writeFileSync(path.join(fallbackDir, FONTS_CSS), SAMPLE_CSS, "utf-8");

      expect(resolveThemesDir({
        env: { HANA_RENDERER_DIST: tempDir },
        fallbackCandidates: [fallbackDir],
      })).toBe(themesDir);
    });

    it("rejects a relative HANA_RENDERER_DIST", () => {
      expect(() => resolveThemesDir({
        env: { HANA_RENDERER_DIST: path.join("relative", "renderer") },
        fallbackCandidates: [themesDir],
      })).toThrow(/HANA_RENDERER_DIST must be an absolute path/);
    });

    it("rejects an explicitly empty HANA_RENDERER_DIST instead of treating it as absent", () => {
      expect(() => resolveThemesDir({
        env: { HANA_RENDERER_DIST: "" },
        fallbackCandidates: [themesDir],
      })).toThrow(/HANA_RENDERER_DIST must be an absolute path/);
    });

    it("does not fall back when the injected renderer is missing its font css", () => {
      const brokenRenderer = path.join(tempDir, "broken-renderer");
      expect(() => resolveThemesDir({
        env: { HANA_RENDERER_DIST: brokenRenderer },
        fallbackCandidates: [themesDir],
      })).toThrow(new RegExp(`HANA_RENDERER_DIST.*${FONTS_CSS.replace(".", "\\.")}`, "s"));
    });

    it("uses development and legacy candidates only when no renderer is injected", () => {
      const empty = path.join(tempDir, "empty");
      fs.mkdirSync(empty, { recursive: true });
      expect(resolveThemesDir({ env: {}, fallbackCandidates: [empty, themesDir] })).toBe(themesDir);
    });
  });

  describe("real font source integrity", () => {
    it("extracts all three Hana families and resolves every real woff2 file", () => {
      const realThemesDir = path.join(__dirname, "..", "desktop", "src", "themes");
      const css = buildFontInjectionCss({ themesDir: realThemesDir });
      for (const family of HANA_PDF_FONT_FAMILIES) {
        expect(css).toContain(`'${family}'`);
      }
      expect(css).toContain("unicode-range:");
      expect(css).not.toContain("url('./fonts/");
      expect(css).not.toContain("Inter");

      const fontUrls = new Set(
        Array.from(css.matchAll(/url\('([^']+)'\)/g), (match) => match[1]),
      );
      expect(fontUrls.size).toBeGreaterThan(0);
      for (const fontUrl of fontUrls) {
        const fontPath = fileURLToPath(fontUrl);
        const stat = fs.statSync(fontPath);
        expect(stat.isFile(), fontPath).toBe(true);
        expect(stat.size, fontPath).toBeGreaterThan(0);
        expect(fs.readFileSync(fontPath).subarray(0, 4).toString("ascii"), fontPath).toBe("wOF2");
      }
    });
  });

});
