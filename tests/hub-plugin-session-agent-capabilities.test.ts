import { describe, expect, it, vi } from "vitest";

import { Hub } from "../hub/index.ts";

function createEngine(overrides: any = {}) {
  const engine: any = {
    agentsDir: "/agents",
    currentAgentId: "agent-a",
    setHubCallbacks: vi.fn(),
    setEventBus: vi.fn(),
    isSessionStreaming: vi.fn(() => false),
    promptSession: vi.fn(async () => {}),
    abortSession: vi.fn(async () => true),
    ensureSessionLoaded: vi.fn(async () => ({ sessionManager: { getCwd: () => "/work" } })),
    getSessionWorkspaceFolders: vi.fn(() => ["/work"]),
    getSessionAuthorizedFolders: vi.fn(() => ["/work"]),
    getSessionThinkingLevel: vi.fn(() => "medium"),
    getSessionPermissionMode: vi.fn(() => "default"),
    listSessions: vi.fn(async () => [{
      path: "/agents/agent-a/sessions/s.jsonl",
      title: "S",
      agentId: "agent-a",
      agentName: "Agent A",
      cwd: "/work",
    }]),
    createSession: vi.fn(async () => ({ sessionPath: "/agents/agent-a/sessions/new.jsonl", agentId: "agent-a" })),
    createSessionForAgent: vi.fn(async () => ({ sessionPath: "/agents/agent-b/sessions/new.jsonl", agentId: "agent-b" })),
    createDetachedSession: vi.fn(async () => ({ sessionPath: "/agents/agent-b/sessions/new.jsonl", agentId: "agent-b" })),
    currentSessionPath: "/agents/agent-a/sessions/focused.jsonl",
    persistSessionMeta: vi.fn(),
    setSessionPinned: vi.fn(async () => "2026-06-07T00:00:00.000Z"),
    setSessionProjectAssignment: vi.fn(async () => ({})),
    setSessionThinkingLevel: vi.fn(async (_sessionPath, level) => ({ ok: true, thinkingLevel: level })),
    setSessionPermissionModeForSession: vi.fn(() => ({ ok: true, permissionMode: "read-only" })),
    listAgents: vi.fn(() => [{
      id: "agent-a",
      name: "Agent A",
      yuan: "hanako",
      identity: "public intro",
      plugin: { ownerPluginId: null, visibility: "public" },
      isCurrent: true,
      isPrimary: true,
    }]),
    getAgent: vi.fn((agentId) => agentId === "agent-a"
      ? {
        id: "agent-a",
        agentName: "Agent A",
        config: { agent: { name: "Agent A", yuan: "hanako" }, plugin: { visibility: "public" } },
        personality: "identity text",
        memoryMasterEnabled: true,
        experienceEnabled: false,
      }
      : null),
    createAgent: vi.fn(async ({ name, id }) => ({ id: id || "plugin-agent", name })),
    updateConfig: vi.fn(async () => ({})),
    invalidateAgentListCache: vi.fn(),
    providerRegistry: {
      getCredentials: vi.fn(),
      getModelsByType: vi.fn(() => []),
      getAllModelsByType: vi.fn(() => []),
      getMediaProviders: vi.fn(() => []),
      getMediaProviderCredentialStatus: vi.fn(() => ({ hasCredentials: true, lanes: [], activeLaneId: null, activeProviderId: null })),
    },
    ...overrides,
  };
  return engine;
}

