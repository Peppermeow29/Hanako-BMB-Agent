/**
 * css-token-references.test.ts
 *
 * 结构 token 的"引用即定义"守卫：desktop/src 下所有 CSS 里，凡是**不带 fallback**
 * 引用结构 token 家族（--space/--fs/--radius/--duration/--ease）的 var()，
 * 该 token 必须在 desktop/src 的某个 CSS 里有定义。
 *
 * 背景：DESIGN.md 曾用与实现脱节的命名（--space-lg/--space-md 等语义五档，实现是
 * 数字九档），污染出两处失效引用（styles.css 右键格式栏）——var() 引用未定义 token
 * 且无 fallback 时整条声明静默失效，肉眼几乎不可察觉。
 *
 * 带 fallback 的引用（如 var(--radius-input, 6px)）是合法的主题可覆写模式，不检查。
 * 注意：定义集是全库聚合（含 mobile-entry.css / themes），跨入口的遮蔽不在本守卫
 * 范围内；它只保证"名字拼对了、家族里真有这个 token"。
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const FAMILY = "(?:space|fs|radius|duration|ease)";

function walkCssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walkCssFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      out.push(full);
    }
  }
  return out;
}

describe("css structural token references", () => {
  it("every no-fallback reference to --space/--fs/--radius/--duration/--ease resolves to a definition", () => {
    const root = path.join(process.cwd(), "desktop", "src");
    const files = walkCssFiles(root);
    expect(files.length).toBeGreaterThan(10);

    const defined = new Set<string>();
    const refs: { file: string; name: string }[] = [];

    const defRe = new RegExp(`--(${FAMILY}-[a-zA-Z0-9-]+)\\s*:`, "g");
    const refRe = new RegExp(`var\\(\\s*--(${FAMILY}-[a-zA-Z0-9-]+)\\s*([,)])`, "g");

    for (const file of files) {
      // 注释里合法地会提到 token 名（修复记录、文档），只扫生效代码
      const src = fs.readFileSync(file, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of src.matchAll(defRe)) defined.add(m[1]);
      for (const m of src.matchAll(refRe)) {
        if (m[2] === ")") {
          refs.push({ file: path.relative(process.cwd(), file), name: m[1] });
        }
      }
    }

    expect(refs.length).toBeGreaterThan(100); // 家族引用量级 sanity check，防 regex 失配空转

    const dangling = refs.filter((r) => !defined.has(r.name));
    expect(
      dangling,
      `发现无 fallback 且未定义的结构 token 引用（声明会静默失效）：\n${dangling
        .map((r) => `  ${r.file}: var(--${r.name})`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
