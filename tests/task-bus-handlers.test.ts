import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRegistry } from "../lib/task-registry.ts";
import { registerTaskRegistryBusHandlers } from "../server/task-bus-handlers.ts";

afterEach(() => {
  vi.useRealTimers();
});

function createBusHarness() {
  const handlers = new Map();
  return {
    bus: {
      handle: vi.fn((type, handler) => {
        handlers.set(type, handler);
      }),
    },
    request(type, payload) {
      const handler = handlers.get(type);
      if (!handler) throw new Error(`missing handler ${type}`);
      return handler(payload);
    },
  };
}

describe("registerTaskRegistryBusHandlers", () => {
  it("preserves task handler run callbacks for scheduled tasks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    const registry = new TaskRegistry();
    const { bus, request } = createBusHarness();
    const abort = vi.fn();
    const run = vi.fn(async () => ({ ok: true }));

    registerTaskRegistryBusHandlers(bus, registry);
    request("task:register-handler", { type: "digest", abort, run });
    request("task:schedule", {
      scheduleId: "daily",
      type: "digest",
      runAt: Date.now() + 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: "daily",
      type: "digest",
    }));
    expect(registry.querySchedule("daily")).toMatchObject({
      enabled: false,
      runCount: 1,
      lastResult: { ok: true },
    });
    registry.clearTimers();
  });

  it("keeps abort-only handlers valid for ordinary task cancellation", () => {
    const registry = new TaskRegistry();
    const { bus, request } = createBusHarness();
    const abort = vi.fn();

    registerTaskRegistryBusHandlers(bus, registry);
    request("task:register-handler", { type: "render", abort });
    request("task:register", { taskId: "t1", type: "render" });

    expect(request("task:cancel", { taskId: "t1", reason: "user" })).toEqual({
      result: "aborted",
      canceled: true,
    });
    expect(abort).toHaveBeenCalledWith("t1");
  });

  it("uses sessionId as the stable parent identity for registered tasks", () => {
    const registry = new TaskRegistry();
    const { bus, request } = createBusHarness();
    const abort = vi.fn();

    registerTaskRegistryBusHandlers(bus, registry);
    request("task:register-handler", { type: "render", abort });
    request("task:register", {
      taskId: "id-task",
      type: "render",
      sessionId: "sess_task",
      parentSessionPath: "/sessions/old.jsonl",
    });
    request("task:register", {
      taskId: "path-task",
      type: "render",
      parentSessionPath: "/sessions/new.jsonl",
    });

    expect(request("task:list", { parentSessionId: "sess_task" }).map((task) => task.taskId)).toEqual(["id-task"]);
    expect(registry.abortByParentSession({
      sessionId: "sess_task",
      sessionPath: "/sessions/new.jsonl",
    }, "parent archived")).toMatchObject({
      matched: 1,
      aborted: 1,
    });
    expect(registry.query("id-task")).toMatchObject({
      parentSessionId: "sess_task",
      parentSessionPath: "/sessions/old.jsonl",
      status: "aborted",
    });
    expect(registry.query("path-task")).toMatchObject({
      parentSessionPath: "/sessions/new.jsonl",
      status: "running",
    });
  });
});
