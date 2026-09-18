import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { extractDocument } from "../lib/document-extract/index.ts";
import type { ExtractFailure } from "../lib/document-extract/types.ts";

// 这一组用真实的转换库跑真实的样本文件，验证"喂进去一份文档，出来一段能读的 Markdown"。
// 断言只看属性（该出现的文字、该出现的表格分隔符），不做快照对比：转换库还在 0.x，
// 输出的排版细节随时会变，快照会天天假红。
//
// 样本由 tests/fixtures/document-extract/generate.mjs 生成。

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "document-extract");

function fixture(name: string) {
  return path.join(fixtureDir, name);
}

describe("document extract against real files", () => {
  it("turns a docx into markdown headings, bold text and a table", async () => {
    const result = await extractDocument({ filePath: fixture("sample.docx") });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("docx");
    expect(result.markdown).toMatch(/^#+\s+Quarterly Notes/m);
    expect(result.markdown).toContain("**bold**");
    expect(result.markdown).toContain("|");
    expect(result.markdown).toContain("Region");
    expect(result.markdown).toContain("120");
  });

  it("turns an xlsx sheet into markdown carrying the cell values", async () => {
    const result = await extractDocument({ filePath: fixture("sample.xlsx") });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("xlsx");
    expect(result.markdown).toContain("Region");
    expect(result.markdown).toContain("North");
    expect(result.markdown).toContain("120");
  });

  it("turns a csv into markdown carrying the cell values", async () => {
    const result = await extractDocument({ filePath: fixture("sample.csv") });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain("Region");
    expect(result.markdown).toContain("South");
    expect(result.markdown).toContain("95");
  });

  it("reads the text layer out of a text PDF", async () => {
    const result = await extractDocument({ filePath: fixture("sample-text.pdf") });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("pdf");
    expect(result.markdown).toContain("Hello from PDF");
    expect(result.markdown).toContain("Second line of text");
  });

  it("reports a PDF that only contains an image as needing OCR", async () => {
    // 这份样本只有一张图、没有任何文字算子。转换库对这种文件报的错误文案要以实际运行为准，
    // 归类规则（见 lib/document-extract/index.ts 的错误映射）可能需要按实测文案调整。
    const result = await extractDocument({ filePath: fixture("sample-scanned.pdf") });

    // 测试项目关掉了 strictNullChecks，失败分支不会被自动收窄，所以先断言再显式定型。
    expect(result.ok).toBe(false);
    expect((result as ExtractFailure).reason).toBe("scanned-pdf");
  });

  it("accepts raw bytes as well as a file path", async () => {
    const { readFile } = await import("fs/promises");
    const buffer = await readFile(fixture("sample.csv"));

    const result = await extractDocument({ buffer, filename: "sample.csv" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain("North");
  });
});
