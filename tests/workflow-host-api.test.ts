import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createHostApi } from "../lib/workflow/host-api.ts";
import { createLimiter } from "../lib/workflow/concurrency.ts";

export function makeDeps( over: any = {}) {
  return {
    executeIsolated: over.executeIsolated || (async () => ({ replyText: "ok", error: null })),
    baseIsoOpts: over.baseIsoOpts || { agentId: "a1", parentSessionPath: "/s.jsonl", cwd: "/w", permissionMode: "read_only" },
    limiter: over.limiter || createLimiter({ maxConcurrent: 4, maxTotal: 100 }),
    signal: over.signal,
    onProgress: over.onProgress || (() => {}),
    budget: over.budget || { total: null, spent: () => 0, remaining: () => Infinity },
    args: over.args,
    resolveAgentId: over.resolveAgentId,
    onAgentEvent: over.onAgentEvent,
    parentFolderScope: over.parentFolderScope,
    runLimits: over.runLimits,
    journal: over.journal,
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("host api - agent()", () => {
  it("调 executeIsolated 并返回 replyText", async () => {
    const calls = [];
    const api = createHostApi(makeDeps({
      executeIsolated: async (p, o) => { calls.push({ p, o }); return { replyText: "hello", error: null }; },
    }));
    const r = await api.agent("do it");
    expect(r).toBe("hello");
    expect(calls[0].o.agentId).toBe("a1");
    expect(calls[0].p).toBe("do it");
  });

  it("inherits permission and non-interactive approval policy into workflow agent nodes", async () => {
    const calls: any[] = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-wf-inherit-"));
    const ws = path.join(root, "ws");
    fs.mkdirSync(ws, { recursive: true });
    const api = createHostApi(makeDeps({
      baseIsoOpts: {
        agentId: "a1", parentSessionPath: "/s.jsonl", cwd: "/w",
        permissionMode: "auto", approvalPolicy: "deny_on_prompt", allowHumanApproval: false,
      },
      parentFolderScope: { sandboxFolders: [ws] },
      executeIsolated: async (_p, o) => { calls.push(o); return { replyText: "hello", error: null }; },
    }));

    await api.agent("do it", { writeFolders: [ws] });

    expect(calls[0]).toMatchObject({
      permissionMode: "auto",
      approvalPolicy: "deny_on_prompt",
      allowHumanApproval: false,
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("supports workflow node access narrowing without exceeding the parent permission mode", async () => {
    const calls: any[] = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-wf-narrow-"));
    const ws = path.join(root, "ws");
    fs.mkdirSync(ws, { recursive: true });
    const api = createHostApi(makeDeps({
      baseIsoOpts: {
        agentId: "a1", parentSessionPath: "/s.jsonl", cwd: "/w",
        permissionMode: "ask", approvalPolicy: "deny_on_prompt", allowHumanApproval: false,
      },
      parentFolderScope: { sandboxFolders: [ws] },
      executeIsolated: async (_p, o) => { calls.push(o); return { replyText: "hello", error: null }; },
    }));

    await api.agent("read", { access: "read" });
    await api.agent("write", { access: "write", writeFolders: [ws] });

    expect(calls[0].permissionMode).toBe("read_only");
    expect(calls[1].permissionMode).toBe("ask");
    expect(calls[1].approvalPolicy).toBe("deny_on_prompt");
    expect(calls[1].cwd).toBe(fs.realpathSync(ws));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("opts.model / opts.agentType 透传与解析", async () => {
    const calls = [];
    const api = createHostApi(makeDeps({
      executeIsolated: async (p, o) => { calls.push(o); return { replyText: "x", error: null }; },
      resolveAgentId: (t) => (t === "Explore" ? "explore-agent" : undefined),
    }));
    await api.agent("p", { model: "claude-haiku-4-5-20251001", agentType: "Explore" });
    expect(calls[0].model).toBe("claude-haiku-4-5-20251001");
    expect(calls[0].agentId).toBe("explore-agent");
  });

  it("executeIsolated 返回 error 时抛错", async () => {
    // nodeRetries: 0 — 本用例只钉"error 会变成抛错"，不走重试退避（默认会重试 2 次）。
    const api = createHostApi(makeDeps({
      executeIsolated: async () => ({ replyText: "", error: "模型挂了" }),
      runLimits: { nodeRetries: 0 },
    }));
    await expect(api.agent("x")).rejects.toThrow(/模型挂了/);
  });

  it("带 schema：注入 structured_output 并返回结构化对象", async () => {
    const api = createHostApi(makeDeps({
      executeIsolated: async (p, o) => {
        const tool = o.extraCustomTools.find((t) => t.name === "structured_output");
        await tool.execute("c", { n: 7 });
        return { replyText: "", error: null };
      },
    }));
    const out = await api.agent("count", { schema: { type: "object", properties: { n: { type: "number" } } } });
    expect(out).toEqual({ n: 7 });
  });

  it("带 schema 但子 agent 没调工具时抛错", async () => {
    const api = createHostApi(makeDeps({
      executeIsolated: async () => ({ replyText: "forgot", error: null }),
      runLimits: { nodeRetries: 0 },
    }));
    await expect(api.agent("x", { schema: { type: "object" } })).rejects.toThrow(/未调用 structured_output/);
  });

  it("signal 已 abort 时 agent() 抛错", async () => {
    const ac = new AbortController(); ac.abort();
    const api = createHostApi(makeDeps({ signal: ac.signal }));
    await expect(api.agent("x")).rejects.toThrow(/中止/);
  });

  it("拒绝未知 agent() option，避免把 subagent 工具参数误当 workflow 参数", async () => {
    const calls = [];
    const api = createHostApi(makeDeps({
      executeIsolated: async (p, o) => { calls.push({ p, o }); return { replyText: "x", error: null }; },
    }));

    expect(() => api.agent("hanako", { task: "读取 README", access: "read" } as any))
      .toThrow(/unsupported.*task|不支持.*task/i);
    expect(calls).toHaveLength(0);
  });

  it("显式 agentType 找不到时失败，不静默落到当前 agent", async () => {
    const calls = [];
    const api = createHostApi(makeDeps({
      resolveAgentId: () => undefined,
      executeIsolated: async (p, o) => { calls.push({ p, o }); return { replyText: "x", error: null }; },
    }));

    await expect(api.agent("do it", { agentType: "missing-agent" }))
      .rejects.toThrow(/agentType.*missing-agent|找不到.*missing-agent/i);
    expect(calls).toHaveLength(0);
  });

  it("拒绝无效 access 值", async () => {
    const api = createHostApi(makeDeps());
    expect(() => api.agent("do it", { access: "admin" } as any))
      .toThrow(/access.*read.*write|access.*无效/i);
  });

  it("节点级上报：agent() 发 start/session/done，带 nodeId/label/phaseLabel/agentId", async () => {
    const evts = [];
    const api = createHostApi(makeDeps({
      onAgentEvent: (e) => evts.push(e),
      resolveAgentId: (t) => (t === "Explore" ? "explore-agent" : undefined),
      executeIsolated: async (p, o) => { o.onSessionReady?.("/child.jsonl"); return { replyText: "ok", error: null }; },
    }));
    api.phase("Find");
    await api.agent("p", { label: "探索", agentType: "Explore" });
    expect(evts.find((e) => e.phase === "start")).toMatchObject({ nodeId: "node-1", label: "探索", agentId: "explore-agent", phaseLabel: "Find" });
    expect(evts.find((e) => e.phase === "session")).toMatchObject({ nodeId: "node-1", childSessionPath: "/child.jsonl" });
    expect(evts.find((e) => e.phase === "done")).toMatchObject({ nodeId: "node-1" });
  });

  it("agent() 为 workflow 节点生成稳定 threadId 并透传给 executeIsolated", async () => {
    const calls = [];
    const evts = [];
    const api = createHostApi(makeDeps({
      baseIsoOpts: {
        agentId: "a1",
        parentSessionPath: "/s.jsonl",
        cwd: "/w",
        // 本用例只关心 threadId 透传，父档只读以豁免 writeFolders default-deny。
        permissionMode: "read_only",
        subagentTaskId: "workflow-1",
      },
      onAgentEvent: (e) => evts.push(e),
      executeIsolated: async (p, o) => {
        calls.push(o);
        o.onSessionReady?.("/child.jsonl");
        return { replyText: "ok", error: null };
      },
    }));

    await api.agent("p", { label: "探索" });

    expect(calls[0]).toMatchObject({
      subagentThreadId: "workflow-1::node-1",
      subagentThreadKind: "workflow_node",
    });
    expect(evts.find((e) => e.phase === "start")).toMatchObject({
      nodeId: "node-1",
      threadId: "workflow-1::node-1",
      threadKind: "workflow_node",
    });
    expect(evts.find((e) => e.phase === "session")).toMatchObject({
      threadId: "workflow-1::node-1",
      childSessionPath: "/child.jsonl",
    });
  });

  it("节点级上报：agent() 失败发 fail（不重复）", async () => {
    const evts = [];
    const api = createHostApi(makeDeps({
      onAgentEvent: (e) => evts.push(e),
      executeIsolated: async () => ({ replyText: "", error: "boom" }),
      runLimits: { nodeRetries: 0 },
    }));
    await expect(api.agent("p")).rejects.toThrow(/boom/);
    expect(evts.filter((e) => e.phase === "fail")).toHaveLength(1);
    expect(evts.find((e) => e.phase === "fail")).toMatchObject({ nodeId: "node-1" });
  });

  it("节点 nodeId 递增（每次 agent() 调用分配一个）", async () => {
    const ids = [];
    const api = createHostApi(makeDeps({ onAgentEvent: (e) => { if (e.phase === "start") ids.push(e.nodeId); } }));
    await api.agent("a");
    await api.agent("b");
    expect(ids).toEqual(["node-1", "node-2"]);
  });
});

describe("host api - agent() 节点重试与超时", () => {
  it("瞬时错误自动重试：失败 1 次后成功，executeIsolated 被调 2 次", async () => {
    vi.useFakeTimers();
    let n = 0;
    const api = createHostApi(makeDeps({
      executeIsolated: async () => (++n === 1 ? { replyText: "", error: "502 Bad Gateway" } : { replyText: "ok", error: null }),
      runLimits: { nodeRetries: 2, nodeTimeoutMs: 60_000 },
    }));
    // agent() 返回惰性 Proxy：必须先消费（.then）才真正开跑，否则推时钟推的是空气。
    const p = api.agent("do", { access: "read" }).then((v) => v);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBe("ok");
    expect(n).toBe(2);
    vi.useRealTimers();
  });

  it("非重试错误（aborted 语义）只调 1 次即失败", async () => {
    let n = 0;
    const api = createHostApi(makeDeps({
      executeIsolated: async () => { n++; return { replyText: "", error: "aborted" }; },
      runLimits: { nodeRetries: 2, nodeTimeoutMs: 60_000 },
    }));
    await expect(api.agent("do", { access: "read" })).rejects.toThrowError(/aborted/);
    expect(n).toBe(1);
  });

  it("opts.retries: 0 关闭重试", async () => {
    let n = 0;
    const api = createHostApi(makeDeps({
      executeIsolated: async () => { n++; return { replyText: "", error: "flaky" }; },
      runLimits: { nodeRetries: 2, nodeTimeoutMs: 60_000 },
    }));
    await expect(api.agent("do", { access: "read", retries: 0 } as any)).rejects.toThrowError(/flaky/);
    expect(n).toBe(1);
  });

  it("opts.retries 被 clamp 到 5", async () => {
    vi.useFakeTimers();
    let n = 0;
    const api = createHostApi(makeDeps({
      executeIsolated: async () => { n++; return { replyText: "", error: "flaky" }; },
      runLimits: { nodeRetries: 2, nodeTimeoutMs: 60_000 },
    }));
    const p = api.agent("do", { access: "read", retries: 99 } as any).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const err = await p;
    vi.useRealTimers();
    expect(String(err?.message)).toMatch(/flaky/);
    expect(n).toBe(6); // 1 次首发 + 5 次重试
  });

  it("拒绝非法 retries（负数 / 非整数）", () => {
    const api = createHostApi(makeDeps());
    expect(() => api.agent("do", { access: "read", retries: -1 } as any)).toThrowError(/retries/);
    expect(() => api.agent("do", { access: "read", retries: 1.5 } as any)).toThrowError(/retries/);
  });

  it("节点超时：executeIsolated 悬挂 → nodeTimeoutMs 后该节点收到 abort 并按可重试处理", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const api = createHostApi(makeDeps({
      executeIsolated: (_p, o) => new Promise((resolve, reject) => {
        calls++;
        if (calls === 2) { resolve({ replyText: "ok", error: null }); return; }
        o.signal?.addEventListener("abort", () => reject(new Error("node aborted by timeout")), { once: true });
      }),
      runLimits: { nodeRetries: 1, nodeTimeoutMs: 30_000 },
    }));
    const p = api.agent("do", { access: "read" }).then((v) => v);
    await vi.advanceTimersByTimeAsync(30_000 + 10_000);
    await expect(p).resolves.toBe("ok");
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it("父 signal abort 时在飞节点收到 abort（abort 链路打通）", async () => {
    const ac = new AbortController();
    const seen: AbortSignal[] = [];
    const api = createHostApi(makeDeps({
      signal: ac.signal,
      executeIsolated: (_p, o) => new Promise((_res, rej) => {
        seen.push(o.signal);
        o.signal?.addEventListener("abort", () => rej(new Error("child saw abort")), { once: true });
      }),
      runLimits: { nodeRetries: 2, nodeTimeoutMs: 600_000 },
    }));
    const p = api.agent("do", { access: "read" }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    const err = await p;
    expect(seen[0]?.aborted).toBe(true);
    expect(String(err?.message)).toMatch(/中止|abort/i);
  });

  it("journal 错误条目带 error 消息与 attempts（经 deps.journal 注入验证）", async () => {
    const records: any[] = [];
    const api = createHostApi(makeDeps({
      executeIsolated: async () => ({ replyText: "", error: "flaky" }),
      runLimits: { nodeRetries: 1, nodeTimeoutMs: 60_000 },
      journal: { record: (seq, key, result, status, extra) => records.push({ seq, status, ...extra }) },
    }));
    vi.useFakeTimers();
    const p = api.agent("do", { access: "read" }).catch(() => null);
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    vi.useRealTimers();
    expect(records.at(-1)).toMatchObject({ status: "error", attempts: 2 });
    expect(String(records.at(-1).error)).toContain("flaky");
  });

  it("journal 成功条目带 attempts（重试后成功记真实次数）", async () => {
    const records: any[] = [];
    let n = 0;
    const api = createHostApi(makeDeps({
      executeIsolated: async () => (++n === 1 ? { replyText: "", error: "flaky" } : { replyText: "ok", error: null }),
      runLimits: { nodeRetries: 2, nodeTimeoutMs: 60_000 },
      journal: { record: (seq, key, result, status, extra) => records.push({ seq, status, ...extra }) },
    }));
    vi.useFakeTimers();
    const p = api.agent("do", { access: "read" }).then((v) => v);
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    vi.useRealTimers();
    expect(records.at(-1)).toMatchObject({ status: "ok", attempts: 2 });
  });

  it("重试时 schema 节点拿到全新 structured_output 工具，不复用上一次尝试的残留", async () => {
    vi.useFakeTimers();
    let n = 0;
    const api = createHostApi(makeDeps({
      executeIsolated: async (_p, o) => {
        n++;
        const tool = o.extraCustomTools.find((t) => t.name === "structured_output");
        await tool.execute("c", { n });
        return n === 1 ? { replyText: "", error: "flaky" } : { replyText: "", error: null };
      },
      runLimits: { nodeRetries: 2, nodeTimeoutMs: 60_000 },
    }));
    const p = api.agent("count", { access: "read", schema: { type: "object", properties: { n: { type: "number" } } } }).then((v) => v);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toEqual({ n: 2 });
    vi.useRealTimers();
  });

  it("重试只发一次 start / 一次 done，不重复登记节点", async () => {
    vi.useFakeTimers();
    let n = 0;
    const evts: any[] = [];
    const api = createHostApi(makeDeps({
      executeIsolated: async () => (++n === 1 ? { replyText: "", error: "flaky" } : { replyText: "ok", error: null }),
      runLimits: { nodeRetries: 2, nodeTimeoutMs: 60_000 },
      onAgentEvent: (e) => evts.push(e),
    }));
    const p = api.agent("do", { access: "read" }).then((v) => v);
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    vi.useRealTimers();
    expect(evts.filter((e) => e.phase === "start")).toHaveLength(1);
    expect(evts.filter((e) => e.phase === "done")).toHaveLength(1);
    expect(evts.filter((e) => e.phase === "fail")).toHaveLength(0);
  });
});

describe("host api - parallel / pipeline / log / phase", () => {
  it("parallel 等齐所有 thunk", async () => {
    const api = createHostApi(makeDeps());
    const r = await api.parallel([async () => 1, async () => 2, async () => 3]);
    expect(r).toEqual([1, 2, 3]);
  });

  it("parallel 单个 thunk 抛错落 null，不拖累其他", async () => {
    const api = createHostApi(makeDeps());
    const r = await api.parallel([async () => 1, async () => { throw new Error("x"); }, async () => 3]);
    expect(r).toEqual([1, null, 3]);
  });

  it("pipeline 每个 item 穿过所有 stage", async () => {
    const api = createHostApi(makeDeps());
    const r = await api.pipeline([1, 2], (n) => n + 1, (n) => n * 10);
    expect(r).toEqual([20, 30]);
  });

  it("pipeline 某 stage 抛错时该 item 落 null", async () => {
    const api = createHostApi(makeDeps());
    const r = await api.pipeline([1, 2], (n) => { if (n === 1) throw new Error("x"); return n; }, (n) => n * 10);
    expect(r).toEqual([null, 20]);
  });

  it("pipeline 后续 stage 能拿到 originalItem 与 index", async () => {
    const api = createHostApi(makeDeps());
    const r = await api.pipeline(["a", "b"], (v) => v.toUpperCase(), (prev, orig, i) => `${prev}:${orig}:${i}`);
    expect(r).toEqual(["A:a:0", "B:b:1"]);
  });

  it("log / phase 转发到 onProgress", () => {
    const evts = [];
    const api = createHostApi(makeDeps({ onProgress: (e) => evts.push(e) }));
    api.phase("Find"); api.log("hi");
    expect(evts).toEqual([{ type: "phase", title: "Find" }, { type: "log", message: "hi" }]);
  });

  it("parallel 发 step start/done 事件，带 stepKind 和 phaseLabel", async () => {
    const evts = [];
    const api = createHostApi(makeDeps({ onAgentEvent: (e) => evts.push(e) }));
    api.phase("Find");
    await api.parallel([async () => 1, async () => 2]);
    const start = evts.find((e) => e.phase === "start" && e.stepKind === "parallel");
    const done = evts.find((e) => e.phase === "done" && e.stepKind === "parallel");
    expect(start).toMatchObject({ stepKind: "parallel", phaseLabel: "Find" });
    expect(start.nodeId).toMatch(/^step-/);
    expect(done).toMatchObject({ stepKind: "parallel" });
    expect(done.nodeId).toBe(start.nodeId);
  });

  it("pipeline 发 step start/done 事件，带 stepKind", async () => {
    const evts = [];
    const api = createHostApi(makeDeps({ onAgentEvent: (e) => evts.push(e) }));
    await api.pipeline([1, 2], (n) => n + 1);
    const start = evts.find((e) => e.phase === "start" && e.stepKind === "pipeline");
    const done = evts.find((e) => e.phase === "done" && e.stepKind === "pipeline");
    expect(start).toBeTruthy();
    expect(done).toBeTruthy();
    expect(done.nodeId).toBe(start.nodeId);
  });

  it("log 发 step start+done 事件（瞬时），label 为消息内容", async () => {
    const evts = [];
    const api = createHostApi(makeDeps({ onAgentEvent: (e) => evts.push(e) }));
    api.phase("Report");
    api.log("3 bugs found");
    const start = evts.find((e) => e.phase === "start" && e.stepKind === "log");
    const done = evts.find((e) => e.phase === "done" && e.stepKind === "log");
    expect(start).toMatchObject({ stepKind: "log", label: "3 bugs found", phaseLabel: "Report" });
    expect(done).toMatchObject({ stepKind: "log" });
  });

  it("parallel 所有 thunk 抛错时发 fail 事件", async () => {
    const evts = [];
    const api = createHostApi(makeDeps({ onAgentEvent: (e) => evts.push(e) }));
    await api.parallel([async () => { throw new Error("x"); }]);
    // parallel 本身 catch → null，不抛外层，但整体仍然 done（parallel 本身成功完成）
    const done = evts.find((e) => e.phase === "done" && e.stepKind === "parallel");
    expect(done).toBeTruthy();
  });
});

describe("host api - agent() writeFolders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-wf-hostapi-"));
  const parentRoot = path.join(root, "ws");
  const sub = path.join(parentRoot, "docs");
  const outside = path.join(root, "outside");
  for (const d of [parentRoot, sub, outside]) fs.mkdirSync(d, { recursive: true });
  const operableBase = {
    agentId: "a1", parentSessionPath: "/s.jsonl", cwd: "/w", permissionMode: "auto",
  };
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("writeFolders 收窄 isoOpts 的 cwd/workspaceFolders/authorizedFolders", async () => {
    const calls: any[] = [];
    const api = createHostApi(makeDeps({
      baseIsoOpts: { ...operableBase },
      executeIsolated: async (_p, o) => { calls.push(o); return { replyText: "ok", error: null }; },
      parentFolderScope: { sandboxFolders: [parentRoot] },
    }));
    await api.agent("do", { writeFolders: [sub] });
    expect(calls[0].cwd).toBe(fs.realpathSync(sub));
    expect(calls[0].workspaceFolders).toEqual([]);
    expect(calls[0].authorizedFolders).toEqual([]);
  });

  it("default-deny：写能力节点未声明 writeFolders 在调用点同步拒绝，消息含纠正指引", () => {
    const api = createHostApi(makeDeps({ baseIsoOpts: { ...operableBase } }));
    let err: any = null;
    try { api.agent("do"); } catch (e) { err = e; }
    expect(err?.code).toBe("WRITE_FOLDERS_REQUIRED");
    expect(err?.message).toContain("writeFolders");
    expect(err?.message).toContain("resumeFromRunId");
  });

  it('access:"read" 节点无需声明（豁免）', async () => {
    const calls: any[] = [];
    const api = createHostApi(makeDeps({
      baseIsoOpts: { ...operableBase },
      executeIsolated: async (_p, o) => { calls.push(o); return { replyText: "ok", error: null }; },
    }));
    await api.agent("scan", { access: "read" });
    expect(calls[0].permissionMode).toBe("read_only");
  });

  it("父会话只读时裸 agent() 豁免且 folder 入参保持继承（回归）", async () => {
    const calls: any[] = [];
    const api = createHostApi(makeDeps({
      executeIsolated: async (_p, o) => { calls.push(o); return { replyText: "ok", error: null }; },
      parentFolderScope: { sandboxFolders: [parentRoot] },
    }));
    await api.agent("do");
    expect(calls[0].cwd).toBe("/w");
    expect(calls[0].workspaceFolders).toBeUndefined();
    expect(calls[0].authorizedFolders).toBeUndefined();
  });

  it('writeFolders 与 access:"read" 冲突在调用点同步抛错', () => {
    const api = createHostApi(makeDeps({ baseIsoOpts: { ...operableBase }, parentFolderScope: { sandboxFolders: [parentRoot] } }));
    expect(() => api.agent("do", { access: "read", writeFolders: [sub] }))
      .toThrowError(/access:"read"/);
  });

  it("越出父 scope 在 await 时报错（attenuation）", async () => {
    const api = createHostApi(makeDeps({ baseIsoOpts: { ...operableBase }, parentFolderScope: { sandboxFolders: [parentRoot] } }));
    await expect(api.agent("do", { writeFolders: [outside] }))
      .rejects.toThrowError(/escapes the parent session folder scope/);
  });

  it("父 scope 缺失时 writeFolders fail-closed", async () => {
    const api = createHostApi(makeDeps({ baseIsoOpts: { ...operableBase } }));
    await expect(api.agent("do", { writeFolders: [sub] }))
      .rejects.toThrowError(/parent session folder scope/);
  });
});
