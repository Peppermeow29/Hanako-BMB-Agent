import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSessionMock, sessionManagerCreateMock, sessionManagerOpenMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  emitSessionShutdown: vi.fn(async () => false),
  SessionManager: {
    create: sessionManagerCreateMock,
    list: vi.fn(async () => []),
    open: sessionManagerOpenMock,
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
  resizeModelImageInput: vi.fn(async (image) => image),
  formatModelImageDimensionNote: vi.fn(() => undefined),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.ts";
import { SessionManifestStore } from "../core/session-manifest/store.ts";

function buildCoordinator({ tempDir, sessionDir, store, emitEvent = vi.fn() }) {
  const agent = {
    id: "hana",
    agentName: "Hana",
    name: "Hana",
    agentDir: path.join(tempDir, "agents", "hana"),
    sessionDir,
    memoryMasterEnabled: true,
    sessionMemoryEnabled: true,
    config: {},
    tools: [],
    buildSystemPrompt: vi.fn(() => "system"),
  };
  return new SessionCoordinator({
    agentsDir: path.join(tempDir, "agents"),
    getAgent: () => agent,
    getActiveAgentId: () => "hana",
    getModels: () => ({
      currentModel: { id: "m", provider: "test", name: "Test Model" },
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: (level) => level || "medium",
    }),
    getResourceLoader: () => ({
      getSystemPrompt: () => "BASE",
      getAppendSystemPrompt: () => [],
      getExtensions: () => ({ extensions: [], errors: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
    }),
    getSkills: () => null,
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent,
    emitDevLog: vi.fn(),
    getHomeCwd: () => tempDir,
    agentIdFromSessionPath: () => "hana",
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getPrefs: () => ({
      getThinkingLevel: () => "medium",
      getChannelsEnabled: () => true,
    }),
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: () => agent,
    listAgents: () => [agent],
    sessionManifestStore: store,
  });
}

describe("SessionCoordinator session manifest integration", () => {
  let tempDir;
  let sessionPath;
  let sessionManager;
  let store;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-manifest-coord-"));
    sessionPath = path.join(tempDir, "agents", "hana", "sessions", "alpha.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", version: 3, id: "alpha", timestamp: "2026-06-18T04:00:00.000Z", cwd: tempDir }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hello" }, timestamp: "2026-06-18T04:00:01.000Z" }),
      "",
    ].join("\n"));
    sessionManager = {
      getSessionFile: () => sessionPath,
      getCwd: () => tempDir,
    };
    sessionManagerCreateMock.mockReturnValue(sessionManager);
    createAgentSessionMock.mockImplementation(async (opts) => ({
      session: {
        sessionManager: opts.sessionManager,
        model: opts.model,
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    }));
    store = new SessionManifestStore({
      dbPath: path.join(tempDir, "session-manifest.db"),
      idGenerator: () => "sess_coord_0001",
      now: () => "2026-06-18T04:00:02.000Z",
    });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createCoordinator() {
    return buildCoordinator({ tempDir, sessionDir: path.dirname(sessionPath), store });
  }

  it("creates and exposes stable session manifests through create/list/pin", async () => {
    const coordinator = createCoordinator();

    const created = await coordinator.createSession(null, tempDir, true);
    const sessions = await coordinator.listSessions();
    const { pinnedAt } = await coordinator.setSessionPinned(sessionPath, true);

    expect(created).toMatchObject({
      sessionPath,
      sessionId: "sess_coord_0001",
      agentId: "hana",
    });
    expect(sessions.find((session) => session.path === sessionPath)).toMatchObject({
      path: sessionPath,
      sessionId: "sess_coord_0001",
      agentId: "hana",
    });
    expect(store.resolveByLocatorPath(sessionPath)).toMatchObject({
      sessionId: "sess_coord_0001",
      ownerAgentId: "hana",
      lifecycle: "active",
      memoryPolicy: { mode: "enabled", inheritedFrom: "session_create" },
      permissionModeSnapshot: {
        mode: "auto",
        source: "session_create",
      },
      pinnedAt,
    });
  });

  it("pins by sessionId after a path move and treats the path as a legacy locator", async () => {
    const coordinator = createCoordinator();

    await coordinator.createSession(null, tempDir, true);
    const movedPath = path.join(tempDir, "agents", "hana", "sessions", "alpha-renamed.jsonl");
    fs.renameSync(sessionPath, movedPath);
    store.updateLocator("sess_coord_0001", movedPath, "rename");

    const { pinnedAt } = await coordinator.setSessionPinned({
      sessionId: "sess_coord_0001",
      sessionPath,
    }, true);

    expect(store.getBySessionId("sess_coord_0001")?.pinnedAt).toBe(pinnedAt);
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(movedPath), "session-meta.json"), "utf-8"));
    expect(meta[path.basename(movedPath)]?.pinnedAt).toBe(pinnedAt);
    expect(meta[path.basename(sessionPath)]?.pinnedAt).toBeUndefined();
  });

  it("keys live runtime sessions by sessionId and resolves legacy locators at lookup boundaries", async () => {
    const coordinator = createCoordinator();

    const created = await coordinator.createSession(null, tempDir, true);

    expect(coordinator._sessions.has("sess_coord_0001")).toBe(true);
    expect(coordinator._sessions.has(sessionPath)).toBe(false);
    expect(coordinator.getSessionByPath(sessionPath)).toBe(created.session);

    const movedPath = path.join(tempDir, "agents", "hana", "sessions", "alpha-renamed.jsonl");
    store.updateLocator("sess_coord_0001", movedPath, "rename");

    expect(coordinator.getSessionByPath(sessionPath)).toBe(created.session);
    expect(coordinator.getSessionByPath(movedPath)).toBe(created.session);
  });

  it("keys hibernated runtime metadata by sessionId while preserving legacy path lookup", async () => {
    const coordinator = createCoordinator();

    const created = await coordinator.createSession(null, tempDir, true);
    Object.defineProperty(created.session, "isStreaming", { value: false, configurable: true });
    Object.defineProperty(created.session, "isCompacting", { value: false, configurable: true });
    created.session.dispose = vi.fn();
    created.session.getContextUsage = vi.fn(() => ({ tokens: 42, contextWindow: 1000, percent: 4.2 }));

    await expect(coordinator.hibernateSessionRuntime(sessionPath, "test")).resolves.toBe(true);

    expect(coordinator._hibernatedSessionMeta.has("sess_coord_0001")).toBe(true);
    expect(coordinator._hibernatedSessionMeta.has(sessionPath)).toBe(false);
    expect(coordinator.getSessionByPath(sessionPath)).toBeNull();
    expect(coordinator.getSessionContextUsage(sessionPath)).toEqual({
      tokens: 42,
      contextWindow: 1000,
      percent: 4.2,
    });
  });

  it("keeps saved session titles attached to the session id when the path moves", async () => {
    const coordinator = createCoordinator();

    await coordinator.createSession(null, tempDir, true);
    await coordinator.saveSessionTitle(sessionPath, "Stable title");

    const movedPath = path.join(tempDir, "agents", "hana", "sessions", "alpha-renamed.jsonl");
    store.updateLocator("sess_coord_0001", movedPath, "rename");

    await expect(coordinator.getTitlesForPaths([movedPath])).resolves.toEqual({
      [movedPath]: "Stable title",
    });
  });

  it("persists plugin ownership updates in the session manifest across path moves", async () => {
    const coordinator = createCoordinator();

    await coordinator.createSession(null, tempDir, true);
    await coordinator.setSessionPluginMeta(sessionPath, {
      ownerPluginId: "sample-plugin",
      kind: "media",
      visibility: "private",
    });

    expect(store.getBySessionId("sess_coord_0001")?.plugin).toEqual({
      ownerPluginId: "sample-plugin",
      kind: "media",
      visibility: "private",
    });

    const movedPath = path.join(tempDir, "agents", "hana", "sessions", "alpha-renamed.jsonl");
    store.updateLocator("sess_coord_0001", movedPath, "rename");
    await coordinator.setSessionPluginMeta(movedPath, { visibility: "public" });

    expect(store.getBySessionId("sess_coord_0001")?.plugin).toEqual({
      ownerPluginId: "sample-plugin",
      kind: "media",
      visibility: "public",
    });
  });

  it("projects manifest-owned metadata in the session list after a path move", async () => {
    const coordinator = createCoordinator();

    await coordinator.createSession(null, tempDir, true);
    const { pinnedAt } = await coordinator.setSessionPinned(sessionPath, true);
    await coordinator.saveSessionTitle(sessionPath, "Moved title");
    await coordinator.setSessionPluginMeta(sessionPath, {
      ownerPluginId: "sample-plugin",
      kind: "media",
      visibility: "private",
    });

    const movedPath = path.join(tempDir, "agents", "hana", "sessions", "alpha-renamed.jsonl");
    fs.renameSync(sessionPath, movedPath);
    store.updateLocator("sess_coord_0001", movedPath, "rename");

    const moved = (await coordinator.listSessions({ includePluginPrivate: true }))
      .find((session) => session.path === movedPath);
    expect(moved).toMatchObject({
      path: movedPath,
      sessionId: "sess_coord_0001",
      title: "Moved title",
      pinnedAt,
      ownerPluginId: "sample-plugin",
      sessionKind: "media",
      visibility: "private",
    });
  });

  it("restores manifest-owned policy and workspace fields after a path move without runtime cache", async () => {
    const coordinator = createCoordinator();
    const allowedFolder = path.join(tempDir, "allowed");
    fs.mkdirSync(allowedFolder, { recursive: true });

    await coordinator.createSession(null, tempDir, true);
    await coordinator.setSessionMemoryEnabled(sessionPath, false);
    coordinator.setSessionPermissionMode(sessionPath, "operate");
    await coordinator.setSessionThinkingLevel(sessionPath, "high");
    await coordinator.setSessionAuthorizedFolders(sessionPath, [allowedFolder]);

    const movedPath = path.join(tempDir, "agents", "hana", "sessions", "alpha-renamed.jsonl");
    fs.renameSync(sessionPath, movedPath);
    store.updateLocator("sess_coord_0001", movedPath, "rename");

    const restarted = createCoordinator();
    expect(restarted.getSessionMemoryEnabled(movedPath)).toBe(false);
    expect(restarted.getPermissionMode(movedPath)).toBe("operate");
    expect(restarted.getSessionThinkingLevel(movedPath)).toBe("high");
    expect(restarted.getSessionFolderScope(movedPath)).toMatchObject({
      workspaceFolders: [],
      authorizedFolders: [allowedFolder],
    });
  });

  it("rejects stale active locators after archive without cold-loading a header file", async () => {
    const coordinator = createCoordinator();
    await coordinator.createSession(null, tempDir, true);
    const archivedPath = path.join(tempDir, "agents", "hana", "sessions", "archived", "alpha.jsonl");
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    fs.renameSync(sessionPath, archivedPath);
    store.updateLocatorLifecycle("sess_coord_0001", archivedPath, "archived", "session_archive");
    sessionManagerOpenMock.mockImplementation(() => {
      fs.writeFileSync(sessionPath, "unexpected cold load\n");
      return { getCwd: () => tempDir, getSessionFile: () => sessionPath };
    });

    await expect(coordinator.ensureSessionLoaded(sessionPath)).rejects.toMatchObject({
      code: "session_locator_not_active",
      status: 409,
    });
    await expect(coordinator.switchSession(sessionPath)).rejects.toMatchObject({
      code: "session_locator_not_active",
      status: 409,
    });

    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
    expect(fs.existsSync(sessionPath)).toBe(false);
  });
});

