import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronStore } from "../lib/desk/cron-store.ts";
import { issueAutomationSuggestionReceipt } from "../lib/desk/automation-suggestion-receipt.ts";
import { AutomationSuggestionStore } from "../lib/tools/automation-suggestion-store.ts";
import fs from "fs";
import path from "path";
import os from "os";

function makeTmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-test-"));
  return new CronStore(
    path.join(dir, "cron-jobs.json"),
    path.join(dir, "cron-runs"),
  );
}

/** 创建临时目录，返回 paths（不实例化 store，用于 _load 测试） */
function makeTmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-test-"));
  return {
    jobsPath: path.join(dir, "cron-jobs.json"),
    runsDir: path.join(dir, "cron-runs"),
  };
}

/** 构造本地时间的 Date（cron 字段匹配的是本地时区） */
function localDate(year, month, day, hour = 0, minute = 0) {
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  return d;
}

describe("CronStore cron 解析", () => {
  // ── 步进值 ──

  it("*/30 * * * * → 每30分钟触发", () => {
    const store = makeTmpStore();
    const from = localDate(2026, 3, 25, 10, 5);
    const next = new Date(store._parseSimpleCron("*/30 * * * *", from));
    // */30 匹配 0 和 30，下一个是 10:30
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(30);
  });

  it("*/15 * * * * → 每15分钟触发", () => {
    const store = makeTmpStore();
    const from = localDate(2026, 3, 25, 10, 14);
    const next = new Date(store._parseSimpleCron("*/15 * * * *", from));
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(15);
  });

  it("*/15 从 :45 起算 → 下个整点的 :00", () => {
    const store = makeTmpStore();
    const from = localDate(2026, 3, 25, 10, 45);
    const next = new Date(store._parseSimpleCron("*/15 * * * *", from));
    expect(next.getHours()).toBe(11);
    expect(next.getMinutes()).toBe(0);
  });

  // ── 每日定时（原有功能） ──

  it("30 9 * * * → 每天 9:30", () => {
    const store = makeTmpStore();
    const from = localDate(2026, 3, 25, 8, 0);
    const next = new Date(store._parseSimpleCron("30 9 * * *", from));
    expect(next.getDate()).toBe(25);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
  });

  it("30 9 * * * → 已过9:30则推到明天", () => {
    const store = makeTmpStore();
    const from = localDate(2026, 3, 25, 10, 0);
    const next = new Date(store._parseSimpleCron("30 9 * * *", from));
    expect(next.getDate()).toBe(26);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
  });

  // ── 每小时 ──

  it("0 * * * * → 每小时整点", () => {
    const store = makeTmpStore();
    const from = localDate(2026, 3, 25, 10, 30);
    const next = new Date(store._parseSimpleCron("0 * * * *", from));
    expect(next.getHours()).toBe(11);
    expect(next.getMinutes()).toBe(0);
  });

  // ── 星期字段 ──

  it("0 9 * * 1 → 仅周一 9:00（不是每天）", () => {
    const store = makeTmpStore();
    // 2026-03-25 是周三
    const from = localDate(2026, 3, 25, 8, 0);
    const next = new Date(store._parseSimpleCron("0 9 * * 1", from));
    expect(next.getDay()).toBe(1); // 周一
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    // 下一个周一是 3/30
    expect(next.getDate()).toBe(30);
  });

  it("0 10 * * 0,6 → 仅周末", () => {
    const store = makeTmpStore();
    // 2026-03-25 是周三
    const from = localDate(2026, 3, 25, 8, 0);
    const next = new Date(store._parseSimpleCron("0 10 * * 0,6", from));
    // 下一个周末：周六 3/28
    expect(next.getDay()).toBe(6);
    expect(next.getDate()).toBe(28);
    expect(next.getHours()).toBe(10);
  });

  // ── 日期字段 ──

  it("0 10 1 * * → 每月1号 10:00", () => {
    const store = makeTmpStore();
    const from = localDate(2026, 3, 25, 8, 0);
    const next = new Date(store._parseSimpleCron("0 10 1 * *", from));
    expect(next.getMonth()).toBe(3); // 4月（0-based）
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(10);
  });

  // ── 范围 ──

  it("0 9 * * 1-5 → 工作日 9:00", () => {
    const store = makeTmpStore();
    // 2026-03-28 是周六
    const from = localDate(2026, 3, 28, 8, 0);
    const next = new Date(store._parseSimpleCron("0 9 * * 1-5", from));
    // 下个工作日：周一 3/30
    expect(next.getDay()).toBe(1);
    expect(next.getDate()).toBe(30);
    expect(next.getHours()).toBe(9);
  });

  // ── 周日 7 → 0 归一化 ──

  it("0 8 * * 7 → 周日（7 归一化为 0）", () => {
    const store = makeTmpStore();
    // 2026-03-25 是周三
    const from = localDate(2026, 3, 25, 8, 0);
    const next = new Date(store._parseSimpleCron("0 8 * * 7", from));
    expect(next.getDay()).toBe(0); // 周日
    // 下一个周日：3/29
    expect(next.getDate()).toBe(29);
    expect(next.getHours()).toBe(8);
  });

  // ── 无效表达式 ──

  it("字段不足5个返回 null", () => {
    const store = makeTmpStore();
    expect(store._parseSimpleCron("30 9", new Date())).toBeNull();
  });

  it("非法步进值返回 null", () => {
    const store = makeTmpStore();
    expect(store._parseSimpleCron("*/0 * * * *", new Date())).toBeNull();
    expect(store._parseSimpleCron("*/abc * * * *", new Date())).toBeNull();
  });

  // ── 回归：连续触发不应产生相同时间 ──

  it("*/30 连续 markRun 后 nextRunAt 持续推进", () => {
    const store = makeTmpStore();
    const t0 = localDate(2026, 3, 25, 10, 5);
    const n1 = new Date(store._parseSimpleCron("*/30 * * * *", t0));
    expect(n1.getMinutes()).toBe(30);

    const n2 = new Date(store._parseSimpleCron("*/30 * * * *", n1));
    expect(n2.getHours()).toBe(11);
    expect(n2.getMinutes()).toBe(0);

    const n3 = new Date(store._parseSimpleCron("*/30 * * * *", n2));
    expect(n3.getHours()).toBe(11);
    expect(n3.getMinutes()).toBe(30);
  });
});

