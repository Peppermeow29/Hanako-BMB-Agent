import { Hono } from "hono";
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionsRoute, __testables } from "../server/routes/sessions.ts";
import { AgentManager } from "../core/agent-manager.ts";

const AGENTS_DIR = "/tmp/hana-test-agents";
const SESSION_PATH = `${AGENTS_DIR}/agent-a/sessions/sess-1.jsonl`;

function makeApp(engineOverrides: Record<string, any> = {}) {
  const engine: Record<string, any> = {
    agentsDir: AGENTS_DIR,
    hanakoHome: mkdtempSync(path.join(tmpdir(), "hana-route-errors-")),
    cwd: "/tmp",
    agentName: "agent-a",
    currentSessionPath: null,
    getAgent: () => ({ agentName: "agent-a" }),
    getSessionIdForPath: () => "sid-1",
    persistSessionMeta: () => {},
    ...engineOverrides,
  };
  const app = new Hono();
  app.route("/", createSessionsRoute(engine));
  return { app, engine };
}

function postJson(app: Hono, url: string, body: any) {
  return app.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 造一个下游语义错误：带 status + code，正是 session-coordinator 抛的形状。 */
function semanticError(message: string, status: number, code: string) {
  return Object.assign(new Error(message), { status, code });
}

describe("new-detached 错误分层", () => {
  it("new-detached surfaces err.status/err.code instead of blanket 500", async () => {
    const { app } = makeApp({
      createDetachedSession: async () => {
        throw semanticError("locator not active", 409, "session_locator_not_active");
      },
    });
    const res = await postJson(app, "/sessions/new-detached", {});
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("session_locator_not_active");
    expect(body.error).toBe("locator not active");
  });

  it("new-detached still returns 500 with the raw message for unclassified errors", async () => {
    const { app } = makeApp({
      createDetachedSession: async () => {
        throw new Error("disk on fire");
      },
    });
    const res = await postJson(app, "/sessions/new-detached", {});
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("disk on fire");
    expect(body.code).toBeUndefined();
  });
});

describe("switch 错误分层", () => {
  it("switch surfaces err.status/err.code and still appends switch-error.log", async () => {
    const { app, engine } = makeApp({
      switchSession: async () => {
        throw semanticError("session index is rebuilding", 503, "session_manifest_unavailable");
      },
    });
    const res = await postJson(app, "/sessions/switch", { path: SESSION_PATH });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("session_manifest_unavailable");
    expect(body.error).toBe("session index is rebuilding");

    // switch-error.log 是现场排障的证据链，分层之后仍须全量落盘
    const logPath = path.join(engine.hanakoHome, "switch-error.log");
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("session index is rebuilding");
  });

  it("switch keeps blanket 500 for status-less errors", async () => {
    const { app } = makeApp({
      switchSession: async () => {
        throw new Error("unexpected boom");
      },
    });
    const res = await postJson(app, "/sessions/switch", { path: SESSION_PATH });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("unexpected boom");
    expect(body.code).toBeUndefined();
  });
});

describe("模型失效的 agent 切换", () => {
  it("switch 把 agent_model_not_available 透传成 409", async () => {
    const { app } = makeApp({
      switchSession: async () => {
        throw semanticError(
          "agent 'writer' model openai/gone is not available",
          409,
          "agent_model_not_available",
        );
      },
    });
    const res = await postJson(app, "/sessions/switch", { path: SESSION_PATH });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("agent_model_not_available");
  });

  it("_doSwitchAgentOnly 在模型解析不到时抛出带 code/status 的错", async () => {
    // 真实链路：路由只负责透传，码必须在抛错点就挂上，否则一路到边界只剩 500。
    // 用合成 this 直接驱动失败分支，避开整套 AgentManager 装配。
    const manager: any = Object.create(AgentManager.prototype);
    manager._agents = new Map([["writer", {
      agentName: "writer",
      config: { models: { chat: { id: "gone", provider: "openai" } } },
    }]]);
    manager._activeAgentId = "primary";
    manager.ensureAgentRuntime = async () => {};
    // availableModels 里没有 openai/gone，findModel 返回 null，走进抛错分支
    manager._d = { getModels: () => ({ availableModels: [], defaultModel: null }) };

    await expect(manager._doSwitchAgentOnly("writer")).rejects.toMatchObject({
      code: "agent_model_not_available",
      status: 409,
    });
    // 失败必须回滚活跃 agent，不能把焦点留在切了一半的状态
    expect(manager._activeAgentId).toBe("primary");
  });
});

describe("classifySessionCreationError", () => {
  it("classifySessionCreationError prefers err.code over message regex", async () => {
    const { classifySessionCreationError } = __testables;
    // 文案命中"no available model"正则，但 code/status 显式给了别的语义：以 code 为准
    const classified = classifySessionCreationError(
      semanticError("no available model", 503, "session_manifest_unavailable"),
    );
    expect(classified.status).toBe(503);
    expect(classified.body.code).toBe("session_manifest_unavailable");
  });

  it("正则分支只在无 code/status 时兜底历史抛错点", async () => {
    const { classifySessionCreationError } = __testables;
    const classified = classifySessionCreationError(new Error("no available model"));
    expect(classified.status).toBe(409);
    expect(classified.body.code).toBe("no_available_model");
  });
});
