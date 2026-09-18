import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSubagentCloseTool,
  createSubagentReplyTool,
  createSubagentTool,
} from "../lib/tools/subagent-tool.ts";
import { DeferredResultCoordinator } from "../lib/deferred-result-coordinator.ts";
import { DeferredResultStore } from "../lib/deferred-result-store.ts";
import { SubagentThreadStore } from "../lib/subagent-thread-store.ts";

// ---- helpers ----------------------------------------------------------------

/** Mock Pi SDK ctx with sessionManager */
const mockCtx = (sp = "/test/session.jsonl", cwd = undefined) => ({
  sessionManager: {
    getSessionFile: () => sp,
    ...(cwd ? { getCwd: () => cwd } : {}),
  },
});

/**
 * Build a mock executeIsolated that:
 *  - calls opts.onSessionReady(sessionPath) synchronously if provided
 *  - resolves with the given result
 */
function makeExecuteIsolated(
  result = { replyText: "done", error: null, sessionPath: "/test/child.jsonl" },
) {
  return vi.fn().mockImplementation((_prompt, opts) => {
    if (typeof opts?.onSessionReady === "function") {
      opts.onSessionReady("/test/child.jsonl");
    }
    return Promise.resolve(result);
  });
}

function makeDeps( overrides: any = {}) {
  const threadStore = {
    beginRun: vi.fn(),
    attachSession: vi.fn(),
    finishRun: vi.fn(),
    runSerialized: vi.fn((_threadId, taskFn) => taskFn()),
    isBusy: vi.fn(() => false),
  };
  return {
    executeIsolated: makeExecuteIsolated(),
    resolveUtilityModel: () => "utility-model",
    getDeferredStore: () => ({
      defer: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
      query: vi.fn(() => ({ meta: {} })),
      _save: vi.fn(),
    }),
    getSessionPath: () => "/test/session.jsonl",
    listAgents: vi.fn(() => [
      { id: "hana", name: "Hana", model: "claude-3-5-sonnet", summary: "主 agent" },
      { id: "other-agent", name: "Other", model: "gpt-4", summary: "专家 agent" },
    ]),
    currentAgentId: "hana",
    agentDir: "/test/agents/hana",
    emitEvent: vi.fn(),
    persistSubagentSessionMeta: vi.fn(async () => {}),
    getSubagentRunStore: () => null,
    getSubagentThreadStore: () => threadStore,
    ...overrides,
  };
}

// ---- tests ------------------------------------------------------------------

