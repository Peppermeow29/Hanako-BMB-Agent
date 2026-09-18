import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertStudioMount } from "../core/studio-mounts.ts";
import { createSandboxResourceIO } from "../lib/resource-io/sandbox-resource-io.ts";

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x04, 0x00,
]);

function makeEngine(tmpDir, options: any = {}) {
  const disabled = Array.isArray(options) ? options : (options.disabled || []);
  const agent = {
    id: "agent-1",
    name: "Hana",
    agentName: "Hana",
    config: { tools: { disabled } },
  };
  const emitEvent = vi.fn();
  const emitResourceChanged = vi.fn();
  const hanakoHome = path.join(tmpDir, "hana");
  const resourceIO = options.resourceIO || createSandboxResourceIO({
    cwd: tmpDir,
    agentDir: tmpDir,
    workspace: tmpDir,
    workspaceFolders: [tmpDir],
    authorizedFolders: [tmpDir],
    hanakoHome,
    getSandboxEnabled: () => false,
    getSessionPath: () => null,
    emitEvent: (event: any) => {
      if (event?.type === "resource.changed") emitResourceChanged(event);
    },
    studioId: "studio_1",
  });
  const executeIsolated = options.executeIsolated || vi.fn(async () => ({ sessionPath: path.join(tmpDir, "agents", "agent-1", "activity", "s.jsonl") }));
  const activityStore = options.activityStore || {
    add: vi.fn((activity) => activity),
    update: vi.fn((id, patch) => ({ id, ...patch })),
  };
  return {
    hanakoHome,
    deskCwd: tmpDir,
    homeCwd: tmpDir,
    getRuntimeContext: () => ({
      serverId: "server_1",
      serverNodeId: "node_1",
      userId: "user_1",
      studioId: "studio_1",
      connectionKind: "local",
      credentialKind: "loopback_token",
    }),
    currentAgentId: agent.id,
    agent,
    agentsDir: path.join(tmpDir, "agents"),
    getAgent: () => agent,
    getPrimaryAgentId: () => options.primaryAgentId ?? agent.id,
    getActivityStore: () => activityStore,
    executeIsolated,
    pluginManager: {
      getAllTools: () => options.pluginTools ?? [{ _pluginId: "beautify", name: "beautify_create-cover" }],
    },
    emitEvent,
    emitResourceChanged,
    resourceIO,
    getResourceIO: () => resourceIO,
    _test: { executeIsolated, activityStore },
  };
}

