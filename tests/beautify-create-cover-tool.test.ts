import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../plugins/beautify/tools/create-cover.ts";

describe("beautify create-cover tool", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-beautify-tool-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("only applies an existing image and never calls language or image generation services", async () => {
    const notePath = path.join(tmpDir, "note.md");
    const imagePath = path.join(tmpDir, "generated.png");
    fs.writeFileSync(notePath, "# Note\n\nBody\n", "utf-8");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const request = vi.fn(async () => {
      throw new Error("unexpected bus request");
    });
    const changed = vi.fn();
    const resources = {
      stat: vi.fn(async (ref) => {
        const stat = fs.statSync(ref.path);
        return {
          exists: true,
          isDirectory: stat.isDirectory(),
          resourceKey: `local_fs:${ref.path}`,
          resource: ref,
        };
      }),
      read: vi.fn(async (ref) => ({ content: fs.readFileSync(ref.path) })),
      mkdir: vi.fn(async (ref) => {
        fs.mkdirSync(ref.path, { recursive: true });
        return { changeType: "created", resourceKey: `local_fs:${ref.path}`, resource: ref };
      }),
      copy: vi.fn(async (from, to) => {
        fs.copyFileSync(from.path, to.path);
        return { changeType: "created", resourceKey: `local_fs:${to.path}`, resource: to };
      }),
      write: vi.fn(async (ref, content) => {
        fs.writeFileSync(ref.path, content);
        return { changeType: "modified", resourceKey: `local_fs:${ref.path}`, resource: ref };
      }),
    };
    const result = await execute({
      targetFilePath: notePath,
      generatedFilePath: imagePath,
      pixelWidth: 1536,
      pixelHeight: 1024,
    }, {
      bus: { request, emit: vi.fn() },
      resources,
      resourceEvents: { changed },
      sessionPath: path.join(tmpDir, "session.jsonl"),
    });

    expect(request).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(resources.copy).toHaveBeenCalled();
    expect(resources.write).toHaveBeenCalledWith(
      { kind: "local-file", path: notePath },
      expect.stringContaining("cover:"),
      expect.any(Object),
    );
    expect(result.content[0].text).toContain("已把图片应用为 Markdown cover");
    expect(result.details.beautifyCover.cover).toMatchObject({
      image: expect.stringMatching(/^文本附件\/note-cover-/),
      actualRatio: "3:2",
      pixelWidth: 1536,
      pixelHeight: 1024,
    });

    const raw = fs.readFileSync(notePath, "utf-8");
    expect(raw).toContain("cover:");
    expect(raw).not.toContain("prompt:");
    expect(raw).not.toContain("provider:");
    expect(raw).not.toContain("model:");
  });
});
