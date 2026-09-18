import { describe, expect, it, vi } from "vitest";
import { BrowserManager } from "../lib/browser/browser-manager.ts";

const SP1 = "/sessions/session-1.json";
const SP2 = "/sessions/session-2.json";
const SP3 = "/sessions/session-3.json";
const SP4 = "/sessions/session-4.json";
const SP5 = "/sessions/session-5.json";
const SP6 = "/sessions/session-6.json";

describe("BrowserManager URL tracking (per-session)", () => {
  it("forks a live tab workspace into an independent cold child and never shares the live view", () => {
    const sessionIds = new Map([
      [SP1, "sess-source"],
      [SP2, "sess-child"],
    ]);
    const manager = new BrowserManager({
      getSessionIdForPath: (sessionPath) => sessionIds.get(sessionPath) || null,
    });
    let coldState: any = {};
    manager._loadColdState = vi.fn(() => structuredClone(coldState));
    manager._saveColdState = vi.fn((next) => { coldState = structuredClone(next); });
    manager._setSessionEntry(SP1, {
      running: true,
      activeTabId: "tab-2",
      tabs: [
        { tabId: "tab-1", title: "One", url: "https://one.example.com" },
        { tabId: "tab-2", title: "Two", url: "https://two.example.com" },
      ],
    });

    expect(manager.forkSessionState({
      sourceSessionPath: SP1,
      targetSessionPath: SP2,
    })).toEqual({
      copied: true,
      tabs: 2,
      url: "https://two.example.com",
    });
    expect(manager.isRunning(SP1)).toBe(true);
    expect(manager.isRunning(SP2)).toBe(false);
    expect(coldState["sess-child"]).toMatchObject({
      sessionPath: SP2,
      activeTabId: "tab-2",
      url: "https://two.example.com",
      tabs: [
        expect.objectContaining({ tabId: "tab-1", url: "https://one.example.com" }),
        expect.objectContaining({ tabId: "tab-2", url: "https://two.example.com" }),
      ],
    });

    coldState["sess-child"].tabs[0].url = "https://child.example.com";
    expect(manager.getTabs(SP1)[0].url).toBe("https://one.example.com");
    expect(manager.discardForkedSessionState({ sessionPath: SP2 })).toEqual({ discarded: true });
    expect(coldState).not.toHaveProperty("sess-child");
    expect(manager.isRunning(SP1)).toBe(true);
  });

  it("does not leak the current tab workspace into a historical fork", () => {
    const sessionIds = new Map([
      [SP1, "sess-source"],
      [SP2, "sess-child"],
    ]);
    const manager = new BrowserManager({
      getSessionIdForPath: (sessionPath) => sessionIds.get(sessionPath) || null,
    });
    let coldState: any = {};
    manager._loadColdState = vi.fn(() => structuredClone(coldState));
    manager._saveColdState = vi.fn((next) => { coldState = structuredClone(next); });
    manager._setSessionEntry(SP1, {
      running: true,
      activeTabId: "tail-tab",
      tabs: [{ tabId: "tail-tab", title: "Tail", url: "https://tail.example" }],
    });

    expect(manager.forkSessionState({
      sourceSessionPath: SP1,
      targetSessionPath: SP2,
      includeSourceState: false,
    })).toEqual({
      copied: false,
      tabs: 0,
      url: null,
      reason: "historical_boundary",
    });
    expect(coldState).not.toHaveProperty("sess-child");
    expect(manager.isRunning(SP1)).toBe(true);
  });

  it("tracks tab workspaces per session and returns the active tab URL", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn()
      .mockResolvedValueOnce({
        activeTabId: "tab-1",
        tabs: [{ tabId: "tab-1", title: "One", url: "https://one.example.com" }],
      })
      .mockResolvedValueOnce({
        activeTabId: "tab-2",
        tabs: [
          { tabId: "tab-1", title: "One", url: "https://one.example.com" },
          { tabId: "tab-2", title: "Two", url: "https://two.example.com" },
        ],
      })
      .mockResolvedValueOnce({
        activeTabId: "tab-1",
        tabs: [
          { tabId: "tab-1", title: "One", url: "https://one.example.com" },
          { tabId: "tab-2", title: "Two", url: "https://two.example.com" },
        ],
      });

    await manager.launch(SP1);
    await manager.newTab(SP1, "https://two.example.com");

    expect(manager.getTabs(SP1).map(tab => tab.tabId)).toEqual(["tab-1", "tab-2"]);
    expect(manager.activeTab(SP1)?.tabId).toBe("tab-2");
    expect(manager.currentUrl(SP1)).toBe("https://two.example.com");

    await manager.switchTab(SP1, "tab-1");

    expect(manager.activeTab(SP1)?.tabId).toBe("tab-1");
    expect(manager.currentUrl(SP1)).toBe("https://one.example.com");
  });

  it("closeTab activates the neighboring tab and removes the closed tab from session state", async () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, {
      running: true,
      url: "https://two.example.com",
      activeTabId: "tab-2",
      headless: false,
      tabs: [
        { tabId: "tab-1", title: "One", url: "https://one.example.com" },
        { tabId: "tab-2", title: "Two", url: "https://two.example.com" },
      ],
    });
    manager._sendCmd = vi.fn().mockResolvedValue({
      activeTabId: "tab-1",
      tabs: [{ tabId: "tab-1", title: "One", url: "https://one.example.com" }],
    });
    manager._saveColdWorkspace = vi.fn();

    await manager.closeTab(SP1, "tab-2");

    expect(manager._sendCmd).toHaveBeenCalledWith("closeTab", { sessionPath: SP1, tabId: "tab-2" });
    expect(manager.getTabs(SP1)).toEqual([
      expect.objectContaining({ tabId: "tab-1", url: "https://one.example.com" }),
    ]);
    expect(manager.activeTab(SP1)?.tabId).toBe("tab-1");
    expect(manager.currentUrl(SP1)).toBe("https://one.example.com");
  });

  it("closing the last tab keeps an empty running workspace instead of stopping the browser", async () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, {
      running: true,
      url: "https://one.example.com",
      activeTabId: "tab-1",
      headless: false,
      tabs: [{ tabId: "tab-1", title: "One", url: "https://one.example.com" }],
    });
    manager._sendCmd = vi.fn().mockResolvedValue({ activeTabId: null, tabs: [] });
    manager._saveColdWorkspace = vi.fn();
    manager._removeColdUrl = vi.fn();

    const result = await manager.closeTab(SP1, "tab-1");

    expect(result).toBeNull();
    // 空标签组仍是活 workspace：不置 running:false，等待用户/agent 再开新 tab
    expect(manager.isRunning(SP1)).toBe(true);
    expect(manager.getTabs(SP1)).toEqual([]);
    expect(manager.currentUrl(SP1)).toBe(null);
    // 冷保存走 _saveColdWorkspace（空组无可恢复 URL，由它负责清掉冷记录），不再直接删冷 URL
    expect(manager._saveColdWorkspace).toHaveBeenCalledWith(SP1, expect.objectContaining({ tabs: [] }));
    expect(manager._removeColdUrl).not.toHaveBeenCalled();
    // 空组保留在 LRU 中，闲置回收与容量淘汰照常管理它
    expect(manager._lruOrder).toContain(SP1);
  });

  it("navigate honors the Agent new-tab browser preference", async () => {
    const manager = new BrowserManager();
    manager.setBrowserPreferences({ agentOpenBehavior: "new_tab" });
    manager._sessions.set(SP1, {
      running: true,
      url: "https://one.example.com",
      activeTabId: "tab-1",
      headless: false,
      tabs: [{ tabId: "tab-1", title: "One", url: "https://one.example.com" }],
    });
    manager._sendCmd = vi.fn()
      .mockResolvedValueOnce({
        activeTabId: "tab-2",
        tabs: [
          { tabId: "tab-1", title: "One", url: "https://one.example.com" },
          { tabId: "tab-2", title: "New Tab", url: null },
        ],
      })
      .mockResolvedValueOnce({
        url: "https://two.example.com",
        title: "Two",
        snapshot: "Page: Two",
        tabId: "tab-2",
      });
    manager._saveColdUrl = vi.fn();

    const result = await manager.navigate("https://two.example.com", SP1);

    expect(result.tabId).toBe("tab-2");
    expect(manager._sendCmd).toHaveBeenNthCalledWith(1, "newTab", {
      sessionPath: SP1,
      url: undefined,
    });
    expect(manager._sendCmd).toHaveBeenNthCalledWith(2, "navigate", {
      url: "https://two.example.com",
      sessionPath: SP1,
      tabId: "tab-2",
    });
    expect(manager.currentUrl(SP1)).toBe("https://two.example.com");
  });

  it.each([
    ["scroll", (manager, sp) => manager.scroll("down", 2, sp)],
    ["select", (manager, sp) => manager.select(7, "next", sp)],
    ["pressKey", (manager, sp) => manager.pressKey("Enter", sp)],
    ["wait", (manager, sp) => manager.wait({ timeout: 100 }, sp)],
  ])("%s updates currentUrl from browser command results", async (_name, action) => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, { running: true, url: "https://before.example.com", headless: false });
    manager._sendCmd = vi.fn().mockResolvedValue({
      currentUrl: "https://after.example.com",
      text: "snapshot",
    });

    const text = await action(manager, SP1);

    expect(text).toBe("snapshot");
    expect(manager.currentUrl(SP1)).toBe("https://after.example.com");
  });

  it("wait() forwards the requested readiness state to the desktop browser host", async () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, { running: true, url: "https://before.example.com", headless: false });
    manager._sendCmd = vi.fn().mockResolvedValue({
      currentUrl: "https://after.example.com",
      text: "snapshot",
    });

    await manager.wait({ timeout: 250, state: "stable" }, SP1);

    expect(manager._sendCmd).toHaveBeenCalledWith("wait", {
      timeout: 250,
      state: "stable",
      sessionPath: SP1,
    });
    expect(manager.currentUrl(SP1)).toBe("https://after.example.com");
  });
});

