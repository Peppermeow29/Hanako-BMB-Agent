import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoopStore, LOOP_DEFAULT_LIMITS, loopKeyForTarget } from "../../lib/loop/loop-store.ts";

const tmpDirs: string[] = [];
function tmpStorePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-store-"));
  tmpDirs.push(dir);
  return path.join(dir, "loop-state.json");
}
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const D = { kind: "desktop", sessionId: "sid-a" } as const;
const B = { kind: "bridge", sessionId: "sid-b", sessionKey: "tg_dm_1@a1", agentId: "a1" } as const;

describe("loopKeyForTarget", () => {
  it("keys by sessionId for both kinds and rejects targets without one", () => {
    expect(loopKeyForTarget(D)).toBe("sid-a");
    expect(loopKeyForTarget(B)).toBe("sid-b");
    expect(() => loopKeyForTarget({ kind: "desktop" } as any)).toThrow(/sessionId/);
  });
});

describe("LoopStore", () => {
  it("creates a running loop with default limits and the target embedded", () => {
    const store = new LoopStore(tmpStorePath());
    const loop = store.create(D, "watch the pipeline");
    expect(loop.key).toBe("sid-a");
    expect(loop.target).toEqual(D);
    expect(loop.status).toBe("running");
    expect(loop.turnCount).toBe(0);
    expect(loop.consecutiveFailures).toBe(0);
    expect(loop.alarm).toBeNull();
    expect(loop.limits).toEqual(LOOP_DEFAULT_LIMITS);
  });

  it("rejects a second active loop for the same session, allows replacing a terminal one", () => {
    const store = new LoopStore(tmpStorePath());
    store.create(D, "t1");
    expect(() => store.create(D, "t2")).toThrow(/loop_already_active/);
    store.update("sid-a", { status: "stopped" });
    expect(store.create(D, "t3").prompt).toBe("t3");
  });

  it("update merges a patch, bumps updatedAt, rejects unknown keys", () => {
    const store = new LoopStore(tmpStorePath());
    const before = store.create(B, "t");
    const after = store.update("sid-b", { turnCount: 3, alarm: { wakeAt: 123, reason: "r" } });
    expect(after.turnCount).toBe(3);
    expect(after.alarm).toEqual({ wakeAt: 123, reason: "r" });
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    expect(() => store.update("sid-none", {})).toThrow(/no_loop/);
  });

  it("persists across reload and lists by status", () => {
    const p = tmpStorePath();
    const store = new LoopStore(p);
    store.create(D, "t");
    store.create(B, "t2");
    store.update("sid-b", { status: "paused", pausedReason: "user" });
    const reloaded = new LoopStore(p);
    expect(reloaded.get("sid-a")?.status).toBe("running");
    expect(reloaded.listByStatus("running").map((l) => l.key)).toEqual(["sid-a"]);
    expect(reloaded.listByStatus("paused")[0]?.pausedReason).toBe("user");
  });

  it("returned objects are clones", () => {
    const store = new LoopStore(tmpStorePath());
    const loop = store.create(D, "t");
    loop.turnCount = 999;
    expect(store.get("sid-a").turnCount).toBe(0);
  });

  it("moves a corrupt state file aside and starts empty, loudly", () => {
    const p = tmpStorePath();
    fs.writeFileSync(p, "{not json", "utf-8");
    const warnings: string[] = [];
    const store = new LoopStore(p, { log: { error: (m: string) => warnings.push(m), warn: () => {} } });
    expect(store.listByStatus("running")).toEqual([]);
    expect(warnings.some((w) => w.includes("corrupt"))).toBe(true);
    const sibling = fs.readdirSync(path.dirname(p)).find((f) => f.includes("corrupt"));
    expect(sibling).toBeTruthy();
  });
});
