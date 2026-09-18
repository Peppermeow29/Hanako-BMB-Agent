import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoopStore } from "../../lib/loop/loop-store.ts";
import { LoopAlarmService, LoopAlarmError } from "../../lib/loop/alarm-service.ts";

const tmpDirs: string[] = [];
function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alarm-"));
  tmpDirs.push(dir);
  return new LoopStore(path.join(dir, "loop-state.json"));
}
afterEach(() => {
  vi.useRealTimers();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const D = { kind: "desktop", sessionId: "sid-a" } as const;
const DK = "sid-a";

function makeService(store, overrides: any = {}) {
  const calls = { delivered: [] as any[], exhausted: [] as any[] };
  const service = new LoopAlarmService({
    store,
    hasLiveBackgroundWork: overrides.hasLiveBackgroundWork ?? (() => false),
    deliverWakeup: overrides.deliverWakeup
      ?? (async (key, reason) => { calls.delivered.push([key, reason]); return { ok: true, mode: "triggerTurn" }; }),
    hooks: {
      onDeliveryExhausted: (key, err) => calls.exhausted.push([key, err]),
    },
    log: { warn: () => {}, error: () => {} } as any,
  });
  return { service, calls };
}

describe("LoopAlarmService.schedule", () => {
  it("clamps below-minimum delays up to minDelaySec", () => {
    const store = makeStore();
    store.create(D, "t");
    const { service } = makeService(store);
    const r = service.schedule(DK, 1, "why");
    expect(r.effectiveDelaySec).toBe(60);
    expect(store.get(DK).alarm.reason).toBe("why");
  });

  it("rejects a short alarm while background work is live", () => {
    const store = makeStore();
    store.create(D, "t");
    const { service } = makeService(store, { hasLiveBackgroundWork: () => true });
    try {
      service.schedule(DK, 300, "poll");
      expect.unreachable("should throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(LoopAlarmError);
      expect(err.code).toBe("short_alarm_with_live_work");
    }
    expect(service.schedule(DK, 1200, "fallback").effectiveDelaySec).toBe(1200);
  });

  it("rejects when no loop or loop not running", () => {
    const store = makeStore();
    const { service } = makeService(store);
    expect(() => service.schedule("sid-none", 120, "r")).toThrow(/no_active_loop/);
    store.create(D, "t");
    store.update(DK, { status: "paused" });
    expect(() => service.schedule(DK, 120, "r")).toThrow(/loop_not_running/);
  });

  it("replaces the previous alarm (single slot)", async () => {
    vi.useFakeTimers();
    const store = makeStore();
    store.create(D, "t");
    const { service, calls } = makeService(store);
    service.schedule(DK, 60, "first");
    service.schedule(DK, 120, "second");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(calls.delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.delivered).toEqual([[DK, "second"]]);
    expect(store.get(DK).alarm).toBeNull();       // 触发即清槽
  });
});

describe("LoopAlarmService fire & retry", () => {
  it("does not fire for a loop that is no longer running", async () => {
    vi.useFakeTimers();
    const store = makeStore();
    store.create(D, "t");
    const { service, calls } = makeService(store);
    service.schedule(DK, 60, "r");
    store.update(DK, { status: "stopped" });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(calls.delivered).toEqual([]);
  });

  it("retries failed delivery then reports exhaustion (fail-closed)", async () => {
    vi.useFakeTimers();
    const store = makeStore();
    store.create(D, "t");
    let attempts = 0;
    const { service, calls } = makeService(store, {
      deliverWakeup: async () => { attempts++; throw new Error("delivery boom"); },
    });
    service.schedule(DK, 60, "r");
    await vi.advanceTimersByTimeAsync(61_000 + 5_000 + 25_000 + 125_000 + 1_000);
    expect(attempts).toBe(4);                     // 首次 + 3 次重试
    expect(calls.exhausted.length).toBe(1);
    expect(calls.exhausted[0][0]).toBe(DK);
  });

  it("a terminal delivery mode (e.g. stopped) is final: no retry, no exhaustion", async () => {
    vi.useFakeTimers();
    const store = makeStore();
    store.create(D, "t");
    let attempts = 0;
    const { service, calls } = makeService(store, {
      deliverWakeup: async () => { attempts++; return { mode: "stopped" }; },
    });
    service.schedule(DK, 60, "r");
    await vi.advanceTimersByTimeAsync(200_000);
    expect(attempts).toBe(1);
    expect(calls.exhausted).toEqual([]);
  });

  it("busy delivery defers the alarm by 60s and eventually fires", async () => {
    vi.useFakeTimers();
    const store = makeStore();
    store.create(D, "t");
    let busyTimes = 2;
    const delivered: any[] = [];
    const { service, calls } = makeService(store, {
      deliverWakeup: async (key: string, reason: string) => {
        if (busyTimes-- > 0) return { mode: "busy" };
        delivered.push([key, reason]);
        return { mode: "triggerTurn" };
      },
    });
    service.schedule(DK, 60, "r");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(delivered).toEqual([]);
    expect(store.get(DK).alarm).not.toBeNull();   // busy 顺延要把槽写回去
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(delivered).toEqual([[DK, "r"]]);
    expect(calls.exhausted).toEqual([]);
  });

  it("busy deferrals are bounded and then fail closed", async () => {
    vi.useFakeTimers();
    const store = makeStore();
    store.create(D, "t");
    const { service, calls } = makeService(store, {
      deliverWakeup: async () => ({ mode: "busy" }),
    });
    service.schedule(DK, 60, "r");
    await vi.advanceTimersByTimeAsync(61_000 + 31 * 61_000);
    expect(calls.exhausted.length).toBe(1);
  });
});

describe("LoopAlarmService.rehydrate", () => {
  it("re-arms stored alarms and fires overdue ones after a short jitter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00Z"));
    const store = makeStore();
    store.create(D, "t");
    store.update(DK, { alarm: { wakeAt: Date.now() - 10_000, reason: "overdue" } });
    const { service, calls } = makeService(store);
    service.rehydrate();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(calls.delivered).toEqual([[DK, "overdue"]]);
  });
});

describe("LoopAlarmService.cancel / dispose", () => {
  it("cancel clears both the timer and the stored slot", async () => {
    vi.useFakeTimers();
    const store = makeStore();
    store.create(D, "t");
    const { service, calls } = makeService(store);
    service.schedule(DK, 60, "r");
    service.cancel(DK);
    expect(store.get(DK).alarm).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls.delivered).toEqual([]);
  });
});