describe("BrowserManager explicit sessionPath", () => {
  it("keys browser runtime state by sessionId while accepting moved path locators", async () => {
    const manager = new BrowserManager({
      getSessionIdForPath: (sessionPath) => (
        sessionPath === "/sessions/old.jsonl" || sessionPath === "/sessions/new.jsonl"
          ? "sess_browser_1"
          : null
      ),
    });
    manager._sendCmd = vi.fn().mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      snapshot: "...",
    });
    manager._saveColdUrl = vi.fn();

    await manager.launch("/sessions/old.jsonl");
    await manager.navigate("https://example.com", "/sessions/new.jsonl");

    expect(manager._sessions.has("sess_browser_1")).toBe(true);
    expect(manager._sessions.has("/sessions/old.jsonl")).toBe(false);
    expect(manager._sessions.has("/sessions/new.jsonl")).toBe(false);
    expect(manager.isRunning("/sessions/old.jsonl")).toBe(true);
    expect(manager.currentUrl("/sessions/old.jsonl")).toBe("https://example.com");
    expect(manager.currentUrl("/sessions/new.jsonl")).toBe("https://example.com");
    expect(manager._saveColdUrl).toHaveBeenCalledWith("/sessions/new.jsonl", "https://example.com");
  });

  it("resumes and migrates legacy path-keyed cold workspaces after the session path moves", async () => {
    const oldPath = "/sessions/old-browser.jsonl";
    const newPath = "/sessions/new-browser.jsonl";
    const sessionId = "sess_browser_cold_1";
    const coldState = {
      [oldPath]: {
        sessionPath: oldPath,
        activeTabId: "tab-page",
        tabs: [
          { tabId: "tab-blank", title: "New Tab", url: null },
          { tabId: "tab-page", title: "Page", url: "https://page.example.com" },
        ],
      },
    };
    const savedStates: any[] = [];
    const manager = new BrowserManager({
      getSessionIdForPath: (sessionPath) => (
        sessionPath === oldPath || sessionPath === newPath ? sessionId : null
      ),
    });
    manager._loadColdState = vi.fn().mockImplementation(() => JSON.parse(JSON.stringify(coldState)));
    manager._saveColdState = vi.fn().mockImplementation((state) => {
      savedStates.push(JSON.parse(JSON.stringify(state)));
    });
    manager._sendCmd = vi.fn().mockImplementation(async (cmd, params) => {
      if (cmd === "resume") return { found: false };
      if (cmd === "launch") {
        return {
          activeTabId: params.activeTabId,
          tabs: params.tabs,
        };
      }
      return {};
    });

    await manager.resumeForSession(newPath);

    expect(manager._sendCmd).toHaveBeenNthCalledWith(1, "resume", { sessionPath: newPath });
    expect(manager._sendCmd).toHaveBeenNthCalledWith(2, "launch", {
      sessionPath: newPath,
      tabs: [
        expect.objectContaining({ tabId: "tab-blank", url: null }),
        expect.objectContaining({ tabId: "tab-page", url: "https://page.example.com" }),
      ],
      activeTabId: "tab-page",
      acceptCookies: true,
    });
    expect(manager.isRunning(oldPath)).toBe(true);
    expect(manager.isRunning(newPath)).toBe(true);
    expect(manager.currentUrl(newPath)).toBe("https://page.example.com");
    expect(savedStates.at(-1)).toEqual({
      [sessionId]: expect.objectContaining({
        sessionPath: newPath,
        activeTabId: "tab-page",
        url: "https://page.example.com",
      }),
    });
  });

  it("searchWeb() uses a transient browser command without registering a session", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({
      provider: "bing_browser",
      results: [{ title: "Result", url: "https://example.com", content: "Snippet", rank: 1 }],
    });

    const result = await manager.searchWeb({
      provider: "bing_browser",
      query: "hana search",
      maxResults: 3,
    } as any);

    expect(result.results).toHaveLength(1);
    expect(manager._sendCmd).toHaveBeenCalledWith("browserSearch", {
      provider: "bing_browser",
      query: "hana search",
      maxResults: 3,
    }, 45000);
    expect(manager.runningSessions).toHaveLength(0);
  });

  it("launch() with explicit sessionPath uses it", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});

    await manager.launch(SP1);

    expect(manager.isRunning(SP1)).toBe(true);
    expect(manager._sendCmd).toHaveBeenCalledWith("launch", {
      sessionPath: SP1,
      headless: false,
      acceptCookies: true,
    });
  });

  it("launch() on already-running session returns immediately", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});
    manager._sessions.set(SP1, { running: true, url: null, headless: false });

    await manager.launch(SP1);

    // _sendCmd should NOT have been called
    expect(manager._sendCmd).not.toHaveBeenCalled();
  });

  it("navigate() updates session URL and cold save", async () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, { running: true, url: null, headless: false });
    manager._sendCmd = vi.fn().mockResolvedValue({
      url: "https://example.com/page",
      title: "Page",
      snapshot: "...",
    });
    manager._saveColdUrl = vi.fn();

    await manager.navigate("https://example.com/page", SP1);

    expect(manager._saveColdUrl).toHaveBeenCalledWith(
      SP1,
      "https://example.com/page",
    );
    expect(manager.currentUrl(SP1)).toBe("https://example.com/page");
  });

  it("close() removes session from Map and cold state", async () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, { running: true, url: "https://example.com", headless: false });
    manager._lruOrder = [SP1];
    manager._sendCmd = vi.fn().mockResolvedValue({});
    manager._removeColdUrl = vi.fn();

    await manager.close(SP1);

    expect(manager._removeColdUrl).toHaveBeenCalledWith(SP1);
    expect(manager.isRunning(SP1)).toBe(false);
    expect(manager._sessions.has(SP1)).toBe(false);
    expect(manager._lruOrder).not.toContain(SP1);
  });

  it("thumbnail display-surface capture errors do not mark the session unavailable", async () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, { running: true, url: "https://example.com", headless: false });
    manager._lruOrder = [SP1];
    manager._sendCmd = vi.fn().mockRejectedValue(
      new Error("Current display surface not available for capture"),
    );

    const thumbnail = await manager.thumbnail(SP1);

    expect(thumbnail).toBeNull();
    expect(manager.isRunning(SP1)).toBe(true);
    expect(manager.runningSessions).toContain(SP1);
    expect(manager.sessionUnavailableReason(SP1)).toBeNull();
    expect(manager._lruOrder).toContain(SP1);
  });

  it("screenshot display-surface capture errors do not block later browser commands", async () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, { running: true, url: "https://example.com", headless: false });
    manager._sendCmd = vi.fn()
      .mockRejectedValueOnce(new Error("Current display surface not available for capture"))
      .mockResolvedValueOnce({
        currentUrl: "https://example.com",
        text: "snapshot after failed screenshot",
      });

    await expect(manager.screenshot(SP1)).rejects.toThrow(/display surface/i);
    expect(manager.isRunning(SP1)).toBe(true);
    expect(manager.sessionUnavailableReason(SP1)).toBeNull();

    const snapshot = await manager.snapshot(SP1);
    expect(snapshot).toBe("snapshot after failed screenshot");
    expect(manager._sendCmd).toHaveBeenNthCalledWith(2, "snapshot", { sessionPath: SP1 });
  });

  it("reports empty screenshot captures before they reach session-file persistence", async () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, { running: true, url: "https://example.com", headless: false });
    manager._sendCmd = vi.fn().mockResolvedValue({ base64: "" });

    await expect(manager.screenshot(SP1)).rejects.toThrow(/no image data|empty image/i);
    expect(manager.isRunning(SP1)).toBe(true);
    expect(manager.sessionUnavailableReason(SP1)).toBeNull();
  });

  it("does not send further commands for an unavailable browser session", async () => {
    const manager = new BrowserManager();
    // running 的 entry 在生产里必然带标签页（空标签组走 workspace-sync，见下方用例）
    manager._sessions.set(SP1, {
      running: true,
      url: "https://example.com",
      headless: false,
      activeTabId: "tab-1",
      tabs: [{ tabId: "tab-1", url: "https://example.com" }],
    });
    manager._sendCmd = vi.fn().mockRejectedValue(
      new Error("Object has been destroyed"),
    );

    await manager.thumbnail(SP1);
    (manager._sendCmd as any).mockClear();

    await expect(manager.snapshot(SP1)).rejects.toThrow(/浏览器实例已不可用|browser instance is unavailable/i);
    expect(manager._sendCmd).not.toHaveBeenCalled();
  });

  it("launch() clears an unavailable stale view before creating a fresh browser", async () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, {
      running: true,
      url: "https://example.com",
      headless: false,
      activeTabId: "tab-1",
      tabs: [{ tabId: "tab-1", url: "https://example.com" }],
    });
    manager._sendCmd = vi.fn().mockRejectedValue(
      new Error("No browser instance for session /sessions/session-1.json"),
    );

    await manager.thumbnail(SP1);
    (manager._sendCmd as any).mockReset();
    (manager._sendCmd as any).mockResolvedValue({});

    await manager.launch(SP1);

    expect(manager._sendCmd).toHaveBeenNthCalledWith(1, "destroyView", { sessionPath: SP1 });
    expect(manager._sendCmd).toHaveBeenNthCalledWith(2, "launch", {
      sessionPath: SP1,
      headless: false,
      acceptCookies: true,
    });
    expect(manager.isRunning(SP1)).toBe(true);
    expect(manager.sessionUnavailableReason(SP1)).toBeNull();
  });

  it("getBrowserSessions() merges cold state with all running sessions", () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, { running: true, url: "https://example.com", headless: false });
    manager._sessions.set(SP2, { running: true, url: "https://other.com", headless: false });
    manager._loadColdState = vi.fn().mockReturnValue({
      "/sessions/cold-session.json": "https://cold.example.com",
    });

    const sessions = manager.getBrowserSessions();

    expect(sessions).toEqual({
      "/sessions/cold-session.json": "https://cold.example.com",
      [SP1]: "https://example.com",
      [SP2]: "https://other.com",
    });
  });

  it("getBrowserSessions() does not include running sessions without URL", () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, { running: true, url: null, headless: false });
    manager._loadColdState = vi.fn().mockReturnValue({});

    const sessions = manager.getBrowserSessions();

    expect(sessions).toEqual({});
  });

  it("getBrowserSessionStates() distinguishes running, resumable, and unavailable sessions", () => {
    const manager = new BrowserManager();
    manager._sessions.set(SP1, { running: true, url: "https://live.example.com", headless: false });
    manager._sessions.set(SP2, {
      running: false,
      url: "https://broken.example.com",
      headless: false,
      health: "unhealthy",
      unavailableReason: "Object has been destroyed",
    });
    manager._loadColdState = vi.fn().mockReturnValue({
      "/sessions/cold-session.json": "https://cold.example.com",
      "/sessions/blank-cold.json": {
        activeTabId: "tab-blank",
        tabs: [{ tabId: "tab-blank", title: "New Tab", url: null }],
      },
      [SP2]: "https://saved-broken.example.com",
    });

    expect(manager.getBrowserSessionStates()).toEqual({
      "/sessions/cold-session.json": {
        url: "https://cold.example.com",
        running: false,
        resumable: true,
        unavailableReason: null,
      },
      [SP2]: {
        url: "https://broken.example.com",
        running: false,
        resumable: false,
        unavailableReason: "Object has been destroyed",
      },
      [SP1]: {
        url: "https://live.example.com",
        running: true,
        resumable: true,
        unavailableReason: null,
      },
    });
  });
});

