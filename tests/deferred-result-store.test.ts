import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeferredResultStore } from "../lib/deferred-result-store.ts";

describe("DeferredResultStore", () => {
  let store;
  let mockBus;

  beforeEach(() => {
    mockBus = { emit: vi.fn() };
    store = new (DeferredResultStore as any)(mockBus);
  });

  describe("defer + resolve", () => {
    it("registers a task and resolves it", () => {
      store.defer("t1", "/session/a", { type: "image" });
      expect(store.query("t1")).toMatchObject({ status: "pending", sessionPath: "/session/a" });
      store.resolve("t1", { files: ["img.png"] });
      expect(store.query("t1")).toMatchObject({ status: "resolved" });
    });

    it("triggers onResult callback with taskId, sessionPath, result, meta", () => {
      const cb = vi.fn();
      store.onResult(cb);
      store.defer("t1", "/s/a", { type: "img" });
      store.resolve("t1", { files: ["x.png"] });
      expect(cb).toHaveBeenCalledWith("t1", "/s/a", { files: ["x.png"] }, { type: "img" });
    });

    it("emits deferred_result event on EventBus", () => {
      store.defer("t1", "/s/a", { type: "img" });
      store.resolve("t1", { files: ["x.png"] });
      expect(mockBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "deferred_result", taskId: "t1", status: "success" }),
        "/s/a"
      );
    });

    it("ignores duplicate resolve (no-op)", () => {
      const cb = vi.fn();
      store.onResult(cb);
      store.defer("t1", "/s/a", {});
      store.resolve("t1", { a: 1 });
      store.resolve("t1", { a: 2 });
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe("defer + fail", () => {
    it("records failure reason", () => {
      store.defer("t1", "/s/a", { type: "img" });
      store.fail("t1", "credit exhausted");
      expect(store.query("t1")).toMatchObject({ status: "failed", reason: "credit exhausted" });
    });

    it("triggers onFail callback", () => {
      const cb = vi.fn();
      store.onFail(cb);
      store.defer("t1", "/s/a", { type: "img" });
      store.fail("t1", "boom");
      expect(cb).toHaveBeenCalledWith("t1", "/s/a", "boom", { type: "img" });
    });
  });

  describe("retry", () => {
    it("reopens a failed task as pending with fresh metadata", () => {
      store.defer("t1", "/s/a", { type: "image-generation", prompt: "old" });
      store.fail("t1", "API returned no images");

      store.retry("t1", "/s/a", { type: "image-generation", prompt: "new" });

      expect(store.query("t1")).toMatchObject({
        status: "pending",
        sessionPath: "/s/a",
        meta: { type: "image-generation", prompt: "new" },
        result: null,
        reason: null,
        delivered: false,
      });
      expect(store.listPending("/s/a").map((task) => task.taskId)).toEqual(["t1"]);
    });
  });

  describe("listPending", () => {
    it("returns only pending tasks for the given session", () => {
      store.defer("t1", "/s/a", {});
      store.defer("t2", "/s/b", {});
      store.defer("t3", "/s/a", {});
      store.resolve("t3", {});
      const pending = store.listPending("/s/a");
      expect(pending).toHaveLength(1);
      expect(pending[0].taskId).toBe("t1");
    });

    it("uses sessionId as the stable identity when a legacy path changes", () => {
      store.defer("t1", {
        sessionId: "sess_deferred",
        sessionPath: "/s/old.jsonl",
      }, { type: "image" });

      expect(store.listPending({
        sessionId: "sess_deferred",
        sessionPath: "/s/new.jsonl",
      }).map((task) => task.taskId)).toEqual(["t1"]);
      expect(store.listPending("/s/new.jsonl")).toEqual([]);
    });
  });

  describe("clearBySession", () => {
    it("removes all pending tasks for a session", () => {
      store.defer("t1", "/s/a", {});
      store.defer("t2", "/s/a", {});
      store.defer("t3", "/s/b", {});
      store.clearBySession("/s/a");
      expect(store.query("t1")).toBeNull();
      expect(store.query("t2")).toBeNull();
      expect(store.query("t3")).not.toBeNull();
    });

    it("clears pending tasks by resolved sessionId after the legacy path moves", () => {
      const resolvingStore = new (DeferredResultStore as any)(mockBus, null, {
        getSessionIdForPath: (sessionPath: string) => (
          sessionPath === "/s/old.jsonl" || sessionPath === "/s/moved.jsonl"
            ? "sess_deferred_resolved"
            : null
        ),
      });

      resolvingStore.defer("t1", "/s/old.jsonl", {});
      resolvingStore.defer("t2", "/s/other.jsonl", {});

      expect(resolvingStore.listPending("/s/moved.jsonl").map((task) => task.taskId)).toEqual(["t1"]);
      resolvingStore.clearBySession("/s/moved.jsonl");

      expect(resolvingStore.query("t1")).toBeNull();
      expect(resolvingStore.query("t2")).not.toBeNull();
      resolvingStore.dispose();
    });
  });

  describe("suppressBySession", () => {
    it("aborts pending tasks and marks undelivered terminal tasks as suppressed", () => {
      store.defer("pending", "/s/a", {});
      store.defer("resolved", "/s/a", {});
      store.resolve("resolved", "done");
      store.defer("other", "/s/b", {});

      const result = store.suppressBySession("/s/a", "parent session archived");

      expect(result).toMatchObject({ aborted: 1, suppressed: 1 });
      expect(store.query("pending")).toMatchObject({
        status: "aborted",
        delivered: true,
        deliverySuppressed: true,
        reason: "parent session archived",
      });
      expect(store.query("resolved")).toMatchObject({
        status: "resolved",
        delivered: true,
        deliverySuppressed: true,
      });
      expect(store.query("other")).toMatchObject({
        status: "pending",
        delivered: false,
      });
    });

    it("suppresses by sessionId before legacy path", () => {
      store.defer("pending", {
        sessionId: "sess_deferred",
        sessionPath: "/s/old.jsonl",
      }, {});
      store.defer("other", "/s/new.jsonl", {});

      const result = store.suppressBySession({
        sessionId: "sess_deferred",
        sessionPath: "/s/new.jsonl",
      }, "session archived");

      expect(result).toMatchObject({ aborted: 1, suppressed: 0 });
      expect(store.query("pending")).toMatchObject({
        status: "aborted",
        deliverySuppressed: true,
      });
      expect(store.query("other")).toMatchObject({ status: "pending" });
      expect(store.query("other")).not.toHaveProperty("deliverySuppressed");
    });
  });

  describe("suppressTaskIdsForSession", () => {
    it("fences only named tasks owned by the stable session and can restore a failed commit", () => {
      store.defer("discarded", {
        sessionId: "sess-a",
        sessionPath: "/s/old-a.jsonl",
      }, {});
      store.defer("retained", {
        sessionId: "sess-a",
        sessionPath: "/s/old-a.jsonl",
      }, {});
      store.defer("other-session", {
        sessionId: "sess-b",
        sessionPath: "/s/b.jsonl",
      }, {});

      const result = store.suppressTaskIdsForSession({
        sessionId: "sess-a",
        sessionPath: "/s/new-a.jsonl",
      }, ["discarded", "other-session", "missing"], "retry discarded branch");

      expect(result).toMatchObject({
        suppressedTaskIds: ["discarded"],
        mismatchedTaskIds: ["other-session"],
        missingTaskIds: ["missing"],
      });
      expect(store.query("discarded")).toMatchObject({
        status: "aborted",
        delivered: true,
        deliverySuppressed: true,
      });
      expect(store.query("retained")).toMatchObject({ status: "pending", delivered: false });
      expect(store.query("other-session")).toMatchObject({ status: "pending", delivered: false });

      expect(store.restoreSuppressedTaskIds(result.receipt)).toBe(1);
      expect(store.query("discarded")).toMatchObject({ status: "pending", delivered: false });
      expect(store.query("discarded")).not.toHaveProperty("deliverySuppressed");
    });
  });

  describe("forkTerminalTasks", () => {
    it("clones terminal results under child-owned task and Session identities", () => {
      const resolvingStore = new (DeferredResultStore as any)(mockBus, null, {
        getSessionIdForPath: (sessionPath: string) => ({
          "/s/source.jsonl": "sess-source",
          "/s/child.jsonl": "sess-child",
        })[sessionPath] || null,
      });
      resolvingStore.defer("source-task", {
        sessionId: "sess-source",
        sessionPath: "/s/source.jsonl",
      }, { type: "subagent", threadId: "source-thread" });
      resolvingStore.resolve("source-task", "done");

      expect(resolvingStore.forkTerminalTasks({
        sourceSessionId: "sess-source",
        sourceSessionPath: "/s/source.jsonl",
        targetSessionId: "sess-child",
        targetSessionPath: "/s/child.jsonl",
        taskIdMap: { "source-task": "child-task" },
      })).toEqual({ tasks: 1, taskIds: ["child-task"] });
      expect(resolvingStore.query("source-task")).toMatchObject({
        sessionId: "sess-source",
        result: "done",
      });
      expect(resolvingStore.query("child-task")).toMatchObject({
        sessionId: "sess-child",
        sessionPath: "/s/child.jsonl",
        status: "resolved",
        result: "done",
        delivered: true,
        meta: { forkedFromTaskId: "source-task" },
      });
      expect(resolvingStore.discardForkedTerminalTasks({
        targetSessionId: "sess-child",
        taskIds: ["child-task"],
      })).toEqual({ discarded: 1 });
      expect(resolvingStore.query("child-task")).toBeNull();
      resolvingStore.dispose();
    });

    it("rejects active tasks without mutating either Session", () => {
      store.defer("pending", {
        sessionId: "sess-source",
        sessionPath: "/s/source.jsonl",
      }, { type: "subagent" });

      expect(() => store.forkTerminalTasks({
        sourceSessionId: "sess-source",
        sourceSessionPath: "/s/source.jsonl",
        targetSessionId: "sess-child",
        targetSessionPath: "/s/child.jsonl",
        taskIdMap: { pending: "child-pending" },
      })).toThrow("active deferred task cannot be cloned");
      expect(store.query("pending")).toMatchObject({ status: "pending", sessionId: "sess-source" });
      expect(store.query("child-pending")).toBeNull();
    });
  });

  describe("unsubscribe", () => {
    it("onResult returns unsubscribe function", () => {
      const cb = vi.fn();
      const unsub = store.onResult(cb);
      store.defer("t1", "/s/a", {});
      unsub();
      store.resolve("t1", {});
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("query unknown task", () => {
    it("returns null for unknown taskId", () => {
      expect(store.query("nonexistent")).toBeNull();
    });
  });
});
