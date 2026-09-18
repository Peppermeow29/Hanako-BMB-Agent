import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserManager } from "../lib/browser/browser-manager.ts";
import { createBrowserTool } from "../lib/tools/browser-tool.ts";
import { resolveToolInvocationPermission } from "../lib/permission/tool-invocation-permission.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browser tool invocation descriptors", () => {
  it("preserves the existing read versus interaction action boundary", () => {
    const tool = createBrowserTool(() => null);
    const readActions = ["snapshot", "screenshot", "scroll", "wait", "show"];
    const routineActions = ["start", "stop"];
    const reviewActions = ["navigate", "click", "type", "select", "key", "evaluate"];

    for (const action of readActions) {
      expect(resolveToolInvocationPermission(tool, { action })).toMatchObject({
        ok: true,
        source: "descriptor",
        descriptor: { action, kind: "read", capability: `browser.${action}` },
      });
    }
    for (const action of routineActions) {
      expect(resolveToolInvocationPermission(tool, { action })).toMatchObject({
        ok: true,
        source: "descriptor",
        descriptor: { action, kind: "routine", capability: `browser.${action}` },
      });
    }
    for (const action of reviewActions) {
      const input = action === "navigate"
        ? { action }
        : { action, tabId: "tab-boundary" };
      expect(resolveToolInvocationPermission(tool, input)).toMatchObject({
        ok: true,
        source: "descriptor",
        descriptor: { action, kind: "review", capability: `browser.${action}` },
      });
    }
  });

  it("fails closed for an action outside the browser schema", () => {
    expect(resolveToolInvocationPermission(createBrowserTool(() => null), { action: "download" }))
      .toMatchObject({ ok: false, error: { reason: "resolver_rejected" } });
  });

  it("binds navigate review to the normalized destination URL", () => {
    const tool = createBrowserTool(() => null);

    expect(resolveToolInvocationPermission(tool, {
      action: "navigate",
      url: "HTTPS://Example.COM:443/a/../b?q=one#section",
    })).toMatchObject({
      ok: true,
      source: "descriptor",
      descriptor: {
        action: "navigate",
        kind: "review",
        capability: "browser.navigate",
        target: {
          type: "url",
          id: "https://example.com/b?q=one#section",
        },
        sideEffect: {
          destinationUrl: "https://example.com/b?q=one#section",
        },
      },
    });
  });

  it("keeps invalid or oversized navigate destinations under review without inventing a target", () => {
    const tool = createBrowserTool(() => null);

    expect(resolveToolInvocationPermission(tool, {
      action: "navigate",
      url: "file:///tmp/private.txt",
    })).toMatchObject({
      ok: true,
      descriptor: {
        action: "navigate",
        kind: "review",
      },
    });
    expect(resolveToolInvocationPermission(tool, {
      action: "navigate",
      url: `https://example.com/${"a".repeat(5000)}`,
    })).toMatchObject({
      ok: true,
      descriptor: {
        action: "navigate",
        kind: "review",
      },
    });

    const invalid = resolveToolInvocationPermission(tool, {
      action: "navigate",
      url: "file:///tmp/private.txt",
    });
    const oversized = resolveToolInvocationPermission(tool, {
      action: "navigate",
      url: `https://example.com/${"a".repeat(5000)}`,
    });
    expect(invalid.ok && invalid.descriptor).not.toHaveProperty("target");
    expect(oversized.ok && oversized.descriptor).not.toHaveProperty("target");
  });

  it.each(["click", "type", "select", "key", "evaluate"])(
    "binds %s review only to the explicit tab id",
    (action) => {
      const manager = new BrowserManager();
      manager._setSessionEntry("/sessions/permission.jsonl", {
        running: true,
        headless: false,
        activeTabId: "tab-explicit",
        tabs: [{
          tabId: "tab-explicit",
          title: "Observed",
          url: "https://observed.example/path",
        }],
      });
      vi.spyOn(BrowserManager, "instance").mockReturnValue(manager);
      const tool = createBrowserTool(() => null);

      expect(resolveToolInvocationPermission(tool, {
        action,
        tabId: "tab-explicit",
      })).toMatchObject({
        ok: true,
        source: "descriptor",
        descriptor: {
          action,
          kind: "review",
          capability: `browser.${action}`,
          target: {
            type: "browser_tab",
            id: "tab-explicit",
          },
        },
      });
      const resolution = resolveToolInvocationPermission(tool, {
        action,
        tabId: "tab-explicit",
      });
      expect(resolution.ok && resolution.descriptor).not.toHaveProperty("sideEffect");
      expect(resolution.ok && resolution.descriptor?.target).not.toHaveProperty("label");
    },
  );

  it.each(["click", "type", "select", "key", "evaluate"])(
    "fails closed when %s omits the exact tab id",
    (action) => {
      const manager = new BrowserManager();
      manager._setSessionEntry("/sessions/focused.jsonl", {
        running: true,
        headless: false,
        activeTabId: "tab-focused",
        tabs: [{ tabId: "tab-focused", title: "Focused", url: "https://focused.example" }],
      });
      vi.spyOn(BrowserManager, "instance").mockReturnValue(manager);
      const tool = createBrowserTool(() => "/sessions/focused.jsonl");

      expect(resolveToolInvocationPermission(tool, { action, ref: 4 })).toMatchObject({
        ok: false,
        error: {
          code: "TOOL_INVOCATION_RESOLVER_FAILED",
          reason: "resolver_rejected",
        },
      });
    },
  );

  it("rejects malformed interaction tab ids instead of broadening the target", () => {
    const manager = new BrowserManager();
    vi.spyOn(BrowserManager, "instance").mockReturnValue(manager);
    const tool = createBrowserTool(() => null);

    for (const tabId of [" tab-1", "tab-*", "tab-?", "tab-1\n"]) {
      expect(resolveToolInvocationPermission(tool, {
        action: "click",
        ref: 4,
        tabId,
      })).toMatchObject({
        ok: false,
        error: { reason: "resolver_rejected" },
      });
    }
  });

  it("returns the active tab id in snapshot content so the next mutation can bind it", async () => {
    const sessionPath = "/sessions/snapshot.jsonl";
    const manager = new BrowserManager();
    manager._setSessionEntry(sessionPath, {
      running: false,
      headless: false,
      activeTabId: "tab-from-host",
      tabs: [{
        tabId: "tab-from-host",
        title: "Snapshot",
        url: "https://snapshot.example",
      }],
    });
    manager.snapshot = vi.fn(async () => "Page: Snapshot\nURL: https://snapshot.example");
    vi.spyOn(BrowserManager, "instance").mockReturnValue(manager);
    const tool = createBrowserTool(() => sessionPath);

    const result = await tool.execute(
      "call-snapshot",
      { action: "snapshot" },
      null,
      null,
      { sessionPath },
    );

    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining('Browser tabId (copy exactly): "tab-from-host"'),
    });
  });
});

