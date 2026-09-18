import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";

import { execute as readDocument, parameters as readDocumentParameters } from "../plugins/office/tools/read-document.ts";
import { execute as listCapabilities } from "../plugins/office/tools/list-capabilities.ts";
import { renderHtmlToPdf } from "../plugins/office/lib/html-to-pdf.ts";
import { isOfficeEnabledForAgentConfig } from "../plugins/office/lib/availability.ts";

function escapePdfText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function makeTextPdf(pages: string[]) {
  const objects = [];
  const pageObjectIds = pages.map((_, index) => 4 + index * 2);
  const contentObjectIds = pages.map((_, index) => 5 + index * 2);

  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  for (let index = 0; index < pages.length; index += 1) {
    const pageId = pageObjectIds[index];
    const contentId = contentObjectIds[index];
    objects[pageId - 1] = [
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]",
      "/Resources << /Font << /F1 3 0 R >> >>",
      `/Contents ${contentId} 0 R >>`,
    ].join(" ");

    const lines = pages[index].split("\n");
    const commands = [
      "BT",
      "/F1 18 Tf",
      "72 720 Td",
      ...lines.flatMap((line, lineIndex) => [
        lineIndex === 0 ? "" : "0 -24 Td",
        `(${escapePdfText(line)}) Tj`,
      ]).filter(Boolean),
      "ET",
    ].join("\n");
    objects[contentId - 1] = `<< /Length ${Buffer.byteLength(commands, "utf-8")} >>\nstream\n${commands}\nendstream`;
  }

  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(chunks.join(""), "utf-8"));
    chunks.push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(""), "utf-8");
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push("0000000000 65535 f \n");
  for (const offset of offsets.slice(1)) {
    chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return chunks.join("");
}

