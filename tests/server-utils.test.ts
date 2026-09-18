import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { resolveAgentStrict } from "../server/utils/resolve-agent.ts";
import { HttpRouteError, jsonRouteError } from "../server/http/route-errors.ts";

function mockEngine(agents) {
  return {
    getAgent: (id) => agents[id] || null,
    currentAgentId: "_focus",
  };
}

function mockCtx(agentId) {
  return { req: { query: (k) => k === "agentId" ? agentId : null, param: () => null } };
}

describe("resolveAgentStrict", () => {
  it("找到 agent 时正常返回", () => {
    const engine = mockEngine({ hana: { id: "hana" }, _focus: { id: "_focus" } });
    expect(resolveAgentStrict(engine, mockCtx("hana"))).toEqual({ id: "hana" });
  });

  it("agentId 不存在时抛 AgentNotFoundError", () => {
    const engine = mockEngine({ _focus: { id: "_focus" } });
    expect(() => resolveAgentStrict(engine, mockCtx("ghost"))).toThrow("not found");
  });

  it("无显式 agentId 时抛 AgentNotFoundError", () => {
    const engine = mockEngine({ _focus: { id: "_focus" } });
    expect(() => resolveAgentStrict(engine, mockCtx(null))).toThrow("not found");
  });
});

describe("焦点回落解析已移除", () => {
  it("只导出严格版，不再有猜 agent 的读取版", async () => {
    const module = await import("../server/utils/resolve-agent.ts");
    expect(Object.keys(module).sort()).toEqual(["AgentNotFoundError", "resolveAgentStrict"]);
  });
});

describe("HTTP route errors", () => {
  it("serializes HttpRouteError responses with code, message, and trace id", async () => {
    const app = new Hono();
    app.get("/error", (c) => jsonRouteError(c, new HttpRouteError({
      code: "desk_unavailable",
      message: "Desk not initialized",
      status: 503,
      traceId: "trace-1",
    })));

    const res = await app.request("/error");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: "desk_unavailable",
        message: "Desk not initialized",
        traceId: "trace-1",
      },
    });
  });

  it("serializes route error options without a trace id", async () => {
    const app = new Hono();
    app.get("/error", (c) => jsonRouteError(c, {
      code: "bad_request",
      message: "name required",
      status: 400,
    }));

    const res = await app.request("/error");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "bad_request",
        message: "name required",
      },
    });
  });

  it("throws for invalid route error codes", () => {
    expect(() => new HttpRouteError({
      code: "",
      message: "bad request",
      status: 400,
    })).toThrow(TypeError);

    const c = { json: vi.fn() };
    expect(() => jsonRouteError(c, {
      code: " ",
      message: "bad request",
      status: 400,
    })).toThrow(TypeError);
  });

  it("throws for invalid or empty route error messages", () => {
    expect(() => new HttpRouteError({
      code: "bad_request",
      message: "",
      status: 400,
    })).toThrow(TypeError);

    expect(() => jsonRouteError({ json: vi.fn() }, {
      code: "bad_request",
      message: 42,
      status: 400,
    } as any)).toThrow(TypeError);
  });

  it("throws for invalid route error statuses", () => {
    expect(() => new HttpRouteError({
      code: "bad_request",
      message: "bad request",
      status: 200 as any,
    })).toThrow(TypeError);

    expect(() => jsonRouteError({ json: vi.fn() }, {
      code: "bad_request",
      message: "bad request",
      status: 500.5 as any,
    })).toThrow(TypeError);
  });
});
