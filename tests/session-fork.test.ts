import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireSessionOperation } from "../core/session-operation-lock.ts";

const { sessionManagerOpenMock } = vi.hoisted(() => ({
  sessionManagerOpenMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: vi.fn(),
  emitSessionShutdown: vi.fn(async () => false),
  estimateTokens: vi.fn(() => 1),
  refreshSessionModelFromRegistry: vi.fn(() => true),
  SessionManager: {
    create: vi.fn(),
    list: vi.fn(async () => []),
    open: sessionManagerOpenMock,
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
  resizeModelImageInput: vi.fn(async (image) => image),
  formatModelImageDimensionNote: vi.fn(() => undefined),
}));

import { SessionCoordinator } from "../core/session-coordinator.ts";

function createManifestStore() {
  let nextId = 0;
  const byId = new Map<string, any>();
  const byPath = new Map<string, any>();
  const capabilities = new Map<string, any>();
  const executors = new Map<string, any>();
  return {
    createForPath: vi.fn((input) => {
      const existing = byPath.get(input.sessionPath);
      if (existing) return existing;
      const manifest = {
        schemaVersion: 1,
        sessionId: `sess_fork_${++nextId}`,
        ownerAgentId: input.ownerAgentId || null,
        domain: input.domain || "desktop",
        kind: input.kind || "chat",
        lifecycle: input.lifecycle || "active",
        health: input.health || "ok",
        currentLocator: { path: input.sessionPath },
        memoryPolicy: input.memoryPolicy || {},
        permissionModeSnapshot: input.permissionModeSnapshot || {},
        thinkingLevel: input.thinkingLevel || null,
        pinnedAt: input.pinnedAt || null,
        workspaceScope: input.workspaceScope || {},
        plugin: input.plugin || null,
        provenance: input.provenance || {},
        migration: input.migration || {},
      };
      byId.set(manifest.sessionId, manifest);
      byPath.set(input.sessionPath, manifest);
      return manifest;
    }),
    resolveByLocatorPath: vi.fn((sessionPath) => byPath.get(sessionPath) || null),
    getBySessionId: vi.fn((sessionId) => byId.get(sessionId) || null),
    updateLocatorLifecycle: vi.fn((sessionId, sessionPath, lifecycle, reason) => {
      const current = byId.get(sessionId);
      if (!current) return null;
      if (current.currentLocator?.path) byPath.delete(current.currentLocator.path);
      const next = {
        ...current,
        lifecycle,
        currentLocator: { path: sessionPath, reason },
      };
      byId.set(sessionId, next);
      byPath.set(sessionPath, next);
      return next;
    }),
    setCapabilitySnapshot: vi.fn((sessionId, snapshot, options = {}) => {
      const next = { sessionId, ...snapshot, source: options.source || null };
      capabilities.set(sessionId, next);
      return next;
    }),
    getCapabilitySnapshot: vi.fn((sessionId) => capabilities.get(sessionId) || null),
    setExecutorMetadata: vi.fn((sessionId, metadata, options = {}) => {
      const next = { sessionId, ...metadata, source: options.source || null };
      executors.set(sessionId, next);
      return next;
    }),
    getExecutorMetadata: vi.fn((sessionId) => executors.get(sessionId) || null),
  };
}

function makeBranch(resourceKey = "visual-resource:kept") {
  return [
    { type: "custom", customType: "hana-message-presentation", id: "presentation-1", parentId: null, data: { text: "first" } },
    { type: "message", id: "user-1", parentId: "presentation-1", message: { role: "user", content: "first" } },
    { type: "message", id: "assistant-1", parentId: "user-1", message: { role: "assistant", content: "answer" } },
    { type: "message", id: "turn-tail-1", parentId: "assistant-1", message: { role: "toolResult", content: [{ type: "text", text: resourceKey }] } },
    { type: "custom", customType: "hana-message-presentation", id: "presentation-2", parentId: "turn-tail-1", data: { text: "second" } },
    { type: "message", id: "user-2", parentId: "presentation-2", message: { role: "user", content: "second" } },
    { type: "message", id: "assistant-2", parentId: "user-2", message: { role: "assistant", content: "later answer" } },
  ];
}

function createHarness(tempDir, { restoreFails = false } = {}) {
  const agentsDir = path.join(tempDir, "agents");
  const sessionDir = path.join(agentsDir, "hana", "sessions");
  const sourceSessionPath = path.join(sessionDir, "source.jsonl");
  const childSessionPath = path.join(sessionDir, "child.jsonl");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(sourceSessionPath, "source session bytes\n", "utf-8");

  const branch = makeBranch();
  const sourceManager: any = {
    fileEntries: [],
    flushed: true,
    nextChildSessionPath: childSessionPath,
    nextPiSessionId: "pi-child",
    getSessionId: vi.fn(() => sourceManager.fileEntries[0]?.id || "pi-source"),
    getBranch: vi.fn(() => branch),
    getCwd: vi.fn(() => path.join(tempDir, "workspace")),
    createBranchedSession: vi.fn((leafId) => {
      const boundaryIndex = branch.findIndex((entry) => entry.id === leafId);
      sourceManager.fileEntries = [
        { type: "session", id: sourceManager.nextPiSessionId, cwd: path.join(tempDir, "workspace") },
        ...branch.slice(0, boundaryIndex + 1),
      ];
      return sourceManager.nextChildSessionPath;
    }),
    _rewriteFile: vi.fn(() => {
      fs.writeFileSync(
        sourceManager.nextChildSessionPath,
        `${sourceManager.fileEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf-8",
      );
    }),
    _buildIndex: vi.fn(),
    appendCustomEntry: vi.fn((customType, data) => {
      const id = `custom-${sourceManager.fileEntries.length}`;
      sourceManager.fileEntries.push({
        type: "custom",
        id,
        parentId: sourceManager.fileEntries.at(-1)?.id || null,
        customType,
        data,
      });
      return id;
    }),
  };
  sessionManagerOpenMock.mockReturnValue(sourceManager);

  const manifestStore: any = createManifestStore();
  const sourceManifest = manifestStore.createForPath({
    sessionPath: sourceSessionPath,
    ownerAgentId: "hana",
    domain: "desktop",
    kind: "chat",
    lifecycle: "active",
    memoryPolicy: { mode: "enabled", inheritedFrom: "session_create" },
    permissionModeSnapshot: { mode: "ask", source: "session_create" },
    thinkingLevel: "high",
    workspaceScope: {
      primaryCwd: path.join(tempDir, "workspace"),
      workspaceFolders: [path.join(tempDir, "reference")],
      authorizedFolders: [path.join(tempDir, "workspace")],
    },
    provenance: { createdBy: "session_create" },
  });
  manifestStore.setCapabilitySnapshot(sourceManifest.sessionId, {
    toolNames: ["read", "write"],
    promptSnapshot: { version: 1, systemPrompt: "frozen prompt" },
    capabilityDriftDismissedFingerprint: "fp-1",
  }, { source: "session_create" });
  manifestStore.setExecutorMetadata(sourceManifest.sessionId, {
    executorAgentId: "hana",
    executorAgentNameSnapshot: "Hana",
    executorMetaVersion: 1,
  }, { source: "session_create" });
  fs.writeFileSync(path.join(sessionDir, "session-meta.json"), JSON.stringify({
    [path.basename(sourceSessionPath)]: {
      memoryEnabled: true,
      projectId: "project-alpha",
      promptSnapshot: { version: 1, systemPrompt: "frozen prompt" },
      toolNames: ["read", "write"],
      thinkingLevel: "high",
      pinnedAt: "2026-07-18T00:00:00.000Z",
      providerCacheAffinityKey: "pi-cache-lineage-source",
    },
  }), "utf-8");
  fs.writeFileSync(path.join(sessionDir, "session-titles.json"), JSON.stringify({
    [sourceManifest.sessionId]: "Fork source title",
  }), "utf-8");

  const agent = {
    id: "hana",
    name: "Hana",
    agentName: "Hana",
    agentDir: path.join(agentsDir, "hana"),
    sessionDir,
    runtimeInitialized: true,
  };
  const forkSessionFiles = vi.fn(() => ({ files: [{ id: "child-file" }], refs: [], fileIdMap: {} }));
  const discardForkedSessionFiles = vi.fn(() => ({ unloaded: true }));
  const forkSessionVisionNotes = vi.fn(() => ({ notes: 1, keys: ["visual-resource:kept"] }));
  const discardForkedSessionVisionNotes = vi.fn(() => true);
  const forkSessionCollabDrafts = vi.fn(() => ({ drafts: 0, suggestionIds: [], suggestionIdMap: {} }));
  const discardForkedSessionCollabDrafts = vi.fn(() => ({ discarded: 0 }));
  const initializeSessionMemoryForkBaseline = vi.fn(() => ({ ok: true }));
  const notifySessionMemoryForkCreated = vi.fn();
  const discardSessionMemoryForkBaseline = vi.fn(() => true);
  const forkSessionPluginConfig = vi.fn(() => ({ copied: 1 }));
  const discardForkedSessionPluginConfig = vi.fn(() => ({ discarded: 1 }));
  const forkSessionBrowserState = vi.fn(({ includeSourceState }) => (
    includeSourceState
      ? { copied: true, tabs: 1, url: "https://example.test" }
      : { copied: false, tabs: 0, url: null, reason: "historical_boundary" }
  ));
  const discardForkedSessionBrowserState = vi.fn(() => ({ discarded: true }));
  const subagentThreadStore = {
    forkOpenDirectThreads: vi.fn(async () => ({ clones: [], skipped: [], referencedThreadIds: [] })),
    discardForkedDirectThreads: vi.fn(async () => ({ removed: 0, clones: [], cleanupFailures: [] })),
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    upsert: vi.fn((threadId, record) => ({ threadId, ...record })),
    remove: vi.fn(() => true),
  };
  const taskRegistry = { query: vi.fn((_taskId?: string): any => null) };
  const deferredResultStore = { query: vi.fn((_taskId?: string): any => null) };
  const subagentRunStore = {
    query: vi.fn((_taskId?: string): any => null),
    forkSessionRuns: vi.fn(() => ({
      runs: 0,
      taskIds: [],
      taskIdMap: {},
      threadIdMap: {},
      skipped: [],
    })),
    forkSessionWorkflowRuns: vi.fn(() => ({
      runs: 0,
      taskIds: [],
      taskIdMap: {},
      skipped: [],
    })),
    discardForkedSessionRuns: vi.fn(() => ({ discarded: 0, skipped: [] })),
  };
  const activityHub = {
    forkSessionEntries: vi.fn(() => ({ entries: 0, activityIds: [], activityIdMap: {} })),
    discardForkedSessionEntries: vi.fn(() => ({ discarded: 0 })),
  };
  const forkSessionDeferredTasks = vi.fn((_options?: any) => ({ tasks: 0, taskIds: [] }));
  const discardForkedSessionDeferredTasks = vi.fn(() => ({ discarded: 0 }));
  const coordinator: any = new SessionCoordinator({
    agentsDir,
    getAgent: () => agent,
    getActiveAgentId: () => "hana",
    getModels: () => ({ currentModel: { id: "m", provider: "test" } }),
    getResourceLoader: () => ({}),
    getSkills: () => null,
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: vi.fn(),
    getHomeCwd: () => path.join(tempDir, "workspace"),
    agentIdFromSessionPath: () => "hana",
    switchAgentOnly: vi.fn(async () => undefined),
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map([["hana", agent]]),
    getActivityStore: () => null,
    getAgentById: (agentId) => agentId === "hana" ? agent : null,
    listAgents: () => [agent],
    isAgentDeleted: () => false,
    sessionManifestStore: manifestStore,
    forkSessionFiles,
    discardForkedSessionFiles,
    forkSessionVisionNotes,
    discardForkedSessionVisionNotes,
    forkSessionCollabDrafts,
    discardForkedSessionCollabDrafts,
    initializeSessionMemoryForkBaseline,
    notifySessionMemoryForkCreated,
    discardSessionMemoryForkBaseline,
    forkSessionPluginConfig,
    discardForkedSessionPluginConfig,
    forkSessionBrowserState,
    discardForkedSessionBrowserState,
    getSubagentThreadStore: () => subagentThreadStore,
    getTaskRegistry: () => taskRegistry,
    getDeferredResultStore: () => deferredResultStore,
    getSubagentRunStore: () => subagentRunStore,
    getActivityHub: () => activityHub,
    forkSessionDeferredTasks,
    discardForkedSessionDeferredTasks,
  });
  coordinator.ensureSessionLoaded = restoreFails
    ? vi.fn(async () => { throw new Error("restore failed"); })
    : vi.fn(async (requestedPath) => ({
        sessionManager: {
          getSessionFile: () => requestedPath,
          getCwd: () => path.join(tempDir, "workspace"),
        },
      }));

  return {
    agent,
    branch,
    childSessionPath,
    coordinator,
    discardForkedSessionFiles,
    discardForkedSessionVisionNotes,
    discardForkedSessionCollabDrafts,
    discardSessionMemoryForkBaseline,
    discardForkedSessionPluginConfig,
    discardForkedSessionBrowserState,
    discardForkedSessionDeferredTasks,
    forkSessionFiles,
    forkSessionVisionNotes,
    forkSessionPluginConfig,
    forkSessionBrowserState,
    forkSessionDeferredTasks,
    forkSessionCollabDrafts,
    initializeSessionMemoryForkBaseline,
    notifySessionMemoryForkCreated,
    manifestStore,
    sourceManager,
    sourceManifest,
    sourceSessionPath,
    subagentThreadStore,
    subagentRunStore,
    activityHub,
    taskRegistry,
  };
}

describe("SessionCoordinator session fork", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-fork-"));
    sessionManagerOpenMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates an independent child through the selected Agent turn and clones persistent state", async () => {
    const harness = createHarness(tempDir);
    const sourceBytes = fs.readFileSync(harness.sourceSessionPath, "utf-8");

    const result = await harness.coordinator.forkSessionAtNode({
      sessionId: harness.sourceManifest.sessionId,
      sessionPath: harness.sourceSessionPath,
      target: { role: "assistant", entryId: "assistant-1" },
    });

    expect(harness.sourceManager.createBranchedSession).toHaveBeenCalledWith("turn-tail-1");
    expect(fs.readFileSync(harness.sourceSessionPath, "utf-8")).toBe(sourceBytes);
    const childEntries = fs.readFileSync(harness.childSessionPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(childEntries.map((entry) => entry.id)).toContain("turn-tail-1");
    expect(childEntries.map((entry) => entry.id)).not.toContain("user-2");

    const retainedEntries = harness.branch.slice(0, 4);
    expect(harness.forkSessionFiles).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: harness.sourceManifest.sessionId,
      sourceSessionPath: harness.sourceSessionPath,
      targetSessionId: result.sessionId,
      targetSessionPath: harness.childSessionPath,
      retainedEntries,
    }));
    expect(harness.forkSessionVisionNotes).toHaveBeenCalledWith(expect.objectContaining({
      retainedEntries,
      targetSessionId: result.sessionId,
    }));
    expect(harness.initializeSessionMemoryForkBaseline).toHaveBeenCalledWith({
      agentId: "hana",
      sessionId: result.sessionId,
      sourceSessionId: harness.sourceManifest.sessionId,
      throughEntryId: "turn-tail-1",
      messageCount: 2,
      forkedAt: expect.any(String),
    });
    expect(harness.notifySessionMemoryForkCreated).toHaveBeenCalledWith({
      agentId: "hana",
      sessionId: result.sessionId,
      sessionPath: harness.childSessionPath,
    });
    expect(harness.coordinator.ensureSessionLoaded.mock.invocationCallOrder[0])
      .toBeLessThan(harness.notifySessionMemoryForkCreated.mock.invocationCallOrder[0]);
    expect(harness.forkSessionPluginConfig).toHaveBeenCalledWith({
      sourceSessionId: harness.sourceManifest.sessionId,
      sourceSessionPath: harness.sourceSessionPath,
      targetSessionId: result.sessionId,
      targetSessionPath: harness.childSessionPath,
    });
    expect(harness.forkSessionBrowserState).toHaveBeenCalledWith({
      sourceSessionId: harness.sourceManifest.sessionId,
      sourceSessionPath: harness.sourceSessionPath,
      targetSessionId: result.sessionId,
      targetSessionPath: harness.childSessionPath,
      includeSourceState: false,
    });
    expect(harness.subagentThreadStore.forkOpenDirectThreads).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: harness.sourceManifest.sessionId,
      sourceSessionPath: harness.sourceSessionPath,
      targetSessionId: result.sessionId,
      targetSessionPath: harness.childSessionPath,
      retainedEntries,
      cloneChildSession: expect.any(Function),
      discardChildSession: expect.any(Function),
    }));
    expect(harness.subagentRunStore.forkSessionRuns).toHaveBeenCalledWith({
      sourceSessionId: harness.sourceManifest.sessionId,
      sourceSessionPath: harness.sourceSessionPath,
      targetSessionId: result.sessionId,
      targetSessionPath: harness.childSessionPath,
      retainedEntries,
      threadClones: [],
    });
    expect(harness.forkSessionDeferredTasks).toHaveBeenCalledWith({
      sourceSessionId: harness.sourceManifest.sessionId,
      sourceSessionPath: harness.sourceSessionPath,
      targetSessionId: result.sessionId,
      targetSessionPath: harness.childSessionPath,
      taskIdMap: {},
    });
    const childManifest = harness.manifestStore.getBySessionId(result.sessionId);
    expect(childManifest).toMatchObject({
      ownerAgentId: "hana",
      lifecycle: "active",
      pinnedAt: null,
      thinkingLevel: "high",
      provenance: {
        createdBy: "session_fork",
        createdFromSessionId: harness.sourceManifest.sessionId,
        forkedFromEntryId: "turn-tail-1",
      },
    });
    expect(childManifest.workspaceScope.workspaceFolders).toEqual([path.join(tempDir, "reference")]);
    expect(harness.manifestStore.getCapabilitySnapshot(result.sessionId)).toMatchObject({
      toolNames: ["read", "write"],
      promptSnapshot: { version: 1, systemPrompt: "frozen prompt" },
      capabilityDriftDismissedFingerprint: "fp-1",
      source: "session_fork",
    });
    expect(harness.manifestStore.getExecutorMetadata(result.sessionId)).toMatchObject({
      executorAgentId: "hana",
      executorAgentNameSnapshot: "Hana",
      source: "session_fork",
    });

    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(harness.childSessionPath), "session-meta.json"), "utf-8"));
    expect(meta[path.basename(harness.childSessionPath)]).toMatchObject({
      memoryEnabled: true,
      projectId: "project-alpha",
      pinnedAt: null,
      providerCacheAffinityKey: "pi-cache-lineage-source",
      forkedFrom: {
        sessionId: harness.sourceManifest.sessionId,
        entryId: "turn-tail-1",
      },
      memoryForkBaseline: {
        sourceSessionId: harness.sourceManifest.sessionId,
        throughEntryId: "turn-tail-1",
        messageCount: 2,
      },
    });
    const titles = JSON.parse(fs.readFileSync(path.join(path.dirname(harness.childSessionPath), "session-titles.json"), "utf-8"));
    expect(titles[result.sessionId]).toBe("Fork source title");
    expect(result).toMatchObject({
      sessionId: result.sessionId,
      sessionPath: harness.childSessionPath,
      sourceSessionId: harness.sourceManifest.sessionId,
      forkedFromEntryId: "turn-tail-1",
      projectId: "project-alpha",
      permissionMode: "ask",
      thinkingLevel: "high",
    });
    expect(result).not.toHaveProperty("session");
    expect(harness.sourceManager.getSessionId()).toBe("pi-child");
  });

  it("captures a legacy source Pi id before branching and persists it as the child cache lineage", async () => {
    const harness = createHarness(tempDir);
    const metaPath = path.join(path.dirname(harness.sourceSessionPath), "session-meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    delete meta[path.basename(harness.sourceSessionPath)].providerCacheAffinityKey;
    fs.writeFileSync(metaPath, JSON.stringify(meta), "utf-8");

    const result = await harness.coordinator.forkSessionAtNode({
      sessionId: harness.sourceManifest.sessionId,
      sessionPath: harness.sourceSessionPath,
      target: { role: "assistant", entryId: "assistant-1" },
    });

    const childMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(childMeta[path.basename(harness.childSessionPath)].providerCacheAffinityKey).toBe("pi-source");
    expect(harness.sourceManager.getSessionId()).toBe("pi-child");
    expect(result.sessionId).not.toBe(harness.sourceManifest.sessionId);
  });

  it("keeps one immutable provider cache lineage across consecutive Fork generations", async () => {
    const harness = createHarness(tempDir);
    const child = await harness.coordinator.forkSessionAtNode({
      sessionId: harness.sourceManifest.sessionId,
      sessionPath: harness.sourceSessionPath,
      target: { role: "assistant", entryId: "assistant-1" },
    });
    const grandchildPath = path.join(path.dirname(harness.childSessionPath), "grandchild.jsonl");
    harness.sourceManager.nextChildSessionPath = grandchildPath;
    harness.sourceManager.nextPiSessionId = "pi-grandchild";
    harness.sourceManager.getBranch.mockReturnValue(harness.branch.slice(0, 4));

    const grandchild = await harness.coordinator.forkSessionAtNode({
      sessionId: child.sessionId,
      sessionPath: child.sessionPath,
      target: { role: "assistant", entryId: "assistant-1" },
    });

    const meta = JSON.parse(fs.readFileSync(
      path.join(path.dirname(harness.childSessionPath), "session-meta.json"),
      "utf-8",
    ));
    expect(meta[path.basename(child.sessionPath)].providerCacheAffinityKey).toBe("pi-cache-lineage-source");
    expect(meta[path.basename(grandchild.sessionPath)].providerCacheAffinityKey).toBe("pi-cache-lineage-source");
    expect(grandchild.sessionId).not.toBe(child.sessionId);
    expect(harness.sourceManager.getSessionId()).toBe("pi-grandchild");
  });

  it("persists provider cache lineage for cloned subagent child Sessions", async () => {
    const harness = createHarness(tempDir);
    const nestedDir = path.join(tempDir, "nested-sessions");
    const sourceNestedPath = path.join(nestedDir, "source-child.jsonl");
    const targetNestedPath = path.join(nestedDir, "forked-child.jsonl");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(sourceNestedPath, "source child bytes\n", "utf-8");
    const nestedBranch = [
      { type: "message", id: "nested-user", parentId: null, message: { role: "user", content: "work" } },
      { type: "message", id: "nested-assistant", parentId: "nested-user", message: { role: "assistant", content: "done" } },
    ];
    const nestedManager: any = {
      fileEntries: [],
      getCwd: () => path.join(tempDir, "workspace"),
      getSessionId: vi.fn(() => nestedManager.fileEntries[0]?.id || "pi-nested-source"),
      getBranch: vi.fn(() => nestedBranch),
      createBranchedSession: vi.fn((leafId) => {
        const boundaryIndex = nestedBranch.findIndex((entry) => entry.id === leafId);
        nestedManager.fileEntries = [
          { type: "session", id: "pi-nested-child", cwd: path.join(tempDir, "workspace") },
          ...nestedBranch.slice(0, boundaryIndex + 1),
        ];
        return targetNestedPath;
      }),
      _buildIndex: vi.fn(),
      _rewriteFile: vi.fn(() => {
        fs.writeFileSync(
          targetNestedPath,
          `${nestedManager.fileEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
          "utf-8",
        );
      }),
      appendCustomEntry: vi.fn((customType, data) => {
        nestedManager.fileEntries.push({
          type: "custom",
          id: `nested-custom-${nestedManager.fileEntries.length}`,
          parentId: nestedManager.fileEntries.at(-1)?.id || null,
          customType,
          data,
        });
      }),
    };
    sessionManagerOpenMock.mockReturnValueOnce(nestedManager);
    const sourceNestedManifest = harness.manifestStore.createForPath({
      sessionPath: sourceNestedPath,
      ownerAgentId: "hana",
      domain: "subagent",
      kind: "subagent_child",
      lifecycle: "active",
    });
    fs.writeFileSync(path.join(nestedDir, "session-meta.json"), JSON.stringify({
      [path.basename(sourceNestedPath)]: {
        providerCacheAffinityKey: "pi-nested-lineage",
        toolNames: ["read"],
      },
    }), "utf-8");

    const result = await harness.coordinator._cloneForkedSubagentChildSession({
      sourceThread: {
        threadId: "thread-source",
        agentId: "hana",
        childSessionId: sourceNestedManifest.sessionId,
        childSessionPath: sourceNestedPath,
      },
      sourceParentSession: {
        sessionId: harness.sourceManifest.sessionId,
        sessionPath: harness.sourceSessionPath,
      },
      targetParentSession: {
        sessionId: "sess-parent-fork",
        sessionPath: harness.childSessionPath,
      },
      newThreadId: "thread-fork",
      allowCurrentChildLeaf: true,
      targetSessionDir: nestedDir,
    }, new Map());

    const nestedMeta = JSON.parse(fs.readFileSync(path.join(nestedDir, "session-meta.json"), "utf-8"));
    expect(nestedMeta[path.basename(result.sessionPath)]).toMatchObject({
      providerCacheAffinityKey: "pi-nested-lineage",
      toolNames: ["read"],
      forkedFrom: {
        sessionId: sourceNestedManifest.sessionId,
        entryId: "nested-assistant",
      },
    });
    expect(nestedManager.getSessionId()).toBe("pi-nested-child");
  });

  it("keeps a verified Fork when asynchronous memory materialization cannot be scheduled", async () => {
    const harness = createHarness(tempDir);
    harness.notifySessionMemoryForkCreated.mockImplementation(() => {
      throw new Error("memory worker unavailable");
    });

    const result = await harness.coordinator.forkSessionAtNode({
      sessionId: harness.sourceManifest.sessionId,
      sessionPath: harness.sourceSessionPath,
      target: { role: "assistant", entryId: "assistant-1" },
    });

    expect(result.sessionPath).toBe(harness.childSessionPath);
    expect(fs.existsSync(harness.childSessionPath)).toBe(true);
    expect(harness.discardSessionMemoryForkBaseline).not.toHaveBeenCalled();
    expect(harness.manifestStore.resolveByLocatorPath(harness.childSessionPath)?.lifecycle).toBe("active");
  });

  it("flushes and restores a child forked at the first user before any assistant message", async () => {
    const harness = createHarness(tempDir);

    const result = await harness.coordinator.forkSessionAtNode({
      sessionId: harness.sourceManifest.sessionId,
      sessionPath: harness.sourceSessionPath,
      target: { role: "user", entryId: "user-1" },
    });

    expect(harness.sourceManager.createBranchedSession).toHaveBeenCalledWith("user-1");
    expect(harness.sourceManager._rewriteFile).toHaveBeenCalled();
    expect(fs.existsSync(harness.childSessionPath)).toBe(true);
    const childEntries = fs.readFileSync(harness.childSessionPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(childEntries.map((entry) => entry.id)).toContain("user-1");
    expect(childEntries.map((entry) => entry.id)).not.toContain("assistant-1");
    expect(harness.coordinator.ensureSessionLoaded).toHaveBeenCalledWith(harness.childSessionPath);
    expect(result).toMatchObject({
      sessionId: expect.any(String),
      sessionPath: harness.childSessionPath,
      forkedFromEntryId: "user-1",
      target: { role: "user", entryId: "user-1" },
    });
  });

  it("rewrites retained collaboration draft handles to child-owned suggestion ids", async () => {
    const harness = createHarness(tempDir);
    harness.branch[3].message.content = [{
      type: "text",
      text: "Draft created (draft-source); waiting for confirmation.",
    }];
    (harness.branch[3].message as any).details = {
      suggestionId: "draft-source",
      kind: "session_send_draft",
    };
    harness.forkSessionCollabDrafts.mockReturnValue({
      drafts: 1,
      suggestionIds: ["draft-child"],
      suggestionIdMap: { "draft-source": "draft-child" },
    });

    const result = await harness.coordinator.forkSessionAtNode({
      sessionId: harness.sourceManifest.sessionId,
      sessionPath: harness.sourceSessionPath,
      target: { role: "assistant", entryId: "assistant-1" },
    });

    expect(harness.forkSessionCollabDrafts).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: harness.sourceManifest.sessionId,
      sourceSessionPath: harness.sourceSessionPath,
      targetSessionId: result.sessionId,
      targetSessionPath: harness.childSessionPath,
      retainedEntries: expect.any(Array),
    }));
    const childBytes = fs.readFileSync(harness.childSessionPath, "utf-8");
    expect(childBytes).toContain("draft-child");
    expect(childBytes).not.toContain("draft-source");
  });

  it("passes the last retained subagent run leaf as the child-session fork boundary", async () => {
    const harness = createHarness(tempDir);
    (harness.branch[3].message as any).details = {
      taskId: "run-a",
      threadId: "thread-a",
    };
    harness.subagentRunStore.query.mockImplementation((taskId) => taskId === "run-a" ? {
      taskId,
      status: "resolved",
      threadId: "thread-a",
      parentSessionId: harness.sourceManifest.sessionId,
      childLeafEntryId: "child-leaf-a",
    } : null);

    await harness.coordinator.forkSessionAtNode({
      sessionId: harness.sourceManifest.sessionId,
      sessionPath: harness.sourceSessionPath,
      target: { role: "assistant", entryId: "assistant-1" },
    });

    expect(harness.subagentThreadStore.forkOpenDirectThreads).toHaveBeenCalledWith(
      expect.objectContaining({
        childBoundaryEntryIds: { "thread-a": "child-leaf-a" },
        allowCurrentChildLeaf: false,
      }),
    );
  });

  it("rewrites retained subagent cards to child-owned run, thread, and child Session identities", async () => {
    const harness = createHarness(tempDir);
    (harness.branch[3].message as any).details = {
      type: "subagent",
      taskId: "thread-source",
      threadId: "thread-source",
      threadKind: "direct",
      sessionId: "sess-sub-source",
      sessionPath: "/subagents/source.jsonl",
      streamKey: "/subagents/source.jsonl",
      streamStatus: "done",
    };
    const threadClone = {
      sourceThreadId: "thread-source",
      newThreadId: "thread-child",
      sourceChildSessionId: "sess-sub-source",
      sourceChildSessionPath: "/subagents/source.jsonl",
      targetChildSessionId: "sess-sub-child",
      targetChildSessionPath: "/subagents/child.jsonl",
    };
    harness.subagentThreadStore.forkOpenDirectThreads.mockResolvedValue({
      clones: [threadClone],
      skipped: [],
      referencedThreadIds: ["thread-source"],
    });
    harness.subagentRunStore.forkSessionRuns.mockReturnValue({
      runs: 1,
      taskIds: ["thread-child"],
      taskIdMap: { "thread-source": "thread-child" },
      threadIdMap: { "thread-source": "thread-child" },
      skipped: [],
    });
    harness.forkSessionDeferredTasks.mockReturnValue({ tasks: 1, taskIds: ["thread-child"] });

    await harness.coordinator.forkSessionAtNode({
      sessionId: harness.sourceManifest.sessionId,
      sessionPath: harness.sourceSessionPath,
      target: { role: "assistant", entryId: "assistant-1" },
    });

    const childBytes = fs.readFileSync(harness.childSessionPath, "utf-8");
    expect(childBytes).toContain("thread-child");
    expect(childBytes).toContain("sess-sub-child");
    expect(childBytes).toContain("/subagents/child.jsonl");
    expect(childBytes).not.toContain("thread-source");
    expect(childBytes).not.toContain("sess-sub-source");
    expect(childBytes).not.toContain("/subagents/source.jsonl");
  });

  it("clones retained workflow run, journal, node Session, and activity identities", async () => {
    const harness = createHarness(tempDir);
    (harness.branch[3].message as any).details = {
      type: "workflow",
      taskId: "workflow-source",
      runId: "workflow-source",
      streamStatus: "done",
    };
    harness.subagentRunStore.forkSessionWorkflowRuns.mockReturnValue({
      runs: 1,
      taskIds: ["workflow-target"],
      taskIdMap: { "workflow-source": "workflow-target" },
      skipped: [],
    });
    harness.forkSessionDeferredTasks.mockImplementation(({ taskIdMap }) => (
      taskIdMap["workflow-source"]
        ? { tasks: 1, taskIds: ["workflow-target"] }
        : { tasks: 0, taskIds: [] }
    ));
    const sourceWorkflowChildPath = path.join(tempDir, "workflow-source-child.jsonl");
    harness.subagentThreadStore.list.mockReturnValue([{
      threadId: "workflow-source::node-1",
      kind: "workflow_node",
      status: "closed",
      lastRunStatus: "resolved",
      parentSessionId: harness.sourceManifest.sessionId,
      parentSessionPath: harness.sourceSessionPath,
      parentTaskId: "workflow-source",
      nodeId: "node-1",
      agentId: "hana",
      childSessionId: "workflow-child-source",
      childSessionPath: sourceWorkflowChildPath,
    }]);
    const targetWorkflowChildPath = path.join(
      harness.agent.agentDir,
      "workflow-sessions",
      "workflow-target",
      "workflow-child-target.jsonl",
    );
    const cloneWorkflowChild = vi.spyOn(harness.coordinator, "_cloneForkedSubagentChildSession")
      .mockResolvedValue({
        sessionId: "workflow-child-target",
        sessionPath: targetWorkflowChildPath,
      });
    const journalDir = path.join(harness.agent.agentDir, "workflow-journals");
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, "workflow-source.jsonl"), "cached-node\n", "utf-8");
    harness.activityHub.forkSessionEntries.mockReturnValue({
      entries: 2,
      activityIds: ["workflow-target", "workflow-target::node-1"],
      activityIdMap: {
        "workflow-source": "workflow-target",
        "workflow-source::node-1": "workflow-target::node-1",
      },
    });

    const result = await harness.coordinator.forkSessionAtNode({
      sessionId: harness.sourceManifest.sessionId,
      sessionPath: harness.sourceSessionPath,
      target: { role: "assistant", entryId: "assistant-1" },
    });

    expect(fs.readFileSync(path.join(journalDir, "workflow-target.jsonl"), "utf-8")).toBe("cached-node\n");
    expect(cloneWorkflowChild).toHaveBeenCalledWith(expect.objectContaining({
      newThreadId: "workflow-target::node-1",
      allowCurrentChildLeaf: true,
      targetSessionDir: path.join(harness.agent.agentDir, "workflow-sessions", "workflow-target"),
    }), expect.any(Map));
    expect(harness.subagentThreadStore.upsert).toHaveBeenCalledWith(
      "workflow-target::node-1",
      expect.objectContaining({
        kind: "workflow_node",
        parentSessionId: result.sessionId,
        parentTaskId: "workflow-target",
        childSessionId: "workflow-child-target",
      }),
    );
    expect(harness.activityHub.forkSessionEntries).toHaveBeenCalledWith(expect.objectContaining({
      activityIdMap: expect.objectContaining({ "workflow-source": "workflow-target" }),
      threadIdMap: expect.objectContaining({
        "workflow-source::node-1": "workflow-target::node-1",
      }),
      childSessionIdMap: expect.objectContaining({
        "workflow-child-source": "workflow-child-target",
      }),
    }));
    expect(fs.readFileSync(harness.childSessionPath, "utf-8")).toContain("workflow-target");
    expect(fs.readFileSync(harness.childSessionPath, "utf-8")).not.toContain('"taskId":"workflow-source"');
    expect(result.workflowRuns).toEqual({ cloned: 1, deferred: 1, nodes: 1 });
    expect(result.activities).toEqual({ cloned: 2 });
  });

  it("rejects a retained active non-media task before creating a child", async () => {
    const harness = createHarness(tempDir);
    (harness.branch[3].message as any).details = { taskId: "plugin-task-active" };
    harness.taskRegistry.query.mockImplementation((taskId) => taskId === "plugin-task-active" ? {
      taskId,
      type: "plugin-task",
      status: "running",
      parentSessionId: harness.sourceManifest.sessionId,
    } : null);

    await expect(harness.coordinator.forkSessionAtNode({
      sessionId: harness.sourceManifest.sessionId,
      sessionPath: harness.sourceSessionPath,
      target: { role: "assistant", entryId: "assistant-1" },
    })).rejects.toMatchObject({
      code: "session_fork_active_task",
      status: 409,
      taskId: "plugin-task-active",
    });
    expect(harness.sourceManager.createBranchedSession).not.toHaveBeenCalled();
  });

  it("does not interleave Fork with an active Retry for the same Session", async () => {
    const harness = createHarness(tempDir);
    const releaseRetry = acquireSessionOperation(harness.sourceManifest.sessionId, "retry");
    try {
      await expect(harness.coordinator.forkSessionAtNode({
        sessionId: harness.sourceManifest.sessionId,
        sessionPath: harness.sourceSessionPath,
        target: { role: "assistant", entryId: "assistant-1" },
      })).rejects.toMatchObject({
        message: "session_busy",
        code: "session_busy",
        status: 409,
        activeOperation: "retry",
      });
      expect(harness.sourceManager.createBranchedSession).not.toHaveBeenCalled();
    } finally {
      releaseRetry();
    }
  });

  it("tombstones the child and removes copied sidecars when restore verification fails", async () => {
    const harness = createHarness(tempDir, { restoreFails: true });
    (harness.branch[3].message as any).details = {
      suggestionId: "draft-source",
      kind: "session_send_draft",
    };
    harness.forkSessionCollabDrafts.mockReturnValue({
      drafts: 1,
      suggestionIds: ["draft-child"],
      suggestionIdMap: { "draft-source": "draft-child" },
    });
    harness.subagentRunStore.forkSessionRuns.mockReturnValue({
      runs: 1,
      taskIds: ["thread-child"],
      taskIdMap: { "thread-source": "thread-child" },
      threadIdMap: { "thread-source": "thread-child" },
      skipped: [],
    });
    harness.forkSessionDeferredTasks.mockReturnValue({
      tasks: 1,
      taskIds: ["thread-child"],
    });

    await expect(harness.coordinator.forkSessionAtNode({
      sessionId: harness.sourceManifest.sessionId,
      sessionPath: harness.sourceSessionPath,
      target: { role: "assistant", entryId: "assistant-1" },
    })).rejects.toThrow("restore failed");

    const childManifest = harness.manifestStore.resolveByLocatorPath(harness.childSessionPath);
    expect(childManifest.lifecycle).toBe("deleted");
    expect(fs.existsSync(harness.childSessionPath)).toBe(false);
    expect(harness.discardForkedSessionFiles).toHaveBeenCalledWith({
      sessionId: childManifest.sessionId,
      sessionPath: harness.childSessionPath,
    });
    expect(harness.discardForkedSessionVisionNotes).toHaveBeenCalledWith({
      sessionId: childManifest.sessionId,
      sessionPath: harness.childSessionPath,
    });
    expect(harness.discardSessionMemoryForkBaseline).toHaveBeenCalledWith({
      agentId: "hana",
      sessionId: childManifest.sessionId,
    });
    expect(harness.discardForkedSessionPluginConfig).toHaveBeenCalledWith({
      sessionId: childManifest.sessionId,
      sessionPath: harness.childSessionPath,
    });
    expect(harness.discardForkedSessionDeferredTasks).toHaveBeenCalledWith({
      targetSessionId: childManifest.sessionId,
      taskIds: ["thread-child"],
    });
    expect(harness.subagentRunStore.discardForkedSessionRuns).toHaveBeenCalledWith({
      targetSessionId: childManifest.sessionId,
      targetSessionPath: harness.childSessionPath,
      taskIds: ["thread-child"],
    });
    expect(harness.discardForkedSessionCollabDrafts).toHaveBeenCalledWith({
      suggestionIds: ["draft-child"],
    });
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(harness.childSessionPath), "session-meta.json"), "utf-8"));
    expect(meta[path.basename(harness.childSessionPath)]).toBeUndefined();
    const titles = JSON.parse(fs.readFileSync(path.join(path.dirname(harness.childSessionPath), "session-titles.json"), "utf-8"));
    expect(titles[childManifest.sessionId]).toBeUndefined();
    expect(harness.notifySessionMemoryForkCreated).not.toHaveBeenCalled();
  });

  it("rejects a node outside the active branch before creating a child", async () => {
    const harness = createHarness(tempDir);

    await expect(harness.coordinator.forkSessionAtNode({
      sessionId: harness.sourceManifest.sessionId,
      sessionPath: harness.sourceSessionPath,
      target: { role: "assistant", entryId: "abandoned-assistant" },
    })).rejects.toMatchObject({
      code: "session_fork_target_invalid",
      status: 400,
    });
    expect(harness.sourceManager.createBranchedSession).not.toHaveBeenCalled();
  });
});