describe("CronStore _calcNextRun", () => {
  it("every 类型：返回 from + ms", () => {
    const store = makeTmpStore();
    const from = "2026-03-25T10:00:00.000Z";
    const next = store._calcNextRun("every", 1800000, from); // 30 min
    expect(new Date(next)).toEqual(new Date("2026-03-25T10:30:00.000Z"));
  });

  it("at 类型：未来时间原样返回", () => {
    const store = makeTmpStore();
    const from = "2026-03-25T10:00:00.000Z";
    const next = store._calcNextRun("at", "2026-03-25T12:00:00.000Z", from);
    expect(next).toBe("2026-03-25T12:00:00.000Z");
  });

  it("at 类型：过去时间返回 null", () => {
    const store = makeTmpStore();
    const from = "2026-03-25T10:00:00.000Z";
    const next = store._calcNextRun("at", "2026-03-25T08:00:00.000Z", from);
    expect(next).toBeNull();
  });
});

// ════════════════════════════════════════════
//  addJob 输入验证
// ════════════════════════════════════════════

describe("CronStore addJob 输入验证", () => {
  it("无效 type 抛错", () => {
    const store = makeTmpStore();
    expect(() => store.addJob({
      type: "invalid",
      schedule: 60000,
      prompt: "test",
    })).toThrow(/无效的 job type/);
  });

  it("every 类型 schedule < 60000 clamp 到 60000", () => {
    const store = makeTmpStore();
    const job = store.addJob({
      type: "every",
      schedule: 5000,
      prompt: "test",
    });
    expect(job.schedule).toBe(60000);
  });

  it("at 类型 Invalid Date 抛错", () => {
    const store = makeTmpStore();
    expect(() => store.addJob({
      type: "at",
      schedule: "not-a-date",
      prompt: "test",
    })).toThrow(/无法解析为日期/);
  });

  it("at 类型过去时间抛错", () => {
    const store = makeTmpStore();
    expect(() => store.addJob({
      type: "at",
      schedule: "2020-01-01T00:00:00.000Z",
      prompt: "test",
    })).toThrow(/必须是未来时间/);
  });
});

describe("Automation job read model", () => {
  it("projects legacy cron prompt jobs to agent_session executor", () => {
    const store = makeTmpStore();
    const model = { id: "gpt-4o", provider: "openai" };
    const executionContext = {
      kind: "session_workspace",
      cwd: "/workspace",
      workspaceFolders: ["/workspace"],
      sourceSessionPath: "/sessions/source.jsonl",
      createdByAgentId: "hana",
    };

    const job = store.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "summarize",
      actorAgentId: "hana",
      executionContext,
      model,
    } as any);

    expect(job.schemaVersion).toBe(4);
    expect(job.trigger).toEqual({ kind: "cron", expression: "0 9 * * *" });
    const downgradedContext = {
      ...executionContext,
      cwd: null,
      workspaceFolders: [],
      authorizedFolders: [],
      sourceSessionId: null,
      sourceSessionPath: null,
    };
    expect(job.executionContext).toEqual(downgradedContext);
    expect(job.executor).toMatchObject({
      kind: "agent_session",
      agentId: "hana",
      prompt: "summarize",
      model,
      executionContext: downgradedContext,
    });
    expect(job.createdBy).toEqual({ kind: "agent", agentId: "hana" });
  });

  it("does not bind missing legacy actor to the focused agent", () => {
    const store = makeTmpStore();

    const job = store.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "summarize",
    });

    expect(job.executor).toMatchObject({
      kind: "agent_session",
      agentId: null,
      prompt: "summarize",
    });
    expect(job.createdBy).toEqual({ kind: "unknown" });
  });

  it("keeps trigger and agent_session executor synced when legacy fields update", () => {
    const store = makeTmpStore();
    const job = store.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "morning summary",
      actorAgentId: "hana",
      model: { id: "gpt-4o", provider: "openai" },
    } as any);

    const updated = store.updateJob(job.id, {
      schedule: "30 18 * * *",
      prompt: "evening summary",
      model: { id: "gpt-4.1", provider: "openai" },
    });

    expect(updated.trigger).toEqual({ kind: "cron", expression: "30 18 * * *" });
    expect(updated.executor).toMatchObject({
      kind: "agent_session",
      agentId: "hana",
      prompt: "evening summary",
      model: { id: "gpt-4.1", provider: "openai" },
    });
  });

  it("writes automation fields back when loading legacy jobs", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath, JSON.stringify({
      jobs: [{
        id: "job_1",
        schemaVersion: 3,
        type: "cron",
        schedule: "0 9 * * *",
        prompt: "legacy",
        enabled: true,
        actorAgentId: "hana",
        model: "",
        consecutiveErrors: 0,
        authorization: {
          schemaVersion: 1,
          jobId: "job_1",
          actorAgentId: "hana",
          grants: [{
            toolName: "terminal",
            action: "run",
            capability: "process.exec",
            target: { type: "workspace", id: "/workspace" },
          }],
          confirmedAt: "2026-07-19T00:00:00.000Z",
          sourceSuggestionId: "automation_old",
        },
      }],
      nextNum: 2,
    }, null, 2), "utf-8");

    new CronStore(jobsPath, runsDir);

    const [job] = JSON.parse(fs.readFileSync(jobsPath, "utf-8")).jobs;
    expect(job.schemaVersion).toBe(4);
    expect(job.enabled).toBe(true);
    expect(job.authorization).toBeUndefined();
    expect(job.trigger).toEqual({ kind: "cron", expression: "0 9 * * *" });
    expect(job.executor).toMatchObject({
      kind: "agent_session",
      agentId: "hana",
      prompt: "legacy",
    });
  });

  it("repairs missing nextRunAt for enabled persisted jobs with valid schedules", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath, JSON.stringify({
      jobs: [{
        id: "job_1",
        type: "cron",
        schedule: "30 0 * * *",
        prompt: "legacy",
        enabled: true,
        nextRunAt: null,
        consecutiveErrors: 0,
      }],
      nextNum: 2,
    }, null, 2), "utf-8");

    const store = new CronStore(jobsPath, runsDir);
    const [job] = store.listJobs();
    const persisted = JSON.parse(fs.readFileSync(jobsPath, "utf-8")).jobs[0];

    expect(typeof job.nextRunAt).toBe("string");
    expect(Number.isNaN(new Date(job.nextRunAt).getTime())).toBe(false);
    expect(persisted.nextRunAt).toBe(job.nextRunAt);
  });

  it("keeps disabled persisted drafts unscheduled when nextRunAt is missing", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath, JSON.stringify({
      jobs: [{
        id: "job_1",
        type: "cron",
        schedule: "30 0 * * *",
        prompt: "",
        label: "Draft",
        enabled: false,
        nextRunAt: null,
        consecutiveErrors: 0,
      }],
      nextNum: 2,
    }, null, 2), "utf-8");

    const store = new CronStore(jobsPath, runsDir);
    const [job] = store.listJobs();

    expect(job.enabled).toBe(false);
    expect(job.nextRunAt).toBeNull();
  });

  it("does not invent nextRunAt for enabled persisted jobs with invalid schedules", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath, JSON.stringify({
      jobs: [{
        id: "job_1",
        type: "cron",
        schedule: "not a cron",
        prompt: "legacy",
        enabled: true,
        nextRunAt: null,
        consecutiveErrors: 0,
      }],
      nextNum: 2,
    }, null, 2), "utf-8");

    const store = new CronStore(jobsPath, runsDir);
    const [job] = store.listJobs();

    expect(job.enabled).toBe(true);
    expect(job.nextRunAt).toBeNull();
  });

  it("rejects direct-action executors on new writes", () => {
    const store = makeTmpStore();

    expect(() => store.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      label: "Drink Water",
      actorAgentId: "hana",
      executionContext: {
        kind: "session_workspace",
        cwd: "/workspace",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/source.jsonl",
        createdByAgentId: "hana",
      },
      executor: {
        kind: "direct_action",
        action: "notify",
        params: {
          title: "喝水",
          body: "站起来活动一下",
          channels: ["desktop"],
        },
      },
      createdBy: { kind: "agent", agentId: "hana", sourceSessionPath: "/sessions/source.jsonl" },
    } as any)).toThrow(/unsupported automation executor: direct_action/);
  });

  it("rejects plugin-action executors on new writes", () => {
    const store = makeTmpStore();

    expect(() => store.addJob({
      type: "cron",
      schedule: "0 18 * * *",
      actorAgentId: "hana",
      executionContext: {
        kind: "session_workspace",
        cwd: "/workspace",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/source.jsonl",
        createdByAgentId: "hana",
      },
      executor: {
        kind: "plugin_action",
        pluginId: "notes",
        actionId: "create_note",
        params: { folder: "daily" },
      },
    } as any)).toThrow(/unsupported automation executor: plugin_action/);
  });

  it("rejects removed file.create direct-action executors on new writes", () => {
    const store = makeTmpStore();

    expect(() => store.addJob({
      type: "cron",
      schedule: "0 18 * * *",
      actorAgentId: "hana",
      executor: {
        kind: "direct_action",
        action: "file.create",
        params: { relativePath: "notes/today.md", content: "# Today\n" },
      },
    } as any)).toThrow(/unsupported automation executor: direct_action/);
  });
});

