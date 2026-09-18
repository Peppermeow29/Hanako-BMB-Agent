import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { estimateTokensMock } = vi.hoisted(() => ({
  estimateTokensMock: vi.fn(() => 2000),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  buildNativeCompactionRequestShapes: vi.fn(() => ({ requests: [] })),
  completeSimple: vi.fn(),
  convertAgentMessagesToLlm: vi.fn(async (messages) => messages),
  createAgentSession: vi.fn(),
  SessionManager: {
    create: vi.fn(),
    open: vi.fn(),
  },
  estimateTokens: estimateTokensMock,
  findCutPoint: vi.fn(),
  generateSummary: vi.fn(),
  prepareCompaction: vi.fn(),
  runAgentLoop: vi.fn(),
  emitSessionShutdown: vi.fn(),
  refreshSessionModelFromRegistry: vi.fn(),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.ts";

const tempRoots: string[] = [];

function createHarness({
  oldContextWindow = 128000,
  currentTokens = 1000,
  messages = [
    { role: "system", content: "system" },
    { role: "user", content: "question" },
    { role: "assistant", content: "answer" },
  ],
  thinkingLevel = "medium",
  modelAvailability = undefined,
}: any = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-model-switch-"));
  tempRoots.push(tempRoot);
  const agentsDir = path.join(tempRoot, "agents");
  const sessionDir = path.join(agentsDir, "hana", "sessions");
  const sessionPath = path.join(sessionDir, "session.jsonl");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(sessionPath, '{"type":"session","id":"test-session"}\n', "utf8");

  const emittedEvents: any[] = [];
  const coord = new SessionCoordinator({
    agentsDir,
    getAgent: () => ({ sessionDir }),
    getActiveAgentId: () => "hana",
    getModels: () => null,
    getResourceLoader: () => null,
    getSkills: () => null,
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: (event, targetPath) => emittedEvents.push({ event, sessionPath: targetPath }),
    getHomeCwd: () => tempRoot,
    agentIdFromSessionPath: () => null,
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => thinkingLevel }),
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: () => null,
    listAgents: () => [],
  });
  const writeSessionMeta = vi.spyOn(coord, "writeSessionMeta").mockResolvedValue(undefined);

  let reportedTokens = currentTokens;
  const session: any = {
    model: { id: "old-model", provider: "test", contextWindow: oldContextWindow },
    isCompacting: false,
    getContextUsage: vi.fn(() => ({ tokens: reportedTokens })),
    agent: { state: { messages } },
    setThinkingLevel: vi.fn(),
  };
  const setModel = vi.fn(async (model) => {
    session.model = model;
  });
  session.setModel = setModel;

  const entry: any = {
    session,
    modelId: "old-model",
    modelProvider: "test",
    thinkingLevel,
    ...(modelAvailability ? { modelAvailability } : {}),
  };
  coord.sessions.set(sessionPath, entry);

  return {
    coord,
    emittedEvents,
    entry,
    messages,
    session,
    sessionPath,
    setModel,
    setReportedTokens: (tokens) => { reportedTokens = tokens; },
    writeSessionMeta,
  };
}

describe("SessionCoordinator.switchSessionModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    estimateTokensMock.mockReturnValue(2000);
  });

  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports per-session model switch state through a public query", () => {
    const { coord, sessionPath } = createHarness();
    coord.sessions.get(sessionPath)._switching = true;

    expect(coord.isSessionSwitching(sessionPath)).toBe(true);
    expect(coord.isSessionSwitching(path.join(path.dirname(sessionPath), "missing.jsonl"))).toBe(false);
  });

  it("allows a short conversation to switch from a large model to a smaller model", async () => {
    const { coord, entry, sessionPath, setModel } = createHarness({
      oldContextWindow: 128000,
      currentTokens: 6000,
    });
    const targetModel = { id: "small-model", provider: "test", contextWindow: 12000 };

    const result = await coord.switchSessionModel(sessionPath, targetModel);

    expect(result).toEqual({ adaptations: [], thinkingLevel: "medium" });
    expect(setModel).toHaveBeenCalledWith(targetModel);
    expect(entry.modelId).toBe("small-model");
    expect(entry.modelProvider).toBe("test");
  });

  it("rejects an oversized switch before changing the session or JSONL", async () => {
    const {
      coord,
      emittedEvents,
      entry,
      messages,
      sessionPath,
      setModel,
      writeSessionMeta,
    } = createHarness({
      oldContextWindow: 128000,
      currentTokens: 10000,
    });
    const jsonlBefore = fs.readFileSync(sessionPath, "utf8");
    const messagesBefore = structuredClone(messages);

    await expect(coord.switchSessionModel(sessionPath, {
      id: "small-model",
      provider: "test",
      contextWindow: 12000,
    })).rejects.toMatchObject({
      code: "MODEL_CONTEXT_TOO_LARGE",
      status: 409,
      currentTokens: 10000,
      effectiveWindow: 6800,
    });

    expect(setModel).not.toHaveBeenCalled();
    expect(writeSessionMeta).not.toHaveBeenCalled();
    expect(entry.modelId).toBe("old-model");
    expect(entry.modelProvider).toBe("test");
    expect(entry._switching).toBe(false);
    expect(messages).toEqual(messagesBefore);
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(jsonlBefore);
    expect(emittedEvents).toEqual([]);
  });

  it("allows switching from a small model to a larger model", async () => {
    const { coord, sessionPath, setModel } = createHarness({
      oldContextWindow: 12000,
      currentTokens: 6000,
    });
    const targetModel = { id: "large-model", provider: "test", contextWindow: 128000 };

    const result = await coord.switchSessionModel(sessionPath, targetModel);

    expect(result.adaptations).toEqual([]);
    expect(setModel).toHaveBeenCalledWith(targetModel);
  });

  it("allows retrying the switch after the user manually compacts the conversation", async () => {
    const { coord, messages, sessionPath, setModel, setReportedTokens } = createHarness({
      oldContextWindow: 128000,
      currentTokens: 10000,
    });
    const targetModel = { id: "small-model", provider: "test", contextWindow: 12000 };

    await expect(coord.switchSessionModel(sessionPath, targetModel)).rejects.toMatchObject({
      code: "MODEL_CONTEXT_TOO_LARGE",
    });
    expect(setModel).not.toHaveBeenCalled();

    messages.splice(0, messages.length, { role: "user", content: "retained after manual compact" });
    setReportedTokens(null);
    const result = await coord.switchSessionModel(sessionPath, targetModel);

    expect(result.adaptations).toEqual([]);
    expect(estimateTokensMock).toHaveBeenCalledOnce();
    expect(setModel).toHaveBeenCalledWith(targetModel);
  });

  it("can leave an unavailable old model when the conversation fits the target", async () => {
    const { coord, entry, session, sessionPath, setModel } = createHarness({
      oldContextWindow: 0,
      currentTokens: 6000,
      modelAvailability: {
        available: false,
        reason: "model_removed",
        modelRef: "test/old-model",
      },
    });
    session.model.api = "hana-session-model-unavailable";
    const targetModel = { id: "small-model", provider: "test", contextWindow: 12000 };

    await coord.switchSessionModel(sessionPath, targetModel);

    expect(setModel).toHaveBeenCalledWith(targetModel);
    expect(entry.modelAvailability).toEqual({
      available: true,
      reason: null,
      modelRef: "test/small-model",
    });
  });

  it("falls back from xhigh to high when switching to a model without max thinking support", async () => {
    const { coord, entry, session, sessionPath, setModel, writeSessionMeta } = createHarness({
      currentTokens: 1000,
      thinkingLevel: "xhigh",
    });
    session.model.xhigh = true;
    const targetModel = { id: "regular-model", provider: "test", contextWindow: 64000 };

    const result = await coord.switchSessionModel(sessionPath, targetModel);

    expect(result).toEqual({ adaptations: [], thinkingLevel: "high" });
    expect(setModel).toHaveBeenCalledOnce();
    expect(session.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(entry.thinkingLevel).toBe("high");
    expect(writeSessionMeta).toHaveBeenCalledWith(sessionPath, expect.objectContaining({
      thinkingLevel: "high",
    }));
  });
});
