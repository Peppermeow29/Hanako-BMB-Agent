/**
 * /api/health 的 sessionStore 附块契约（Task C）：
 * - 正常路径：如实转发 engine.getSessionMetadataRecoveryStatus() 的结果。
 * - 兜底路径：getter 抛错时不得让 /api/health 本身 500，必须回退成一个
 *   显式 degraded 状态，让调用方（前端）看到"探测失败"而不是把整个健康检查拖垮。
 *
 * 这是纯函数级单测（不 spin 真服务器）——真实 HTTP 层的行为锁在
 * server-composition-boundary.test.ts 的"real request smoke"里，本文件只锁
 * server/index.ts 里这个具体聚合点的契约，跑起来快、不需要真实端口。
 */
import { describe, expect, it } from "vitest";
import { resolveSessionMetadataRecoveryStatusForHealth } from "../server/index.ts";

describe("resolveSessionMetadataRecoveryStatusForHealth", () => {
  it("forwards a healthy (non-degraded) status as-is", () => {
    const engine = { getSessionMetadataRecoveryStatus: () => ({ degraded: false, reasons: [] }) };
    expect(resolveSessionMetadataRecoveryStatusForHealth(engine)).toEqual({ degraded: false, reasons: [] });
  });

  it("forwards a degraded status as-is", () => {
    const degraded = { degraded: true, reasons: [{ kind: "meta_quarantined", detail: "hana/session-meta.json" }] };
    const engine = { getSessionMetadataRecoveryStatus: () => degraded };
    expect(resolveSessionMetadataRecoveryStatusForHealth(engine)).toEqual(degraded);
  });

  it("falls back to a degraded probe-failed status instead of throwing when the getter throws", () => {
    const engine = { getSessionMetadataRecoveryStatus: () => { throw new Error("boom"); } };
    expect(() => resolveSessionMetadataRecoveryStatusForHealth(engine)).not.toThrow();
    expect(resolveSessionMetadataRecoveryStatusForHealth(engine)).toEqual({
      degraded: true,
      reasons: [{ kind: "store_unavailable", detail: "recovery status probe failed" }],
    });
  });

  it("falls back the same way when the engine (or the method) is missing entirely", () => {
    expect(resolveSessionMetadataRecoveryStatusForHealth({} as any)).toEqual({
      degraded: true,
      reasons: [{ kind: "store_unavailable", detail: "recovery status probe failed" }],
    });
  });
});
