import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PreferencesManager } from "../core/preferences-manager.ts";
import { createPreferencesRoute } from "../server/routes/preferences.ts";

function makePrefs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-prefs-notification-"));
  return new PreferencesManager({
    userDir: path.join(root, "user"),
    agentsDir: path.join(root, "agents"),
  });
}

function makeApp(engine) {
  const app = new Hono();
  app.route("/api", createPreferencesRoute(engine));
  return app;
}

describe("notification preferences", () => {
  it("defaults all completion notification categories to never", () => {
    const prefs = makePrefs();

    expect(prefs.getNotificationPreferences()).toEqual({
      chatCompletion: "never",
      scheduledTaskCompletion: "never",
      patrolCompletion: "never",
    });
  });

  it("reads the legacy turnCompletion preference as chatCompletion", () => {
    const prefs = makePrefs();

    prefs.savePreferences({ notifications: { turnCompletion: "when_session_unfocused" } });

    expect(prefs.getNotificationPreferences()).toEqual({
      chatCompletion: "when_session_unfocused",
      scheduledTaskCompletion: "never",
      patrolCompletion: "never",
    });
  });

  it("accepts a legacy turnCompletion patch from an older client", () => {
    const prefs = makePrefs();
    prefs.setNotificationPreferences({ chatCompletion: "when_unfocused" });

    expect(prefs.setNotificationPreferences({ turnCompletion: "when_session_unfocused" })).toEqual({
      chatCompletion: "when_session_unfocused",
      scheduledTaskCompletion: "never",
      patrolCompletion: "never",
    });
  });

  it("persists and normalizes the three notification categories", () => {
    const prefs = makePrefs();

    expect(prefs.setNotificationPreferences({
      chatCompletion: "when_session_unfocused",
      scheduledTaskCompletion: "always",
      patrolCompletion: "when_unfocused",
    })).toEqual({
      chatCompletion: "when_session_unfocused",
      scheduledTaskCompletion: "always",
      patrolCompletion: "when_unfocused",
    });
    expect(prefs.getPreferences().notifications).toEqual({
      chatCompletion: "when_session_unfocused",
      scheduledTaskCompletion: "always",
      patrolCompletion: "when_unfocused",
    });
    expect(prefs.setNotificationPreferences({
      chatCompletion: "sometimes",
      scheduledTaskCompletion: "when_session_unfocused",
      patrolCompletion: "sometimes",
    })).toEqual({
      chatCompletion: "never",
      scheduledTaskCompletion: "never",
      patrolCompletion: "never",
    });
  });

  it("reads and updates notification preferences through the route", async () => {
    let notifications = {
      chatCompletion: "never",
      scheduledTaskCompletion: "never",
      patrolCompletion: "never",
    };
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({})),
      getUtilityApi: vi.fn(() => ({})),
      getNotificationPreferences: vi.fn(() => notifications),
      setNotificationPreferences: vi.fn((patch) => {
        notifications = {
          ...notifications,
          ...patch,
        };
        return notifications;
      }),
    };
    const app = makeApp(engine);

    const initial = await app.request("/api/preferences/notifications");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      notifications: {
        chatCompletion: "never",
        scheduledTaskCompletion: "never",
        patrolCompletion: "never",
      },
    });

    const updated = await app.request("/api/preferences/notifications", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        notifications: {
          chatCompletion: "when_session_unfocused",
          scheduledTaskCompletion: "always",
          patrolCompletion: "when_unfocused",
        },
      }),
    });

    expect(updated.status).toBe(200);
    expect(engine.setNotificationPreferences).toHaveBeenCalledWith({
      chatCompletion: "when_session_unfocused",
      scheduledTaskCompletion: "always",
      patrolCompletion: "when_unfocused",
    });
    expect(await updated.json()).toEqual({
      ok: true,
      notifications: {
        chatCompletion: "when_session_unfocused",
        scheduledTaskCompletion: "always",
        patrolCompletion: "when_unfocused",
      },
    });
  });
});
