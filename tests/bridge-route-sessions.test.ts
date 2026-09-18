import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createBridgeRoute } from "../server/routes/bridge.ts";

let rootDir;

function makeApp() {
  const agentId = "hana";
  const sessionDir = path.join(rootDir, "agents", agentId, "sessions");
  const bridgeDir = path.join(sessionDir, "bridge");
  const sessionPath = path.join(bridgeDir, "owner", "tg-owner.jsonl");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "", "utf-8");

  const agent = {
    id: agentId,
    sessionDir,
    config: {
      bridge: {
        telegram: { owner: "owner" },
      },
    },
  };
  const engine = {
    currentAgentId: agentId,
    getAgent: (id) => (id === agentId ? agent : null),
    getBridgeIndex: () => ({
      "tg_dm_owner@hana": {
        file: "owner/tg-owner.jsonl",
        name: "Owner",
        avatarUrl: "https://example.com/avatar.png",
        userId: "owner",
        chatId: "owner",
      },
    }),
    getBridgeReadOnly: () => false,
    getBridgeReceiptEnabled: () => true,
  };

  const app = new Hono();
  app.route("/api", createBridgeRoute(engine, null));
  return { app, sessionPath };
}

describe("bridge sessions route", () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-route-"));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("returns the resolved sessionPath for ChatTranscript hydration", async () => {
    const { app, sessionPath } = makeApp();

    const res = await app.request("/api/bridge/sessions?platform=telegram&agentId=hana");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      sessionKey: "tg_dm_owner@hana",
      file: "owner/tg-owner.jsonl",
      sessionPath,
      displayName: "Owner",
      avatarUrl: "https://example.com/avatar.png",
    });
  });

  it("refuses to answer bridge reads for whichever agent the server is focused on", async () => {
    const { app } = makeApp();

    for (const url of [
      "/api/bridge/status",
      "/api/bridge/messages",
      "/api/bridge/sessions?platform=telegram",
      `/api/bridge/sessions/${encodeURIComponent("tg_dm_owner@hana")}/messages`,
    ]) {
      const res = await app.request(url);
      expect(res.status, url).toBe(404);
      expect((await res.json()).error, url).toMatch(/agentId/i);
    }
  });

  it("strips Bridge internal time tags from visible session messages", async () => {
    const { app, sessionPath } = makeApp();
    fs.writeFileSync(sessionPath, `${JSON.stringify({
      type: "message",
      timestamp: "2026-07-03T05:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "<t>07-03 13:00</t> hello" }],
      },
    })}\n`, "utf-8");

    const res = await app.request(`/api/bridge/sessions/${encodeURIComponent("tg_dm_owner@hana")}/messages?agentId=hana`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.messages[0]).toMatchObject({
      role: "user",
      content: "hello",
    });
  });

  it("returns refreshed bridge status after owner changes", async () => {
    const agentId = "hana";
    const sessionDir = path.join(rootDir, "agents", agentId, "sessions");
    const agent = {
      id: agentId,
      sessionDir,
      config: { bridge: { feishu: {} } },
      updateConfig(patch) {
        this.config.bridge = {
          ...this.config.bridge,
          ...patch.bridge,
          feishu: {
            ...(this.config.bridge.feishu || {}),
            ...(patch.bridge.feishu || {}),
          },
        };
      },
    };
    const engine = {
      currentAgentId: agentId,
      getAgent: (id) => (id === agentId ? agent : null),
      getBridgeIndex: () => ({
        "fs_dm_owner@hana": {
          file: "owner/tg-owner.jsonl",
          userId: "owner",
          name: "Owner",
        },
      }),
      getBridgeReadOnly: () => false,
      getBridgeReceiptEnabled: () => true,
    };
    const ownerApp = new Hono();
    ownerApp.route("/api", createBridgeRoute(engine, null));

    const res = await ownerApp.request("/api/bridge/owner?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "feishu", userId: "owner" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status.owner.feishu).toBe("owner");
  });

  it("marks QQ sessions as owner when configured owner matches a principal alias", async () => {
    const agentId = "hana";
    const sessionDir = path.join(rootDir, "agents", agentId, "sessions");
    const bridgeDir = path.join(sessionDir, "bridge");
    const sessionPath = path.join(bridgeDir, "owner", "qq-owner.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "", "utf-8");

    const agent = {
      id: agentId,
      sessionDir,
      config: {
        bridge: {
          qq: { owner: "c2c-openid" },
        },
      },
    };
    const engine = {
      currentAgentId: agentId,
      getAgent: (id) => (id === agentId ? agent : null),
      getBridgeIndex: () => ({
        "qq_dm_c2c-openid@hana": {
          file: "owner/qq-owner.jsonl",
          userId: "stable-user-id",
          chatId: "c2c-openid",
          qqPrincipal: {
            principalId: "stable-user-id",
            aliases: ["stable-user-id", "c2c-openid"],
          },
        },
      }),
      getBridgeReadOnly: () => false,
      getBridgeReceiptEnabled: () => true,
    };
    const qqApp = new Hono();
    qqApp.route("/api", createBridgeRoute(engine, null));

    const res = await qqApp.request("/api/bridge/sessions?platform=qq&agentId=hana");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sessions[0]).toMatchObject({
      sessionKey: "qq_dm_c2c-openid@hana",
      isOwner: true,
    });
  });
});
