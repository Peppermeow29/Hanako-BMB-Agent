import fs from "fs";
import os from "os";
import path from "path";
import ExcelJS from "exceljs";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFsRoute } from "../server/routes/fs.ts";

describe("fs route", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-fs-route-"));

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
  });

  function buildApp({ hanakoHome, workspace, otherWorkspace = null }) {
    const app = new Hono();
    const desks: Record<string, string> = { hana: workspace };
    if (otherWorkspace) desks.mio = otherWorkspace;
    const engine = {
      hanakoHome,
      currentAgentId: "hana",
      getHomeCwd: vi.fn((agentId) => desks[agentId] || null),
      listAgents: () => Object.keys(desks).map((id) => ({ id })),
      getAgent(id) {
        if (!desks[id]) return null;
        return {
          id,
          config: { desk: { home_folder: desks[id] } },
          deskManager: {},
        };
      },
    };
    app.route("/api", createFsRoute(engine));
    return app;
  }

  it("rejects symlink escapes from an allowed workspace", async () => {
    const hanakoHome = path.join(tempRoot, "hanako");
    const workspace = path.join(tempRoot, "workspace");
    const outsideDir = path.join(tempRoot, "outside");
    fs.mkdirSync(path.join(hanakoHome, "user"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const outsideFile = path.join(outsideDir, "secret.txt");
    const linkedFile = path.join(workspace, "secret-link.txt");
    fs.writeFileSync(outsideFile, "top secret", "utf-8");
    fs.symlinkSync(outsideFile, linkedFile);

    const app = buildApp({ hanakoHome, workspace });
    const res = await app.request(`/api/fs/read?path=${encodeURIComponent(linkedFile)}`);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "path not allowed" });
  });

  it("keeps missing files inside the workspace as 404 instead of 403", async () => {
    const hanakoHome = path.join(tempRoot, "hanako");
    const workspace = path.join(tempRoot, "workspace");
    fs.mkdirSync(path.join(hanakoHome, "user"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });

    const missingFile = path.join(workspace, "missing.txt");
    const app = buildApp({ hanakoHome, workspace });
    const res = await app.request(`/api/fs/read?path=${encodeURIComponent(missingFile)}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "file not found" });
  });

  it("serves every agent's desk, not only the one the server is focused on", async () => {
    const hanakoHome = path.join(tempRoot, "hanako");
    const workspace = path.join(tempRoot, "workspace");
    const otherWorkspace = path.join(tempRoot, "other-workspace");
    fs.mkdirSync(path.join(hanakoHome, "user"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(otherWorkspace, { recursive: true });

    const otherFile = path.join(otherWorkspace, "notes.txt");
    fs.writeFileSync(otherFile, "second desk", "utf-8");
    const homeFile = path.join(hanakoHome, "user", "prefs.txt");
    fs.writeFileSync(homeFile, "home file", "utf-8");

    const app = buildApp({ hanakoHome, workspace, otherWorkspace });

    // No agentId in the request, and the file belongs to the agent the server
    // is not focused on: still served, because the token is what decides
    // access here and it is not scoped to one agent.
    const otherRes = await app.request(`/api/fs/read?path=${encodeURIComponent(otherFile)}`);
    expect(otherRes.status).toBe(200);
    expect(await otherRes.text()).toBe("second desk");

    const homeRes = await app.request(`/api/fs/read?path=${encodeURIComponent(homeFile)}`);
    expect(homeRes.status).toBe(200);
    expect(await homeRes.text()).toBe("home file");
  });

  it("refuses paths outside every allowed root", async () => {
    const hanakoHome = path.join(tempRoot, "hanako");
    const workspace = path.join(tempRoot, "workspace");
    const outsideDir = path.join(tempRoot, "outside");
    fs.mkdirSync(path.join(hanakoHome, "user"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "top secret", "utf-8");

    const app = buildApp({ hanakoHome, workspace });

    const plainRes = await app.request(`/api/fs/read?path=${encodeURIComponent(outsideFile)}`);
    expect(plainRes.status).toBe(403);
    expect(await plainRes.json()).toEqual({ error: "path not allowed" });

    // Climbing out of an allowed root lands in the same place.
    const escape = path.join(workspace, "..", "outside", "secret.txt");
    const escapeRes = await app.request(`/api/fs/read?path=${encodeURIComponent(escape)}`);
    expect(escapeRes.status).toBe(403);
    expect(await escapeRes.json()).toEqual({ error: "path not allowed" });
  });

  it("renders allowed xlsx files as HTML for the web preview fallback", async () => {
    const hanakoHome = path.join(tempRoot, "hanako");
    const workspace = path.join(tempRoot, "workspace");
    fs.mkdirSync(path.join(hanakoHome, "user"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });

    const workbookPath = path.join(workspace, "budget.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Budget");
    sheet.addRow(["Name", "Value"]);
    sheet.addRow(["A&B", "<42>"]);
    await workbook.xlsx.writeFile(workbookPath);

    const app = buildApp({ hanakoHome, workspace });
    const res = await app.request(`/api/fs/xlsx-html?path=${encodeURIComponent(workbookPath)}`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<table><tr><td>Name</td><td>Value</td></tr><tr><td>A&amp;B</td><td>&lt;42&gt;</td></tr></table>");
  });
});
