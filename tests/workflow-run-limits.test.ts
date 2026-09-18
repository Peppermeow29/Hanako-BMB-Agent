import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUN_LIMITS,
  createIdleWatchdog,
  isRetryableNodeError,
  normalizeRunLimits,
  retryDelayMs,
} from "../lib/workflow/run-limits.ts";

afterEach(() => vi.useRealTimers());

describe("normalizeRunLimits", () => {
  it("空入参 → 全默认", () => {
    expect(normalizeRunLimits(undefined)).toEqual(DEFAULT_RUN_LIMITS);
    expect(normalizeRunLimits(null)).toEqual(DEFAULT_RUN_LIMITS);
  });
  it("越界值被 clamp，非数值回默认", () => {
    const l = normalizeRunLimits({ nodeTimeoutMs: 1, idleTimeoutMs: 10 ** 9, maxConcurrent: 999, nodeRetries: 99, totalTimeoutMs: "x" });
    expect(l.nodeTimeoutMs).toBe(60_000);
    expect(l.idleTimeoutMs).toBe(60 * 60_000);
    expect(l.maxConcurrent).toBe(64);
    expect(l.nodeRetries).toBe(5);
    expect(l.totalTimeoutMs).toBe(DEFAULT_RUN_LIMITS.totalTimeoutMs);
  });
});

describe("createIdleWatchdog", () => {
  it("持续喂狗不触发；停喂 idleTimeoutMs 后触发一次", () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const dog = createIdleWatchdog({ idleTimeoutMs: 10_000, onIdleTimeout: fired });
    dog.start();
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(9_000); dog.feed(); }
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(fired).toHaveBeenCalledTimes(1);
  });
  it("stop 之后不再触发", () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const dog = createIdleWatchdog({ idleTimeoutMs: 10_000, onIdleTimeout: fired });
    dog.start();
    dog.stop();
    vi.advanceTimersByTime(60_000);
    expect(fired).not.toHaveBeenCalled();
  });
});

describe("isRetryableNodeError", () => {
  it("默认可重试（未知错误当瞬时故障处理）", () => {
    expect(isRetryableNodeError(new Error("agent 失败: 502 Bad Gateway"))).toBe(true);
    expect(isRetryableNodeError(new Error("rate limited"))).toBe(true);
  });
  it("中止 / 预算 / 总数上限 / 选项校验类不重试", () => {
    expect(isRetryableNodeError(new Error("workflow 已中止"))).toBe(false);
    expect(isRetryableNodeError(new Error("workflow token 预算耗尽（已用 1）"))).toBe(false);
    expect(isRetryableNodeError(new Error("workflow 超出 agent 总数上限 1000（防失控 backstop）"))).toBe(false);
    expect(isRetryableNodeError(new Error('workflow agent() unsupported option "task".'))).toBe(false);
    expect(isRetryableNodeError(new Error('workflow agentType "x" was not found.'))).toBe(false);
  });
  it("带非重试 code 的错误不重试（folder scope / 子代理越权）", () => {
    const scoped = Object.assign(new Error("escapes"), { code: "WRITE_FOLDER_OUTSIDE_PARENT_SCOPE" });
    const denied = Object.assign(new Error("denied"), { code: "SUBAGENT_WRITE_DENIED_BY_PARENT_READ_ONLY" });
    expect(isRetryableNodeError(scoped)).toBe(false);
    expect(isRetryableNodeError(denied)).toBe(false);
  });
  it("节点超时消息保持可重试（措辞必须避开中止/aborted）", () => {
    expect(isRetryableNodeError(new Error("节点超时（900000ms）：节点未在时限内完成"))).toBe(true);
  });
});

describe("retryDelayMs", () => {
  it("第 1 次 5s±20%，第 2+ 次 20s±20%", () => {
    for (let i = 0; i < 20; i++) {
      const d1 = retryDelayMs(1); expect(d1).toBeGreaterThanOrEqual(4_000); expect(d1).toBeLessThanOrEqual(6_000);
      const d2 = retryDelayMs(2); expect(d2).toBeGreaterThanOrEqual(16_000); expect(d2).toBeLessThanOrEqual(24_000);
    }
  });
});
