import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_INPUT_BYTES, extractDocument } from "../lib/document-extract/index.ts";
import type { ExtractFailure, ExtractResult } from "../lib/document-extract/types.ts";

// 测试项目关掉了 strictNullChecks，联合类型的失败分支不会被自动收窄，
// 所以失败断言统一走这里：先真的断言 ok 为 false，再把类型交给编译器。
function expectFailure(result: ExtractResult): ExtractFailure {
  expect(result.ok).toBe(false);
  return result as ExtractFailure;
}

function makeApi(overrides: any = {}) {
  return {
    formatFromBytes: vi.fn(() => null),
    formatFromExtension: vi.fn(() => null),
    toMarkdownBytes: vi.fn(async () => ""),
    ...overrides,
  };
}

function depsFor(api: any) {
  return { loadApi: async () => api };
}

describe("document extract", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeTmpDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-document-extract-"));
    return tmpDir;
  }

  it("falls back to the filename extension when the bytes carry no signature", async () => {
    const api = makeApi({
      formatFromExtension: vi.fn((ext: string) => (ext === "csv" ? "csv" : null)),
      toMarkdownBytes: vi.fn(async () => "| region | total |\n| --- | --- |\n| north | 120 |"),
    });

    const result = await extractDocument(
      { buffer: Buffer.from("region,total\nnorth,120\n", "utf-8"), filename: "quarterly.csv" },
      depsFor(api),
    );

    expect(api.formatFromExtension).toHaveBeenCalledWith("csv");
    expect(result).toMatchObject({ ok: true, format: "csv" });
    if (result.ok) {
      expect(result.markdown).toContain("north");
      expect(result.warnings).toEqual([]);
    }
  });

  it("reports unsupported when neither the bytes nor a filename identify a format", async () => {
    const api = makeApi();

    const result = await extractDocument({ buffer: Buffer.from([0x00, 0x01, 0x02, 0x03]) }, depsFor(api));

    const failure = expectFailure(result);
    expect(failure.reason).toBe("unsupported");
    expect(failure.message).toMatch(/docx/i);
    expect(api.toMarkdownBytes).not.toHaveBeenCalled();
  });

  it("rejects an oversized buffer before touching the converter", async () => {
    const api = makeApi({ formatFromBytes: vi.fn(() => "pdf") });
    const oversized = Buffer.allocUnsafe(MAX_INPUT_BYTES + 1);

    const result = await extractDocument({ buffer: oversized, filename: "huge.pdf" }, depsFor(api));

    const failure = expectFailure(result);
    expect(failure.reason).toBe("too-large");
    expect(failure.message).toContain(String(MAX_INPUT_BYTES + 1));
    expect(failure.message).toContain(String(MAX_INPUT_BYTES));
    expect(api.toMarkdownBytes).not.toHaveBeenCalled();
  });

  it("rejects an oversized file by stat without reading it from disk", async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "huge.pdf");
    const fd = fs.openSync(filePath, "w");
    try {
      fs.ftruncateSync(fd, MAX_INPUT_BYTES + 1);
    } finally {
      fs.closeSync(fd);
    }
    const readFile = vi.spyOn(fs.promises, "readFile");
    const api = makeApi({ formatFromBytes: vi.fn(() => "pdf") });

    const result = await extractDocument({ filePath, filename: "huge.pdf" }, depsFor(api));

    const failure = expectFailure(result);
    expect(failure.reason).toBe("too-large");
    expect(failure.message).toContain(String(MAX_INPUT_BYTES + 1));
    expect(readFile).not.toHaveBeenCalled();
    expect(api.toMarkdownBytes).not.toHaveBeenCalled();
  });

  it("converts a file read from disk and reports the detected format", async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "notes.csv");
    fs.writeFileSync(filePath, "region,total\nnorth,120\n", "utf-8");
    const api = makeApi({
      formatFromExtension: vi.fn(() => "csv"),
      toMarkdownBytes: vi.fn(async () => "| region | total |"),
    });

    const result = await extractDocument({ filePath }, depsFor(api));

    expect(api.formatFromExtension).toHaveBeenCalledWith("csv");
    expect(api.toMarkdownBytes).toHaveBeenCalledWith(expect.anything(), "csv");
    expect(result).toMatchObject({ ok: true, format: "csv" });
  });

  it("maps a scanned-looking PDF failure to the scanned-pdf reason", async () => {
    const api = makeApi({
      formatFromBytes: vi.fn(() => "pdf"),
      toMarkdownBytes: vi.fn(async () => {
        throw new Error("pdf has no text layer: scanned document");
      }),
    });

    const result = await extractDocument({ buffer: Buffer.from("%PDF-1.4"), filename: "scan.pdf" }, depsFor(api));

    const failure = expectFailure(result);
    expect(failure.reason).toBe("scanned-pdf");
    expect(failure.message).toContain("scanned document");
  });

  it("keeps an unrecognized PDF failure as parse-failed with the original message", async () => {
    const api = makeApi({
      formatFromBytes: vi.fn(() => "pdf"),
      toMarkdownBytes: vi.fn(async () => {
        throw new Error("xref table is corrupt at offset 512");
      }),
    });

    const result = await extractDocument({ buffer: Buffer.from("%PDF-1.4"), filename: "broken.pdf" }, depsFor(api));

    const failure = expectFailure(result);
    expect(failure.reason).toBe("parse-failed");
    expect(failure.message).toContain("xref table is corrupt at offset 512");
  });

  it("never reports scanned-pdf for a non-PDF format even when the message looks like one", async () => {
    const api = makeApi({
      formatFromBytes: vi.fn(() => "docx"),
      toMarkdownBytes: vi.fn(async () => {
        throw new Error("scanned image only content, ocr required");
      }),
    });

    const result = await extractDocument({ buffer: Buffer.from("PK"), filename: "report.docx" }, depsFor(api));

    const failure = expectFailure(result);
    expect(failure.reason).toBe("parse-failed");
    expect(failure.message).toContain("ocr required");
  });

  it("treats an empty conversion as success but warns that no text was found", async () => {
    const api = makeApi({
      formatFromBytes: vi.fn(() => "docx"),
      toMarkdownBytes: vi.fn(async () => "   \n  "),
    });

    const result = await extractDocument({ buffer: Buffer.from("PK"), filename: "empty.docx" }, depsFor(api));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.format).toBe("docx");
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.join(" ")).toMatch(/no text/i);
    }
  });

  it("requires either a buffer or a file path", async () => {
    await expect(extractDocument({} as any, depsFor(makeApi()))).rejects.toThrow(/buffer or filePath/i);
  });
});