describe("Automation suggestion receipts and persistence", () => {
  const studioId = "studio-a";
  const executionContext = {
    kind: "session_workspace",
    cwd: "/workspace/project",
    workspaceFolders: ["/workspace/project"],
    authorizedFolders: [],
    sourceSessionId: "sess-source",
    sourceBridgeSessionKey: null,
    sourceSessionPath: "/sessions/source.jsonl",
    createdByAgentId: "agent-a",
    notificationContext: null,
  };

  function makeStudioStore(id = studioId) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-receipt-test-"));
    return new CronStore(
      path.join(dir, "cron-jobs.json"),
      path.join(dir, "cron-runs"),
      { studioId: id },
    );
  }

  function baseJob() {
    return {
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "run the daily task",
      actorAgentId: "agent-a",
      executionContext,
    };
  }

  function receipt({
    suggestionId = "automation_suggestion_1",
    operation = "create" as "create" | "update",
    jobId = null as string | null,
    baseConfigRevision = null as number | null,
    receiptStudioId = studioId,
    now = () => Date.now(),
    expiresAt = now() + 60_000,
  } = {}) {
    return issueAutomationSuggestionReceipt({
      suggestionId,
      confirmedAt: "2026-07-19T10:00:00.000Z",
      expiresAt,
      studioId: receiptStudioId,
      operation,
      jobId,
      baseConfigRevision,
    }, { now });
  }

  it("strips deprecated authorization fields from ordinary writes", () => {
    const store = makeStudioStore();
    const job = store.addJob({
      ...baseJob(),
      authorization: { forged: true },
      requestedGrants: [{ forged: true }],
    } as any);
    expect(job.authorization).toBeUndefined();
    expect(job.requestedGrants).toBeUndefined();

    const updated = store.updateJob(job.id, {
      authorization: { forged: true },
      requestedGrants: [{ forged: true }],
    } as any);
    expect(updated.authorization).toBeUndefined();
    expect(updated.requestedGrants).toBeUndefined();
  });

  it("increments configRevision for every user-editable suggestion field", () => {
    const store = makeStudioStore();
    const job = store.addJob(baseJob());
    const renamed = store.updateJob(job.id, { label: "renamed" });
    expect(renamed.configRevision).toBe(2);

    const changed = store.updateJob(job.id, { prompt: "a changed task" });
    expect(changed.configRevision).toBe(3);

    const updateReceipt = receipt({
      suggestionId: "automation_suggestion_2",
      operation: "update",
      jobId: job.id,
      baseConfigRevision: 3,
    });
    const relabeled = store.updateJob(job.id, { label: "confirmed rename" }, {
      suggestionReceipt: updateReceipt,
    });
    expect(relabeled.configRevision).toBe(4);
    expect(relabeled.label).toBe("confirmed rename");
  });

  it("invalidates an update suggestion when the label changes after draft creation", () => {
    const store = makeStudioStore();
    const job = store.addJob(baseJob());
    const staleAfterRename = receipt({
      suggestionId: "automation_suggestion_before_rename",
      operation: "update",
      jobId: job.id,
      baseConfigRevision: job.configRevision,
    });

    const renamed = store.updateJob(job.id, { label: "newer label" });
    expect(renamed.configRevision).toBe(job.configRevision + 1);
    expect(() => store.updateJob(job.id, { label: "stale label" }, {
      suggestionReceipt: staleAfterRename,
    })).toThrow(/changed after this suggestion/);
    expect(store.getJob(job.id)).toMatchObject({
      label: "newer label",
      configRevision: renamed.configRevision,
    });
  });

  it("invalidates an update suggestion when the job is disabled after the draft was created", () => {
    const store = makeStudioStore();
    const job = store.addJob(baseJob());
    const staleAfterToggle = receipt({
      suggestionId: "automation_suggestion_before_disable",
      operation: "update",
      jobId: job.id,
      baseConfigRevision: job.configRevision,
    });

    const disabled = store.toggleJob(job.id);
    expect(disabled.enabled).toBe(false);
    expect(disabled.configRevision).toBe(job.configRevision + 1);
    expect(() => store.updateJob(job.id, { enabled: true, prompt: "stale prompt" }, {
      suggestionReceipt: staleAfterToggle,
    })).toThrow(/changed after this suggestion/);
    expect(store.getJob(job.id)).toMatchObject({
      enabled: false,
      configRevision: disabled.configRevision,
      prompt: job.prompt,
    });
  });

  it("invalidates an update suggestion when a one-time job runs and disables itself", () => {
    const store = makeStudioStore();
    const job = store.addJob({
      ...baseJob(),
      type: "at",
      schedule: new Date(Date.now() + 60_000).toISOString(),
    });
    const staleAfterRun = receipt({
      suggestionId: "automation_suggestion_before_at_run",
      operation: "update",
      jobId: job.id,
      baseConfigRevision: job.configRevision,
    });

    expect(store.markRun(job.id, {
      success: true,
      expectedConfigRevision: job.configRevision,
    })).toBe(true);
    const completed = store.getJob(job.id);
    expect(completed).toMatchObject({
      enabled: false,
      configRevision: job.configRevision + 1,
    });
    expect(() => store.updateJob(job.id, { enabled: true, prompt: "stale prompt" }, {
      suggestionReceipt: staleAfterRun,
    })).toThrow(/changed after this suggestion/);
    expect(store.getJob(job.id)).toMatchObject({
      enabled: false,
      configRevision: completed.configRevision,
      prompt: job.prompt,
    });
  });

  it("rejects forged, cloned, replayed, expired, cross-Studio, and stale receipts", () => {
    const store = makeStudioStore();
    expect(() => store.addJob(baseJob(), {
      suggestionReceipt: {},
    })).toThrow(/invalid or already consumed/);

    const valid = receipt();
    expect(() => store.addJob(baseJob(), {
      suggestionReceipt: { ...valid },
    })).toThrow(/invalid or already consumed/);
    const created = store.addJob(baseJob(), {
      suggestionReceipt: valid,
    });
    expect(() => store.addJob(baseJob(), {
      suggestionReceipt: valid,
    })).toThrow(/invalid or already consumed/);

    const crossStudio = receipt({ receiptStudioId: "studio-b" });
    expect(() => store.addJob(baseJob(), {
      suggestionReceipt: crossStudio,
    })).toThrow(/does not match/);

    const nowValue = { value: 1000 };
    const expired = receipt({ now: () => nowValue.value, expiresAt: 1001 });
    nowValue.value = 1001;
    expect(() => store.addJob(baseJob(), {
      suggestionReceipt: expired,
    })).toThrow(/expired/);

    const stale = receipt({
      operation: "update",
      jobId: created.id,
      baseConfigRevision: 1,
    });
    store.updateJob(created.id, { prompt: "new revision" });
    expect(() => store.updateJob(created.id, {}, {
      suggestionReceipt: stale,
    })).toThrow(/changed after this suggestion/);
  });

  it("keeps future schemas intact while stripping deprecated authority fields", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath, JSON.stringify({
      jobs: [{
        id: "studio_job_future",
        schemaVersion: 999,
        studioId,
        configRevision: 1,
        ...baseJob(),
        enabled: true,
        createdAt: "2026-07-19T10:00:00.000Z",
        nextRunAt: "2026-07-20T10:00:00.000Z",
        permissionMode: "operate",
        approvalPolicy: "allow",
        allowHumanApproval: true,
        executor: {
          kind: "agent_session",
          agentId: "agent-a",
          prompt: "run the daily task",
          model: "",
          executionContext,
          permissionMode: "operate",
          approvalPolicy: "allow",
        },
        authorization: {
          schemaVersion: 2,
          studioId,
          jobId: "studio_job_future",
          actorAgentId: "agent-a",
          configRevision: 1,
          grants: [{ forged: true }],
          confirmedAt: "2026-07-19T10:00:00.000Z",
          sourceSuggestionId: "automation_future",
        },
        requestedGrants: [{ forged: true }],
      }],
      nextNum: 2,
    }), "utf-8");
    const futureStore = new CronStore(jobsPath, runsDir, { studioId });
    expect(futureStore.getJob("studio_job_future").schemaVersion).toBe(999);
    expect(futureStore.getJob("studio_job_future").authorization).toBeUndefined();
    expect(futureStore.getJob("studio_job_future").requestedGrants).toBeUndefined();
    expect(futureStore.getJob("studio_job_future").permissionMode).toBeUndefined();
    expect(futureStore.getJob("studio_job_future").approvalPolicy).toBeUndefined();
    expect(futureStore.getJob("studio_job_future").allowHumanApproval).toBeUndefined();
    expect(futureStore.getJob("studio_job_future").executor.permissionMode).toBeUndefined();
    expect(futureStore.getJob("studio_job_future").executor.approvalPolicy).toBeUndefined();
  });

  it("reloads before every mutation so stale instances observe the latest persisted revision", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-concurrency-test-"));
    const jobsPath = path.join(dir, "cron-jobs.json");
    const runsDir = path.join(dir, "cron-runs");
    const first = new CronStore(jobsPath, runsDir, { studioId });
    const second = new CronStore(jobsPath, runsDir, { studioId });
    const created = first.addJob(baseJob());
    const updated = second.updateJob(created.id, { prompt: "latest task" });
    const added = first.addJob({ ...baseJob(), prompt: "another task" });

    expect(added.id).not.toBe(created.id);
    expect(first.getJob(created.id).prompt).toBe("latest task");
    expect(first.getJob(created.id).configRevision).toBe(updated.configRevision);
    expect(first.listJobs()).toHaveLength(2);
  });

  it("commits a suggestion inspected before expiry even if the write crosses the TTL boundary", async () => {
    let now = 0;
    const store = makeStudioStore();
    const suggestions = new AutomationSuggestionStore({ now: () => now, ttlMs: 100 });
    let committedReceipt: object | null = null;
    const originalWriteState = store._writeState.bind(store);
    vi.spyOn(store, "_writeState").mockImplementation((state) => {
      originalWriteState(state);
      now = 101;
    });
    const suggestion = suggestions.create({
      sessionId: "session-a",
      studioId,
      jobData: baseJob(),
      apply: (_value, confirmation) => {
        committedReceipt = confirmation!.receipt;
        return store.addJob(baseJob(), {
          suggestionReceipt: confirmation!.receipt,
        });
      },
    });

    now = 99;
    const result = await suggestions.apply({
      sessionId: "session-a",
      studioId,
      ref: suggestion.suggestionId,
    });

    expect(result.ok).toBe(true);
    expect(store.listJobs()).toHaveLength(1);
    expect(store.listJobs()[0].authorization).toBeUndefined();
    expect(store.listJobs()[0].requestedGrants).toBeUndefined();
    expect(() => store.addJob(baseJob(), {
      suggestionReceipt: committedReceipt,
    })).toThrow(/invalid or already consumed/);
  });

  it("prunes expired suggestions before allocating a new shortcode", () => {
    let now = 0;
    const suggestions = new AutomationSuggestionStore({
      now: () => now,
      ttlMs: 100,
      generateShortCode: () => "1234",
    });
    const first = suggestions.create({
      sessionId: "session-a",
      studioId,
      jobData: baseJob(),
      apply: () => null,
    });
    now = 101;
    const second = suggestions.create({
      sessionId: "session-a",
      studioId,
      jobData: baseJob(),
      apply: () => null,
    });

    expect(first.shortCode).toBe("1234");
    expect(second.shortCode).toBe("1234");
    expect(suggestions.get(first.suggestionId)).toBeNull();
    expect(suggestions.get(second.suggestionId)?.suggestionId).toBe(second.suggestionId);
  });

  it("requires the exact Studio to consume a Studio-bound suggestion", async () => {
    const apply = vi.fn(() => ({ id: "studio_job_1" }));
    const suggestions = new AutomationSuggestionStore();
    const suggestion = suggestions.create({
      sessionId: "session-a",
      studioId: "studio-a",
      jobData: baseJob(),
      apply,
    });

    await expect(suggestions.apply({
      sessionId: "session-a",
      ref: suggestion.suggestionId,
    })).resolves.toEqual({ ok: false, reason: "not-found" });
    await expect(suggestions.apply({
      sessionId: "session-a",
      studioId: "studio-b",
      ref: suggestion.suggestionId,
    })).resolves.toEqual({ ok: false, reason: "not-found" });
    expect(apply).not.toHaveBeenCalled();

    const result = await suggestions.apply({
      sessionId: "session-a",
      studioId: "studio-a",
      ref: suggestion.suggestionId,
    });
    expect(result.ok).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
  });

  it("refuses to retain a path-only automation suggestion", () => {
    const suggestions = new AutomationSuggestionStore();
    expect(() => suggestions.create({
      sessionPath: "/sessions/legacy.jsonl",
      studioId: "studio-a",
      jobData: baseJob(),
      apply: () => null,
    })).toThrow(/stable sessionId or bridgeSessionKey/);
  });
});