describe("BrowserManager multi-instance", () => {
  it("can launch up to 5 concurrent sessions", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});

    const allSessions = [SP1, SP2, SP3, SP4, SP5];
    for (const sp of allSessions) {
      await manager.launch(sp);
    }

    expect(manager.runningSessions).toHaveLength(5);
    for (const sp of allSessions) {
      expect(manager.isRunning(sp)).toBe(true);
    }
  });

  it("6th session triggers LRU eviction of oldest running session", async () => {
    const manager = new BrowserManager();
    // Track suspend calls
    const suspendCalls = [];
    manager._sendCmd = vi.fn().mockImplementation(async (cmd, params) => {
      if (cmd === "suspend") suspendCalls.push(params?.sessionPath);
      return {};
    });
    manager._saveColdUrl = vi.fn();

    const allSessions = [SP1, SP2, SP3, SP4, SP5];
    for (const sp of allSessions) {
      await manager.launch(sp);
    }

    // Launch 6th session → should evict SP1 (oldest in LRU)
    await manager.launch(SP6);

    expect(suspendCalls).toContain(SP1);
    expect(manager.isRunning(SP1)).toBe(false);
    expect(manager.isRunning(SP6)).toBe(true);
    expect(manager.runningSessions).toHaveLength(5);
  });

  it("LRU evicts least recently used, not just first launched", async () => {
    const manager = new BrowserManager();
    const suspendCalls = [];
    manager._sendCmd = vi.fn().mockImplementation(async (cmd, params) => {
      if (cmd === "suspend") suspendCalls.push(params?.sessionPath);
      return {};
    });
    manager._saveColdUrl = vi.fn();

    const allSessions = [SP1, SP2, SP3, SP4, SP5];
    for (const sp of allSessions) {
      await manager.launch(sp);
    }

    // Touch SP1 to move it to end of LRU
    manager._touchLru(SP1);

    // Launch 6th → should evict SP2 (now oldest in LRU)
    await manager.launch(SP6);

    expect(suspendCalls).toContain(SP2);
    expect(manager.isRunning(SP2)).toBe(false);
    expect(manager.isRunning(SP1)).toBe(true);
    expect(manager.isRunning(SP6)).toBe(true);
  });

  it("close/suspend/resume are isolated per session", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockImplementation(async (cmd) => {
      if (cmd === "resume") return { found: true, url: "https://resumed.com" };
      return {};
    });
    manager._saveColdUrl = vi.fn();
    manager._loadColdState = vi.fn().mockReturnValue({});

    // Launch two sessions
    await manager.launch(SP1);
    await manager.launch(SP2);

    // Suspend SP1
    manager._sessions.get(SP1).url = "https://sp1.example.com";
    await manager.suspendForSession(SP1);

    expect(manager.isRunning(SP1)).toBe(false);
    expect(manager.isRunning(SP2)).toBe(true);

    // Close SP2
    await manager.close(SP2);

    expect(manager.isRunning(SP2)).toBe(false);
    expect(manager._sessions.has(SP2)).toBe(false);

    // Resume SP1
    // Need cold state for resume to proceed when not running
    manager._loadColdState = vi.fn().mockReturnValue({
      [SP1]: "https://sp1.example.com",
    });
    await manager.resumeForSession(SP1);

    expect(manager.isRunning(SP1)).toBe(true);
    expect(manager.currentUrl(SP1)).toBe("https://resumed.com");
  });

  it("cold resume restores the tab workspace even when the active tab is blank", async () => {
    const manager = new BrowserManager();
    manager._loadColdState = vi.fn().mockReturnValue({
      [SP1]: {
        activeTabId: "tab-blank",
        tabs: [
          { tabId: "tab-blank", title: "New Tab", url: null },
          { tabId: "tab-page", title: "Page", url: "https://page.example.com" },
        ],
      },
    });
    manager._sendCmd = vi.fn().mockImplementation(async (cmd, params) => {
      if (cmd === "resume") return { found: false };
      if (cmd === "launch") return {
        activeTabId: params.activeTabId,
        tabs: params.tabs,
      };
      return {};
    });

    await manager.resumeForSession(SP1);

    expect(manager._sendCmd).toHaveBeenNthCalledWith(1, "resume", { sessionPath: SP1 });
    expect(manager._sendCmd).toHaveBeenNthCalledWith(2, "launch", {
      sessionPath: SP1,
      tabs: [
        expect.objectContaining({ tabId: "tab-blank", url: null }),
        expect.objectContaining({ tabId: "tab-page", url: "https://page.example.com" }),
      ],
      activeTabId: "tab-blank",
      acceptCookies: true,
    });
    expect(manager.isRunning(SP1)).toBe(true);
    expect(manager.activeTab(SP1)?.tabId).toBe("tab-blank");
    expect(manager.getTabs(SP1).map(tab => tab.tabId)).toEqual(["tab-blank", "tab-page"]);
  });

  it("resumeForSessionIfAvailable returns a typed skip when no browser host is connected", async () => {
    const manager = new BrowserManager();
    manager._transport = { connected: false };
    manager._loadColdState = vi.fn().mockReturnValue({
      [SP1]: {
        activeTabId: "tab-page",
        tabs: [{ tabId: "tab-page", title: "Page", url: "https://cold.example.com" }],
      },
    });
    manager._sendCmd = vi.fn();

    const result = await manager.resumeForSessionIfAvailable(SP1);

    expect(result).toMatchObject({
      status: "skipped",
      reason: "browser_host_unavailable",
      hostConnected: false,
      hasResumeState: true,
      url: "https://cold.example.com",
    });
    expect(manager._sendCmd).not.toHaveBeenCalled();
  });

  it("resumeForSessionIfAvailable auto-resumes only a warm suspended host view", async () => {
    const manager = new BrowserManager();
    manager._transport = { connected: true };
    manager._loadColdState = vi.fn().mockReturnValue({
      [SP1]: {
        activeTabId: "tab-page",
        tabs: [{ tabId: "tab-page", title: "Page", url: "https://cold.example.com" }],
      },
    });
    manager._saveColdWorkspace = vi.fn();
    manager._sendCmd = vi.fn().mockImplementation(async (cmd) => {
      if (cmd === "resume") {
        return {
          found: true,
          activeTabId: "tab-page",
          tabs: [{ tabId: "tab-page", title: "Page", url: "https://warm.example.com" }],
        };
      }
      throw new Error(`unexpected browser command: ${cmd}`);
    });

    const result = await manager.resumeForSessionIfAvailable(SP1);

    expect(manager._sendCmd).toHaveBeenCalledTimes(1);
    expect(manager._sendCmd).toHaveBeenCalledWith("resume", { sessionPath: SP1 });
    expect(result).toMatchObject({
      status: "resumed",
      running: true,
      url: "https://warm.example.com",
    });
    expect(manager.currentUrl(SP1)).toBe("https://warm.example.com");
  });

  it("resumeForSessionIfAvailable defers cold resume instead of launching during session switch", async () => {
    const manager = new BrowserManager();
    manager._transport = { connected: true };
    manager._loadColdState = vi.fn().mockReturnValue({
      [SP1]: {
        activeTabId: "tab-page",
        tabs: [{ tabId: "tab-page", title: "Page", url: "https://cold.example.com" }],
      },
    });
    manager._sendCmd = vi.fn().mockImplementation(async (cmd) => {
      if (cmd === "resume") return { found: false };
      throw new Error(`unexpected browser command: ${cmd}`);
    });

    const result = await manager.resumeForSessionIfAvailable(SP1);

    expect(manager._sendCmd).toHaveBeenCalledTimes(1);
    expect(manager._sendCmd).toHaveBeenCalledWith("resume", { sessionPath: SP1 });
    expect(result).toMatchObject({
      status: "skipped",
      reason: "cold_resume_deferred",
      hostConnected: true,
      hasResumeState: true,
      running: false,
      url: "https://cold.example.com",
    });
    expect(manager.isRunning(SP1)).toBe(false);
  });

  it("blank cold workspaces are not resumable and are pruned when suspended", async () => {
    const manager = new BrowserManager();
    const blankWorkspace = {
      activeTabId: "tab-blank",
      tabs: [{ tabId: "tab-blank", title: "New Tab", url: null }],
    };
    manager._transport = { connected: true };
    manager._loadColdState = vi.fn().mockReturnValue({ [SP1]: blankWorkspace });
    manager._saveColdState = vi.fn();
    manager._sendCmd = vi.fn();

    const result = await manager.resumeForSessionIfAvailable(SP1);

    expect(result).toMatchObject({
      status: "skipped",
      reason: "no_browser_state",
      hasResumeState: false,
      url: null,
    });
    expect(manager._sendCmd).not.toHaveBeenCalled();

    manager._saveColdWorkspace(SP1, blankWorkspace);

    expect(manager._saveColdState).toHaveBeenCalledWith({});
  });

  it("hasAnyRunning returns true when at least one session is running", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});

    expect(manager.hasAnyRunning).toBe(false);

    await manager.launch(SP1);
    expect(manager.hasAnyRunning).toBe(true);

    await manager.launch(SP2);
    expect(manager.hasAnyRunning).toBe(true);

    await manager.close(SP1);
    expect(manager.hasAnyRunning).toBe(true);

    await manager.close(SP2);
    expect(manager.hasAnyRunning).toBe(false);
  });

  it("runningSessions returns correct list", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});
    manager._saveColdUrl = vi.fn();

    expect(manager.runningSessions).toEqual([]);

    await manager.launch(SP1);
    await manager.launch(SP2);
    await manager.launch(SP3);

    expect(manager.runningSessions).toHaveLength(3);
    expect(manager.runningSessions).toContain(SP1);
    expect(manager.runningSessions).toContain(SP2);
    expect(manager.runningSessions).toContain(SP3);

    await manager.suspendForSession(SP2);

    expect(manager.runningSessions).toHaveLength(2);
    expect(manager.runningSessions).not.toContain(SP2);
  });

  it("suspendForSession saves the cold tab workspace and marks not running", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});
    manager._saveColdWorkspace = vi.fn();

    await manager.launch(SP1);
    const entry = manager._sessions.get(SP1);
    entry.url = "https://example.com/page";
    entry.activeTabId = "tab-1";
    entry.tabs = [{ tabId: "tab-1", title: "Page", url: "https://example.com/page" }];

    await manager.suspendForSession(SP1);

    expect(manager._saveColdWorkspace).toHaveBeenCalledWith(
      SP1,
      expect.objectContaining({ activeTabId: "tab-1", url: "https://example.com/page" }),
    );
    expect(manager.isRunning(SP1)).toBe(false);
    // suspend 后 entry 从 Map 中移除（冷状态已写磁盘，避免僵尸条目累积）
    expect(manager._sessions.has(SP1)).toBe(false);
  });

  it("closeBrowserForSession on running session delegates to close()", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});
    manager._removeColdUrl = vi.fn();

    await manager.launch(SP1);

    await manager.closeBrowserForSession(SP1);

    expect(manager._sessions.has(SP1)).toBe(false);
    expect(manager._removeColdUrl).toHaveBeenCalledWith(SP1);
  });

  it("closeBrowserForSession on suspended session destroys view", async () => {
    const manager = new BrowserManager();
    const cmds = [];
    manager._sendCmd = vi.fn().mockImplementation(async (cmd) => {
      cmds.push(cmd);
      return {};
    });
    manager._saveColdUrl = vi.fn();
    manager._removeColdUrl = vi.fn();

    await manager.launch(SP1);
    manager._sessions.get(SP1).url = "https://example.com";
    await manager.suspendForSession(SP1);

    cmds.length = 0; // reset tracking

    await manager.closeBrowserForSession(SP1);

    expect(cmds).toContain("destroyView");
    expect(manager._sessions.has(SP1)).toBe(false);
    expect(manager._removeColdUrl).toHaveBeenCalledWith(SP1);
  });
});