describe("SessionCoordinator pin order", () => {
  let tempDir;
  let sessionDir;
  let store;
  let emitEvent;
  let coordinator;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-pin-order-"));
    sessionDir = path.join(tempDir, "agents", "hana", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    let nextId = 1;
    store = new SessionManifestStore({
      dbPath: path.join(tempDir, "session-manifest.db"),
      idGenerator: () => `sess_pin_${String(nextId++).padStart(4, "0")}`,
      now: () => "2026-07-27T00:00:00.000Z",
    });
    emitEvent = vi.fn();
    coordinator = buildCoordinator({ tempDir, sessionDir, store, emitEvent });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedSession(name, activityIso) {
    const sessionPath = path.join(sessionDir, `${name}.jsonl`);
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", version: 3, id: name, timestamp: activityIso, cwd: tempDir }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "hello" },
        timestamp: activityIso,
      }),
      "",
    ].join("\n"));
    const manifest = store.createForPath({
      sessionPath,
      ownerAgentId: "hana",
      domain: "desktop",
      kind: "chat",
      lifecycle: "active",
    });
    return { sessionPath, sessionId: manifest.sessionId };
  }

  function readMeta(sessionPath) {
    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf-8"));
    return meta[path.basename(sessionPath)] || null;
  }

  function pinOrderEvents() {
    return emitEvent.mock.calls.filter(([event]) => (
      event?.type === "session_metadata_updated"
      && Object.prototype.hasOwnProperty.call(event.metadata || {}, "pinOrder")
    ));
  }

  it("puts each newly pinned session above the ones pinned before it", async () => {
    const first = seedSession("alpha", "2026-07-27T01:00:00.000Z");
    const second = seedSession("beta", "2026-07-27T02:00:00.000Z");

    await coordinator.setSessionPinned(first.sessionPath, true);
    await coordinator.setSessionPinned(second.sessionPath, true);

    expect(store.getBySessionId(first.sessionId)?.pinOrder).toBe(-1024);
    expect(store.getBySessionId(second.sessionId)?.pinOrder).toBe(-2048);
    expect(readMeta(first.sessionPath)?.pinOrder).toBe(-1024);
    expect(readMeta(second.sessionPath)?.pinOrder).toBe(-2048);
  });

  it("clears the order when a session is unpinned and issues a fresh one when it is pinned again", async () => {
    const first = seedSession("alpha", "2026-07-27T01:00:00.000Z");
    const second = seedSession("beta", "2026-07-27T02:00:00.000Z");
    await coordinator.setSessionPinned(first.sessionPath, true);
    await coordinator.setSessionPinned(second.sessionPath, true);

    await coordinator.setSessionPinned(first.sessionPath, false);

    expect(store.getBySessionId(first.sessionId)).toMatchObject({ pinnedAt: null, pinOrder: null });
    expect(readMeta(first.sessionPath)?.pinnedAt).toBeNull();
    expect(readMeta(first.sessionPath)?.pinOrder).toBeNull();

    await coordinator.setSessionPinned(first.sessionPath, true);

    expect(store.getBySessionId(first.sessionId)?.pinOrder).toBe(-3072);
  });

  it("renumbers pinned sessions from a submitted order and announces every change", async () => {
    const first = seedSession("alpha", "2026-07-27T01:00:00.000Z");
    const second = seedSession("beta", "2026-07-27T02:00:00.000Z");
    const third = seedSession("gamma", "2026-07-27T03:00:00.000Z");
    for (const session of [first, second, third]) {
      await coordinator.setSessionPinned(session.sessionPath, true);
    }
    emitEvent.mockClear();

    const orders = await coordinator.setSessionPinOrder([
      { sessionId: third.sessionId },
      { sessionId: first.sessionId },
      { sessionId: second.sessionId },
    ]);

    expect(orders).toEqual([
      { sessionId: third.sessionId, pinOrder: 1024 },
      { sessionId: first.sessionId, pinOrder: 2048 },
      { sessionId: second.sessionId, pinOrder: 3072 },
    ]);
    expect(store.getBySessionId(third.sessionId)?.pinOrder).toBe(1024);
    expect(store.getBySessionId(first.sessionId)?.pinOrder).toBe(2048);
    expect(store.getBySessionId(second.sessionId)?.pinOrder).toBe(3072);
    expect(readMeta(third.sessionPath)?.pinOrder).toBe(1024);
    expect(readMeta(first.sessionPath)?.pinOrder).toBe(2048);
    expect(readMeta(second.sessionPath)?.pinOrder).toBe(3072);
    expect(pinOrderEvents()).toHaveLength(3);
    expect(pinOrderEvents().map(([event]) => event.metadata.pinOrder)).toEqual([1024, 2048, 3072]);
  });

  it("refuses a reorder that names a session that is not pinned, without writing anything", async () => {
    const first = seedSession("alpha", "2026-07-27T01:00:00.000Z");
    const second = seedSession("beta", "2026-07-27T02:00:00.000Z");
    await coordinator.setSessionPinned(first.sessionPath, true);
    emitEvent.mockClear();

    await expect(coordinator.setSessionPinOrder([
      { sessionId: first.sessionId },
      { sessionId: second.sessionId },
    ])).rejects.toMatchObject({
      code: "session_not_pinned",
      status: 400,
    });

    expect(store.getBySessionId(first.sessionId)?.pinOrder).toBe(-1024);
    expect(store.getBySessionId(second.sessionId)?.pinOrder).toBeNull();
    expect(pinOrderEvents()).toHaveLength(0);
  });

  it("refuses a reorder that repeats the same session", async () => {
    const first = seedSession("alpha", "2026-07-27T01:00:00.000Z");
    await coordinator.setSessionPinned(first.sessionPath, true);

    await expect(coordinator.setSessionPinOrder([
      { sessionId: first.sessionId },
      { sessionId: first.sessionId },
    ])).rejects.toMatchObject({ code: "session_pin_order_duplicate" });
  });

  it("freezes the order sessions pinned before ordering existed were already displayed in, once", async () => {
    const oldest = seedSession("alpha", "2026-07-27T01:00:00.000Z");
    const newest = seedSession("beta", "2026-07-27T03:00:00.000Z");
    const middle = seedSession("gamma", "2026-07-27T02:00:00.000Z");
    for (const session of [oldest, newest, middle]) {
      store.setPinnedAt(session.sessionId, "2026-07-01T00:00:00.000Z");
    }
    const setPinOrder = vi.spyOn(store, "setPinOrder");

    await coordinator.listSessions();
    await vi.waitFor(() => {
      expect(store.getState("pin-order-backfill-v1")?.completedAt).toEqual(expect.any(String));
    });

    expect(store.getBySessionId(newest.sessionId)?.pinOrder).toBe(1024);
    expect(store.getBySessionId(middle.sessionId)?.pinOrder).toBe(2048);
    expect(store.getBySessionId(oldest.sessionId)?.pinOrder).toBe(3072);
    expect(readMeta(newest.sessionPath)?.pinOrder).toBe(1024);
    expect(setPinOrder).toHaveBeenCalledTimes(3);

    setPinOrder.mockClear();
    await coordinator.listSessions();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(setPinOrder).not.toHaveBeenCalled();
  });

  it("reports the frozen order back through the session list", async () => {
    const first = seedSession("alpha", "2026-07-27T01:00:00.000Z");
    const second = seedSession("beta", "2026-07-27T02:00:00.000Z");
    await coordinator.setSessionPinned(first.sessionPath, true);
    await coordinator.setSessionPinned(second.sessionPath, true);

    const sessions = await coordinator.listSessions();

    expect(sessions.find((s) => s.path === first.sessionPath)?.pinOrder).toBe(-1024);
    expect(sessions.find((s) => s.path === second.sessionPath)?.pinOrder).toBe(-2048);
  });
});
