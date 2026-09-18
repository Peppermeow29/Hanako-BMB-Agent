import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoopStore } from "../../lib/loop/loop-store.ts";
import { LoopAlarmService } from "../../lib/loop/alarm-service.ts";
import { LoopController, LoopError } from "../../lib/loop/loop-controller.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const D = { kind: "desktop", sessionId: "sid-a" } as const;
const DK = "sid-a";
const D_PATH = "/s/a.jsonl";
const B = { kind: "bridge", sessionId: "sid-b", sessionKey: "tg_dm_1@a1", agentId: "a1" } as const;
const BK = "sid-b";
const B_PATH = "/agents/a1/bridge/owner/x.jsonl";
const PATH_TO_ID: Record<string, string> = { [D_PATH]: "sid-a", [B_PATH]: "sid-b" };

function makeHarness(overrides: any = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopctl-"));
  tmpDirs.push(dir);
  const store = new LoopStore(path.join(dir, "loop-state.json"));
  const delivered: any[] = [];
  const notices: any[] = [];
  const deliverLoopMessage = overrides.deliverLoopMessage
    ?? vi.fn(async (target, msg) => { delivered.push([target, msg]); return { ok: true, mode: "triggerTurn" }; });
  const hasLiveBackgroundWork = overrides.hasLiveBackgroundWork ?? (() => false);
  const controller = new LoopController({
    store,
    hasLiveBackgroundWork,
    deliverLoopMessage,
    recordNotice: async (target, msg) => { notices.push([target, msg]); return { ok: true, mode: "notifyOnly" }; },
    isTargetMidStream: overrides.isTargetMidStream ?? (() => false),
    isTargetRunnable: overrides.isTargetRunnable ?? (() => true),
    resolveSessionIdForPath: overrides.resolveSessionIdForPath ?? ((sp: string) => PATH_TO_ID[sp] ?? null),
    resolveTargetFromSessionRef: overrides.resolveTargetFromSessionRef ?? (async () => null),
    log: { warn: () => {}, error: () => {}, info: () => {} } as any,
  });
  const alarm = new LoopAlarmService({
    store,
    hasLiveBackgroundWork,
    deliverWakeup: (key, reason) => controller.deliverWakeupTurn(key, reason),
    hooks: { onDeliveryExhausted: (key, err) => controller.pauseForDeliveryFailure(key, err) },
    log: { warn: () => {} } as any,
  });
  controller.attachAlarm(alarm);
  return { store, controller, alarm, delivered, notices, deliverLoopMessage };
}

async function runTurn(controller, sessionPath, { error = false, aborted = false } = {}) {
  controller.onTurnStart(sessionPath);
  if (error) controller.onMessageEnd(sessionPath, "error");
  await controller.onTurnEnd(sessionPath, { aborted });
}

describe("start / 记账 / 守恒", () => {
  it("start creates the loop and injects a kickoff turn", async () => {
    const { controller, store, delivered } = makeHarness();
    await controller.start(D, "watch the pipeline");
    expect(store.get(DK).status).toBe("running");
    expect(delivered.length).toBe(1);
    expect(delivered[0][0]).toEqual(D);
    expect(delivered[0][1].details.kind).toBe("kickoff");
  });

  it("counts only loop-triggered turns against the budget", async () => {
    const { controller, store } = makeHarness();
    await controller.start(D, "t");
    await runTurn(controller, D_PATH);             // kickoff 触发 → 计数
    await runTurn(controller, D_PATH);             // 用户轮 → 不计
    expect(store.get(DK).turnCount).toBe(1);
  });

  it("守恒检查：轮结束既无闹钟也无后台任务 → 自动补兜底闹钟", async () => {
    vi.useFakeTimers();
    const { controller, store } = makeHarness();
    await controller.start(D, "t");
    await runTurn(controller, D_PATH);
    const alarm = store.get(DK).alarm;
    expect(alarm).not.toBeNull();
    expect(alarm.wakeAt - Date.now()).toBeGreaterThanOrEqual(1200 * 1000 - 1000);
  });

  it("守恒检查：有活跃后台任务时不补闹钟", async () => {
    const { controller, store } = makeHarness({ hasLiveBackgroundWork: () => true });
    await controller.start(D, "t");
    await runTurn(controller, D_PATH);
    expect(store.get(DK).alarm).toBeNull();
  });

  it("目标仍在续流时跳过守恒检查", async () => {
    const { controller, store } = makeHarness({ isTargetMidStream: () => true });
    await controller.start(D, "t");
    await runTurn(controller, D_PATH);
    expect(store.get(DK).alarm).toBeNull();
  });
});

describe("bridge 目标：统一 sessionId 解析", () => {
  it("bridge 轮的事件经 path→sessionId 归位", async () => {
    const { controller, store } = makeHarness();
    await controller.start(B, "t");
    await runTurn(controller, B_PATH);
    expect(store.get(BK).turnCount).toBe(1);
  });

  it("解析不到的 sessionPath 不影响任何循环", async () => {
    const { controller, store } = makeHarness();
    await controller.start(B, "t");
    await runTurn(controller, "/some/unrelated.jsonl");
    expect(store.get(BK).turnCount).toBe(0);
  });

  it("bridge 轮内的 loop_control 经工具面 sessionPath 解析", async () => {
    const { controller, store } = makeHarness();
    await controller.start(B, "t");
    const r = controller.toolSchedule(B_PATH, 1800, "next check");
    expect(r.effectiveDelaySec).toBe(1800);
    expect(store.get(BK).alarm).not.toBeNull();
    await controller.toolComplete(B_PATH, "done");
    expect(store.get(BK).status).toBe("completed");
  });

  it("无循环的 sessionPath 走工具面直接抛 no_active_loop", () => {
    const { controller } = makeHarness();
    expect(() => controller.toolSchedule("/s/none.jsonl", 300, "r")).toThrow(LoopError);
  });
});

