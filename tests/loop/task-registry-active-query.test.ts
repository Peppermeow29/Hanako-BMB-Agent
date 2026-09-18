import { describe, it, expect } from "vitest";
import { TaskRegistry, ACTIVE_TASK_STATUSES } from "../../lib/task-registry.ts";

describe("TaskRegistry.hasActiveForParentSession", () => {
  it("exports ACTIVE_TASK_STATUSES covering non-final states", () => {
    expect(ACTIVE_TASK_STATUSES.has("running")).toBe(true);
    expect(ACTIVE_TASK_STATUSES.has("pending")).toBe(true);
    expect(ACTIVE_TASK_STATUSES.has("completed")).toBe(false);
  });

  it("returns true only when the session has a non-final task", () => {
    const registry = new TaskRegistry();
    registry.register("t1", { type: "test", parentSessionPath: "/tmp/s1.jsonl", persist: false });
    expect(registry.hasActiveForParentSession("/tmp/s1.jsonl")).toBe(true);
    expect(registry.hasActiveForParentSession("/tmp/other.jsonl")).toBe(false);
    registry.complete("t1");
    expect(registry.hasActiveForParentSession("/tmp/s1.jsonl")).toBe(false);
  });
});
