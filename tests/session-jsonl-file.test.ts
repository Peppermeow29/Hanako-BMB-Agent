import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSessionEntries,
  repairOversizedSessionEntries,
  repairOversizedSessionEntriesInFile,
} from "../core/session-jsonl-file.ts";

describe("session-jsonl-file guards", () => {
  let tempRoot = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it("projects oversized write tool-call args instead of dropping the whole session", () => {
    const hugeContent = "x".repeat(16 * 1024);
    const raw = [
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-06-04T00:00:00.000Z", cwd: "/work" }),
      JSON.stringify({
        id: "u1",
        parentId: null,
        type: "message",
        message: { role: "user", content: "write a file" },
      }),
      JSON.stringify({
        id: "a1",
        parentId: "u1",
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "tc1",
            name: "write",
            arguments: { path: "报告2026.txt", content: hugeContent },
          }],
        },
      }),
    ].join("\n");

    const entries = parseSessionEntries(raw, { maxLineBytes: 1024 });

    expect(entries).toHaveLength(3);
    const args = entries[2].message.content[0].arguments;
    expect(args.path).toBe("报告2026.txt");
    expect(args.content).toMatch(/omitted/);
    expect(JSON.stringify(entries[2])).not.toContain(hugeContent);
  });

  it("preserves visible message text while removing oversized inline media", () => {
    const promptText = [
      "[attached_image: /tmp/a.png]",
      "[attached_image: /tmp/b.png]",
      "请参考这两张图，把手机屏幕里的内容换成新的 UI。",
      "x".repeat(2048),
    ].join("\n");
    const hugeImage = "a".repeat(4096);
    const entries = [
      { type: "session", version: 3, id: "s1", timestamp: "2026-06-21T00:00:00.000Z", cwd: "/work" },
      {
        id: "u1",
        parentId: null,
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: promptText },
            { type: "image", data: hugeImage, mimeType: "image/png" },
            { type: "image", data: hugeImage, mimeType: "image/png" },
          ],
        },
      },
    ];

    const result = repairOversizedSessionEntries(entries, { maxLineBytes: 3000 });

    expect(result.projected).toBe(1);
    const content = result.entries[1].message.content;
    expect(content).toEqual([{ type: "text", text: promptText }]);
    expect(JSON.stringify(result.entries[1])).not.toContain("Hana session JSONL guard");
    expect(JSON.stringify(result.entries[1])).not.toContain(hugeImage);
  });

  it("repairs oversized JSONL lines in place and keeps a repair artifact", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-jsonl-guard-"));
    const sessionPath = path.join(tempRoot, "session.jsonl");
    const hugeContent = "y".repeat(16 * 1024);
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-06-04T00:00:00.000Z", cwd: "/work" }),
      JSON.stringify({
        id: "a1",
        parentId: null,
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "tc1",
            name: "write",
            arguments: { path: "报告2026.txt", content: hugeContent },
          }],
        },
      }),
      "",
    ].join("\n"));

    const result = repairOversizedSessionEntriesInFile(sessionPath, { maxLineBytes: 1024 });

    expect(result.repaired).toBe(true);
    expect(result.projected).toBe(1);
    expect(fs.existsSync(`${sessionPath}.repair.json`)).toBe(true);
    const repairedRaw = fs.readFileSync(sessionPath, "utf-8");
    expect(repairedRaw).not.toContain(hugeContent);
    expect(repairedRaw).toContain("报告2026.txt");
    expect(parseSessionEntries(repairedRaw)).toHaveLength(2);
  });
});
