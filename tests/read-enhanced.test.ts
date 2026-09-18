import fs from "fs";
import os from "os";
import path from "path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { createEnhancedReadFile } from "../lib/sandbox/read-enhanced.ts";

describe("createEnhancedReadFile xlsx handling", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  async function writeWorkbook(filename, fillSheet) {
    tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "hana-read-enhanced-"));
    const filePath = path.join(tmpDir, filename);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Budget");
    fillSheet(sheet);
    await workbook.xlsx.writeFile(filePath);
    return filePath;
  }

  async function readXlsxText(filePath) {
    const readFile = createEnhancedReadFile();
    const buffer = await readFile(filePath);
    return buffer.toString("utf-8");
  }

  it("preserves useful cell text for small xlsx files", async () => {
    const filePath = await writeWorkbook("small.xlsx", (sheet) => {
      sheet.addRow(["Month", "Spend", "Owner"]);
      sheet.addRow(["June", 42, "Hana"]);
      sheet.addRow(["July", 57, "Mika"]);
    });

    const text = await readXlsxText(filePath);

    expect(text).toContain("[Sheet: Budget]");
    expect(text).toContain("Month");
    expect(text).toContain("June");
    expect(text).toContain("July");
    expect(text).not.toContain("truncated");
  });

  it("keeps later large xlsx rows reachable for read pagination", async () => {
    const filePath = await writeWorkbook("large.xlsx", (sheet) => {
      sheet.addRow(["Key", "Description", "Amount", "Owner"]);
      for (let r = 1; r <= 320; r += 1) {
        sheet.addRow([
          `ROW-${String(r).padStart(3, "0")}`,
          `Detailed budget line ${r} ${"x".repeat(80)}`,
          r * 10,
          `owner-${r}`,
        ]);
      }
    });

    const text = await readXlsxText(filePath);

    expect(text).toContain("[Sheet: Budget]");
    expect(text).toContain("Rows: 321");
    expect(text).toContain("Columns: 4");
    expect(text).toContain("ROW-001");
    expect(text).toContain("ROW-320");
    expect(text).not.toContain("Preview");
    expect(text).not.toContain("[truncated:");
  });
});
