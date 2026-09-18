import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";

describe("ResourceService", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeTmpDir() {
    if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-resource-service-"));
    return tmpDir;
  }

  function writeLegacySessionFileSidecar({
    fileId = "sf_legacy",
    sessionId = null,
    status = "available",
    fileExists = true,
    missingAt = null,
    legacyFileIds = null,
  } = {}) {
    const root = makeTmpDir();
    const agentsDir = path.join(root, "agents");
    const sessionPath = path.join(agentsDir, "hana", "sessions", "legacy.jsonl");
    const filePath = path.join(root, "legacy", "note.txt");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n", "utf-8");
    if (fileExists) fs.writeFileSync(filePath, "hello legacy\n", "utf-8");
    fs.writeFileSync(`${sessionPath}.files.json`, JSON.stringify({
      version: 1,
      sessionPath,
      ...(sessionId ? { sessionId } : {}),
      files: {
        [fileId]: {
          id: fileId,
          ...(sessionId ? { sessionId } : {}),
          ...(legacyFileIds ? { legacyFileIds } : {}),
          sessionPath,
          filePath,
          realPath: filePath,
          displayName: "Legacy Note",
          filename: "note.txt",
          label: "Legacy Note",
          ext: "txt",
          mime: "text/plain",
          size: 13,
          kind: "document",
          isDirectory: false,
          origin: "stage_files",
          operations: ["staged"],
          createdAt: 111,
          mtimeMs: 222,
          storageKind: "external",
          status,
          missingAt: missingAt ?? (status === "expired" ? 333 : null),
        },
      },
      refs: [
        { fileId, origin: "stage_files", operation: "staged", storageKind: "external", createdAt: 111 },
      ],
      createdAt: 111,
      updatedAt: 222,
    }, null, 2), "utf-8");
    return { root, agentsDir, sessionPath, filePath, fileId };
  }

  function makeService(ResourceService, agentsDir) {
    return new ResourceService({
      agentsDir,
      sessionFiles: new SessionFileRegistry(),
      runtimeContext: {
        studioId: "studio_legacy",
      },
    });
  }

  it("resolves old SessionFile sidecars by derived resource id without a disk migration", async () => {
    const { ResourceService } = await import("../core/resource-service.ts");
    const { agentsDir } = writeLegacySessionFileSidecar({ fileId: "sf_legacy" });
    const service = makeService(ResourceService, agentsDir);

    const resource = service.getResource("res_sf_legacy");

    expect(resource).toMatchObject({
      resourceId: "res_sf_legacy",
      name: "studios/studio_legacy/resources/res_sf_legacy",
      studioId: "studio_legacy",
      type: "file",
      source: "session_file",
      fileId: "sf_legacy",
      displayName: "Legacy Note",
      lifecycle: { status: "available", missingAt: null },
    });
  });

  it("indexes manifest-era sidecars by sessionId while keeping path compatibility", async () => {
    const { ResourceService } = await import("../core/resource-service.ts");
    const { agentsDir, fileId } = writeLegacySessionFileSidecar({
      fileId: "sf_manifest",
      sessionId: "sess_manifest_resource",
    });
    const service = makeService(ResourceService, agentsDir);

    const resource = service.getResource("res_sf_manifest");

    expect(resource).toMatchObject({
      resourceId: "res_sf_manifest",
      fileId,
      displayName: "Legacy Note",
    });
    expect(service._sessionRefByFileId.get(fileId)).toEqual({
      sessionId: "sess_manifest_resource",
      sessionPath: expect.stringContaining("legacy.jsonl"),
    });
    expect(service._sessionFiles.get(fileId, { sessionId: "sess_manifest_resource" })?.sessionId)
      .toBe("sess_manifest_resource");
  });

  it("resolves local content for available legacy resources", async () => {
    const { ResourceService } = await import("../core/resource-service.ts");
    const { agentsDir, filePath } = writeLegacySessionFileSidecar({ fileId: "sf_content" });
    const service = makeService(ResourceService, agentsDir);

    const content = service.resolveContent("res_sf_content");

    expect(content).toMatchObject({
      resourceId: "res_sf_content",
      filePath: fs.realpathSync(filePath),
      mime: "text/plain",
      size: 13,
      filename: "note.txt",
    });
  });

  it("marks available legacy resources as missing when tracked content no longer exists", async () => {
    const { ResourceService } = await import("../core/resource-service.ts");
    const { agentsDir } = writeLegacySessionFileSidecar({
      fileId: "sf_missing",
      status: "available",
      fileExists: false,
    });
    const service = makeService(ResourceService, agentsDir);

    const resource = service.getResource("res_sf_missing");

    expect(resource).toMatchObject({
      resourceId: "res_sf_missing",
      lifecycle: { status: "missing" },
      links: {
        self: "/api/resources/res_sf_missing",
      },
    });
    expect(resource.lifecycle.missingAt).toEqual(expect.any(Number));
    expect(resource.links.content).toBeUndefined();
  });

  it("restores missing legacy resources as available when tracked content exists again", async () => {
    const { ResourceService } = await import("../core/resource-service.ts");
    const { agentsDir } = writeLegacySessionFileSidecar({
      fileId: "sf_returned",
      status: "missing",
      fileExists: true,
      missingAt: 444,
    });
    const service = makeService(ResourceService, agentsDir);

    const resource = service.getResource("res_sf_returned");

    expect(resource).toMatchObject({
      resourceId: "res_sf_returned",
      lifecycle: { status: "available", missingAt: null },
      links: {
        self: "/api/resources/res_sf_returned",
        content: "/api/resources/res_sf_returned/content",
      },
    });
  });

  it("resolves resource ids captured before a fork through legacy file ids", async () => {
    const { ResourceService } = await import("../core/resource-service.ts");
    const { resourceIdForSessionFileId } = await import("../lib/resources/resource-envelope.ts");
    const { agentsDir } = writeLegacySessionFileSidecar({
      fileId: "sf_forked",
      sessionId: "sess_forked_child",
      legacyFileIds: ["sf_parent"],
    });
    const service = makeService(ResourceService, agentsDir);

    const resource = service.getResource(resourceIdForSessionFileId("sf_parent"));

    expect(resource).toMatchObject({
      resourceId: "res_sf_forked",
      fileId: "sf_forked",
      displayName: "Legacy Note",
      lifecycle: { status: "available", missingAt: null },
    });
    expect(service.resolveContent("res_sf_parent")).toMatchObject({
      resourceId: "res_sf_forked",
      mime: "text/plain",
      filename: "note.txt",
    });
  });

  it("scopes the by-id fallback to the owning session so legacy aliases resolve", async () => {
    const { ResourceService } = await import("../core/resource-service.ts");
    const { agentsDir } = writeLegacySessionFileSidecar({
      fileId: "sf_scoped_child",
      sessionId: "sess_scoped_child",
      legacyFileIds: ["sf_scoped_parent"],
    });
    const service = makeService(ResourceService, agentsDir);

    expect(service._findSessionRefForFileId("sf_scoped_parent")).toEqual({
      sessionId: "sess_scoped_child",
      sessionPath: expect.stringContaining("legacy.jsonl"),
    });
    expect(service._findSessionFileByResourceId("res_sf_scoped_parent")).toMatchObject({
      id: "sf_scoped_child",
    });
    expect(service._sessionFiles.get("sf_scoped_parent")).toBeNull();
  });

  it("refuses content for expired legacy resources", async () => {
    const { ResourceService, ResourceError } = await import("../core/resource-service.ts");
    const { agentsDir } = writeLegacySessionFileSidecar({ fileId: "sf_expired", status: "expired" });
    const service = makeService(ResourceService, agentsDir);

    expect(() => service.resolveContent("res_sf_expired"))
      .toThrow(ResourceError);
    expect(() => service.resolveContent("res_sf_expired"))
      .toThrow(/resource expired/);
  });
});