describe("browser authorization revocation", () => {
  it("keys revocation by session identity and clears per session", () => {
    const manager = new BrowserManager({
      getSessionIdForPath: (sessionPath: string) => (sessionPath === SP1 ? "sess-1" : null),
    });

    expect(manager.isBrowserAuthorizationRevoked(SP1)).toBe(false);
    manager.revokeBrowserAuthorization(SP1);
    expect(manager.isBrowserAuthorizationRevoked(SP1)).toBe(true);
    // 同一 session identity 的 legacy path 键也命中
    expect(manager.isBrowserAuthorizationRevoked("sess-1")).toBe(true);
    // 其它 session 不受影响
    expect(manager.isBrowserAuthorizationRevoked(SP2)).toBe(false);

    manager.clearBrowserAuthorizationRevocation(SP1);
    expect(manager.isBrowserAuthorizationRevoked(SP1)).toBe(false);
  });

  it("revocation without sessionPath is a no-op", () => {
    const manager = new BrowserManager({});
    manager.revokeBrowserAuthorization(null);
    expect(manager.isBrowserAuthorizationRevoked(null)).toBe(false);
    manager.clearBrowserAuthorizationRevocation(null);
    expect(manager.isBrowserAuthorizationRevoked(null)).toBe(false);
  });
});