describe("subagent-tool (executeIsolated 原子模式)", () => {
  let mockStore;
  let deps;

  beforeEach(() => {
    mockStore = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn(), query: vi.fn(() => ({ meta: {} })), _save: vi.fn() };
    deps = makeDeps({ getDeferredStore: () => mockStore });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. fire-and-forget: returns immediately with taskId / streamStatus / sessionPath
  it("dispatches task and returns immediately with running status", async () => {
    const tool = createSubagentTool(deps);
    const task = "任务：查一下项目状态\n\n请阅读当前仓库的未提交改动，并总结风险。";
    const result = await tool.execute("call_1", { task }, null, null, mockCtx());

    // t() returns the key path when locale is not loaded in tests
    expect(result.content[0].text).toMatch(/task-id|subagentDispatched/);
    expect(result.details).toBeDefined();
    expect((result.details as any).taskId).toMatch(/^subagent-/);
    expect((result.details as any).streamStatus).toBe("running");
    expect((result.details as any).sessionPath).toBeNull();
    expect((result.details as any).task).toBe(task);
    expect((result.details as any).taskTitle).toBe("任务：查一下项目状态");
    expect((result.details as any).agentId).toBe("hana");
    expect((result.details as any).agentName).toBe("Hana");
    expect((result.details as any).requestedAgentId).toBe("hana");
    expect((result.details as any).requestedAgentNameSnapshot).toBe("Hana");
    expect((result.details as any).executorAgentId).toBe("hana");
    expect((result.details as any).executorAgentNameSnapshot).toBe("Hana");
    expect((result.details as any).executorMetaVersion).toBe(1);

    // store.defer is called before returning
    expect(mockStore.defer).toHaveBeenCalledWith(
      expect.stringMatching(/^subagent-/),
      "/test/session.jsonl",
      expect.objectContaining({
        type: "subagent",
        deliveryIntent: "trigger_parent_turn",
        summary: "任务：查一下项目状态",
      }),
    );
  });

  it("不带 instance 也登记 direct instance，并把 run 关联到 threadId", async () => {
    const threadStore = {
      beginRun: vi.fn(),
      attachSession: vi.fn(),
      finishRun: vi.fn(),
    };
    const runStore = {
      register: vi.fn(),
      attachSession: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
      abort: vi.fn(),
    };
    const tool = createSubagentTool(makeDeps({
      getDeferredStore: () => mockStore,
      getSubagentRunStore: () => runStore,
      getSubagentThreadStore: () => threadStore,
    }));

    const result = await tool.execute("call_1", { task: "读代码", agent: "other-agent" }, null, null, mockCtx());
    const taskId = (result.details as any).taskId;

    expect((result.details as any).threadId).toBe(taskId);
    expect((result.details as any).threadKind).toBe("direct");
    expect(threadStore.beginRun).toHaveBeenCalledWith(taskId, expect.objectContaining({
      kind: "direct",
      parentSessionPath: "/test/session.jsonl",
      agentId: "other-agent",
      summary: "读代码",
    }));
    expect(runStore.register).toHaveBeenCalledWith(taskId, expect.objectContaining({
      threadId: taskId,
      threadKind: "direct",
    }));

    await vi.waitFor(() => {
      expect(threadStore.attachSession).toHaveBeenCalledWith(taskId, "/test/child.jsonl", expect.objectContaining({
        agentId: "other-agent",
      }));
      expect(threadStore.finishRun).toHaveBeenCalledWith(taskId, expect.objectContaining({
        status: "resolved",
        close: false,
      }));
    });
  });

  it("默认甲（Codex）：派单不剥离工具（无 toolFilter/builtinFilter）+ permissionMode operate + subagentContext", async () => {
    const capture = makeExecuteIsolated();
    const tool = createSubagentTool(makeDeps({ executeIsolated: capture, getDeferredStore: () => mockStore }));
    await tool.execute("call_1", { task: "干活" }, null, null, mockCtx());
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    const opts = capture.mock.calls[0][1];
    expect(opts.toolFilter).toBeUndefined();      // 甲：不剥离自定义工具，给全集
    expect(opts.builtinFilter).toBeUndefined();   // 甲：不剥离内置工具，给全集
    expect(opts.permissionMode).toBe("operate");  // 无 access + 无父档 → operate（历史默认全权）
    expect(opts.approvalPolicy).toBe("deny_on_prompt");
    expect(opts.allowHumanApproval).toBe(false);
    expect(opts.subagentContext).toBe(true);      // → classify 防自递归
  });

  it("self-dispatch emits actual agent identity with session-ready patch", async () => {
    const emitEvent = vi.fn();
    const persistSubagentSessionMeta = vi.fn(async () => {});
    const tool = createSubagentTool(makeDeps({
      getDeferredStore: () => mockStore,
      emitEvent,
      persistSubagentSessionMeta,
    }));

    const result = await tool.execute("call_1", { task: "当前 agent 自己执行" }, null, null, mockCtx());
    const { taskId } = result.details as any;

    await vi.waitFor(() => {
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "block_update",
          taskId,
          patch: expect.objectContaining({
            streamKey: "/test/child.jsonl",
            agentId: "hana",
            agentName: "Hana",
            requestedAgentId: "hana",
            requestedAgentNameSnapshot: "Hana",
            executorAgentId: "hana",
            executorAgentNameSnapshot: "Hana",
          }),
        }),
        "/test/session.jsonl",
      );
    });

    await vi.waitFor(() => {
      expect(persistSubagentSessionMeta).toHaveBeenCalledWith(
        "/test/child.jsonl",
        expect.objectContaining({
          executorAgentId: "hana",
          executorAgentNameSnapshot: "Hana",
          executorMetaVersion: 1,
        }),
      );
    });
  });

  it("session-ready patch and durable run record include the child sessionId", async () => {
    const emitEvent = vi.fn();
    const childMetaRecord = { meta: {} as any };
    const runStore = {
      register: vi.fn(),
      attachSession: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
      abort: vi.fn(),
    };
    const store = {
      defer: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
      query: vi.fn(() => childMetaRecord),
      _save: vi.fn(),
    };
    const executeIsolated = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child-moved.jsonl", {
        sessionId: "sess_child_ready",
        sessionPath: "/test/child-moved.jsonl",
      });
      return Promise.resolve({ replyText: "done", error: null, sessionPath: "/test/child-moved.jsonl" });
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated,
      getDeferredStore: () => store,
      getSubagentRunStore: () => runStore,
      emitEvent,
    }));

    const result = await tool.execute("call_1", { task: "当前 agent 自己执行" }, null, null, mockCtx());
    const { taskId } = result.details as any;

    await vi.waitFor(() => {
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "block_update",
          taskId,
          patch: expect.objectContaining({
            sessionId: "sess_child_ready",
            streamKey: "/test/child-moved.jsonl",
          }),
        }),
        "/test/session.jsonl",
      );
    });

    expect(childMetaRecord.meta).toMatchObject({
      sessionId: "sess_child_ready",
      sessionPath: "/test/child-moved.jsonl",
    });
    expect(runStore.attachSession).toHaveBeenCalledWith(
      taskId,
      "/test/child-moved.jsonl",
      expect.objectContaining({
        childSessionId: "sess_child_ready",
      }),
    );
  });

  it("records the subagent run in the durable run store across dispatch, session ready, and completion", async () => {
    const runStore = {
      register: vi.fn(),
      attachSession: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
      abort: vi.fn(),
    };
    const tool = createSubagentTool(makeDeps({
      getDeferredStore: () => mockStore,
      getSubagentRunStore: () => runStore,
    }));

    const result = await tool.execute("call_1", { task: "写一份校准报告" }, null, null, mockCtx());
    const { taskId } = result.details as any;

    expect(runStore.register).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        parentSessionPath: "/test/session.jsonl",
        summary: "写一份校准报告",
        requestedAgentId: "hana",
        requestedAgentNameSnapshot: "Hana",
      }),
    );

    await vi.waitFor(() => {
      expect(runStore.attachSession).toHaveBeenCalledWith(
        taskId,
        "/test/child.jsonl",
        expect.objectContaining({
          executorAgentId: "hana",
          executorAgentNameSnapshot: "Hana",
        }),
      );
    });

    await vi.waitFor(() => {
      expect(runStore.resolve).toHaveBeenCalledWith(taskId, "done");
    });
  });

  it("uses the original first line as taskTitle and dispatches task unchanged", async () => {
    const executeIsolated = makeExecuteIsolated();
    const tool = createSubagentTool(makeDeps({
      executeIsolated,
      getDeferredStore: () => mockStore,
    }));

    const task = "你是一个生活规划助手。请为用户制定一份**一周生活规律建议**，涵盖以下五个方面：\n\n1. 作息\n2. 运动";
    const result = await tool.execute("call_1", { task }, null, null, mockCtx());

    expect((result.details as any).taskTitle).toBe("你是一个生活规划助手。请为用户制定一份**一周生活规律建议**，涵盖以下五个方面：");
    expect(executeIsolated).toHaveBeenCalledWith(
      task,
      expect.any(Object),
    );
  });

  // 2. deferred store resolves on success
  it("resolves deferred store on success", async () => {
    const tool = createSubagentTool(deps);
    await tool.execute("call_1", { task: "成功的任务" }, null, null, mockCtx());

    await vi.waitFor(() => {
      expect(mockStore.resolve).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "done",
      );
    });
    expect(mockStore.fail).not.toHaveBeenCalled();
  });

  it("routes subagent completion through deferred delivery and triggers the parent LLM turn", async () => {
    const realStore = new (DeferredResultStore as any)();
    const sessionCoordinator = {
      deliverCustomMessage: vi.fn(async () => ({ ok: true, mode: "triggerTurn" })),
      recordCustomEntry: vi.fn(),
    };
    const coordinator = new DeferredResultCoordinator({
      store: realStore,
      sessionCoordinator,
      retryIntervalMs: 0,
      log: { warn: vi.fn(), error: vi.fn(), log: vi.fn() } as any,
    });
    coordinator.start();
    const tool = createSubagentTool(makeDeps({
      getDeferredStore: () => realStore,
      executeIsolated: makeExecuteIsolated({
        replyText: "子任务完成，主任务可以继续。",
        error: null,
        sessionPath: "/test/child.jsonl",
        stopReason: "stop",
      } as any),
    }));

    try {
      const result = await tool.execute("call_1", { task: "完成子任务后让主 agent 继续" }, null, null, mockCtx());
      const { taskId } = result.details as any;

      await vi.waitFor(() => {
        expect(sessionCoordinator.deliverCustomMessage).toHaveBeenCalledWith(
          "/test/session.jsonl",
          expect.objectContaining({
            customType: "hana-background-result",
            display: false,
            content: expect.stringContaining(`task-id="${taskId}"`),
          }),
          expect.objectContaining({
            triggerTurn: true,
            shouldDeliver: expect.any(Function),
          }),
        );
      });
      expect(realStore.query(taskId)).toMatchObject({ delivered: true });
    } finally {
      coordinator.dispose();
      realStore.dispose();
    }
  });

  it("routes subagent failure through deferred delivery and resumes the parent LLM turn", async () => {
    const realStore = new (DeferredResultStore as any)();
    const sessionCoordinator = {
      deliverCustomMessage: vi.fn(async () => ({ ok: true, mode: "triggerTurn" })),
      recordCustomEntry: vi.fn(),
    };
    const coordinator = new DeferredResultCoordinator({
      store: realStore,
      sessionCoordinator,
      retryIntervalMs: 0,
      log: { warn: vi.fn(), error: vi.fn(), log: vi.fn() } as any,
    });
    coordinator.start();
    const tool = createSubagentTool(makeDeps({
      getDeferredStore: () => realStore,
      executeIsolated: makeExecuteIsolated({
        replyText: null,
        error: "subagent failed before producing a result",
        sessionPath: "/test/child.jsonl",
        stopReason: "error",
      } as any),
    }));

    try {
      const result = await tool.execute("call_1", { task: "失败也要通知主 agent" }, null, null, mockCtx());
      const { taskId } = result.details as any;

      await vi.waitFor(() => {
        expect(sessionCoordinator.deliverCustomMessage).toHaveBeenCalledWith(
          "/test/session.jsonl",
          expect.objectContaining({
            customType: "hana-background-result",
            display: false,
            content: expect.stringContaining('status="failed"'),
          }),
          expect.objectContaining({
            triggerTurn: true,
            shouldDeliver: expect.any(Function),
          }),
        );
      });
      expect(realStore.query(taskId)).toMatchObject({
        status: "failed",
        delivered: true,
        meta: { deliveryIntent: "trigger_parent_turn" },
      });
    } finally {
      coordinator.dispose();
      realStore.dispose();
    }
  });

  it("inherits cwd and parent session identity from the tool execution ctx", async () => {
    const captureExecute = makeExecuteIsolated({ replyText: "done", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
      getParentCwd: () => "/focused/cwd",
    }));

    await tool.execute(
      "call_1",
      { task: "在当前会话目录写文件" },
      null,
      null,
      mockCtx("/test/parent.jsonl", "/actual/parent/cwd"),
    );

    expect(captureExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cwd: "/actual/parent/cwd",
        parentSessionPath: "/test/parent.jsonl",
        fileReadSessionPaths: ["/test/parent.jsonl"],
      }),
    );
  });

  it("fails deferred store when the run finishes without text or produced files", async () => {
    const emptyExecute = makeExecuteIsolated({
      replyText: "",
      error: null,
      sessionPath: "/test/child.jsonl",
      stopReason: "stop",
      sessionFiles: [],
    } as any);
    const tool = createSubagentTool(makeDeps({
      executeIsolated: emptyExecute,
      getDeferredStore: () => mockStore,
    }));

    await tool.execute("call_1", { task: "需要产物的任务" }, null, null, mockCtx());

    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        expect.any(String),
      );
    });
    expect(mockStore.resolve).not.toHaveBeenCalled();
  });

  it("fails deferred store when the final assistant message did not finish cleanly", async () => {
    const truncatedExecute = makeExecuteIsolated({
      replyText: "partial answer",
      error: null,
      sessionPath: "/test/child.jsonl",
      stopReason: "length",
      sessionFiles: [],
    } as any);
    const tool = createSubagentTool(makeDeps({
      executeIsolated: truncatedExecute,
      getDeferredStore: () => mockStore,
    }));

    await tool.execute("call_1", { task: "长输出任务" }, null, null, mockCtx());

    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        expect.stringMatching(/length|limit|未完成|截断/),
      );
    });
    expect(mockStore.resolve).not.toHaveBeenCalled();
  });

  it("resolves with produced file summary when file output exists without final text", async () => {
    const fileExecute = makeExecuteIsolated({
      replyText: "",
      error: null,
      sessionPath: "/test/child.jsonl",
      stopReason: "stop",
      sessionFiles: [{ filePath: "/workspace/report.md", label: "report.md" }],
    } as any);
    const tool = createSubagentTool(makeDeps({
      executeIsolated: fileExecute,
      getDeferredStore: () => mockStore,
    }));

    await tool.execute("call_1", { task: "生成报告文件" }, null, null, mockCtx());

    await vi.waitFor(() => {
      expect(mockStore.resolve).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        expect.stringContaining("/workspace/report.md"),
      );
    });
    expect(mockStore.fail).not.toHaveBeenCalled();
  });

  // 3. deferred store fails when executeIsolated returns an error
  it("fails deferred store when result.error is set", async () => {
    const failingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return Promise.resolve({ replyText: null, error: "boom", sessionPath: null });
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: failingExecute,
      getDeferredStore: () => mockStore,
    }));

    await tool.execute("call_1", { task: "会失败的任务" }, null, null, mockCtx());

    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "boom",
      );
    });
    expect(mockStore.resolve).not.toHaveBeenCalled();
  });

  it("does not silently fallback to current agent when delegated execution fails", async () => {
    const executeIsolated = vi.fn().mockRejectedValue(new Error("delegated boom"));
    const emitEvent = vi.fn();
    const tool = createSubagentTool(makeDeps({
      executeIsolated,
      getDeferredStore: () => mockStore,
      emitEvent,
      listAgents: vi.fn(() => [
        { id: "hana", name: "Hana" },
        { id: "butter", name: "butter" },
      ]),
    }));

    const result = await tool.execute("call_1", { task: "委派任务", agent: "butter" }, null, null, mockCtx());

    expect((result.details as any).requestedAgentId).toBe("butter");
    expect((result.details as any).executorAgentId).toBe("butter");
    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "delegated boom",
      );
    });
    expect(executeIsolated).toHaveBeenCalledTimes(1);
    expect(executeIsolated).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ agentId: "butter" }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "block_update",
        patch: expect.objectContaining({ streamStatus: "failed", summary: "delegated boom" }),
      }),
      "/test/session.jsonl",
    );
  });

  // 4. emits block_update with streamStatus: done on success
  it("emits block_update with streamStatus done on success", async () => {
    const emitEvent = vi.fn();
    const tool = createSubagentTool(makeDeps({
      getDeferredStore: () => mockStore,
      emitEvent,
    }));

    const result = await tool.execute("call_1", { task: "完成的任务" }, null, null, mockCtx());
    const { taskId } = result.details as any;

    await vi.waitFor(() => {
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "block_update",
          taskId,
          patch: expect.objectContaining({ streamStatus: "done" }),
        }),
        "/test/session.jsonl",
      );
    });
  });

  // 5. emits block_update with streamStatus: failed on failure
  it("emits block_update with streamStatus failed on failure", async () => {
    const emitEvent = vi.fn();
    const errorExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return Promise.resolve({ replyText: null, error: "network error", sessionPath: null });
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: errorExecute,
      getDeferredStore: () => mockStore,
      emitEvent,
    }));

    const result = await tool.execute("call_1", { task: "失败的任务" }, null, null, mockCtx());
    const { taskId } = result.details as any;

    await vi.waitFor(() => {
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "block_update",
          taskId,
          patch: expect.objectContaining({ streamStatus: "failed" }),
        }),
        "/test/session.jsonl",
      );
    });
  });

  it("does not time out subagent work before the 30 minute default", async () => {
    vi.useFakeTimers();
    const pendingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const emitEvent = vi.fn();
    const tool = createSubagentTool(makeDeps({
      executeIsolated: pendingExecute,
      getDeferredStore: () => mockStore,
      emitEvent,
    }));

    const result = await tool.execute("call_1", { task: "长任务" }, null, null, mockCtx());
    expect((result.details as any).streamStatus).toBe("running");

    await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
    expect(mockStore.fail).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60 * 1000);
    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        expect.any(String),
      );
    });
    expect(emitEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "block_update",
        patch: expect.objectContaining({ streamStatus: "failed" }),
      }),
      "/test/session.jsonl",
    );
  });

  // 6. per-session concurrent limit: rejects 11th task on the same session
  it("rejects new work when the per-session limit (10) is reached", async () => {
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
    }));

    // Dispatch 10 tasks on the same session (fire-and-forget)
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(await tool.execute(`call_${i}`, { task: `任务 ${i}` }, null, null, mockCtx()));
    }
    for (const r of results) {
      expect((r.details as any).streamStatus).toBe("running");
    }

    // 11th task on the same session must be rejected
    const blocked = await tool.execute("call_10", { task: "第十一个任务" }, null, null, mockCtx());
    expect(blocked.content[0].text).toMatch(/10|subagentMaxConcurrent/);
    expect(blocked.details).toBeUndefined();

    // Cleanup
    for (const resolve of pending) {
      resolve({ replyText: "ok", error: null, sessionPath: null });
    }
  });

  it("shares the per-session concurrency limit across moved paths with the same session id", async () => {
    const pending = [];
    const originalPath = "/session/original.jsonl";
    const movedPath = "/session/archived/renamed.jsonl";
    const sessionId = "sess_subagent_parent";
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
      getSessionIdForPath: (sessionPath: string) => (
        sessionPath === originalPath || sessionPath === movedPath ? sessionId : null
      ),
    }));

    for (let i = 0; i < 10; i++) {
      const r = await tool.execute(`call_moved_${i}`, { task: `任务 ${i}` }, null, null, mockCtx(originalPath));
      expect((r.details as any).streamStatus).toBe("running");
    }

    const blocked = await tool.execute("call_moved_10", { task: "移动后的第十一个任务" }, null, null, mockCtx(movedPath));
    expect(blocked.content[0].text).toMatch(/10|subagentMaxConcurrent/);
    expect(blocked.details).toBeUndefined();

    for (const resolve of pending) {
      resolve({ replyText: "ok", error: null, sessionPath: null });
    }
  });

  // 6b. different sessions each get their own per-session quota
  it("allows different sessions to each run up to per-session limit", async () => {
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
    }));

    // Session A: dispatch 10 tasks
    for (let i = 0; i < 10; i++) {
      const r = await tool.execute(`call_a${i}`, { task: `任务 A${i}` }, null, null, mockCtx("/session/a.jsonl"));
      expect((r.details as any).streamStatus).toBe("running");
    }

    // Session B: should still be able to dispatch 10 tasks (independent quota)
    for (let i = 0; i < 10; i++) {
      const r = await tool.execute(`call_b${i}`, { task: `任务 B${i}` }, null, null, mockCtx("/session/b.jsonl"));
      expect((r.details as any).streamStatus).toBe("running");
    }

    // Session A: 11th task should be rejected
    const blockedA = await tool.execute("call_a10", { task: "第十一个 A" }, null, null, mockCtx("/session/a.jsonl"));
    expect(blockedA.content[0].text).toMatch(/10|subagentMaxConcurrent/);
    expect(blockedA.details).toBeUndefined();

    // Session B: 11th task should also be rejected
    const blockedB = await tool.execute("call_b10", { task: "第十一个 B" }, null, null, mockCtx("/session/b.jsonl"));
    expect(blockedB.content[0].text).toMatch(/10|subagentMaxConcurrent/);
    expect(blockedB.details).toBeUndefined();

    // Cleanup
    for (const resolve of pending) {
      resolve({ replyText: "ok", error: null, sessionPath: null });
    }
  });

  // 6c. global limit (20) rejects when total across all sessions exceeds it
  it("rejects when global limit (20) is reached across sessions", async () => {
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
    }));

    // Fill up 20 tasks across 4 sessions (5 each, under per-session limit of 8)
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < 5; i++) {
        const r = await tool.execute(`call_${s}_${i}`, { task: `任务` }, null, null, mockCtx(`/session/${s}.jsonl`));
        expect((r.details as any).streamStatus).toBe("running");
      }
    }

    // 21st task from a new session (per-session is fine, but global is full)
    const blocked = await tool.execute("call_4_0", { task: "第21个" }, null, null, mockCtx("/session/4.jsonl"));
    expect(blocked.content[0].text).toMatch(/20|subagentMaxConcurrent/);
    expect(blocked.details).toBeUndefined();

    // Cleanup
    for (const resolve of pending) {
      resolve({ replyText: "ok", error: null, sessionPath: null });
    }
  });

  // 7. discovery mode: agent="?" lists agents (excluding self)
  it("lists agents in discovery mode (agent=?)", async () => {
    const noopExecute = vi.fn();
    const tool = createSubagentTool(makeDeps({
      executeIsolated: noopExecute,
      listAgents: () => [
        { id: "hana", name: "Hana", model: "claude-3-5-sonnet", summary: "主 agent" },
        { id: "other-agent", name: "Other", model: "gpt-4", summary: "专家 agent" },
      ],
      currentAgentId: "hana",
    }));

    const result = await (tool.execute as any)("call_1", { task: "", agent: "?" });

    expect(result.content[0].text).toContain("other-agent");
    expect(result.content[0].text).toContain("Other");
    // self should be excluded
    expect(result.content[0].text).not.toContain("hana (");
    // executeIsolated must not be called in discovery mode
    expect(noopExecute).not.toHaveBeenCalled();
  });

  // 8. cross-agent delegation: agentId forwarded in opts
  it("passes agentId to executeIsolated when delegating to another agent", async () => {
    const captureExecute = makeExecuteIsolated({ replyText: "delegated", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
    }));

    const result = await tool.execute("call_1", { task: "专项任务", agent: "other-agent" }, null, null, mockCtx());

    expect((result.details as any).agentId).toBe("other-agent");
    expect(captureExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ agentId: "other-agent" }),
    );
  });

  it("passes parent session files as read-only scopes to isolated execution", async () => {
    const captureExecute = makeExecuteIsolated({ replyText: "ok", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
    }));

    await tool.execute("call_1", { task: "读取 parent 附件" }, null, null, mockCtx("/test/parent.jsonl"));

    expect(captureExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        fileReadSessionPaths: ["/test/parent.jsonl"],
      }),
    );
  });

  // 9. unknown agent returns error without calling executeIsolated
  it("returns error when agent id is unknown", async () => {
    const noopExecute = vi.fn();
    const tool = createSubagentTool(makeDeps({ executeIsolated: noopExecute }));

    const result = await (tool.execute as any)("call_1", { task: "任务", agent: "nonexistent" });

    expect(result.content[0].text).toMatch(/agentNotFound|not found|不存在|找不到 agent/);
    expect(noopExecute).not.toHaveBeenCalled();
  });

  // 9b. LLM 把 roster 里的显示名当 id 用：name → id 兜底匹配
  it("resolves display name to id when caller passes name instead of id", async () => {
    const captureExecute = makeExecuteIsolated({ replyText: "ok", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
      listAgents: () => [
        { id: "hana", name: "Hana" },
        { id: "ming", name: "明" },
      ],
      currentAgentId: "hana",
    }));

    const result = await tool.execute("call_1", { task: "委派", agent: "明" }, null, null, mockCtx());

    expect((result.details as any).agentId).toBe("ming");
    expect(captureExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ agentId: "ming" }),
    );
  });

  // 10. direct instances require durable parent-session infrastructure
  it("returns an explicit error instead of sync fallback when deferred store is unavailable", async () => {
    const syncExecute = makeExecuteIsolated({ replyText: "sync result", error: null, sessionPath: null });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: syncExecute,
      getDeferredStore: () => null,
      getSessionPath: () => null,
    }));

    const result = await (tool.execute as any)("call_1", { task: "同步任务" });

    expect(result.content[0].text).toBeTruthy();
    expect((result.details as any).errorCode).toBe("SUBAGENT_PARENT_SESSION_REQUIRED");
    expect(syncExecute).not.toHaveBeenCalled();
  });

  it("returns an explicit error when the thread store is unavailable", async () => {
    const syncExecute = makeExecuteIsolated({ replyText: "sync result", error: null, sessionPath: null });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: syncExecute,
      getSubagentThreadStore: () => null,
    }));

    const result = await tool.execute("call_1", { task: "缺少线程账本" }, null, null, mockCtx());

    expect(result.content[0].text).toBeTruthy();
    expect((result.details as any).errorCode).toBe("SUBAGENT_PARENT_SESSION_REQUIRED");
    expect(syncExecute).not.toHaveBeenCalled();
  });
});

