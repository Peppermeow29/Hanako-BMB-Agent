// tests/workflow-integration.test.ts
import { describe, expect, it, vi } from "vitest";
import { runWorkflowScript } from "../lib/workflow/sandbox.ts";
import { createHostApi } from "../lib/workflow/host-api.ts";
import { createLimiter } from "../lib/workflow/concurrency.ts";

function makeHost(executeIsolated, over: any = {}) {
  return createHostApi({
    executeIsolated,
    baseIsoOpts: { agentId: "a1", parentSessionPath: "/s.jsonl", cwd: "/w" },
    limiter: createLimiter({ maxConcurrent: 4, maxTotal: 100 }),
    onProgress: over.onProgress || (() => {}),
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    args: over.args,
  });
}

const META = `export const meta = { name: 'demo', description: 'd' }\n`;

describe("workflow end-to-end (mock executeIsolated)", () => {
  it("loop-until-count 脚本跑通", async () => {
    const exec = vi.fn(async () => ({ replyText: "bug", error: null }));
    const script = META + `
      const out = [];
      while (out.length < 3) { out.push(await agent('find a bug', { access: 'read' })); }
      return out;
    `;
    const { result } = await runWorkflowScript(script, makeHost(exec));
    expect(result).toEqual(["bug", "bug", "bug"]);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("parallel + schema 的 fan-out 脚本跑通", async () => {
    const exec = vi.fn(async (p, o) => {
      const tool = o.extraCustomTools?.find((t) => t.name === "structured_output");
      if (tool) await tool.execute("c", { ok: true, file: p });
      return { replyText: "", error: null };
    });
    const script = META + `
      const files = ['a.js', 'b.js', 'c.js'];
      const found = await parallel(files.map((f) => () =>
        agent('audit ' + f, { access: 'read', schema: { type: 'object', properties: { ok: { type: 'boolean' }, file: { type: 'string' } } } })
      ));
      return found.filter((x) => x && x.ok).length;
    `;
    const { result } = await runWorkflowScript(script, makeHost(exec));
    expect(result).toBe(3);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("args 透传给脚本", async () => {
    const host = makeHost(async () => ({ replyText: "", error: null }), { args: { target: 42 } });
    const { result } = await runWorkflowScript(META + `return args.target`, host);
    expect(result).toBe(42);
  });

  it("未 await 的 agent() 调用会让 workflow 失败且不会启动该节点", async () => {
    const exec = vi.fn(async () => ({ replyText: "bug", error: null }));
    const script = META + `
      const read = agent('read README', { access: 'read' });
      return 'done';
    `;

    await expect(runWorkflowScript(script, makeHost(exec)))
      .rejects.toThrow(/agent\(\).*await|await.*agent\(\)/i);
    expect(exec).not.toHaveBeenCalled();
  });

  it("未知 agent() option 即使未 await 也会同步失败", async () => {
    const exec = vi.fn(async () => ({ replyText: "bug", error: null }));
    const script = META + `
      const read = agent('hanako', { task: '读取 README', access: 'read' });
      return 'done';
    `;

    await expect(runWorkflowScript(script, makeHost(exec)))
      .rejects.toThrow(/unsupported.*task|不支持.*task/i);
    expect(exec).not.toHaveBeenCalled();
  });

  it("读取 agent().result 会立即失败，避免把 Promise 当结果拼进后续任务", async () => {
    const exec = vi.fn(async () => ({ replyText: "bug", error: null }));
    const script = META + `
      const read = agent('read README', { access: 'read' });
      return read.result;
    `;

    await expect(runWorkflowScript(script, makeHost(exec)))
      .rejects.toThrow(/await agent\(\).*result|agent\(\).*Promise/i);
    expect(exec).not.toHaveBeenCalled();
  });
});
