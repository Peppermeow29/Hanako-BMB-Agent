import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertStudioMount } from "../core/studio-mounts.ts";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-mobile-workbench-"));
}

function makeApp(engine) {
  const app = new Hono();
  return import("../server/routes/mobile-workbench.ts").then(({ createMobileWorkbenchRoute }) => {
    app.route("/api", createMobileWorkbenchRoute(engine));
    return app;
  });
}

async function makeRouteResourceIO({ hanakoHome, workspace, eventBus = {}, studioId = "studio_1" }: Record<string, any>) {
  const { createSandboxResourceIO } = await import("../lib/resource-io/sandbox-resource-io.ts");
  return createSandboxResourceIO({
    cwd: workspace,
    agentDir: workspace,
    workspace,
    workspaceFolders: [workspace],
    authorizedFolders: [workspace],
    hanakoHome,
    getSandboxEnabled: () => false,
    getSessionPath: () => null,
    emitEvent: (event: any) => {
      if (event?.type === "resource.changed") eventBus.changed?.(event);
      if (event?.type === "resource.renamed") eventBus.renamed?.(event);
      if (event?.type === "resource.deleted") eventBus.deleted?.(event);
    },
    studioId,
  });
}

describe("mobile workbench route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("lists workbench files without exposing absolute server paths", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "note.md"), "hello", "utf-8");
    fs.writeFileSync(path.join(workspace, ".secret"), "hidden", "utf-8");
    const app = await makeApp({
      hanakoHome: path.join(tmpDir, "hana"),
      deskCwd: workspace,
      homeCwd: workspace,
    });

    const res = await app.request("/api/mobile/workbench/files");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ rootId: "default", subdir: "" });
    expect(data).not.toHaveProperty("basePath");
    expect(data.files.map((file) => file.name)).toEqual(["note.md"]);
    expect(JSON.stringify(data)).not.toContain(workspace);
  });

  it("discloses local_fs native roots to the local owner principal only", async () => {
    const { upsertStudioMount } = await import("../core/studio-mounts.ts");
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    const mountRoot = path.join(tmpDir, "client-project");
    const hanakoHome = path.join(tmpDir, "hana");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(mountRoot, { recursive: true });
    fs.writeFileSync(path.join(mountRoot, "brief.md"), "brief", "utf-8");
    upsertStudioMount(hanakoHome, {
      mountId: "mount_client",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Client Project",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });
    const app = await makeApp({
      hanakoHome,
      deskCwd: workspace,
      homeCwd: workspace,
      getRuntimeContext: () => ({
        serverId: "server_1",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
        connectionKind: "local",
        credentialKind: "loopback_token",
      }),
    });

    const mounted = await app.request("/api/workbench/files?mountId=mount_client");
    expect(mounted.status).toBe(200);
    const mountedData = await mounted.json();
    expect(mountedData.mount).toMatchObject({
      mountId: "mount_client",
      nativeRootPath: mountRoot,
    });
    expect(JSON.stringify(mountedData)).not.toContain(`"path"`);

    const fallback = await app.request("/api/workbench/files");
    expect(fallback.status).toBe(200);
    expect((await fallback.json()).mount).toMatchObject({ nativeRootPath: workspace });
  });

  it("exposes the same server workbench through desktop-neutral aliases", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "note.md"), "old", "utf-8");
    const app = await makeApp({
      hanakoHome: path.join(tmpDir, "hana"),
      deskCwd: workspace,
      homeCwd: workspace,
    });

    const files = await app.request("/api/workbench/files");
    expect(files.status).toBe(200);
    expect(await files.json()).toMatchObject({
      rootId: "default",
      files: [{ name: "note.md", isDir: false }],
    });

    const content = await app.request("/api/workbench/content?name=note.md");
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("old");
    expect(Number(content.headers.get("X-Hana-File-MtimeMs"))).toBeGreaterThan(0);
    expect(content.headers.get("X-Hana-File-Size")).toBe(String(Buffer.byteLength("old")));

    const write = await app.request("/api/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "writeText", name: "note.md", content: "new" }),
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toMatchObject({ ok: true, action: "writeText", rootId: "default" });
    expect(fs.readFileSync(path.join(workspace, "note.md"), "utf-8")).toBe("new");

    const upload = await app.request("/api/workbench/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ name: "asset.txt", contentBase64: Buffer.from("uploaded").toString("base64") }],
      }),
    });
    expect(upload.status).toBe(200);
    expect(await upload.json()).toMatchObject({
      ok: true,
      results: [{ name: "asset.txt", ok: true, size: Buffer.byteLength("uploaded") }],
    });
    expect(fs.readFileSync(path.join(workspace, "asset.txt"), "utf-8")).toBe("uploaded");
  });

  it("returns mobile bootstrap metadata for desktop-compatible agent workbench selection", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const app = await makeApp({
      hanakoHome: path.join(tmpDir, "hana"),
      userDir: path.join(tmpDir, "hana", "user"),
      agentDir: path.join(tmpDir, "hana", "agents", "hana"),
      deskCwd: workspace,
      homeCwd: workspace,
      getLocale: () => "zh-CN",
      agentName: "Hana",
      userName: "Owner",
      currentAgentId: "hana",
      config: {
        cwd_history: [workspace],
        memory: { enabled: false },
        editor: { markdown: { bodyFontSize: 18 } },
      },
      getThinkingLevel: () => "high",
      agent: {
        config: {
          agent: { yuan: "hanako" },
          providers: { openai: { api_key: "secret-key" } },
        },
      },
      listAgents: () => [{
        id: "hana",
        name: "Hana",
        yuan: "hanako",
        isPrimary: true,
        hasAvatar: false,
        homeFolder: null,
        chatModel: { id: "deepseek-chat", provider: "deepseek" },
      }],
      getHomeCwd: (agentId) => agentId === "hana" ? workspace : null,
      getAppearance: () => ({ theme: "warm-paper", serif: true }),
    });

    const res = await app.request("/api/mobile/bootstrap");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      locale: "zh-CN",
      agentName: "Hana",
      userName: "Owner",
      currentAgentId: "hana",
      homeFolder: workspace,
      cwdHistory: [workspace],
      memoryEnabled: false,
      thinkingLevel: "high",
      editor: { markdown: { bodyFontSize: 18 } },
      appearance: { theme: "warm-paper", serif: true },
    });
    expect(data.agents).toEqual([
      {
        id: "hana",
        name: "Hana",
        yuan: "hanako",
        isPrimary: true,
        isCurrent: false,
        hasAvatar: false,
        chatModel: { id: "deepseek-chat", provider: "deepseek" },
        homeFolder: null,
        effectiveHomeFolder: workspace,
        memoryMasterEnabled: true,
      },
    ]);
    expect(JSON.stringify(data)).not.toContain("secret-key");
  });

  it("serves UTF-8 file content with HEAD and Range support", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "粘贴图片.md"), "abcdef", "utf-8");
    const app = await makeApp({
      hanakoHome: path.join(tmpDir, "hana"),
      deskCwd: workspace,
      homeCwd: workspace,
    });
    const query = `name=${encodeURIComponent("粘贴图片.md")}`;

    const head = await app.request(`/api/mobile/workbench/content?${query}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("6");
    expect(head.headers.get("content-disposition")).toContain("filename*=UTF-8''");

    const range = await app.request(`/api/mobile/workbench/content?${query}`, {
      headers: { Range: "bytes=1-3" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 1-3/6");
    expect(await range.text()).toBe("bcd");
  });

  it("safe-deletes mobile files into recoverable trash instead of hard removing bytes", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    const hanakoHome = path.join(tmpDir, "hana");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "draft.txt"), "keep me recoverable", "utf-8");
    const app = await makeApp({
      hanakoHome,
      deskCwd: workspace,
      homeCwd: workspace,
    });

    const res = await app.request("/api/mobile/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "safeDelete", name: "draft.txt" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, action: "safeDelete" });
    expect(data.trashId).toMatch(/^trash_/);
    expect(fs.existsSync(path.join(workspace, "draft.txt"))).toBe(false);
    const trashDir = path.join(hanakoHome, "trash", "mobile-workbench", data.trashId);
    expect(fs.readFileSync(path.join(trashDir, "payload"), "utf-8")).toBe("keep me recoverable");
    expect(JSON.parse(fs.readFileSync(path.join(trashDir, "metadata.json"), "utf-8")))
      .toMatchObject({ originalName: "draft.txt", rootId: "default" });
  });

  it("returns a new version for text writes and rejects stale expected versions", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const target = path.join(workspace, "note.md");
    fs.writeFileSync(target, "old", "utf-8");
    const before = fs.statSync(target);
    const app = await makeApp({
      hanakoHome: path.join(tmpDir, "hana"),
      deskCwd: workspace,
      homeCwd: workspace,
    });

    const stale = await app.request("/api/mobile/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "writeText",
        name: "note.md",
        content: "should not write",
        expectedVersion: { mtimeMs: before.mtime.getTime() - 1, size: before.size },
      }),
    });

    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({
      ok: false,
      conflict: true,
      version: { mtimeMs: before.mtime.getTime(), size: before.size },
    });
    expect(fs.readFileSync(target, "utf-8")).toBe("old");

    const saved = await app.request("/api/mobile/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "writeText",
        name: "note.md",
        content: "new body",
        expectedVersion: { mtimeMs: before.mtime.getTime(), size: before.size },
      }),
    });

    expect(saved.status).toBe(200);
    const data = await saved.json();
    expect(data).toMatchObject({
      ok: true,
      action: "writeText",
      version: { size: Buffer.byteLength("new body") },
    });
    expect(typeof data.version.mtimeMs).toBe("number");
    expect(fs.readFileSync(target, "utf-8")).toBe("new body");
  });

  it("emits ResourceEvents for successful Workbench text writes", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const target = path.join(workspace, "note.md");
    fs.writeFileSync(target, "old", "utf-8");
    const realTarget = fs.realpathSync(target);
    const changed = vi.fn();
    const resourceIO = await makeRouteResourceIO({
      hanakoHome: path.join(tmpDir, "hana"),
      workspace,
      eventBus: { changed },
    });
    const app = await makeApp({
      hanakoHome: path.join(tmpDir, "hana"),
      deskCwd: workspace,
      homeCwd: workspace,
      getResourceIO: () => resourceIO,
    });

    const res = await app.request("/api/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "writeText", name: "note.md", content: "new body" }),
    });

    expect(res.status).toBe(200);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({
      changeType: "modified",
      resourceKey: expect.stringContaining("note.md"),
      source: "api",
      reason: "mobile_workbench.write",
      resource: expect.objectContaining({
        kind: "local-file",
        provider: "local_fs",
        filePath: realTarget,
      }),
      version: expect.objectContaining({
        size: Buffer.byteLength("new body"),
      }),
    }));
  });

  it("emits ResourceEvents for Workbench mkdir, rename, and safe delete", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    const hanakoHome = path.join(tmpDir, "hana");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "draft.md"), "draft", "utf-8");
    const changed = vi.fn();
    const renamed = vi.fn();
    const deleted = vi.fn();
    const resourceIO = await makeRouteResourceIO({
      hanakoHome,
      workspace,
      eventBus: { changed, renamed, deleted },
    });
    const app = await makeApp({
      hanakoHome,
      deskCwd: workspace,
      homeCwd: workspace,
      getResourceIO: () => resourceIO,
    });

    const mkdir = await app.request("/api/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mkdir", name: "notes" }),
    });
    expect(mkdir.status).toBe(200);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({
      changeType: "created",
      reason: "mobile_workbench.mkdir",
      resource: expect.objectContaining({
        filePath: fs.realpathSync(path.join(workspace, "notes")),
      }),
    }));

    const rename = await app.request("/api/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rename", oldName: "draft.md", newName: "renamed.md" }),
    });
    expect(rename.status).toBe(200);
    expect(renamed).toHaveBeenCalledWith(expect.objectContaining({
      reason: "mobile_workbench.rename",
      oldResource: expect.objectContaining({
        filePath: expect.stringContaining("draft.md"),
      }),
      newResource: expect.objectContaining({
        filePath: fs.realpathSync(path.join(workspace, "renamed.md")),
      }),
    }));

    const remove = await app.request("/api/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "safeDelete", name: "renamed.md" }),
    });
    expect(remove.status).toBe(200);
    expect(deleted).toHaveBeenCalledWith(expect.objectContaining({
      reason: "mobile_workbench.safe_delete",
      resource: expect.objectContaining({
        filePath: expect.stringContaining("renamed.md"),
      }),
    }));
  });

  it("rejects path traversal in mobile file names and subdirectories", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const app = await makeApp({
      hanakoHome: path.join(tmpDir, "hana"),
      deskCwd: workspace,
      homeCwd: workspace,
    });

    const res = await app.request("/api/mobile/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "writeText", subdir: "../outside", name: "x.md", content: "no" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_subdir" });
  });

  it("accepts normal mobile base64 uploads below the route body limit", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const app = await makeApp({
      hanakoHome: path.join(tmpDir, "hana"),
      deskCwd: workspace,
      homeCwd: workspace,
    });

    const res = await app.request("/api/mobile/workbench/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ name: "tiny.txt", contentBase64: Buffer.from("hello mobile").toString("base64") }],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      results: [{ name: "tiny.txt", ok: true, size: Buffer.byteLength("hello mobile") }],
    });
    expect(fs.readFileSync(path.join(workspace, "tiny.txt"), "utf-8")).toBe("hello mobile");
  });

  it("rejects oversized mobile upload JSON bodies before parsing base64 files", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const app = await makeApp({
      hanakoHome: path.join(tmpDir, "hana"),
      deskCwd: workspace,
      homeCwd: workspace,
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          files: [{ name: "tiny.bin", contentBase64: Buffer.from("ok").toString("base64") }],
        })));
        controller.close();
      },
    });
    const req = new Request("http://localhost/api/mobile/workbench/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(81 * 1024 * 1024),
      },
      body: stream,
      duplex: "half",
    } as any);

    const res = await app.request(req);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it("denies remote mobile writes without files.write scope", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const app = new Hono();
    const { createMobileWorkbenchRoute } = await import("../server/routes/mobile-workbench.ts");
    app.use("*", async (c, next) => {
      (c as any).set("authPrincipal", Object.freeze({
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        trustState: "lan",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
        deviceId: "device_1",
        scopes: ["files.read"],
      }));
      await next();
    });
    app.route("/api", createMobileWorkbenchRoute({
      hanakoHome: path.join(tmpDir, "hana"),
      deskCwd: workspace,
      homeCwd: workspace,
      getRuntimeContext: () => ({
        serverId: "server_1",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
        connectionKind: "local",
        credentialKind: "loopback_token",
      }),
    }));

    const res = await app.request("/api/mobile/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "writeText", name: "x.md", content: "no" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "insufficient_scope",
      capability: "files.write",
    });
  });

  it("lists active local_fs studio mounts through the mobile workbench route", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    const mountRoot = path.join(tmpDir, "mounted-docs");
    const hanakoHome = path.join(tmpDir, "hana");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(mountRoot, { recursive: true });
    fs.writeFileSync(path.join(mountRoot, "mounted.md"), "mount body", "utf-8");
    upsertStudioMount(hanakoHome, {
      mountId: "mount_docs",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Mounted Docs",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });
    const app = await makeApp({
      hanakoHome,
      deskCwd: workspace,
      homeCwd: workspace,
      getRuntimeContext: () => ({
        serverId: "server_1",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
        connectionKind: "local",
        credentialKind: "loopback_token",
      }),
    });

    const res = await app.request("/api/mobile/workbench/files?rootId=mount_docs");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      rootId: "mount_docs",
      files: [{ name: "mounted.md", isDir: false }],
    });
    // local owner principal 通过显式 nativeRootPath 字段拿 native 根；
    // 内部 path 字段永不外漏。
    expect(data.mount).not.toHaveProperty("path");
    expect(data.mount.nativeRootPath).toBe(mountRoot);
  });

  it("accepts mountId as the canonical workbench mount selector while preserving rootId in the response", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    const mountRoot = path.join(tmpDir, "mounted-docs");
    const hanakoHome = path.join(tmpDir, "hana");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(mountRoot, { recursive: true });
    fs.writeFileSync(path.join(mountRoot, "mounted.md"), "mount body", "utf-8");
    upsertStudioMount(hanakoHome, {
      mountId: "mount_docs",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Mounted Docs",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });
    const app = await makeApp({
      hanakoHome,
      deskCwd: workspace,
      homeCwd: workspace,
      getRuntimeContext: () => ({
        serverId: "server_1",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
        connectionKind: "local",
        credentialKind: "loopback_token",
      }),
    });

    const files = await app.request("/api/workbench/files?mountId=mount_docs");
    expect(files.status).toBe(200);
    expect(await files.json()).toMatchObject({
      rootId: "mount_docs",
      mountId: "mount_docs",
      mount: {
        mountId: "mount_docs",
        label: "Mounted Docs",
        sourceKind: "storage",
        provider: "local_fs",
      },
      files: [{ name: "mounted.md", isDir: false }],
    });

    const content = await app.request("/api/workbench/content?mountId=mount_docs&name=mounted.md");
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("mount body");
    expect(Number(content.headers.get("X-Hana-File-MtimeMs"))).toBeGreaterThan(0);
    expect(content.headers.get("X-Hana-File-Size")).toBe(String(Buffer.byteLength("mount body")));

    const write = await app.request("/api/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "writeText",
        mountId: "mount_docs",
        name: "mounted.md",
        content: "new mount body",
      }),
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toMatchObject({
      ok: true,
      rootId: "mount_docs",
      mountId: "mount_docs",
    });
    expect(fs.readFileSync(path.join(mountRoot, "mounted.md"), "utf-8")).toBe("new mount body");
  });

  it("moves multiple tree items inside a mounted workspace and returns touched directories", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    const mountRoot = path.join(tmpDir, "mounted-docs");
    const hanakoHome = path.join(tmpDir, "hana");
    fs.mkdirSync(path.join(mountRoot, "notes"), { recursive: true });
    fs.mkdirSync(path.join(mountRoot, "archive"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(mountRoot, "notes", "draft.md"), "draft", "utf-8");
    upsertStudioMount(hanakoHome, {
      mountId: "mount_docs",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Mounted Docs",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });
    const app = await makeApp({
      hanakoHome,
      deskCwd: workspace,
      homeCwd: workspace,
      getRuntimeContext: () => ({
        serverId: "server_1",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
        connectionKind: "local",
        credentialKind: "loopback_token",
      }),
    });

    const res = await app.request("/api/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "movePaths",
        mountId: "mount_docs",
        items: [{ sourceSubdir: "notes", name: "draft.md", isDirectory: false }],
        destSubdir: "archive",
        currentSubdir: "",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      ok: true,
      action: "movePaths",
      mountId: "mount_docs",
      filesByPath: {
        notes: [],
        archive: [{ name: "draft.md", isDir: false }],
      },
    });
    expect(fs.existsSync(path.join(mountRoot, "notes", "draft.md"))).toBe(false);
    expect(fs.readFileSync(path.join(mountRoot, "archive", "draft.md"), "utf-8")).toBe("draft");
  });

  it("creates and consumes an execution lease for remote mobile writes", async () => {
    tmpDir = makeTmpDir();
    const workspace = path.join(tmpDir, "workspace");
    const hanakoHome = path.join(tmpDir, "hana");
    fs.mkdirSync(workspace, { recursive: true });
    const app = new Hono();
    const { createMobileWorkbenchRoute } = await import("../server/routes/mobile-workbench.ts");
    app.use("*", async (c, next) => {
      (c as any).set("authPrincipal", Object.freeze({
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        trustState: "paired",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
        deviceId: "device_1",
        scopes: ["files.read", "files.write"],
      }));
      await next();
    });
    app.route("/api", createMobileWorkbenchRoute({
      hanakoHome,
      currentAgentId: "hana",
      deskCwd: workspace,
      homeCwd: workspace,
      getRuntimeContext: () => ({
        serverId: "server_1",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
      }),
    }));

    const res = await app.request("/api/mobile/workbench/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "writeText", name: "remote.md", content: "remote body" }),
    });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(workspace, "remote.md"), "utf-8")).toBe("remote body");
    const leases = JSON.parse(fs.readFileSync(path.join(hanakoHome, "security", "execution-leases.json"), "utf-8"));
    expect(leases.leases).toHaveLength(1);
    expect(leases.leases[0]).toMatchObject({
      status: "consumed",
      commandClass: "write_files",
      sandboxProfile: "workspace_write",
      backupPolicy: "snapshot_before_write",
      actorPrincipalId: expect.stringContaining("principal_device"),
      // The workbench writes as a subsystem, not as an agent. The lease names
      // that subsystem on both fields so the record says who really acted,
      // instead of pinning the write on whichever agent was in the foreground.
      agentId: "mobile_workbench",
      sessionId: "mobile_workbench",
    });
    const audit = fs.readFileSync(path.join(hanakoHome, "logs", "security-audit.jsonl"), "utf-8");
    expect(audit).toContain(leases.leases[0].leaseId);
  });
});
