import { describe, expect, it, vi } from "vitest";
import { createCardGuideTool } from "../lib/tools/card-guide-tool.ts";
import { createCheckDeferredTool } from "../lib/tools/check-deferred-tool.ts";
import { createShowCardTool } from "../lib/tools/show-card-tool.ts";
import {
  createSubagentCloseTool,
  createSubagentReplyTool,
  createSubagentTool,
} from "../lib/tools/subagent-tool.ts";
import { createTodoTool } from "../lib/tools/todo.ts";
import { createStopTaskTool } from "../lib/tools/stop-task-tool.ts";
import { resolveToolInvocationPermission } from "../lib/permission/tool-invocation-permission.ts";

function runtimeCtx(sessionPath = "/sessions/current.jsonl") {
  return {
    sessionManager: {
      getSessionFile: () => sessionPath,
    },
  };
}

describe("built-in permission catalog", () => {
  it("classifies built-in actions at their declared permission boundaries", () => {
    const subagentDeps = { agentDir: "/agents/hana" };
    const toolsAndInputs: Array<[Record<string, any>, Record<string, any>]> = [
      [createCardGuideTool(), {}],
      [createCheckDeferredTool({
        getDeferredStore: () => null,
        getSessionPath: () => null,
      }), {}],
      [createShowCardTool(), { title: "chart", code: "<svg></svg>" }],
      [createTodoTool(), { todos: [] }],
      [createSubagentTool(subagentDeps), { task: "research" }],
      [createSubagentReplyTool(subagentDeps), { threadId: "th_1", task: "continue" }],
      [createSubagentCloseTool(subagentDeps), { threadId: "th_1" }],
    ];
    const resolutions = toolsAndInputs.map(([tool, input]) => (
      resolveToolInvocationPermission(tool, input)
    ));
    expect(resolutions.every((resolution) => resolution.ok)).toBe(true);
    const descriptors = resolutions.map((resolution) => (
      resolution.ok ? resolution.descriptor : null
    ));

    expect(descriptors.map((descriptor) => descriptor?.kind)).toEqual([
      "read",
      "read",
      "review",
      "routine",
      "routine",
      "routine",
      "routine",
    ]);
    expect(descriptors.map((descriptor) => descriptor?.capability)).toEqual([
      "hana_card_guide.read",
      "check_pending_tasks.read",
      "show_card.render",
      "todo_write.replace",
      "subagent.launch",
      "subagent_reply.continue",
      "subagent_close.close",
    ]);
  });

  it("keeps subagent roster discovery readable in read-only sessions", () => {
    const tool = createSubagentTool({ agentDir: "/agents/hana" });

    expect(tool.sessionPermission.resolveInvocation({ agent: "?" })).toEqual({
      action: "list",
      kind: "read",
      capability: "subagent.list",
    });
  });
});

describe("stop_task stable ownership boundary", () => {
  it("stops a task owned by the caller's stable session id", async () => {
    const abort = vi.fn(() => "aborted");
    const registry = {
      query: vi.fn(() => ({ taskId: "task-1", parentSessionId: "sess-current" })),
      abort,
    };
    const tool = createStopTaskTool({
      getTaskRegistry: () => registry,
      getSessionIdForPath: (sessionPath) => (
        sessionPath === "/sessions/current.jsonl" ? "sess-current" : null
      ),
    });

    const result = await tool.execute(
      "call-1",
      { task_id: "task-1" },
      null,
      null,
      runtimeCtx(),
    );

    expect(abort).toHaveBeenCalledWith("task-1");
    expect((result as any).isError).not.toBe(true);
    expect(tool.sessionPermission.resolveInvocation({ task_id: "task-1" })).toMatchObject({
      action: "stop",
      kind: "routine",
      capability: "stop_task.stop",
      target: { type: "background_task", id: "task-1" },
    });
    expect(resolveToolInvocationPermission(tool, { task_id: "task-1" })).toMatchObject({
      ok: true,
      source: "descriptor",
      descriptor: {
        action: "stop",
        kind: "routine",
        capability: "stop_task.stop",
        target: { type: "background_task", id: "task-1" },
      },
    });
  });

  it("refuses a task owned by another session before calling abort", async () => {
    const abort = vi.fn(() => "aborted");
    const tool = createStopTaskTool({
      getTaskRegistry: () => ({
        query: () => ({ taskId: "task-other", parentSessionId: "sess-other" }),
        abort,
      }),
      getSessionIdForPath: () => "sess-current",
    });

    const result = await tool.execute(
      "call-1",
      { task_id: "task-other" },
      null,
      null,
      runtimeCtx(),
    );

    expect(abort).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      details: { errorCode: "STOP_TASK_SESSION_MISMATCH", taskId: "task-other" },
    });
  });

  it("fails closed when either side has no stable session identity", async () => {
    const abort = vi.fn(() => "aborted");
    const registry = {
      query: () => ({ taskId: "task-legacy", parentSessionPath: "/sessions/legacy.jsonl" }),
      abort,
    };
    const missingCaller = createStopTaskTool({
      getTaskRegistry: () => registry,
      getSessionIdForPath: () => null,
    });
    const missingParent = createStopTaskTool({
      getTaskRegistry: () => registry,
      getSessionIdForPath: (sessionPath) => (
        sessionPath === "/sessions/current.jsonl" ? "sess-current" : null
      ),
    });

    const callerResult = await missingCaller.execute(
      "call-1", { task_id: "task-legacy" }, null, null, runtimeCtx(),
    );
    const parentResult = await missingParent.execute(
      "call-2", { task_id: "task-legacy" }, null, null, runtimeCtx(),
    );

    expect((callerResult as any).details.errorCode).toBe("STOP_TASK_SESSION_ID_REQUIRED");
    expect((parentResult as any).details.errorCode).toBe("STOP_TASK_PARENT_SESSION_ID_REQUIRED");
    expect(abort).not.toHaveBeenCalled();
  });
});
