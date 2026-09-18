import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { upsertStudioMount } from "../core/studio-mounts.ts";
import { normalizeWorkspacePath } from "../shared/workspace-history.ts";

const { replayLatestUserTurnMock, retrySessionTurnMock } = vi.hoisted(() => ({
  replayLatestUserTurnMock: vi.fn(async () => ({ text: null, toolMedia: [] })),
  retrySessionTurnMock: vi.fn(async () => ({ text: null, toolMedia: [] })),
}));

const browserManagerMock = {
  _sessions: new Map(), // sessionPath → { running, url }
  isRunning(sp) { return this._sessions.get(sp)?.running ?? false; },
  currentUrl(sp) { return this._sessions.get(sp)?.url ?? null; },
  get hasAnyRunning() { for (const s of this._sessions.values()) if (s.running) return true; return false; },
  suspendForSession: vi.fn(async (sp) => {
    const s = browserManagerMock._sessions.get(sp);
    if (s) s.running = false;
  }),
  resumeForSession: vi.fn(async (sp) => {
    browserManagerMock._sessions.set(sp, { running: true, url: "https://after.example.com" });
  }),
  resumeForSessionIfAvailable: vi.fn(async (sp) => ({
    status: "skipped",
    canResume: false,
    reason: "no_browser_state",
    hostConnected: true,
    hasResumeState: false,
    running: browserManagerMock.isRunning(sp),
    url: browserManagerMock.currentUrl(sp),
  })),
  notifyViewerSession: vi.fn(async (_sp: string, _title?: string | null) => {}),
  closeBrowserForSession: vi.fn(),
  getBrowserSessions: vi.fn(() => ({})),
  getBrowserSessionStates: vi.fn(() => ({})),
};

vi.mock("../lib/browser/browser-manager.js", () => ({
  BrowserManager: {
    instance: () => browserManagerMock,
  },
}));

vi.mock("../core/message-utils.js", () => ({
  extractTextContent: vi.fn(() => ({ text: "", images: [], thinking: "", toolUses: [] })),
  contentHasThinkingBlock: vi.fn(() => false),
  filterUnreferencedInlineImages: vi.fn((_text, images) => images || []),
  loadSessionHistoryMessages: vi.fn(async () => []),
  loadLatestAssistantSummaryFromSessionFile: vi.fn(async () => null),
  isValidSessionPath: vi.fn(() => true),
  isActiveSessionPath: vi.fn(() => true),
  isActiveDesktopSessionPath: vi.fn(() => true),
  isArchivedDesktopSessionPath: vi.fn(() => true),
  // 本文件的测试不构造 hana-message-origin 条目，恒等直通即等价于真实实现
  // （annotateOriginMessages 只在遇到该 customType 时才会摘除/注释条目）。
  annotateOriginMessages: vi.fn((messages) => messages || []),
  // 同理：本文件的测试不构造 hana-session-collab-decision 条目，空索引 + 直通
  // 等价于真实实现（灰测修复 C：草稿卡确认状态持久化，见 tests/session-collab-decision.test.ts）。
  collectSessionCollabDecisions: vi.fn(() => new Map()),
  overlaySessionCollabDecision: vi.fn((block) => block),
}));

vi.mock("../core/session-turn-actions.js", () => ({
  replayLatestUserTurn: replayLatestUserTurnMock,
  retrySessionTurn: retrySessionTurnMock,
}));

