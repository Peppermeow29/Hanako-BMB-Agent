import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  collectRetainedSubagentTaskIds,
  collectRetainedWorkflowTaskIds,
  rewriteForkedSubagentRunReferences,
  rewriteForkedWorkflowRunReferences,
  SubagentRunStore,
} from "../lib/subagent-run-store.ts";

describe("SubagentRunStore", () => {
  let tempDir;
  let storePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-subagent-runs-"));
    storePath = path.join(tempDir, "subagent-runs.json");
  });

  it("persists taskId to child session mapping independently of deferred delivery state", () => {
    const store = new SubagentRunStore(storePath);

    store.register("subagent-1", {
      parentSessionPath: "/agents/hana/sessions/parent.jsonl",
      summary: "校准脚本",
      requestedAgentId: "hanako",
      requestedAgentNameSnapshot: "小花",
    });
    store.attachSession("subagent-1", "/agents/hana/subagent-sessions/child.jsonl", {
      executorAgentId: "hanako",
      executorAgentNameSnapshot: "小花",
      executorMetaVersion: 1,
    });
    store.resolve("subagent-1", "完成摘要");

    const restored = new SubagentRunStore(storePath);
    expect(restored.query("subagent-1")).toMatchObject({
      taskId: "subagent-1",
      parentSessionPath: "/agents/hana/sessions/parent.jsonl",
      childSessionPath: "/agents/hana/subagent-sessions/child.jsonl",
      status: "resolved",
      summary: "完成摘要",
      requestedAgentId: "hanako",
      executorAgentId: "hanako",
      executorAgentNameSnapshot: "小花",
    });
  });

  it("aborts pending runs registered under a parent session path", () => {
    const store = new SubagentRunStore(storePath);
    store.register("subagent-1", { parentSessionPath: "/agents/hana/sessions/a.jsonl" });
    store.register("subagent-2", { parentSessionPath: "/agents/hana/sessions/b.jsonl" });
    store.register("subagent-3", { parentSessionPath: "/agents/hana/sessions/a.jsonl" });
    store.resolve("subagent-3", "done");

    const result = store.abortByParentSession("/agents/hana/sessions/a.jsonl", "parent session archived");

    expect(result).toMatchObject({ aborted: 1, skippedFinal: 1 });
    expect(store.query("subagent-1")).toMatchObject({
      status: "aborted",
      reason: "parent session archived",
    });
    expect(store.query("subagent-2")).toMatchObject({ status: "pending" });
    expect(store.query("subagent-3")).toMatchObject({ status: "resolved" });
  });

  it("aborts pending runs by stable parent session id after the parent path moves", () => {
    const originalPath = "/agents/hana/sessions/original.jsonl";
    const movedPath = "/agents/hana/sessions/archived/renamed.jsonl";
    const sessionId = "sess_subagent_runs";
    const store = new SubagentRunStore(storePath, {
      getSessionIdForPath: (sessionPath: string) => (
        sessionPath === originalPath || sessionPath === movedPath ? sessionId : null
      ),
    });
    store.register("subagent-1", { parentSessionPath: originalPath });
    store.register("subagent-2", { parentSessionPath: "/agents/hana/sessions/other.jsonl" });

    const result = store.abortByParentSession(movedPath, "parent session archived");

    expect(result).toMatchObject({ matched: 1, aborted: 1 });
    expect(store.query("subagent-1")).toMatchObject({
      status: "aborted",
      parentSessionId: sessionId,
      reason: "parent session archived",
    });
    expect(store.query("subagent-2")).toMatchObject({ status: "pending" });
  });

  it("attachSession persists childSessionId alongside the child locator", () => {
    const store = new SubagentRunStore(storePath);
    store.register("workflow-1::node-1", {
      parentSessionId: "sess_parent",
      parentSessionPath: "/agents/hana/sessions/parent.jsonl",
    });

    store.attachSession("workflow-1::node-1", "/agents/hana/subagent-sessions/child-moved.jsonl", {
      childSessionId: "sess_child",
    });

    expect(store.query("workflow-1::node-1")).toMatchObject({
      parentSessionId: "sess_parent",
      parentSessionPath: "/agents/hana/sessions/parent.jsonl",
      childSessionId: "sess_child",
      childSessionPath: "/agents/hana/subagent-sessions/child-moved.jsonl",
    });
  });

  it("collects only structured subagent run identities from retained entries", () => {
    expect(collectRetainedSubagentTaskIds([
      {
        role: "toolResult",
        toolName: "subagent",
        details: { taskId: "run-initial", threadId: "run-initial" },
      },
      {
        role: "toolResult",
        toolName: "subagent_reply",
        details: { taskId: "run-reply", threadId: "run-initial" },
      },
      { type: "subagent", taskId: "run-card" },
      {
        role: "custom",
        customType: "hana-deferred-result",
        data: {
          type: "subagent",
          taskId: "run-deferred",
          result: { taskId: "run-payload" },
        },
      },
      {
        role: "custom",
        customType: "hana-background-result",
        content: '<hana-background-result task-id="run-message" status="success" type="subagent">done</hana-background-result>',
      },
      { role: "assistant", content: "taskId: run-from-text", taskId: "run-untyped" },
      { type: "media_generation", taskId: "run-media" },
      { type: "workflow", taskId: "run-workflow", nested: { type: "subagent", taskId: "run-workflow-child" } },
      {
        role: "custom",
        customType: "hana-background-result",
        content: '<hana-background-result task-id="run-media-result" status="success" type="image-generation">done</hana-background-result>',
      },
    ])).toEqual([
      "run-initial",
      "run-reply",
      "run-card",
      "run-deferred",
      "run-message",
    ]);
  });

  it("collects and rewrites only typed workflow run identities", () => {
    const entries: any[] = [
      { type: "workflow", taskId: "workflow-source", runId: "workflow-source", nested: { taskId: "workflow-source" } },
      {
        role: "custom",
        customType: "hana-background-result",
        content: '<hana-background-result task-id="workflow-source" status="success" type="workflow">done</hana-background-result>',
      },
      { type: "subagent", taskId: "workflow-source" },
      { type: "media_generation", taskId: "workflow-source" },
    ];
    expect(collectRetainedWorkflowTaskIds(entries)).toEqual(["workflow-source"]);

    const rewritten: any = rewriteForkedWorkflowRunReferences(entries, {
      taskIdMap: { "workflow-source": "workflow-target" },
    });
    expect(rewritten[0]).toMatchObject({
      type: "workflow",
      taskId: "workflow-target",
      runId: "workflow-target",
      nested: { taskId: "workflow-target" },
    });
    expect(rewritten[1].content).toContain('task-id="workflow-target"');
    expect(rewritten[2].taskId).toBe("workflow-source");
    expect(rewritten[3].taskId).toBe("workflow-source");
  });

  it("forks retained source-owned terminal runs onto cloned thread and child identities", () => {
    const idsByPath = new Map([
      ["/parents/source.jsonl", "sess_source"],
      ["/parents/fork.jsonl", "sess_fork"],
    ]);
    const store = new SubagentRunStore(storePath, {
      getSessionIdForPath: (sessionPath: string) => idsByPath.get(sessionPath) || null,
    });
    const addTerminal = (taskId, threadId, parentSessionPath, status = "resolved") => {
      store.register(taskId, {
        parentSessionPath,
        threadId,
        threadKind: "direct",
        summary: `${taskId} summary`,
      });
      store.attachSession(taskId, "/children/source.jsonl", {
        childSessionId: "sess_child_source",
        childLeafEntryId: `leaf-${taskId}`,
      });
      store.upsert(taskId, {
        status,
        ...(status === "failed" ? { reason: `${taskId} failed` } : {}),
      });
    };
    addTerminal("thread-a", "thread-a", "/parents/source.jsonl");
    addTerminal("run-a-2", "thread-a", "/parents/source.jsonl", "failed");
    addTerminal("tail-run", "thread-a", "/parents/source.jsonl");
    addTerminal("foreign-run", "thread-a", "/parents/other.jsonl");

    const result = store.forkSessionRuns({
      sourceSessionId: "sess_source",
      sourceSessionPath: "/parents/source.jsonl",
      targetSessionId: "sess_fork",
      targetSessionPath: "/parents/fork.jsonl",
      retainedEntries: [
        { role: "toolResult", toolName: "subagent", details: { taskId: "thread-a" } },
        { role: "toolResult", toolName: "subagent_reply", details: { taskId: "run-a-2" } },
        { type: "subagent", taskId: "foreign-run" },
      ],
      threadClones: [{
        sourceThreadId: "thread-a",
        newThreadId: "thread-a-fork",
        sourceChildSessionId: "sess_child_source",
        sourceChildSessionPath: "/children/source.jsonl",
        targetChildSessionId: "sess_child_fork",
        targetChildSessionPath: "/children/fork.jsonl",
      }],
      createTaskId: () => "run-a-2-fork",
    });

    expect(result).toMatchObject({
      runs: 2,
      taskIds: ["thread-a-fork", "run-a-2-fork"],
      taskIdMap: {
        "thread-a": "thread-a-fork",
        "run-a-2": "run-a-2-fork",
      },
      threadIdMap: { "thread-a": "thread-a-fork" },
      skipped: [{ taskId: "foreign-run", reason: "ownership_mismatch" }],
    });
    expect(store.query("thread-a-fork")).toMatchObject({
      taskId: "thread-a-fork",
      status: "resolved",
      parentSessionId: "sess_fork",
      parentSessionPath: "/parents/fork.jsonl",
      childSessionId: "sess_child_fork",
      childSessionPath: "/children/fork.jsonl",
      childLeafEntryId: "leaf-thread-a",
      threadId: "thread-a-fork",
      forkedFromTaskId: "thread-a",
      forkedFromThreadId: "thread-a",
      sourceTaskIds: ["thread-a"],
    });
    expect(store.query("run-a-2-fork")).toMatchObject({
      status: "failed",
      reason: "run-a-2 failed",
      threadId: "thread-a-fork",
      forkedFromTaskId: "run-a-2",
    });
    expect(store.query("thread-a")).toMatchObject({
      parentSessionId: "sess_source",
      childSessionId: "sess_child_source",
      threadId: "thread-a",
    });
    expect(store.query("tail-run")).toBeTruthy();
    expect(store.query("tail-run-fork")).toBeNull();

    const restored = new SubagentRunStore(storePath, {
      getSessionIdForPath: (sessionPath: string) => idsByPath.get(sessionPath) || null,
    });
    expect(restored.query("run-a-2-fork")).toMatchObject({
      parentSessionId: "sess_fork",
      childSessionId: "sess_child_fork",
      forkedFromTaskId: "run-a-2",
    });
  });

  it("forks retained terminal workflow runs without sharing source task identity", () => {
    const sourcePath = "/agents/hana/sessions/source.jsonl";
    const targetPath = "/agents/hana/sessions/target.jsonl";
    const store = new SubagentRunStore(storePath, {
      getSessionIdForPath: (sessionPath: string) => (
        sessionPath === sourcePath ? "source-session"
          : sessionPath === targetPath ? "target-session"
            : null
      ),
    });
    store.register("workflow-source", {
      parentSessionId: "source-session",
      parentSessionPath: sourcePath,
      summary: "workflow result",
    });
    store.resolve("workflow-source", "workflow result");

    const result = store.forkSessionWorkflowRuns({
      sourceSessionId: "source-session",
      sourceSessionPath: sourcePath,
      targetSessionId: "target-session",
      targetSessionPath: targetPath,
      retainedEntries: [{ type: "workflow", taskId: "workflow-source" }],
      createTaskId: () => "workflow-target",
    });

    expect(result.taskIdMap).toEqual({ "workflow-source": "workflow-target" });
    expect(store.query("workflow-target")).toMatchObject({
      status: "resolved",
      parentSessionId: "target-session",
      parentSessionPath: targetPath,
      summary: "workflow result",
      forkedFromTaskId: "workflow-source",
      childSessionId: null,
      childSessionPath: null,
      threadId: null,
    });
    expect(store.query("workflow-source")).toMatchObject({
      parentSessionId: "source-session",
      forkedFromTaskId: null,
    });
  });

  it("rejects a retained active source run with 409 before creating fork records", () => {
    const store = new SubagentRunStore(storePath);
    store.register("thread-active", {
      parentSessionId: "sess_source",
      parentSessionPath: "/source.jsonl",
      threadId: "thread-active",
      childSessionId: "sess_child_source",
      childSessionPath: "/children/source.jsonl",
    });

    expect(() => store.forkSessionRuns({
      sourceSessionId: "sess_source",
      sourceSessionPath: "/source.jsonl",
      targetSessionId: "sess_fork",
      targetSessionPath: "/fork.jsonl",
      retainedEntries: [{ type: "subagent", taskId: "thread-active" }],
      threadClones: [{
        sourceThreadId: "thread-active",
        newThreadId: "thread-active-fork",
        targetChildSessionId: "sess_child_fork",
        targetChildSessionPath: "/children/fork.jsonl",
      }],
    })).toThrow(expect.objectContaining({
      code: "subagent_run_busy",
      status: 409,
      taskId: "thread-active",
    }));
    expect(store.query("thread-active-fork")).toBeNull();
    expect(store.size).toBe(1);
  });

  it("rolls back fork records when persistence fails", () => {
    const store = new SubagentRunStore(storePath);
    store.register("thread-source", {
      parentSessionId: "sess_source",
      parentSessionPath: "/source.jsonl",
      threadId: "thread-source",
      childSessionId: "sess_child_source",
      childSessionPath: "/children/source.jsonl",
    });
    store.resolve("thread-source", "done");
    const realSave = (store as any)._save.bind(store);
    let saveCalls = 0;
    (store as any)._save = () => {
      saveCalls += 1;
      if (saveCalls === 1) throw new Error("persist failed");
      return realSave();
    };

    expect(() => store.forkSessionRuns({
      sourceSessionId: "sess_source",
      sourceSessionPath: "/source.jsonl",
      targetSessionId: "sess_fork",
      targetSessionPath: "/fork.jsonl",
      retainedEntries: [{ type: "subagent", taskId: "thread-source" }],
      threadClones: [{
        sourceThreadId: "thread-source",
        newThreadId: "thread-fork",
        targetChildSessionId: "sess_child_fork",
        targetChildSessionPath: "/children/fork.jsonl",
      }],
    })).toThrow("persist failed");
    expect(store.query("thread-fork")).toBeNull();
    expect(store.query("thread-source")).toMatchObject({ status: "resolved" });

    const restored = new SubagentRunStore(storePath);
    expect(restored.query("thread-fork")).toBeNull();
    expect(restored.query("thread-source")).toMatchObject({ status: "resolved" });
  });

  it("discards only fork-owned runs under the target Session", () => {
    const store = new SubagentRunStore(storePath);
    store.register("source-thread", {
      parentSessionId: "sess_source",
      parentSessionPath: "/source.jsonl",
      threadId: "source-thread",
    });
    store.attachSession("source-thread", "/children/source.jsonl", { childSessionId: "sess_child_source" });
    store.resolve("source-thread", "done");
    const forked = store.forkSessionRuns({
      sourceSessionId: "sess_source",
      sourceSessionPath: "/source.jsonl",
      targetSessionId: "sess_fork",
      targetSessionPath: "/fork.jsonl",
      retainedEntries: [{ type: "subagent", taskId: "source-thread" }],
      threadClones: [{
        sourceThreadId: "source-thread",
        newThreadId: "fork-thread",
        targetChildSessionId: "sess_child_fork",
        targetChildSessionPath: "/children/fork.jsonl",
      }],
    });

    const result = store.discardForkedSessionRuns({
      targetSessionId: "sess_fork",
      targetSessionPath: "/fork.jsonl",
      taskIds: ["source-thread", ...forked.taskIds],
    });

    expect(result).toEqual({ discarded: 1, skipped: ["source-thread"] });
    expect(store.query("fork-thread")).toBeNull();
    expect(store.query("source-thread")).toMatchObject({ status: "resolved" });
  });

  it("rewrites typed subagent identities without touching text, media, or workflow domains", () => {
    const source = [{
      role: "toolResult",
      toolName: "subagent_reply",
      details: {
        taskId: "run-source",
        parentTaskId: "run-parent",
        threadId: "thread-source",
        subagentThreadId: "thread-source",
        sessionId: "sess_child_source",
        childSessionId: "sess_child_source",
        sessionPath: "/children/source.jsonl",
        childSessionPath: "/children/source.jsonl",
        streamKey: "/children/source.jsonl",
        note: "run-source thread-source /children/source.jsonl",
      },
    }, {
      type: "toolCall",
      name: "subagent_reply",
      arguments: { threadId: "thread-source", task: "mention run-source literally" },
    }, {
      role: "custom",
      customType: "hana-deferred-result",
      data: { type: "subagent", taskId: "run-source", result: "run-source stays in result text" },
    }, {
      role: "custom",
      customType: "hana-background-result",
      content: '<hana-background-result task-id="run-source" status="success" type="subagent">run-source stays in body</hana-background-result>',
      details: { taskId: "run-source" },
    }, {
      type: "interlude",
      variant: "deferred_result",
      taskId: "run-source",
    }, {
      role: "assistant",
      content: "run-source thread-source /children/source.jsonl",
      taskId: "run-source",
    }, {
      type: "media_generation",
      taskId: "run-source",
      sessionId: "sess_child_source",
    }, {
      type: "workflow",
      taskId: "run-source",
      threadId: "thread-source",
      nested: { type: "subagent", taskId: "run-source" },
    }, {
      role: "custom",
      customType: "hana-background-result",
      content: '<hana-background-result task-id="run-source" status="success" type="image-generation">image</hana-background-result>',
    }];

    const rewritten: any = rewriteForkedSubagentRunReferences(source, {
      taskIdMap: {
        "run-source": "run-fork",
        "run-parent": "run-parent-fork",
      },
      threadClones: [{
        sourceThreadId: "thread-source",
        newThreadId: "thread-fork",
        sourceChildSessionId: "sess_child_source",
        sourceChildSessionPath: "/children/source.jsonl",
        targetChildSessionId: "sess_child_fork",
        targetChildSessionPath: "/children/fork.jsonl",
      }],
    });

    expect(rewritten[0].details).toMatchObject({
      taskId: "run-fork",
      parentTaskId: "run-parent-fork",
      threadId: "thread-fork",
      subagentThreadId: "thread-fork",
      sessionId: "sess_child_fork",
      childSessionId: "sess_child_fork",
      sessionPath: "/children/fork.jsonl",
      childSessionPath: "/children/fork.jsonl",
      streamKey: "/children/fork.jsonl",
      note: "run-source thread-source /children/source.jsonl",
    });
    expect(rewritten[1]).toMatchObject({
      arguments: { threadId: "thread-fork", task: "mention run-source literally" },
    });
    expect(rewritten[2].data).toEqual({
      type: "subagent",
      taskId: "run-fork",
      result: "run-source stays in result text",
    });
    expect(rewritten[3].content).toContain('task-id="run-fork"');
    expect(rewritten[3].content).toContain("run-source stays in body");
    expect(rewritten[3].details.taskId).toBe("run-fork");
    expect(rewritten[4].taskId).toBe("run-fork");
    expect(rewritten[5]).toEqual(source[5]);
    expect(rewritten[6]).toEqual(source[6]);
    expect(rewritten[7]).toEqual(source[7]);
    expect(rewritten[8]).toEqual(source[8]);
    expect(source[0].details.taskId).toBe("run-source");
  });
});
