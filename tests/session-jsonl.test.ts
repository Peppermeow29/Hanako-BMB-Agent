import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionMessages } from "../lib/session-jsonl.ts";

describe("readSessionMessages active branch", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeEntries(entries: any[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-jsonl-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "session.jsonl");
    fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return filePath;
  }

  it("returns only root-to-current-leaf messages from an append-only branched file", () => {
    const filePath = writeEntries([
      { type: "session", version: 3, id: "header", timestamp: "2026-07-19T00:00:00.000Z", cwd: "/work" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-07-19T00:00:01.000Z", message: { role: "user", content: "root" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-19T00:00:02.000Z", message: { role: "assistant", content: "root answer" } },
      { type: "message", id: "u-old", parentId: "a1", timestamp: "2026-07-19T00:00:03.000Z", message: { role: "user", content: "abandoned user" } },
      { type: "message", id: "a-old", parentId: "u-old", timestamp: "2026-07-19T00:00:04.000Z", message: { role: "assistant", content: "abandoned answer" } },
      { type: "custom", customType: "hana-message-presentation", data: {}, id: "p2", parentId: "a1", timestamp: "2026-07-19T00:00:05.000Z" },
      { type: "message", id: "u2", parentId: "p2", timestamp: "2026-07-19T00:00:06.000Z", message: { role: "user", content: "active user" } },
      { type: "message", id: "a2", parentId: "u2", timestamp: "2026-07-19T00:00:07.000Z", message: { role: "assistant", content: "active answer" } },
    ]);

    expect(readSessionMessages(filePath)).toEqual({
      messages: [
        { role: "user", content: "root", timestamp: "2026-07-19T00:00:01.000Z" },
        { role: "assistant", content: "root answer", timestamp: "2026-07-19T00:00:02.000Z" },
        { role: "user", content: "active user", timestamp: "2026-07-19T00:00:06.000Z" },
        { role: "assistant", content: "active answer", timestamp: "2026-07-19T00:00:07.000Z" },
      ],
      lastTimestamp: "2026-07-19T00:00:07.000Z",
    });
  });

  it("reads the full parent chain even when the abandoned tail makes the file larger than the old tail window", () => {
    const hugeAbandonedText = "x".repeat(300 * 1024);
    const filePath = writeEntries([
      { type: "session", version: 3, id: "header", timestamp: "2026-07-19T00:00:00.000Z", cwd: "/work" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-07-19T00:00:01.000Z", message: { role: "user", content: "root" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-19T00:00:02.000Z", message: { role: "assistant", content: "root answer" } },
      { type: "message", id: "u-old", parentId: "a1", timestamp: "2026-07-19T00:00:03.000Z", message: { role: "user", content: hugeAbandonedText } },
      { type: "message", id: "u2", parentId: "a1", timestamp: "2026-07-19T00:00:04.000Z", message: { role: "user", content: "active" } },
      { type: "message", id: "a2", parentId: "u2", timestamp: "2026-07-19T00:00:05.000Z", message: { role: "assistant", content: "active answer" } },
    ]);

    const result = readSessionMessages(filePath);

    expect(result.messages.map((message) => message.content)).toEqual([
      "root",
      "root answer",
      "active",
      "active answer",
    ]);
    expect(JSON.stringify(result)).not.toContain(hugeAbandonedText.slice(0, 100));
  });

  it("applies since after resolving the active branch and keeps legacy linear files readable", () => {
    const filePath = writeEntries([
      { type: "message", timestamp: "2026-07-19T00:00:01.000Z", message: { role: "user", content: "old" } },
      { type: "message", timestamp: "2026-07-19T00:00:03.000Z", message: { role: "assistant", content: "new" } },
    ]);

    expect(readSessionMessages(filePath, { since: "2026-07-19T00:00:02.000Z" })).toEqual({
      messages: [{ role: "assistant", content: "new", timestamp: "2026-07-19T00:00:03.000Z" }],
      lastTimestamp: "2026-07-19T00:00:03.000Z",
    });
  });
});