describe("sessions route", () => {
  let tmpDir;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-sessions-route-"));
    browserManagerMock._sessions.clear();
    browserManagerMock._sessions.set("/tmp/agents/a/sessions/old.jsonl", { running: true, url: "https://before.example.com" });
    browserManagerMock.suspendForSession.mockClear();
    browserManagerMock.notifyViewerSession.mockClear();
    browserManagerMock.resumeForSession.mockClear();
    browserManagerMock.resumeForSessionIfAvailable.mockClear();
    browserManagerMock.closeBrowserForSession.mockClear();
    browserManagerMock.getBrowserSessions.mockReset();
    browserManagerMock.getBrowserSessions.mockReturnValue({});
    browserManagerMock.getBrowserSessionStates.mockReset();
    browserManagerMock.getBrowserSessionStates.mockReturnValue({});
    replayLatestUserTurnMock.mockClear();
    replayLatestUserTurnMock.mockResolvedValue({ text: null, toolMedia: [] });
    retrySessionTurnMock.mockClear();
    retrySessionTurnMock.mockResolvedValue({ text: null, toolMedia: [] });
  });

  it("restores browser state for the target session after switch", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: "/tmp/agents/a/sessions/old.jsonl",
      messages: [{ role: "assistant", content: "ok" }],
      memoryEnabled: true,
      planMode: false,
      memoryModelUnavailableReason: null,
      cwd: "/tmp/workspace",
      currentAgentId: "hana",
      agentName: "Hana",
      currentModel: {
        id: "mimo-v2.5",
        provider: "mimo",
        api: "openai-completions",
        baseUrl: "https://api.xiaomimimo.com/v1",
        input: ["text"],
      },
      // A real engine always resolves ownership for a switchable session path.
      resolveSessionOwnership: vi.fn(() => ({ agentId: "a", source: "path", agentDeleted: false })),
      isSessionStreaming: vi.fn(() => false),
      switchSession: vi.fn(async (sessionPath) => {
        engine.currentSessionPath = sessionPath;
      }),
      getSessionByPath: vi.fn((sp) => ({
        messages: [{ role: "assistant", content: "ok" }],
      })),
      getSessionMemoryEnabled: vi.fn(() => false),
      getAgent: vi.fn(() => ({ agentName: "Hana" })),
      getSessionWorkspaceMount: vi.fn(() => ({ mountId: "mount_docs", label: "Docs" })),
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative("/tmp/agents", sp);
        return rel.split(path.sep)[0] || null;
      }),
    };

    app.route("/api", createSessionsRoute(engine));
    browserManagerMock.resumeForSessionIfAvailable.mockImplementationOnce(async (sp) => {
      await browserManagerMock.resumeForSession(sp);
      return {
        status: "resumed",
        canResume: false,
        reason: "already_running",
        hostConnected: true,
        hasResumeState: true,
        running: browserManagerMock.isRunning(sp),
        url: browserManagerMock.currentUrl(sp),
      };
    });

    const res = await app.request("/api/sessions/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/agents/a/sessions/new.jsonl", currentSessionPath: "/tmp/agents/a/sessions/old.jsonl" }),
    });

    const data = await res.json();
    expect(res.status).toBe(200);
    // 切换时 viewer 保持可见，由随后的 notifyViewerSession 重绘目标 session
    expect(browserManagerMock.suspendForSession).toHaveBeenCalledWith(
      "/tmp/agents/a/sessions/old.jsonl",
      { keepViewerVisible: true },
    );
    expect(browserManagerMock.notifyViewerSession.mock.calls.at(-1)?.[0])
      .toBe("/tmp/agents/a/sessions/new.jsonl");
    expect(browserManagerMock.resumeForSessionIfAvailable).toHaveBeenCalledWith("/tmp/agents/a/sessions/new.jsonl");
    expect(browserManagerMock.resumeForSession).toHaveBeenCalledWith("/tmp/agents/a/sessions/new.jsonl");
    expect(data.browserRunning).toBe(true); // resumeForSession sets it running
    expect(data.browserUrl).toBe("https://after.example.com"); // per-session URL
    expect(data.memoryEnabled).toBe(false);
    expect(engine.getSessionMemoryEnabled).toHaveBeenCalledWith("/tmp/agents/a/sessions/new.jsonl");
    expect(data.workspaceMountId).toBe("mount_docs");
    expect(data.workspaceLabel).toBe("Docs");
    expect(data.currentModelAudio).toBe(true);
    expect(data.currentModelAudioTransport).toBe("mimo-input-audio");
    expect(data.currentModelAudioTransportSupported).toBe(true);
  });

  it("returns historical model availability without failing the session switch", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const targetPath = "/tmp/agents/a/sessions/removed-model.jsonl";
    const historicalModel = {
      id: "removed-chat-model",
      name: "Removed Chat Model",
      provider: "legacy-provider",
      api: "hana-unavailable-model",
      input: ["text"],
    };
    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: targetPath,
      activeSessionModel: historicalModel,
      currentModel: { id: "current-model", provider: "current-provider", input: ["text"] },
      memoryEnabled: true,
      planMode: false,
      memoryModelUnavailableReason: null,
      cwd: "/tmp/workspace",
      currentAgentId: "a",
      // A real engine always resolves ownership for a switchable session path.
      resolveSessionOwnership: vi.fn(() => ({ agentId: "a", source: "path", agentDeleted: false })),
      isSessionStreaming: vi.fn(() => false),
      switchSession: vi.fn(async () => historicalModel),
      getSessionByPath: vi.fn(() => ({
        model: historicalModel,
        messages: [{ role: "user", content: "history" }],
      })),
      getSessionMemoryEnabled: vi.fn(() => true),
      getSessionThinkingLevel: vi.fn(() => "medium"),
      getSessionWorkspaceFolders: vi.fn(() => []),
      getSessionAuthorizedFolders: vi.fn(() => []),
      getSessionModelAvailability: vi.fn(() => ({
        available: false,
        reason: "model_removed",
        modelRef: "legacy-provider/removed-chat-model",
      })),
      getAgent: vi.fn(() => ({ agentName: "Agent A" })),
      agentIdFromSessionPath: vi.fn(() => "a"),
    };
    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: targetPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.messageCount).toBe(1);
    expect(data).toMatchObject({
      currentModelId: "removed-chat-model",
      currentModelProvider: "legacy-provider",
      currentModelAvailable: false,
      currentModelUnavailableReason: "model_removed",
    });
    expect(engine.getSessionModelAvailability).toHaveBeenCalledWith(targetPath);
  });

  it("switches sessions by sessionId and treats path as a legacy locator", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const currentPath = "/tmp/agents/a/sessions/current.jsonl";

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: "/tmp/agents/a/sessions/old.jsonl",
      memoryEnabled: true,
      planMode: false,
      memoryModelUnavailableReason: null,
      cwd: "/tmp/workspace",
      currentAgentId: "a",
      currentModel: { id: "m", provider: "test", input: ["text"] },
      getSessionManifest: vi.fn((sessionId) => (
        sessionId === "sess_switch"
          ? { sessionId, currentLocator: { path: currentPath } }
          : null
      )),
      // A real engine always resolves ownership for a switchable session path.
      resolveSessionOwnership: vi.fn(() => ({ agentId: "a", source: "path", agentDeleted: false })),
      isSessionStreaming: vi.fn(() => false),
      switchSession: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ messages: [] })),
      getSessionMemoryEnabled: vi.fn(() => true),
      getSessionThinkingLevel: vi.fn(() => "medium"),
      getSessionWorkspaceFolders: vi.fn(() => []),
      getSessionAuthorizedFolders: vi.fn(() => []),
      getAgent: vi.fn(() => ({ agentName: "Agent A" })),
      agentIdFromSessionPath: vi.fn(() => "a"),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess_switch",
        path: "/tmp/agents/a/sessions/stale.jsonl",
        currentSessionPath: "/tmp/agents/a/sessions/old.jsonl",
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.switchSession).toHaveBeenCalledWith(currentPath);
    expect(browserManagerMock.resumeForSessionIfAvailable).toHaveBeenCalledWith(currentPath);
    expect(browserManagerMock.resumeForSession).not.toHaveBeenCalledWith(currentPath);
  });

  it("skips opportunistic browser resume without failing when no browser host is attached", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const targetPath = "/tmp/agents/a/sessions/no-host.jsonl";

    browserManagerMock.resumeForSessionIfAvailable.mockResolvedValueOnce({
      status: "skipped",
      canResume: false,
      reason: "browser_host_unavailable",
      hostConnected: false,
      hasResumeState: true,
      running: false,
      url: "https://cold.example.com",
    });

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: "/tmp/agents/a/sessions/old.jsonl",
      memoryEnabled: true,
      planMode: false,
      memoryModelUnavailableReason: null,
      cwd: "/tmp/workspace",
      currentAgentId: "a",
      currentModel: { id: "m", provider: "test", input: ["text"] },
      // A real engine always resolves ownership for a switchable session path.
      resolveSessionOwnership: vi.fn(() => ({ agentId: "a", source: "path", agentDeleted: false })),
      isSessionStreaming: vi.fn(() => false),
      switchSession: vi.fn(async (sessionPath) => {
        engine.currentSessionPath = sessionPath;
      }),
      getSessionByPath: vi.fn(() => ({ messages: [] })),
      getSessionMemoryEnabled: vi.fn(() => true),
      getSessionThinkingLevel: vi.fn(() => "medium"),
      getSessionWorkspaceFolders: vi.fn(() => []),
      getSessionAuthorizedFolders: vi.fn(() => []),
      getAgent: vi.fn(() => ({ agentName: "Agent A" })),
      agentIdFromSessionPath: vi.fn(() => "a"),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: targetPath, currentSessionPath: "/tmp/agents/a/sessions/old.jsonl" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.switchSession).toHaveBeenCalledWith(targetPath);
    expect(browserManagerMock.resumeForSessionIfAvailable).toHaveBeenCalledWith(targetPath);
    expect(browserManagerMock.resumeForSession).not.toHaveBeenCalledWith(targetPath);
    expect(data.browserResume).toMatchObject({
      status: "skipped",
      reason: "browser_host_unavailable",
      hostConnected: false,
    });
  });

  it("keeps cold browser resume deferred during session switch", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const targetPath = "/tmp/agents/a/sessions/cold-browser.jsonl";

    browserManagerMock.resumeForSessionIfAvailable.mockResolvedValueOnce({
      status: "skipped",
      canResume: false,
      reason: "cold_resume_deferred",
      hostConnected: true,
      hasResumeState: true,
      running: false,
      url: "https://cold.example.com",
    });

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: "/tmp/agents/a/sessions/old.jsonl",
      memoryEnabled: true,
      planMode: false,
      memoryModelUnavailableReason: null,
      cwd: "/tmp/workspace",
      currentAgentId: "a",
      currentModel: { id: "m", provider: "test", input: ["text"] },
      // A real engine always resolves ownership for a switchable session path.
      resolveSessionOwnership: vi.fn(() => ({ agentId: "a", source: "path", agentDeleted: false })),
      isSessionStreaming: vi.fn(() => false),
      switchSession: vi.fn(async (sessionPath) => {
        engine.currentSessionPath = sessionPath;
      }),
      getSessionByPath: vi.fn(() => ({ messages: [] })),
      getSessionMemoryEnabled: vi.fn(() => true),
      getSessionThinkingLevel: vi.fn(() => "medium"),
      getSessionWorkspaceFolders: vi.fn(() => []),
      getSessionAuthorizedFolders: vi.fn(() => []),
      getAgent: vi.fn(() => ({ agentName: "Agent A" })),
      agentIdFromSessionPath: vi.fn(() => "a"),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: targetPath, currentSessionPath: "/tmp/agents/a/sessions/old.jsonl" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(browserManagerMock.resumeForSessionIfAvailable).toHaveBeenCalledWith(targetPath);
    expect(browserManagerMock.resumeForSession).not.toHaveBeenCalledWith(targetPath);
    expect(data.browserRunning).toBe(false);
    expect(data.browserUrl).toBeNull();
    expect(data.browserResume).toMatchObject({
      status: "skipped",
      reason: "cold_resume_deferred",
      hostConnected: true,
    });
  });

  it("keeps real browser resume failures visible during session switch", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const targetPath = "/tmp/agents/a/sessions/browser-error.jsonl";

    browserManagerMock.resumeForSessionIfAvailable.mockRejectedValueOnce(new Error("browser resume exploded"));

    const engine = {
      hanakoHome: tmpDir,
      agentsDir: "/tmp/agents",
      currentSessionPath: "/tmp/agents/a/sessions/old.jsonl",
      memoryEnabled: true,
      planMode: false,
      memoryModelUnavailableReason: null,
      cwd: "/tmp/workspace",
      currentAgentId: "a",
      currentModel: { id: "m", provider: "test", input: ["text"] },
      // A real engine always resolves ownership for a switchable session path.
      resolveSessionOwnership: vi.fn(() => ({ agentId: "a", source: "path", agentDeleted: false })),
      isSessionStreaming: vi.fn(() => false),
      switchSession: vi.fn(async () => {}),
      getSessionByPath: vi.fn(() => ({ messages: [] })),
      getSessionMemoryEnabled: vi.fn(() => true),
      getAgent: vi.fn(() => ({ agentName: "Agent A" })),
      agentIdFromSessionPath: vi.fn(() => "a"),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: targetPath, currentSessionPath: "/tmp/agents/a/sessions/old.jsonl" }),
    });
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error).toBe("browser resume exploded");
    expect(engine.switchSession).toHaveBeenCalledWith(targetPath);
  });

  it("passes workspaceFolders when creating a new session and returns the normalized scope", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const cwd = path.join(tmpDir, "main");
    const extra = path.join(tmpDir, "reference");
    const hub = { eventBus: { emit: vi.fn() } };

    const engine = {
      currentAgentId: "hana",
      config: {},
      cwd,
      memoryEnabled: true,
      planMode: false,
      memoryModelUnavailableReason: null,
      createSession: vi.fn(async () => ({
        sessionPath: "/tmp/agents/hana/sessions/new.jsonl",
        sessionId: "sess_route_new",
        agentId: "hana",
      })),
      createSessionForAgent: vi.fn(),
      persistSessionMeta: vi.fn(),
      updateConfig: vi.fn(async (patch) => Object.assign(engine.config, patch)),
      getAgent: vi.fn(() => ({ agentName: "Hana" })),
      getSessionWorkspaceFolders: vi.fn(() => [extra]),
      getSessionThinkingLevel: vi.fn(() => "high"),
    };

    app.route("/api", createSessionsRoute(engine, hub));

    const res = await app.request("/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, workspaceFolders: [extra], thinkingLevel: "high" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.createSession).toHaveBeenCalledWith(
      null,
      cwd,
      true,
      undefined,
      { workspaceFolders: [extra], visibleInSessionList: true, thinkingLevel: "high" },
    );
    expect(data.workspaceFolders).toEqual([extra]);
    expect(data.sessionId).toBe("sess_route_new");
    // session meta 必须显式落到刚建出来的会话上，而不是由被调方去猜焦点
    expect(engine.persistSessionMeta).toHaveBeenCalledWith("/tmp/agents/hana/sessions/new.jsonl");
    expect(hub.eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session_created",
        session: expect.objectContaining({
          path: "/tmp/agents/hana/sessions/new.jsonl",
          sessionId: "sess_route_new",
          thinkingLevel: "high",
        }),
      }),
      "/tmp/agents/hana/sessions/new.jsonl",
    );
  });

  it("returns a structured no-model error instead of a generic 500 when new session creation cannot select a model (#1643)", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const engine = {
      currentAgentId: "hana",
      config: {},
      cwd: "/tmp/workspace",
      createSession: vi.fn(async () => {
        throw new Error("No available model");
      }),
      createSessionForAgent: vi.fn(),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp/workspace" }),
    });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data).toMatchObject({
      error: "No available model",
      code: "no_available_model",
    });
  });

  it("resolves workspaceMountId on the server when creating a new session", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const hanakoHome = path.join(tmpDir, "hana");
    const defaultRoot = path.join(tmpDir, "default");
    const mountedRoot = path.join(tmpDir, "mounted");
    fs.mkdirSync(defaultRoot, { recursive: true });
    fs.mkdirSync(mountedRoot, { recursive: true });
    const resolvedMountedRoot = fs.realpathSync(mountedRoot);
    upsertStudioMount(hanakoHome, {
      mountId: "mount_docs",
      hostStudioId: "studio_1",
      sourceKind: "storage",
      provider: "local_fs",
      rootLocator: { path: mountedRoot },
      label: "Docs",
      presentation: "folder",
      capabilities: ["list", "read", "write"],
    });

    const engine = {
      hanakoHome,
      homeCwd: defaultRoot,
      currentAgentId: "hana",
      config: {},
      cwd: defaultRoot,
      memoryEnabled: true,
      planMode: false,
      memoryModelUnavailableReason: null,
      getRuntimeContext: () => ({
        serverId: "server_1",
        serverNodeId: "node_1",
        userId: "user_1",
        studioId: "studio_1",
        connectionKind: "local",
        credentialKind: "loopback_token",
      }),
      createSession: vi.fn(async (_sessionMgr, cwd) => {
        engine.cwd = cwd;
        return { sessionPath: "/tmp/agents/hana/sessions/new.jsonl", agentId: "hana" };
      }),
      createSessionForAgent: vi.fn(),
      persistSessionMeta: vi.fn(),
      updateConfig: vi.fn(async (patch) => Object.assign(engine.config, patch)),
      getAgent: vi.fn(() => ({ agentName: "Hana" })),
      getSessionWorkspaceMount: vi.fn(() => ({ mountId: "mount_docs", label: "Docs" })),
      getSessionWorkspaceFolders: vi.fn(() => []),
      getSessionThinkingLevel: vi.fn(() => "medium"),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceMountId: "mount_docs" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.createSession).toHaveBeenCalledWith(
      null,
      resolvedMountedRoot,
      true,
      undefined,
      {
        workspaceFolders: [],
        visibleInSessionList: true,
        workspaceMountId: "mount_docs",
        workspaceLabel: "Docs",
      },
    );
    expect(engine.updateConfig).toHaveBeenCalledWith({
      last_cwd: resolvedMountedRoot,
      cwd_history: [normalizeWorkspacePath(resolvedMountedRoot)],
    });
    expect(data.cwd).toBe(resolvedMountedRoot);
    expect(data.workspaceMountId).toBe("mount_docs");
    expect(data.workspaceLabel).toBe("Docs");
  });

  it("creates a detached session without switching the focused session", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const cwd = path.join(tmpDir, "quick");
    const extra = path.join(tmpDir, "reference");
    const hub = { eventBus: { emit: vi.fn() } };

    const engine = {
      currentSessionPath: "/tmp/agents/hana/sessions/focused.jsonl",
      currentAgentId: "hana",
      config: {},
      cwd: "/tmp/main-workspace",
      memoryEnabled: true,
      planMode: false,
      memoryModelUnavailableReason: null,
      createDetachedSession: vi.fn(async () => ({
        sessionPath: "/tmp/agents/hana/sessions/quick.jsonl",
        sessionId: "sess_quick",
        agentId: "hana",
      })),
      persistSessionMeta: vi.fn(),
      setSessionProjectAssignment: vi.fn(async () => {}),
      updateConfig: vi.fn(async () => {}),
      getAgent: vi.fn(() => ({ agentName: "Hana" })),
      getSessionWorkspaceFolders: vi.fn(() => [extra]),
      getSessionPermissionMode: vi.fn(() => "auto"),
    };

    app.route("/api", createSessionsRoute(engine, hub));

    const res = await app.request("/api/sessions/new-detached", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd,
        workspaceFolders: [extra],
        agentId: "hana",
        permissionMode: "auto",
        projectId: "project-quick",
      }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.createDetachedSession).toHaveBeenCalledWith({
      cwd,
      memoryEnabled: true,
      agentId: "hana",
      workspaceFolders: [extra],
      visibleInSessionList: true,
      permissionMode: "auto",
    });
    expect(engine.setSessionProjectAssignment).toHaveBeenCalledWith({
      sessionPath: "/tmp/agents/hana/sessions/quick.jsonl",
      projectId: "project-quick",
    });
    // 回归钉子：detached 创建结束时焦点已经还给 focused.jsonl，
    // 读焦点的旧实现会把新会话的记忆开关写到上一个会话头上。
    expect(engine.persistSessionMeta).toHaveBeenCalledWith("/tmp/agents/hana/sessions/quick.jsonl");
    expect(engine.persistSessionMeta).not.toHaveBeenCalledWith("/tmp/agents/hana/sessions/focused.jsonl");
    expect(data).toMatchObject({
      ok: true,
      path: "/tmp/agents/hana/sessions/quick.jsonl",
      sessionId: "sess_quick",
      agentId: "hana",
      currentSessionPath: "/tmp/agents/hana/sessions/focused.jsonl",
      permissionMode: "auto",
      projectId: "project-quick",
    });
    expect(hub.eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session_created",
        session: expect.objectContaining({ path: "/tmp/agents/hana/sessions/quick.jsonl" }),
      }),
      "/tmp/agents/hana/sessions/quick.jsonl",
    );
  });

  it("adds a session authorized folder through an explicit session route", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "new.jsonl");
    const cwd = path.join(tmpDir, "workspace");
    const authorizedFolder = path.join(tmpDir, "assets");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(authorizedFolder, { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n");
    const engine = {
      agentsDir: path.join(tmpDir, "agents"),
      agentIdFromSessionPath: vi.fn(() => "hana"),
      getSessionFolderScope: vi.fn(() => ({
        sessionPath,
        cwd,
        workspaceFolders: [],
        authorizedFolders: [authorizedFolder],
        sandboxFolders: [cwd, authorizedFolder],
      })),
      addSessionAuthorizedFolder: vi.fn(async () => ({
        sessionPath,
        cwd,
        workspaceFolders: [],
        authorizedFolders: [authorizedFolder],
        sandboxFolders: [cwd, authorizedFolder],
      })),
      isAgentDeleted: vi.fn(() => false),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/authorized-folders", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sessionPath, action: "add", folder: authorizedFolder }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.addSessionAuthorizedFolder).toHaveBeenCalledWith(sessionPath, authorizedFolder);
    expect(data).toMatchObject({
      ok: true,
      sessionPath,
      cwd,
      workspaceFolders: [],
      authorizedFolders: [authorizedFolder],
      sandboxFolders: [cwd, authorizedFolder],
    });
  });

  it("assigns a new session to the requested project before broadcasting it", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const hub = { eventBus: { emit: vi.fn() } };

    const engine = {
      currentAgentId: "hana",
      config: {},
      cwd: "/tmp/work",
      memoryEnabled: true,
      planMode: false,
      memoryModelUnavailableReason: null,
      normalizeSessionProjectAssignmentId: vi.fn(() => "project-hana"),
      createSession: vi.fn(async () => ({ sessionPath: "/tmp/agents/hana/sessions/new.jsonl", agentId: "hana" })),
      createSessionForAgent: vi.fn(),
      setSessionProjectAssignment: vi.fn(async ({ sessionPath, projectId }) => ({ sessionPath, projectId })),
      persistSessionMeta: vi.fn(),
      updateConfig: vi.fn(async (patch) => Object.assign(engine.config, patch)),
      getAgent: vi.fn(() => ({ agentName: "Hana" })),
      getSessionWorkspaceFolders: vi.fn(() => []),
    };

    app.route("/api", createSessionsRoute(engine, hub));

    const res = await app.request("/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp/work", projectId: "project-hana" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.normalizeSessionProjectAssignmentId).toHaveBeenCalledWith("project-hana");
    expect(engine.setSessionProjectAssignment).toHaveBeenCalledWith({
      sessionPath: "/tmp/agents/hana/sessions/new.jsonl",
      projectId: "project-hana",
    });
    expect(data.projectId).toBe("project-hana");
    expect(hub.eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session_created",
        session: expect.objectContaining({ projectId: "project-hana" }),
      }),
      "/tmp/agents/hana/sessions/new.jsonl",
    );
  });

  it("includes pinnedAt in the session list response", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const pinnedAt = "2026-04-29T08:00:00.000Z";

    const engine = {
      listSessions: vi.fn(async () => [{
        path: "/tmp/agents/hana/sessions/a.jsonl",
        title: "Pinned thread",
        firstMessage: "hello",
        modified: new Date("2026-04-29T07:00:00.000Z"),
        messageCount: 2,
        cwd: "/tmp/work",
        agentId: "hana",
        agentName: "Hana",
        sessionId: "sess_route_list",
        pinnedAt,
      }]),
      rcState: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data[0].sessionId).toBe("sess_route_list");
    expect(data[0].pinnedAt).toBe(pinnedAt);
  });

  it("includes the manual pin order in the session list and search responses", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const session = {
      path: "/tmp/agents/hana/sessions/a.jsonl",
      title: "Pinned thread",
      firstMessage: "hello",
      modified: new Date("2026-04-29T07:00:00.000Z"),
      messageCount: 2,
      cwd: "/tmp/work",
      agentId: "hana",
      agentName: "Hana",
      sessionId: "sess_route_order",
      pinnedAt: "2026-04-29T08:00:00.000Z",
      pinOrder: 2048,
    };

    app.route("/api", createSessionsRoute({
      listSessions: vi.fn(async () => [session]),
      rcState: null,
    }));

    const listData = await (await app.request("/api/sessions")).json();
    const searchData = await (await app.request("/api/sessions/search?q=Pinned")).json();

    expect(listData[0].pinOrder).toBe(2048);
    expect(searchData.results[0].pinOrder).toBe(2048);
  });

  it("includes explicit projectId in the session list response", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();

    const engine = {
      listSessions: vi.fn(async () => [{
        path: "/tmp/agents/hana/sessions/a.jsonl",
        title: "Project thread",
        firstMessage: "hello",
        modified: new Date("2026-05-28T07:00:00.000Z"),
        messageCount: 2,
        cwd: "/tmp/work",
        agentId: "hana",
        agentName: "Hana",
        projectId: "project-hana",
      }]),
      rcState: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data[0].projectId).toBe("project-hana");
  });

  it("searches sessions without exposing the cached full transcript", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const sessions = [
      {
        path: "/tmp/agents/hana/sessions/title.jsonl",
        title: "聊天记录搜索",
        firstMessage: "hello",
        modified: new Date("2026-05-22T07:00:00.000Z"),
        messageCount: 2,
        cwd: "/tmp/work",
        agentId: "hana",
        agentName: "Hana",
        allMessagesText: "标题命中时不需要扫正文。",
      },
      {
        path: "/tmp/agents/hana/sessions/content.jsonl",
        title: "无关主题",
        firstMessage: "hello",
        modified: new Date("2026-05-22T08:00:00.000Z"),
        messageCount: 4,
        cwd: "/tmp/work",
        agentId: "hana",
        agentName: "Hana",
        allMessagesText: "这里记录了和其他 Agent 的聊天记录排查。",
      },
    ];

    app.route("/api", createSessionsRoute({
      listSessions: vi.fn(async () => sessions),
      rcState: null,
    }));

    const titleRes = await app.request("/api/sessions/search?q=%E8%81%8A%E5%A4%A9%E8%AE%B0%E5%BD%95&phase=title");
    const titleData = await titleRes.json();
    expect(titleRes.status).toBe(200);
    expect(titleData.results).toEqual([
      expect.objectContaining({
        path: "/tmp/agents/hana/sessions/title.jsonl",
        matchKind: "title",
      }),
    ]);

    const contentRes = await app.request("/api/sessions/search?q=%E8%81%8A%E5%A4%A9%E8%AE%B0%E5%BD%95&phase=content");
    const contentData = await contentRes.json();
    expect(contentRes.status).toBe(200);
    expect(contentData.results).toEqual([
      expect.objectContaining({
        path: "/tmp/agents/hana/sessions/content.jsonl",
        matchKind: "content",
        snippet: expect.stringContaining("聊天记录"),
      }),
    ]);
    expect(contentData.results[0]).not.toHaveProperty("allMessagesText");
  });

  it("rejects overly long session search queries before scanning session text", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const listSessions = vi.fn(async () => {
      throw new Error("should not scan sessions for invalid query");
    });

    app.route("/api", createSessionsRoute({
      listSessions,
      rcState: null,
    }));

    const res = await app.request(`/api/sessions/search?q=${encodeURIComponent("记".repeat(513))}`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "query_too_long",
      maxLength: 512,
    });
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("projects the same default Studio sessions to a paired device principal", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const session = {
      path: "/tmp/agents/hana/sessions/a.jsonl",
      title: "Shared Studio Session",
      firstMessage: "hello from desktop",
      modified: new Date("2026-05-16T08:00:00.000Z"),
      messageCount: 2,
      cwd: "/tmp/work",
      agentId: "hana",
      agentName: "Hana",
    };
    const runtimeContext = {
      serverId: "server_projection",
      serverNodeId: "node_projection",
      userId: "user_projection",
      studioId: "studio_projection",
      connectionKind: "local",
      credentialKind: "loopback_token",
      platformAccountId: null,
      officialServiceKind: null,
    };

    app.use("*", async (c, next) => {
      (c as any).set("authPrincipal", Object.freeze({
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        trustState: "lan",
        serverNodeId: "node_projection",
        userId: "user_projection",
        studioId: "studio_projection",
        studioIds: ["studio_projection"],
        deviceId: "device_phone",
        scopes: ["chat"],
      }));
      await next();
    });
    app.route("/api", createSessionsRoute({
      getRuntimeContext: () => runtimeContext,
      listSessions: vi.fn(async () => [session]),
      rcState: null,
    }));

    const res = await app.request("/api/sessions");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual([expect.objectContaining({
      path: session.path,
      title: session.title,
      messageCount: 2,
    })]);
  });

  it("includes each session's permission mode in the session list projection", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const session = {
      path: "/tmp/agents/hana/sessions/a.jsonl",
      title: "Read only chat",
      firstMessage: "",
      modified: new Date("2026-05-16T08:00:00.000Z"),
      messageCount: 1,
      cwd: "/tmp/work",
      agentId: "hana",
      agentName: "Hana",
    };
    const getSessionPermissionMode = vi.fn(() => "read_only");

    app.route("/api", createSessionsRoute({
      listSessions: vi.fn(async () => [session]),
      getSessionPermissionMode,
      rcState: null,
    }));

    const res = await app.request("/api/sessions");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data[0]).toMatchObject({
      path: session.path,
      permissionMode: "read_only",
    });
    expect(getSessionPermissionMode).toHaveBeenCalledWith(session.path);
  });

  it("keeps cold-start session permission mode from the session list projection", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const session = {
      path: "/tmp/agents/hana/sessions/auto.jsonl",
      title: "Auto review chat",
      firstMessage: "",
      modified: new Date("2026-06-08T08:00:00.000Z"),
      messageCount: 1,
      cwd: "/tmp/work",
      agentId: "hana",
      agentName: "Hana",
      permissionMode: "auto",
    };
    const getSessionPermissionMode = vi.fn(() => "ask");

    app.route("/api", createSessionsRoute({
      listSessions: vi.fn(async () => [session]),
      getSessionPermissionMode,
      rcState: null,
    }));

    const res = await app.request("/api/sessions");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data[0]).toMatchObject({
      path: session.path,
      permissionMode: "auto",
    });
    expect(getSessionPermissionMode).not.toHaveBeenCalled();
  });

  it("marks deleted-agent sessions read-only in the session list response", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const session = {
      path: "/tmp/agents/deleted/sessions/a.jsonl",
      title: "Old agent chat",
      firstMessage: "hello",
      modified: new Date("2026-06-03T07:00:00.000Z"),
      messageCount: 2,
      cwd: "/tmp/work",
      agentId: "deleted",
      agentName: "Deleted Agent",
      agentDeleted: true,
      readOnlyReason: "agent_deleted",
      continuationAvailable: true,
    };

    app.route("/api", createSessionsRoute({
      listSessions: vi.fn(async () => [session]),
      rcState: null,
    }));

    const res = await app.request("/api/sessions");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data[0]).toMatchObject({
      path: session.path,
      agentDeleted: true,
      readOnlyReason: "agent_deleted",
      continuationAvailable: true,
    });
  });

  it("creates a primary-agent continuation from a deleted-agent session", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const hub = { eventBus: { emit: vi.fn() } };
    const agentsDir = path.join(tmpDir, "agents");
    const oldPath = path.join(agentsDir, "deleted", "sessions", "old.jsonl");
    const newPath = path.join(agentsDir, "hana", "sessions", "new.jsonl");
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, JSON.stringify({ role: "user", content: "old hello" }) + "\n");
    const engine = {
      agentsDir,
      agentIdFromSessionPath: vi.fn(() => "deleted"),
      isAgentDeleted: vi.fn(() => true),
      isDeletedAgentSession: vi.fn(() => true),
      continueDeletedAgentSession: vi.fn(async () => ({
        sessionPath: newPath,
        agentId: "hana",
        agentName: "Hana",
        cwd: "/tmp/work",
        workspaceFolders: [],
        compacted: false,
        compactionError: "model unavailable",
      })),
      getSessionWorkspaceFolders: vi.fn(() => []),
      getAgent: vi.fn(() => ({ agentName: "Hana" })),
      planMode: false,
      permissionMode: "ask",
      accessMode: "ask",
      getSessionThinkingLevel: vi.fn(() => "medium"),
      memoryModelUnavailableReason: null,
    };

    app.route("/api", createSessionsRoute(engine, hub));

    const res = await app.request("/api/sessions/continue-deleted-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: oldPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.continueDeletedAgentSession).toHaveBeenCalledWith(oldPath);
    expect(data).toMatchObject({
      ok: true,
      path: newPath,
      agentId: "hana",
      compacted: false,
      compactionError: "model unavailable",
    });
    expect(hub.eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session_created",
        session: expect.objectContaining({ path: newPath, agentId: "hana" }),
      }),
      newPath,
    );
  });

  it("returns typed 422 when a deleted-agent continuation source has no transcript", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const agentsDir = path.join(tmpDir, "agents");
    const oldPath = path.join(agentsDir, "deleted", "sessions", "empty.jsonl");
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, "{}\n");
    const emptyError = new Error("continueDeletedAgentSession: source session has no displayable transcript") as any;
    emptyError.code = "SESSION_TRANSCRIPT_EMPTY";
    emptyError.status = 422;
    const engine = {
      agentsDir,
      agentIdFromSessionPath: vi.fn(() => "deleted"),
      isAgentDeleted: vi.fn(() => true),
      isDeletedAgentSession: vi.fn(() => true),
      continueDeletedAgentSession: vi.fn(async () => {
        throw emptyError;
      }),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/continue-deleted-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: oldPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(422);
    expect(data).toMatchObject({
      code: "SESSION_TRANSCRIPT_EMPTY",
      error: "continueDeletedAgentSession: source session has no displayable transcript",
    });
  });

  it("returns an actionable typed 422 when fresh compaction cannot replay retained history", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const { CompactionHistoryReplayError } = await import("../core/session-compactor.ts");
    const app = new Hono();
    const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "unsafe.jsonl");
    const replayError = new CompactionHistoryReplayError({
      boundaryRegion: "retained",
      safeBoundaryCount: 0,
    });
    const engine = {
      agentsDir: path.join(tmpDir, "agents"),
      isDeletedAgentSession: vi.fn(() => false),
      freshCompactDesktopSession: vi.fn(async () => {
        throw replayError;
      }),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/fresh-compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sessionPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(422);
    expect(engine.freshCompactDesktopSession).toHaveBeenCalledWith(sessionPath);
    expect(data).toMatchObject({
      code: "COMPACTION_HISTORY_REPLAY_UNPROCESSABLE",
      error: expect.stringContaining("cannot be compacted safely"),
    });
  });

  it("rejects content/runtime writes but allows safe unpin for deleted-agent sessions", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const deletedPath = "/tmp/agents/deleted/sessions/old.jsonl";
    const engine = {
      agentsDir: "/tmp/agents",
      agentIdFromSessionPath: vi.fn(() => "deleted"),
      isAgentDeleted: vi.fn(() => true),
      isDeletedAgentSession: vi.fn(() => true),
      setSessionPinned: vi.fn(async () => ({ pinnedAt: null, pinOrder: null })),
      switchSession: vi.fn(),
      saveSessionTitle: vi.fn(),
      rcState: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const pin = await app.request("/api/sessions/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: deletedPath, pinned: true }),
    });
    const unpin = await app.request("/api/sessions/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: deletedPath, pinned: false }),
    });
    const rename = await app.request("/api/sessions/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: deletedPath, title: "Nope" }),
    });
    const switchRes = await app.request("/api/sessions/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: deletedPath }),
    });

    expect(pin.status).toBe(409);
    expect(unpin.status).toBe(200);
    expect(rename.status).toBe(409);
    expect(switchRes.status).toBe(409);
    expect(await pin.json()).toMatchObject({ error: "agent_deleted" });
    expect(engine.setSessionPinned).toHaveBeenCalledWith({ sessionPath: deletedPath }, false);
    expect(engine.saveSessionTitle).not.toHaveBeenCalled();
    expect(engine.switchSession).not.toHaveBeenCalled();
  });

  it("deleted-agent 门禁以 engine.isDeletedAgentSession 为准（manifest 归属存活时放行 pin）", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    // 物理路径在已删除 agent 目录（路径口径会拦），manifest 归属存活 agent（权威口径放行）
    const movedPath = "/tmp/agents/deleted/sessions/moved.jsonl";
    const engine = {
      agentsDir: "/tmp/agents",
      agentIdFromSessionPath: vi.fn(() => "deleted"),
      isAgentDeleted: vi.fn(() => true),
      isDeletedAgentSession: vi.fn(() => false),
      setSessionPinned: vi.fn(async () => "2026-07-08T00:00:00.000Z"),
      rcState: null,
    };
    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: movedPath, pinned: true }),
    });

    expect(res.status).toBe(200);
    expect(engine.setSessionPinned).toHaveBeenCalled();
    expect(engine.isDeletedAgentSession).toHaveBeenCalledWith(movedPath);
  });

  it("rejects session projection when the authenticated Studio differs from the server Studio", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();

    app.use("*", async (c, next) => {
      (c as any).set("authPrincipal", Object.freeze({
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        trustState: "lan",
        serverNodeId: "node_projection",
        userId: "user_projection",
        studioId: "studio_other",
        studioIds: ["studio_other"],
        deviceId: "device_phone",
        scopes: ["chat"],
      }));
      await next();
    });
    app.route("/api", createSessionsRoute({
      getRuntimeContext: () => ({
        serverId: "server_projection",
        serverNodeId: "node_projection",
        userId: "user_projection",
        studioId: "studio_projection",
        connectionKind: "local",
        credentialKind: "loopback_token",
        platformAccountId: null,
        officialServiceKind: null,
      }),
      listSessions: vi.fn(async () => {
        throw new Error("should not list sessions for mismatched Studio");
      }),
      rcState: null,
    }));

    const res = await app.request("/api/sessions");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "studio_scope_mismatch",
      detail: "authenticated Studio does not match this server Studio",
    });
  });

  it("includes summary presence in the session list response", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const summaryManager = {
      getSummary: vi.fn((sessionId) => (
        sessionId === "has-summary"
          ? { session_id: sessionId, summary: "### 重要事实\n- 用户在做记忆系统。" }
          : null
      )),
    };

    const engine = {
      getSessionIdForPath: vi.fn((sessionPath) => (
        sessionPath.endsWith("has-summary.jsonl") ? "sess_has_summary" : "sess_no_summary"
      )),
      listSessions: vi.fn(async () => [
        {
          path: "/tmp/agents/hana/sessions/has-summary.jsonl",
          title: "Has summary",
          firstMessage: "hello",
          modified: new Date("2026-04-29T07:00:00.000Z"),
          messageCount: 2,
          cwd: "/tmp/work",
          agentId: "hana",
          agentName: "Hana",
        },
        {
          path: "/tmp/agents/hana/sessions/no-summary.jsonl",
          title: "No summary",
          firstMessage: "hello",
          modified: new Date("2026-04-29T06:00:00.000Z"),
          messageCount: 1,
          cwd: "/tmp/work",
          agentId: "hana",
          agentName: "Hana",
        },
      ]),
      getAgent: vi.fn(() => ({ summaryManager })),
      rcState: null,
    };

    app.route("/api", createSessionsRoute(engine));
    summaryManager.getSummary.mockImplementation((sessionId) => (
      sessionId === "sess_has_summary"
        ? { session_id: sessionId, summary: "### 重要事实\n- 用户在做记忆系统。" }
        : null
    ));

    const res = await app.request("/api/sessions");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.map((s) => [s.path, s.hasSummary])).toEqual([
      ["/tmp/agents/hana/sessions/has-summary.jsonl", true],
      ["/tmp/agents/hana/sessions/no-summary.jsonl", false],
    ]);
    expect(summaryManager.getSummary).toHaveBeenCalledWith("sess_has_summary");
    expect(summaryManager.getSummary).toHaveBeenCalledWith("sess_no_summary");
  });

  it("replays the latest user message through the branch-aware action", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "a.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "x\n");

    const engine = {
      agentsDir: path.join(tmpDir, "agents"),
      isSessionStreaming: vi.fn(() => false),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/latest-user-message/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: sessionPath,
        sourceEntryId: "entry-u1",
        clientMessageId: "client-u1",
        text: "edited",
        displayMessage: { text: "edited" },
        uiContext: { currentViewed: "/tmp/work", activeFile: null, activePreview: null, pinnedFiles: [] },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(replayLatestUserTurnMock).toHaveBeenCalledWith(engine, {
      sessionPath,
      sourceEntryId: "entry-u1",
      clientMessageId: "client-u1",
      replacementText: "edited",
      displayMessage: { text: "edited" },
      uiContext: { currentViewed: "/tmp/work", activeFile: null, activePreview: null, pinnedFiles: [] },
    });
  });

  it("retries an arbitrary active-branch node through the sessionId-first route", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "retry.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "x\n");

    const manifest = {
      sessionId: "sess_retry",
      lifecycle: "active",
      currentLocator: { path: sessionPath },
    };
    const engine = {
      agentsDir: path.join(tmpDir, "agents"),
      getSessionManifest: vi.fn(() => manifest),
      isSessionStreaming: vi.fn(() => false),
    };

    app.route("/api", createSessionsRoute(engine));
    const target = { role: "assistant", entryId: "entry-a2" };
    const res = await app.request("/api/sessions/turns/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: manifest.sessionId,
        sessionPath,
        target,
        clientMessageId: "client-u2",
        text: "edited question",
        displayMessage: { text: "edited question" },
        uiContext: { currentViewed: "/tmp/work", activeFile: null, activePreview: null, pinnedFiles: [] },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(retrySessionTurnMock).toHaveBeenCalledWith(engine, {
      sessionId: manifest.sessionId,
      sessionPath,
      target,
      clientMessageId: "client-u2",
      replacementText: "edited question",
      displayMessage: { text: "edited question" },
      uiContext: { currentViewed: "/tmp/work", activeFile: null, activePreview: null, pinnedFiles: [] },
    });
  });

  it("rejects a stale path paired with a valid sessionId before retrying", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const currentPath = path.join(tmpDir, "agents", "hana", "sessions", "current.jsonl");
    const stalePath = path.join(tmpDir, "agents", "hana", "sessions", "stale.jsonl");
    const engine = {
      agentsDir: path.join(tmpDir, "agents"),
      getSessionManifest: vi.fn(() => ({
        sessionId: "sess_retry",
        lifecycle: "active",
        currentLocator: { path: currentPath },
      })),
    };

    app.route("/api", createSessionsRoute(engine));
    const res = await app.request("/api/sessions/turns/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess_retry",
        sessionPath: stalePath,
        target: { role: "user", entryId: "entry-u1" },
      }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "session_locator_mismatch" });
    expect(retrySessionTurnMock).not.toHaveBeenCalled();
  });

  it("forks an arbitrary node into a new session and announces the child", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const sourcePath = path.join(tmpDir, "agents", "hana", "sessions", "source.jsonl");
    const childPath = path.join(tmpDir, "agents", "hana", "sessions", "child.jsonl");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "x\n");
    const hub = { eventBus: { emit: vi.fn() } };
    const sourceManifest = {
      sessionId: "sess_source",
      lifecycle: "active",
      currentLocator: { path: sourcePath },
    };
    const engine = {
      agentsDir: path.join(tmpDir, "agents"),
      getSessionManifest: vi.fn(() => sourceManifest),
      isSessionStreaming: vi.fn(() => false),
      forkSessionAtNode: vi.fn(async () => ({
        session: { internal: true },
        sessionId: "sess_child",
        sessionPath: childPath,
        path: childPath,
        agentId: "hana",
        cwd: "/tmp/work",
        workspaceFolders: ["/tmp/work"],
        authorizedFolders: ["/tmp/work"],
        permissionMode: "ask",
        thinkingLevel: "high",
      })),
      getAgent: vi.fn(() => ({ agentName: "Hana" })),
    };

    app.route("/api", createSessionsRoute(engine, hub));
    const target = { role: "assistant", entryId: "entry-a2" };
    const res = await app.request("/api/sessions/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: sourceManifest.sessionId,
        sessionPath: sourcePath,
        target,
      }),
    });

    expect(res.status).toBe(200);
    const responseBody = await res.json();
    expect(responseBody).toMatchObject({
      ok: true,
      sessionId: "sess_child",
      sessionPath: childPath,
      path: childPath,
      agentId: "hana",
    });
    expect(responseBody).not.toHaveProperty("session");
    expect(engine.forkSessionAtNode).toHaveBeenCalledWith({
      sessionId: sourceManifest.sessionId,
      sessionPath: sourcePath,
      target,
    });
    expect(hub.eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session_created",
        session: expect.objectContaining({ sessionId: "sess_child", path: childPath }),
      }),
      childPath,
    );
  });

  // retry 和 fork 是最容易接到外来异常的两条路由（重放会碰模型和文件，fork 会碰文件系统）。
  // 它们各自的无码默认值不同——retry 回 400、fork 回 500——这是既有的用户可见行为，
  // 收编到统一的状态码出口时必须原样保住，只把"越界状态码"这一种情形交给范围门。
  describe("retry / fork error status contract", () => {
    function activeSession(name) {
      const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", `${name}.jsonl`);
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, "x\n");
      return {
        sessionPath,
        manifest: {
          sessionId: `sess_${name}`,
          lifecycle: "active",
          currentLocator: { path: sessionPath },
        },
      };
    }

    async function retryWith(err) {
      const { createSessionsRoute } = await import("../server/routes/sessions.ts");
      const app = new Hono();
      const { sessionPath, manifest } = activeSession("retry-status");
      retrySessionTurnMock.mockRejectedValueOnce(err);
      app.route("/api", createSessionsRoute({
        agentsDir: path.join(tmpDir, "agents"),
        getSessionManifest: vi.fn(() => manifest),
        isSessionStreaming: vi.fn(() => false),
      }));
      const res = await app.request("/api/sessions/turns/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: manifest.sessionId,
          sessionPath,
          target: { role: "assistant", entryId: "entry-a2" },
        }),
      });
      return { res, raw: await res.text() };
    }

    async function forkWith(err) {
      const { createSessionsRoute } = await import("../server/routes/sessions.ts");
      const app = new Hono();
      const { sessionPath, manifest } = activeSession("fork-status");
      app.route("/api", createSessionsRoute({
        agentsDir: path.join(tmpDir, "agents"),
        getSessionManifest: vi.fn(() => manifest),
        isSessionStreaming: vi.fn(() => false),
        forkSessionAtNode: vi.fn().mockRejectedValue(err),
        getAgent: vi.fn(() => ({ agentName: "Hana" })),
      }));
      const res = await app.request("/api/sessions/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: manifest.sessionId,
          sessionPath,
          target: { role: "assistant", entryId: "entry-a2" },
        }),
      });
      return { res, raw: await res.text() };
    }

    it("keeps retry's 400 default for an error that declares no status", async () => {
      const { res } = await retryWith(new Error("retry blew up"));
      expect(res.status).toBe(400);
    });

    it("keeps fork's 500 default for an error that declares no status", async () => {
      const { res } = await forkWith(new Error("fork blew up"));
      expect(res.status).toBe(500);
    });

    it.each([
      ["retry", (e) => retryWith(e)],
      ["fork", (e) => forkWith(e)],
    ])("keeps the session_busy 409 special case on %s", async (_name, run) => {
      const { res } = await run(new Error("session_busy"));
      expect(res.status).toBe(409);
    });

    // 改动前这两条是红的：越界状态码原样交给 Response 构造会抛 RangeError，
    // 异常穿透 catch，客户端收到的是框架兜底的纯文本而不是我们的错误体。
    it.each([
      ["retry", (e) => retryWith(e)],
      ["fork", (e) => forkWith(e)],
    ])("clamps an out-of-range status to 500 on %s", async (_name, run) => {
      const err: any = new Error("upstream exit code leaked");
      err.status = 999;
      const { res, raw } = await run(err);
      expect(res.status).toBe(500);
      expect(JSON.parse(raw)).toMatchObject({ error: "upstream exit code leaked" });
    });
  });

  it("returns a session summary through an explicit route", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/with-summary.jsonl";
    const summaryManager = {
      getSummary: vi.fn(() => ({
        session_id: "with-summary",
        summary: "### 重要事实\n- 用户在做记忆系统。\n\n### 事情经过\n- 10:00 用户讨论 session 摘要。",
        created_at: "2026-04-29T07:00:00.000Z",
        updated_at: "2026-04-29T08:00:00.000Z",
      })),
    };

    const agentIdFromSessionPath = vi.fn((_sp: any) => "hana");
    const engine = {
      agentsDir: "/tmp/agents",
      agentIdFromSessionPath,
      resolveSessionOwnership: vi.fn((ref) => {
        const sp = typeof ref === "string" ? ref : ref?.sessionPath || null;
        const agentId = sp ? agentIdFromSessionPath(sp) || null : null;
        return { agentId, source: agentId ? "path" : "none", agentDeleted: false };
      }),
      getAgent: vi.fn(() => ({ summaryManager })),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/summary?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({
      hasSummary: true,
      summary: "### 重要事实\n- 用户在做记忆系统。\n\n### 事情经过\n- 10:00 用户讨论 session 摘要。",
      createdAt: "2026-04-29T07:00:00.000Z",
      updatedAt: "2026-04-29T08:00:00.000Z",
    });
    expect(engine.agentIdFromSessionPath).toHaveBeenCalledWith(sessionPath);
    expect(summaryManager.getSummary).toHaveBeenCalledWith("with-summary");
  });

  it("returns an empty summary state when the session has no summary", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const engine = {
      agentsDir: "/tmp/agents",
      agentIdFromSessionPath: vi.fn(() => "hana"),
      getAgent: vi.fn(() => ({ summaryManager: { getSummary: vi.fn(() => null) } })),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/summary?path=%2Ftmp%2Fagents%2Fhana%2Fsessions%2Fempty.jsonl");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({
      hasSummary: false,
      summary: null,
      createdAt: null,
      updatedAt: null,
    });
  });

  it("pins and unpins sessions through an explicit route", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const pinnedAt = "2026-04-29T08:00:00.000Z";

    const engine = {
      agentsDir: "/tmp/agents",
      setSessionPinned: vi.fn(async (_sessionPath, pinned) => (
        pinned ? { pinnedAt, pinOrder: -1024 } : { pinnedAt: null, pinOrder: null }
      )),
      getSessionIdForPath: vi.fn(() => "sess_route_pin"),
    };

    app.route("/api", createSessionsRoute(engine));

    const pinRes = await app.request("/api/sessions/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/agents/hana/sessions/a.jsonl", pinned: true }),
    });
    const pinData = await pinRes.json();

    expect(pinRes.status).toBe(200);
    expect(engine.setSessionPinned).toHaveBeenCalledWith({
      sessionId: "sess_route_pin",
      sessionPath: "/tmp/agents/hana/sessions/a.jsonl",
    }, true);
    expect(pinData).toEqual({ ok: true, pinnedAt, pinOrder: -1024, sessionId: "sess_route_pin" });

    const unpinRes = await app.request("/api/sessions/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/agents/hana/sessions/a.jsonl", pinned: false }),
    });
    const unpinData = await unpinRes.json();

    expect(unpinRes.status).toBe(200);
    expect(engine.setSessionPinned).toHaveBeenLastCalledWith({
      sessionId: "sess_route_pin",
      sessionPath: "/tmp/agents/hana/sessions/a.jsonl",
    }, false);
    expect(unpinData).toEqual({ ok: true, pinnedAt: null, pinOrder: null, sessionId: "sess_route_pin" });
  });

  it("applies a submitted pin order for the whole pinned strip", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const locators = {
      sess_a: "/tmp/agents/hana/sessions/a.jsonl",
      sess_b: "/tmp/agents/hana/sessions/b.jsonl",
    };

    const engine = {
      agentsDir: "/tmp/agents",
      getSessionManifest: vi.fn((sessionId) => (
        locators[sessionId] ? { sessionId, currentLocator: { path: locators[sessionId] } } : null
      )),
      setSessionPinOrder: vi.fn(async (refs) => refs.map((ref, index) => ({
        sessionId: ref.sessionId,
        pinOrder: (index + 1) * 1024,
      }))),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/pin-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds: ["sess_b", "sess_a"] }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.setSessionPinOrder).toHaveBeenCalledWith([
      { sessionId: "sess_b" },
      { sessionId: "sess_a" },
    ]);
    expect(data).toEqual({
      ok: true,
      orders: [
        { sessionId: "sess_b", pinOrder: 1024 },
        { sessionId: "sess_a", pinOrder: 2048 },
      ],
    });
  });

  it("rejects a pin order request that is empty, repeats a session, or names an unknown one", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();

    const engine = {
      agentsDir: "/tmp/agents",
      getSessionManifest: vi.fn((sessionId) => (
        sessionId === "sess_a"
          ? { sessionId, currentLocator: { path: "/tmp/agents/hana/sessions/a.jsonl" } }
          : null
      )),
      setSessionPinOrder: vi.fn(async () => []),
    };

    app.route("/api", createSessionsRoute(engine));

    async function post(body) {
      const res = await app.request("/api/sessions/pin-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, data: await res.json() };
    }

    expect((await post({ sessionIds: [] })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ sessionIds: ["sess_a", "sess_a"] }))).toMatchObject({
      status: 400,
      data: { code: "session_pin_order_duplicate" },
    });
    expect((await post({ sessionIds: ["sess_a", "sess_missing"] }))).toMatchObject({
      status: 404,
      data: { code: "session_manifest_not_found" },
    });
    expect(engine.setSessionPinOrder).not.toHaveBeenCalled();
  });

  it("surfaces an unpinned session in a pin order request as a client error", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();

    const engine = {
      agentsDir: "/tmp/agents",
      getSessionManifest: vi.fn((sessionId) => ({
        sessionId,
        currentLocator: { path: `/tmp/agents/hana/sessions/${sessionId}.jsonl` },
      })),
      setSessionPinOrder: vi.fn(async () => {
        const err: any = new Error("setSessionPinOrder: session sess_b is not pinned");
        err.code = "session_not_pinned";
        err.status = 400;
        err.sessionId = "sess_b";
        throw err;
      }),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/pin-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds: ["sess_a", "sess_b"] }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "session_not_pinned",
      sessionId: "sess_b",
    });
  });

  it("refuses a pin order request from a principal without session write scope", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();

    app.use("*", async (c, next) => {
      (c as any).set("authPrincipal", Object.freeze({
        kind: "device",
        credentialKind: "device_credential",
        connectionKind: "lan",
        trustState: "lan",
        serverNodeId: "node_projection",
        userId: "user_projection",
        studioId: "studio_projection",
        studioIds: ["studio_projection"],
        deviceId: "device_phone",
        scopes: [],
      }));
      await next();
    });

    const engine = {
      agentsDir: "/tmp/agents",
      getRuntimeContext: () => ({
        serverId: "server_projection",
        serverNodeId: "node_projection",
        userId: "user_projection",
        studioId: "studio_projection",
        connectionKind: "local",
        credentialKind: "loopback_token",
        platformAccountId: null,
        officialServiceKind: null,
      }),
      getSessionManifest: vi.fn((sessionId) => ({
        sessionId,
        currentLocator: { path: `/tmp/agents/hana/sessions/${sessionId}.jsonl` },
      })),
      setSessionPinOrder: vi.fn(async () => []),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/pin-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds: ["sess_a"] }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "insufficient_scope" });
    expect(engine.setSessionPinOrder).not.toHaveBeenCalled();
  });

  it("pins sessions by sessionId and rejects stale locator paths", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const pinnedAt = "2026-04-29T08:00:00.000Z";
    const currentPath = "/tmp/agents/hana/sessions/current.jsonl";

    const engine = {
      agentsDir: "/tmp/agents",
      getSessionManifest: vi.fn((sessionId) => (
        sessionId === "sess_route_pin"
          ? { sessionId, currentLocator: { path: currentPath } }
          : null
      )),
      setSessionPinned: vi.fn(async (_sessionPath, pinned) => (
        pinned ? { pinnedAt, pinOrder: -1024 } : { pinnedAt: null, pinOrder: null }
      )),
      getSessionIdForPath: vi.fn(() => "sess_route_pin"),
    };

    app.route("/api", createSessionsRoute(engine));

    const mismatch = await app.request("/api/sessions/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess_route_pin",
        path: "/tmp/agents/hana/sessions/stale.jsonl",
        pinned: true,
      }),
    });
    const mismatchData = await mismatch.json();

    expect(mismatch.status).toBe(409);
    expect(mismatchData).toMatchObject({
      code: "session_locator_mismatch",
      sessionId: "sess_route_pin",
      currentPath,
    });

    const res = await app.request("/api/sessions/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess_route_pin",
        pinned: true,
      }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.setSessionPinned).toHaveBeenCalledWith({
      sessionId: "sess_route_pin",
      sessionPath: currentPath,
    }, true);
    expect(data).toEqual({ ok: true, pinnedAt, pinOrder: -1024, sessionId: "sess_route_pin" });
  });

  it("clears pinned state before archiving a session", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const agentsDir = path.join(tmpDir, "agents");
    const sessionPath = path.join(agentsDir, "hana", "sessions", "a.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n", "utf-8");

    const engine = {
      agentsDir,
      closeSession: vi.fn(async () => {}),
      setSessionPinned: vi.fn(async () => null),
      moveSessionLifecycle: vi.fn(async () => ({ sessionId: "sess_archive" })),
      rcState: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sessionPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ ok: true, sessionId: "sess_archive" });
    expect(engine.setSessionPinned).toHaveBeenCalledWith({ sessionPath }, false);
    expect(fs.existsSync(path.join(path.dirname(sessionPath), "archived", path.basename(sessionPath)))).toBe(true);
  });

  it("suppresses deferred and confirm state by sessionId during archive cleanup", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const agentsDir = path.join(tmpDir, "agents");
    const sessionPath = path.join(agentsDir, "hana", "sessions", "a.jsonl");
    const archivedPath = path.join(path.dirname(sessionPath), "archived", path.basename(sessionPath));
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n", "utf-8");

    const deferredSuppressBySession = vi.fn();
    const confirmAbortBySession = vi.fn();
    const engine = {
      agentsDir,
      closeSession: vi.fn(async () => {}),
      setSessionPinned: vi.fn(async () => null),
      moveSessionLifecycle: vi.fn(async () => ({ sessionId: "sess_archive_cleanup" })),
      getSessionIdForPath: vi.fn((targetPath) => (
        targetPath === sessionPath || targetPath === archivedPath ? "sess_archive_cleanup" : null
      )),
      deferredResults: { suppressBySession: deferredSuppressBySession },
      confirmStore: { abortBySession: confirmAbortBySession },
      rcState: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sessionPath }),
    });

    expect(res.status).toBe(200);
    expect(deferredSuppressBySession).toHaveBeenCalledWith(
      { sessionId: "sess_archive_cleanup", sessionPath },
      "parent session archived",
    );
    expect(confirmAbortBySession).toHaveBeenCalledWith({
      sessionId: "sess_archive_cleanup",
      sessionPath,
    });
  });

  it("marks current todos completed and removed through an explicit session route", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const { SessionManager } = await import("../lib/pi-sdk/index.ts");
    const { loadLatestTodosFromSessionFile, loadLatestTodoSnapshotFromSessionFile } = await import("../lib/tools/todo-compat.ts");
    const { TODO_STATE_CUSTOM_TYPE } = await import("../lib/tools/todo-constants.ts");
    const app = new Hono();
    const agentsDir = path.join(tmpDir, "agents");
    const sessionDir = path.join(agentsDir, "hana", "sessions");
    const manager = SessionManager.create("/tmp/workspace", sessionDir);
    const sessionPath = manager.getSessionFile();
    const baseAssistantId = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "working" }],
      api: "test",
      provider: "test",
      model: "test",
      stopReason: "toolUse",
      timestamp: Date.now(),
    } as any);
    const currentTodoLeafId = manager.appendMessage({
      role: "toolResult",
      toolCallId: "todo-1",
      toolName: "todo_write",
      content: [{ type: "text", text: "1/2" }],
      isError: false,
      timestamp: Date.now(),
      details: {
        todos: [
          { content: "read", activeForm: "reading", status: "completed" },
          { content: "write", activeForm: "writing", status: "in_progress" },
        ],
      },
    });
    manager.branch(baseAssistantId);
    manager.appendCustomMessageEntry(
      TODO_STATE_CUSTOM_TYPE,
      "discarded todos",
      false,
      {
        source: "user",
        removed: false,
        todos: [{ content: "discarded", activeForm: "discarding", status: "in_progress" }],
      },
    );
    manager.branch(currentTodoLeafId);

    const openSessionManagerAtCurrentBranch = vi.fn(() => manager);
    const syncSessionBranchHead = vi.fn();
    const engine = {
      agentsDir,
      isSessionStreaming: vi.fn(() => false),
      getSessionByPath: vi.fn(() => null),
      openSessionManagerAtCurrentBranch,
      syncSessionBranchHead,
      emitEvent: vi.fn(),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/todos/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sessionPath }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ ok: true, todos: [] });
    expect(await loadLatestTodosFromSessionFile(sessionPath)).toEqual([]);
    expect(await loadLatestTodoSnapshotFromSessionFile(sessionPath)).toMatchObject({
      removed: true,
      source: "user",
      todos: [
        { content: "read", activeForm: "reading", status: "completed" },
        { content: "write", activeForm: "writing", status: "completed" },
      ],
    });
    expect(openSessionManagerAtCurrentBranch).toHaveBeenCalledWith(sessionPath, path.dirname(sessionPath));
    expect(syncSessionBranchHead).toHaveBeenCalledWith(sessionPath, manager, "todo_complete_append");
    expect(engine.emitEvent).toHaveBeenCalledWith({ type: "todo_update", todos: [] }, sessionPath);
  });

  it("infers subagent agent identity from child sessionPath when history details are missing", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "do work",
          sessionPath: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
          streamStatus: "done",
        },
      },
    ]);

    const agentIdFromSessionPath = vi.fn((sp) => {
      const rel = path.relative("/tmp/agents", sp);
      return rel.split(path.sep)[0] || null;
    });
    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
      agentIdFromSessionPath,
      resolveSessionOwnership: vi.fn((ref) => {
        const sp = typeof ref === "string" ? ref : ref?.sessionPath || null;
        const agentId = sp ? agentIdFromSessionPath(sp) || null : null;
        return { agentId, source: agentId ? "path" : "none", agentDeleted: false };
      }),
      getAgent: vi.fn((id) => (id === "hanako" ? { agentName: "Hanako" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toHaveLength(1);
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      agentId: "hanako",
      agentName: "Hanako",
      streamKey: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
    });
  });

  it("hydrates legacy path-only subagent blocks with sessionId and current manifest locator", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const legacyChildPath = "/tmp/agents/hanako/subagent-sessions/child-old.jsonl";
    const movedChildPath = "/tmp/agents/hanako/subagent-sessions/archive/child-new.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-legacy",
          task: "do work",
          sessionPath: legacyChildPath,
          streamStatus: "done",
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
      getSessionIdForPath: vi.fn((sp) => (
        sp === legacyChildPath || sp === movedChildPath ? "sess_child_legacy" : null
      )),
      getSessionManifest: vi.fn((id) => (
        id === "sess_child_legacy"
          ? { sessionId: id, currentLocator: { path: movedChildPath } }
          : null
      )),
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative("/tmp/agents", sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => (id === "hanako" ? { agentName: "Hanako" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      taskId: "subagent-legacy",
      sessionId: "sess_child_legacy",
      streamKey: movedChildPath,
    });
  });

  it("restores deferred subagent result as an interlude block before the following assistant reply", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/subagent-result.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] })
      .mockReturnValueOnce({ text: "received child result", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "评估大纲",
          taskTitle: "大纲评估",
          streamStatus: "done",
        },
      },
      {
        role: "custom",
        customType: "hana-background-result",
        content: "<hana-background-result task-id=\"subagent-1\" status=\"success\" type=\"subagent\">\n子助手完整回复\n</hana-background-result>",
        display: false,
      },
      { role: "assistant", content: "received child result" },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      agentIdFromSessionPath: vi.fn(() => "hana"),
      resolveSessionOwnership: vi.fn(() => ({ agentId: "hana", source: "path", agentDeleted: false })),
      getAgent: vi.fn((id) => (id === "hana" ? { agentName: "小花" } : null)),
      deferredResults: {
        query: vi.fn(() => ({
          status: "resolved",
          result: "子助手完整回复",
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "明",
            label: "大纲评估",
            summary: "请阅读整份长任务说明并输出完整评估",
          },
        })),
      },
      subagentRuns: { query: vi.fn(() => null) },
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    const interlude = data.blocks.find((b) => b.type === "interlude");
    expect(interlude).toMatchObject({
      afterIndex: 0,
      taskId: "subagent-1",
      sourceKind: "subagent",
      sourceLabel: "明 · 大纲评估",
      text: "小花 收到了来自 明 · 大纲评估 的回复",
      detailMarkdown: "子助手完整回复",
    });
    expect(interlude.text).not.toContain("长任务说明");
  });

  it("restores repeated deferred result occurrences for the same task as distinct interludes", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/subagent-result-repeat.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "card from checked results", images: [], thinking: "", toolUses: [] })
      .mockReturnValueOnce({ text: "received first delivery", images: [], thinking: "", toolUses: [] })
      .mockReturnValueOnce({ text: "received second delivery", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "card from checked results" },
      {
        role: "custom",
        customType: "hana-background-result",
        content: "<hana-background-result task-id=\"subagent-1\" status=\"success\" type=\"subagent\">\n子助手完整回复\n</hana-background-result>",
        display: false,
      },
      { role: "assistant", content: "received first delivery" },
      {
        role: "custom",
        customType: "hana-background-result",
        content: "<hana-background-result task-id=\"subagent-1\" status=\"success\" type=\"subagent\">\n子助手完整回复\n</hana-background-result>",
        display: false,
      },
      { role: "assistant", content: "received second delivery" },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      agentIdFromSessionPath: vi.fn(() => "hana"),
      getAgent: vi.fn((id) => (id === "hana" ? { agentName: "小花" } : null)),
      deferredResults: {
        query: vi.fn(() => ({
          status: "resolved",
          result: "子助手完整回复",
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "明",
            label: "大纲评估",
          },
        })),
      },
      subagentRuns: { query: vi.fn(() => null) },
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    const interludes = data.blocks.filter((b) => b.type === "interlude");
    expect(interludes).toHaveLength(2);
    expect(interludes.map((b) => b.taskId)).toEqual(["subagent-1", "subagent-1"]);
    expect(interludes.map((b) => b.afterIndex)).toEqual([0, 1]);
    expect(new Set(interludes.map((b) => b.id)).size).toBe(2);
  });

  it("exposes JSONL source order for messages and deferred interludes during restore", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/source-order.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "生成图片", images: [], thinking: "", toolUses: [] })
      .mockReturnValueOnce({ text: "最终报告", images: [], thinking: "", toolUses: [] })
      .mockReturnValueOnce({ text: "收到后台回复", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "生成图片" },
      {
        role: "toolResult",
        toolName: "media_generate-image",
        details: {
          mediaGeneration: {
            kind: "image",
            tasks: [{ taskId: "task-img" }],
          },
        },
      },
      {
        role: "custom",
        customType: "hana-deferred-result",
        data: {
          schemaVersion: 1,
          taskId: "task-img",
          status: "success",
          type: "image-generation",
          result: {
            sessionFiles: [{
              fileId: "sf_img",
              filePath: "/tmp/generated.png",
              label: "generated.png",
              ext: "png",
              mime: "image/png",
              kind: "image",
            }],
          },
        },
        display: false,
      },
      { role: "assistant", content: "最终报告" },
      {
        role: "custom",
        customType: "hana-background-result",
        content: "<hana-background-result task-id=\"subagent-1\" status=\"success\" type=\"subagent\">\n后台回复\n</hana-background-result>",
        display: false,
        details: { deliveryId: "delivery-after-final" },
      },
      { role: "assistant", content: "收到后台回复" },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      agentIdFromSessionPath: vi.fn(() => "hana"),
      getAgent: vi.fn((id) => (id === "hana" ? { agentName: "小花" } : null)),
      deferredResults: {
        query: vi.fn(() => ({
          status: "resolved",
          result: "后台回复",
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "明",
            label: "后台任务",
          },
        })),
      },
      subagentRuns: { query: vi.fn(() => null) },
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.messages.map((m) => [m.content, m.sourceIndex])).toEqual([
      ["生成图片", 0],
      ["最终报告", 3],
      ["收到后台回复", 5],
    ]);
    expect(data.blocks.some((b) => b.replacesTaskId === "task-img")).toBe(false);
    const interlude = data.blocks.find((b) => b.type === "interlude");
    expect(interlude).toMatchObject({
      afterIndex: 1,
      sourceIndex: 4,
      taskId: "subagent-1",
    });
  });

  it("restores consumed turn input ledger records as durable interludes before their assistant reply", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/turn-input-consumption.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "before delivery", images: [], thinking: "", toolUses: [] })
      .mockReturnValueOnce({ text: "收到 task-a", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "before delivery" },
      {
        role: "custom",
        id: "custom-task-a",
        customType: "hana-background-result",
        content: "<hana-background-result task-id=\"task-a\" status=\"success\" type=\"subagent\">\ndone\n</hana-background-result>",
        display: false,
        details: { deliveryId: "delivery-consumed" },
      },
      {
        role: "assistant",
        id: "assistant-task-a",
        content: "收到 task-a",
      },
      {
        role: "custom",
        customType: "turn_input_consumption",
        data: {
          schemaVersion: 1,
          deliveryId: "delivery-consumed",
          input: {
            entryId: "custom-task-a",
            customType: "hana-background-result",
            taskId: "task-a",
            deliveryId: "delivery-consumed",
          },
          assistant: {
            entryId: "assistant-task-a",
          },
          block: {
            type: "interlude",
            id: "interlude-delivery-consumed",
            deliveryId: "delivery-consumed",
            variant: "deferred_result",
            taskId: "task-a",
            status: "success",
            sourceKind: "subagent",
            sourceLabel: "Hanako · queued-task",
            text: "Hana 收到了来自 Hanako · queued-task 的回复",
            detailMarkdown: "done",
          },
        },
        display: false,
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      agentIdFromSessionPath: vi.fn(() => "hana"),
      getAgent: vi.fn((id) => (id === "hana" ? { agentName: "Hana" } : null)),
      deferredResults: {
        query: vi.fn(() => ({
          status: "resolved",
          result: "done",
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "Hanako",
            label: "queued-task",
          },
        })),
      },
      subagentRuns: { query: vi.fn(() => null) },
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    const interludes = data.blocks.filter((b) => b.type === "interlude");
    expect(interludes).toHaveLength(1);
    expect(interludes[0]).toMatchObject({
      afterIndex: 0,
      sourceIndex: 1,
      deliveryId: "delivery-consumed",
      taskId: "task-a",
      text: "Hana 收到了来自 Hanako · queued-task 的回复",
      detailMarkdown: "done",
    });
    expect(data.messages.find((message) => message.entryId === "assistant-task-a")).toMatchObject({
      turnInputEntryId: "custom-task-a",
      turnInputVisible: false,
    });
  });

  it("keeps deferred subagent interlude hidden in history until an assistant reply exists", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/subagent-result-pending-reply.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "custom",
        customType: "hana-background-result",
        content: "<hana-background-result task-id=\"subagent-1\" status=\"success\" type=\"subagent\">\n子助手完整回复\n</hana-background-result>",
        display: false,
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      agentIdFromSessionPath: vi.fn(() => "hana"),
      getAgent: vi.fn((id) => (id === "hana" ? { agentName: "小花" } : null)),
      deferredResults: {
        query: vi.fn(() => ({
          status: "resolved",
          result: "子助手完整回复",
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "明",
            label: "大纲评估",
          },
        })),
      },
      subagentRuns: { query: vi.fn(() => null) },
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks.some((b) => b.type === "interlude")).toBe(false);
  });

  it("does not attach a hidden deferred interlude across a later user message", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/subagent-result-cross-user.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] })
      .mockReturnValueOnce({ text: "new user question", images: [], thinking: "", toolUses: [] })
      .mockReturnValueOnce({ text: "reply to user question", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "custom",
        customType: "hana-background-result",
        content: "<hana-background-result task-id=\"subagent-1\" status=\"success\" type=\"subagent\">\n子助手完整回复\n</hana-background-result>",
        display: false,
      },
      { role: "user", content: "new user question" },
      { role: "assistant", content: "reply to user question" },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      agentIdFromSessionPath: vi.fn(() => "hana"),
      getAgent: vi.fn((id) => (id === "hana" ? { agentName: "小花" } : null)),
      deferredResults: {
        query: vi.fn(() => ({
          status: "resolved",
          result: "子助手完整回复",
          meta: {
            type: "subagent",
            interlude: true,
            executorAgentNameSnapshot: "明",
            label: "大纲评估",
          },
        })),
      },
      subagentRuns: { query: vi.fn(() => null) },
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks.some((b) => b.type === "interlude")).toBe(false);
  });

  it("loads session messages by sessionId and treats path as a legacy locator", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const currentPath = "/tmp/agents/hana/sessions/current.jsonl";

    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: "/tmp/agents/hana/sessions/focus.jsonl",
      getSessionManifest: vi.fn((sessionId) => (
        sessionId === "sess_messages"
          ? { sessionId, currentLocator: { path: currentPath } }
          : null
      )),
      agentIdFromSessionPath: vi.fn(() => "hana"),
      getAgent: vi.fn(() => ({ agentName: "Hana" })),
      getSessionFile: vi.fn(() => null),
      getSessionFileByPath: vi.fn(() => null),
      listSessionFiles: vi.fn(() => []),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(
      `/api/sessions/messages?sessionId=sess_messages&path=${encodeURIComponent("/tmp/agents/hana/sessions/stale.jsonl")}`,
    );

    expect(res.status).toBe(200);
    expect(msgUtils.loadSessionHistoryMessages).toHaveBeenCalledWith(engine, currentPath);
  });

  it("reload 时从 runStore 回填 workflow inline 块终态（running→done + 补 finishedAt）", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "hi" },
      {
        role: "toolResult",
        toolName: "workflow",
        details: { taskId: "workflow-1", workflow: "three-theme-poem", streamStatus: "running", startedAt: 1000 },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
      subagentRuns: {
        query: vi.fn((id) => id === "workflow-1"
          ? { taskId: "workflow-1", status: "resolved", summary: "诗", completedAt: "2026-05-31T08:26:49.160Z" }
          : null),
      },
    };

    app.route("/api", createSessionsRoute(engine));
    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    const wf = data.blocks.find((b) => b.type === "workflow");
    expect(wf).toMatchObject({ taskId: "workflow-1", streamStatus: "done", startedAt: 1000 });
    expect(wf.finishedAt).toBe(Date.parse("2026-05-31T08:26:49.160Z"));
  });

  it("workflow inline 块仍 pending 时保持 running（不误判完成）", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "hi" },
      {
        role: "toolResult",
        toolName: "workflow",
        details: { taskId: "workflow-2", workflow: "wf", streamStatus: "running", startedAt: 1000 },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
      subagentRuns: { query: vi.fn(() => ({ taskId: "workflow-2", status: "pending" })) },
    };

    app.route("/api", createSessionsRoute(engine));
    const res = await app.request("/api/sessions/messages");
    const data = await res.json();
    const wf = data.blocks.find((b) => b.type === "workflow");
    expect(wf.streamStatus).toBe("running");
  });

  it("首屏载入重发该会话的 workflow 活动（重启后右侧卡复原）", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "hi" },
    ]);

    const rebroadcastSession = vi.fn();
    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
      subagentRuns: null,
      activityHub: { rebroadcastSession },
    };

    app.route("/api", createSessionsRoute(engine));
    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent("/s/a.jsonl")}`);
    expect(res.status).toBe(200);
    expect(rebroadcastSession).toHaveBeenCalledWith("/s/a.jsonl");
  });

  it("翻页（before）不重发 workflow 活动（避免重复广播）", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "hi" },
    ]);

    const rebroadcastSession = vi.fn();
    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
      subagentRuns: null,
      activityHub: { rebroadcastSession },
    };

    app.route("/api", createSessionsRoute(engine));
    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent("/s/a.jsonl")}&before=5`);
    expect(res.status).toBe(200);
    expect(rebroadcastSession).not.toHaveBeenCalled();
  });

  it("includes session entry timestamps on displayable history messages", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "hello", images: [], thinking: "", toolUses: [] })
      .mockReturnValueOnce({ text: "hi back", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "user", content: "hello", timestamp: "2026-05-07T05:42:00.000Z" },
      { role: "assistant", content: "hi back", timestamp: "2026-05-07T05:43:00.000Z" },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.messages).toEqual([
      {
        id: "0",
        sourceIndex: 0,
        role: "user",
        content: "hello",
        timestamp: "2026-05-07T05:42:00.000Z",
      },
      {
        id: "1",
        sourceIndex: 1,
        role: "assistant",
        content: "hi back",
        timestamp: "2026-05-07T05:43:00.000Z",
      },
    ]);
  });

  it("projects the exact hidden turn input onto its assistant without relabeling the visible user", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const hiddenInput = '<hana-background-result task-id="task-1" status="success" type="subagent">done</hana-background-result>';

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "hello", images: [], thinking: "", toolUses: [] })
      .mockReturnValueOnce({ text: "first reply", images: [], thinking: "", toolUses: [] })
      .mockReturnValueOnce({ text: "background work", images: [], thinking: "", toolUses: [] })
      .mockReturnValueOnce({ text: "background reply", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { id: "entry-visible-user", role: "user", content: "hello" },
      { id: "entry-visible-assistant", role: "assistant", content: "first reply" },
      {
        id: "entry-hidden-input",
        role: "custom",
        customType: "hana-background-result",
        content: hiddenInput,
        display: false,
        details: { deliveryId: "delivery-1" },
      },
      { id: "entry-background-work", role: "assistant", content: "background work" },
      { id: "entry-background-assistant", role: "assistant", content: "background reply" },
    ]);

    app.route("/api", createSessionsRoute({
      agentsDir: "/tmp/agents",
      deferredResults: null,
      subagentRuns: null,
    }));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent("/tmp/hidden-turn.jsonl")}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.messages.find((message) => message.entryId === "entry-visible-assistant")).toMatchObject({
      turnInputEntryId: "entry-visible-user",
      turnInputVisible: true,
    });
    expect(data.messages.find((message) => message.entryId === "entry-background-assistant")).toMatchObject({
      turnInputEntryId: "entry-hidden-input",
      turnInputVisible: false,
    });
    expect(data.messages.find((message) => message.entryId === "entry-background-work")).toMatchObject({
      turnInputEntryId: "entry-hidden-input",
      turnInputVisible: false,
    });
  });

  it("does not expose legacy reminder blocks in REST history projections", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const raw = "[hana_reminder at 2026-07-05 14:05]\n- Plugin demo loaded\n[/hana_reminder]\n\nhello";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: raw, images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "user", content: raw },
    ]);

    app.route("/api", createSessionsRoute({
      agentsDir: "/tmp/agents",
      deferredResults: null,
    }));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.messages[0].content).toBe("hello");
  });

  it("strips Bridge internal time tags from loadMessages history for bridge sessions", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const bridgePath = "/tmp/agents/hana/sessions/bridge/owner/tg.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "<t>07-03 13:00</t> hello", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "user", content: "<t>07-03 13:00</t> hello" },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(bridgePath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.messages[0].content).toBe("hello");
  });

  it("returns empty assistant thinking blocks from history as completed thinking", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const content = [{ type: "thinking", thinking: "" }];

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.contentHasThinkingBlock).mockImplementation((candidate) => candidate === content);
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.messages).toEqual([{
      id: "0",
      sourceIndex: 0,
      role: "assistant",
      content: "",
      thinking: "",
    }]);
  });

  it("does not return OpenAI commentary-only history messages as visible text", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent).mockClear();
    vi.mocked(msgUtils.contentHasThinkingBlock).mockReturnValue(false);
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      {
        role: "assistant",
        content: [{
          type: "text",
          text: "I need to inspect the current state.",
          textSignature: JSON.stringify({
            v: 1,
            id: "msg_commentary",
            phase: "commentary",
          }),
        }],
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.messages).toEqual([]);
    expect(msgUtils.extractTextContent).not.toHaveBeenCalled();
  });

  it("hydrates only the requested display window for long session history", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const sourceMessages = Array.from({ length: 120 }, (_, i) => ({
      role: "assistant",
      content: `message ${i}`,
    }));

    vi.mocked(msgUtils.extractTextContent).mockClear();
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce(sourceMessages);
    vi.mocked(msgUtils.extractTextContent).mockImplementation((content) => ({
      text: String(content),
      images: [],
      thinking: "",
      toolUses: [],
    }));

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: "/tmp/agents/hana/sessions/long.jsonl",
      deferredResults: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages?limit=20");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.messages).toHaveLength(20);
    expect(data.messages[0]).toMatchObject({ id: "100", content: "message 100" });
    expect(data.messages[19]).toMatchObject({ id: "119", content: "message 119" });
    expect(msgUtils.extractTextContent).toHaveBeenCalledTimes(20);
  });

  it("pairs restored tool outcomes by call id and keeps missing results unknown", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "tool round" },
      { role: "toolResult", toolCallId: "call-fail", toolName: "read", isError: true, content: [{ type: "text", text: "file not found" }] },
      { role: "toolResult", toolCallId: "call-ok", toolName: "read", isError: false, content: [{ type: "text", text: "ok" }] },
    ]);
    vi.mocked(msgUtils.extractTextContent).mockReturnValueOnce({
      text: "",
      images: [],
      thinking: "",
      toolUses: [
        { id: "call-ok", name: "read" },
        { id: "call-fail", name: "read" },
        { id: "call-missing", name: "read" },
      ],
    });

    app.route("/api", createSessionsRoute({
      agentsDir: "/tmp/agents",
      deferredResults: null,
    }));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.messages[0].toolCalls).toEqual([
      expect.objectContaining({ id: "call-ok", status: "succeeded", success: true }),
      expect.objectContaining({ id: "call-fail", status: "failed", success: false, error: "file not found" }),
      expect.objectContaining({ id: "call-missing", status: "unknown", success: false }),
    ]);
  });

  it("does not return path-backed inline image base64 in session history", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({
        text: "[attached_image: /tmp/a.png]\nsee image",
        images: [{ data: "BASE64_A", mimeType: "image/png" }],
        thinking: "",
        toolUses: [],
      });
    vi.mocked(msgUtils.filterUnreferencedInlineImages).mockReturnValueOnce([]);
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "user", content: "image message" },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(msgUtils.filterUnreferencedInlineImages).toHaveBeenCalledWith(
      "[attached_image: /tmp/a.png]\nsee image",
      [{ data: "BASE64_A", mimeType: "image/png" }],
    );
    expect(data.messages[0]).toEqual({
      id: "0",
      sourceIndex: 0,
      role: "user",
      content: "[attached_image: /tmp/a.png]\nsee image",
    });
  });

  it("refreshes session file lifecycle metadata when rebuilding history blocks", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/main.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "I made a file", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "I made a file" },
      {
        role: "toolResult",
        toolName: "stage_files",
        details: {
          files: [
            {
              fileId: "sf_old",
              filePath: "/cache/old.png",
              label: "old.png",
              ext: "png",
              status: "available",
            },
          ],
        },
      },
      {
        role: "toolResult",
        toolName: "create_artifact",
        details: {
          artifactId: "art-1",
          type: "markdown",
          title: "Plan",
          content: "# Plan",
          artifactFile: {
            fileId: "sf_art",
            filePath: "/cache/plan.md",
            label: "Plan.md",
            ext: "md",
            status: "available",
          },
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      deferredResults: null,
      getSessionFile: vi.fn((fileId, options) => {
        expect(options).toEqual({ sessionPath });
        if (fileId === "sf_old") {
          return {
            id: "sf_old",
            filePath: "/cache/old.png",
            label: "old.png",
            ext: "png",
            mime: "image/png",
            kind: "image",
            storageKind: "managed_cache",
            status: "expired",
            missingAt: 1234,
          };
        }
        if (fileId === "sf_art") {
          return {
            id: "sf_art",
            filePath: "/cache/plan.md",
            label: "Plan.md",
            ext: "md",
            mime: "text/markdown",
            kind: "markdown",
            storageKind: "managed_cache",
            status: "expired",
            missingAt: 5678,
          };
        }
        return null;
      }),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toHaveLength(2);
    expect(data.blocks[0]).toMatchObject({
      type: "file",
      fileId: "sf_old",
      status: "expired",
      missingAt: 1234,
      mime: "image/png",
      kind: "image",
    });
    expect(data.blocks[1]).toMatchObject({
      type: "artifact",
      fileId: "sf_art",
      filePath: "/cache/plan.md",
      status: "expired",
      missingAt: 5678,
      mime: "text/markdown",
      kind: "markdown",
    });
  });

  it("returns session registry files alongside restored messages", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/main.jsonl";

    const activeMessages = [{
      id: "entry-u1",
      role: "user",
      content: [{ type: "text", text: '[SessionFile] {"fileId":"sf_write"}' }],
    }];
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce(activeMessages as any);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      runtimeContext: { studioId: "studio_route" },
      deferredResults: null,
      listSessionFiles: vi.fn((sp) => {
        expect(sp).toBe(sessionPath);
        return [{
          id: "sf_write",
          sessionPath,
          filePath: "/workspace/draft.md",
          label: "draft.md",
          ext: "md",
          mime: "text/markdown",
          kind: "markdown",
          origin: "agent_write",
          operations: ["created", "modified"],
          createdAt: 1234,
          status: "available",
        }];
      }),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.sessionFiles).toEqual([expect.objectContaining({
      fileId: "sf_write",
      filePath: "/workspace/draft.md",
      origin: "agent_write",
      operations: ["created", "modified"],
      createdAt: 1234,
      resource: expect.objectContaining({
        resourceId: "res_sf_write",
        name: "studios/studio_route/resources/res_sf_write",
        studioId: "studio_route",
        fileId: "sf_write",
      }),
    })]);
    expect(engine.listSessionFiles).toHaveBeenCalledWith(sessionPath, { references: activeMessages });
  });

  it("preserves repeated stage_files cards for the same SessionFile in history", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/repeated-stage.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "first delivery", images: [], thinking: "", toolUses: [] })
      .mockReturnValueOnce({ text: "second delivery", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "first delivery" },
      {
        role: "toolResult",
        toolName: "stage_files",
        details: {
          files: [
            { fileId: "sf_doc", filePath: "/workspace/doc.html", label: "doc.html", ext: "html" },
          ],
        },
      },
      { role: "assistant", content: "second delivery" },
      {
        role: "toolResult",
        toolName: "stage_files",
        details: {
          files: [
            { fileId: "sf_doc", filePath: "/workspace/doc.html", label: "doc.html", ext: "html" },
          ],
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      runtimeContext: { studioId: "studio_route" },
      deferredResults: null,
      getSessionFile: vi.fn((fileId, options) => {
        expect(fileId).toBe("sf_doc");
        expect(options).toEqual({ sessionPath });
        return {
          id: "sf_doc",
          filePath: "/workspace/doc.html",
          label: "doc.html",
          ext: "html",
          mime: "text/html",
          kind: "document",
          storageKind: "external",
          status: "available",
        };
      }),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.messages).toHaveLength(2);
    expect(data.blocks).toEqual([
      expect.objectContaining({
        type: "file",
        afterIndex: 0,
        fileId: "sf_doc",
        filePath: "/workspace/doc.html",
        label: "doc.html",
        status: "available",
      }),
      expect.objectContaining({
        type: "file",
        afterIndex: 1,
        fileId: "sf_doc",
        filePath: "/workspace/doc.html",
        label: "doc.html",
        status: "available",
      }),
    ]);
  });

  it("hydrates every legacy file block without fileId from the session file sidecar by path", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/legacy.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "legacy file", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "legacy file" },
      {
        role: "toolResult",
        toolName: "stage_files",
        details: {
          files: [
            { filePath: "/cache/legacy.png", label: "legacy.png", ext: "png" },
            { filePath: "/cache/second.png", label: "second.png", ext: "png" },
          ],
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      deferredResults: null,
      getSessionFile: vi.fn(),
      getSessionFileByPath: vi.fn((filePath, options) => {
        expect(options).toEqual({ sessionPath });
        if (filePath === "/cache/legacy.png") {
          return {
            id: "sf_legacy",
            filePath,
            label: "legacy.png",
            ext: "png",
            mime: "image/png",
            kind: "image",
            storageKind: "managed_cache",
            status: "expired",
            missingAt: 4321,
          };
        }
        if (filePath === "/cache/second.png") {
          return {
            id: "sf_second",
            filePath,
            label: "second.png",
            ext: "png",
            mime: "image/png",
            kind: "image",
            storageKind: "managed_cache",
            status: "available",
            missingAt: null,
          };
        }
        return null;
      }),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks[0]).toMatchObject({
      type: "file",
      fileId: "sf_legacy",
      filePath: "/cache/legacy.png",
      status: "expired",
      missingAt: 4321,
    });
    expect(data.blocks[1]).toMatchObject({
      type: "file",
      fileId: "sf_second",
      filePath: "/cache/second.png",
      status: "available",
    });
  });

  it("suppresses the iframe card and result of a since-retired image-generation plugin", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/media-restore.jsonl";
    const resultBody = JSON.stringify({
      sessionFiles: [{
        fileId: "sf_img",
        filePath: "/cache/generated.png",
        label: "generated.png",
        ext: "png",
        mime: "image/png",
        kind: "image",
        storageKind: "plugin_data",
        status: "available",
      }],
    }, null, 2).replace(/"/g, "&quot;");

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "submitted image", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "submitted image" },
      {
        role: "toolResult",
        toolName: "legacy_generate-image",
        details: {
          card: {
            type: "iframe",
            route: "/card?batch=old",
            title: "图片生成",
            pluginId: "retired-plugin",
          },
        },
      },
      {
        role: "custom",
        customType: "hana-background-result",
        content: `<hana-background-result task-id="task-img" status="success" type="image-generation">\n${resultBody}\n</hana-background-result>`,
        display: false,
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      deferredResults: null,
      // The card above was recorded by a plugin that is no longer
      // installed -- pluginManager confirms its absence so the guard drops
      // the stale iframe card instead of trying to render it.
      pluginManager: { getPlugin: () => null },
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toEqual([]);
  });

  it("restores plugin_card blocks from extension custom messages", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/plugin-card.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "card produced", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "card produced" },
      {
        role: "custom",
        customType: "finance-market",
        content: "",
        display: true,
        details: {
          card: {
            pluginId: "finance-market",
            route: "/card?id=quote",
            title: "Quote",
          },
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      deferredResults: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toEqual([{
      type: "plugin_card",
      afterIndex: 0,
      sourceIndex: 1,
      card: {
        pluginId: "finance-market",
        route: "/card?id=quote",
        title: "Quote",
        type: "iframe",
      },
    }]);
  });

  it("normalizes plugin chat surface cards from extension custom messages", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/plugin-chat-surface.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "chat surface produced", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "chat surface produced" },
      {
        role: "custom",
        customType: "tavern",
        content: "",
        display: true,
        details: {
          card: {
            pluginId: "tavern",
            type: "chat.surface",
            sessionRef: {
              sessionId: "sess_tavern",
              sessionPath: "/tmp/agents/hana/sessions/stale.jsonl",
            },
            title: "Tavern run",
          },
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      deferredResults: null,
      getSessionManifest: vi.fn((sessionId) => sessionId === "sess_tavern"
        ? {
          sessionId,
          currentLocator: { path: "/tmp/agents/hana/sessions/tavern-current.jsonl" },
          plugin: { ownerPluginId: "tavern", visibility: "plugin_private" },
        }
        : null),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toEqual([{
      type: "plugin_card",
      afterIndex: 0,
      sourceIndex: 1,
      card: {
        pluginId: "tavern",
        type: "chat.surface",
        sessionId: "sess_tavern",
        sessionPath: "/tmp/agents/hana/sessions/tavern-current.jsonl",
        sessionRef: {
          sessionId: "sess_tavern",
          sessionPath: "/tmp/agents/hana/sessions/tavern-current.jsonl",
        },
        title: "Tavern run",
      },
    }]);
  });

  it("does not restore deleted image generation from a legacy deferred result record", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/legacy-ledger.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "submitted image", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "submitted image" },
      {
        role: "toolResult",
        toolName: "media_generate-image",
        details: {
          mediaGeneration: {
            kind: "image",
            tasks: [{ taskId: "task-img" }],
          },
        },
      },
      {
        role: "custom",
        customType: "hana-deferred-result",
        data: {
          schemaVersion: 1,
          taskId: "task-img",
          status: "success",
          type: "image-generation",
          result: {
            sessionFiles: [{
              fileId: "sf_img",
              filePath: "/cache/generated.png",
              label: "generated.png",
              ext: "png",
              mime: "image/png",
              kind: "image",
              storageKind: "plugin_data",
              status: "available",
            }],
          },
        },
        display: false,
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      deferredResults: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toEqual([]);
  });

  it("prefers explicit executor metadata over owner-path inference", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "delegate to butter",
          requestedAgentId: "butter",
          requestedAgentNameSnapshot: "butter",
          executorAgentId: "butter",
          executorAgentNameSnapshot: "butter",
          sessionPath: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
          streamStatus: "done",
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative("/tmp/agents", sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => {
        if (id === "hanako") return { agentName: "Hanako" };
        if (id === "butter") return { agentName: "butter" };
        return null;
      }),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toHaveLength(1);
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      agentId: "butter",
      agentName: "butter",
      requestedAgentId: "butter",
      requestedAgentName: "butter",
      streamKey: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
    });
  });

  it("uses child-session executor snapshot when live agent has been deleted", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    const agentsDir = path.join(tmpDir, "agents");
    const childSessionPath = path.join(agentsDir, "hanako", "subagent-sessions", "child.jsonl");
    fs.mkdirSync(path.dirname(childSessionPath), { recursive: true });
    fs.writeFileSync(childSessionPath, "", "utf-8");
    fs.writeFileSync(
      path.join(path.dirname(childSessionPath), "session-meta.json"),
      JSON.stringify({
        "child.jsonl": {
          executorAgentId: "deleted-butter",
          executorAgentNameSnapshot: "butter",
          executorMetaVersion: 1,
        },
      }, null, 2),
      "utf-8",
    );

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "legacy delegated task",
          sessionPath: childSessionPath,
          streamStatus: "done",
        },
      },
    ]);

    const engine = {
      agentsDir,
      deferredResults: null,
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative(agentsDir, sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => (id === "hanako" ? { agentName: "Hanako" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toHaveLength(1);
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      agentId: "deleted-butter",
      agentName: "butter",
      streamKey: childSessionPath,
    });
  });

  it("uses manifest executor metadata before legacy child-session sidecars", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    const agentsDir = path.join(tmpDir, "agents");
    const childSessionPath = path.join(agentsDir, "hanako", "subagent-sessions", "child.jsonl");
    fs.mkdirSync(path.dirname(childSessionPath), { recursive: true });
    fs.writeFileSync(childSessionPath, "", "utf-8");

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "legacy delegated task",
          sessionPath: childSessionPath,
          streamStatus: "done",
        },
      },
    ]);

    const engine = {
      agentsDir,
      deferredResults: null,
      getSessionIdForPath: vi.fn((sp) => (sp === childSessionPath ? "sess_child" : null)),
      getSessionManifest: vi.fn((sessionId) => (
        sessionId === "sess_child"
          ? { currentLocator: { path: childSessionPath } }
          : null
      )),
      getSessionExecutorMetadata: vi.fn(() => ({
        executorAgentId: "deleted-butter",
        executorAgentNameSnapshot: "Butter Manifest",
        executorMetaVersion: 1,
      })),
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative(agentsDir, sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => (id === "hanako" ? { agentName: "Hanako" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.getSessionExecutorMetadata).toHaveBeenCalledWith({
      sessionId: "sess_child",
      sessionPath: childSessionPath,
    });
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      agentId: "deleted-butter",
      agentName: "Butter Manifest",
      streamKey: childSessionPath,
    });
  });

  it("keeps pending subagent block running even when child-session tail summary is available", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "do work",
          sessionPath: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
          streamStatus: "running",
        },
      },
    ]);
    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: {
        query: vi.fn(() => ({
          status: "pending",
          meta: {
            sessionPath: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
          },
        })),
      },
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative("/tmp/agents", sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => (id === "hanako" ? { agentName: "Hanako" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(msgUtils.loadLatestAssistantSummaryFromSessionFile).not.toHaveBeenCalled();
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      streamStatus: "running",
    });
  });

  it("marks running subagent block done only after deferred store resolves", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "do work",
          sessionPath: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
          streamStatus: "running",
        },
      },
    ]);
    vi.mocked(msgUtils.loadLatestAssistantSummaryFromSessionFile)
      .mockResolvedValueOnce("child finished");

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: {
        query: vi.fn(() => ({
          status: "resolved",
          result: "deferred result",
          meta: {
            sessionPath: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
          },
        })),
      },
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative("/tmp/agents", sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => (id === "hanako" ? { agentName: "Hanako" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(msgUtils.loadLatestAssistantSummaryFromSessionFile).toHaveBeenCalledWith("/tmp/agents/hanako/subagent-sessions/child.jsonl");
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      streamStatus: "done",
      summary: "child finished",
    });
  });

  it("deduplicates subagent summary reads by sessionId while resolving stale paths to the current locator", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();
    const staleChildPath = "/tmp/agents/hanako/subagent-sessions/stale-child.jsonl";
    const currentChildPath = "/tmp/agents/hanako/subagent-sessions/current-child.jsonl";

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-stale",
          task: "old child",
          sessionPath: staleChildPath,
          streamStatus: "running",
        },
      },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-current",
          task: "current child",
          sessionPath: currentChildPath,
          streamStatus: "running",
        },
      },
    ]);
    vi.mocked(msgUtils.loadLatestAssistantSummaryFromSessionFile).mockClear();
    vi.mocked(msgUtils.loadLatestAssistantSummaryFromSessionFile)
      .mockResolvedValueOnce("child finished once");

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: {
        query: vi.fn((taskId) => ({
          status: "resolved",
          result: "deferred result",
          meta: {
            sessionPath: taskId === "subagent-stale" ? staleChildPath : currentChildPath,
          },
        })),
      },
      getSessionIdForPath: vi.fn((sp) => (
        sp === staleChildPath || sp === currentChildPath ? "sess_child" : null
      )),
      getSessionManifest: vi.fn((sessionId) => (
        sessionId === "sess_child"
          ? { sessionId, currentLocator: { path: currentChildPath } }
          : null
      )),
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative("/tmp/agents", sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => (id === "hanako" ? { agentName: "Hanako" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toHaveLength(2);
    expect(msgUtils.loadLatestAssistantSummaryFromSessionFile).toHaveBeenCalledTimes(1);
    expect(msgUtils.loadLatestAssistantSummaryFromSessionFile).toHaveBeenCalledWith(currentChildPath);
    expect(data.blocks[0]).toMatchObject({ streamStatus: "done", summary: "child finished once" });
    expect(data.blocks[1]).toMatchObject({ streamStatus: "done", summary: "child finished once" });
  });

  it("hydrates running subagent block from durable run store when deferred delivery state is gone", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "do work",
          sessionPath: null,
          streamStatus: "running",
        },
      },
    ]);
    vi.mocked(msgUtils.loadLatestAssistantSummaryFromSessionFile)
      .mockResolvedValueOnce("child finished from durable run");

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: {
        query: vi.fn(() => null),
      },
      subagentRuns: {
        query: vi.fn(() => ({
          taskId: "subagent-1",
          parentSessionPath: "/tmp/agents/hanako/sessions/parent.jsonl",
          childSessionPath: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
          status: "resolved",
          summary: "durable result",
          requestedAgentId: "hanako",
          requestedAgentNameSnapshot: "Hanako",
          executorAgentId: "hanako",
          executorAgentNameSnapshot: "Hanako",
          executorMetaVersion: 1,
        })),
      },
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative("/tmp/agents", sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => (id === "hanako" ? { agentName: "Hanako" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine.subagentRuns.query).toHaveBeenCalledWith("subagent-1");
    expect(msgUtils.loadLatestAssistantSummaryFromSessionFile).toHaveBeenCalledWith("/tmp/agents/hanako/subagent-sessions/child.jsonl");
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      streamKey: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
      streamStatus: "done",
      summary: "child finished from durable run",
      agentId: "hanako",
      agentName: "Hanako",
    });
  });

  it("marks old unmapped running subagent block failed instead of leaving preview in an infinite connecting state", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    vi.mocked(msgUtils.loadLatestAssistantSummaryFromSessionFile).mockClear();
    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-legacy",
          task: "legacy child session without persisted mapping",
          sessionPath: null,
          streamStatus: "running",
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: {
        query: vi.fn(() => null),
      },
      subagentRuns: {
        query: vi.fn(() => null),
      },
      agentIdFromSessionPath: vi.fn(() => null),
      getAgent: vi.fn(() => null),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      streamKey: "",
      streamStatus: "failed",
      summary: "历史 subagent 链接不可恢复",
    });
    expect(msgUtils.loadLatestAssistantSummaryFromSessionFile).not.toHaveBeenCalled();
  });

  it("marks stale durable pending subagent run failed when the deferred runtime task is gone", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const msgUtils = await import("../core/message-utils.ts");
    const app = new Hono();

    vi.mocked(msgUtils.loadLatestAssistantSummaryFromSessionFile).mockClear();
    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-pending-stale",
          task: "legacy child session still marked running",
          sessionPath: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
          streamStatus: "running",
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: {
        query: vi.fn(() => null),
      },
      subagentRuns: {
        query: vi.fn(() => ({
          taskId: "subagent-pending-stale",
          parentSessionPath: "/tmp/agents/hanako/sessions/parent.jsonl",
          childSessionPath: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
          status: "pending",
          summary: "legacy pending",
        })),
      },
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative("/tmp/agents", sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => (id === "hanako" ? { agentName: "Hanako" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      streamKey: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
      streamStatus: "failed",
      summary: "历史 subagent 运行状态不可恢复",
    });
    expect(msgUtils.loadLatestAssistantSummaryFromSessionFile).not.toHaveBeenCalled();
  });

  it("exposes structured browser session states and returns refreshed states after close", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/browser.jsonl";
    const states = {
      [sessionPath]: {
        url: "https://example.com",
        running: false,
        resumable: true,
        unavailableReason: null,
      },
    };
    browserManagerMock.getBrowserSessionStates.mockReturnValue(states);

    app.route("/api", createSessionsRoute({ agentsDir: "/tmp/agents" }));

    const listRes = await app.request("/api/browser/session-states");
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual(states);

    const closeRes = await app.request("/api/browser/close-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionPath }),
    });
    expect(closeRes.status).toBe(200);
    expect(browserManagerMock.closeBrowserForSession).toHaveBeenCalledWith(sessionPath);
    expect(await closeRes.json()).toEqual({ ok: true, sessions: states });
  });

  it("emits browser_status when a browser session is closed through the route", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/browser.jsonl";
    const hub = { eventBus: { emit: vi.fn() } };

    app.route("/api", createSessionsRoute({ agentsDir: "/tmp/agents" }, hub));

    const res = await app.request("/api/browser/close-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionPath }),
    });

    expect(res.status).toBe(200);
    expect(hub.eventBus.emit).toHaveBeenCalledWith(
      { type: "browser_status", running: false, url: null },
      sessionPath,
    );
  });

  // ── #1610: web/mobile 会话修订点（revision）──

  it("passes the projection revision through the session list response", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();

    const engine = {
      listSessions: vi.fn(async () => [{
        path: "/tmp/agents/hana/sessions/a.jsonl",
        title: "Bridge thread",
        firstMessage: "hello",
        modified: new Date("2026-06-10T07:00:00.000Z"),
        messageCount: 2,
        cwd: "/tmp/work",
        agentId: "hana",
        agentName: "Hana",
        revision: "1024:1765500000000",
      }]),
      rcState: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data[0].revision).toBe("1024:1765500000000");
  });

  it("defaults the session list revision to null when the projection has none", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();

    const engine = {
      listSessions: vi.fn(async () => [{
        path: "/tmp/agents/hana/sessions/in-memory.jsonl",
        title: null,
        firstMessage: "",
        modified: new Date("2026-06-10T07:00:00.000Z"),
        messageCount: 0,
        cwd: "/tmp/work",
        agentId: "hana",
        agentName: "Hana",
      }]),
      rcState: null,
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data[0].revision).toBeNull();
  });

  it("returns the on-disk revision with the session messages payload", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();

    const agentsDir = path.join(tmpDir, "agents");
    const sessionDir = path.join(agentsDir, "hana", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "rc-target.jsonl");
    fs.writeFileSync(sessionPath, JSON.stringify({ type: "session", id: "s1", cwd: "/tmp/work" }) + "\n");
    const stat = fs.statSync(sessionPath);

    const engine = {
      agentsDir,
      currentSessionPath: sessionPath,
      deferredResults: null,
      agentIdFromSessionPath: vi.fn(() => "hana"),
      getAgent: vi.fn(() => ({ agentName: "Hana" })),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.revision).toBe(`${stat.size}:${stat.mtimeMs}`);
  });

  it("returns a null messages revision when the session file cannot be stat-ed", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.ts");
    const app = new Hono();
    const sessionPath = "/tmp/agents/hana/sessions/raced-away.jsonl";

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: sessionPath,
      deferredResults: null,
      agentIdFromSessionPath: vi.fn(() => "hana"),
      getAgent: vi.fn(() => ({ agentName: "Hana" })),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.revision).toBeNull();
  });
});
