import { describe, expect, it } from "vitest";
import {
  stripCssComments,
  stripCustomPropertyDeclarations,
  findBareSpacing,
  findHardcodedColors,
  findBareDurations,
  scan,
} from "../scripts/style-discipline.mjs";
import baseline from "./style-discipline-baseline.json";

describe("style-discipline matchers", () => {
  it("strips comments before matching", () => {
    expect(findBareSpacing(stripCssComments("/* padding: 7px */ .a { gap: var(--space-8); }"))).toEqual([]);
  });

  it("flags bare px in spacing props, spares 0 / var() / calc-with-var", () => {
    const css = `.a { padding: 8px 0; margin-top: 7px; gap: var(--space-4);
      margin-bottom: calc(var(--r) - 1px); padding-left: 0; }`;
    const hits = findBareSpacing(css);
    expect(hits).toEqual([
      { property: "padding", value: "8px 0" },
      { property: "margin-top", value: "7px" },
    ]);
  });

  it("flags hex and rgb/rgba literals, spares var() fallback usage", () => {
    const css = `.a { color: #3B3D3F; background: rgba(0, 0, 0, 0.05);
      border-color: var(--overlay-medium, rgba(0, 0, 0, 0.16)); box-shadow: 0 1px 0 #fff; }`;
    const hits = findHardcodedColors(css);
    expect(hits.map(h => h.literal)).toEqual(["#3B3D3F", "rgba(0, 0, 0, 0.05)", "#fff"]);
  });

  it("flags literal durations in transition/animation, spares var(--duration-*) and 0s", () => {
    const css = `.a { transition: opacity var(--duration-fast) var(--ease-out), width 0.16s;
      animation: spin 0.8s linear; transition-delay: 0s; }`;
    const hits = findBareDurations(css);
    expect(hits.map(h => h.literal)).toEqual(["0.16s", "0.8s"]);
  });

  /**
   * 立法（2026-07-09 样式立法⑤收尾）：token 定义行（`--x: ...`）是字面量的唯一
   * 合法归宿——立法本身就是把散落字面量收进定义行，扫描器再把定义行计为违例，
   * 会导致每次立法都顶高 styles.css / mobile-entry.css 基线，"只减不增"棘轮失真。
   * 故定义行与 themes/ 同机制排除出扫描域；var() 引用位不受影响照常扫描。
   */
  it("strips custom property declaration lines (token 定义行豁免), keeps usages", () => {
    const css = `:root { --scrim-15: rgba(0, 0, 0, 0.15); --shadow-md: 0 2px 8px rgba(0, 0, 0, 0.08);
      --duration-slowish: 0.16s; --space-13: 13px; }
    .a { background: rgba(0, 0, 0, 0.3); --local-ink: #3B3D3F; color: #abc;
      padding: 7px; transition: width 0.16s; }`;
    const stripped = stripCustomPropertyDeclarations(css);
    expect(findHardcodedColors(stripped).map(h => h.literal)).toEqual(["rgba(0, 0, 0, 0.3)", "#abc"]);
    expect(findBareSpacing(stripped)).toEqual([{ property: "padding", value: "7px" }]);
    expect(findBareDurations(stripped).map(h => h.literal)).toEqual(["0.16s"]);
  });

  it("custom property stripping leaves var() references untouched", () => {
    const css = `.a { color: var(--text, #333); box-shadow: var(--shadow-md); }`;
    expect(stripCustomPropertyDeclarations(css)).toBe(css);
  });
});

describe("style-discipline ratchet (只减不增)", () => {
  const current = scan();

  it("no file exceeds its baseline count in any dimension", () => {
    const regressions: string[] = [];
    for (const [file, counts] of Object.entries(current)) {
      const base = (baseline as Record<string, Record<string, number>>)[file] ?? {};
      for (const [dim, n] of Object.entries(counts)) {
        const allowed = base[dim] ?? 0;
        if (n > allowed) regressions.push(`${file} ${dim}: ${n} > baseline ${allowed}`);
      }
    }
    expect(
      regressions,
      `新增风格违例（新代码必须走 token；存量收账后跑 --update-baseline 下调基线）：\n  ${regressions.join("\n  ")}`,
    ).toEqual([]);
  });

  it("baseline has no stale entries far above reality (提示收账后下调)", () => {
    // 软契约：基线比现实高说明收过账没更新基线。不红，只在 console 提示。
    const stale: string[] = [];
    for (const [file, base] of Object.entries(baseline as Record<string, Record<string, number>>)) {
      const cur = current[file] ?? {};
      for (const [dim, allowed] of Object.entries(base)) {
        const n = (cur as Record<string, number>)[dim] ?? 0;
        if (n < allowed) stale.push(`${file} ${dim}: ${n} < baseline ${allowed}`);
      }
    }
    if (stale.length) console.warn(`[style-discipline] 基线可下调：\n  ${stale.join("\n  ")}`);
    expect(true).toBe(true);
  });
});
