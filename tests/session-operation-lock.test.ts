import { describe, expect, it } from "vitest";
import { acquireSessionOperation } from "../core/session-operation-lock.ts";

describe("session operation lock", () => {
  it("serializes Retry and Fork by stable Session identity", () => {
    const releaseRetry = acquireSessionOperation("session-1", "retry");
    expect(() => acquireSessionOperation("session-1", "fork")).toThrow(expect.objectContaining({
      code: "session_busy",
      status: 409,
      operation: "fork",
      activeOperation: "retry",
    }));
    const releaseOther = acquireSessionOperation("session-2", "fork");
    expect(releaseOther).toBeTypeOf("function");
    releaseOther();
    expect(releaseRetry()).toBe(true);
    const releaseFork = acquireSessionOperation("session-1", "fork");
    expect(releaseFork()).toBe(true);
    expect(releaseFork()).toBe(false);
  });
});
