/**
 * style-discipline.mjs — 可递减、不可新增的样式债务扫描
 *
 * 三个维度（经用户校准 2026-07-07）：
 *   bare-spacing   padding/margin/gap 族里的裸 px（0 除外；calc 含 var 视为网格补偿豁免）
 *   hardcoded-color 非主题 CSS 里的 #hex / rgb()/rgba() 字面量（var() fallback 位豁免）
 *   bare-duration  transition/animation 里的字面量时长（0s 豁免）
 *
 * 基线语义"只减不增"：tests/style-discipline-baseline.json 是灰名单，
 * 契约测试断言逐文件逐维度 计数 ≤ 基线；基线外文件必须为 0。
 * 有意收账后运行 `node scripts/style-discipline.mjs --update-baseline` 下调基线。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 立法（2026-07-09 样式立法⑤收尾）：custom property 定义行（`--x: ...`）是
 * 字面量的唯一合法归宿——立法就是把散落字面量收进定义行，若扫描器把定义行
 * 也计为违例，每次立法都会顶高 styles.css / mobile-entry.css 的基线，
 * "只减不增"棘轮失真。故定义行与 themes/ 同机制排除出扫描域。
 * 只剥声明（锚定在 `{`/`;` 之后），`var(--x, fallback)` 引用位不受影响。
 */
export function stripCustomPropertyDeclarations(src) {
  return src.replace(/(^|[;{])(\s*)--[\w-]+\s*:[^;}]*/g, "$1$2");
}

const SPACING_PROP = /(?:^|[\s;{])((?:padding|margin)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|gap|row-gap|column-gap)\s*:\s*([^;}]+)/g;

export function findBareSpacing(css) {
  const hits = [];
  for (const m of css.matchAll(SPACING_PROP)) {
    const property = m[1];
    const value = m[2].trim();
    // calc 含 var：网格补偿（如 calc(var(--r) - 1px)）豁免整条
    if (/calc\([^)]*var\(/.test(value)) continue;
    // 去掉 var(...) 段后再找 px 字面量，避免 fallback 位误报
    const stripped = value.replace(/var\([^)]*\)/g, "");
    if (/(?<![\w.])(?!0px)\d*\.?\d+px/.test(stripped)) hits.push({ property, value });
  }
  return hits;
}

export function findHardcodedColors(css) {
  const hits = [];
  // 先剥掉 var() 整段（含 fallback），剩余里的色字面量都算违例
  const stripped = css.replace(/var\([^)]*\)/g, "");
  for (const m of stripped.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([0-9,./%\s]+\)/g)) {
    hits.push({ literal: m[0] });
  }
  return hits;
}

export function findBareDurations(css) {
  const hits = [];
  for (const m of css.matchAll(/(?:^|[\s;{])(transition|animation)(?:-[a-z-]+)?\s*:\s*([^;}]+)/g)) {
    const stripped = m[2].replace(/var\([^)]*\)/g, "");
    for (const d of stripped.matchAll(/(?<![\w.])(\d*\.?\d+)(m?s)\b/g)) {
      if (parseFloat(d[1]) === 0) continue; // 0s 禁用动画的惯用法豁免
      hits.push({ property: m[1], literal: `${d[1]}${d[2]}` });
    }
  }
  return hits;
}

const CSS_ROOT = path.join(process.cwd(), "desktop", "src");
const THEME_DIR = path.sep + path.join("desktop", "src", "themes") + path.sep;
const BASELINE_PATH = path.join(process.cwd(), "tests", "style-discipline-baseline.json");

export function collectCssFiles(root = CSS_ROOT) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "dist") walk(full); }
      else if (e.name.endsWith(".css") && !full.includes(THEME_DIR)) out.push(full);
    }
  })(root);
  return out.sort();
}

export function scan(root = CSS_ROOT) {
  const result = {};
  for (const file of collectCssFiles(root)) {
    const css = stripCustomPropertyDeclarations(stripCssComments(fs.readFileSync(file, "utf-8")));
    const rel = path.relative(process.cwd(), file).split(path.sep).join("/");
    const counts = {
      "bare-spacing": findBareSpacing(css).length,
      "hardcoded-color": findHardcodedColors(css).length,
      "bare-duration": findBareDurations(css).length,
    };
    if (Object.values(counts).some(v => v > 0)) result[rel] = counts;
  }
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = scan();
  if (process.argv.includes("--update-baseline")) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(result, null, 2) + "\n");
    console.log(`baseline updated: ${BASELINE_PATH}`);
  } else if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    let total = 0;
    for (const [file, counts] of Object.entries(result)) {
      const line = Object.entries(counts).filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`).join(" ");
      total += Object.values(counts).reduce((a, b) => a + b, 0);
      console.log(`${file}: ${line}`);
    }
    console.log(`total violations: ${total}`);
  }
}
