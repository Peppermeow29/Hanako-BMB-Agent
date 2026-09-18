import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BROWSER_PREFERENCES,
  normalizeBrowserPreferences,
} from "../shared/browser-preferences.ts";
import { PreferencesManager } from "../core/preferences-manager.ts";
import { createPreferencesRoute } from "../server/routes/preferences.ts";
import fs from "fs";
import os from "os";
import path from "path";

describe("browser preferences", () => {
  it("defaults to accepting Cookies and smart Agent tab opening", () => {
    expect(DEFAULT_BROWSER_PREFERENCES).toEqual({
      acceptCookies: true,
      agentOpenBehavior: "smart",
    });
    expect(normalizeBrowserPreferences()).toEqual(DEFAULT_BROWSER_PREFERENCES);
  });

  it("normalizes invalid values back to user-safe defaults", () => {
    expect(normalizeBrowserPreferences({
      acceptCookies: "false",
      agentOpenBehavior: "sideways",
    })).toEqual(DEFAULT_BROWSER_PREFERENCES);
    expect(normalizeBrowserPreferences({
      acceptCookies: false,
      agentOpenBehavior: "new_tab",
    })).toEqual({
      acceptCookies: false,
      agentOpenBehavior: "new_tab",
    });
  });

  it("persists browser preferences through PreferencesManager", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-browser-prefs-"));
    const userDir = path.join(root, "user");
    const manager = new PreferencesManager({ userDir, agentsDir: path.join(root, "agents") });

    expect(manager.getBrowserPreferences()).toEqual(DEFAULT_BROWSER_PREFERENCES);

    manager.setBrowserPreferences({ acceptCookies: false, agentOpenBehavior: "current_tab" });

    expect(manager.getBrowserPreferences()).toEqual({
      acceptCookies: false,
      agentOpenBehavior: "current_tab",
    });
    const stored = JSON.parse(fs.readFileSync(path.join(userDir, "preferences.json"), "utf-8"));
    expect(stored.browser).toEqual({
      acceptCookies: false,
      agentOpenBehavior: "current_tab",
    });
  });

  it("reads and updates browser preferences through the preferences route", async () => {
    let browser = DEFAULT_BROWSER_PREFERENCES;
    const applyBrowserPreferences = vi.fn(async (settings) => {
      browser = normalizeBrowserPreferences(settings);
      return browser;
    });
    const engine = {
      getBrowserPreferences: vi.fn(() => browser),
      setBrowserPreferences: vi.fn((patch) => {
        browser = normalizeBrowserPreferences({ ...browser, ...patch });
        return browser;
      }),
    };
    const app = new Hono();
    app.route("/api", createPreferencesRoute(engine, {
      applyBrowserPreferences,
      clearBrowserCookiesAndSiteData: vi.fn(async () => ({ ok: true })),
    }));

    const initial = await app.request("/api/preferences/browser");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ browser: DEFAULT_BROWSER_PREFERENCES });

    const updated = await app.request("/api/preferences/browser", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser: { acceptCookies: false, agentOpenBehavior: "new_tab" } }),
    });

    expect(updated.status).toBe(200);
    expect(engine.setBrowserPreferences).toHaveBeenCalledWith({
      acceptCookies: false,
      agentOpenBehavior: "new_tab",
    });
    expect(applyBrowserPreferences).toHaveBeenCalledWith({
      acceptCookies: false,
      agentOpenBehavior: "new_tab",
    });
    expect(await updated.json()).toEqual({
      ok: true,
      browser: { acceptCookies: false, agentOpenBehavior: "new_tab" },
    });
  });

  it("clears browser Cookies through the preferences route", async () => {
    const clearBrowserCookiesAndSiteData = vi.fn(async () => ({ ok: true }));
    const engine = {
      getBrowserPreferences: vi.fn(() => DEFAULT_BROWSER_PREFERENCES),
      setBrowserPreferences: vi.fn((patch) => normalizeBrowserPreferences(patch)),
    };
    const app = new Hono();
    app.route("/api", createPreferencesRoute(engine, {
      clearBrowserCookiesAndSiteData,
      applyBrowserPreferences: vi.fn(),
    }));

    const res = await app.request("/api/preferences/browser/clear-cookies", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(clearBrowserCookiesAndSiteData).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({ ok: true });
  });
});
