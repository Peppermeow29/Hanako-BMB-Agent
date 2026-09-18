import { afterEach, describe, expect, it, vi } from "vitest";
import { createCronScheduler, DEFAULT_CRON_EXECUTION_TIMEOUT_MS } from "../lib/desk/cron-scheduler.ts";
import { AUTOMATION_SCHEMA_VERSION } from "../lib/desk/automation-normalizer.ts";

function createStore(job) {
  const calls = {
    runs: [],
    marks: [],
  };

  return {
    calls,
    store: {
      listJobs() {
        return [job];
      },
      getJob(id) {
        return id === job.id ? job : null;
      },
      logRun(id, run) {
        calls.runs.push({ id, run });
      },
      markRun(id) {
        calls.marks.push(id);
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("cron-scheduler", () => {
  it("默认把 cron 执行超时上限设为 20 分钟", () => {
    expect(DEFAULT_CRON_EXECUTION_TIMEOUT_MS).toBe(20 * 60 * 1000);
  });

  it("执行成功时记录 success", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = {
      id: "job_1",
      label: "测试任务",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const { store, calls } = createStore(job);
    const done = [];
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => {},
      onJobDone: (j, result) => done.push({ id: j.id, result }),
    } as any);

    await scheduler.checkJobs();

    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].id).toBe("job_1");
    expect(calls.runs[0].run.status).toBe("success");
    expect(calls.marks).toEqual(["job_1"]);
    expect(done).toEqual([{ id: "job_1", result: { status: "success" } }]);
  });

  it("执行成功时把 executor 结果写入 run history 和 done event", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = {
      id: "job_direct",
      label: "通知任务",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const { store, calls } = createStore(job);
    const done = [];
    const executionResult = {
      status: "forged",
      startedAt: "forged",
      finishedAt: "forged",
      executorKind: "direct_action",
      action: "notify",
      delivery: { ok: true, deliveries: [{ channel: "desktop", status: "sent" }] },
    };
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => executionResult,
      onJobDone: (j, result) => done.push({ id: j.id, result }),
    } as any);

    await scheduler.checkJobs();

    expect(calls.runs[0].run).toMatchObject({
      status: "success",
      executorKind: "direct_action",
      action: "notify",
      delivery: { ok: true, deliveries: [{ channel: "desktop", status: "sent" }] },
    });
    expect(calls.runs[0].run.startedAt).not.toBe("forged");
    expect(calls.runs[0].run.finishedAt).not.toBe("forged");
    expect(done).toEqual([{ id: "job_direct", result: { ...executionResult, status: "success" } }]);
  });

  it("执行抛错时记录 error 和错误信息", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = {
      id: "job_2",
      label: "失败任务",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const { store, calls } = createStore(job);
    const done = [];
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => {
        throw new Error("boom");
      },
      onJobDone: (j, result) => done.push({ id: j.id, result }),
    } as any);

    await scheduler.checkJobs();

    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].id).toBe("job_2");
    expect(calls.runs[0].run.status).toBe("error");
    expect(calls.runs[0].run.error).toBe("boom");
    expect(calls.marks).toEqual(["job_2"]);
    expect(done).toEqual([{ id: "job_2", result: { status: "error", error: "boom" } }]);
  });

  it("executeJob 抛 skipped 错误时记录 skipped，不推进 nextRunAt", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = {
      id: "job_3",
      label: "跳过任务",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const { store, calls } = createStore(job);
    const done = [];
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: async () => {
        const err = new Error("agent 正在执行另一个 cron");
        (err as any).skipped = true;
        throw err;
      },
      onJobDone: (j, result) => done.push({ id: j.id, result }),
    } as any);

    await scheduler.checkJobs();

    // 应该记录 skipped 状态
    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].id).toBe("job_3");
    expect(calls.runs[0].run.status).toBe("skipped");

    // 关键：markRun 不应被调用（不推进 nextRunAt，下次重试）
    expect(calls.marks).toEqual([]);

    expect(done).toEqual([{ id: "job_3", result: { status: "skipped" } }]);
  });

  it("执行超过上限时 abort job 并记录 timeout 错误", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const job = {
      id: "job_timeout",
      label: "超时任务",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const { store, calls } = createStore(job);
    const abortJob = vi.fn();
    const done = [];
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: () => new Promise(() => {}),
      abortJob,
      onJobDone: (j, result) => done.push({ id: j.id, result }),
      executionTimeoutMs: 100,
    });

    const check = scheduler.checkJobs();
    await vi.advanceTimersByTimeAsync(100);
    await check;

    expect(abortJob).toHaveBeenCalledWith(job);
    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0].run.status).toBe("error");
    expect(calls.runs[0].run.error).toBe("execution timeout (100ms)");
    expect(calls.marks).toEqual(["job_timeout"]);
    expect(done).toEqual([
      { id: "job_timeout", result: { status: "error", error: "execution timeout (100ms)" } },
    ]);
  });

  it("captures one Studio store for list, execute, log, and cursor updates", async () => {
    const job = {
      studioId: "studio-a",
      id: "studio_job_1",
      configRevision: 1,
      label: "A job",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const a = {
      listJobs: vi.fn(() => [job]),
      getJob: vi.fn(() => job),
      logRun: vi.fn(),
      markRun: vi.fn(() => true),
    };
    const b = {
      listJobs: vi.fn(() => []),
      getJob: vi.fn(),
      logRun: vi.fn(),
      markRun: vi.fn(),
    };
    let current = a;
    const service = { captureCurrent: vi.fn(() => current) };
    const scheduler = createCronScheduler({
      cronStore: service,
      executeJob: vi.fn(async () => {
        current = b;
      }),
    } as any);

    await scheduler.checkJobs();

    expect(service.captureCurrent).toHaveBeenCalledOnce();
    expect(a.logRun).toHaveBeenCalledOnce();
    expect(a.markRun).toHaveBeenCalledWith(job.id, {
      success: true,
      expectedConfigRevision: 1,
    });
    expect(b.logRun).not.toHaveBeenCalled();
    expect(b.markRun).not.toHaveBeenCalled();
  });

  it("re-reads queued jobs and does not execute a deleted stale snapshot", async () => {
    const due = new Date(Date.now() - 1000).toISOString();
    const first = { id: "job_1", configRevision: 1, label: "first", enabled: true, nextRunAt: due };
    const second = { id: "job_2", configRevision: 1, label: "second", enabled: true, nextRunAt: due };
    const liveJobs = new Map([[first.id, first], [second.id, second]]);
    const executed: string[] = [];
    const store = {
      listJobs: vi.fn(() => [first, second]),
      getJob: vi.fn((id) => liveJobs.get(id) || null),
      markRun: vi.fn(() => true),
      logRun: vi.fn(),
    };
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: vi.fn(async (job) => {
        executed.push(job.id);
        if (job.id === first.id) liveJobs.delete(second.id);
      }),
    } as any);

    await scheduler.checkJobs();

    expect(executed).toEqual([first.id]);
    expect(store.getJob).toHaveBeenCalledWith(second.id);
  });

  it("records a stale run without advancing a newer configuration revision", async () => {
    const job = {
      id: "job_stale",
      configRevision: 4,
      label: "stale",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const store = {
      listJobs: vi.fn(() => [job]),
      getJob: vi.fn(() => job),
      markRun: vi.fn(() => false),
      logRun: vi.fn(),
    };
    const done = vi.fn();
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob: vi.fn(async () => ({ status: "forged" })),
      onJobDone: done,
    } as any);

    await scheduler.checkJobs();

    expect(store.markRun).toHaveBeenCalledWith(job.id, {
      success: true,
      expectedConfigRevision: 4,
    });
    expect(store.logRun).toHaveBeenCalledWith(job.id, expect.objectContaining({
      status: "success",
      staleConfigRevision: true,
    }));
    expect(done).toHaveBeenCalledWith(job, expect.objectContaining({
      status: "success",
      staleConfigRevision: true,
    }));
  });

  it("does not execute a future automation schema or advance its cursor", async () => {
    const job = {
      id: "job_future_schema",
      schemaVersion: AUTOMATION_SCHEMA_VERSION + 1,
      configRevision: 1,
      label: "future",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    };
    const store = {
      listJobs: vi.fn(() => [job]),
      getJob: vi.fn(() => job),
      markRun: vi.fn(),
      logRun: vi.fn(),
    };
    const executeJob = vi.fn();
    const done = vi.fn();
    const scheduler = createCronScheduler({
      cronStore: store,
      executeJob,
      onJobDone: done,
    } as any);

    await scheduler.checkJobs();

    expect(executeJob).not.toHaveBeenCalled();
    expect(store.markRun).not.toHaveBeenCalled();
    expect(store.logRun).toHaveBeenCalledWith(job.id, expect.objectContaining({
      status: "skipped",
      reason: "unsupported_automation_schema",
      schemaVersion: AUTOMATION_SCHEMA_VERSION + 1,
    }));
    expect(done).toHaveBeenCalledWith(job, {
      status: "skipped",
      reason: "unsupported_automation_schema",
      schemaVersion: AUTOMATION_SCHEMA_VERSION + 1,
    });
  });
});
