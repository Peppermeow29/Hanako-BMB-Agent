import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSessionMock,
  repairInlineMediaMock,
  sessionManagerOpenMock,
} = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  repairInlineMediaMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: { create: vi.fn(), open: sessionManagerOpenMock },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
  estimateTokens: vi.fn(() => 0),
  findCutPoint: vi.fn(),
  generateSummary: vi.fn(),
  emitSessionShutdown: vi.fn(),
  refreshSessionModelFromRegistry: vi.fn(),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../core/session-inline-media-prune.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    repairSessionInlineMediaEntriesInFile: (...args: any[]) => repairInlineMediaMock(...args),
  };
});

import { SessionCoordinator } from "../core/session-coordinator.ts";

function makeTool(name) {
  return { name, execute: vi.fn() };
}

function makeAgent({ id, sessionDir }) {
  return {
    id,
    agentDir: path.dirname(sessionDir),
    sessionDir,
    tools: [makeTool(`${id}-tool`)],
    config: { locale: "en", tools: {} },
    memoryMasterEnabled: true,
    get memoryEnabled() { return true; },
    get sessionMemoryEnabled() { return true; },
    setMemoryEnabled: vi.fn(),
    getToolsSnapshot: vi.fn(() => [makeTool(`${id}-tool`)]),
    buildSystemPrompt: vi.fn(() => `${id.toUpperCase()} PROMPT`),
  };
}

function makeRestoredSession(sessionPath) {
  return {
    sessionManager: { getSessionFile: () => sessionPath },
    subscribe: vi.fn(() => vi.fn()),
    setActiveToolsByName: vi.fn(),
    model: { id: "restored-model", provider: "test" },
  };
}

function createTestSessionManifestStore() {
  let nextId = 0;
  const manifestsByPath = new Map<string, any>();
  const manifestsById = new Map<string, any>();
  return {
    resolveByLocatorPath: vi.fn((sessionPath) => manifestsByPath.get(sessionPath) || null),
    getBySessionId: vi.fn((sessionId) => manifestsById.get(sessionId) || null),
    createForPath: vi.fn((input: any) => {
      const existing = manifestsByPath.get(input.sessionPath);
      if (existing) return existing;
      const manifest = {
        ...input,
        sessionId: `sess_test_${++nextId}`,
        lifecycle: input.lifecycle || "active",
        currentLocator: { path: input.sessionPath },
      };
      manifestsByPath.set(input.sessionPath, manifest);
      manifestsById.set(manifest.sessionId, manifest);
      return manifest;
    }),
    updateLocatorLifecycle: vi.fn(),
    setCapabilitySnapshot: vi.fn(),
    setPermissionModeSnapshot: vi.fn(),
    setThinkingLevel: vi.fn(),
  };
}

