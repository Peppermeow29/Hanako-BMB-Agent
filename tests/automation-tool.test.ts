import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAutomationTool } from "../lib/tools/automation-tool.ts";
import { buildBridgeContext } from "../lib/bridge/bridge-context.ts";

const AGENT_SESSION_PATH = path.resolve("/sessions/agent-a.jsonl");
const LEGACY_SESSION_PATH = path.resolve("/sessions/legacy.jsonl");

function makeStore(initialJobs: any[] = [], id = "studio_job_1") {
  const jobs = initialJobs.map((job) => ({
    studioId: "studio-a",
    configRevision: 1,
    ...job,
  }));
  const store: any = {
    studioId: "studio-a",
    addJob: vi.fn((jobData, _options?: any) => ({ ...jobData, id, enabled: true })),
    updateJob: vi.fn((jobId, fields, _options?: any) => ({ ...jobs.find((job) => job.id === jobId), ...fields, id: jobId })),
    getJob: vi.fn((jobId) => jobs.find((job) => job.id === jobId) || null),
    listJobs: vi.fn(() => jobs),
  };
  return store;
}

function makeSuggestionStore(id = "automation_suggestion_1", shortCode = "3827") {
  const created: any[] = [];
  const store = {
    create: vi.fn((entry) => {
      const suggestion = { ...entry, suggestionId: id, shortCode };
      created.push(suggestion);
      return suggestion;
    }),
  };
  return { store, created };
}