describe("office plugin tools", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-office-plugin-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports Office capabilities without side effects", async () => {
    const result = await listCapabilities();

    expect(result.content[0].text).toContain("Office tools are available");
    expect(result.details.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "read-document",
        tool: "office_read-document",
        supportedInputs: expect.arrayContaining([".pdf", ".xlsm"]),
      }),
      expect.objectContaining({ id: "html-to-pdf", tool: "office_html-to-pdf" }),
    ]));
  });

  it("is enabled by default and follows the per-agent office toggle", () => {
    expect(isOfficeEnabledForAgentConfig({})).toBe(true);
    expect(isOfficeEnabledForAgentConfig({ tools: { disabled: [] } })).toBe(true);
    expect(isOfficeEnabledForAgentConfig({ tools: { disabled: ["office"] } })).toBe(false);
  });

  it("keeps read-document parameters compatible with Moonshot/Kimi root schema rules", () => {
    expect(readDocumentParameters).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        resource: expect.objectContaining({ type: "object" }),
        filePath: expect.objectContaining({ type: "string" }),
      }),
    });
    expect(readDocumentParameters).not.toHaveProperty("anyOf");
    expect(readDocumentParameters).not.toHaveProperty("required");
  });

  it("validates missing read-document input at runtime", async () => {
    const result = await readDocument({});

    expect(result.content[0].text).toContain("office_read-document requires resource or filePath");
    expect(result.details.error).toMatchObject({
      code: "OFFICE_READ_FAILED",
      message: "office_read-document requires resource or filePath",
    });
  });

  it("reads xlsx workbooks as structured JSON", async () => {
    const filePath = path.join(tempDir, "report.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Summary");
    sheet.addRow(["Name", "Value"]);
    sheet.addRow(["Revenue", 42]);
    await workbook.xlsx.writeFile(filePath);

    const result = await readDocument({ filePath, outputFormat: "json" });

    expect(result.details.office.kind).toBe("xlsx");
    expect(result.details.office.workbook.sheets[0]).toMatchObject({
      name: "Summary",
      rows: [
        ["Name", "Value"],
        ["Revenue", "42"],
      ],
    });
    expect(result.content[0].text).toContain('"sheetCount": 1');
  });

  it("reads documents from ResourceIO refs by materializing through plugin resources", async () => {
    const filePath = path.join(tempDir, "resource-note.md");
    fs.writeFileSync(filePath, "hello from resource ref", "utf-8");
    const materialize = vi.fn(async () => ({
      filePath,
      resourceKey: "mount:docs/resource-note.md",
      resource: { kind: "mount", mountId: "docs", path: "resource-note.md" },
    }));

    const result = await readDocument({
      resource: { kind: "mount", mountId: "docs", path: "resource-note.md" },
    }, {
      resources: { materialize },
    });

    expect(materialize).toHaveBeenCalledWith({ kind: "mount", mountId: "docs", path: "resource-note.md" });
    expect(result.content[0].text).toContain("hello from resource ref");
    expect(result.details.office).toMatchObject({
      filePath,
      resourceKey: "mount:docs/resource-note.md",
    });
  });

  it("declares ResourceIO materialize/read capabilities for Office document reads", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "plugins", "office", "manifest.json"), "utf-8"));

    expect(manifest.capabilities).toEqual(expect.arrayContaining([
      "resource.read",
      "resource.materialize",
    ]));
  });

  it("reads xlsm workbooks through the same structured workbook path", async () => {
    const filePath = path.join(tempDir, "macro-report.xlsm");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("MacroData");
    sheet.addRow(["Name", "Value"]);
    sheet.addRow(["Approved", true]);
    await workbook.xlsx.writeFile(filePath);

    const result = await readDocument({ filePath, outputFormat: "json" });

    expect(result.details.office).toMatchObject({
      ext: ".xlsm",
      kind: "xlsx",
      format: "json",
    });
    expect(result.details.office.workbook.sheets[0]).toMatchObject({
      name: "MacroData",
      rows: [
        ["Name", "Value"],
        ["Approved", "true"],
      ],
    });
  });

  it("reads selected PDF pages as Markdown with pagination metadata", async () => {
    const filePath = path.join(tempDir, "travel.pdf");
    fs.writeFileSync(filePath, makeTextPdf([
      "Opening page alpha",
      "Second page beta\nE = mc^2",
    ]), "utf-8");

    const result = await readDocument({ filePath, pageRange: "2", maxChars: 2000 });

    expect(result.details.office).toMatchObject({
      kind: "pdf",
      format: "markdown",
      totalPages: 2,
      pages: [2],
      truncated: false,
    });
    expect(result.content[0].text).toContain("## Page 2");
    expect(result.content[0].text).toContain("Second page beta");
    expect(result.content[0].text).toContain("E = mc^2");
    expect(result.content[0].text).not.toContain("Opening page alpha");
    expect(result.details.office.warnings).toEqual(expect.arrayContaining(["math_may_be_degraded"]));
  });

  it("stops long PDF reads at page boundaries and reports the next page range", async () => {
    const filePath = path.join(tempDir, "long.pdf");
    fs.writeFileSync(filePath, makeTextPdf([
      "Page one ".repeat(30),
      "Page two ".repeat(30),
      "Page three ".repeat(30),
    ]), "utf-8");

    const result = await readDocument({ filePath, maxChars: 100 });

    expect(result.details.office).toMatchObject({
      kind: "pdf",
      totalPages: 3,
      pages: [1],
      truncated: true,
      nextPageRange: "2-3",
    });
    expect(result.content[0].text).toContain("## Page 1");
    expect(result.content[0].text).toContain("[PDF read truncated at page 1; continue with pageRange=\"2-3\".]");
    expect(result.content[0].text).not.toContain("## Page 2");
  });

  it("continues long PDF reads after the maxPages window", async () => {
    const filePath = path.join(tempDir, "many-pages.pdf");
    fs.writeFileSync(filePath, makeTextPdf([
      "Page one",
      "Page two",
      "Page three",
      "Page four",
    ]), "utf-8");

    const result = await readDocument({ filePath, maxPages: 2, maxChars: 2000 });

    expect(result.details.office).toMatchObject({
      kind: "pdf",
      totalPages: 4,
      pages: [1, 2],
      truncated: true,
      nextPageRange: "3-4",
      totalRequestedPages: 4,
    });
    expect(result.content[0].text).toContain("## Page 1");
    expect(result.content[0].text).toContain("## Page 2");
    expect(result.content[0].text).toContain("[PDF read truncated at page 2; continue with pageRange=\"3-4\".]");
  });

  it("reports image-only PDFs as unsupported without OCR fallback", async () => {
    const filePath = path.join(tempDir, "blank.pdf");
    fs.writeFileSync(filePath, makeTextPdf([""]), "utf-8");

    const result = await readDocument({ filePath });

    expect(result.details.error).toMatchObject({
      code: "OFFICE_READ_FAILED",
      message: expect.stringContaining("no extractable text"),
    });
    expect(result.content[0].text).toContain("OCR is not supported");
  });

  it("renders HTML to PDF through the desktop helper contract and stages the output", async () => {
    let observedCommand = null;
    let observedJob = null;
    let observedSpawnOptions = null;
    const fakeSpawn = vi.fn((command, args, options) => {
      observedCommand = { command, args };
      observedSpawnOptions = options;
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        const jobPath = args.at(-1);
        const job = JSON.parse(fs.readFileSync(jobPath, "utf-8"));
        observedJob = job;
        fs.mkdirSync(path.dirname(job.outputPath), { recursive: true });
        fs.writeFileSync(job.outputPath, "%PDF-1.4\n% office test\n", "utf-8");
        child.emit("close", 0);
      });
      return child;
    });
    const stageFile = vi.fn(({ sessionPath, filePath, label }) => ({
      file: { fileId: "sf_pdf", sessionPath, filePath, label },
      mediaItem: { type: "session_file", fileId: "sf_pdf", sessionPath, filePath, label },
    }));
    const rendererDist = path.join(tempDir, "active-renderer");
    const helperEnv = {
      HANA_DESKTOP_EXEC_PATH: "/Applications/HanaAgent.app/Contents/MacOS/HanaAgent",
      HANA_DESKTOP_IS_PACKAGED: "1",
      HANA_RENDERER_DIST: rendererDist,
      ELECTRON_RUN_AS_NODE: "1",
      OFFICE_TEST_MARKER: "preserved",
    };

    const result = await renderHtmlToPdf(
      {
        html: "<!doctype html><style>@page{size:A4}</style><h1>Hello</h1>",
        filename: "hello.pdf",
      },
      {
        dataDir: tempDir,
        sessionPath: "/sessions/office.jsonl",
        stageFile,
      },
      {
        env: helperEnv,
        spawn: fakeSpawn,
      },
    );

    expect(observedCommand).toMatchObject({
      command: "/Applications/HanaAgent.app/Contents/MacOS/HanaAgent",
      args: ["--hana-office-html-to-pdf", expect.stringMatching(/job\.json$/)],
    });
    expect(observedSpawnOptions).toMatchObject({
      env: {
        HANA_RENDERER_DIST: rendererDist,
        OFFICE_TEST_MARKER: "preserved",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(observedSpawnOptions.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(helperEnv.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(fs.readFileSync(result.outputPath, "utf-8")).toContain("%PDF-1.4");
    expect(observedJob).toMatchObject({ embedHanaFonts: true });
    expect(stageFile).toHaveBeenCalledWith({
      sessionPath: "/sessions/office.jsonl",
      filePath: result.outputPath,
      label: "hello.pdf",
    });
    expect(result.mediaItem).toMatchObject({ type: "session_file", fileId: "sf_pdf" });
  });

  it("stages rendered PDF output with sessionId when the path locator is absent", async () => {
    const fakeSpawn = vi.fn((command, args) => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        const jobPath = args.at(-1);
        const job = JSON.parse(fs.readFileSync(jobPath, "utf-8"));
        fs.mkdirSync(path.dirname(job.outputPath), { recursive: true });
        fs.writeFileSync(job.outputPath, "%PDF-1.4\n% office test\n", "utf-8");
        child.emit("close", 0);
      });
      return child;
    });
    const stageFile = vi.fn(({ sessionId, sessionPath, sessionRef, filePath, label }) => ({
      file: { fileId: "sf_pdf", sessionId, sessionPath, sessionRef, filePath, label },
      mediaItem: { type: "session_file", fileId: "sf_pdf", sessionId, sessionPath, sessionRef, filePath, label },
    }));

    const result = await renderHtmlToPdf(
      {
        html: "<!doctype html><h1>Hello</h1>",
        filename: "hello-id.pdf",
      },
      {
        dataDir: tempDir,
        sessionId: "sess_office_pdf",
        sessionRef: { sessionId: "sess_office_pdf" },
        stageFile,
      },
      {
        env: {
          HANA_DESKTOP_EXEC_PATH: "/Applications/HanaAgent.app/Contents/MacOS/HanaAgent",
          HANA_DESKTOP_IS_PACKAGED: "1",
        },
        spawn: fakeSpawn,
      },
    );

    expect(stageFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess_office_pdf",
      sessionRef: { sessionId: "sess_office_pdf" },
      filePath: result.outputPath,
      label: "hello-id.pdf",
    }));
    expect(result.sessionFile).toMatchObject({ fileId: "sf_pdf", sessionId: "sess_office_pdf" });
  });

  it("lets callers opt out of Hana font embedding via embedHanaFonts:false", async () => {
    let observedJob = null;
    const fakeSpawn = vi.fn((command, args) => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        const job = JSON.parse(fs.readFileSync(args.at(-1), "utf-8"));
        observedJob = job;
        fs.mkdirSync(path.dirname(job.outputPath), { recursive: true });
        fs.writeFileSync(job.outputPath, "%PDF-1.4\n% office test\n", "utf-8");
        child.emit("close", 0);
      });
      return child;
    });

    await renderHtmlToPdf(
      { html: "<h1>plain</h1>", embedHanaFonts: false },
      { dataDir: tempDir },
      {
        env: { HANA_DESKTOP_EXEC_PATH: "/usr/local/bin/electron" },
        spawn: fakeSpawn,
      },
    );

    expect(observedJob).toMatchObject({ embedHanaFonts: false });
  });
});
