import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  SessionListProjectionCache,
  sessionFileRevision,
} from "../core/session-list-projection-cache.ts";

function writeSessionFile(dir: string, name: string, entries: unknown[]): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return filePath;
}

const HEADER = {
  type: "session",
  id: "sess-1",
  cwd: "/tmp/work",
  timestamp: "2026-06-01T00:00:00.000Z",
};

const USER_MESSAGE = {
  type: "message",
  timestamp: "2026-06-01T00:00:01.000Z",
  message: { role: "user", content: "hello", timestamp: "2026-06-01T00:00:01.000Z" },
};

describe("session-list-projection-cache revision", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-projection-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function tryLinkFile(target: string, linkPath: string): boolean {
    try {
      fs.symlinkSync(target, linkPath, "file");
      return true;
    } catch (error) {
      if (process.platform === "win32" && (error as any)?.code === "EPERM") return false;
      throw error;
    }
  }

  it("exposes the file stat signature as the projection revision", async () => {
    const filePath = writeSessionFile(tmpDir, "a.jsonl", [HEADER, USER_MESSAGE]);
    const stat = fs.statSync(filePath);

    const cache = new SessionListProjectionCache();
    const [projection] = await cache.list(tmpDir);

    expect(projection.revision).toBe(sessionFileRevision(stat));
    expect(projection.revision).toBe(`${stat.size}:${stat.mtimeMs}`);
  });

  it("advances the revision when the session file grows", async () => {
    const filePath = writeSessionFile(tmpDir, "a.jsonl", [HEADER, USER_MESSAGE]);

    const cache = new SessionListProjectionCache();
    const [before] = await cache.list(tmpDir);

    // 模拟 /rc 接管期间 Bridge 侧写入新消息
    fs.appendFileSync(filePath, JSON.stringify({
      type: "message",
      timestamp: "2026-06-01T00:10:00.000Z",
      message: { role: "user", content: "from bridge rc", timestamp: "2026-06-01T00:10:00.000Z" },
    }) + "\n");

    const [after] = await cache.list(tmpDir);

    expect(after.revision).not.toBe(before.revision);
  });

  it("keeps the cached projection revision consistent on cache hits", async () => {
    writeSessionFile(tmpDir, "a.jsonl", [HEADER, USER_MESSAGE]);

    const cache = new SessionListProjectionCache();
    const [first] = await cache.list(tmpDir);
    const [second] = await cache.list(tmpDir);

    expect(second.revision).toBe(first.revision);
  });

  it("keeps firstMessage empty for header-only sessions instead of returning a UI placeholder", async () => {
    writeSessionFile(tmpDir, "empty.jsonl", [HEADER]);

    const cache = new SessionListProjectionCache();
    const [projection] = await cache.list(tmpDir);

    expect(projection.messageCount).toBe(0);
    expect(projection.firstMessage).toBe("");
    expect(projection.allMessagesText).toBe("");
  });

  it("does not expose reminder text in list previews or searchable projection text", async () => {
    writeSessionFile(tmpDir, "reminder.jsonl", [
      HEADER,
      {
        ...USER_MESSAGE,
        message: {
          role: "user",
          content: "[hana_reminder at 2026-07-05 14:05]\n- Plugin demo loaded\n[/hana_reminder]\n\nhello",
        },
      },
    ]);

    const cache = new SessionListProjectionCache();
    const [projection] = await cache.list(tmpDir);

    expect(projection.firstMessage).toBe("hello");
    expect(projection.allMessagesText).toBe("hello");
  });

  it("includes jsonl files that are reached through a filesystem link", async () => {
    const realDir = path.join(tmpDir, "real");
    fs.mkdirSync(realDir, { recursive: true });
    const realFile = writeSessionFile(realDir, "linked.jsonl", [HEADER, USER_MESSAGE]);
    const linkedFile = path.join(tmpDir, "linked.jsonl");
    if (!tryLinkFile(realFile, linkedFile)) return;

    const cache = new SessionListProjectionCache();
    const [projection] = await cache.list(tmpDir);

    expect(projection.path).toBe(linkedFile);
    expect(projection.revision).toBe(sessionFileRevision(fs.statSync(linkedFile)));
  });

  it("does not list repair artifacts as sessions", async () => {
    const filePath = writeSessionFile(tmpDir, "a.jsonl", [HEADER, USER_MESSAGE]);
    writeSessionFile(tmpDir, "a.jsonl.repair.jsonl", [
      HEADER,
      {
        ...USER_MESSAGE,
        message: { role: "user", content: "[omitted 2048 chars by Hana session JSONL guard]" },
      },
    ]);

    const cache = new SessionListProjectionCache();
    const projections = await cache.list(tmpDir);

    expect(projections).toHaveLength(1);
    expect(projections[0].path).toBe(filePath);
  });
});