describe("subagent-tool 权限档（Codex 式：access 参数 + 继承父会话）", () => {
  let mockStore;
  beforeEach(() => {
    mockStore = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn(), query: vi.fn(() => ({ meta: {} })), _save: vi.fn() };
  });
  afterEach(() => { vi.useRealTimers(); });

  async function captureOpts(params, extraDeps: any = {}) {
    const capture = makeExecuteIsolated();
    const tool = createSubagentTool(makeDeps({
      executeIsolated: capture,
      getDeferredStore: () => mockStore,
      ...extraDeps,
    }));
    await tool.execute("call_1", params, null, null, mockCtx());
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    return capture.mock.calls[0][1];
  }

  it("access:read → 派单 permissionMode=read_only（探索者只读，真实 write 由拦截层挡）", async () => {
    const opts = await captureOpts({ task: "调研", access: "read" });
    expect(opts.permissionMode).toBe("read_only");
    expect(opts.subagentContext).toBe(true);
  });

  it("access:write → 派单 permissionMode=operate（执行者可操作）", async () => {
    const opts = await captureOpts({ task: "改代码", access: "write" });
    expect(opts.permissionMode).toBe("operate");
  });

  it("access:read 压过父会话可操作档（显式优先）", async () => {
    const opts = await captureOpts(
      { task: "只读审查", access: "read" },
      { getSessionPermissionMode: () => "operate" },
    );
    expect(opts.permissionMode).toBe("read_only");
  });

  it("省略 access + 父会话只读(plan) → 继承 read_only", async () => {
    const opts = await captureOpts(
      { task: "跟随父档" },
      { getSessionPermissionMode: () => "read_only" },
    );
    expect(opts.permissionMode).toBe("read_only");
  });

  it("省略 access + 父会话可操作 → 继承 operate", async () => {
    const opts = await captureOpts(
      { task: "跟随父档" },
      { getSessionPermissionMode: () => "operate" },
    );
    expect(opts.permissionMode).toBe("operate");
  });

  it("省略 access + 父会话先问(ask) → 继承 ask，并禁用人工确认", async () => {
    const opts = await captureOpts(
      { task: "跟随父档" },
      { getSessionPermissionMode: () => "ask" },
    );
    expect(opts.permissionMode).toBe("ask");
    expect(opts.approvalPolicy).toBe("deny_on_prompt");
    expect(opts.allowHumanApproval).toBe(false);
  });

  it("省略 access + 父会话 auto → 继承 auto，并禁用人工确认", async () => {
    const opts = await captureOpts(
      { task: "跟随父档" },
      { getSessionPermissionMode: () => "auto" },
    );
    expect(opts.permissionMode).toBe("auto");
    expect(opts.approvalPolicy).toBe("deny_on_prompt");
    expect(opts.allowHumanApproval).toBe(false);
  });

  it("非法 access 值按省略处理（继承父只读档）", async () => {
    const opts = await captureOpts(
      { task: "x", access: "garbage" },
      { getSessionPermissionMode: () => "read_only" },
    );
    expect(opts.permissionMode).toBe("read_only");
  });

  it("getSessionPermissionMode 按 parentSessionPath 反查（不从焦点推导）", async () => {
    const getSessionPermissionMode = vi.fn(() => "read_only");
    await captureOpts({ task: "x" }, { getSessionPermissionMode });
    expect(getSessionPermissionMode).toHaveBeenCalledWith("/test/session.jsonl");
  });

  // ── attenuation 校验（#1614）：父只读 + 显式 write → 拒绝派单，不静默降级 ──
  it("父只读 + access:write → 派单被拒（错误结果 + 不执行 + 不登记任务）", async () => {
    const capture = makeExecuteIsolated();
    const tool = createSubagentTool(makeDeps({
      executeIsolated: capture,
      getDeferredStore: () => mockStore,
      getSessionPermissionMode: () => "read_only",
    }));
    const result = await tool.execute("call_1", { task: "改代码", access: "write" }, null, null, mockCtx());
    expect((result.details as any).errorCode).toBe("SUBAGENT_WRITE_DENIED_BY_PARENT_READ_ONLY");
    // t() 在测试环境返回 key 本身；只断言走了对应文案 key
    expect(result.content[0].text).toMatch(/subagentWriteAccessDenied|read-only|只读/);
    expect(capture).not.toHaveBeenCalled();
    expect(mockStore.defer).not.toHaveBeenCalled();
  });

  it("父只读 + access:write 的 subagent_reply 同样被拒（线程残留 write 档也不放行）", async () => {
    const threadStore = new (SubagentThreadStore as any)();
    threadStore.beginRun("thread-w", {
      kind: "direct",
      parentSessionPath: "/test/session.jsonl",
      agentId: "other-agent",
      access: "write",
    });
    threadStore.attachSession("thread-w", "/test/child.jsonl");
    threadStore.finishRun("thread-w", { status: "resolved", summary: "ok", close: false });

    const capture = makeExecuteIsolated();
    const replyTool = createSubagentReplyTool(makeDeps({
      executeIsolated: capture,
      getDeferredStore: () => mockStore,
      getSubagentThreadStore: () => threadStore,
      getSessionPermissionMode: () => "read_only",
    }));

    // 继承线程的 write 档：父只读时拒绝
    const denied = await replyTool.execute("c1", { threadId: "thread-w", task: "继续" }, null, null, mockCtx());
    expect((denied.details as any).errorCode).toBe("SUBAGENT_WRITE_DENIED_BY_PARENT_READ_ONLY");
    expect(capture).not.toHaveBeenCalled();
    expect(mockStore.defer).not.toHaveBeenCalled();

    // 显式降到 access:read：放行（给模型的出路与错误提示一致）
    const allowed = await replyTool.execute("c2", { threadId: "thread-w", task: "只读继续", access: "read" }, null, null, mockCtx());
    expect((allowed.details as any).errorCode).toBeUndefined();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(capture.mock.calls[0][1].permissionMode).toBe("read_only");
  });
});

