import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

/**
 * 切换助手失败时，路由必须把抛错点已经挂好的 code / status 原样交给前端。
 * 前端只有拿到 code 才能给出"这个助手的模型没了，去设置里换一个"这类可行动的提示；
 * 一旦被压成裸 500，用户看到的只有一段翻译不了的英文。
 */
describe("agents route: /agents/switch error surfacing", () => {
  async function switchWith(switchAgent) {
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const app = new Hono();
    const engine = {
      currentAgentId: "target",
      config: { cwd_history: [] },
      switchAgent,
      updateConfig: vi.fn().mockResolvedValue(undefined),
      getAgent: vi.fn(() => ({ agentName: "Target" })),
      emitEvent: vi.fn(),
    };
    app.route("/api", createAgentsRoute(engine));
    const res = await app.request("/api/agents/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "target" }),
    });
    // 故意不直接 res.json()：构造响应本身失败时（越界 status 会让 Response 抛 RangeError）
    // Hono 兜底应答的是纯文本，用 raw 把这种"原始错误被毁掉"的情形看成断言得了的失败。
    const raw = await res.text();
    let data: any = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    return { res, data, raw, engine };
  }

  it("passes through the status and code carried by the thrown error", async () => {
    const err: any = new Error("Agent target has no available model: openai/gpt-9");
    err.code = "agent_model_not_available";
    err.status = 409;

    const { res, data } = await switchWith(vi.fn().mockRejectedValue(err));

    expect(res.status).toBe(409);
    expect(data).toEqual({
      error: "Agent target has no available model: openai/gpt-9",
      code: "agent_model_not_available",
    });
  });

  it("still answers 500 without a code when the error carries none", async () => {
    const { res, data } = await switchWith(vi.fn().mockRejectedValue(new Error("boom")));

    expect(res.status).toBe(500);
    expect(data).toEqual({ error: "boom" });
    expect(data.code).toBeUndefined();
  });

  // status 是个开放字段：child_process 的退出码也叫 status。越界值会让 Response
  // 构造抛 RangeError，异常穿透 catch，客户端拿到的是 Hono 兜底的纯文本，
  // 原始错误连同它的 code 一起被毁掉。3xx 更糟：302 会变成一次真的重定向。
  it.each([302, 999, 0, 204])("falls back to 500 for the out-of-range status %s", async (status) => {
    const err: any = new Error("switch failed");
    err.code = "agent_model_not_available";
    err.status = status;

    const { res, data, raw } = await switchWith(vi.fn().mockRejectedValue(err));

    expect(res.status).toBe(500);
    expect(data, `expected a JSON error body, got: ${raw}`).toEqual({
      error: "switch failed",
      code: "agent_model_not_available",
    });
  });

  // 钉住范围门的两端，否则把 400 写成 350、把 599 写成 550 都没人拦得住。
  it.each([400, 599])("lets the in-range status %s through", async (status) => {
    const err: any = new Error("switch failed");
    err.status = status;

    const { res } = await switchWith(vi.fn().mockRejectedValue(err));

    expect(res.status).toBe(status);
  });

  it.each([399, 600])("clamps the just-out-of-range status %s to 500", async (status) => {
    const err: any = new Error("switch failed");
    err.status = status;

    const { res } = await switchWith(vi.fn().mockRejectedValue(err));

    expect(res.status).toBe(500);
  });

  it("honours the legacy statusCode key when status is absent", async () => {
    const err: any = new Error("invalid yuan");
    err.code = "invalid_yuan";
    err.statusCode = 400;

    const { res, data } = await switchWith(vi.fn().mockRejectedValue(err));

    expect(res.status).toBe(400);
    expect(data).toEqual({ error: "invalid yuan", code: "invalid_yuan" });
  });

  it("keeps the legacy statusCode key inside the same range gate", async () => {
    const err: any = new Error("child process exited");
    err.statusCode = 1;

    const { res, data } = await switchWith(vi.fn().mockRejectedValue(err));

    expect(res.status).toBe(500);
    expect(data).toEqual({ error: "child process exited" });
  });

  it("logs the failure server-side instead of relying on the client", async () => {
    const { createAgentsRoute } = await import("../server/routes/agents.ts");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = new Hono();
      app.route("/api", createAgentsRoute({
        currentAgentId: "target",
        config: { cwd_history: [] },
        switchAgent: vi.fn().mockRejectedValue(new Error("boom")),
        getAgent: vi.fn(() => ({ agentName: "Target" })),
        emitEvent: vi.fn(),
      }));
      await app.request("/api/agents/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "target" }),
      });
      const logged = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logged).toContain("boom");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