function makeCoordinator({ agentsDir, ownerAgent, tempDir, sessionManifestStore }: any) {
  return new SessionCoordinator({
    agentsDir,
    sessionManifestStore,
    getAgent: () => ownerAgent,
    getActiveAgentId: () => "owner",
    getModels: () => ({
      currentModel: { id: "owner-model", provider: "test" },
      availableModels: [{ id: "restored-model", provider: "test" }],
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: () => "medium",
    }),
    getResourceLoader: () => ({
      getSystemPrompt: () => "BASE PROMPT",
      getAppendSystemPrompt: () => [],
      getExtensions: () => ({ extensions: [], errors: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
    }),
    getSkills: () => ({ getSkillsForAgent: vi.fn(() => ({ skills: [], diagnostics: [] })) }),
    buildTools: (_cwd, customTools) => ({ tools: [makeTool("read")], customTools }),
    emitEvent: vi.fn(),
    getHomeCwd: () => tempDir,
    agentIdFromSessionPath: () => "owner",
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: (id) => (id === "owner" ? ownerAgent : null),
    listAgents: () => [],
  } as any);
}

describe("session-scoped invocation capability grants", () => {
  const CAPABILITY = "mcp_acme_search.invoke";
  let tempDir;
  let agentsDir;
  let ownerSessionDir;
  let sessionPath;
  let ownerAgent;
  let manifestStore;

  beforeEach(() => {
    vi.clearAllMocks();
    repairInlineMediaMock.mockReturnValue({
      repaired: false,
      stripped: 0,
      strippedImages: 0,
      strippedVideos: 0,
      strippedAudios: 0,
    });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-invocation-grant-"));
    agentsDir = path.join(tempDir, "agents");
    ownerSessionDir = path.join(agentsDir, "owner", "sessions");
    fs.mkdirSync(ownerSessionDir, { recursive: true });
    sessionPath = path.join(ownerSessionDir, "shared.jsonl");
    fs.writeFileSync(
      path.join(ownerSessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(sessionPath)]: { memoryEnabled: true } }, null, 2),
    );
    ownerAgent = makeAgent({ id: "owner", sessionDir: ownerSessionDir });
    sessionManagerOpenMock.mockImplementation(() => ({ getCwd: () => tempDir }));
    manifestStore = createTestSessionManifestStore();
    createAgentSessionMock.mockImplementation(async () => ({
      session: makeRestoredSession(sessionPath),
    }));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function loadedCoordinator() {
    const coordinator = makeCoordinator({
      agentsDir,
      ownerAgent,
      tempDir,
      sessionManifestStore: manifestStore,
    });
    await coordinator.ensureSessionLoaded(sessionPath);
    return coordinator;
  }

  it("grants a capability that later invocations in the same session can read back", async () => {
    const coordinator = await loadedCoordinator();
    expect(coordinator.getAllowedInvocationCapabilities(sessionPath)).toEqual([]);

    const result = coordinator.allowInvocationCapability(sessionPath, CAPABILITY);
    expect(result).toMatchObject({ ok: true, capability: CAPABILITY });
    expect(coordinator.getAllowedInvocationCapabilities(sessionPath)).toEqual([CAPABILITY]);

    // Granting twice is idempotent rather than accumulating duplicates.
    coordinator.allowInvocationCapability(sessionPath, CAPABILITY);
    expect(coordinator.getAllowedInvocationCapabilities(sessionPath)).toEqual([CAPABILITY]);
  });

  it("never writes the grant to session meta or the manifest snapshot", async () => {
    const coordinator = await loadedCoordinator();
    const metaSpy = vi.spyOn(coordinator, "writeSessionMeta");

    coordinator.allowInvocationCapability(sessionPath, CAPABILITY);
    // Force any queued meta write to settle before inspecting the file.
    await coordinator.writeSessionMeta(sessionPath, { memoryEnabled: true });

    // Contrast with permission mode, which persists through both of these.
    for (const [, partial] of metaSpy.mock.calls) {
      expect(Object.keys(partial || {})).not.toContain("sessionAllowedInvocationCapabilities");
    }

    const metaRaw = fs.readFileSync(path.join(ownerSessionDir, "session-meta.json"), "utf-8");
    expect(metaRaw).not.toContain("sessionAllowedInvocationCapabilities");
    expect(metaRaw).not.toContain(CAPABILITY);
    const entry = JSON.parse(metaRaw)[path.basename(sessionPath)];
    expect(entry).not.toHaveProperty("sessionAllowedInvocationCapabilities");

    for (const call of manifestStore.setCapabilitySnapshot.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(CAPABILITY);
    }
    for (const call of manifestStore.setPermissionModeSnapshot.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(CAPABILITY);
    }
    for (const call of manifestStore.createForPath.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(CAPABILITY);
    }
  });

  it("starts empty for a freshly loaded session, so a restart re-asks", async () => {
    const first = await loadedCoordinator();
    first.allowInvocationCapability(sessionPath, CAPABILITY);
    expect(first.getAllowedInvocationCapabilities(sessionPath)).toEqual([CAPABILITY]);

    // A new coordinator over the very same session files is the restart case:
    // nothing on disk can carry the grant forward.
    const restarted = await loadedCoordinator();
    expect(restarted.getAllowedInvocationCapabilities(sessionPath)).toEqual([]);
  });

  it("refuses to grant against an unloaded session instead of silently dropping it", async () => {
    const coordinator = makeCoordinator({
      agentsDir,
      ownerAgent,
      tempDir,
      sessionManifestStore: manifestStore,
    });
    expect(() => coordinator.allowInvocationCapability(sessionPath, CAPABILITY))
      .toThrow(/not loaded/);
    expect(coordinator.getAllowedInvocationCapabilities(sessionPath)).toEqual([]);
  });

  it("rejects an empty capability", async () => {
    const coordinator = await loadedCoordinator();
    for (const bad of ["", "   ", null, undefined, 42]) {
      expect(() => coordinator.allowInvocationCapability(sessionPath, bad))
        .toThrow(/capability is required/);
    }
    expect(coordinator.getAllowedInvocationCapabilities(sessionPath)).toEqual([]);
  });
});
