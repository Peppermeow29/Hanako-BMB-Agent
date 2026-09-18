import { describe, it, expect } from "vitest";
import { createLoopControlTool } from "../../lib/tools/loop-control-tool.ts";
import { LoopAlarmError } from "../../lib/loop/alarm-service.ts";

function makeTool(controller: any) {
  return createLoopControlTool({ getLoopController: () => controller });
}
// ctx 形状对齐 getToolSessionPath（lib/tools/tool-session.ts）；桥接轮内同样成立
const ctx = { sessionManager: { getSessionFile: () => "/s/a.jsonl" } };

async function run(tool: any, params: any, context: any = ctx) {
  const result = await tool.execute("tc1", params, null, null, context);
  return result.content[0].text;
}

describe("loop_control", () => {
  it("declares its own session permission", () => {
    const tool = makeTool(null);
    expect(tool.name).toBe("loop_control");
    expect(tool.sessionPermission.resolveInvocation()).toMatchObject({ kind: "routine" });
  });

  it("rejects when the loop service is missing or no loop is active (execute-layer gate)", async () => {
    expect(await run(makeTool(null), { action: "schedule", delay_seconds: 300 })).toMatch(/not.*available|未就绪/i);
    const controller = {
      toolStatus: () => null,
      toolSchedule: () => { throw new Error("should not reach"); },
    };
    expect(await run(makeTool(controller), { action: "schedule", delay_seconds: 300 }))
      .toMatch(/no active loop|没有.*循环/i);
  });

  it("rejects without a session path", async () => {
    const controller = { toolStatus: () => ({ status: "running" }) };
    // 默认 locale 为 zh（lib/i18n.ts），断言与同文件其它用例一致按中英双语写
    expect(await run(makeTool(controller), { action: "schedule", delay_seconds: 300 }, {}))
      .toMatch(/session|会话/i);
  });

  it("schedule forwards to the controller and reports the effective delay", async () => {
    const calls: any[] = [];
    const controller = {
      toolStatus: () => ({ status: "running" }),
      toolSchedule: (sp: string, d: number, r: string) => {
        calls.push([sp, d, r]);
        return { wakeAt: Date.now() + d * 1000, effectiveDelaySec: d };
      },
    };
    const text = await run(makeTool(controller), { action: "schedule", delay_seconds: 1800, reason: "poll remote state" });
    expect(calls).toEqual([["/s/a.jsonl", 1800, "poll remote state"]]);
    expect(text).toContain("1800");
  });

  it("schedule surfaces the guarded rejection as an educational tool error, not a throw", async () => {
    const controller = {
      toolStatus: () => ({ status: "running" }),
      toolSchedule: () => {
        throw new LoopAlarmError("short_alarm_with_live_work", "Background work wakes this session automatically.");
      },
    };
    const text = await run(makeTool(controller), { action: "schedule", delay_seconds: 120 });
    expect(text).toContain("Background work wakes this session automatically.");
  });

  it("schedule requires delay_seconds", async () => {
    const controller = { toolStatus: () => ({ status: "running" }) };
    expect(await run(makeTool(controller), { action: "schedule" })).toMatch(/delay_seconds/);
  });

  it("complete forwards the summary", async () => {
    const calls: any[] = [];
    const controller = {
      toolStatus: () => ({ status: "running" }),
      toolComplete: async (sp: string, s: string) => { calls.push([sp, s]); return { status: "completed" }; },
    };
    const text = await run(makeTool(controller), { action: "complete", reason: "goal achieved" });
    expect(calls).toEqual([["/s/a.jsonl", "goal achieved"]]);
    expect(text).toMatch(/completed|已完成/i);
  });
});