describe("desk beautify cover apply route", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cover-route-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies a user-selected local image through the same cover service", async () => {
    const notePath = path.join(tmpDir, "note.md");
    const imagePath = path.join(tmpDir, "cover.png");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");
    fs.writeFileSync(imagePath, PNG_HEADER);

    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const engine = makeEngine(tmpDir);
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const res = await app.request("/api/desk/beautify/cover/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: notePath, imageFilePath: imagePath }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cover.image).toMatch(/^文本附件\/note-cover-/);
    expect(fs.existsSync(path.join(tmpDir, ...body.cover.image.split("/")))).toBe(true);
    expect(fs.readFileSync(notePath, "utf-8")).toContain("cover:");
    const expectedPath = fs.realpathSync(notePath);
    expect(engine.emitResourceChanged).toHaveBeenCalledWith(expect.objectContaining({
      changeType: "modified",
      resource: expect.objectContaining({
        kind: "local-file",
        provider: "local_fs",
        path: expectedPath,
        filePath: expectedPath,
      }),
      source: "api",
      reason: "desk.beautify.cover.apply",
    }));
  });

  it("applies uploaded cover bytes to a server workbench Markdown target", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const engine = makeEngine(tmpDir);
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const target = { kind: "workbench-file", rootId: "default", subdir: "", name: "note.md" };
    const res = await app.request("/api/desk/beautify/cover/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target,
        image: {
          filename: "client-cover.png",
          contentBase64: PNG_HEADER.toString("base64"),
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.target).toMatchObject(target);
    expect(body.cover.image).toMatch(/^文本附件\/note-cover-/);
    expect(fs.existsSync(path.join(tmpDir, ...body.cover.image.split("/")))).toBe(true);
    expect(fs.readFileSync(notePath, "utf-8")).toContain("cover:");
    const expectedPath = fs.realpathSync(notePath);
    expect(engine.emitResourceChanged).toHaveBeenCalledWith(expect.objectContaining({
      changeType: "modified",
      resource: expect.objectContaining({
        kind: "local-file",
        provider: "local_fs",
        path: expectedPath,
        filePath: expectedPath,
      }),
      source: "api",
      reason: "desk.beautify.cover.apply",
    }));
  });

  it("applies uploaded cover bytes to a non-default workbench mount target", async () => {
    const mountRoot = path.join(tmpDir, "mounted");
    const defaultNotePath = path.join(tmpDir, "note.md");
    const mountedNotePath = path.join(mountRoot, "note.md");
    fs.mkdirSync(mountRoot, { recursive: true });
    fs.writeFileSync(defaultNotePath, "# Default\n", "utf-8");
    fs.writeFileSync(mountedNotePath, "# Mounted\n", "utf-8");

    const engine = makeEngine(tmpDir);
    upsertStudioMount(engine.hanakoHome, {
      mountId: "mount_docs",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountRoot },
      label: "Mounted Docs",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });
    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const target = { kind: "workbench-file", mountId: "mount_docs", subdir: "", name: "note.md" };
    const res = await app.request("/api/desk/beautify/cover/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target,
        image: {
          filename: "client-cover.png",
          contentBase64: PNG_HEADER.toString("base64"),
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.target).toMatchObject(target);
    expect(fs.readFileSync(mountedNotePath, "utf-8")).toContain("cover:");
    expect(fs.readFileSync(defaultNotePath, "utf-8")).toBe("# Default\n");
  });

  it("allows direct UI local image apply when the Agent beautify tool is disabled", async () => {
    const notePath = path.join(tmpDir, "note.md");
    const imagePath = path.join(tmpDir, "cover.png");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");
    fs.writeFileSync(imagePath, PNG_HEADER);

    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const app = new Hono();
    app.route("/api", createDeskRoute(makeEngine(tmpDir, ["beautify"]), null));

    const res = await app.request("/api/desk/beautify/cover/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: notePath, imageFilePath: imagePath }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("applies a built-in cover gallery preset through a whitelist id", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { COVER_GALLERY_PRESETS } = await import("../shared/cover-gallery-presets.ts");
    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const engine = makeEngine(tmpDir);
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const res = await app.request("/api/desk/beautify/cover/preset/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: notePath,
        presetId: COVER_GALLERY_PRESETS[0].id,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cover.image).toMatch(/^文本附件\/note-cover-/);
    expect(fs.existsSync(path.join(tmpDir, ...body.cover.image.split("/")))).toBe(true);
    expect(fs.readFileSync(notePath, "utf-8")).toContain("cover:");
    const expectedPath = fs.realpathSync(notePath);
    expect(engine.emitResourceChanged).toHaveBeenCalledWith(expect.objectContaining({
      changeType: "modified",
      resource: expect.objectContaining({
        kind: "local-file",
        provider: "local_fs",
        path: expectedPath,
        filePath: expectedPath,
      }),
      source: "api",
      reason: "desk.beautify.cover.preset_apply",
    }));
  });

  it("applies a built-in cover gallery preset to a server workbench Markdown target", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { COVER_GALLERY_PRESETS } = await import("../shared/cover-gallery-presets.ts");
    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const engine = makeEngine(tmpDir);
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, null));

    const target = { kind: "workbench-file", rootId: "default", subdir: "", name: "note.md" };
    const res = await app.request("/api/desk/beautify/cover/preset/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target,
        presetId: COVER_GALLERY_PRESETS[0].id,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.target).toMatchObject(target);
    expect(body.cover.image).toMatch(/^文本附件\/note-cover-/);
    expect(fs.existsSync(path.join(tmpDir, ...body.cover.image.split("/")))).toBe(true);
    expect(fs.readFileSync(notePath, "utf-8")).toContain("cover:");
  });

  it("allows built-in cover gallery preset apply when the Agent beautify tool is disabled", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { COVER_GALLERY_PRESETS } = await import("../shared/cover-gallery-presets.ts");
    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const app = new Hono();
    app.route("/api", createDeskRoute(makeEngine(tmpDir, { disabled: ["beautify"] }), null));

    const res = await app.request("/api/desk/beautify/cover/preset/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: notePath,
        presetId: COVER_GALLERY_PRESETS[0].id,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("rejects unknown built-in cover gallery preset ids", async () => {
    const notePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(notePath, "# Demo\n", "utf-8");

    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const app = new Hono();
    app.route("/api", createDeskRoute(makeEngine(tmpDir), null));

    const res = await app.request("/api/desk/beautify/cover/preset/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: notePath,
        presetId: "../private",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown cover gallery preset" });
  });
});
