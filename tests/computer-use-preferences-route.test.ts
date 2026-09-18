import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createPreferencesRoute } from "../server/routes/preferences.ts";

describe("removed Computer Use compatibility routes", () => {
  it.each(["darwin", "win32", "linux"])("preserves settings without starting providers on %s", async (platform) => {
    const stored = { enabled: true, app_approvals: [{ providerId: "macos:cua", appId: "example" }] };
    const engine = { getComputerUseSettings: () => stored, getComputerHost: vi.fn() };
    const app = new Hono();
    app.route("/api", createPreferencesRoute(engine, { platform }));
    const res = await app.request("/api/preferences/computer-use");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      settings: { enabled: false, app_approvals: stored.app_approvals },
      selectedProviderId: null,
      status: { supported: false, enabled: false, providers: [], activeLease: null },
    });
    expect(stored.enabled).toBe(true);
    expect(engine.getComputerHost).not.toHaveBeenCalled();
  });
  it.each([
    ["PUT", ""], ["POST", "/request-permissions"], ["POST", "/approvals"], ["DELETE", "/approvals"],
  ])("rejects %s %s before any engine mutation", async (method, suffix) => {
    const engine = { setComputerUseSettings: vi.fn(), getComputerHost: vi.fn(), approveComputerUseApp: vi.fn(), revokeComputerUseApp: vi.fn() };
    const app = new Hono();
    app.route("/api", createPreferencesRoute(engine));
    const res = await app.request("/api/preferences/computer-use" + suffix, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: "FEATURE_UNAVAILABLE" });
    for (const fn of Object.values(engine)) expect(fn).not.toHaveBeenCalled();
  });
});