// ════════════════════════════════════════════
//  updateJob 字段白名单
// ════════════════════════════════════════════

describe("CronStore updateJob 字段白名单", () => {
  it("addJob / updateJob 保留完整模型复合键", () => {
    const store = makeTmpStore();
    const firstModel = { id: "MiniMax-M2.7", provider: "minimax" };
    const secondModel = { id: "gpt-4o", provider: "openai" };

    const job = store.addJob({
      type: "every",
      schedule: 3600000,
      prompt: "test",
      model: firstModel,
    } as any);

    expect(job.model).toEqual(firstModel);

    const updated = store.updateJob(job.id, { model: secondModel });
    expect(updated.model).toEqual(secondModel);
    expect(store.getJob(job.id).model).toEqual(secondModel);
  });

  it("nextRunAt / id / createdAt 不可被覆盖", () => {
    const store = makeTmpStore();
    const job = store.addJob({
      type: "every",
      schedule: 3600000,
      prompt: "test",
    });
    const origId = job.id;
    const origCreatedAt = job.createdAt;
    const origNextRunAt = job.nextRunAt;

    store.updateJob(job.id, {
      id: "hacked_id",
      createdAt: "1999-01-01T00:00:00.000Z",
      nextRunAt: "1999-01-01T00:00:00.000Z",
      label: "new label",
    });

    const updated = store.getJob(origId);
    expect(updated.id).toBe(origId);
    expect(updated.createdAt).toBe(origCreatedAt);
    expect(updated.nextRunAt).toBe(origNextRunAt);
    expect(updated.label).toBe("new label");
  });

  it("updateJob 允许确认卡同步变更执行 Agent 归属", () => {
    const store = makeTmpStore();
    const job = store.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "old prompt",
      actorAgentId: "agent-a",
      executionContext: {
        kind: "session_workspace",
        cwd: "/home/agent-a",
        workspaceFolders: [],
        sourceSessionPath: null,
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
          sourceSessionPath: null,
          createdByAgentId: "agent-a",
        },
      },
    } as any);

    const updated = store.updateJob(job.id, {
      prompt: "new prompt",
      actorAgentId: "agent-b",
      executionContext: {
        kind: "session_workspace",
        cwd: "/home/agent-b",
        workspaceFolders: [],
        sourceSessionPath: null,
        createdByAgentId: "agent-b",
      },
      executor: {
        kind: "agent_session",
        agentId: "agent-b",
        prompt: "new prompt",
        model: "",
        executionContext: {
          kind: "session_workspace",
          cwd: "/home/agent-b",
          workspaceFolders: [],
          sourceSessionPath: null,
          createdByAgentId: "agent-b",
        },
      },
    } as any);

    expect(updated.actorAgentId).toBe("agent-b");
    expect(updated.executionContext.cwd).toBe("/home/agent-b");
    expect(updated.executor).toMatchObject({
      kind: "agent_session",
      agentId: "agent-b",
      prompt: "new prompt",
    });
  });

  it("schedule 变更触发 nextRunAt 重算", () => {
    const store = makeTmpStore();
    const job = store.addJob({
      type: "every",
      schedule: 3600000,
      prompt: "test",
    });
    const origNextRunAt = job.nextRunAt;

    // 改 schedule 为 2 小时
    const updated = store.updateJob(job.id, { schedule: 7200000 });
    expect(updated.schedule).toBe(7200000);
    // nextRunAt 应该被重算（基于当前时间 + 7200000），跟原来不同
    expect(updated.nextRunAt).not.toBe(origNextRunAt);
  });

  it("enabling a valid job with missing nextRunAt recomputes the schedule cursor", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath, JSON.stringify({
      jobs: [{
        id: "job_1",
        type: "cron",
        schedule: "30 0 * * *",
        prompt: "daily",
        label: "Daily",
        enabled: false,
        nextRunAt: null,
        consecutiveErrors: 0,
      }],
      nextNum: 2,
    }, null, 2), "utf-8");
    const store = new CronStore(jobsPath, runsDir);

    const updated = store.updateJob("job_1", { enabled: true });

    expect(updated.enabled).toBe(true);
    expect(typeof updated.nextRunAt).toBe("string");
    expect(Number.isNaN(new Date(updated.nextRunAt).getTime())).toBe(false);
  });

  it("updateJob 允许同步变更 type 和 schedule", () => {
    const store = makeTmpStore();
    const job = store.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "test",
    });

    const updated = store.updateJob(job.id, { type: "every", schedule: 7200000 });
    expect(updated.type).toBe("every");
    expect(updated.schedule).toBe(7200000);
    expect(updated.nextRunAt).toBeTruthy();
  });

  it("updateJob 修改 type 时必须同步提供 schedule", () => {
    const store = makeTmpStore();
    const job = store.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "test",
    });

    expect(() => store.updateJob(job.id, { type: "every" }))
      .toThrow(/schedule/);
  });
});

