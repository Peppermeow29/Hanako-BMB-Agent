import { beforeEach, describe, expect, it, vi } from "vitest";
import os from "os";
import { Hono } from "hono";

const factories = vi.hoisted(() => ({ feishu: vi.fn(), wechat: vi.fn() }));
vi.mock("../lib/bridge/feishu-adapter.ts", () => ({ createFeishuAdapter: factories.feishu }));
vi.mock("../lib/bridge/wechat-adapter.ts", () => ({ createWechatAdapter: factories.wechat }));

import { BridgeManager } from "../lib/bridge/bridge-manager.ts";
import { buildBridgeStatus, createBridgeRoute } from "../server/routes/bridge.ts";

function setup() {
  const bridge = {
    telegram: { enabled: true, token: "old-tg-secret" },
    qq: { enabled: true, appID: "qq", appSecret: "old-qq-secret" },
    dingtalk: { enabled: true, clientId: "dt", clientSecret: "old-dt-secret" },
    wechat: { enabled: true, botToken: "wx-secret" },
    feishu: { enabled: true, appId: "fs", appSecret: "fs-secret" },
  };
  const agent = { id: "hana", config: { bridge }, updateConfig: vi.fn() };
  const engine = { hanakoHome: os.tmpdir(), getAgent: vi.fn(() => agent), getBridgeIndex: () => ({}) };
  const hub = { eventBus: { emit: vi.fn() } };
  const manager = new BridgeManager({ engine, hub });
  return { agent, engine, manager };
}

describe("slim bridge runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    factories.wechat.mockReturnValue({ stop: vi.fn() });
    factories.feishu.mockReturnValue({ stop: vi.fn() });
  });

  it("auto-starts only WeChat/Feishu without rewriting legacy credentials", () => {
    const { agent, manager } = setup();
    const before = JSON.stringify(agent.config);
    manager.autoStart(new Map([[agent.id, agent]]));
    expect(factories.wechat).toHaveBeenCalledOnce();
    expect(factories.feishu).toHaveBeenCalledOnce();
    expect(Object.keys(manager.getStatus(agent.id)).sort()).toEqual(["feishu", "wechat"]);
    expect(manager.getStatus(agent.id).wechat.status).toBe("connecting");
    expect(JSON.stringify(agent.config)).toBe(before);
    expect(agent.updateConfig).not.toHaveBeenCalled();
    manager.stopPlatform("wechat", agent.id);
    manager.stopPlatform("feishu", agent.id);
  });

  it.each(["telegram", "qq", "dingtalk"])("rejects direct startup of %s", platform => {
    const { agent, manager } = setup();
    expect(() => manager.startPlatformFromConfig(platform, agent.config.bridge[platform], agent.id)).toThrow(/not included/);
    expect(() => manager.startPlatform(platform, {}, agent.id)).toThrow(/not included/);
    expect(manager.getStatus(agent.id)[platform]).toBeUndefined();
  });

  it("projects unavailable legacy platforms while retaining masked status and config", () => {
    const { agent, engine } = setup();
    const before = JSON.stringify(agent.config);
    const status = buildBridgeStatus(engine, { getStatus: () => ({ telegram: { status: "connected" } }) }, agent);
    for (const p of ["telegram", "qq", "dingtalk"]) {
      expect(status[p]).toMatchObject({ enabled: false, supported: false, status: "disconnected" });
      expect(status[p].error).toMatch(/not included/);
    }
    expect(status.wechat.enabled).toBe(true);
    expect(status.feishu.enabled).toBe(true);
    for (const secret of ["old-tg-secret", "old-qq-secret", "old-dt-secret", "wx-secret", "fs-secret"]) expect(JSON.stringify(status)).not.toContain(secret);
    expect(JSON.stringify(agent.config)).toBe(before);
  });

  it.each(["telegram", "qq", "dingtalk"].flatMap(platform =>
    ["config", "owner", "stop", "test", "send-media"].map(endpoint => ({ platform, endpoint })),
  ))("rejects $platform $endpoint before accessing config or network", async ({ platform, endpoint }) => {
    const { agent, engine, manager } = setup();
    const before = JSON.stringify(agent.config);
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, manager));
    const res = await app.request(`/api/bridge/${endpoint}?agentId=hana`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, enabled: true, useSavedCredentials: true, chatId: "test", filePath: "/not-read" }),
    });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ ok: false, code: "FEATURE_UNAVAILABLE" });
    expect(engine.getAgent).not.toHaveBeenCalled();
    expect(agent.updateConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(agent.config)).toBe(before);
    expect(factories.wechat).not.toHaveBeenCalled();
    expect(factories.feishu).not.toHaveBeenCalled();
  });
});