describe("automation tool", () => {
  it("creates generic Agent-run automation suggestions by default", async () => {
    const store = makeStore();
    const { store: suggestionStore } = makeSuggestionStore();
    const confirmStore = { create: vi.fn() };
    const tool = createAutomationTool(store, {
      confirmStore,
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => ["/workspace/ref"],
      getHomeCwd: (agentId: string) => `/home/${agentId}`,
    });

    const result = await tool.execute(
      "call_1",
      {
        action: "create",
        agentId: "agent-b",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        label: "Morning Review",
        prompt: "Review my notes and send a short summary.",
      },
      undefined,
      undefined,
      {
        sessionId: "session-a",
        sessionManager: {
          getSessionFile: () => AGENT_SESSION_PATH,
          getCwd: () => "/workspace/current",
        },
        bridgeContext: {
          isBridgeSession: true,
          sessionKey: "wechat_dm_owner@agent-a",
          platform: "wechat",
        },
      },
    );

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(suggestionStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-a",
        sessionPath: AGENT_SESSION_PATH,
        bridgeSessionKey: "wechat_dm_owner@agent-a",
        operation: "create",
        jobData: expect.objectContaining({
          label: "Morning Review",
          actorAgentId: "agent-b",
          executionContext: expect.objectContaining({
            notificationContext: {
              bridgeDeliveryTarget: {
                kind: "bridge",
                platform: "wechat",
                chatType: "dm",
                chatId: "owner",
                sessionKey: "wechat_dm_owner@agent-a",
                agentId: "agent-a",
              },
            },
          }),
        }),
        apply: expect.any(Function),
      }),
    );
    expect(result.details).toMatchObject({
      action: "pending_add",
      operation: "create",
      suggestionId: "automation_suggestion_1",
      suggestionShortCode: "3827",
      automationSuggestion: {
        suggestionId: "automation_suggestion_1",
        shortCode: "3827",
        operation: "create",
      },
    });
    expect("confirmId" in result.details).toBe(false);
    expect(result.content[0].text).not.toContain("/confirm");
    expect(store.addJob).not.toHaveBeenCalled();
  });

  it("issues reply-based /apply guidance on text-command bridge platforms (#1619)", async () => {
    const store = makeStore();
    const { store: suggestionStore } = makeSuggestionStore("automation_suggestion_wx", "3827");
    const tool = createAutomationTool(store, {
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
      getHomeCwd: (agentId: string) => `/home/${agentId}`,
    });

    const result = await tool.execute(
      "call_wechat",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        label: "Morning Review",
        prompt: "Review my notes.",
      },
      undefined,
      undefined,
      {
        sessionManager: { getSessionFile: () => AGENT_SESSION_PATH },
        bridgeContext: buildBridgeContext({
          sessionKey: "wx_dm_owner@agent-a",
          role: "owner",
        }, "zh"),
      },
    );

    const text = result.content[0].text;
    // Agent 必须知道：纯文本平台、确认协议是回复 /apply（含建议ID 精确形式）
    expect(text).toContain("/apply");
    expect(text).toContain("3827");
    expect(text).toContain("没有可点击");
    // 禁止桌面交互式指令措辞，也不再用语义模糊的"等你确认"
    expect(text).not.toMatch(/请点击|点击确认|点击按钮|点击卡片/);
    expect(text).not.toContain("等你确认后再创建");
    expect(store.addJob).not.toHaveBeenCalled();
  });

  it("keeps the desktop suggestion copy unchanged outside bridge sessions", async () => {
    const store = makeStore();
    const { store: suggestionStore } = makeSuggestionStore("automation_suggestion_desk", "5120");
    const tool = createAutomationTool(store, {
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
      getHomeCwd: (agentId: string) => `/home/${agentId}`,
    });

    const result = await tool.execute(
      "call_desktop",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        label: "Morning Review",
        prompt: "Review my notes.",
      },
      undefined,
      undefined,
      {
        sessionId: "session-a",
        sessionManager: { getSessionFile: () => AGENT_SESSION_PATH },
      },
    );

    expect(result.content[0].text).toBe("我准备了一项自动任务建议，等你确认后再创建。");
  });

  it("keeps generic suggestion copy when the bridge context declares no interaction capabilities", async () => {
    const store = makeStore();
    const { store: suggestionStore } = makeSuggestionStore("automation_suggestion_legacy", "7045");
    const tool = createAutomationTool(store, {
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
      getHomeCwd: (agentId: string) => `/home/${agentId}`,
    });

    const result = await tool.execute(
      "call_legacy_bridge_ctx",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        label: "Morning Review",
        prompt: "Review my notes.",
      },
      undefined,
      undefined,
      {
        sessionManager: { getSessionFile: () => AGENT_SESSION_PATH },
        // 手工拼的 bridgeContext（无 interactionCapabilities）：能力未声明就不输出文本协议指引
        bridgeContext: { isBridgeSession: true, platform: "wechat", sessionKey: "wechat_dm_owner@agent-a" },
      },
    );

    expect(result.content[0].text).toBe("我准备了一项自动任务建议，等你确认后再创建。");
  });

  it("uses edited suggestion fields when an automation suggestion is applied", async () => {
    const store = makeStore();
    const { store: suggestionStore, created } = makeSuggestionStore("automation_suggestion_2", "4812");
    const tool = createAutomationTool(store, {
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
      getHomeCwd: (agentId: string) => `/home/${agentId}`,
    });

    await tool.execute(
      "call_2",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 10 * * *",
        label: "Reminder",
        prompt: "original prompt",
      },
      undefined,
      undefined,
      {
        sessionId: "session-a",
        sessionManager: { getSessionFile: () => AGENT_SESSION_PATH },
      },
    );

    expect(store.addJob).not.toHaveBeenCalled();

    await created[0].apply({
      jobData: {
        label: "Edited Reminder",
        schedule: "30 10 * * *",
        prompt: "edited agent run prompt",
        targetAgentId: "agent-b",
        actorAgentId: "forged-agent",
        executionContext: {
          kind: "session_workspace",
          cwd: "/forged",
          workspaceFolders: ["/forged"],
          authorizedFolders: ["/forged-secret"],
          sourceSessionId: "forged-session",
          sourceSessionPath: "/forged/session.jsonl",
          createdByAgentId: "forged-agent",
        },
      },
    });

    expect(store.addJob).toHaveBeenCalledWith(expect.objectContaining({
      label: "Edited Reminder",
      schedule: "30 10 * * *",
      prompt: "edited agent run prompt",
      actorAgentId: "agent-b",
      executionContext: {
        kind: "session_workspace",
        cwd: "/home/agent-b",
        workspaceFolders: ["/home/agent-b"],
        authorizedFolders: [],
        sourceSessionId: null,
        sourceBridgeSessionKey: null,
        sourceSessionPath: null,
        createdByAgentId: "agent-b",
        notificationContext: null,
      },
      executor: expect.objectContaining({
        kind: "agent_session",
        agentId: "agent-b",
        prompt: "edited agent run prompt",
      }),
    }));
  });

  it("stores every suggestions in milliseconds before the desktop card applies them", async () => {
    const store = makeStore();
    const { store: suggestionStore, created } = makeSuggestionStore("automation_suggestion_every", "7200");
    const tool = createAutomationTool(store, {
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
      getHomeCwd: (agentId: string) => `/home/${agentId}`,
    });

    const result = await tool.execute(
      "call_every",
      {
        action: "create",
        scheduleType: "every",
        schedule: "120",
        label: "Two hour reminder",
        prompt: "remind me every two hours",
      },
      undefined,
      undefined,
      {
        sessionId: "session-a",
        sessionManager: { getSessionFile: () => AGENT_SESSION_PATH },
      },
    );

    expect(result.details.jobData).toMatchObject({
      type: "every",
      schedule: 7_200_000,
    });

    await created[0].apply();

    expect(store.addJob).toHaveBeenCalledWith(expect.objectContaining({
      type: "every",
      schedule: 7_200_000,
    }));
  });

  it("updates existing automations only after the update suggestion is applied", async () => {
    const existingJob = {
      id: "studio_job_9",
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "old prompt",
      label: "Old automation",
      actorAgentId: "agent-a",
      executionContext: {
        kind: "session_workspace",
        cwd: "/home/agent-a",
        workspaceFolders: [],
        sourceSessionPath: AGENT_SESSION_PATH,
        createdByAgentId: "agent-a",
      },
      executor: {
        kind: "agent_session",
        agentId: "agent-a",
        prompt: "old prompt",
        model: "",
        executionContext: {
          kind: "session_workspace",
          cwd: "/home/agent-a",
          workspaceFolders: [],
          sourceSessionPath: AGENT_SESSION_PATH,
          createdByAgentId: "agent-a",
        },
      },
    };
    const store = makeStore([existingJob]);
    const { store: suggestionStore, created } = makeSuggestionStore("automation_suggestion_update", "9031");
    const tool = createAutomationTool(store, {
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
      getHomeCwd: (agentId: string) => `/home/${agentId}`,
    });

    const result = await tool.execute(
      "call_update",
      {
        action: "update",
        id: "studio_job_9",
        agentId: "agent-b",
        scheduleType: "cron",
        schedule: "30 12 * * *",
        label: "Lunch automation",
        prompt: "new prompt",
      },
      undefined,
      undefined,
      {
        sessionId: "session-a",
        sessionManager: { getSessionFile: () => AGENT_SESSION_PATH },
      },
    );

    expect(result.details).toMatchObject({
      action: "pending_update",
      operation: "update",
      suggestionId: "automation_suggestion_update",
      suggestionShortCode: "9031",
      jobData: expect.objectContaining({
        id: "studio_job_9",
        actorAgentId: "agent-b",
      }),
    });
    expect("confirmId" in result.details).toBe(false);
    expect(store.updateJob).not.toHaveBeenCalled();

    await created[0].apply();

    expect(store.updateJob).toHaveBeenCalledWith("studio_job_9", expect.objectContaining({
      type: "cron",
      schedule: "30 12 * * *",
      label: "Lunch automation",
      prompt: "new prompt",
      actorAgentId: "agent-b",
      executor: expect.objectContaining({
        kind: "agent_session",
        agentId: "agent-b",
        prompt: "new prompt",
      }),
    }));
    expect(store.addJob).not.toHaveBeenCalled();
  });

  it("preserves existing fields when an update suggestion only changes the schedule", async () => {
    const existingJob = {
      id: "studio_job_keep_fields",
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "send the daily note",
      label: "Daily note",
      actorAgentId: "agent-a",
      executionContext: {
        kind: "session_workspace",
        cwd: "/home/agent-a",
        workspaceFolders: [],
        sourceSessionPath: AGENT_SESSION_PATH,
        createdByAgentId: "agent-a",
      },
      executor: {
        kind: "agent_session",
        agentId: "agent-a",
        prompt: "send the daily note",
        model: "",
        executionContext: {
          kind: "session_workspace",
          cwd: "/home/agent-a",
          workspaceFolders: [],
          sourceSessionPath: AGENT_SESSION_PATH,
          createdByAgentId: "agent-a",
        },
      },
    };
    const store = makeStore([existingJob]);
    const { store: suggestionStore, created } = makeSuggestionStore("automation_suggestion_keep", "1204");
    const tool = createAutomationTool(store, {
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
      getHomeCwd: (agentId: string) => `/home/${agentId}`,
    });

    await tool.execute(
      "call_update_keep_fields",
      {
        action: "update",
        id: "studio_job_keep_fields",
        scheduleType: "cron",
        schedule: "30 9 * * *",
      },
      undefined,
      undefined,
      {
        sessionId: "session-a",
        sessionManager: { getSessionFile: () => AGENT_SESSION_PATH },
      },
    );

    await created[0].apply();

    expect(store.updateJob).toHaveBeenCalledWith("studio_job_keep_fields", expect.objectContaining({
      schedule: "30 9 * * *",
      label: "Daily note",
      prompt: "send the daily note",
      actorAgentId: "agent-a",
    }));
  });

  it("falls back to an inline suggestion result when no suggestion store is available", async () => {
    const store = makeStore();
    const tool = createAutomationTool(store, {
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
    });

    const result = await tool.execute(
      "call_inline",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 8 * * *",
        label: "Breakfast",
        prompt: "eat breakfast",
      },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => AGENT_SESSION_PATH } },
    );

    expect(result.details).toMatchObject({
      action: "pending_add",
      suggestionId: "",
      suggestionShortCode: "",
    });
    expect("confirmId" in result.details).toBe(false);
    expect(store.addJob).not.toHaveBeenCalled();
  });

  it("does not retain an apply closure for a path-only session identity", async () => {
    const store = makeStore();
    const { store: suggestionStore } = makeSuggestionStore("automation_path_only", "1001");
    const tool = createAutomationTool(store, {
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
    });

    const result = await tool.execute(
      "call_path_only",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 8 * * *",
        label: "Path only",
        prompt: "must not become confirmable by path",
      },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => LEGACY_SESSION_PATH } },
    );

    expect(suggestionStore.create).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ suggestionId: "", suggestionShortCode: "" });
    expect(store.addJob).not.toHaveBeenCalled();
  });

  it("creates immediately only when auto approve is explicitly enabled", async () => {
    const store = makeStore();
    const { store: suggestionStore } = makeSuggestionStore("automation_suggestion_3", "6001");
    const confirmStore = { create: vi.fn() };
    const tool = createAutomationTool(store, {
      getAutoApprove: () => true,
      confirmStore,
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
    });

    await tool.execute(
      "call_3",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 10 * * *",
        label: "Reminder",
        prompt: "prompt",
      },
      undefined,
      undefined,
      { sessionManager: { getSessionFile: () => AGENT_SESSION_PATH } },
    );

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(suggestionStore.create).not.toHaveBeenCalled();
    expect(store.addJob).toHaveBeenCalledOnce();
    expect(store.addJob.mock.calls[0]).toHaveLength(1);
  });

  it("passes the exact one-shot suggestion receipt when the suggestion is applied", async () => {
    const store = makeStore();
    const { store: suggestionStore, created } = makeSuggestionStore("automation_suggestion_receipt", "4412");
    const tool = createAutomationTool(store, {
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
    });

    const result = await tool.execute(
      "call_receipt",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 10 * * *",
        label: "Scheduled task",
        prompt: "run the task",
      },
      undefined,
      undefined,
      {
        sessionId: "session-a",
        sessionManager: { getSessionFile: () => AGENT_SESSION_PATH },
      },
    );

    expect(result.details).toMatchObject({
      suggestionId: "automation_suggestion_receipt",
      jobData: {
        studioId: "studio-a",
        createdBy: { sourceSessionId: "session-a" },
      },
    });
    expect(store.addJob).not.toHaveBeenCalled();

    const suggestionReceipt = {};
    await created[0].apply({
      jobData: {
        label: "Edited label",
      },
    }, {
      suggestionId: "automation_suggestion_receipt",
      confirmedAt: "2026-07-19T10:30:00.000Z",
      receipt: suggestionReceipt,
    });

    expect(store.addJob).toHaveBeenCalledOnce();
    const committed = store.addJob.mock.calls[0][0];
    expect(committed.label).toBe("Edited label");
    expect(store.addJob.mock.calls[0][1]).toEqual({
      suggestionReceipt,
    });
  });

  it("binds update suggestions to the active Studio and base config revision", async () => {
    const existingJob = {
      id: "studio_job_revision",
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "old prompt",
      actorAgentId: "agent-a",
      configRevision: 7,
    };
    const store = makeStore([existingJob]);
    const { store: suggestionStore, created } = makeSuggestionStore("automation_suggestion_revision", "4413");
    const tool = createAutomationTool(store, {
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
      getSessionWorkspaceFolders: () => [],
    });

    await tool.execute(
      "call_revision",
      {
        action: "update",
        id: existingJob.id,
        scheduleType: "cron",
        schedule: "30 9 * * *",
      },
      undefined,
      undefined,
      {
        sessionId: "session-a",
        sessionManager: { getSessionFile: () => AGENT_SESSION_PATH },
      },
    );

    expect(suggestionStore.create).toHaveBeenCalledWith(expect.objectContaining({
      studioId: "studio-a",
      operation: "update",
      jobId: "studio_job_revision",
      baseConfigRevision: 7,
      sessionId: "session-a",
    }));

    const suggestionReceipt = {};
    await created[0].apply(undefined, {
      suggestionId: "automation_suggestion_revision",
      confirmedAt: "2026-07-19T11:00:00.000Z",
      receipt: suggestionReceipt,
    });

    expect(store.updateJob).toHaveBeenCalledOnce();
    expect(store.updateJob.mock.calls[0][2]).toEqual({
      suggestionReceipt,
    });
    expect(store.updateJob.mock.calls[0][1]).toMatchObject({
      schedule: "30 9 * * *",
    });
  });

  it("only declares create/update as deferred drafts when direct auto approve is disabled", () => {
    const deferredTool = createAutomationTool(makeStore(), {
      getAutoApprove: () => false,
    });
    const directCommitTool = createAutomationTool(makeStore(), {
      getAutoApprove: () => true,
    });

    expect(deferredTool.sessionPermission.describeSideEffect({ action: "create" })).toMatchObject({
      kind: "deferred_mutation_draft",
      commit: "requires_user_confirmation",
      ruleId: "automation-draft-no-write",
    });
    expect(deferredTool.sessionPermission.describeSideEffect({ action: "update" })).toMatchObject({
      kind: "deferred_mutation_draft",
      commit: "requires_user_confirmation",
      ruleId: "automation-draft-no-write",
    });
    expect(deferredTool.sessionPermission.describeSideEffect({ action: "list" })).toBeNull();
    expect(directCommitTool.sessionPermission.describeSideEffect({ action: "create" })).toBeNull();
    expect(deferredTool.sessionPermission.resolveInvocation({ action: "create" })).toMatchObject({
      kind: "routine",
      sideEffect: { kind: "deferred_mutation_draft" },
    });
    expect(directCommitTool.sessionPermission.resolveInvocation({ action: "create" })).toMatchObject({
      kind: "review",
      sideEffect: {
        kind: "automation_configuration_mutation",
        operation: "create",
      },
    });
  });

  it("rejects unknown automation actions", async () => {
    const store = makeStore();
    const tool = createAutomationTool(store, {
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/current",
    });

    const result = await tool.execute(
      "call_4",
      {
        action: "add_file_create",
        scheduleType: "cron",
        schedule: "0 18 * * *",
        relativePath: "notes/today.md",
        content: "# Today\n",
      },
      undefined,
      undefined,
      {},
    );

    expect(result.details).toMatchObject({
      action: "add_file_create",
      error: "unknown automation action: add_file_create",
    });
    expect(store.addJob).not.toHaveBeenCalled();
  });
});
