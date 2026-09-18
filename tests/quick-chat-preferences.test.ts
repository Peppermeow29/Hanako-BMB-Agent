import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_QUICK_CHAT_SHORTCUT,
  DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES,
  normalizeQuickChatPreferences,
} from "../shared/quick-chat-preferences.ts";
import { createPreferencesRoute } from "../server/routes/preferences.ts";

describe("quick chat preferences", () => {
  it("defaults to the ChatGPT-style global shortcut", () => {
    expect(DEFAULT_QUICK_CHAT_SHORTCUT).toBe("Alt+Space");
    expect(DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES).toBe(10);
    expect(normalizeQuickChatPreferences()).toEqual({
      shortcut: "Alt+Space",
      reuseTimeoutMinutes: 10,
    });
  });

  it("keeps valid user accelerators and rejects empty shortcuts", () => {
    expect(normalizeQuickChatPreferences({ shortcut: "CommandOrControl+Shift+K" })).toEqual({
      shortcut: "CommandOrControl+Shift+K",
      reuseTimeoutMinutes: 10,
    });
    expect(normalizeQuickChatPreferences({ shortcut: "" })).toEqual({
      shortcut: "Alt+Space",
      reuseTimeoutMinutes: 10,
    });
  });

  it("normalizes quick chat reuse timeout minutes", () => {
    expect(normalizeQuickChatPreferences({ reuseTimeoutMinutes: 5 })).toEqual({
      shortcut: "Alt+Space",
      reuseTimeoutMinutes: 5,
    });
    expect(normalizeQuickChatPreferences({ reuseTimeoutMinutes: "12.7" })).toEqual({
      shortcut: "Alt+Space",
      reuseTimeoutMinutes: 13,
    });
    expect(normalizeQuickChatPreferences({ reuseTimeoutMinutes: -1 })).toEqual({
      shortcut: "Alt+Space",
      reuseTimeoutMinutes: 0,
    });
    expect(normalizeQuickChatPreferences({ reuseTimeoutMinutes: 999 })).toEqual({
      shortcut: "Alt+Space",
      reuseTimeoutMinutes: 120,
    });
  });

  it("normalizes macOS Option+Space recorder output to a valid accelerator", () => {
    expect(normalizeQuickChatPreferences({ shortcut: "Alt+\u00A0" })).toEqual({
      shortcut: "Alt+Space",
      reuseTimeoutMinutes: 10,
    });
    expect(normalizeQuickChatPreferences({ shortcut: "Alt+" })).toEqual({
      shortcut: "Alt+Space",
      reuseTimeoutMinutes: 10,
    });
  });

  it("reads and updates quick chat preferences through the preferences route", async () => {
    let quickChat = { shortcut: "Alt+Space", reuseTimeoutMinutes: 10 };
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({})),
      getUtilityApi: vi.fn(() => ({})),
      getQuickChatPreferences: vi.fn(() => quickChat),
      setQuickChatPreferences: vi.fn((patch) => {
        quickChat = normalizeQuickChatPreferences({ ...quickChat, ...patch });
        return quickChat;
      }),
    };
    const app = new Hono();
    app.route("/api", createPreferencesRoute(engine));

    const initial = await app.request("/api/preferences/quick-chat");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ quickChat: { shortcut: "Alt+Space", reuseTimeoutMinutes: 10 } });

    const updated = await app.request("/api/preferences/quick-chat", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quickChat: { shortcut: "CommandOrControl+Shift+K" } }),
    });

    expect(updated.status).toBe(200);
    expect(engine.setQuickChatPreferences).toHaveBeenCalledWith({
      shortcut: "CommandOrControl+Shift+K",
    });
    expect(await updated.json()).toEqual({
      ok: true,
      quickChat: { shortcut: "CommandOrControl+Shift+K", reuseTimeoutMinutes: 10 },
    });
  });
});
