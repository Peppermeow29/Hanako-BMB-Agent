import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileTool } from "../lib/tools/file-tool.ts";

describe("file tool extract action", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeTree() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-file-extract-"));
    const workspace = path.join(tmpDir, "workspace");
    const outside = path.join(tmpDir, "elsewhere", "report.docx");
    const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "main.jsonl");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(outside, "PK-docx-bytes");
    fs.writeFileSync(sessionPath, "{}\n");
    const inside = path.join(workspace, "quarterly.docx");
    fs.writeFileSync(inside, "PK-docx-bytes");
    return { workspace, inside, outside, sessionPath };
  }

  function okExtract(markdown: string, format = "docx", warnings: string[] = []) {
    return vi.fn(async () => ({ ok: true, markdown, format, warnings }));
  }

  it("refuses to extract a local path outside the allowed roots", async () => {
    const { workspace, outside, sessionPath } = makeTree();
    const extractDocument = okExtract("# Report");
    const tool = createFileTool({
      getCwd: () => workspace,
      getSessionPath: () => sessionPath,
      extractDocument,
    });

    const result = await tool.execute("file-1", { action: "extract", path: outside });

    expect(result.content[0].text).toMatch(/outside allowed roots/i);
    expect(extractDocument).not.toHaveBeenCalled();
  });

  it("extracts a workspace document into markdown text", async () => {
    const { workspace, inside, sessionPath } = makeTree();
    const extractDocument = okExtract("# Quarterly Notes\n\nNorth grew.", "docx", ["heading level guessed"]);
    const tool = createFileTool({
      getCwd: () => workspace,
      getSessionPath: () => sessionPath,
      extractDocument,
    });

    const result = await tool.execute("file-1", { action: "extract", path: "quarterly.docx" });

    expect(extractDocument).toHaveBeenCalledWith(expect.objectContaining({
      filePath: inside,
      filename: "quarterly.docx",
    }));
    expect(result.content[0].text).toContain("# Quarterly Notes");
    expect(result.details).toMatchObject({
      format: "docx",
      warnings: ["heading level guessed"],
      truncated: false,
      totalChars: "# Quarterly Notes\n\nNorth grew.".length,
    });
  });

  it("extracts a SessionFile that lives outside the workspace", async () => {
    const { workspace, outside, sessionPath } = makeTree();
    const extractDocument = okExtract("# Attached Report");
    const tool = createFileTool({
      getCwd: () => workspace,
      getSessionPath: () => sessionPath,
      resolveSessionFile: vi.fn(() => ({
        id: "sf_doc",
        fileId: "sf_doc",
        sessionPath,
        filePath: outside,
        realPath: outside,
        filename: "report.docx",
        status: "available",
      })),
      extractDocument,
    });

    const result = await tool.execute("file-1", { action: "extract", fileId: "sf_doc" });

    expect(extractDocument).toHaveBeenCalledWith(expect.objectContaining({ filePath: outside }));
    expect(result.content[0].text).toContain("# Attached Report");
  });

  it("returns an explicit error when extraction fails", async () => {
    const { workspace, sessionPath } = makeTree();
    const extractDocument = vi.fn(async () => ({
      ok: false,
      reason: "scanned-pdf",
      message: "no text layer found",
    }));
    const tool = createFileTool({
      getCwd: () => workspace,
      getSessionPath: () => sessionPath,
      extractDocument,
    });

    const result = await tool.execute("file-1", { action: "extract", path: "quarterly.docx" });

    expect(result.content[0].text).toContain("scanned-pdf");
    expect(result.content[0].text).toContain("no text layer found");
  });

  it("truncates oversized markdown and says how much was cut", async () => {
    const { workspace, sessionPath } = makeTree();
    const markdown = "x".repeat(250_000);
    const tool = createFileTool({
      getCwd: () => workspace,
      getSessionPath: () => sessionPath,
      extractDocument: okExtract(markdown, "pdf"),
    });

    const result = await tool.execute("file-1", { action: "extract", path: "quarterly.docx" });

    const text = result.content[0].text;
    expect(text.startsWith("x".repeat(200_000))).toBe(true);
    expect(text).toContain("[Truncated: showing first 200000 chars of 250000]");
    expect(text.length).toBeLessThan(markdown.length);
    expect(result.details).toMatchObject({ truncated: true, totalChars: 250_000, format: "pdf" });
  });
});