// ════════════════════════════════════════════
//  _load 错误处理
// ════════════════════════════════════════════

describe("CronStore _load 错误处理", () => {
  it("ENOENT（文件不存在）不报错，jobs 为空", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    // 不写任何文件，直接构造 store
    const spy = vi.spyOn(console, "error");
    const store = new CronStore(jobsPath, runsDir);
    expect(store.size).toBe(0);
    // ENOENT 走静默分支，不应 console.error
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("JSON 损坏且没有有效 .tmp 时显式失败", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath, "{ broken json !!!", "utf-8");

    expect(() => new CronStore(jobsPath, runsDir)).toThrow(expect.objectContaining({
      code: "cron_store_corrupt",
      status: 500,
      message: "automation task storage is corrupt",
    }));
    expect(fs.readFileSync(jobsPath, "utf-8")).toBe("{ broken json !!!");
  });

  it("主文件缺失但 .tmp 损坏时显式失败", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath + ".tmp", "{ broken recovery !!!", "utf-8");

    expect(() => new CronStore(jobsPath, runsDir)).toThrow(expect.objectContaining({
      code: "cron_store_corrupt",
      status: 500,
    }));
    expect(fs.existsSync(jobsPath)).toBe(false);
    expect(fs.readFileSync(jobsPath + ".tmp", "utf-8")).toBe("{ broken recovery !!!");
  });

  it.each([
    ["null root", "null"],
    ["array root", "[]"],
    ["primitive root", "42"],
    ["non-array jobs", JSON.stringify({ jobs: {} })],
  ])("主文件拒绝无效存储结构：%s", (_label, payload) => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath, payload, "utf-8");

    expect(() => new CronStore(jobsPath, runsDir)).toThrow(expect.objectContaining({
      code: "cron_store_corrupt",
      status: 500,
    }));
  });

  it(".tmp 拒绝无效存储结构且不会覆盖损坏主文件", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath, "broken primary", "utf-8");
    fs.writeFileSync(jobsPath + ".tmp", "null", "utf-8");

    expect(() => new CronStore(jobsPath, runsDir)).toThrow(expect.objectContaining({
      code: "cron_store_corrupt",
      status: 500,
    }));
    expect(fs.readFileSync(jobsPath, "utf-8")).toBe("broken primary");
    expect(fs.readFileSync(jobsPath + ".tmp", "utf-8")).toBe("null");
  });

  it("JSON 损坏 + .tmp 存在 → 保留原始字节并从 .tmp 恢复", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });

    // 写损坏的主文件
    const brokenBytes = Buffer.from([0x7b, 0x20, 0x62, 0x72, 0x6f, 0x6b, 0x65, 0x6e, 0xff]);
    fs.writeFileSync(jobsPath, brokenBytes);

    // 写有效的 .tmp 文件
    const tmpData = {
      jobs: [
        { id: "job_1", type: "every", schedule: 3600000, prompt: "recovered", enabled: true, model: "", consecutiveErrors: 0 },
      ],
      nextNum: 2,
    };
    fs.writeFileSync(jobsPath + ".tmp", JSON.stringify(tmpData), "utf-8");

    const spy = vi.spyOn(console, "error");
    const store = new CronStore(jobsPath, runsDir);
    expect(store.size).toBe(1);
    expect(store.getJob("job_1").prompt).toBe("recovered");
    expect(JSON.parse(fs.readFileSync(jobsPath, "utf-8")).jobs[0].prompt).toBe("recovered");
    expect(fs.existsSync(jobsPath + ".tmp")).toBe(false);
    const backups = fs.readdirSync(path.dirname(jobsPath))
      .filter(name => name.startsWith("cron-jobs.json.corrupt-") && name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(jobsPath), backups[0]))).toEqual(brokenBytes);
    // 应该有恢复日志
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("从 .tmp 恢复"));
    spy.mockRestore();
  });

  it("重复恢复使用唯一 backup，不覆盖已有副本", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath, "first broken payload", "utf-8");
    fs.writeFileSync(jobsPath + ".tmp", JSON.stringify({ jobs: [], nextNum: 1 }), "utf-8");
    new CronStore(jobsPath, runsDir);

    fs.writeFileSync(jobsPath, "second broken payload", "utf-8");
    fs.writeFileSync(jobsPath + ".tmp", JSON.stringify({ jobs: [], nextNum: 1 }), "utf-8");
    new CronStore(jobsPath, runsDir);

    const backups = fs.readdirSync(path.dirname(jobsPath))
      .filter(name => name.startsWith("cron-jobs.json.corrupt-") && name.endsWith(".bak"));
    expect(backups).toHaveLength(2);
    expect(backups.map(name => fs.readFileSync(path.join(path.dirname(jobsPath), name), "utf-8")).sort())
      .toEqual(["first broken payload", "second broken payload"]);
  });

  it("backup 写入失败时显式失败且不覆盖主文件或 .tmp", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath, "broken primary", "utf-8");
    const recoveryPayload = JSON.stringify({ jobs: [], nextNum: 1 });
    fs.writeFileSync(jobsPath + ".tmp", recoveryPayload, "utf-8");
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (String(file).includes(".corrupt-")) {
        throw Object.assign(new Error("backup denied"), { code: "EACCES" });
      }
      return originalWriteFileSync(file, data, options as never);
    });

    try {
      expect(() => new CronStore(jobsPath, runsDir)).toThrow(expect.objectContaining({
        code: "cron_store_recovery_failed",
        status: 500,
      }));
    } finally {
      writeSpy.mockRestore();
    }
    expect(fs.readFileSync(jobsPath, "utf-8")).toBe("broken primary");
    expect(fs.readFileSync(jobsPath + ".tmp", "utf-8")).toBe(recoveryPayload);
  });

  it("恢复 rename 失败时显式失败并保留主文件、.tmp 与 backup", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath, "broken primary", "utf-8");
    const recoveryPayload = JSON.stringify({ jobs: [], nextNum: 1 });
    fs.writeFileSync(jobsPath + ".tmp", recoveryPayload, "utf-8");
    const originalRenameSync = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (source === jobsPath + ".tmp" && destination === jobsPath) {
        throw Object.assign(new Error("rename denied"), { code: "EACCES" });
      }
      return originalRenameSync(source, destination);
    });

    try {
      expect(() => new CronStore(jobsPath, runsDir)).toThrow(expect.objectContaining({
        code: "cron_store_recovery_failed",
        status: 500,
      }));
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.readFileSync(jobsPath, "utf-8")).toBe("broken primary");
    expect(fs.readFileSync(jobsPath + ".tmp", "utf-8")).toBe(recoveryPayload);
    const backups = fs.readdirSync(path.dirname(jobsPath))
      .filter(name => name.startsWith("cron-jobs.json.corrupt-") && name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(jobsPath), backups[0]), "utf-8"))
      .toBe("broken primary");
  });

  it("主文件缺失但 .tmp 有效时恢复并持久化主文件", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath + ".tmp", JSON.stringify({
      jobs: [
        { id: "job_1", type: "cron", schedule: "0 9 * * *", prompt: "recovered", enabled: true, model: "", consecutiveErrors: 0 },
      ],
      nextNum: 2,
    }), "utf-8");

    const store = new CronStore(jobsPath, runsDir);

    expect(store.getJob("job_1").prompt).toBe("recovered");
    expect(JSON.parse(fs.readFileSync(jobsPath, "utf-8")).jobs[0].prompt).toBe("recovered");
    expect(fs.existsSync(jobsPath + ".tmp")).toBe(false);
    expect(fs.readdirSync(path.dirname(jobsPath)).filter(name => name.includes(".corrupt-"))).toEqual([]);
  });

  it("every schedule < 60000 自动 clamp", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });

    const data = {
      jobs: [
        { id: "job_1", type: "every", schedule: 1000, prompt: "fast", enabled: true, model: "", consecutiveErrors: 0 },
        { id: "job_2", type: "every", schedule: 120000, prompt: "ok", enabled: true, model: "", consecutiveErrors: 0 },
      ],
      nextNum: 3,
    };
    fs.writeFileSync(jobsPath, JSON.stringify(data), "utf-8");

    const store = new CronStore(jobsPath, runsDir);
    expect(store.getJob("job_1").schedule).toBe(60000);
    expect(store.getJob("job_2").schedule).toBe(120000);
  });

  it("读取旧污染 every schedule 时把重复分钟归一化修回毫秒", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    const intendedMs = 7_200_000;
    const pollutedMs = intendedMs * 60_000;

    const data = {
      jobs: [
        {
          id: "job_polluted",
          type: "every",
          schedule: pollutedMs,
          prompt: "every two hours",
          enabled: true,
          model: "",
          consecutiveErrors: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          nextRunAt: "2039-09-10T00:00:00.000Z",
          trigger: { kind: "every", intervalMs: pollutedMs },
        },
      ],
      nextNum: 2,
    };
    fs.writeFileSync(jobsPath, JSON.stringify(data), "utf-8");

    const before = Date.now();
    const store = new CronStore(jobsPath, runsDir);
    const after = Date.now();
    const job = store.getJob("job_polluted");
    const nextRunTime = new Date(job.nextRunAt).getTime();

    expect(job.schedule).toBe(intendedMs);
    expect(job.trigger.intervalMs).toBe(intendedMs);
    expect(nextRunTime).toBeGreaterThanOrEqual(before + intendedMs - 1000);
    expect(nextRunTime).toBeLessThanOrEqual(after + intendedMs + 1000);

    const saved = JSON.parse(fs.readFileSync(jobsPath, "utf-8"));
    expect(saved.jobs[0].schedule).toBe(intendedMs);
    expect(saved.jobs[0].trigger.intervalMs).toBe(intendedMs);
  });

  it("多次 listJobs 幂等（清洗后 _save，后续不再重复写）", () => {
    const { jobsPath, runsDir } = makeTmpPaths();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });

    const data = {
      jobs: [
        { id: "job_1", type: "every", schedule: 5000, prompt: "test", enabled: true, model: "" },
      ],
      nextNum: 2,
    };
    fs.writeFileSync(jobsPath, JSON.stringify(data), "utf-8");

    const store = new CronStore(jobsPath, runsDir);
    // 首次 _load 触发清洗 + _save
    expect(store.getJob("job_1").schedule).toBe(60000);
    expect(store.getJob("job_1").consecutiveErrors).toBe(0);

    // 再次 listJobs（触发 _load），数据已干净，不应再 _save
    // 用一个小延迟确保 mtime 能区分
    const spy = vi.spyOn(store, "_writeState");
    store.listJobs();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ════════════════════════════════════════════
