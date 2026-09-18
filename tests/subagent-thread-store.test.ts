import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectReferencedSubagentThreadIds,
  SubagentThreadStore,
  SUBAGENT_THREAD_STORE_VERSION,
} from "../lib/subagent-thread-store.ts";

describe("SubagentThreadStore", () => {
  let tempDir;
  let storePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-subagent-threads-"));
    storePath = path.join(tempDir, "subagent-threads.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("records a direct thread, attaches its child session, then keeps it open for follow-up", () => {
    const store = new SubagentThreadStore(storePath);
    store.beginRun("subagent-1", {
      kind: "direct",
      parentSessionPath: "/parent.jsonl",
      agentId: "hana",
      label: "探索一",
      access: "read",
      summary: "read files",
    });
    store.attachSession("subagent-1", "/child.jsonl");
    store.finishRun("subagent-1", { status: "resolved", summary: "done", close: false });

    expect(store.get("subagent-1")).toMatchObject({
      threadId: "subagent-1",
      kind: "direct",
      status: "open",
      lastRunStatus: "resolved",
      parentSessionPath: "/parent.jsonl",
      agentId: "hana",
      childSessionPath: "/child.jsonl",
      label: "探索一",
      access: "read",
      summary: "done",
      runCount: 1,
    });
    expect(store.get("subagent-1").closedAt).toBeNull();
  });

  it("keeps direct threads open across runs and increments runCount", () => {
    const store = new SubagentThreadStore(storePath);
    const threadId = "subagent-thread-1";

    store.beginRun(threadId, {
      kind: "direct",
      parentSessionPath: "/parent.jsonl",
      agentId: "butter",
      label: "探索一",
      access: "read",
    });
    store.attachSession(threadId, "/child.jsonl");
    store.finishRun(threadId, { status: "resolved", summary: "first", close: false });
    store.beginRun(threadId, {
      kind: "direct",
      parentSessionPath: "/parent.jsonl",
      agentId: "butter",
      label: "探索一",
      access: "read",
    });
    expect(store.get(threadId)).toMatchObject({
      status: "open",
      lastRunStatus: "pending",
      runCount: 2,
    });
    store.finishRun(threadId, { status: "resolved", summary: "second", close: false });

    expect(store.get(threadId)).toMatchObject({
      kind: "direct",
      status: "open",
      lastRunStatus: "resolved",
      childSessionPath: "/child.jsonl",
      label: "探索一",
      access: "read",
      runCount: 2,
    });
    expect(store.get(threadId).closedAt).toBeNull();
  });

  it("persists and reloads thread records with schema version", () => {
    const store = new SubagentThreadStore(storePath);
    store.beginRun("workflow-1::node-1", {
      kind: "workflow_node",
      parentTaskId: "workflow-1",
      nodeId: "node-1",
      parentSessionPath: "/parent.jsonl",
      agentId: "hana",
      label: "探索",
    });
    store.attachSession("workflow-1::node-1", "/child.jsonl");

    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(onDisk.schemaVersion).toBe(SUBAGENT_THREAD_STORE_VERSION);

    const restored = new SubagentThreadStore(storePath);
    expect(restored.get("workflow-1::node-1")).toMatchObject({
      kind: "workflow_node",
      parentTaskId: "workflow-1",
      nodeId: "node-1",
      label: "探索",
      childSessionPath: "/child.jsonl",
    });
  });

  it("attachSession persists childSessionId alongside the child locator", () => {
    const store = new SubagentThreadStore(storePath);
    store.beginRun("workflow-1::node-1", {
      kind: "workflow_node",
      parentSessionId: "sess_parent",
      parentSessionPath: "/parent.jsonl",
    });

    store.attachSession("workflow-1::node-1", "/child-moved.jsonl", {
      childSessionId: "sess_child",
    });

    expect(store.get("workflow-1::node-1")).toMatchObject({
      parentSessionId: "sess_parent",
      parentSessionPath: "/parent.jsonl",
      childSessionId: "sess_child",
      childSessionPath: "/child-moved.jsonl",
    });
  });

  it("removes all threads owned by a parent session", () => {
    const store = new SubagentThreadStore(storePath);
    store.beginRun("a", { kind: "direct", parentSessionPath: "/s/a.jsonl" });
    store.beginRun("b", { kind: "workflow_node", parentSessionPath: "/s/a.jsonl" });
    store.beginRun("c", { kind: "direct", parentSessionPath: "/s/b.jsonl" });

    expect(store.removeBySession("/s/a.jsonl")).toBe(2);
    expect(store.get("a")).toBeNull();
    expect(store.get("b")).toBeNull();
    expect(store.get("c")).toBeTruthy();
  });

  it("rehydrates orphan pending runs as failed without closing direct threads", () => {
    fs.writeFileSync(storePath, JSON.stringify({
      schemaVersion: SUBAGENT_THREAD_STORE_VERSION,
      threads: {
        "subagent-1": {
          threadId: "subagent-1",
          kind: "direct",
          status: "open",
          lastRunStatus: "pending",
          parentSessionPath: "/s/a.jsonl",
          runCount: 1,
          createdAt: "2026-06-01T00:00:00.000Z",
          lastRunAt: "2026-06-01T00:01:00.000Z",
        },
        "workflow-1::node-1": {
          threadId: "workflow-1::node-1",
          kind: "workflow_node",
          status: "open",
          lastRunStatus: "pending",
          parentSessionPath: "/s/a.jsonl",
          runCount: 2,
          createdAt: "2026-06-01T00:00:00.000Z",
          lastRunAt: "2026-06-01T00:02:00.000Z",
        },
      },
    }, null, 2));

    const store = new SubagentThreadStore(storePath);

    expect(store.get("subagent-1")).toMatchObject({
      kind: "direct",
      status: "open",
      lastRunStatus: "failed",
      closedAt: null,
    });
    expect(store.get("workflow-1::node-1")).toMatchObject({
      kind: "workflow_node",
      status: "closed",
      lastRunStatus: "failed",
      closedAt: "2026-06-01T00:02:00.000Z",
    });
  });

  it("normalizes legacy ephemeral/reusable threads to direct and maps instance to label on read", () => {
    fs.writeFileSync(storePath, JSON.stringify({
      schemaVersion: 1,
      threads: {
        "subagent-old": {
          threadId: "subagent-old",
          kind: "ephemeral",
          status: "closed",
          lastRunStatus: "resolved",
          parentSessionPath: "/s/a.jsonl",
        },
        "reusable::/s/a.jsonl::butter::探索": {
          threadId: "reusable::/s/a.jsonl::butter::探索",
          kind: "reusable",
          status: "open",
          lastRunStatus: "resolved",
          parentSessionPath: "/s/a.jsonl",
          instance: "探索",
          reuseKey: "/s/a.jsonl::butter::探索",
        },
      },
    }, null, 2));

    const store = new SubagentThreadStore(storePath);

    expect(store.get("subagent-old")).toMatchObject({
      kind: "direct",
      status: "closed",
    });
    expect(store.get("reusable::/s/a.jsonl::butter::探索")).toMatchObject({
      kind: "direct",
      status: "open",
      label: "探索",
    });
    expect(store.get("reusable::/s/a.jsonl::butter::探索").instance).toBeUndefined();
    expect(store.get("reusable::/s/a.jsonl::butter::探索").reuseKey).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(storePath, "utf8")).schemaVersion).toBe(SUBAGENT_THREAD_STORE_VERSION);
  });

  it("lists open direct threads for one parent session and excludes workflow nodes", () => {
    const store = new SubagentThreadStore(storePath);
    store.beginRun("subagent-a", {
      kind: "direct",
      parentSessionPath: "/s/a.jsonl",
      agentId: "hana",
      agentName: "Hana",
      label: "探索一",
      access: "read",
      summary: "读完生命周期代码",
    });
    store.finishRun("subagent-a", { status: "resolved", summary: "可继续", close: false });
    store.beginRun("subagent-b", {
      kind: "direct",
      parentSessionPath: "/s/b.jsonl",
      agentId: "hana",
      label: "探索一",
      access: "read",
    });
    store.beginRun("workflow-1::node-1", {
      kind: "workflow_node",
      parentSessionPath: "/s/a.jsonl",
      label: "探索",
    });

    expect(store.listOpenDirectBySession("/s/a.jsonl")).toEqual([
      expect.objectContaining({
        threadId: "subagent-a",
        kind: "direct",
        status: "open",
        agentName: "Hana",
        label: "探索一",
        access: "read",
        summary: "可继续",
      }),
    ]);
  });

  it("matches parent session threads by stable session id after the parent path moves", () => {
    const originalPath = "/s/original.jsonl";
    const movedPath = "/s/archived/renamed.jsonl";
    const sessionId = "sess_subagent_threads";
    const store = new SubagentThreadStore(storePath, {
      getSessionIdForPath: (sessionPath: string) => (
        sessionPath === originalPath || sessionPath === movedPath ? sessionId : null
      ),
    });
    store.beginRun("subagent-a", { kind: "direct", parentSessionPath: originalPath });
    store.beginRun("workflow-a", { kind: "workflow_node", parentSessionPath: originalPath });
    store.beginRun("subagent-b", { kind: "direct", parentSessionPath: "/s/other.jsonl" });

    expect(store.listOpenDirectBySession(movedPath).map((thread) => thread.threadId)).toEqual(["subagent-a"]);
    expect(store.removeBySession(movedPath)).toBe(2);
    expect(store.get("subagent-a")).toBeNull();
    expect(store.get("workflow-a")).toBeNull();
    expect(store.get("subagent-b")).toBeTruthy();
  });

  it("closes a direct thread explicitly and rejects closing workflow nodes through direct close", () => {
    const store = new SubagentThreadStore(storePath);
    store.beginRun("subagent-a", { kind: "direct", parentSessionPath: "/s/a.jsonl" });
    store.beginRun("workflow-1::node-1", { kind: "workflow_node", parentSessionPath: "/s/a.jsonl" });

    expect(store.closeDirectThread("subagent-a", { summary: "不用了" })).toMatchObject({
      threadId: "subagent-a",
      status: "closed",
      summary: "不用了",
    });
    expect(store.closeDirectThread("workflow-1::node-1", { summary: "x" })).toBeNull();
  });

  it("serializes work per direct thread without blocking different threads", async () => {
    const store = new SubagentThreadStore(storePath);
    const order = [];
    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });

    const p1 = store.runSerialized("subagent-a", async () => {
      order.push("a1-start");
      await gateA;
      order.push("a1-end");
    });
    const p2 = store.runSerialized("subagent-a", async () => {
      order.push("a2-start");
    });
    const p3 = store.runSerialized("subagent-b", async () => {
      order.push("b-start");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["a1-start", "b-start"]);
    expect(store.isBusy("subagent-a")).toBe(true);

    releaseA();
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual(["a1-start", "b-start", "a1-end", "a2-start"]);
    expect(store.isBusy("subagent-a")).toBe(false);
  });

  it("collects only structured retained thread identities", () => {
    expect(collectReferencedSubagentThreadIds([
      {
        message: {
          content: [
            { type: "toolResult", details: { threadId: "thread-a" } },
            { text: "threadId: fake-text-reference" },
          ],
        },
      },
      { data: { subagentThreadId: "thread-b", nested: { threadId: "thread-a" } } },
      { data: { taskId: "thread-c", runId: "ignored-run" } },
    ])).toEqual(["thread-a", "thread-b", "thread-c"]);
  });

  it("forks only retained open direct threads into independent parent and child identities", async () => {
    const sessionIds = new Map([
      ["/parent/source.jsonl", "sess_source"],
      ["/parent/fork.jsonl", "sess_fork"],
    ]);
    const store = new SubagentThreadStore(storePath, {
      getSessionIdForPath: (sessionPath: string) => sessionIds.get(sessionPath) || null,
    });
    const addThread = (threadId, parentSessionPath, childSessionPath, status = "resolved") => {
      store.beginRun(threadId, {
        kind: "direct",
        parentSessionPath,
        agentId: "butter",
        agentName: "Butter",
        label: threadId,
        access: "read",
      });
      store.attachSession(threadId, childSessionPath, { childSessionId: `sess_${threadId}` });
      store.finishRun(threadId, { status, summary: `${threadId} summary`, close: false });
    };
    addThread("kept", "/parent/source.jsonl", "/children/kept.jsonl");
    addThread("not-retained", "/parent/source.jsonl", "/children/not-retained.jsonl");
    addThread("other-parent", "/parent/other.jsonl", "/children/other.jsonl");
    store.beginRun("closed", { kind: "direct", parentSessionPath: "/parent/source.jsonl" });
    store.attachSession("closed", "/children/closed.jsonl", { childSessionId: "sess_closed" });
    store.closeDirectThread("closed");
    store.beginRun("workflow", { kind: "workflow_node", parentSessionPath: "/parent/source.jsonl" });

    const cloneChildSession = vi.fn(async ({ sourceThread, newThreadId }) => ({
      sessionId: `child_${newThreadId}`,
      sessionPath: `/children/fork/${sourceThread.threadId}.jsonl`,
    }));
    const discardChildSession = vi.fn(async () => undefined);
    const result = await store.forkOpenDirectThreads({
      sourceSessionId: "sess_source",
      sourceSessionPath: "/parent/source.jsonl",
      targetSessionId: "sess_fork",
      targetSessionPath: "/parent/fork.jsonl",
      retainedEntries: [{ details: { threadId: "kept" } }, { threadId: "closed" }, { threadId: "workflow" }],
      createThreadId: () => "kept-fork",
      cloneChildSession,
      discardChildSession,
    });

    expect(cloneChildSession).toHaveBeenCalledOnce();
    expect(result.clones).toEqual([{
      sourceThreadId: "kept",
      newThreadId: "kept-fork",
      sourceChildSessionId: "sess_kept",
      sourceChildSessionPath: "/children/kept.jsonl",
      targetChildSessionId: "child_kept-fork",
      targetChildSessionPath: "/children/fork/kept.jsonl",
    }]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      { threadId: "closed", reason: "not_open_direct" },
      { threadId: "workflow", reason: "not_open_direct" },
    ]));
    expect(store.get("kept")).toMatchObject({
      parentSessionId: "sess_source",
      childSessionPath: "/children/kept.jsonl",
      runCount: 1,
    });
    expect(store.get("kept-fork")).toMatchObject({
      parentSessionId: "sess_fork",
      parentSessionPath: "/parent/fork.jsonl",
      childSessionId: "child_kept-fork",
      childSessionPath: "/children/fork/kept.jsonl",
      forkedFromThreadId: "kept",
      sourceThreadIds: ["kept"],
      label: "kept",
      access: "read",
      summary: "kept summary",
      runCount: 1,
      status: "open",
    });
    expect(store.get("not-retained")).toBeTruthy();
    expect(store.get("other-parent")).toBeTruthy();
  });

  it("resolves a historical thread id to different records inside source and fork parent scopes", async () => {
    const sessionIds = new Map([
      ["/source.jsonl", "sess_source"],
      ["/fork.jsonl", "sess_fork"],
    ]);
    const store = new SubagentThreadStore(storePath, {
      getSessionIdForPath: (sessionPath: string) => sessionIds.get(sessionPath) || null,
    });
    store.beginRun("original", { kind: "direct", parentSessionPath: "/source.jsonl" });
    store.attachSession("original", "/children/original.jsonl", { childSessionId: "sess_child_source" });
    store.finishRun("original", { status: "resolved", close: false });

    await store.forkOpenDirectThreads({
      sourceSessionId: "sess_source",
      sourceSessionPath: "/source.jsonl",
      targetSessionId: "sess_fork",
      targetSessionPath: "/fork.jsonl",
      retainedEntries: [{ threadId: "original" }],
      createThreadId: () => "fork-clone",
      cloneChildSession: async () => ({ sessionId: "sess_child_fork", sessionPath: "/children/fork.jsonl" }),
      discardChildSession: async () => undefined,
    });

    expect(store.resolveDirectThreadForSession("original", "/source.jsonl")).toMatchObject({
      threadId: "original",
      childSessionPath: "/children/original.jsonl",
    });
    expect(store.resolveDirectThreadForSession("original", "/fork.jsonl")).toMatchObject({
      threadId: "fork-clone",
      childSessionPath: "/children/fork.jsonl",
    });
    expect(store.resolveDirectThreadForSession("fork-clone", "/source.jsonl")).toBeNull();

    const restored = new SubagentThreadStore(storePath, {
      getSessionIdForPath: (sessionPath: string) => sessionIds.get(sessionPath) || null,
    });
    expect(restored.resolveDirectThreadForSession("original", "/fork.jsonl")).toMatchObject({
      threadId: "fork-clone",
      sourceThreadIds: ["original"],
    });
  });

  it("rejects a retained busy thread before cloning any child state", async () => {
    const store = new SubagentThreadStore(storePath);
    store.beginRun("busy", { kind: "direct", parentSessionPath: "/source.jsonl" });
    store.attachSession("busy", "/children/busy.jsonl", { childSessionId: "sess_busy" });
    store.runSerialized("busy", () => new Promise(() => {}));
    const cloneChildSession = vi.fn();

    await expect(store.forkOpenDirectThreads({
      sourceSessionPath: "/source.jsonl",
      targetSessionId: "sess_fork",
      targetSessionPath: "/fork.jsonl",
      retainedEntries: [{ threadId: "busy" }],
      cloneChildSession,
      discardChildSession: vi.fn(),
    })).rejects.toMatchObject({ code: "subagent_thread_busy", threadId: "busy" });
    expect(cloneChildSession).not.toHaveBeenCalled();
  });

  it("rolls back earlier cloned records and child sessions when a later clone fails", async () => {
    const store = new SubagentThreadStore(storePath);
    for (const threadId of ["first", "second"]) {
      store.beginRun(threadId, { kind: "direct", parentSessionPath: "/source.jsonl" });
      store.attachSession(threadId, `/children/${threadId}.jsonl`, { childSessionId: `sess_${threadId}` });
      store.finishRun(threadId, { status: "resolved", close: false });
    }
    const discardChildSession = vi.fn(async () => undefined);
    let index = 0;
    const forkPromise = store.forkOpenDirectThreads({
      sourceSessionPath: "/source.jsonl",
      targetSessionId: "sess_fork",
      targetSessionPath: "/fork.jsonl",
      retainedEntries: [{ threadId: "first" }, { threadId: "second" }],
      createThreadId: (source) => `${source.threadId}-fork`,
      cloneChildSession: async ({ sourceThread }) => {
        index += 1;
        if (index === 2) throw new Error("second clone failed");
        return { sessionId: `child_${sourceThread.threadId}`, sessionPath: `/fork/${sourceThread.threadId}.jsonl` };
      },
      discardChildSession,
    });

    await expect(forkPromise).rejects.toMatchObject({
      message: "second clone failed",
      subagentThreadForkCleanup: {
        clones: [expect.objectContaining({ newThreadId: "first-fork" })],
        cleanupFailures: [],
      },
    });
    expect(discardChildSession).toHaveBeenCalledWith(expect.objectContaining({
      newThreadId: "first-fork",
      targetChildSessionPath: "/fork/first.jsonl",
    }));
    expect(store.get("first-fork")).toBeNull();
    expect(store.get("second-fork")).toBeNull();
    expect(store.get("first")).toBeTruthy();
    expect(store.get("second")).toBeTruthy();
  });

  it("cleans a callback-reported partial child SessionRef after clone failure", async () => {
    const store = new SubagentThreadStore(storePath);
    store.beginRun("source", { kind: "direct", parentSessionPath: "/source.jsonl" });
    store.attachSession("source", "/children/source.jsonl", { childSessionId: "sess_child_source" });
    store.finishRun("source", { status: "resolved", close: false });
    const discardChildSession = vi.fn(async () => undefined);
    const cloneError: any = new Error("sidecar clone failed");
    cloneError.createdSessionRef = {
      sessionId: "sess_partial_child",
      sessionPath: "/children/partial.jsonl",
    };

    await expect(store.forkOpenDirectThreads({
      sourceSessionPath: "/source.jsonl",
      targetSessionId: "sess_fork",
      targetSessionPath: "/fork.jsonl",
      retainedEntries: [{ taskId: "source" }],
      createThreadId: () => "partial-clone",
      cloneChildSession: async () => { throw cloneError; },
      discardChildSession,
    })).rejects.toMatchObject({
      subagentThreadForkCleanup: {
        clones: [expect.objectContaining({
          newThreadId: "partial-clone",
          targetChildSessionId: "sess_partial_child",
          targetChildSessionPath: "/children/partial.jsonl",
        })],
        cleanupFailures: [],
      },
    });
    expect(discardChildSession).toHaveBeenCalledOnce();
    expect(store.get("partial-clone")).toBeNull();
    expect(store.get("source")).toBeTruthy();
  });

  it("discards only fork-owned thread records and delegates cloned child cleanup", async () => {
    const store = new SubagentThreadStore(storePath);
    store.beginRun("source", { kind: "direct", parentSessionPath: "/source.jsonl" });
    store.attachSession("source", "/children/source.jsonl", { childSessionId: "sess_child_source" });
    store.finishRun("source", { status: "resolved", close: false });
    await store.forkOpenDirectThreads({
      sourceSessionPath: "/source.jsonl",
      targetSessionId: "sess_fork",
      targetSessionPath: "/fork.jsonl",
      retainedEntries: [{ threadId: "source" }],
      createThreadId: () => "fork-clone",
      cloneChildSession: async () => ({ sessionId: "sess_child_fork", sessionPath: "/children/fork.jsonl" }),
      discardChildSession: async () => undefined,
    });
    const discardChildSession = vi.fn(async () => undefined);

    const result = await store.discardForkedDirectThreads(
      { sessionId: "sess_fork", sessionPath: "/fork.jsonl" },
      { discardChildSession },
    );

    expect(result).toMatchObject({ removed: 1, cleanupFailures: [] });
    expect(discardChildSession).toHaveBeenCalledWith(expect.objectContaining({
      newThreadId: "fork-clone",
      targetChildSessionId: "sess_child_fork",
      targetChildSessionPath: "/children/fork.jsonl",
    }));
    expect(store.get("fork-clone")).toBeNull();
    expect(store.get("source")).toBeTruthy();
  });
});
