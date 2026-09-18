import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { createDeferredResultExtension } from "../lib/extensions/deferred-result-ext.ts";
import { DeferredResultStore } from "../lib/deferred-result-store.ts";

function createMockPi() {
  const handlers: any = {};
  return {
    on: vi.fn((event, handler) => {
      handlers[event] = handler;
    }),
    sendMessage: vi.fn(),
    _trigger(event, ...args) {
      handlers[event]?.(...args);
    },
  };
}

describe("DeferredResultExtension", () => {
  let store, pi, factory;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new (DeferredResultStore as any)();
    factory = createDeferredResultExtension(store);
    pi = createMockPi();
    factory(pi);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes to session_start and session_shutdown", () => {
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("does not realtime-deliver newly resolved tasks through the extension", () => {
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    store.defer("t1", "/s/a", { type: "image-generation" });
    store.resolve("t1", { files: ["img.png"] });

    expect(pi.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ customType: "hana-background-result" }),
      expect.anything(),
    );
  });

  it("keeps session-start undelivered fallback for compatibility", async () => {
    store.defer("t1", "/s/a", { type: "image-generation" });
    store.resolve("t1", { files: ["img.png"] });

    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    await vi.advanceTimersByTimeAsync(500);

    const [msg, opts] = pi.sendMessage.mock.calls.find(([message]) => (
      message.customType === "hana-background-result"
    ));
    expect(msg.customType).toBe("hana-background-result");
    expect(msg.content).toContain("task-id=\"t1\"");
    expect(msg.content).toContain("status=\"success\"");
    expect(opts.deliverAs).toBe("steer");
    expect(opts.triggerTurn).toBe(true);
  });

  it("does not session-start deliver UI-only media results into the agent context", async () => {
    store.defer("t1", "/s/a", {
      type: "image-generation",
      deliveryIntent: "ui_only",
      triggerParentTurn: false,
    });
    store.resolve("t1", { files: ["img.png"] });

    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    await vi.advanceTimersByTimeAsync(500);

    expect(pi.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ customType: "hana-background-result" }),
      expect.anything(),
    );
    expect(store.query("t1")).toMatchObject({ delivered: false });
  });

  it("session-start delivers failed UI-only image results when failure notification is enabled", async () => {
    store.defer("t1", "/s/a", {
      type: "image-generation",
      deliveryIntent: "ui_only",
      triggerParentTurn: false,
      notifyAgentOnFailure: true,
    });
    store.fail("t1", "quota exhausted");

    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    await vi.advanceTimersByTimeAsync(500);

    const [msg, opts] = pi.sendMessage.mock.calls.find(([message]) => (
      message.customType === "hana-background-result"
    ));
    expect(msg.content).toContain("status=\"failed\"");
    expect(msg.content).toContain("quota exhausted");
    expect(opts).toMatchObject({ deliverAs: "steer", triggerTurn: true });
    expect(store.query("t1")).toMatchObject({ delivered: true });
  });

  it("does not fallback-deliver bridge-owned tasks through Pi session_start", async () => {
    store.defer("t1", "/s/a", {
      type: "image-generation",
      deliveryTarget: { kind: "bridge", platform: "wechat", chatId: "wx-user" },
    });
    store.resolve("t1", { files: ["img.png"] });

    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    await vi.advanceTimersByTimeAsync(500);

    expect(pi.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ customType: "hana-background-result" }),
      expect.anything(),
    );
    expect(store.query("t1").delivered).toBe(false);
  });

  it("does NOT send notification for a different session", () => {
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    store.defer("t1", "/s/b", { type: "image-generation" });
    store.resolve("t1", { files: [] });
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("sends failure notification", () => {
    store.defer("t1", "/s/a", { type: "image-generation" });
    store.fail("t1", "credit exhausted");
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    vi.advanceTimersByTime(500);

    const [msg] = pi.sendMessage.mock.calls.find(([message]) => (
      message.customType === "hana-background-result"
    ));
    expect(msg.content).toContain("status=\"failed\"");
    expect(msg.content).toContain("credit exhausted");
  });

  it("unsubscribes on session_shutdown", () => {
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    pi._trigger("session_shutdown");

    store.defer("t2", "/s/a", {});
    store.resolve("t2", {});
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("catches sendMessage errors without breaking", () => {
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    pi.sendMessage.mockImplementation(() => {
      throw new Error("boom");
    });

    store.defer("t1", "/s/a", {});
    expect(() => store.resolve("t1", {})).not.toThrow();
  });

  it("escapes XML special characters in content", () => {
    store.defer("t1", "/s/a", { type: "test" });
    store.resolve("t1", { message: "a < b & c > d" });
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    vi.advanceTimersByTime(500);

    const [msg] = pi.sendMessage.mock.calls.find(([message]) => (
      message.customType === "hana-background-result"
    ));
    expect(msg.content).not.toContain("< b");
    expect(msg.content).toContain("&lt;");
    expect(msg.content).toContain("&amp;");
  });
});
