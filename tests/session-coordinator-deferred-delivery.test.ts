import { describe, expect, it, vi } from "vitest";

import { SessionCoordinator } from "../core/session-coordinator.ts";

const MODEL = { id: "gpt-5.6-sol", provider: "openai-codex" };

function makeCoordinator( overrides: any = {}) {
  const models = overrides.models || { availableModels: [MODEL] };
  const manifestByPath = new Map<string, any>();
  const branchHeads = new Map<string, any>();
  const sessionManifestStore = {
    resolveByLocatorPath: vi.fn((sessionPath) => manifestByPath.get(sessionPath) || null),
    createForPath: vi.fn(({ sessionPath, ownerAgentId }) => {
      const manifest = {
        sessionId: `sess:${sessionPath}`,
        ownerAgentId,
        locator: { path: sessionPath },
      };
      manifestByPath.set(sessionPath, manifest);
      return manifest;
    }),
    getBySessionId: vi.fn((sessionId) => (
      [...manifestByPath.values()].find((manifest) => manifest.sessionId === sessionId) || null
    )),
    getBranchHead: vi.fn((sessionId) => branchHeads.get(sessionId) || null),
    setBranchHead: vi.fn((sessionId, state) => {
      const head = { sessionId, ...state };
      branchHeads.set(sessionId, head);
      return head;
    }),
  };
  const coordinator = new SessionCoordinator({
    agentsDir: "/tmp/fake/agents",
    getAgent: () => ({ id: "test-agent" }),
    getActiveAgentId: () => "test-agent",
    getModels: () => models,
    getResourceLoader: () => ({}),
    getSkills: () => ({}),
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: () => {},
    getHomeCwd: () => "/tmp",
    agentIdFromSessionPath: () => "test-agent",
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getAgents: () => new Map(),
    getActivityStore: () => ({}),
    getAgentById: () => ({ id: "test-agent" }),
    listAgents: () => [],
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    sessionManifestStore,
    ...overrides,
  });
  coordinator.preflightSessionInput = vi.fn();
  return coordinator;
}

