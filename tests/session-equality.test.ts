import { describe, it, expect } from "vitest";
import { getToolSessionPath } from "../lib/tools/tool-session.ts";
import { resolveAgentStrict, AgentNotFoundError } from "../server/utils/resolve-agent.ts";

// ── getToolSessionPath ──

describe("session-equality: tool sessionPath 归属", () => {
  it("从 ctx.sessionManager.getSessionFile() 获取 sessionPath", () => {
    const ctx = {
      sessionManager: { getSessionFile: () => "/agents/hana/sessions/abc.jsonl" },
    };
    expect(getToolSessionPath(ctx)).toBe("/agents/hana/sessions/abc.jsonl");
  });

  it("ctx 为 null 时返回 null（不 fallback）", () => {
    expect(getToolSessionPath(null)).toBeNull();
    expect(getToolSessionPath(undefined)).toBeNull();
  });

  it("ctx 无 sessionManager 时返回 null", () => {
    expect(getToolSessionPath({})).toBeNull();
  });

  it("不同 session 的 ctx 返回各自的 path", () => {
    const ctxA = { sessionManager: { getSessionFile: () => "/sessions/a.jsonl" } };
    const ctxB = { sessionManager: { getSessionFile: () => "/sessions/b.jsonl" } };
    expect(getToolSessionPath(ctxA)).toBe("/sessions/a.jsonl");
    expect(getToolSessionPath(ctxB)).toBe("/sessions/b.jsonl");
    expect(getToolSessionPath(ctxA)).not.toBe(getToolSessionPath(ctxB));
  });
});

// ── 解析 agent 一律要显式 agentId ──

describe("session-equality: 解析 agent 不静默 fallback", () => {
  const mockEngine = {
    getAgent: (id) => {
      if (id === "valid") return { id: "valid", name: "Valid" };
      if (id === "focus") return { id: "focus", name: "Focus" };
      return undefined;
    },
    currentAgentId: "focus",
  };

  it("显式传入有效 agentId 返回对应 agent", () => {
    const c = { req: { query: () => "valid", param: () => null } };
    expect(resolveAgentStrict(mockEngine, c).id).toBe("valid");
  });

  it("显式传入无效 agentId 抛 AgentNotFoundError", () => {
    const c = { req: { query: () => "nonexistent", param: () => null } };
    expect(() => resolveAgentStrict(mockEngine, c)).toThrow(AgentNotFoundError);
  });

  it("未传 agentId 时报错，不落到焦点 agent", () => {
    const c = { req: { query: () => null, param: () => null } };
    expect(() => resolveAgentStrict(mockEngine, c)).toThrow(AgentNotFoundError);
  });
});
