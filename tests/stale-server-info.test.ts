/**
 * 测试 startServer 发现残留 server-info.json 时的处置决策（Windows 残留
 * hana-server.exe 占用端口导致启动死循环的修复）。
 *
 * 场景动机：startServer 发现「活着但验证不通过」的残留 server 时，原逻辑
 * 无条件删除 server-info.json（唯一定位线索），随后盲目 spawn 撞
 * EADDRINUSE，形成每次启动都失败的死循环。这里把「是否删文件 / 是否
 * fail-fast」的决策抽成纯函数，独立验证。
 */
import { describe, it, expect } from "vitest";
import { resolveStaleServerInfoDisposition } from "../desktop/src/shared/stale-server-info.cjs";

describe("resolveStaleServerInfoDisposition", () => {
  it("活着且占目标端口：保留文件、快速失败", () => {
    expect(resolveStaleServerInfoDisposition({ pidAlive: true, knownDead: false, portConflict: true }))
      .toEqual({ removeInfoFile: false, failFast: true });
  });

  it("活着但端口不冲突：保留文件、继续 spawn", () => {
    expect(resolveStaleServerInfoDisposition({ pidAlive: true, knownDead: false, portConflict: false }))
      .toEqual({ removeInfoFile: false, failFast: false });
  });

  it("期望端口配置不可读：无法排除冲突，保守快速失败", () => {
    expect(resolveStaleServerInfoDisposition({ pidAlive: true, knownDead: false, portConflict: null }))
      .toEqual({ removeInfoFile: false, failFast: true });
  });

  it("已确认死亡：可删", () => {
    expect(resolveStaleServerInfoDisposition({ pidAlive: true, knownDead: true, portConflict: true }))
      .toEqual({ removeInfoFile: true, failFast: false });
  });

  it("PID 已死：可删", () => {
    expect(resolveStaleServerInfoDisposition({ pidAlive: false, knownDead: false, portConflict: false }))
      .toEqual({ removeInfoFile: true, failFast: false });
  });
});