function makeSession({ isStreaming }) {
  return {
    isStreaming,
    model: MODEL,
    sessionManager: {
      getEntries: vi.fn(() => []),
      getLeafId: vi.fn(() => null),
      getEntry: vi.fn(() => null),
    },
    sendCustomMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe("SessionCoordinator deferred custom delivery", () => {
  it("rechecks prompt streaming state before committing input side effects", async () => {
    const coord = makeCoordinator();
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/prompt-race.jsonl";
    const afterCachePreflight = vi.fn();
    const session = {
      ...makeSession({ isStreaming: false }),
      isStreaming: true,
      prompt: vi.fn(),
      agent: { state: { messages: [] } },
    };
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });

    await expect(coord.promptSession(sessionPath, "retry", {}, {
      afterCachePreflight,
    })).rejects.toThrow("session_busy");

    expect(afterCachePreflight).not.toHaveBeenCalled();
    expect(coord.preflightSessionInput).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("wakes an idle live session with triggerTurn instead of steer", async () => {
    const order: string[] = [];
    const emitEvent = vi.fn();
    const coord = makeCoordinator({ emitEvent });
    const session = makeSession({ isStreaming: false });
    session.sendCustomMessage.mockImplementation(async () => {
      order.push("send");
    });
    emitEvent.mockImplementation(() => {
      order.push("emit");
    });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/a.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });
    coord.steerSession = vi.fn();

    const result = await coord.deliverCustomMessage(sessionPath, {
      customType: "hana-background-result",
      content: "<hana-background-result task-id=\"task-1\" status=\"success\" type=\"subagent\">done</hana-background-result>",
      display: false,
      details: { deliveryId: "delivery-1" },
    });

    expect(result).toMatchObject({ ok: true, mode: "triggerTurn" });
    expect(coord.preflightSessionInput).toHaveBeenCalledWith(sessionPath);
    expect(order).toEqual(["emit", "send"]);
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "hana-background-result", display: false }),
      { triggerTurn: true },
    );
    expect(coord.steerSession).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn_input_presentation",
        presentation: expect.objectContaining({
          kind: "pre_reply_interlude",
          taskId: "task-1",
          deliveryId: "delivery-1",
          status: "success",
          resultType: "subagent",
          deliveryMode: "triggerTurn",
        }),
      }),
      sessionPath,
    );
  });

  it("queues custom delivery as a follow-up when the session is currently streaming", async () => {
    const emitEvent = vi.fn();
    const coord = makeCoordinator({ emitEvent });
    const session = makeSession({ isStreaming: true });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/a.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });

    const result = await coord.deliverCustomMessage(sessionPath, {
      customType: "hana-background-result",
      content: "<hana-background-result task-id=\"task-follow-up\" status=\"success\" type=\"workflow\">done</hana-background-result>",
      display: false,
    });

    expect(result).toMatchObject({ ok: true, mode: "followUp" });
    expect(coord.preflightSessionInput).toHaveBeenCalledWith(sessionPath);
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "hana-background-result", display: false }),
      { deliverAs: "followUp" },
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn_input_presentation",
        presentation: expect.objectContaining({
          kind: "pre_reply_interlude",
          taskId: "task-follow-up",
          status: "success",
          resultType: "workflow",
          deliveryMode: "followUp",
        }),
      }),
      sessionPath,
    );
  });

  it("refuses retry-only custom delivery if the session became streaming", async () => {
    const coord = makeCoordinator();
    const session = makeSession({ isStreaming: true });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/retry-race.jsonl";
    const beforeInputSideEffects = vi.fn();
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });

    await expect(coord.deliverCustomMessage(sessionPath, {
      customType: "hana-background-result",
      content: '<hana-background-result task-id="task-1" status="success" type="subagent">done</hana-background-result>',
      display: false,
    }, {
      triggerTurn: true,
      requireIdle: true,
      beforeInputSideEffects,
    })).rejects.toThrow("session_busy");

    expect(beforeInputSideEffects).not.toHaveBeenCalled();
    expect(coord.preflightSessionInput).not.toHaveBeenCalled();
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
  });

  it("cold-loads an unloaded session before delivering the custom message", async () => {
    const coord = makeCoordinator();
    const session = makeSession({ isStreaming: false });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/cold.jsonl";
    coord.ensureSessionLoaded = vi.fn(async (sessionPath) => {
      coord.sessions.set(sessionPath, {
        session,
        agentId: "test-agent",
        lastTouchedAt: 0,
      });
      return session;
    });

    const result = await coord.deliverCustomMessage(sessionPath, {
      customType: "hana-background-result",
      content: "<hana-background-result />",
      display: false,
    });

    expect(result).toMatchObject({ ok: true, mode: "triggerTurn" });
    expect(coord.ensureSessionLoaded).toHaveBeenCalledWith(sessionPath);
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "hana-background-result", display: false }),
      { triggerTurn: true },
    );
  });

  it("rechecks a retry delivery fence after cold-loading and before appending", async () => {
    const coord = makeCoordinator();
    const session = makeSession({ isStreaming: false });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/cold-fenced.jsonl";
    let deliverAllowed = true;
    coord.ensureSessionLoaded = vi.fn(async (resolvedPath) => {
      coord.sessions.set(resolvedPath, {
        session,
        agentId: "test-agent",
        lastTouchedAt: 0,
      });
      deliverAllowed = false;
      return session;
    });

    const result = await coord.deliverCustomMessage(sessionPath, {
      customType: "hana-background-result",
      content: "<hana-background-result />",
      display: false,
    }, {
      shouldDeliver: () => deliverAllowed,
    });

    expect(result).toEqual({ ok: false, mode: "suppressed" });
    expect(coord.ensureSessionLoaded).toHaveBeenCalledWith(sessionPath);
    expect(coord.preflightSessionInput).not.toHaveBeenCalled();
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
  });

  it("refuses to cold-load archived sessions for custom delivery", async () => {
    const coord = makeCoordinator();
    coord.ensureSessionLoaded = vi.fn();
    const archivedPath = "/tmp/fake/agents/test-agent/sessions/archived/cold.jsonl";

    await expect(
      coord.deliverCustomMessage(archivedPath, {
        customType: "hana-background-result",
        content: "<hana-background-result />",
        display: false,
      }),
    ).rejects.toThrow(/active desktop session/);

    expect(coord.ensureSessionLoaded).not.toHaveBeenCalled();
  });

  it("can deliver a notification without triggering a parent turn", async () => {
    const emitEvent = vi.fn();
    const coord = makeCoordinator({ emitEvent });
    const session = makeSession({ isStreaming: false });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/a.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });

    const result = await coord.deliverCustomMessage(
      sessionPath,
      {
        customType: "hana-background-result",
        content: "<hana-background-result />",
        display: false,
      },
      { triggerTurn: false },
    );

    expect(result).toMatchObject({ ok: true, mode: "notifyOnly" });
    expect(coord.preflightSessionInput).not.toHaveBeenCalled();
    expect(session.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "hana-background-result", display: false }),
      { triggerTurn: false },
    );
    expect(emitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn_input_presentation" }),
      expect.anything(),
    );
  });

  it("rejects a triggered deferred turn when the live session model is no longer available", async () => {
    const emitEvent = vi.fn();
    const coord = makeCoordinator({ models: { availableModels: [] }, emitEvent });
    const session = makeSession({ isStreaming: false });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/disabled-model.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });

    await expect(coord.deliverCustomMessage(sessionPath, {
      customType: "hana-background-result",
      content: "<hana-background-result />",
      display: false,
    })).rejects.toMatchObject({
      code: "MODEL_NOT_AVAILABLE",
      modelRef: "openai-codex/gpt-5.6-sol",
    });
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("rejects a triggered deferred turn before presentation or persistence when cache preflight fails", async () => {
    const emitEvent = vi.fn();
    const coord = makeCoordinator({ emitEvent });
    const session = makeSession({ isStreaming: false });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/cache-drift.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });
    vi.spyOn(coord, "preflightSessionInput").mockImplementation(() => {
      throw new Error("Cache prefix contract violated: tools");
    });

    await expect(coord.deliverCustomMessage(sessionPath, {
      customType: "hana-background-result",
      content: "<hana-background-result />",
      display: false,
    })).rejects.toThrow(/Cache prefix contract violated/);

    expect(session.sendCustomMessage).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("commits synchronous retry side effects after preflight and before custom input persistence", async () => {
    const order: string[] = [];
    const emitEvent = vi.fn(() => order.push("presentation"));
    const coord = makeCoordinator({ emitEvent });
    const session = makeSession({ isStreaming: false });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/retry-custom.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });
    vi.mocked(coord.preflightSessionInput).mockImplementation(() => {
      order.push("preflight");
      return {} as any;
    });
    session.sendCustomMessage.mockImplementation(async () => {
      order.push("send");
    });

    await coord.deliverCustomMessage(sessionPath, {
      customType: "hana-background-result",
      content: '<hana-background-result task-id="task-1" status="success" type="subagent">done</hana-background-result>',
      display: false,
    }, {
      triggerTurn: true,
      beforeInputSideEffects: () => order.push("commit"),
    });

    expect(order).toEqual(["preflight", "commit", "presentation", "send"]);
  });

  it("rejects asynchronous custom-input commit hooks before presentation or persistence", async () => {
    const emitEvent = vi.fn();
    const coord = makeCoordinator({ emitEvent });
    const session = makeSession({ isStreaming: false });
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/retry-custom-async.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });

    await expect(coord.deliverCustomMessage(sessionPath, {
      customType: "hana-background-result",
      content: '<hana-background-result task-id="task-1" status="success" type="subagent">done</hana-background-result>',
      display: false,
    }, {
      triggerTurn: true,
      beforeInputSideEffects: async () => {},
    })).rejects.toThrow(/must be synchronous/);

    expect(emitEvent).not.toHaveBeenCalled();
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
  });

  it("records non-context custom entries on a live session manager without sending a custom message", () => {
    const coord = makeCoordinator();
    const session = makeSession({ isStreaming: false });
    (session as any).sessionManager.appendCustomEntry = vi.fn();
    const sessionPath = "/tmp/fake/agents/test-agent/sessions/a.jsonl";
    coord.sessions.set(sessionPath, {
      session,
      agentId: "test-agent",
      lastTouchedAt: 0,
    });

    const result = coord.recordCustomEntry(sessionPath, "hana-deferred-result", {
      taskId: "task-img",
    });

    expect(result).toMatchObject({ ok: true, mode: "live" });
    expect((session as any).sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      "hana-deferred-result",
      { taskId: "task-img" },
    );
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
  });
});
