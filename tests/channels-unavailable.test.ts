import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createChannelsRoute } from "../server/routes/channels.ts";
import { createDmRoute } from "../server/routes/dm.ts";
import { ConfigCoordinator } from "../core/config-coordinator.ts";

describe("retired channel boundaries", () => {
  const paths = [
    "/channels", "/channels/toggle", "/channels/ch_old", "/channels/ch_old/messages",
    "/channels/ch_old/members", "/channels/ch_old/read", "/channels/ch_old/members/old",
    "/dm", "/dm/old", "/dm/old/reset", "/conversations/ch_old/export",
    "/conversations/ch_old/agent-activities", "/conversations/ch_old/agent-phone-settings",
    "/conversations/ch_old/agent-phone-tool-mode",
  ];
  it.each(paths)("rejects %s before accessing configuration, disk or scheduling", async path => {
    const touched = vi.fn(() => { throw new Error("unexpected access"); });
    const engine = new Proxy({}, { get: touched });
    const app = new Hono();
    app.route("/api", createChannelsRoute(engine, engine));
    app.route("/api", createDmRoute(engine, engine));
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const res = await app.request("/api" + path, { method });
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ code: "FEATURE_UNAVAILABLE" });
    }
    expect(touched).not.toHaveBeenCalled();
  });
  it("does not read or overwrite saved channel preferences", async () => {
    const read = vi.fn(() => { throw new Error("must not read legacy config"); });
    const coordinator = new ConfigCoordinator({ getPrefs: read } as any);
    expect(coordinator.getChannelsEnabled()).toBe(false);
    await expect(coordinator.setChannelsEnabled(true)).rejects.toThrow("not included");
    await expect(coordinator.setChannelsEnabled(false)).rejects.toThrow("not included");
    expect(read).not.toHaveBeenCalled();
  });
});