//  markRun 错误退避
// ════════════════════════════════════════════

describe("CronStore markRun 错误退避", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-03-28T12:00:00.000Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("success 时 consecutiveErrors 归 0", () => {
    const store = makeTmpStore();
    const job = store.addJob({ type: "every", schedule: 3600000, prompt: "test" });
    // 手动设置一些错误计数
    store.getJob(job.id).consecutiveErrors = 3;
    store.markRun(job.id, { success: true });
    expect(store.getJob(job.id).consecutiveErrors).toBe(0);
  });

  it("failure 时 consecutiveErrors 递增", () => {
    const store = makeTmpStore();
    const job = store.addJob({ type: "every", schedule: 3600000, prompt: "test" });
    expect(store.getJob(job.id).consecutiveErrors).toBe(0);

    store.markRun(job.id, { success: false });
    expect(store.getJob(job.id).consecutiveErrors).toBe(1);

    store.markRun(job.id, { success: false });
    expect(store.getJob(job.id).consecutiveErrors).toBe(2);
  });

  it("failure 时 nextRunAt 包含退避时间", () => {
    const store = makeTmpStore();
    const job = store.addJob({ type: "every", schedule: 3600000, prompt: "test" });

    // 首次失败：consecutiveErrors=1 → 退避 1 分钟
    store.markRun(job.id, { success: false });
    const nextRun = new Date(store.getJob(job.id).nextRunAt);
    const expectedBackoff = new Date(Date.now() + 60_000);
    // nextRunAt 应该 >= 退避时间（退避 1 min vs 正常 1 hour，正常间隔更大则取正常）
    // every 3600000 的 normalNext = now + 1h，远大于退避 1 min，所以 nextRunAt = normalNext
    const normalNext = new Date(Date.now() + 3600000);
    expect(nextRun.getTime()).toBeGreaterThanOrEqual(normalNext.getTime() - 1000);
  });

  it("failure 时短间隔任务 nextRunAt 被退避推迟", () => {
    const store = makeTmpStore();
    // 60 秒间隔的任务
    const job = store.addJob({ type: "every", schedule: 60000, prompt: "test" });

    // 第 2 次失败：consecutiveErrors=2 → 退避 5 分钟（300_000 ms）
    store.markRun(job.id, { success: false }); // consecutiveErrors=1, backoff=60s
    store.markRun(job.id, { success: false }); // consecutiveErrors=2, backoff=300s

    const nextRun = new Date(store.getJob(job.id).nextRunAt);
    // normalNext = now + 60s，backoffNext = now + 300s → 取 backoffNext
    const backoffNext = new Date(Date.now() + 300_000);
    // 允许 1 秒误差
    expect(Math.abs(nextRun.getTime() - backoffNext.getTime())).toBeLessThan(1000);
  });

  it("多次失败后退避递增（3 次失败 → 退避 15 分钟）", () => {
    const store = makeTmpStore();
    const job = store.addJob({ type: "every", schedule: 60000, prompt: "test" });

    store.markRun(job.id, { success: false }); // 1 → 60s
    store.markRun(job.id, { success: false }); // 2 → 300s
    store.markRun(job.id, { success: false }); // 3 → 900s

    expect(store.getJob(job.id).consecutiveErrors).toBe(3);

    const nextRun = new Date(store.getJob(job.id).nextRunAt);
    const backoffNext = new Date(Date.now() + 900_000); // 15 分钟
    expect(Math.abs(nextRun.getTime() - backoffNext.getTime())).toBeLessThan(1000);
  });

  it("成功后退避重置", () => {
    const store = makeTmpStore();
    const job = store.addJob({ type: "every", schedule: 60000, prompt: "test" });

    // 连续失败 3 次
    store.markRun(job.id, { success: false });
    store.markRun(job.id, { success: false });
    store.markRun(job.id, { success: false });
    expect(store.getJob(job.id).consecutiveErrors).toBe(3);

    // 成功一次
    store.markRun(job.id, { success: true });
    expect(store.getJob(job.id).consecutiveErrors).toBe(0);

    // 再次失败：退避应从头开始（1 分钟，不是 15 分钟）
    store.markRun(job.id, { success: false });
    expect(store.getJob(job.id).consecutiveErrors).toBe(1);

    const nextRun = new Date(store.getJob(job.id).nextRunAt);
    // backoff[1] = 60_000，normalNext = now + 60_000，两者相同量级
    const backoffNext = new Date(Date.now() + 60_000);
    // 差值应接近 0 或正常间隔（60s），都在退避范围内
    expect(nextRun.getTime()).toBeGreaterThanOrEqual(backoffNext.getTime() - 1000);
  });

  it("退避上限为 60 分钟（超过 BACKOFF 表长度后不再增长）", () => {
    const store = makeTmpStore();
    const job = store.addJob({ type: "every", schedule: 60000, prompt: "test" });

    // 失败 10 次（超过 BACKOFF 表的 5 个元素）
    for (let i = 0; i < 10; i++) {
      store.markRun(job.id, { success: false });
    }

    expect(store.getJob(job.id).consecutiveErrors).toBe(10);
    const nextRun = new Date(store.getJob(job.id).nextRunAt);
    const maxBackoff = new Date(Date.now() + 3_600_000); // 60 分钟
    expect(Math.abs(nextRun.getTime() - maxBackoff.getTime())).toBeLessThan(1000);
  });

  it("默认参数（无 opts）等同 success=true", () => {
    const store = makeTmpStore();
    const job = store.addJob({ type: "every", schedule: 3600000, prompt: "test" });
    store.getJob(job.id).consecutiveErrors = 5;

    // 不传第二个参数
    store.markRun(job.id);
    expect(store.getJob(job.id).consecutiveErrors).toBe(0);
  });
});

