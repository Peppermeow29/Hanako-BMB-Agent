import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Match runtime normalizeWorkspacePath: backslash → forward slash for cross-platform persistence */
const n = (p: string) => p.replace(/\\/g, "/");

/**
 * Workspace history lives in one agent's own config, so these routes have to be
 * told which agent. This engine keeps two agents so a test can prove a write
 * lands on the named one and leaves the other alone.
 */
function makeTwoAgentEngine(historyByAgent: Record<string, string[]>) {
  const agents: Record<string, any> = {};
  for (const [id, history] of Object.entries(historyByAgent)) {
    agents[id] = { id, config: { cwd_history: [...history] } };
  }
  const engine = {
    // The focused agent — nothing in these routes may fall back to it.
    currentAgentId: "focused",
    getAgent: vi.fn((id: string) => agents[id] || null),
    updateConfig: vi.fn(async (patch: any, opts: any = {}) => {
      const target = agents[opts.agentId];
      if (!target) throw new Error(`updateConfig without a known agentId: ${JSON.stringify(opts)}`);
      target.config = { ...target.config, ...patch };
    }),
    agents,
  };
  return engine;
}

describe("config workspace routes", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-workspaces-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists a selected workspace into the named agent's workspace history", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    const oldWorkspace = path.join(tmpDir, "old");
    const nextWorkspace = path.join(tmpDir, "next");
    fs.mkdirSync(oldWorkspace);
    fs.mkdirSync(nextWorkspace);
    const engine = makeTwoAgentEngine({ hana: [oldWorkspace], mio: [] });
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config/workspaces/recent?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: nextWorkspace }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cwd_history).toEqual([n(nextWorkspace), n(oldWorkspace)]);
    expect(engine.updateConfig).toHaveBeenCalledWith(
      { cwd_history: [n(nextWorkspace), n(oldWorkspace)] },
      { agentId: "hana" },
    );
  });

  it("keeps one agent's workspace pick out of another agent's history", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    const hanaWorkspace = path.join(tmpDir, "hana-ws");
    const mioWorkspace = path.join(tmpDir, "mio-ws");
    fs.mkdirSync(hanaWorkspace);
    fs.mkdirSync(mioWorkspace);
    const engine = makeTwoAgentEngine({ hana: [hanaWorkspace], mio: [mioWorkspace] });
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config/workspaces/recent?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: mioWorkspace }),
    });

    expect(res.status).toBe(200);
    expect(engine.agents.hana.config.cwd_history).toEqual([n(mioWorkspace), n(hanaWorkspace)]);
    // Untouched: the other agent keeps exactly the history it had.
    expect(engine.agents.mio.config.cwd_history).toEqual([mioWorkspace]);
  });

  it("refuses to record a workspace when the request names no agent", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    const nextWorkspace = path.join(tmpDir, "next");
    fs.mkdirSync(nextWorkspace);
    const engine = makeTwoAgentEngine({ hana: [], focused: [] });
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config/workspaces/recent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: nextWorkspace }),
    });
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toContain("missing agentId");
    expect(engine.updateConfig).not.toHaveBeenCalled();
    expect(engine.agents.focused.config.cwd_history).toEqual([]);
  });

  it("removes a recent workspace entry from the named agent without deleting the directory", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    const oldWorkspace = path.join(tmpDir, "old");
    const keepWorkspace = path.join(tmpDir, "keep");
    fs.mkdirSync(oldWorkspace);
    fs.mkdirSync(keepWorkspace);
    const engine = makeTwoAgentEngine({ hana: [oldWorkspace, keepWorkspace], mio: [oldWorkspace] });
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config/workspaces/recent?agentId=hana", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: oldWorkspace }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cwd_history).toEqual([n(keepWorkspace)]);
    expect(fs.existsSync(oldWorkspace)).toBe(true);
    expect(engine.updateConfig).toHaveBeenCalledWith({ cwd_history: [n(keepWorkspace)] }, { agentId: "hana" });
    // The same folder stays in the other agent's history.
    expect(engine.agents.mio.config.cwd_history).toEqual([oldWorkspace]);
  });

  it("refuses to remove a recent workspace when the request names no agent", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    const oldWorkspace = path.join(tmpDir, "old");
    fs.mkdirSync(oldWorkspace);
    const engine = makeTwoAgentEngine({ focused: [oldWorkspace] });
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config/workspaces/recent", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: oldWorkspace }),
    });
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toContain("missing agentId");
    expect(engine.agents.focused.config.cwd_history).toEqual([oldWorkspace]);
  });

  it("clears the named agent's recent history without deleting directories or touching other agents", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    const oldWorkspace = path.join(tmpDir, "old");
    fs.mkdirSync(oldWorkspace);
    const engine = makeTwoAgentEngine({ hana: [oldWorkspace], mio: [oldWorkspace] });
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config/workspaces/recent/all?agentId=hana", { method: "DELETE" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, cwd_history: [] });
    expect(fs.existsSync(oldWorkspace)).toBe(true);
    expect(engine.updateConfig).toHaveBeenCalledWith({ cwd_history: [] }, { agentId: "hana" });
    expect(engine.agents.mio.config.cwd_history).toEqual([oldWorkspace]);
  });

  it("refuses to clear recent history when the request names no agent", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    const oldWorkspace = path.join(tmpDir, "old");
    fs.mkdirSync(oldWorkspace);
    const engine = makeTwoAgentEngine({ focused: [oldWorkspace] });
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config/workspaces/recent/all", { method: "DELETE" });
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toContain("missing agentId");
    expect(engine.agents.focused.config.cwd_history).toEqual([oldWorkspace]);
  });

  it("no longer answers the identity-free config read with any agent workspace state", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    const engine = {
      // engine.config is whichever agent the server happens to be focused on
      config: { last_cwd: "/somewhere", cwd_history: ["/somewhere"] },
      providerRegistry: {
        getAllProvidersRaw: () => ({}),
        get: () => null,
      },
      updateConfig: vi.fn(),
    };
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config");
    const data = await res.json();

    expect(res.status).toBe(200);
    // Workspace history belongs to one agent, so it is served (and garbage
    // collected) by GET /api/agents/:id/config, not by this path.
    expect(data).not.toHaveProperty("cwd_history");
    expect(data).not.toHaveProperty("last_cwd");
    expect(engine.updateConfig).not.toHaveBeenCalled();
  });

  it("exposes and creates the default onboarding workspace", async () => {
    const homeDir = path.join(tmpDir, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const { createConfigRoute } = await import("../server/routes/config.ts");
    const engine = { config: {} };
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const expected = path.join(homeDir, "Desktop", "OH-WorkSpace");

    const getRes = await app.request("/api/config/default-workspace");
    expect(getRes.status).toBe(200);
    await expect(getRes.json()).resolves.toEqual({ path: expected });
    expect(fs.existsSync(expected)).toBe(false);

    const postRes = await app.request("/api/config/default-workspace", { method: "POST" });
    expect(postRes.status).toBe(200);
    await expect(postRes.json()).resolves.toEqual({ ok: true, path: expected });
    expect(fs.statSync(expected).isDirectory()).toBe(true);

    homedirSpy.mockRestore();
  });
});
