import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("MountAwareFileService", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("resolves default root and active local_fs studio mounts without exposing paths", async () => {
    const { upsertStudioMount } = await import("../core/studio-mounts.ts");
    const { MountAwareFileService } = await import("../core/mount-aware-file-service.ts");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mount-file-"));
    const defaultRoot = path.join(tmpDir, "default");
    const mountRoot = path.join(tmpDir, "mount");
    fs.mkdirSync(defaultRoot, { recursive: true });
    fs.mkdirSync(mountRoot, { recursive: true });
    fs.writeFileSync(path.join(mountRoot, "mounted.md"), "hello mount", "utf-8");
    upsertStudioMount(tmpDir, {
      mountId: "mount_docs",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Docs",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });

    const service = new MountAwareFileService({
      hanakoHome: tmpDir,
      defaultRoot,
      studioId: "studio_1",
    });

    expect(service.resolveRoot("default")).toMatchObject({
      id: "default",
      label: "Default",
      capabilities: ["list", "read", "write"],
    });
    expect(service.resolveRoot("default")).not.toHaveProperty("path");

    const mounted = service.resolveRoot("mount_docs");
    expect(mounted).toMatchObject({
      id: "mount_docs",
      label: "Docs",
      mountId: "mount_docs",
      capabilities: ["list", "read", "write"],
    });
    expect(mounted).not.toHaveProperty("path");
    expect(await service.listFiles("mount_docs", "")).toMatchObject({
      rootId: "mount_docs",
      files: [{ name: "mounted.md", isDir: false }],
    });
  });

  it("rejects local_fs mounts outside their resolved root", async () => {
    const { MountAwareFileService } = await import("../core/mount-aware-file-service.ts");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mount-file-"));
    const defaultRoot = path.join(tmpDir, "default");
    fs.mkdirSync(defaultRoot, { recursive: true });
    const service = new MountAwareFileService({
      hanakoHome: tmpDir,
      defaultRoot,
      studioId: "studio_1",
    });

    expect(() => service.resolveDirectory("default", "../outside")).toThrow("invalid_subdir");
  });

  it("discloses local_fs native roots only when constructed with discloseNativeRoot", async () => {
    const { upsertStudioMount } = await import("../core/studio-mounts.ts");
    const { MountAwareFileService } = await import("../core/mount-aware-file-service.ts");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mount-file-"));
    const defaultRoot = path.join(tmpDir, "default");
    const mountRoot = path.join(tmpDir, "mount");
    fs.mkdirSync(defaultRoot, { recursive: true });
    fs.mkdirSync(mountRoot, { recursive: true });
    fs.writeFileSync(path.join(mountRoot, "mounted.md"), "hello mount", "utf-8");
    upsertStudioMount(tmpDir, {
      mountId: "mount_docs",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Docs",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });

    const disclosing = new MountAwareFileService({
      hanakoHome: tmpDir,
      defaultRoot,
      studioId: "studio_1",
      discloseNativeRoot: true,
    });
    expect(disclosing.resolveRoot("mount_docs")).toMatchObject({
      mountId: "mount_docs",
      nativeRootPath: mountRoot,
    });
    expect(disclosing.resolveRoot("mount_docs")).not.toHaveProperty("path");
    expect(disclosing.resolveRoot("default")).toMatchObject({ nativeRootPath: defaultRoot });
    expect((await disclosing.listFiles("mount_docs", "")).mount).toMatchObject({
      nativeRootPath: mountRoot,
    });

    const closed = new MountAwareFileService({
      hanakoHome: tmpDir,
      defaultRoot,
      studioId: "studio_1",
    });
    expect(closed.resolveRoot("mount_docs")).not.toHaveProperty("nativeRootPath");
    expect(closed.resolveRoot("default")).not.toHaveProperty("nativeRootPath");
    expect((await closed.listFiles("mount_docs", "")).mount).not.toHaveProperty("nativeRootPath");
  });

  it("preserves ResourceIO operation context for workbench mutations", async () => {
    const { MountAwareFileService } = await import("../core/mount-aware-file-service.ts");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-mount-file-"));
    const defaultRoot = path.join(tmpDir, "default");
    fs.mkdirSync(defaultRoot, { recursive: true });
    fs.writeFileSync(path.join(defaultRoot, "old.md"), "old", "utf-8");
    fs.mkdirSync(path.join(defaultRoot, "archive"), { recursive: true });
    const resourceIO = {
      stat: vi.fn(async () => ({ exists: false, isDirectory: false, resourceKey: "local_fs:/note.md" })),
      read: vi.fn(async () => ({ content: Buffer.from(""), resourceKey: "local_fs:/note.md" })),
      write: vi.fn(async (ref, content) => ({
        changeType: "created",
        resourceKey: "local_fs:/note.md",
        resource: ref,
        content,
      })),
      mkdir: vi.fn(async (ref) => ({
        changeType: "created",
        resourceKey: "local_fs:/archive",
        resource: ref,
      })),
      move: vi.fn(async (from, to) => ({
        oldResourceKey: "local_fs:/old.md",
        newResourceKey: "local_fs:/archive/old.md",
        oldResource: from,
        newResource: to,
      })),
      list: vi.fn(async () => ({ items: [] })),
    };
    const service = new MountAwareFileService({
      hanakoHome: tmpDir,
      defaultRoot,
      studioId: "studio_1",
      resourceIO,
      operationContext: {
        source: "api",
        sessionId: "sess_1",
        sessionPath: "/sessions/current.jsonl",
        principal: {
          kind: "api",
          userId: "user_1",
          studioId: "studio_1",
          sessionId: "sess_1",
          sessionPath: "/sessions/current.jsonl",
          connectionKind: "lan",
          credentialKind: "device_credential",
          requestId: "req_1",
        },
        requestId: "req_1",
      },
    });

    await service.writeText("default", "", { name: "note.md", content: "hello" }, { reason: "mobile_workbench.write" });
    await service.move("default", "", { name: "old.md", destSubdir: "archive" }, { reason: "mobile_workbench.move" });

    expect(resourceIO.write).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "local-file", path: path.join(defaultRoot, "note.md") }),
      "hello",
      expect.objectContaining({
        source: "api",
        reason: "mobile_workbench.write",
        sessionId: "sess_1",
        sessionPath: "/sessions/current.jsonl",
        requestId: "req_1",
        principal: expect.objectContaining({
          kind: "api",
          userId: "user_1",
          studioId: "studio_1",
          connectionKind: "lan",
          credentialKind: "device_credential",
        }),
      }),
    );
    expect(resourceIO.mkdir).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "local-file", path: path.join(defaultRoot, "archive") }),
      expect.objectContaining({
        emit: false,
        reason: "mobile_workbench.move",
        principal: expect.objectContaining({ kind: "api", requestId: "req_1" }),
      }),
    );
  });
});
