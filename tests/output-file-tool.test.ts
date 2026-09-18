import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStageFilesTool,
  STAGE_FILES_EXECUTION_BOUNDARY,
} from "../lib/tools/output-file-tool.ts";
import { loadLocale } from "../lib/i18n.ts";

describe("stage_files tool", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("describes the tool as the unified file delivery handoff", () => {
    loadLocale("en");
    const tool = createStageFilesTool({});

    expect(tool.description).toContain("Deliver files");
    expect(tool.description).toContain("Bridge");
    expect((tool.parameters.properties.fileIds as any).description).toContain("SessionFile ids");
    expect((tool.parameters.properties.filepaths as any).description).toContain("when no SessionFile id is available");
  });

  it("registers staged files as session files while preserving legacy mediaUrls", async () => {
    loadLocale("en");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-stage-tool-"));
    const filePath = path.join(tmpDir, "out.txt");
    fs.writeFileSync(filePath, "ok");
    const sessionPath = "/sessions/s1.jsonl";
    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin }) => ({
      id: "sf_test1234567890",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: path.basename(filePath),
      label,
      ext: "txt",
      mime: "text/plain",
      size: 2,
      kind: "document",
      origin,
      createdAt: 1,
    }));
    const tool = createStageFilesTool({ registerSessionFile });

    const result = await tool.execute("call-1", { filepaths: [filePath] }, null, null, {
      sessionManager: { getSessionFile: () => sessionPath },
    });

    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath,
      filePath,
      label: "out.txt",
      origin: "stage_files",
    });
    expect(result.details.files).toEqual([expect.objectContaining({
      id: "sf_test1234567890",
      fileId: "sf_test1234567890",
      filePath,
      label: "out.txt",
      ext: "txt",
      mime: "text/plain",
      size: 2,
      kind: "document",
    })]);
    expect(result.details.media.items).toEqual([expect.objectContaining({
      type: "session_file",
      fileId: "sf_test1234567890",
      sessionPath,
      filePath,
      filename: "out.txt",
      mime: "text/plain",
      size: 2,
      kind: "document",
    })]);
    expect(result.details.media.mediaUrls).toEqual([filePath]);
  });

  it("revalidates the host-bound canonical path immediately before registration", async () => {
    loadLocale("en");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-stage-boundary-"));
    const stagedPath = path.join(tmpDir, "out.txt");
    fs.writeFileSync(stagedPath, "ok");
    const filePath = fs.realpathSync(stagedPath);
    const registerSessionFile = vi.fn();
    const checkStagePath = vi.fn(() => ({
      allowed: false,
      canonicalPath: path.join(tmpDir, "replaced.txt"),
      reason: "path changed",
    }));
    const params: any = { filepaths: [filePath] };
    Object.defineProperty(params, STAGE_FILES_EXECUTION_BOUNDARY, {
      value: Object.freeze({
        canonicalPaths: Object.freeze([filePath]),
        checkStagePath,
      }),
    });
    const tool = createStageFilesTool({ registerSessionFile });

    const result = await tool.execute("call-boundary", params, null, null, {
      sessionManager: { getSessionFile: () => "/sessions/s1.jsonl" },
    });

    expect(checkStagePath).toHaveBeenCalledWith(filePath);
    expect(registerSessionFile).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("path changed after permission validation");
  });

  it("delivers existing SessionFiles by fileId through the stage_files handoff", async () => {
    loadLocale("en");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-stage-fileid-"));
    const sessionPath = "/sessions/s1.jsonl";
    const coverPath = path.join(tmpDir, "cover.png");
    const altPath = path.join(tmpDir, "alt.png");
    fs.writeFileSync(coverPath, "cover");
    fs.writeFileSync(altPath, "alt");
    const existingById = {
      sf_existing123456: {
        id: "sf_existing123456",
        fileId: "sf_existing123456",
        sessionPath,
        filePath: coverPath,
        realPath: coverPath,
        displayName: "cover.png",
        filename: "cover.png",
        label: "cover.png",
        ext: "png",
        mime: "image/png",
        size: 5,
        kind: "image",
        origin: "session_file_copy",
        storageKind: "external",
        status: "available",
      },
      sf_existing789012: {
        id: "sf_existing789012",
        fileId: "sf_existing789012",
        sessionPath,
        filePath: altPath,
        realPath: altPath,
        displayName: "alt.png",
        filename: "alt.png",
        label: "alt.png",
        ext: "png",
        mime: "image/png",
        size: 3,
        kind: "image",
        origin: "session_file_copy",
        storageKind: "external",
        status: "available",
      },
    };
    const registerSessionFile = vi.fn(({ filePath, origin }) => {
      const existing = Object.values(existingById).find((file: any) => file.filePath === filePath) as any;
      return { ...existing, origin, operations: ["copied", "staged"] };
    });
    const resolveSessionFile = vi.fn((fileId) => existingById[fileId]);
    const tool = createStageFilesTool({ registerSessionFile, resolveSessionFile });

    const result = await tool.execute("call-1", { fileIds: ["sf_existing123456", "sf_existing789012"] }, null, null, {
      sessionManager: { getSessionFile: () => sessionPath },
    });

    expect(resolveSessionFile).toHaveBeenCalledWith("sf_existing123456", { sessionPath });
    expect(resolveSessionFile).toHaveBeenCalledWith("sf_existing789012", { sessionPath });
    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath,
      filePath: coverPath,
      label: "cover.png",
      origin: "stage_files",
    });
    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath,
      filePath: altPath,
      label: "alt.png",
      origin: "stage_files",
    });
    expect(result.details.files).toEqual([
      expect.objectContaining({
        id: "sf_existing123456",
        fileId: "sf_existing123456",
        filePath: coverPath,
        label: "cover.png",
        mime: "image/png",
        kind: "image",
        origin: "stage_files",
        status: "available",
      }),
      expect.objectContaining({
        id: "sf_existing789012",
        fileId: "sf_existing789012",
        filePath: altPath,
        label: "alt.png",
        mime: "image/png",
        kind: "image",
        origin: "stage_files",
        status: "available",
      }),
    ]);
    expect(result.details.media.items).toEqual([
      expect.objectContaining({
        type: "session_file",
        fileId: "sf_existing123456",
        sessionPath,
        filePath: coverPath,
        filename: "cover.png",
        mime: "image/png",
        size: 5,
        kind: "image",
      }),
      expect.objectContaining({
        type: "session_file",
        fileId: "sf_existing789012",
        sessionPath,
        filePath: altPath,
        filename: "alt.png",
        mime: "image/png",
        size: 3,
        kind: "image",
      }),
    ]);
    expect(result.details.media.mediaUrls).toEqual([coverPath, altPath]);
  });
});