/** 触发 BrowserManager 在 constructor 里注册的 transport 消息处理器（IPC / WS 两种传输都覆盖）。 */
function emitTransportMessage(manager: any, msg: any) {
  const handler = manager._transport?._handler || manager._transport?._boundListener;
  if (!handler) throw new Error("transport message handler not registered");
  handler(msg);
}

describe("browser workspace sync from the desktop viewer", () => {
  it("applies a workspace snapshot pushed by the main process", () => {
    const manager = new BrowserManager({});
    manager._setSessionEntry(SP1, {
      running: true,
      activeTabId: "tab-1",
      url: "https://one.example.com",
      tabs: [{ tabId: "tab-1", title: "One", url: "https://one.example.com" }],
    });

    emitTransportMessage(manager, {
      type: "browser-workspace-sync",
      sessionPath: SP1,
      workspace: {
        sessionPath: SP1,
        activeTabId: "tab-2",
        tabs: [
          { tabId: "tab-1", title: "One", url: "https://one.example.com" },
          { tabId: "tab-2", title: "Two", url: "https://two.example.com" },
        ],
      },
    });

    expect(manager.getTabs(SP1).map((tab: any) => tab.tabId)).toEqual(["tab-1", "tab-2"]);
    expect(manager.activeTab(SP1)?.tabId).toBe("tab-2");
    expect(manager.currentUrl(SP1)).toBe("https://two.example.com");
  });

  it("keeps the session running when the synced workspace has no tabs", () => {
    const manager = new BrowserManager({});
    manager._setSessionEntry(SP1, {
      running: true,
      activeTabId: "tab-1",
      url: "https://one.example.com",
      tabs: [{ tabId: "tab-1", title: "One", url: "https://one.example.com" }],
    });

    emitTransportMessage(manager, {
      type: "browser-workspace-sync",
      sessionPath: SP1,
      workspace: { sessionPath: SP1, activeTabId: null, tabs: [] },
    });

    // 空标签组仍是活着的 workspace：running 不变，只是没有 url
    expect(manager.isRunning(SP1)).toBe(true);
    expect(manager.getTabs(SP1)).toEqual([]);
    expect(manager.activeTab(SP1)).toBeNull();
    expect(manager.currentUrl(SP1)).toBeNull();
  });

  it("ignores a sync for a session that has no live entry", () => {
    const manager = new BrowserManager({});
    emitTransportMessage(manager, {
      type: "browser-workspace-sync",
      sessionPath: SP2,
      workspace: { sessionPath: SP2, activeTabId: "tab-9", tabs: [{ tabId: "tab-9" }] },
    });
    expect(manager._getSessionEntry(SP2)).toBeNull();
  });

  it("returns null from thumbnail without sending a command when the tab group is empty", async () => {
    const manager = new BrowserManager({});
    manager._setSessionEntry(SP1, {
      running: true,
      activeTabId: null,
      url: null,
      tabs: [],
    });
    manager._sendCmd = vi.fn(async () => ({ base64: "nope" }));

    expect(await manager.thumbnail(SP1)).toBeNull();
    expect(manager._sendCmd).not.toHaveBeenCalled();
  });

  it("suspend can keep the viewer visible for a follow-up session switch", async () => {
    const manager = new BrowserManager({});
    manager._setSessionEntry(SP1, {
      running: true,
      activeTabId: "t1",
      tabs: [{ tabId: "t1", url: "https://a.example" }],
    });
    manager._loadColdState = vi.fn(() => ({}));
    manager._saveColdState = vi.fn();
    const sent: any[] = [];
    manager._sendCmd = vi.fn(async (cmd, params) => { sent.push({ cmd, params }); return {}; });

    await manager.suspendForSession(SP1, { keepViewerVisible: true });

    expect(sent[0]).toMatchObject({ cmd: "suspend", params: { sessionPath: SP1, keepViewerVisible: true } });
  });

  it("suspend hides the viewer by default", async () => {
    const manager = new BrowserManager({});
    manager._setSessionEntry(SP1, {
      running: true,
      activeTabId: "t1",
      tabs: [{ tabId: "t1", url: "https://a.example" }],
    });
    manager._loadColdState = vi.fn(() => ({}));
    manager._saveColdState = vi.fn();
    const sent: any[] = [];
    manager._sendCmd = vi.fn(async (cmd, params) => { sent.push({ cmd, params }); return {}; });

    await manager.suspendForSession(SP1);

    expect(sent[0]).toMatchObject({ cmd: "suspend", params: { sessionPath: SP1, keepViewerVisible: false } });
  });

  it("notifyViewerSession sends the viewerShowSession command and swallows transport errors", async () => {
    const manager = new BrowserManager({});
    manager._sendCmd = vi.fn(async () => { throw new Error("not connected"); });

    await expect(manager.notifyViewerSession(SP1, "标题")).resolves.toBeUndefined();
    expect(manager._sendCmd).toHaveBeenCalledWith("viewerShowSession", { sessionPath: SP1, title: "标题" }, 10000);
  });

  it("notifyViewerSession does nothing without a session path", async () => {
    const manager = new BrowserManager({});
    manager._sendCmd = vi.fn(async () => ({}));

    await manager.notifyViewerSession(null);

    expect(manager._sendCmd).not.toHaveBeenCalled();
  });
});

