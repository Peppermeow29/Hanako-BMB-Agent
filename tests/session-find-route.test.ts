import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 有意不 mock core/message-utils：本文件的核心价值是 find 与 messages 的序号一致性，
// 必须走真实 JSONL 解析链路。
// v3 session 格式的条目按 parentId 链成树，SessionManager.getBranch 从 leaf 沿
// parentId 回溯取当前分支；fixture 必须像真实文件一样把条目串成链，
// 否则只有最后一条会出现在分支里。
function jsonlLine(id: string, parentId: string | null, role: string, content: unknown): string {
  return JSON.stringify({ type: "message", id, parentId, timestamp: "2026-07-08T10:00:00Z", message: { role, content } });
}

async function buildApp(agentsDir: string) {
  const { createSessionsRoute } = await import("../server/routes/sessions.ts");
  const app = new Hono();
  const manifestSessionPath = path.join(agentsDir, "hana", "sessions", "find-target.jsonl");
  const engine = {
    agentsDir,
    currentSessionPath: null,
    isSessionStreaming: () => false,
    agentIdFromSessionPath: () => "hana",
    getAgent: () => ({ agentName: "Hana" }),
    getSessionWorkspaceMount: () => null,
    getSessionManifest: (id: string) =>
      id === "sess_find" ? { currentLocator: { path: manifestSessionPath } } : null,
  };
  app.route("/api", createSessionsRoute(engine));
  return app;
}

