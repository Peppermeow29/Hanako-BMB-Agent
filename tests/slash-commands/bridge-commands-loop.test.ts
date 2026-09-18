import { describe, it, expect, vi } from "vitest";
import { bridgeCommands } from "../../core/slash-commands/bridge-commands.ts";
import { SlashCommandRegistry } from "../../core/slash-command-registry.ts";

const loopCmd = () => bridgeCommands.find((c) => c.name === "loop");

const D_TARGET = { kind: "desktop", sessionId: "sid-a" };

function makeController(overrides: any = {}) {
  return {
    targetFromSessionRef: vi.fn(async (_ref: any, _opts: any = {}) => D_TARGET),
    start: vi.fn(async () => ({ status: "running" })),
    stop: vi.fn(async () => ({ status: "stopped" })),
    pause: vi.fn(async () => ({ status: "paused" })),
    resume: vi.fn(async () => ({ status: "running" })),
    statusForTarget: vi.fn(() => ({
      status: "running", prompt: "watch it", turnCount: 3,
      limits: { maxTurns: 50 }, alarm: { wakeAt: Date.now() + 60_000, reason: "r" },
      pausedReason: null,
    })),
    ...overrides,
  };
}

function makeCtx(overrides: any = {}) {
  const controller = makeController(overrides.controller);
  return {
    ctx: {
      sessionRef: { kind: "desktop", agentId: "a1", sessionPath: "/s/a.jsonl", sessionId: "sid-a" },
      engine: { loopController: controller },
      reply: vi.fn(async () => {}),
      args: "",
      ...overrides.ctx,
    },
    controller,
  };
}

describe("/loop", () => {
  it("is registered with owner permission and reserved in the core name set", () => {
    const def = loopCmd();
    expect(def).toBeTruthy();
    expect(def!.permission).toBe("owner");
    expect(SlashCommandRegistry.CORE_RESERVED_NAMES.has("loop")).toBe(true);
  });

  it("starts a loop: resolves the target with ensure=true and passes the full args as prompt", async () => {
    const { ctx, controller } = makeCtx({ ctx: { args: "watch the pipeline until green" } });
    const r: any = await loopCmd()!.handler(ctx);
    expect(controller.targetFromSessionRef).toHaveBeenCalledWith(ctx.sessionRef, { ensure: true });
    expect(controller.start).toHaveBeenCalledWith(D_TARGET, "watch the pipeline until green");
    expect(r.reply).toMatch(/启动/);
  });

  it("subcommands resolve the target without ensure", async () => {
    for (const [sub, fn] of [["stop", "stop"], ["pause", "pause"], ["resume", "resume"]] as const) {
      const { ctx, controller } = makeCtx({ ctx: { args: sub } });
      await loopCmd()!.handler(ctx);
      expect(controller.targetFromSessionRef).toHaveBeenCalledWith(ctx.sessionRef, { ensure: false });
      expect((controller as any)[fn]).toHaveBeenCalledWith(
        ...(fn === "pause" ? [D_TARGET, "user"] : [D_TARGET]),
      );
    }
  });

  it("unresolvable target yields an error reply", async () => {
    const { ctx } = makeCtx({
      controller: { targetFromSessionRef: vi.fn(async () => null) },
      ctx: { args: "do x" },
    });
    const r: any = await loopCmd()!.handler(ctx);
    expect(r.error).toBeTruthy();
  });

  it("status renders progress and alarm info", async () => {
    const { ctx } = makeCtx({ ctx: { args: "status" } });
    const r: any = await loopCmd()!.handler(ctx);
    expect(r.reply).toContain("3/50");
    expect(r.reply).toContain("running");
  });

  it("bare /loop shows status when a loop exists, usage error otherwise", async () => {
    const { ctx } = makeCtx();
    const r: any = await loopCmd()!.handler(ctx);
    expect(r.reply).toContain("running");
    const none = makeCtx({ controller: { statusForTarget: vi.fn(() => null) }, ctx: { args: "" } });
    const r2: any = await loopCmd()!.handler(none.ctx);
    expect(r2.error || r2.reply).toMatch(/用法|usage/i);
  });

  it("controller errors surface as {error}", async () => {
    const { ctx } = makeCtx({
      controller: { start: vi.fn(async () => { throw new Error("loop_already_active"); }) },
      ctx: { args: "task" },
    });
    const r: any = await loopCmd()!.handler(ctx);
    expect(r.error).toContain("loop_already_active");
  });
});