describe("Hub plugin-facing session and agent capabilities", () => {
  it("creates plugin-owned sessions through the detached engine session creation API", async () => {
    const engine = createEngine();
    const hub = new Hub({ engine });

    const result = await hub.eventBus.request("session:create", {
      agentId: "agent-b",
      cwd: "/work",
      memoryEnabled: false,
      ownerPluginId: "tavern",
      kind: "tavern",
      visibility: "plugin_private",
    });

    expect(result).toMatchObject({
      sessionPath: "/agents/agent-b/sessions/new.jsonl",
      agentId: "agent-b",
      ownerPluginId: "tavern",
      kind: "tavern",
      visibility: "plugin_private",
    });
    expect(engine.createDetachedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-b",
        cwd: "/work",
        memoryEnabled: false,
        ownerPluginId: "tavern",
        sessionKind: "tavern",
        sessionVisibility: "plugin_private",
      }),
    );
    expect(engine.createSessionForAgent).not.toHaveBeenCalled();
    // 回归钉子：detached 创建后焦点已还给上一个会话，
    // meta 必须写刚建出来的这个会话，不能写焦点会话。
    expect(engine.persistSessionMeta).toHaveBeenCalledWith("/agents/agent-b/sessions/new.jsonl");
    expect(engine.persistSessionMeta).not.toHaveBeenCalledWith("/agents/agent-a/sessions/focused.jsonl");
  });

  it("updates session metadata without writing conversation history directly", async () => {
    const engine = createEngine();
    const hub = new Hub({ engine });

    const result = await hub.eventBus.request("session:update", {
      sessionPath: "/agents/agent-a/sessions/s.jsonl",
      pinned: true,
      projectId: "project-a",
      thinkingLevel: "high",
      permissionMode: "read-only",
      visibility: "plugin_private",
    });

    expect(result.ok).toBe(true);
    expect(engine.setSessionPinned).toHaveBeenCalledWith("/agents/agent-a/sessions/s.jsonl", true);
    expect(engine.setSessionProjectAssignment).toHaveBeenCalledWith({
      sessionPath: "/agents/agent-a/sessions/s.jsonl",
      projectId: "project-a",
    });
    expect(engine.setSessionThinkingLevel).toHaveBeenCalledWith("/agents/agent-a/sessions/s.jsonl", "high");
    expect(engine.setSessionPermissionModeForSession).toHaveBeenCalledWith("/agents/agent-a/sessions/s.jsonl", "read-only");
  });

  it("resolves plugin session bus operations by sessionId before using legacy paths", async () => {
    const engine = createEngine({
      resolveSessionRef: vi.fn(() => ({
        sessionId: "sess_hub",
        currentLocator: { path: "/agents/agent-a/sessions/s.jsonl" },
      })),
      listSessions: vi.fn(async () => [{
        sessionId: "sess_hub",
        path: "/agents/agent-a/sessions/s.jsonl",
        title: "S",
        agentId: "agent-a",
      }]),
    });
    const hub = new Hub({ engine });

    const update = await hub.eventBus.request("session:update", {
      sessionId: "sess_hub",
      sessionPath: "/agents/agent-a/sessions/stale.jsonl",
      pinned: true,
    });
    const send = await hub.eventBus.request("session:send", {
      sessionId: "sess_hub",
      text: "hello",
    });

    expect(update.ok).toBe(true);
    expect(send).toMatchObject({
      accepted: true,
      sessionId: "sess_hub",
      sessionPath: "/agents/agent-a/sessions/s.jsonl",
    });
    expect(engine.setSessionPinned).toHaveBeenCalledWith("/agents/agent-a/sessions/s.jsonl", true);
    expect(engine.promptSession).toHaveBeenCalledWith(
      "/agents/agent-a/sessions/s.jsonl",
      "hello",
      expect.objectContaining({ sessionId: "sess_hub" }),
    );
  });

  it("returns public agent profiles and creates plugin-owned agents", async () => {
    const engine = createEngine();
    const hub = new Hub({ engine });

    await expect(hub.eventBus.request("agent:profile", { agentId: "agent-a" })).resolves.toMatchObject({
      profile: {
        id: "agent-a",
        name: "Agent A",
        memoryPolicy: { enabled: true },
      },
    });

    const created = await hub.eventBus.request("agent:create", {
      name: "Tavern Character",
      ownerPluginId: "tavern",
      visibility: "plugin_private",
    });

    expect(created).toMatchObject({
      agent: {
        id: "plugin-agent",
        name: "Tavern Character",
        ownerPluginId: "tavern",
        visibility: "plugin_private",
      },
    });
    expect(engine.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      name: "Tavern Character",
    }));
    expect(engine.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin: expect.objectContaining({
          ownerPluginId: "tavern",
          visibility: "plugin_private",
        }),
      }),
      { agentId: "plugin-agent" },
    );
  });
});