describe("browser idle reclaim", () => {
  it("suspends a session only when both agent and user are idle past the threshold", async () => {
    vi.useFakeTimers();
    try {
      const manager = new BrowserManager({});
      manager._loadColdState = vi.fn(() => ({}));
      manager._saveColdState = vi.fn();
      manager._sendCmd = vi.fn(async (cmd) => (cmd === "viewerVisibility" ? { visible: false, sessionPath: null } : {}));
      manager._setSessionEntry(SP1, { running: true, activeTabId: "t1", tabs: [{ tabId: "t1", url: "https://a.example" }] });
      manager._touchLru(SP1);
      manager._ensureIdleSweep();

      await vi.advanceTimersByTimeAsync(29 * 60_000);
      expect(manager.isRunning(SP1)).toBe(true);        // 未到阈值
      manager._touchUserActivity(SP1);                   // 用户活动重置
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      expect(manager.isRunning(SP1)).toBe(true);
      await vi.advanceTimersByTimeAsync(6 * 60_000);     // 双闲置超 30 分钟
      expect(manager.isRunning(SP1)).toBe(false);        // 已被 suspend（entry 删除）
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the session currently visible in the viewer", async () => {
    vi.useFakeTimers();
    try {
      const manager = new BrowserManager({});
      manager._loadColdState = vi.fn(() => ({}));
      manager._saveColdState = vi.fn();
      manager._sendCmd = vi.fn(async (cmd) => (cmd === "viewerVisibility" ? { visible: true, sessionPath: SP1 } : {}));
      manager._setSessionEntry(SP1, { running: true, activeTabId: "t1", tabs: [{ tabId: "t1", url: "https://a.example" }] });
      manager._touchLru(SP1);
      manager._ensureIdleSweep();
      await vi.advanceTimersByTimeAsync(65 * 60_000);
      expect(manager.isRunning(SP1)).toBe(true);
      clearInterval(manager._idleSweepTimer);
      manager._idleSweepTimer = null;
    } finally {
      vi.useRealTimers();
    }
  });
});
