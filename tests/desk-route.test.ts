import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertStudioMount } from "../core/studio-mounts.ts";

const extractZipMock = vi.fn(async (zipPath, destDir) => {
  const skillDir = path.join(destDir, "sample-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: sample-skill\n---\nfrom: ${zipPath}\n`, "utf-8");
  fs.writeFileSync(path.join(skillDir, "references", "guide.md"), "# Guide\n", "utf-8");
});

vi.mock("../lib/extract-zip.js", () => ({
  extractZip: extractZipMock,
}));

describe("desk route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lists all known project skill sources while marking policy-active and shadowed candidates", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-route-skills-"));
    try {
      const cwd = path.join(tempRoot, "workspace");
      for (const [sub, name] of [
        [".agents/skills", "shared-skill"],
        [".codex/skills", "shared-skill"],
        [".claude/skills", "claude-only"],
      ]) {
        const skillDir = path.join(cwd, sub, name);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf-8");
      }
      const engine = {
        deskCwd: cwd,
        homeCwd: cwd,
        getAgent: vi.fn(() => ({
          config: {
            workspace_context: {
              discover_project_skills: true,
              discover_compatible_project_skills: true,
            },
          },
        })),
      };

      const { createDeskRoute } = await import("../server/routes/desk.ts");
      const app = new Hono();
      app.route("/api", createDeskRoute(engine, null));

      const res = await app.request(`/api/desk/skills?dir=${encodeURIComponent(cwd)}&agentId=agent-a`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.policy).toEqual({
        discoverProjectSkills: true,
        discoverCompatibleProjectSkills: true,
      });
      expect(data.skills.find((skill) => skill.source === "Agents" && skill.name === "shared-skill"))
        .toMatchObject({ active: true, shadowed: false, sourceCategory: "standard" });
      expect(data.skills.find((skill) => skill.source === "Codex" && skill.name === "shared-skill"))
        .toMatchObject({ active: false, shadowed: true, shadowedBy: expect.objectContaining({ source: "Agents" }) });
      expect(data.skills.find((skill) => skill.source === "Claude Code" && skill.name === "claude-only"))
        .toMatchObject({ active: true, shadowed: false, sourceCategory: "compatible" });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps policy-disabled project skills manageable on disk", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-route-skills-"));
    try {
      const cwd = path.join(tempRoot, "workspace");
      const skillDir = path.join(cwd, ".agents", "skills", "disabled-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: disabled-skill\n---\n", "utf-8");
      const engine = {
        deskCwd: cwd,
        homeCwd: cwd,
        getAgent: vi.fn(() => ({
          config: {
            workspace_context: {
              discover_project_skills: false,
              discover_compatible_project_skills: false,
            },
          },
        })),
        syncWorkspaceSkillPaths: vi.fn(async () => {}),
      };
      const { createDeskRoute } = await import("../server/routes/desk.ts");
      const app = new Hono();
      app.route("/api", createDeskRoute(engine, null));

      const listed = await app.request(`/api/desk/skills?dir=${encodeURIComponent(cwd)}&agentId=agent-a`);
      expect((await listed.json()).skills[0]).toMatchObject({
        name: "disabled-skill",
        active: false,
        shadowed: false,
        inactiveReason: "policy-disabled",
      });

      const deleted = await app.request("/api/desk/delete-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: cwd, agentId: "agent-a", skillDir }),
      });
      expect(deleted.status).toBe(200);
      expect(fs.existsSync(skillDir)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("desk/install-skill 对 zip/.skill 走 extractZip 抽象，并把解压结果安装到工作区技能目录", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-route-"));
    try {
      const cwd = path.join(tempRoot, "workspace");
      fs.mkdirSync(cwd, { recursive: true });
      const zipPath = path.join(tempRoot, "sample-skill.zip");
      fs.writeFileSync(zipPath, "placeholder");

      const syncWorkspaceSkillPaths = vi.fn(async () => {});
      const engine = {
        deskCwd: cwd,
        homeCwd: cwd,
        syncWorkspaceSkillPaths,
      };

      const { createDeskRoute } = await import("../server/routes/desk.ts");
      const app = new Hono();
      app.route("/api", createDeskRoute(engine, null));

      const res = await app.request("/api/desk/install-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: zipPath, dir: cwd, agentId: "agent-a" }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        name: "sample-skill",
        installedSkillSource: {
          kind: "skill_source",
          owner: "workspace",
          skillName: "sample-skill",
          filePath: path.join(cwd, ".agents", "skills", "sample-skill", "SKILL.md"),
          baseDir: path.join(cwd, ".agents", "skills", "sample-skill"),
          editable: true,
          readonly: false,
        },
      });
      expect(extractZipMock).toHaveBeenCalledTimes(1);
      expect(extractZipMock).toHaveBeenCalledWith(zipPath, expect.stringContaining(".tmp-install-"));
      expect(fs.existsSync(path.join(cwd, ".agents", "skills", "sample-skill", "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(cwd, ".agents", "skills", "sample-skill", "references", "guide.md"))).toBe(true);
      expect(syncWorkspaceSkillPaths).toHaveBeenCalledWith(cwd, { reload: true, emitEvent: true, force: true, agentId: "agent-a" });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("desk/delete-skill forces workspace skill reload even when the skill path list is unchanged", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-route-"));
    try {
      const cwd = path.join(tempRoot, "workspace");
      const skillDir = path.join(cwd, ".agents", "skills", "old-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: old-skill\n---\n", "utf-8");

      const syncWorkspaceSkillPaths = vi.fn(async () => {});
      const engine = {
        deskCwd: cwd,
        homeCwd: cwd,
        syncWorkspaceSkillPaths,
      };

      const { createDeskRoute } = await import("../server/routes/desk.ts");
      const app = new Hono();
      app.route("/api", createDeskRoute(engine, null));

      const res = await app.request("/api/desk/delete-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillDir }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(fs.existsSync(skillDir)).toBe(false);
      expect(syncWorkspaceSkillPaths).toHaveBeenCalledWith(cwd, { reload: true, emitEvent: true, force: true, agentId: null });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("manages workspace skills through a mounted Studio workspace", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-route-"));
    try {
      const hanakoHome = path.join(tempRoot, "hana");
      const workspace = path.join(tempRoot, "mounted-workspace");
      const existingSkillDir = path.join(workspace, ".agents", "skills", "existing-skill");
      fs.mkdirSync(existingSkillDir, { recursive: true });
      fs.writeFileSync(path.join(existingSkillDir, "SKILL.md"), "---\nname: existing-skill\n---\n", "utf-8");
      upsertStudioMount(hanakoHome, {
        schemaVersion: 1,
        mountId: "mount_docs",
        hostStudioId: "studio-main",
        sourceKind: "storage",
        provider: "local_fs",
        label: "Docs",
        presentation: "folder",
        capabilities: ["list", "read", "write"],
        rootLocator: { path: workspace },
      });

      const syncWorkspaceSkillPaths = vi.fn(async () => {});
      const engine = {
        hanakoHome,
        deskCwd: path.join(tempRoot, "default-workspace"),
        homeCwd: path.join(tempRoot, "default-workspace"),
        getRuntimeContext: () => ({ studioId: "studio-main" }),
        syncWorkspaceSkillPaths,
      };

      const { createDeskRoute } = await import("../server/routes/desk.ts");
      const app = new Hono();
      app.route("/api", createDeskRoute(engine, null));

      const listed = await app.request("/api/desk/skills?mountId=mount_docs");
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({
        skills: [{ name: "existing-skill", workspaceMountId: "mount_docs" }],
      });

      const installed = await app.request("/api/desk/install-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mountId: "mount_docs",
          file: {
            filename: "sample-skill.zip",
            contentBase64: Buffer.from("placeholder").toString("base64"),
          },
        }),
      });
      expect(installed.status).toBe(200);
      expect(await installed.json()).toMatchObject({ ok: true, name: "sample-skill" });
      expect(fs.existsSync(path.join(workspace, ".agents", "skills", "sample-skill", "SKILL.md"))).toBe(true);
      expect(syncWorkspaceSkillPaths).toHaveBeenCalledWith(fs.realpathSync(workspace), { reload: true, emitEvent: true, force: true, agentId: null });

      const deleted = await app.request("/api/desk/delete-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mountId: "mount_docs",
          skillDir: path.join(workspace, ".agents", "skills", "sample-skill"),
        }),
      });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ ok: true });
      expect(fs.existsSync(path.join(workspace, ".agents", "skills", "sample-skill"))).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows explicit desk dirs from workspace scope and rejects arbitrary siblings", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-route-"));
    try {
      const cwd = path.join(tempRoot, "workspace");
      const extra = path.join(tempRoot, "reference");
      const sibling = path.join(tempRoot, "private");
      for (const dir of [cwd, extra, sibling]) fs.mkdirSync(dir, { recursive: true });

      const engine = {
        hanakoHome: path.join(tempRoot, "hana-home"),
        deskCwd: cwd,
        homeCwd: cwd,
        isApprovedWorkspaceDir: vi.fn((dir) => dir === cwd || dir === extra),
      };

      const { createDeskRoute } = await import("../server/routes/desk.ts");
      const app = new Hono();
      app.route("/api", createDeskRoute(engine, null));

      const allowed = await app.request(`/api/desk/files?dir=${encodeURIComponent(extra)}`);
      expect(allowed.status).toBe(200);
      expect((await allowed.json()).basePath).toBe(extra);

      const blocked = await app.request(`/api/desk/files?dir=${encodeURIComponent(sibling)}`);
      expect(await blocked.json()).toHaveProperty("error");
      expect(engine.isApprovedWorkspaceDir).toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows a selected agent explicit home folder without switching the engine focus", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-route-"));
    try {
      const currentHome = path.join(tempRoot, "hana");
      const selectedHome = path.join(tempRoot, "mio");
      fs.mkdirSync(currentHome, { recursive: true });
      fs.mkdirSync(selectedHome, { recursive: true });
      fs.writeFileSync(path.join(selectedHome, "mio.md"), "ok");

      const engine = {
        hanakoHome: path.join(tempRoot, "hana-home"),
        deskCwd: currentHome,
        homeCwd: currentHome,
        getExplicitHomeCwd: vi.fn((agentId) => (agentId === "mio" ? selectedHome : null)),
        getHomeCwd: vi.fn((agentId) => (agentId === "mio" ? selectedHome : currentHome)),
      };

      const { createDeskRoute } = await import("../server/routes/desk.ts");
      const app = new Hono();
      app.route("/api", createDeskRoute(engine, null));

      const blocked = await app.request(`/api/desk/files?dir=${encodeURIComponent(selectedHome)}`);
      expect(await blocked.json()).toHaveProperty("error");

      const allowed = await app.request(`/api/desk/files?dir=${encodeURIComponent(selectedHome)}&agentId=mio`);
      expect(allowed.status).toBe(200);
      const data = await allowed.json();
      expect(data.basePath).toBe(selectedHome);
      expect(data.files.map(f => f.name)).toContain("mio.md");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows the app file browser to open persisted workspace history outside the agent sandbox", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-route-"));
    try {
      const agentHome = path.join(tempRoot, "hana");
      const selectedWorkspace = path.join(tempRoot, "desktop");
      fs.mkdirSync(agentHome, { recursive: true });
      fs.mkdirSync(selectedWorkspace, { recursive: true });
      fs.writeFileSync(path.join(selectedWorkspace, "visible.txt"), "ok");

      const engine = {
        hanakoHome: path.join(tempRoot, "hana-home"),
        config: { cwd_history: [selectedWorkspace] },
        deskCwd: agentHome,
        homeCwd: agentHome,
        isApprovedWorkspaceDir: vi.fn(() => false),
      };

      const { createDeskRoute } = await import("../server/routes/desk.ts");
      const app = new Hono();
      app.route("/api", createDeskRoute(engine, null));

      const res = await app.request(`/api/desk/files?dir=${encodeURIComponent(selectedWorkspace)}`);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.basePath).toBe(selectedWorkspace);
      expect(data.files.map(f => f.name)).toContain("visible.txt");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns route errors for missing activity session lookups", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-route-"));
    try {
      const activityStore = {
        get: vi.fn((id) => {
          if (id === "no-session") {
            return {
              id,
              type: "beautify",
              label: "No session",
              summary: "missing session file",
              startedAt: 1,
              finishedAt: null,
              sessionFile: null,
            };
          }
          if (id === "missing-file") {
            return {
              id,
              type: "beautify",
              label: "Missing file",
              summary: "missing file",
              startedAt: 1,
              finishedAt: null,
              sessionFile: "missing.jsonl",
            };
          }
          return null;
        }),
      };
      const engine = {
        agentsDir: tempRoot,
        listAgents: () => [{ id: "agent-a", name: "Agent A" }],
        getActivityStore: () => activityStore,
      };

      const { createDeskRoute } = await import("../server/routes/desk.ts");
      const app = new Hono();
      app.route("/api", createDeskRoute(engine, null));

      const notFound = await app.request("/api/desk/activities/missing/session");
      expect(notFound.status).toBe(404);
      expect(await notFound.json()).toEqual({
        error: {
          code: "activity_not_found",
          message: "activity not found",
        },
      });

      const noSession = await app.request("/api/desk/activities/no-session/session");
      expect(noSession.status).toBe(404);
      expect(await noSession.json()).toEqual({
        error: {
          code: "activity_session_unavailable",
          message: "no session file",
        },
      });

      const missingFile = await app.request("/api/desk/activities/missing-file/session");
      expect(missingFile.status).toBe(404);
      expect(await missingFile.json()).toEqual({
        error: {
          code: "activity_session_missing",
          message: "session file missing",
        },
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns a route error when heartbeat is unavailable", async () => {
    const { createDeskRoute } = await import("../server/routes/desk.ts");
    const app = new Hono();
    app.route("/api", createDeskRoute({
      listAgents: () => [],
    }, {
      scheduler: {
        getHeartbeat: vi.fn(() => null),
      },
    }));

    const res = await app.request("/api/desk/heartbeat?agentId=agent-a", {
      method: "POST",
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: "heartbeat_unavailable",
        message: "Heartbeat not initialized",
      },
    });
  });

  it("moves workspace tree items by explicit subdir and reports affected folders", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-route-"));
    try {
      const cwd = path.join(tempRoot, "workspace");
      fs.mkdirSync(path.join(cwd, "notes"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "archive"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "notes", "chapter.md"), "chapter", "utf-8");

      const engine = {
        hanakoHome: path.join(tempRoot, "hana"),
        deskCwd: cwd,
        homeCwd: cwd,
      };

      const { createDeskRoute } = await import("../server/routes/desk.ts");
      const app = new Hono();
      app.route("/api", createDeskRoute(engine, null));

      const res = await app.request("/api/desk/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "movePaths",
          dir: cwd,
          items: [{ sourceSubdir: "notes", name: "chapter.md", isDirectory: false }],
          destSubdir: "archive",
          currentSubdir: "",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results).toEqual([{ name: "chapter.md", ok: true }]);
      expect(fs.existsSync(path.join(cwd, "archive", "chapter.md"))).toBe(true);
      expect(data.filesByPath.notes).toEqual([]);
      expect(data.filesByPath.archive.map(f => f.name)).toEqual(["chapter.md"]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects path-like names for create, mkdir, and rename instead of truncating them", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-route-"));
    try {
      const cwd = path.join(tempRoot, "workspace");
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(path.join(cwd, "old.md"), "old", "utf-8");

      const engine = {
        hanakoHome: path.join(tempRoot, "hana"),
        deskCwd: cwd,
        homeCwd: cwd,
      };

      const { createDeskRoute } = await import("../server/routes/desk.ts");
      const app = new Hono();
      app.route("/api", createDeskRoute(engine, null));

      const createRes = await app.request("/api/desk/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", dir: cwd, name: "../evil.md", content: "" }),
      });
      const mkdirRes = await app.request("/api/desk/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mkdir", dir: cwd, name: "nested/folder" }),
      });
      const renameRes = await app.request("/api/desk/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", dir: cwd, oldName: "old.md", newName: "nested/new.md" }),
      });

      expect(await createRes.json()).toHaveProperty("error", "invalid name");
      expect(await mkdirRes.json()).toHaveProperty("error", "invalid name");
      expect(await renameRes.json()).toHaveProperty("error", "invalid name");
      expect(fs.existsSync(path.join(cwd, "evil.md"))).toBe(false);
      expect(fs.existsSync(path.join(cwd, "nested"))).toBe(false);
      expect(fs.existsSync(path.join(cwd, "old.md"))).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns route errors for workspace file action validation misses", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-route-"));
    try {
      const cwd = path.join(tempRoot, "workspace");
      fs.mkdirSync(cwd, { recursive: true });

      const engine = {
        hanakoHome: path.join(tempRoot, "hana"),
        deskCwd: cwd,
        homeCwd: cwd,
      };

      const { createDeskRoute } = await import("../server/routes/desk.ts");
      const app = new Hono();
      app.use("*", async (c, next) => {
        (c as any).set("authPrincipal", Object.freeze({
          kind: "local_user",
          connectionKind: "local",
          credentialKind: "loopback_token",
          scopes: ["*"],
        }));
        await next();
      });
      app.route("/api", createDeskRoute(engine, null));

      const uploadMissingPaths = await app.request("/api/desk/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "upload", paths: [] }),
      });
      expect(uploadMissingPaths.status).toBe(400);
      expect(await uploadMissingPaths.json()).toEqual({
        error: {
          code: "workspace_file_validation_failed",
          message: "paths required",
        },
      });

      const createMissingFields = await app.request("/api/desk/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", content: "" }),
      });
      expect(createMissingFields.status).toBe(400);
      expect(await createMissingFields.json()).toEqual({
        error: {
          code: "workspace_file_validation_failed",
          message: "name and content required",
        },
      });

      const unknownAction = await app.request("/api/desk/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "compress" }),
      });
      expect(unknownAction.status).toBe(400);
      expect(await unknownAction.json()).toEqual({
        error: {
          code: "unknown_workspace_file_action",
          message: "unknown action: compress",
        },
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("searches workspace file names recursively without exposing hidden or dependency folders", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-route-"));
    try {
      const cwd = path.join(tempRoot, "workspace");
      fs.mkdirSync(path.join(cwd, "src", "components"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "node_modules", "pkg"), { recursive: true });
      fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", "components", "DeskTree.tsx"), "tree", "utf-8");
      fs.writeFileSync(path.join(cwd, "docs", "desk-note.md"), "note", "utf-8");
      fs.writeFileSync(path.join(cwd, "node_modules", "pkg", "desk-hidden.js"), "hidden", "utf-8");
      fs.writeFileSync(path.join(cwd, ".git", "desk-private"), "hidden", "utf-8");

      const engine = {
        hanakoHome: path.join(tempRoot, "hana-home"),
        deskCwd: cwd,
        homeCwd: cwd,
      };

      const { createDeskRoute } = await import("../server/routes/desk.ts");
      const app = new Hono();
      app.route("/api", createDeskRoute(engine, null));

      const res = await app.request(`/api/desk/search-files?dir=${encodeURIComponent(cwd)}&q=desk`);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results.map(item => item.relativePath)).toEqual([
        "docs/desk-note.md",
        "src/components/DeskTree.tsx",
      ]);
      expect(data.results[0]).toEqual(expect.objectContaining({
        name: "desk-note.md",
        parentSubdir: "docs",
        isDir: false,
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects upload action with absolute source paths for non-local-owner principals", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-route-"));
    try {
      const cwd = path.join(tempRoot, "workspace");
      const externalDir = path.join(tempRoot, "outside");
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(externalDir, { recursive: true });
      const sensitiveFile = path.join(externalDir, "secret.txt");
      fs.writeFileSync(sensitiveFile, "secret bytes", "utf-8");

      const engine = {
        deskCwd: cwd,
        homeCwd: cwd,
      };

      const { createDeskRoute } = await import("../server/routes/desk.ts");
      const app = new Hono();
      app.use("*", async (c, next) => {
        (c as any).set("authPrincipal", Object.freeze({
          kind: "device",
          connectionKind: "lan",
          credentialKind: "device_credential",
          principalId: "device:phone-1",
          scopes: ["chat", "resources.read", "files.read", "files.write"],
        }));
        await next();
      });
      app.route("/api", createDeskRoute(engine, null));

      const res = await app.request("/api/desk/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "upload", paths: [sensitiveFile] }),
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data).toEqual(expect.objectContaining({ error: expect.stringContaining("local") }));
      expect(fs.existsSync(path.join(cwd, "secret.txt"))).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows upload action for local-owner principal", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-route-"));
    try {
      const cwd = path.join(tempRoot, "workspace");
      const externalDir = path.join(tempRoot, "drag-source");
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(externalDir, { recursive: true });
      const draggedFile = path.join(externalDir, "note.md");
      fs.writeFileSync(draggedFile, "dragged content", "utf-8");

      const engine = {
        hanakoHome: path.join(tempRoot, "hana"),
        deskCwd: cwd,
        homeCwd: cwd,
      };

      const { createDeskRoute } = await import("../server/routes/desk.ts");
      const app = new Hono();
      app.use("*", async (c, next) => {
        (c as any).set("authPrincipal", Object.freeze({
          kind: "local_user",
          connectionKind: "local",
          credentialKind: "loopback_token",
          scopes: ["*"],
        }));
        await next();
      });
      app.route("/api", createDeskRoute(engine, null));

      const res = await app.request("/api/desk/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "upload", paths: [draggedFile] }),
      });

      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(cwd, "note.md"))).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
