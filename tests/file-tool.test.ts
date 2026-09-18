import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileTool } from "../lib/tools/file-tool.ts";

describe("file tool", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeTree() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-file-tool-"));
    const workspace = path.join(tmpDir, "workspace");
    const source = path.join(tmpDir, "plugin-data", "generated", "cover.png");
    const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "main.jsonl");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(source, "png");
    fs.writeFileSync(sessionPath, "{}\n");
    return { workspace, source, sessionPath };
  }

  it("stats a SessionFile by fileId without reading its content", async () => {
    const { workspace, source, sessionPath } = makeTree();
    const tool = createFileTool({
      getCwd: () => workspace,
      getSessionPath: () => sessionPath,
      resolveSessionFile: vi.fn(() => ({
        id: "sf_source",
        fileId: "sf_source",
        sessionPath,
        filePath: source,
        realPath: source,
        filename: "cover.png",
        mime: "image/png",
        kind: "image",
        size: 3,
        status: "available",
      })),
    });

    const result = await tool.execute("file-1", {
      action: "stat",
      fileId: "sf_source",
    });

    const details = result.details as any;
    expect(result.content[0].text).toContain("cover.png");
    expect(details.file).toMatchObject({
      type: "session_file",
      fileId: "sf_source",
      filename: "cover.png",
      mime: "image/png",
      kind: "image",
      size: 3,
      status: "available",
    });
  });

  it("stats a SessionFile by sessionId-first fileId shorthand", async () => {
    const { workspace, source } = makeTree();
    const sessionId = "sess_file_tool";
    const resolveSessionFile = vi.fn(() => ({
      id: "sf_source",
      fileId: "sf_source",
      sessionId,
      sessionPath: "/sessions/moved.jsonl",
      filePath: source,
      realPath: source,
      filename: "cover.png",
      mime: "image/png",
      kind: "image",
      size: 3,
      status: "available",
    }));
    const tool = createFileTool({
      getCwd: () => workspace,
      getSessionPath: () => "/sessions/current.jsonl",
      resolveSessionFile,
    });

    const result = await tool.execute("file-1", {
      action: "stat",
      fileId: "sf_source",
      sessionId,
    });

    expect(resolveSessionFile).toHaveBeenCalledWith("sf_source", { sessionId });
    expect((result.details as any).file).toMatchObject({
      type: "session_file",
      fileId: "sf_source",
      filename: "cover.png",
    });
  });

  it("stats a local path with ISO mtime text and versioned details", async () => {
    const { workspace } = makeTree();
    const notePath = path.join(workspace, "note.txt");
    fs.writeFileSync(notePath, "hello", "utf-8");
    const tool = createFileTool({
      getCwd: () => workspace,
    });

    const result = await tool.execute("file-1", {
      action: "stat",
      path: "note.txt",
    });

    const details = result.details as any;
    const mtimeIso = new Date(details.file.mtimeMs).toISOString();
    expect(result.content[0].text).toContain("note.txt");
    expect(result.content[0].text).toContain(`modified ${mtimeIso}`);
    expect(details.file).toMatchObject({
      type: "path",
      path: notePath,
      filePath: notePath,
      filename: "note.txt",
      size: 5,
      mtimeMs: expect.any(Number),
      version: {
        mtimeMs: details.file.mtimeMs,
        size: 5,
      },
    });
  });

  it("copies a SessionFile into the current workspace by fileId", async () => {
    const { workspace, source, sessionPath } = makeTree();
    const registerSessionFile = vi.fn(({ filePath, label, origin, operation, storageKind }) => ({
      id: "sf_copy",
      fileId: "sf_copy",
      sessionPath,
      filePath,
      label,
      origin,
      operation,
      storageKind,
      mime: "image/png",
      kind: "image",
      size: 3,
    }));
    const tool = createFileTool({
      getCwd: () => workspace,
      getSessionPath: () => sessionPath,
      resolveSessionFile: vi.fn(() => ({
        id: "sf_source",
        sessionPath,
        filePath: source,
        realPath: source,
        filename: "cover.png",
        status: "available",
      })),
      registerSessionFile,
    });

    const result = await tool.execute("file-1", {
      action: "copy",
      fileId: "sf_source",
      targetDir: "assets",
      filename: "article-cover.png",
    });

    const targetPath = path.join(workspace, "assets", "article-cover.png");
    const details = result.details as any;
    expect(fs.readFileSync(targetPath, "utf8")).toBe("png");
    expect(result.content[0].text).toContain("article-cover.png");
    expect(details.file).toMatchObject({
      fileId: "sf_copy",
      filePath: targetPath,
      storageKind: "external",
    });
    expect(details.media.items[0]).toMatchObject({
      type: "session_file",
      fileId: "sf_copy",
      sessionPath,
      filePath: targetPath,
      kind: "image",
    });
  });

  it("copies a SessionFile by sessionId and preserves sessionId in the media item", async () => {
    const { workspace, source } = makeTree();
    const sessionId = "sess_file_copy";
    const sessionPath = "/sessions/moved.jsonl";
    const registerSessionFile = vi.fn(({ sessionId, sessionPath, filePath, label, origin, operation, storageKind }) => ({
      id: "sf_copy",
      fileId: "sf_copy",
      sessionId,
      sessionPath,
      filePath,
      label,
      origin,
      operation,
      storageKind,
      mime: "image/png",
      kind: "image",
      size: 3,
    }));
    const resolveSessionFile = vi.fn(() => ({
      id: "sf_source",
      sessionId,
      sessionPath,
      filePath: source,
      realPath: source,
      filename: "cover.png",
      status: "available",
    }));
    const tool = createFileTool({
      getCwd: () => workspace,
      getSessionPath: () => sessionPath,
      resolveSessionFile,
      registerSessionFile,
    });

    const result = await tool.execute("file-1", {
      action: "copy",
      fileId: "sf_source",
      sessionId,
      targetDir: "assets",
      filename: "article-cover.png",
    });

    expect(resolveSessionFile).toHaveBeenCalledWith("sf_source", { sessionId });
    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({ sessionId, sessionPath }));
    expect((result.details as any).media.items[0]).toMatchObject({
      type: "session_file",
      fileId: "sf_copy",
      sessionId,
      sessionPath,
    });
  });

  it("does not copy arbitrary local paths from outside the current workspace", async () => {
    const { workspace, source, sessionPath } = makeTree();
    const tool = createFileTool({
      getCwd: () => workspace,
      getSessionPath: () => sessionPath,
    });

    const result = await tool.execute("file-1", {
      action: "copy",
      path: source,
      targetDir: "assets",
      filename: "cover.png",
    });

    expect(result.content[0].text).toMatch(/copy source is outside allowed roots/i);
    expect(fs.existsSync(path.join(workspace, "assets", "cover.png"))).toBe(false);
  });

  it("allows file.copy to use live authorized session folders outside cwd", async () => {
    const { workspace, sessionPath } = makeTree();
    const authorized = path.join(tmpDir!, "authorized-assets");
    const source = path.join(authorized, "cover.png");
    const targetDir = path.join(authorized, "exports");
    fs.mkdirSync(authorized, { recursive: true });
    fs.writeFileSync(source, "png");
    const tool = createFileTool({
      getCwd: () => workspace,
      getSessionPath: () => sessionPath,
      getAuthorizedFolders: vi.fn(() => [authorized]),
    });

    const result = await tool.execute("file-1", {
      action: "copy",
      path: source,
      targetDir,
      filename: "copied.png",
    });

    expect(result.content[0].text).toContain("copied.png");
    expect(fs.readFileSync(path.join(targetDir, "copied.png"), "utf8")).toBe("png");
  });
});
