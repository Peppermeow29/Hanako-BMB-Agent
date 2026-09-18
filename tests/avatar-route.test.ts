import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createAvatarRoute } from "../server/routes/avatar.ts";

/**
 * The agent half of /api/avatar/:role names an agent directory. The request has
 * to say which agent that is: picking whichever agent the server happens to be
 * focused on serves one client the other client's face, and writes the upload
 * into the wrong agent's folder.
 */
describe("avatar route", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-avatar-route-"));

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
  });

  function buildApp() {
    const userDir = path.join(tempRoot, "user");
    const hanaDir = path.join(tempRoot, "agents", "hana");
    const otherDir = path.join(tempRoot, "agents", "other");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(hanaDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });

    const agents = {
      hana: { id: "hana", agentDir: hanaDir },
      other: { id: "other", agentDir: otherDir },
    };
    const engine = {
      userDir,
      // Focus pointer: present on the real engine, and must not be consulted here.
      currentAgentId: "hana",
      agentDir: hanaDir,
      getAgent: (id: string) => agents[id] || null,
    };
    const app = new Hono();
    app.route("/api", createAvatarRoute(engine));
    return { app, userDir, hanaDir, otherDir };
  }

  const PNG_DATA_URL = "data:image/png;base64,aGVsbG8=";

  it("refuses to guess an agent when the request omits agentId", async () => {
    const { app } = buildApp();
    for (const [method, url] of [
      ["GET", "/api/avatar/agent"],
      ["POST", "/api/avatar/agent"],
      ["DELETE", "/api/avatar/agent"],
    ] as const) {
      const res = await app.request(url, {
        method,
        ...(method === "POST"
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: PNG_DATA_URL }) }
          : {}),
      });
      expect(res.status, `${method} ${url}`).toBe(404);
    }
  });

  it("writes and reads the agent named by the request, not the focused one", async () => {
    const { app, hanaDir, otherDir } = buildApp();

    const res = await app.request("/api/avatar/agent?agentId=other", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: PNG_DATA_URL }),
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(otherDir, "avatars", "agent.png"))).toBe(true);
    expect(fs.existsSync(path.join(hanaDir, "avatars", "agent.png"))).toBe(false);

    const read = await app.request("/api/avatar/agent?agentId=other");
    expect(read.status).toBe(200);

    const focused = await app.request("/api/avatar/agent?agentId=hana");
    expect(focused.status).toBe(404);
  });

  it("404s an agentId that names no agent", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/avatar/agent?agentId=ghost");
    expect(res.status).toBe(404);
  });

  it("keeps the user avatar agent-independent", async () => {
    const { app, userDir } = buildApp();
    const res = await app.request("/api/avatar/user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: PNG_DATA_URL }),
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(userDir, "avatars", "user.png"))).toBe(true);
    expect((await app.request("/api/avatar/user")).status).toBe(200);
  });
});