describe("subagent-tool direct instance lifecycle", () => {
  let mockStore;
  beforeEach(() => {
    mockStore = {
      defer: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
      abort: vi.fn(),
      query: vi.fn(() => ({ meta: {} })),
      _save: vi.fn(),
    };
  });
  afterEach(() => { vi.useRealTimers(); });

  it("新建 direct subagent 默认就是 open instance，label 只做展示，access 只决定权限", async () => {
    const threadStore = new (SubagentThreadStore as any)();
    const capture = makeExecuteIsolated({ replyText: "ok", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: capture,
      getDeferredStore: () => mockStore,
      getSubagentThreadStore: () => threadStore,
    }));

    const res = await tool.execute("c1", {
      task: "探索任务",
      agent: "other-agent",
      label: "探索一",
      access: "read",
    }, null, null, mockCtx());
    expect((res.details as any).label).toBe("探索一");
    expect((res.details as any).reuseInstance).toBeUndefined();
    expect((res.details as any).threadId).toBe((res.details as any).taskId);
    expect((res.details as any).threadKind).toBe("direct");

    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    const opts = capture.mock.calls[0][1];
    expect(opts.persist).toMatch(/subagent-sessions[/\\]direct$/);
    expect(opts.resumeSessionPath).toBeUndefined();
    expect(opts.permissionMode).toBe("read_only");
    expect(opts.subagentContext).toBe(true);

    await vi.waitFor(() => {
      expect(threadStore.get((res.details as any).threadId)).toMatchObject({
        kind: "direct",
        status: "open",
        lastRunStatus: "resolved",
        parentSessionPath: "/test/session.jsonl",
        agentId: "other-agent",
        agentName: "Other",
        childSessionPath: "/test/child.jsonl",
        label: "探索一",
        access: "read",
        summary: "ok",
        runCount: 1,
      });
    });
  });

  it("legacy instance 参数只映射为 label，不再作为复用开关或 reuseKey", async () => {
    const threadStore = new (SubagentThreadStore as any)();
    const capture = makeExecuteIsolated({ replyText: "ok", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: capture,
      getDeferredStore: () => mockStore,
      getSubagentThreadStore: () => threadStore,
    }));

    const first = await tool.execute("c1", {
      task: "第一次",
      agent: "other-agent",
      instance: "探索",
    }, null, null, mockCtx());
    const second = await tool.execute("c2", {
      task: "第二次",
      agent: "other-agent",
      instance: "探索",
    }, null, null, mockCtx());

    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
    expect((first.details as any).threadId).not.toBe((second.details as any).threadId);
    expect((first.details as any).label).toBe("探索");
    expect((second.details as any).label).toBe("探索");
    expect(capture.mock.calls[1][1].resumeSessionPath).toBeUndefined();
    expect(threadStore.listOpenDirectBySession("/test/session.jsonl")).toHaveLength(2);
  });

  it("subagent_reply 用 threadId 续接已有 direct instance，并生成新的 taskId", async () => {
    const threadStore = new (SubagentThreadStore as any)();
    const capture = makeExecuteIsolated({ replyText: "continued", error: null, sessionPath: "/test/child.jsonl" });
    threadStore.beginRun("subagent-thread-1", {
      kind: "direct",
      parentSessionPath: "/test/session.jsonl",
      agentId: "other-agent",
      agentName: "Other",
      label: "探索一",
      access: "read",
    });
    threadStore.attachSession("subagent-thread-1", "/test/child.jsonl");
    threadStore.finishRun("subagent-thread-1", {
      status: "resolved",
      summary: "之前读过生命周期",
      close: false,
    });

    const replyTool = createSubagentReplyTool(makeDeps({
      executeIsolated: capture,
      getDeferredStore: () => mockStore,
      getSubagentThreadStore: () => threadStore,
    }));

    const res = await replyTool.execute("c1", {
      threadId: "subagent-thread-1",
      task: "继续刚才的方向",
    }, null, null, mockCtx());

    expect((res.details as any).taskId).toMatch(/^subagent-/);
    expect((res.details as any).threadId).toBe("subagent-thread-1");
    expect((res.details as any).threadKind).toBe("direct");
    expect((res.details as any).label).toBe("探索一");
    expect(mockStore.defer).toHaveBeenCalledWith(
      expect.stringMatching(/^subagent-/),
      "/test/session.jsonl",
      expect.objectContaining({ deliveryIntent: "trigger_parent_turn" }),
    );

    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    const opts = capture.mock.calls[0][1];
    expect(opts.agentId).toBe("other-agent");
    expect(opts.resumeSessionPath).toBe("/test/child.jsonl");
    expect(opts.persist).toMatch(/subagent-sessions[/\\]direct$/);
    expect(opts.permissionMode).toBe("read_only");

    await vi.waitFor(() => {
      expect(threadStore.get("subagent-thread-1")).toMatchObject({
        runCount: 2,
        summary: "continued",
        status: "open",
        lastRunStatus: "resolved",
      });
    });
  });

  it("fork 后用历史 threadId 只续接目标 Session 的独立 clone", async () => {
    const sessionIds = new Map([
      ["/source.jsonl", "sess_source"],
      ["/fork.jsonl", "sess_fork"],
      ["/children/source.jsonl", "sess_child_source"],
      ["/children/fork.jsonl", "sess_child_fork"],
    ]);
    const getSessionIdForPath = (sessionPath) => sessionIds.get(sessionPath) || null;
    const threadStore = new (SubagentThreadStore as any)(null, { getSessionIdForPath });
    threadStore.beginRun("historical-thread", {
      kind: "direct",
      parentSessionPath: "/source.jsonl",
      agentId: "other-agent",
      agentName: "Other",
      access: "read",
    });
    threadStore.attachSession("historical-thread", "/children/source.jsonl", {
      childSessionId: "sess_child_source",
    });
    threadStore.finishRun("historical-thread", { status: "resolved", summary: "source ready", close: false });
    await threadStore.forkOpenDirectThreads({
      sourceSessionId: "sess_source",
      sourceSessionPath: "/source.jsonl",
      targetSessionId: "sess_fork",
      targetSessionPath: "/fork.jsonl",
      retainedEntries: [{ data: { threadId: "historical-thread" } }],
      createThreadId: () => "fork-thread",
      cloneChildSession: async () => ({
        sessionId: "sess_child_fork",
        sessionPath: "/children/fork.jsonl",
      }),
      discardChildSession: async () => undefined,
    });
    const capture = vi.fn().mockImplementation((_prompt, opts) => {
      opts.onSessionReady?.("/children/fork.jsonl", {
        sessionId: "sess_child_fork",
        sessionPath: "/children/fork.jsonl",
      });
      return Promise.resolve({ replyText: "fork continued", error: null, sessionPath: "/children/fork.jsonl" });
    });
    const replyTool = createSubagentReplyTool(makeDeps({
      executeIsolated: capture,
      getDeferredStore: () => mockStore,
      getSubagentThreadStore: () => threadStore,
      getSessionIdForPath,
    }));

    const result = await replyTool.execute("c-fork", {
      threadId: "historical-thread",
      task: "只在 fork 里继续",
    }, null, null, mockCtx("/fork.jsonl"));

    expect((result.details as any).threadId).toBe("fork-thread");
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    expect(capture.mock.calls[0][1]).toMatchObject({
      parentSessionPath: "/fork.jsonl",
      resumeSessionPath: "/children/fork.jsonl",
      subagentThreadId: "fork-thread",
    });
    await vi.waitFor(() => expect(threadStore.get("fork-thread")).toMatchObject({
      runCount: 2,
      summary: "fork continued",
      childSessionPath: "/children/fork.jsonl",
    }));
    expect(threadStore.get("historical-thread")).toMatchObject({
      runCount: 1,
      summary: "source ready",
      childSessionPath: "/children/source.jsonl",
    });
  });

  it("subagent_reply 拒绝关闭的、跨父会话的或 workflow 节点线程", async () => {
    const threadStore = new (SubagentThreadStore as any)();
    threadStore.beginRun("closed", { kind: "direct", parentSessionPath: "/test/session.jsonl" });
    threadStore.closeDirectThread("closed", { summary: "done" });
    threadStore.beginRun("other-session", { kind: "direct", parentSessionPath: "/other/session.jsonl" });
    threadStore.beginRun("workflow-1::node-1", { kind: "workflow_node", parentSessionPath: "/test/session.jsonl" });

    const capture = makeExecuteIsolated();
    const replyTool = createSubagentReplyTool(makeDeps({
      executeIsolated: capture,
      getDeferredStore: () => mockStore,
      getSubagentThreadStore: () => threadStore,
    }));

    await expect(replyTool.execute("c1", { threadId: "closed", task: "x" }, null, null, mockCtx()))
      .resolves.toMatchObject({ details: expect.objectContaining({ errorCode: "SUBAGENT_THREAD_NOT_OPEN" }) });
    await expect(replyTool.execute("c2", { threadId: "other-session", task: "x" }, null, null, mockCtx()))
      .resolves.toMatchObject({ details: expect.objectContaining({ errorCode: "SUBAGENT_THREAD_NOT_IN_SESSION" }) });
    await expect(replyTool.execute("c3", { threadId: "workflow-1::node-1", task: "x" }, null, null, mockCtx()))
      .resolves.toMatchObject({ details: expect.objectContaining({ errorCode: "SUBAGENT_THREAD_NOT_DIRECT" }) });
    expect(capture).not.toHaveBeenCalled();
  });

  it("subagent_close 关闭当前父会话里的 direct instance", async () => {
    const threadStore = new (SubagentThreadStore as any)();
    threadStore.beginRun("subagent-thread-1", {
      kind: "direct",
      parentSessionPath: "/test/session.jsonl",
      agentId: "other-agent",
      label: "探索一",
      access: "read",
    });
    const closeTool = createSubagentCloseTool(makeDeps({
      getDeferredStore: () => mockStore,
      getSubagentThreadStore: () => threadStore,
    }));

    const res = await closeTool.execute("c1", {
      threadId: "subagent-thread-1",
      reason: "探索阶段结束",
    }, null, null, mockCtx());

    expect(res.details).toMatchObject({
      threadId: "subagent-thread-1",
      streamStatus: "closed",
    });
    expect(threadStore.get("subagent-thread-1")).toMatchObject({
      status: "closed",
      summary: "探索阶段结束",
    });
  });

  it("fork 后 close 的历史 threadId 只关闭目标 Session clone", async () => {
    const sessionIds = new Map([
      ["/source.jsonl", "sess_source"],
      ["/fork.jsonl", "sess_fork"],
    ]);
    const getSessionIdForPath = (sessionPath) => sessionIds.get(sessionPath) || null;
    const threadStore = new (SubagentThreadStore as any)(null, { getSessionIdForPath });
    threadStore.beginRun("source-thread", { kind: "direct", parentSessionPath: "/source.jsonl" });
    threadStore.attachSession("source-thread", "/children/source.jsonl", { childSessionId: "sess_child_source" });
    threadStore.finishRun("source-thread", { status: "resolved", close: false });
    await threadStore.forkOpenDirectThreads({
      sourceSessionId: "sess_source",
      sourceSessionPath: "/source.jsonl",
      targetSessionId: "sess_fork",
      targetSessionPath: "/fork.jsonl",
      retainedEntries: [{ threadId: "source-thread" }],
      createThreadId: () => "fork-thread",
      cloneChildSession: async () => ({ sessionId: "sess_child_fork", sessionPath: "/children/fork.jsonl" }),
      discardChildSession: async () => undefined,
    });
    const closeTool = createSubagentCloseTool(makeDeps({
      getSubagentThreadStore: () => threadStore,
      getSessionIdForPath,
    }));

    const result = await closeTool.execute("close-fork", {
      threadId: "source-thread",
      reason: "fork done",
    }, null, null, mockCtx("/fork.jsonl"));

    expect(result.details).toMatchObject({ threadId: "fork-thread", streamStatus: "closed" });
    expect(threadStore.get("fork-thread")).toMatchObject({ status: "closed", summary: "fork done" });
    expect(threadStore.get("source-thread")).toMatchObject({ status: "open" });
  });

  it("同一 direct instance 并发 reply 串行排队，另一个 direct instance 不被阻塞", async () => {
    const threadStore = new (SubagentThreadStore as any)();
    threadStore.beginRun("thread-a", { kind: "direct", parentSessionPath: "/test/session.jsonl", agentId: "other-agent", access: "write" });
    threadStore.attachSession("thread-a", "/test/a.jsonl");
    threadStore.finishRun("thread-a", { status: "resolved", summary: "a ready", close: false });
    threadStore.beginRun("thread-b", { kind: "direct", parentSessionPath: "/test/session.jsonl", agentId: "other-agent", access: "write" });
    threadStore.attachSession("thread-b", "/test/b.jsonl");
    threadStore.finishRun("thread-b", { status: "resolved", summary: "b ready", close: false });

    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_p, opts) => {
      opts?.onSessionReady?.(opts.resumeSessionPath);
      return new Promise((resolve) => pending.push(resolve));
    });
    const replyTool = createSubagentReplyTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
      getSubagentThreadStore: () => threadStore,
    }));

    const r1 = await replyTool.execute("c1", { threadId: "thread-a", task: "a1" }, null, null, mockCtx());
    await vi.waitFor(() => expect(blockingExecute).toHaveBeenCalledTimes(1));
    const r2 = await replyTool.execute("c2", { threadId: "thread-a", task: "a2" }, null, null, mockCtx());
    const r3 = await replyTool.execute("c3", { threadId: "thread-b", task: "b1" }, null, null, mockCtx());

    expect((r1.details as any).threadId).toBe("thread-a");
    expect(r2.content[0].text).toMatch(/queued|排队|subagentThreadQueued/);
    expect((r3.details as any).threadId).toBe("thread-b");
    await vi.waitFor(() => expect(blockingExecute).toHaveBeenCalledTimes(2)); // a1 + b1，a2 未开始

    pending[0]({ replyText: "a1 done", error: null, sessionPath: "/test/a.jsonl" });
    await vi.waitFor(() => expect(blockingExecute).toHaveBeenCalledTimes(3));
    pending.forEach((resolve) => resolve({ replyText: "done", error: null, sessionPath: null }));
  });

  it("current_status provider can expose open direct instances for the current session", async () => {
    const threadStore = new (SubagentThreadStore as any)();
    threadStore.beginRun("thread-a", {
      kind: "direct",
      parentSessionPath: "/test/session.jsonl",
      agentId: "other-agent",
      agentName: "Other",
      label: "探索一",
      access: "read",
      summary: "读完生命周期代码",
    });
    threadStore.finishRun("thread-a", { status: "resolved", summary: "读完生命周期代码", close: false });
    const statusTool = makeDeps({
      getSubagentThreadStore: () => threadStore,
    });

    expect(statusTool.getSubagentThreadStore().listOpenDirectBySession("/test/session.jsonl")).toEqual([
      expect.objectContaining({
        threadId: "thread-a",
        agentName: "Other",
        label: "探索一",
        access: "read",
      }),
    ]);
  });
});