// ════════════════════════════════════════════
//  cron 解析器边界
// ════════════════════════════════════════════

describe("cron 解析器边界", () => {
  it("字段值越界返回 null（70 分钟）", () => {
    const store = makeTmpStore();
    const result = store._calcNextRun("cron", "70 * * * *", new Date().toISOString());
    expect(result).toBeNull();
  });

  it("字段值越界返回 null（25 小时）", () => {
    const store = makeTmpStore();
    const result = store._calcNextRun("cron", "0 25 * * *", new Date().toISOString());
    expect(result).toBeNull();
  });

  it("反向范围返回 null", () => {
    const store = makeTmpStore();
    const result = store._calcNextRun("cron", "5-2 * * * *", new Date().toISOString());
    expect(result).toBeNull();
  });

  it("at Invalid Date 返回 null", () => {
    const store = makeTmpStore();
    const result = store._calcNextRun("at", "not-a-date", new Date().toISOString());
    expect(result).toBeNull();
  });

  it("有效 cron 表达式仍正常工作", () => {
    const store = makeTmpStore();
    const result = store._calcNextRun("cron", "0 7 * * *", new Date().toISOString());
    expect(result).not.toBeNull();
  });

  it("当 DOM 与 DOW 都受限时，按标准 cron 语义用 OR 匹配两者", () => {
    const store = makeTmpStore();
    const from = localDate(2026, 4, 2, 10, 0);
    const nextIso = store._calcNextRun("cron", "0 9 1 * 1", from.toISOString());
    expect(nextIso).not.toBeNull();

    const start = new Date(from);
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);
    let expected = null;
    for (let i = 0; i < 366 * 24 * 60; i++) {
      const t = new Date(start.getTime() + i * 60_000);
      if (t.getHours() !== 9 || t.getMinutes() !== 0) continue;
      if (t.getDate() === 1 || t.getDay() === 1) {
        expected = t.toISOString();
        break;
      }
    }

    expect(nextIso).toBe(expected);
    const next = new Date(nextIso);
    expect(next.getDate() === 1 || next.getDay() === 1).toBe(true);
  });
});

// ════════════════════════════════════════════
//  logRun 日志修剪
// ════════════════════════════════════════════

describe("CronStore logRun 日志修剪", () => {
  it("logRun 超过 500 行时修剪到 300 行", () => {
    const store = makeTmpStore();
    for (let i = 0; i < 510; i++) {
      store.logRun("job_1", { status: "success", i });
    }
    // 第 501 次写入后触发修剪（501→300），之后 502-510 再追加 9 行 = 309
    const history = store.getRunHistory("job_1", 9999);
    expect(history.length).toBeLessThanOrEqual(310);
    expect(history.length).toBeGreaterThan(0);
    // 确认确实发生了修剪（不修剪的话是 510）
    expect(history.length).toBeLessThan(500);
  });
});
