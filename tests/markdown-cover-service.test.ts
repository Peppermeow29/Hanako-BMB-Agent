import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMarkdownCoverFromGeneratedFile } from "../plugins/beautify/lib/markdown-cover-service.ts";

describe("markdown cover service", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cover-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("copies generated cover into the markdown attachment folder and writes cover frontmatter", async () => {
    const notePath = path.join(tmpDir, "note.md");
    const generatedPath = path.join(tmpDir, "generated.png");
    fs.writeFileSync(notePath, "# Title\n\nBody\n", "utf-8");
    fs.writeFileSync(generatedPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await applyMarkdownCoverFromGeneratedFile({
      markdownFilePath: notePath,
      generatedFilePath: generatedPath,
      actualRatio: "16:9",
      pixelWidth: 1600,
      pixelHeight: 900,
      now: new Date("2026-05-26T10:11:12.000Z"),
    });

    const copiedPath = path.join(tmpDir, ...result.cover.image.split("/"));
    expect(fs.existsSync(copiedPath)).toBe(true);
    expect(result.cover).toMatchObject({
      actualRatio: "16:9",
      pixelWidth: 1600,
      pixelHeight: 900,
      displayWidth: 100,
      displayHeight: 320,
      positionX: 50,
      positionY: 50,
    });
    expect(result.cover).not.toHaveProperty("prompt");
    expect(result.cover).not.toHaveProperty("promptPreset");
    expect(result.cover).not.toHaveProperty("preferredRatio");
    expect(result.cover).not.toHaveProperty("generatedAt");
    expect(result.cover).not.toHaveProperty("generator");

    const raw = fs.readFileSync(notePath, "utf-8");
    expect(raw).toContain("cover:");
    expect(raw).toContain("image: ");
    expect(raw).not.toContain("prompt:");
    expect(raw).not.toContain("promptPreset:");
    expect(raw).not.toContain("preferredRatio:");
    expect(raw).not.toContain("generatedAt:");
    expect(raw).not.toContain("generator:");
    expect(raw).toMatch(/\n---\n# Title\n\nBody\n$/);
  });

  it("uses ResourceIO for user resource copy and markdown writes when provided", async () => {
    const notePath = path.join(tmpDir, "note.md");
    const generatedPath = path.join(tmpDir, "generated.png");
    fs.writeFileSync(generatedPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    let writtenMarkdown = "";
    const resourceIO = {
      stat: vi.fn(async (ref) => ({
        exists: true,
        isDirectory: false,
        resourceKey: `local_fs:${ref.path}`,
        resource: ref,
      })),
      read: vi.fn(async () => ({
        content: Buffer.from("# Title\n\nBody\n"),
      })),
      mkdir: vi.fn(async () => ({ changeType: "created" })),
      copy: vi.fn(async () => ({ changeType: "created" })),
      write: vi.fn(async (_ref, content) => {
        writtenMarkdown = String(content);
        return { changeType: "modified" };
      }),
    };

    const result = await applyMarkdownCoverFromGeneratedFile({
      markdownFilePath: notePath,
      generatedFilePath: generatedPath,
      actualRatio: "16:9",
      pixelWidth: 1600,
      pixelHeight: 900,
      now: new Date("2026-05-26T10:11:12.000Z"),
      resourceIO,
      operationContext: {
        source: "plugin",
        reason: "plugin:beautify:cover",
      },
    });

    expect(resourceIO.mkdir).toHaveBeenCalledWith(
      { kind: "local-file", path: path.join(tmpDir, "文本附件") },
      expect.objectContaining({ source: "plugin", reason: "plugin:beautify:cover", emit: false }),
    );
    expect(resourceIO.copy).toHaveBeenCalledWith(
      { kind: "local-file", path: generatedPath },
      { kind: "local-file", path: result.attachmentPath },
      expect.objectContaining({ source: "plugin", reason: "plugin:beautify:cover" }),
    );
    expect(resourceIO.write).toHaveBeenCalledWith(
      { kind: "local-file", path: notePath },
      expect.stringContaining("cover:"),
      expect.objectContaining({ source: "plugin", reason: "plugin:beautify:cover" }),
    );
    expect(writtenMarkdown).toMatch(/\n---\n# Title\n\nBody\n$/);
  });
});