describe("browser tool authorization revocation", () => {
  const sessionPath = "/sessions/revoked.jsonl";

  function revokedHarness() {
    const manager = new BrowserManager();
    manager._setSessionEntry(sessionPath, {
      running: true,
      headless: false,
      activeTabId: "tab-revoked",
      tabs: [{ tabId: "tab-revoked", title: "Revoked", url: "https://revoked.example" }],
    });
    manager.navigate = vi.fn(async () => ({ url: "https://example.com" }));
    manager.thumbnail = vi.fn(async () => null);
    vi.spyOn(BrowserManager, "instance").mockReturnValue(manager);
    return { manager, tool: createBrowserTool(() => sessionPath) };
  }

  it("returns the revocation notice instead of acting when authorization is revoked", async () => {
    const { manager, tool } = revokedHarness();
    manager.isBrowserAuthorizationRevoked = vi.fn(() => true);

    const result: any = await tool.execute(
      "call-revoked",
      { action: "navigate", url: "https://example.com" },
      null,
      null,
      { sessionPath },
    );

    expect(result.details.status).toBe("authorization_revoked");
    expect(result.details.running).toBe(false);
    expect(result.isError).toBeUndefined();
    expect(manager.navigate).not.toHaveBeenCalled();
  });

  it("maps in-flight failures to the revocation notice when the user stopped the browser", async () => {
    const { manager, tool } = revokedHarness();
    manager.isBrowserAuthorizationRevoked = vi.fn(() => false);
    manager.navigate = vi.fn(async () => {
      manager.isBrowserAuthorizationRevoked = vi.fn(() => true);
      throw new Error("Object has been destroyed");
    });

    const result: any = await tool.execute(
      "call-revoked-inflight",
      { action: "navigate", url: "https://example.com" },
      null,
      null,
      { sessionPath },
    );

    expect(result.details.status).toBe("authorization_revoked");
    expect(result.isError).toBeUndefined();
  });
});
