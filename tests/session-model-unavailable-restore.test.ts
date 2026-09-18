import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSessionMock,
  sessionManagerOpenMock,
  refreshSessionModelFromRegistryMock,
} = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
  refreshSessionModelFromRegistryMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  emitSessionShutdown: vi.fn(async () => false),
  SessionManager: {
    create: vi.fn(),
    list: vi.fn(async () => []),
    open: sessionManagerOpenMock,
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
  estimateTokens: vi.fn(() => 10),
  resizeModelImageInput: vi.fn(async (image) => image),
  formatModelImageDimensionNote: vi.fn(() => undefined),
  refreshSessionModelFromRegistry: refreshSessionModelFromRegistryMock,
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.ts";

const LEGACY_MODEL_REF = {
  provider: "legacy-provider",
  modelId: "removed-chat-model",
};

const NEXT_MODEL = {
  id: "current-chat-model",
  name: "Current Chat Model",
  provider: "current-provider",
  api: "openai-completions",
  baseUrl: "https://models.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

function createManifestStore() {
  const byPath = new Map<string, any>();
  const branchHeads = new Map<string, any>();
  return {
    resolveByLocatorPath: vi.fn((sessionPath) => byPath.get(sessionPath) || null),
    getBySessionId: vi.fn((sessionId) => (
      [...byPath.values()].find((manifest) => manifest.sessionId === sessionId) || null
    )),
    createForPath: vi.fn((input) => {
      const manifest = {
        ...input,
        sessionId: "sess_unavailable_model",
        currentLocator: { path: input.sessionPath },
      };
      byPath.set(input.sessionPath, manifest);
      return manifest;
    }),
    getBranchHead: vi.fn((sessionId) => branchHeads.get(sessionId) || null),
    setBranchHead: vi.fn((sessionId, head) => {
      const stored = { ...head, sessionId };
      branchHeads.set(sessionId, stored);
      return stored;
    }),
    setMemoryPolicy: vi.fn(),
    setPermissionModeSnapshot: vi.fn(),
    setThinkingLevel: vi.fn(),
    setWorkspaceScope: vi.fn(),
    setPlugin: vi.fn(),
  };
}

describe("historical sessions whose model is unavailable", () => {
  let root: string;
  let sessionPath: string;
  let originalJsonl: string;
  let runtimeSession: any;

  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-model-unavailable-"));
    sessionPath = path.join(root, "agents", "hana", "sessions", "history.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    originalJsonl = [
      JSON.stringify({ type: "session", version: 3, id: "history", timestamp: "2026-07-01T00:00:00.000Z", cwd: root }),
      JSON.stringify({ type: "model_change", id: "model-change", parentId: null, timestamp: "2026-07-01T00:00:01.000Z", provider: LEGACY_MODEL_REF.provider, modelId: LEGACY_MODEL_REF.modelId }),
      JSON.stringify({ type: "message", id: "message-1", parentId: "model-change", timestamp: "2026-07-01T00:00:02.000Z", message: { role: "user", content: "old history", timestamp: 1 } }),
      "",
    ].join("\n");
    fs.writeFileSync(sessionPath, originalJsonl);

    const entries = originalJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const sessionManager = {
      getSessionFile: () => sessionPath,
      getCwd: () => root,
      buildSessionContext: () => ({
        model: LEGACY_MODEL_REF,
        messages: [{ role: "user", content: "old history", timestamp: 1 }],
      }),
      getEntries: () => entries,
      getEntry: (id) => entries.find((entry) => entry.id === id) || null,
      getLeafId: () => "message-1",
      branch: vi.fn(),
      resetLeaf: vi.fn(),
      getBranch: () => entries,
    };
    sessionManagerOpenMock.mockReturnValue(sessionManager);
    createAgentSessionMock.mockImplementation(async (options) => {
      runtimeSession = {
        sessionManager,
        model: options.model,
        messages: [{ role: "user", content: "old history", timestamp: 1 }],
        agent: {
          state: {
            model: options.model,
            messages: [{ role: "user", content: "old history", timestamp: 1 }],
            systemPrompt: "frozen prompt",
            tools: [],
          },
          streamFn: vi.fn(),
        },
        isStreaming: false,
        isCompacting: false,
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        setThinkingLevel: vi.fn(),
        getContextUsage: vi.fn(() => ({ tokens: 10, contextWindow: 128_000, percent: 0.01 })),
        prompt: vi.fn(async () => undefined),
        setModel: vi.fn(async (model) => {
          runtimeSession.model = model;
          runtimeSession.agent.state.model = model;
        }),
      };
      return { session: runtimeSession };
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createCoordinator({
    providerKnown = true,
    selection = {
      hasExplicitModels: false,
      configError: null,
      models: [{ id: "another-model" }],
    },
    credentials = { apiKey: "configured", baseUrl: "https://legacy.example/v1" },
  }: {
    providerKnown?: boolean;
    selection?: any;
    credentials?: any;
  } = {}) {
    const agent = {
      id: "hana",
      agentName: "Hana",
      agentDir: path.join(root, "agents", "hana"),
      sessionDir: path.dirname(sessionPath),
      memoryMasterEnabled: true,
      sessionMemoryEnabled: true,
      config: {},
      tools: [],
      buildSystemPrompt: vi.fn(() => "current prompt"),
    };
    const providerRegistry = {
      resolveChatProvider: vi.fn((providerId) => (
        providerKnown && providerId === LEGACY_MODEL_REF.provider
          ? { sourceProviderId: providerId, entry: { id: providerId } }
          : null
      )),
      getChatModelSelection: vi.fn(() => selection),
      getCredentials: vi.fn(() => credentials),
      allowsMissingApiKey: vi.fn(() => false),
    };
    const models = {
      currentModel: NEXT_MODEL,
      availableModels: [NEXT_MODEL],
      authStorage: {},
      modelRegistry: { find: vi.fn(() => null) },
      providerRegistry,
      resolveThinkingLevel: (level) => level || "medium",
      getModelDefaultThinkingLevel: () => "medium",
    };
    return new SessionCoordinator({
      agentsDir: path.join(root, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => models,
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: vi.fn(),
      emitDevLog: vi.fn(),
      getHomeCwd: () => root,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: vi.fn(async () => undefined),
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium", getChannelsEnabled: () => true }),
      getAgents: () => new Map([["hana", agent]]),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [agent],
      sessionManifestStore: createManifestStore(),
    });
  }

  it("restores history without fallback or JSONL rewrite and blocks prompting", async () => {
    const coordinator = createCoordinator();

    await expect(coordinator.switchSession(sessionPath)).resolves.toBeDefined();

    expect(createAgentSessionMock).toHaveBeenCalledOnce();
    expect(createAgentSessionMock.mock.calls[0][0].model).toMatchObject({
      id: LEGACY_MODEL_REF.modelId,
      provider: LEGACY_MODEL_REF.provider,
      api: "hana-unavailable-model",
    });
    expect(coordinator.getSessionModelAvailability(sessionPath)).toEqual({
      available: false,
      reason: "model_removed",
      modelRef: `${LEGACY_MODEL_REF.provider}/${LEGACY_MODEL_REF.modelId}`,
    });
    expect(coordinator._sessions.has("sess_unavailable_model")).toBe(true);
    expect(fs.readFileSync(sessionPath, "utf-8")).toBe(originalJsonl);

    await expect(coordinator.promptSession(sessionPath, "new turn", {})).rejects.toMatchObject({
      code: "MODEL_NOT_AVAILABLE",
      modelRef: `${LEGACY_MODEL_REF.provider}/${LEGACY_MODEL_REF.modelId}`,
      unavailableReason: "model_removed",
    });
    expect(runtimeSession.prompt).not.toHaveBeenCalled();
  });

  it("requires an explicit model selection before clearing the blocked state", async () => {
    const coordinator = createCoordinator();
    await coordinator.switchSession(sessionPath);

    await expect(coordinator.switchSessionModel(sessionPath, NEXT_MODEL)).resolves.toMatchObject({
      adaptations: [],
    });

    expect(runtimeSession.setModel).toHaveBeenCalledWith(NEXT_MODEL);
    expect(runtimeSession.model).toBe(NEXT_MODEL);
    expect(coordinator.getSessionModelAvailability(sessionPath)).toEqual({
      available: true,
      reason: null,
      modelRef: `${NEXT_MODEL.provider}/${NEXT_MODEL.id}`,
    });
    await expect(coordinator.promptSession(sessionPath, "continue", {})).resolves.toBeUndefined();
    expect(runtimeSession.prompt).toHaveBeenCalledWith("continue", undefined);
  });

  it("does not describe an unknown provider as a deleted model", async () => {
    const coordinator = createCoordinator({ providerKnown: false });

    await coordinator.switchSession(sessionPath);

    expect(coordinator.getSessionModelAvailability(sessionPath)).toMatchObject({
      available: false,
      reason: "provider_not_configured",
    });
  });

  it("uses a temporary reason when the provider contract still contains the model", async () => {
    const coordinator = createCoordinator({
      selection: {
        hasExplicitModels: false,
        configError: null,
        models: [{ id: LEGACY_MODEL_REF.modelId }],
      },
    });

    await coordinator.switchSession(sessionPath);

    expect(coordinator.getSessionModelAvailability(sessionPath)).toMatchObject({
      available: false,
      reason: "temporarily_unavailable",
    });
  });
});
