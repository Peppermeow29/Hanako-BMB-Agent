import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionLocatorKey } from "../core/session-manifest/path-normalizer.ts";

const { createCronSchedulerMock, schedulers } = vi.hoisted(() => ({
  createCronSchedulerMock: vi.fn(),
  schedulers: [],
}));

vi.mock("../lib/desk/cron-scheduler.js", () => ({
  createCronScheduler: createCronSchedulerMock,
}));

vi.mock("../lib/desk/heartbeat.js", () => ({
  HEARTBEAT_ACTIVITY_DIR: ".hana-heartbeat",
  createHeartbeat: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../lib/fresh-compact/daily-scheduler.js", () => ({
  createFreshCompactDailyScheduler: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock("../hub/fresh-compact-maintainer.js", () => ({
  FreshCompactMaintainer: vi.fn().mockImplementation(function () {
    this.runDaily = vi.fn();
  }),
}));

import { Scheduler } from "../hub/scheduler.ts";

describe("Scheduler studio cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    schedulers.length = 0;
    createCronSchedulerMock.mockImplementation((opts) => {
      const scheduler = {
        opts,
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        checkJobs: vi.fn(),
      };
      schedulers.push(scheduler);
      return scheduler;
    });
  });

  it("starts one studio cron scheduler instead of one scheduler per agent directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-scheduler-cron-"));
    try {
      fs.mkdirSync(path.join(root, "agents", "agent-a"), { recursive: true });
      fs.mkdirSync(path.join(root, "agents", "agent-b"), { recursive: true });
      const studioStore = { listJobs: vi.fn(() => []) };
      const engine = {
        agentsDir: path.join(root, "agents"),
        agents: new Map(),
        getStudioCronStore: () => studioStore,
        getHeartbeatMaster: () => false,
      };

      const scheduler = new Scheduler({ hub: { engine, eventBus: { emit: vi.fn() } } });
      scheduler.start();

      expect(createCronSchedulerMock).toHaveBeenCalledTimes(1);
      expect(createCronSchedulerMock.mock.calls[0][0].cronStore).toBe(studioStore);
      expect(schedulers[0].start).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes a studio cron job with its actorAgentId and current stable-session folder scope", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-scheduler-cron-"));
    try {
      const agentsDir = path.join(root, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      fs.mkdirSync(path.join(agentsDir, "agent-b"), { recursive: true });
      const activityStore = { add: vi.fn() };
      const executeIsolated = vi.fn(async () => ({ sessionPath: "", error: null }));
      const sourceSessionPath = path.join(root, "sessions", "b.jsonl");
      fs.mkdirSync(path.dirname(sourceSessionPath), { recursive: true });
      fs.writeFileSync(sourceSessionPath, "", "utf-8");
      const executionContext = {
        kind: "session_workspace",
        cwd: "/workspace/stale",
        workspaceFolders: ["/workspace/stale-ref"],
        authorizedFolders: ["/workspace/revoked"],
        sourceSessionId: "sess-b",
        sourceBridgeSessionKey: null,
        sourceSessionPath: "/sessions/b-old.jsonl",
        createdByAgentId: "agent-b",
        notificationContext: null,
      };
      const engine = {
        agentsDir,
        agents: new Map(),
        getStudioCronStore: () => ({ listJobs: vi.fn(() => []) }),
        getHeartbeatMaster: () => false,
        ensureAgentRuntime: vi.fn(async (agentId) => ({ id: agentId, agentName: agentId })),
        getAgent: vi.fn((agentId) => ({ id: agentId, agentName: agentId })),
        isAgentDeleted: vi.fn(() => false),
        getSessionManifest: vi.fn(() => ({
          sessionId: "sess-b",
          ownerAgentId: "agent-b",
          lifecycle: "active",
          health: "ok",
          currentLocator: {
            type: "jsonl",
            path: sourceSessionPath,
            key: sessionLocatorKey(sourceSessionPath),
          },
        })),
        getSessionIdForPath: vi.fn(() => "sess-b"),
        getSessionFolderScope: vi.fn(() => ({
          cwd: "/workspace/live",
          workspaceFolders: ["/workspace/live-ref"],
          authorizedFolders: ["/workspace/live-authorized"],
        })),
        executeIsolated,
        summarizeActivity: vi.fn(),
        getActivityStore: vi.fn(() => activityStore),
        emitDevLog: vi.fn(),
      };
      const eventBus = { emit: vi.fn() };
      const scheduler = new Scheduler({ hub: { engine, eventBus } });
      scheduler.start();
      const executeJob = createCronSchedulerMock.mock.calls[0][0].executeJob;

      await executeJob({
        studioId: "studio-a",
        id: "studio_job_1",
        configRevision: 3,
        label: "Agent B workspace job",
        prompt: "run in b",
        model: { id: "gpt-test", provider: "openai" },
        actorAgentId: "agent-b",
        executor: {
          kind: "agent_session",
          agentId: "agent-b",
          prompt: "run in b",
          model: { id: "gpt-test", provider: "openai" },
          executionContext,
        },
        executionContext,
      });

      expect(executeIsolated).toHaveBeenCalledWith(
        expect.stringContaining("run in b"),
        expect.objectContaining({
          agentId: "agent-b",
          cwd: "/workspace/live",
          workspaceFolders: ["/workspace/live-ref"],
          authorizedFolders: ["/workspace/live-authorized"],
          parentSessionId: "sess-b",
          parentSessionPath: sourceSessionPath,
          model: { id: "gpt-test", provider: "openai" },
          activityType: "cron",
          permissionContext: {
            surface: "automation",
            automationJob: {
              studioId: "studio-a",
              id: "studio_job_1",
              actorAgentId: "agent-b",
              configRevision: 3,
              executionScopeKey: expect.any(String),
            },
          },
        }),
      );
      expect(activityStore.add).toHaveBeenCalledWith(expect.objectContaining({
        type: "cron",
        agentId: "agent-b",
        label: "Agent B workspace job",
      }));
      expect(eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "activity_update" }),
        null,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes agent_session cron jobs through the executor read model", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-scheduler-cron-"));
    try {
      const agentsDir = path.join(root, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      const activityStore = { add: vi.fn() };
      const executeIsolated = vi.fn(async () => ({ sessionPath: "", error: null }));
      const executionContext = {
        kind: "session_workspace",
        cwd: "/workspace/a",
        workspaceFolders: ["/workspace/ref"],
        authorizedFolders: [],
        sourceSessionId: null,
        sourceBridgeSessionKey: null,
        sourceSessionPath: "/sessions/a.jsonl",
        createdByAgentId: "agent-a",
        notificationContext: null,
      };
      const engine = {
        agentsDir,
        agents: new Map(),
        getStudioCronStore: () => ({ listJobs: vi.fn(() => []) }),
        getHeartbeatMaster: () => false,
        ensureAgentRuntime: vi.fn(async (agentId) => ({ id: agentId, agentName: agentId })),
        getAgent: vi.fn((agentId) => ({ id: agentId, agentName: agentId })),
        isAgentDeleted: vi.fn(() => false),
        getHomeCwd: vi.fn(() => "/home/agent-a"),
        executeIsolated,
        summarizeActivity: vi.fn(),
        getActivityStore: vi.fn(() => activityStore),
        emitDevLog: vi.fn(),
      };
      const eventBus = { emit: vi.fn() };
      const scheduler = new Scheduler({ hub: { engine, eventBus } });
      scheduler.start();
      const executeJob = createCronSchedulerMock.mock.calls[0][0].executeJob;

      await executeJob({
        studioId: "studio-a",
        id: "studio_job_2",
        configRevision: 1,
        label: "Executor job",
        actorAgentId: "agent-a",
        executionContext,
        trigger: { kind: "cron", expression: "0 9 * * *" },
        executor: {
          kind: "agent_session",
          agentId: "agent-a",
          prompt: "run from executor",
          model: { id: "gpt-test", provider: "openai" },
          executionContext,
        },
      });

      expect(executeIsolated).toHaveBeenCalledWith(
        expect.stringContaining("run from executor"),
        expect.objectContaining({
          agentId: "agent-a",
          cwd: "/home/agent-a",
          workspaceFolders: ["/home/agent-a"],
          authorizedFolders: [],
          model: { id: "gpt-test", provider: "openai" },
          activityType: "cron",
        }),
      );
      const executionOptions = (executeIsolated.mock.calls[0] as any[])[1] as any;
      expect(executionOptions.parentSessionId).toBeUndefined();
      expect(executionOptions.parentSessionPath).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the global automation permission mode for background Agent cron runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-scheduler-cron-"));
    try {
      const agentsDir = path.join(root, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      const activityStore = { add: vi.fn() };
      const executeIsolated = vi.fn(async () => ({ sessionPath: "", error: null }));
      const engine = {
        agentsDir,
        agents: new Map(),
        getStudioCronStore: () => ({ listJobs: vi.fn(() => []) }),
        getHeartbeatMaster: () => false,
        getAutomationPermissionMode: vi.fn(() => "read_only"),
        ensureAgentRuntime: vi.fn(async (agentId) => ({ id: agentId, agentName: agentId })),
        getAgent: vi.fn((agentId) => ({ id: agentId, agentName: agentId })),
        isAgentDeleted: vi.fn(() => false),
        executeIsolated,
        summarizeActivity: vi.fn(),
        getActivityStore: vi.fn(() => activityStore),
        emitDevLog: vi.fn(),
      };
      const eventBus = { emit: vi.fn() };
      const scheduler = new Scheduler({ hub: { engine, eventBus } });
      scheduler.start();
      const executeJob = createCronSchedulerMock.mock.calls[0][0].executeJob;

      await executeJob({
        studioId: "studio-a",
        id: "studio_job_auto",
        configRevision: 1,
        label: "Auto permission job",
        prompt: "run with default permission",
        permissionMode: "operate",
        actorAgentId: "agent-a",
        executor: {
          kind: "agent_session",
          agentId: "agent-a",
          prompt: "run with default permission",
          permissionMode: "operate",
        },
        executionContext: {
          kind: "session_workspace",
          cwd: "/workspace/a",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/a.jsonl",
          createdByAgentId: "agent-a",
        },
      });

      expect(engine.getAutomationPermissionMode).toHaveBeenCalledOnce();
      expect(executeIsolated).toHaveBeenCalledWith(
        expect.stringContaining("run with default permission"),
        expect.objectContaining({
          permissionMode: "read_only",
          approvalPolicy: "deny_on_prompt",
          allowHumanApproval: false,
          activityType: "cron",
          permissionContext: {
            surface: "automation",
            automationJob: {
              studioId: "studio-a",
              id: "studio_job_auto",
              actorAgentId: "agent-a",
              configRevision: 1,
              executionScopeKey: expect.any(String),
            },
          },
        }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes the running lock and timeout abort by Studio when job ids collide", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-scheduler-cron-scope-"));
    try {
      const agentsDir = path.join(root, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      const runs = new Map();
      const executeIsolated = vi.fn((_prompt, opts) => new Promise((resolve) => {
        const studioId = opts.permissionContext.automationJob.studioId;
        runs.set(studioId, { signal: opts.signal, resolve });
      }));
      const engine = {
        agentsDir,
        agents: new Map(),
        getStudioCronStore: () => ({ listJobs: vi.fn(() => []) }),
        getHeartbeatMaster: () => false,
        ensureAgentRuntime: vi.fn(async (agentId) => ({ id: agentId, agentName: agentId })),
        getAgent: vi.fn((agentId) => ({ id: agentId, agentName: agentId })),
        isAgentDeleted: vi.fn(() => false),
        executeIsolated,
        summarizeActivity: vi.fn(() => "done"),
        getActivityStore: vi.fn(() => ({ add: vi.fn() })),
        emitDevLog: vi.fn(),
      };
      const scheduler = new Scheduler({ hub: { engine, eventBus: { emit: vi.fn() } } });
      scheduler.start();
      const { executeJob, abortJob } = createCronSchedulerMock.mock.calls[0][0];
      const executionContext = {
        kind: "session_workspace",
        cwd: "/workspace/a",
        workspaceFolders: [],
        authorizedFolders: [],
        sourceSessionId: null,
        sourceBridgeSessionKey: null,
        sourceSessionPath: null,
        createdByAgentId: "agent-a",
        notificationContext: null,
      };
      const makeJob = (studioId) => ({
        studioId,
        id: "shared-job-id",
        configRevision: 1,
        label: `${studioId} job`,
        actorAgentId: "agent-a",
        executionContext,
        executor: {
          kind: "agent_session",
          agentId: "agent-a",
          prompt: `run ${studioId}`,
          executionContext,
        },
      });
      const studioAJob = makeJob("studio-a");
      const studioBJob = makeJob("studio-b");

      const studioARun = executeJob(studioAJob);
      const studioBRun = executeJob(studioBJob);
      await vi.waitFor(() => expect(executeIsolated).toHaveBeenCalledTimes(2));

      await expect(executeJob(studioAJob)).rejects.toMatchObject({ skipped: true });
      expect(executeIsolated).toHaveBeenCalledTimes(2);

      abortJob(studioAJob);
      expect(runs.get("studio-a").signal.aborted).toBe(true);
      expect(runs.get("studio-b").signal.aborted).toBe(false);

      runs.get("studio-a").resolve({ sessionPath: "", error: null });
      runs.get("studio-b").resolve({ sessionPath: "", error: null });
      await Promise.all([studioARun, studioBRun]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "has no owner", ownerAgentId: undefined, health: "ok", reverseSessionId: "sess-a" },
    { label: "belongs to another actor", ownerAgentId: "agent-b", health: "ok", reverseSessionId: "sess-a" },
    { label: "is unhealthy", ownerAgentId: "agent-a", health: "corrupt", reverseSessionId: "sess-a" },
    { label: "reverse-resolves to another session", ownerAgentId: "agent-a", health: "ok", reverseSessionId: "sess-other" },
  ])("fails closed before execution when the stable source manifest $label", async ({
    ownerAgentId,
    health,
    reverseSessionId,
  }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-scheduler-source-scope-"));
    try {
      const agentsDir = path.join(root, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      const sourceSessionPath = path.join(root, "sessions", "a.jsonl");
      fs.mkdirSync(path.dirname(sourceSessionPath), { recursive: true });
      fs.writeFileSync(sourceSessionPath, "", "utf-8");
      const executeIsolated = vi.fn();
      const engine = {
        agentsDir,
        agents: new Map(),
        getStudioCronStore: () => ({ listJobs: vi.fn(() => []) }),
        getHeartbeatMaster: () => false,
        ensureAgentRuntime: vi.fn(async (agentId) => ({ id: agentId, agentName: agentId })),
        getAgent: vi.fn((agentId) => ({ id: agentId, agentName: agentId })),
        isAgentDeleted: vi.fn(() => false),
        getSessionManifest: vi.fn(() => ({
          sessionId: "sess-a",
          ownerAgentId,
          lifecycle: "active",
          health,
          currentLocator: {
            type: "jsonl",
            path: sourceSessionPath,
            key: sessionLocatorKey(sourceSessionPath),
          },
        })),
        getSessionIdForPath: vi.fn(() => reverseSessionId),
        executeIsolated,
        summarizeActivity: vi.fn(),
        getActivityStore: vi.fn(() => ({ add: vi.fn() })),
        emitDevLog: vi.fn(),
      };
      const scheduler = new Scheduler({ hub: { engine, eventBus: { emit: vi.fn() } } });
      scheduler.start();
      const executeJob = createCronSchedulerMock.mock.calls[0][0].executeJob;
      const executionContext = {
        kind: "session_workspace",
        cwd: "/workspace/a",
        workspaceFolders: [],
        authorizedFolders: [],
        sourceSessionId: "sess-a",
        sourceBridgeSessionKey: null,
        sourceSessionPath: "/sessions/a-old.jsonl",
        createdByAgentId: "agent-a",
        notificationContext: null,
      };

      await expect(executeJob({
        studioId: "studio-a",
        id: "stable-source-job",
        configRevision: 1,
        label: "Stable source job",
        actorAgentId: "agent-a",
        executionContext,
        executor: {
          kind: "agent_session",
          agentId: "agent-a",
          prompt: "run stable source",
          executionContext,
        },
      })).rejects.toThrow(/source session is unavailable or no longer belongs to its actor/);
      expect(executeIsolated).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed if an unmigrated non-Agent automation executor reaches the scheduler", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-scheduler-cron-"));
    try {
      const agentsDir = path.join(root, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      const executeIsolated = vi.fn();
      const engine = {
        agentsDir,
        agents: new Map(),
        getStudioCronStore: () => ({ listJobs: vi.fn(() => []) }),
        getHeartbeatMaster: () => false,
        executeIsolated,
        emitDevLog: vi.fn(),
      };
      const scheduler = new Scheduler({ hub: { engine, eventBus: { emit: vi.fn() } } });
      scheduler.start();
      const executeJob = createCronSchedulerMock.mock.calls[0][0].executeJob;

      const result = executeJob({
        id: "studio_job_notify",
        label: "Drink Water",
        actorAgentId: "agent-a",
        executor: {
          kind: "direct_action",
          action: "notify",
          params: {
            title: "喝水",
            body: "站起来活动一下",
            channels: ["desktop"],
          },
        },
      });

      await expect(result).rejects.toThrow(/unsupported automation executor: direct_action/);
      expect(executeIsolated).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("notifies once for cron and heartbeat completions but never for other activity types", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-scheduler-notification-"));
    try {
      const agentsDir = path.join(root, "agents");
      fs.mkdirSync(path.join(agentsDir, "agent-a"), { recursive: true });
      const deliverNotification = vi.fn(async () => ({ ok: true }));
      const executeIsolated = vi.fn()
        .mockResolvedValueOnce({ sessionPath: "/sessions/cron.jsonl", error: null })
        .mockResolvedValueOnce({ sessionPath: "/sessions/heartbeat.jsonl", error: "patrol failed" });
      const engine = {
        agentsDir,
        ensureAgentRuntime: vi.fn(async () => undefined),
        getAgent: vi.fn(() => ({ id: "agent-a", agentName: "Hana" })),
        executeIsolated,
        summarizeActivity: vi.fn(async (sessionPath) => path.basename(sessionPath)),
        getActivityStore: vi.fn(() => ({ add: vi.fn() })),
        emitDevLog: vi.fn(),
        getNotificationPreferences: vi.fn(() => ({
          chatCompletion: "never",
          scheduledTaskCompletion: "always",
          patrolCompletion: "always",
        })),
        deliverNotification,
      };
      const scheduler = new Scheduler({ hub: { engine, eventBus: { emit: vi.fn() } } });

      await scheduler._executeActivityForAgent("agent-a", "cron prompt", "cron", "Daily report");
      expect(deliverNotification).toHaveBeenCalledTimes(1);
      expect(deliverNotification).toHaveBeenLastCalledWith(
        expect.objectContaining({
          desktopFocusPolicy: "always",
          sessionPath: "/sessions/cron.jsonl",
          idempotencyKey: "activity-completion:cron:agent-a:/sessions/cron.jsonl",
        }),
        { agentId: "agent-a" },
      );

      await expect(scheduler._executeActivityForAgent(
        "agent-a",
        "heartbeat prompt",
        "heartbeat",
        "Routine patrol",
      )).rejects.toThrow("patrol failed");
      expect(deliverNotification).toHaveBeenCalledTimes(2);
      expect(deliverNotification).toHaveBeenLastCalledWith(
        expect.objectContaining({
          desktopFocusPolicy: "always",
          sessionPath: "/sessions/heartbeat.jsonl",
          idempotencyKey: "activity-completion:heartbeat:agent-a:/sessions/heartbeat.jsonl",
        }),
        { agentId: "agent-a" },
      );

      for (const type of ["workflow", "subagent"]) {
        await scheduler._deliverActivityCompletionNotification({
          entry: {
            id: `${type}-1`,
            type,
            label: type,
            agentId: "agent-a",
            agentName: "Hana",
            summary: type,
            status: "done",
          },
          sessionPath: `/sessions/${type}.jsonl`,
        });
      }
      expect(deliverNotification).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