describe("护栏", () => {
  it("连续失败达上限 → 自动暂停并通知", async () => {
    const { controller, store, notices } = makeHarness();
    await controller.start(D, "t");
    await runTurn(controller, D_PATH, { error: true });
    for (let i = 0; i < 2; i++) {
      controller.markPendingLoopTurnForTest(DK);
      await runTurn(controller, D_PATH, { error: true });
    }
    const loop = store.get(DK);
    expect(loop.status).toBe("paused");
    expect(loop.pausedReason).toBe("consecutive_failures");
    expect(notices.length).toBeGreaterThan(0);
  });

  it("成功轮清零连续失败计数", async () => {
    const { controller, store } = makeHarness();
    await controller.start(D, "t");
    await runTurn(controller, D_PATH, { error: true });
    controller.markPendingLoopTurnForTest(DK);
    await runTurn(controller, D_PATH);
    expect(store.get(DK).consecutiveFailures).toBe(0);
  });

  it("轮数预算耗尽 → 暂停，resume 重置轮数后继续", async () => {
    const { controller, store } = makeHarness();
    await controller.start(D, "t");
    store.update(DK, { turnCount: 49 });
    controller.markPendingLoopTurnForTest(DK);
    await runTurn(controller, D_PATH);
    expect(store.get(DK).status).toBe("paused");
    expect(store.get(DK).pausedReason).toBe("budget_exhausted");
    await controller.resume(D);
    const resumed = store.get(DK);
    expect(resumed.status).toBe("running");
    expect(resumed.turnCount).toBe(0);
    expect(resumed.consecutiveFailures).toBe(0);
  });

  it("abort 的轮计为失败", async () => {
    const { controller, store } = makeHarness();
    await controller.start(D, "t");
    await runTurn(controller, D_PATH, { aborted: true });
    expect(store.get(DK).consecutiveFailures).toBe(1);
  });
});

describe("complete / stop / wakeup / 身份换代 / 投递失败", () => {
  it("toolComplete ends the loop and cancels the alarm", async () => {
    const { controller, store } = makeHarness();
    await controller.start(D, "t");
    controller.toolSchedule(D_PATH, 1200, "next check");
    await controller.toolComplete(D_PATH, "goal achieved");
    const loop = store.get(DK);
    expect(loop.status).toBe("completed");
    expect(loop.completedSummary).toBe("goal achieved");
    expect(loop.alarm).toBeNull();
  });

  it("deliverWakeupTurn injects a wakeup and the turn is counted", async () => {
    const { controller, store, delivered } = makeHarness();
    await controller.start(D, "t");
    await runTurn(controller, D_PATH);
    await controller.deliverWakeupTurn(DK, "check now");
    expect(delivered.at(-1)[1].details.kind).toBe("wakeup");
    await runTurn(controller, D_PATH);
    expect(store.get(DK).turnCount).toBe(2);
  });

  it("followUp 投递把当前轮标记为循环轮", async () => {
    const { controller, store } = makeHarness({
      deliverLoopMessage: vi.fn(async () => ({ ok: true, mode: "followUp" })),
    });
    await controller.start(D, "t");
    await controller.onTurnEnd(D_PATH, {});
    expect(store.get(DK).turnCount).toBe(1);
  });

  it("busy 投递不留下 pending 标记", async () => {
    const { controller, store } = makeHarness({
      deliverLoopMessage: vi.fn(async () => ({ mode: "busy" })),
    });
    await controller.start(B, "t");
    await runTurn(controller, B_PATH);
    expect(store.get(BK).turnCount).toBe(0);
  });

  it("身份换代：投递层抛 loop_target_reset → 循环终止并尽力通知，返回终态 stopped", async () => {
    const err: any = new Error("session was reset");
    err.code = "loop_target_reset";
    const { controller, store, notices } = makeHarness({
      deliverLoopMessage: vi.fn()
        .mockResolvedValueOnce({ ok: true, mode: "triggerTurn" })   // kickoff 正常
        .mockRejectedValueOnce(err),                                 // 唤醒时会话已重置
    });
    await controller.start(B, "t");
    const r = await controller.deliverWakeupTurn(BK, "check");
    expect(r).toEqual({ mode: "stopped" });
    expect(store.get(BK).status).toBe("stopped");
    expect(store.get(BK).pausedReason).toBe("session_reset");
    expect(notices.length).toBe(1);
  });

  it("pauseForDeliveryFailure 暂停并注明原因（fail-closed）", async () => {
    const { controller, store } = makeHarness();
    await controller.start(D, "t");
    controller.pauseForDeliveryFailure(DK, new Error("boom"));
    await Promise.resolve();
    expect(store.get(DK).status).toBe("paused");
    expect(store.get(DK).pausedReason).toBe("wakeup_delivery_failed");
  });

  it("stop terminates and further bus events are no-ops", async () => {
    const { controller, store } = makeHarness();
    await controller.start(D, "t");
    await controller.stop(D);
    expect(store.get(DK).status).toBe("stopped");
    await runTurn(controller, D_PATH);
    expect(store.get(DK).turnCount).toBe(0);
  });
});

describe("recoverAtBoot", () => {
  it("不可运行的目标转 stopped；可运行但无闹钟的补兜底", async () => {
    vi.useFakeTimers();
    const { controller, store } = makeHarness({
      isTargetRunnable: (target: any) => target.kind !== "bridge",
    });
    store.create(B, "t1");
    store.create(D, "t2");
    controller.recoverAtBoot();
    expect(store.get(BK).status).toBe("stopped");
    expect(store.get(DK).alarm).not.toBeNull();
  });
});