describe("sessions find route", () => {
  let agentsDir: string;
  let sessionPath: string;

  // displayable 序号布局（与 /api/sessions/messages 的消息 id 严格同源）：
  //   0: m1  user      "第一条：我们聊聊 lighthouse 架构"          → find entry，lighthouse 命中
  //   1: m2  assistant "好的，lighthouse 的实现在这里"          → find entry，lighthouse 命中
  //   2: m2b assistant 纯 tool_use                                → displayable 推进序号，无 find entry
  //   3: m2c user      纯 image                                   → displayable 推进序号，无 find entry
  //   -: t1  toolResult                                           → 不 displayable，不推进序号
  //   4: m3  user      hana-background-result 隐藏系统消息         → 推进序号，被隐藏正则排除，无 find entry
  //   5: m4  user      "第二个话题：搜索定位怎么做"                 → find entry
  //   6: m5  assistant "用 displayable 序号做锚点"                 → find entry
  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-find-route-"));
    sessionPath = path.join(agentsDir, "hana", "sessions", "find-target.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, [
      // version: 3 = 当前 session 格式版本。缺 version 会被 SessionManager.open 当 v1
      // 触发迁移重写（加 id/parentId），首个请求后文件变大、revision 漂移，
      // 与生产文件（始终 v3 写入）不符，也会让 revision 断言不稳定。
      JSON.stringify({ type: "session", version: 3, id: "sess_find", cwd: "/tmp", timestamp: "2026-07-08T09:00:00Z" }),
      jsonlLine("m1", null, "user", "第一条：我们聊聊 lighthouse 架构"),
      jsonlLine("m2", "m1", "assistant", "好的，lighthouse 的实现在这里"),
      jsonlLine("m2b", "m2", "assistant", [{ type: "tool_use", id: "tu1", name: "Bash", input: {} }]),
      jsonlLine("m2c", "m2b", "user", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }]),
      JSON.stringify({ type: "message", id: "t1", parentId: "m2c", timestamp: "2026-07-08T10:00:00Z", message: { role: "toolResult", toolName: "Bash", content: "lighthouse grep output" } }),
      jsonlLine("m3", "t1", "user", "<hana-background-result task=\"x\"> 隐藏系统消息 lighthouse </hana-background-result>"),
      jsonlLine("m4", "m3", "user", "第二个话题：搜索定位怎么做"),
      jsonlLine("m5", "m4", "assistant", "用 displayable 序号做锚点"),
    ].join("\n"), "utf8");
  });

  it("find 返回消息级命中，序号与 messages 接口一致", async () => {
    const app = await buildApp(agentsDir);
    const findRes = await app.request(`/api/sessions/find?path=${encodeURIComponent(sessionPath)}&q=lighthouse`);
    expect(findRes.status).toBe(200);
    const find = await findRes.json();
    expect(find.total).toBe(2);
    // 布局注释：lighthouse 命中只有 m1(0)、m2(1)
    expect(find.matches.map((m: any) => m.index)).toEqual([0, 1]);

    const msgRes = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}&all=1`);
    const msg = await msgRes.json();
    for (const match of find.matches) {
      const hit = msg.messages.find((m: any) => m.id === String(match.index));
      expect(hit, `find index ${match.index} 必须能在 messages 里找到同 id 消息`).toBeTruthy();
      expect(hit.content.toLowerCase()).toContain("lighthouse");
    }
    // 实测锚点：m2b（纯 tool_use assistant）与 m2c（纯 image user）在 messages 侧
    // 确实各占一个 displayable 序号（2 和 3），find 侧照常推进但不产生命中。
    const idx2 = msg.messages.find((m: any) => m.id === "2");
    expect(idx2?.role).toBe("assistant");
    expect(idx2?.toolCalls?.[0]?.name).toBe("Bash");
    const idx3 = msg.messages.find((m: any) => m.id === "3");
    expect(idx3?.role).toBe("user");
    expect(idx3?.images?.length).toBe(1);

    // 布局注释：2 = 纯 tool_use assistant，3 = 纯 image user（推进序号但无可查找文本），
    // 4 = hana-background-result 隐藏系统消息（推进序号但被排除）
    expect(find.matches.map((m: any) => m.index)).not.toContain(2);
    expect(find.matches.map((m: any) => m.index)).not.toContain(3);
    expect(find.matches.map((m: any) => m.index)).not.toContain(4);
  });

  it("bestIndex 优先 exact 命中", async () => {
    const app = await buildApp(agentsDir);
    const res = await app.request(`/api/sessions/find?path=${encodeURIComponent(sessionPath)}&q=搜索定位`);
    const data = await res.json();
    // 布局注释：m4 "第二个话题：搜索定位怎么做" 的 displayable 序号为 5
    expect(data.bestIndex).toBe(5);

    // 双向锁：messages 主循环侧的序号语义漂移也必须让本用例报红。
    const msgRes = await app.request(`/api/sessions/messages?path=${encodeURIComponent(sessionPath)}&all=1`);
    const msg = await msgRes.json();
    const hit = msg.messages.find((m: any) => m.id === String(data.bestIndex));
    expect(hit, "bestIndex 必须能在 messages 里找到同 id 消息").toBeTruthy();
    expect(hit.content).toContain("搜索定位");
  });

  it("缺 path 返回 400，不回退 currentSessionPath", async () => {
    const app = await buildApp(agentsDir);
    const res = await app.request(`/api/sessions/find?q=abc`);
    expect(res.status).toBe(400);
  });

  it("空 q 返回空结果", async () => {
    const app = await buildApp(agentsDir);
    const res = await app.request(`/api/sessions/find?path=${encodeURIComponent(sessionPath)}&q=`);
    const data = await res.json();
    expect(data.total).toBe(0);
    expect(data.matches).toEqual([]);
  });

  it("超长 q 返回 400", async () => {
    const app = await buildApp(agentsDir);
    const res = await app.request(`/api/sessions/find?path=${encodeURIComponent(sessionPath)}&q=${"a".repeat(513)}`);
    expect(res.status).toBe(400);
  });

  it("revision 键控缓存：重复请求一致，追加写入后缓存失效", async () => {
    const app = await buildApp(agentsDir);
    const url = `/api/sessions/find?path=${encodeURIComponent(sessionPath)}&q=lighthouse`;
    const data1 = await (await app.request(url)).json();
    expect(data1.revision).toBeTruthy();
    const data2 = await (await app.request(url)).json();
    expect(data2).toEqual(data1);

    // 追加一条新的可命中消息：displayable 序号 7（紧随 m5 的 6 之后）
    fs.appendFileSync(sessionPath, "\n" + jsonlLine("m6", "m5", "user", "lighthouse 第三次出现"), "utf8");
    const data3 = await (await app.request(url)).json();
    expect(data3.total).toBe(3);
    expect(data3.matches.map((m: any) => m.index)).toEqual([0, 1, 7]);
    expect(data3.revision).not.toBe(data1.revision);
  });

  it("sessionId 命中 manifest 时结果与 path 版一致", async () => {
    const app = await buildApp(agentsDir);
    const byPath = await (await app.request(`/api/sessions/find?path=${encodeURIComponent(sessionPath)}&q=lighthouse`)).json();
    const bySessionId = await (await app.request(`/api/sessions/find?sessionId=sess_find&q=lighthouse`)).json();
    expect(bySessionId).toEqual(byPath);
  });

  it("sessionId 未知返回 404", async () => {
    const app = await buildApp(agentsDir);
    const res = await app.request(`/api/sessions/find?sessionId=unknown&q=x`);
    expect(res.status).toBe(404);
  });
});
