import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigRoute } from "../server/routes/config.ts";

function makeAgent(tmpDir, overrides: any = {}) {
  const agentDir = path.join(tmpDir, "agents", "hana");
  const memoryDir = path.join(agentDir, "memory");
  const summariesDir = path.join(memoryDir, "summaries");
  fs.mkdirSync(summariesDir, { recursive: true });

  for (const name of ["memory.md", "today.md", "week.md", "longterm.md", "facts.md"]) {
    fs.writeFileSync(path.join(memoryDir, name), "old compiled content", "utf-8");
    fs.writeFileSync(path.join(memoryDir, `${name}.fingerprint`), "old-fp", "utf-8");
  }
  fs.writeFileSync(path.join(summariesDir, "old-session.json"), "{}", "utf-8");
  fs.writeFileSync(path.join(summariesDir, "keep.tmp"), "not a summary", "utf-8");

  return {
    id: "hana",
    agentDir,
    memoryMdPath: path.join(memoryDir, "memory.md"),
    summariesDir,
    summaryManager: { clearCache: vi.fn() },
    factStore: {
      exportAll: vi.fn(() => []),
      clearAll: vi.fn(),
    },
    ...overrides,
  };
}

function makeEngine(agent, tmpDir) {
  return {
    config: {},
    configPath: path.join(tmpDir, "config.yaml"),
    currentAgentId: agent.id,
    agentsDir: path.join(tmpDir, "agents"),
    preferences: {
      getExperimentValue: vi.fn((_: string) => undefined),
    },
    getAgent: vi.fn((id) => (id === agent.id ? agent : null)),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  };
}

function mountConfigRoute(engine) {
  const app = new Hono();
  app.route("/api", createConfigRoute(engine));
  return app;
}

function expectCompiledMemoryCleared(agent) {
  const memoryDir = path.dirname(agent.memoryMdPath);
  for (const name of ["memory.md", "today.md", "week.md", "longterm.md", "facts.md"]) {
    expect(fs.readFileSync(path.join(memoryDir, name), "utf-8")).toBe("");
    expect(fs.existsSync(path.join(memoryDir, `${name}.fingerprint`))).toBe(false);
  }
  const marker = JSON.parse(fs.readFileSync(path.join(memoryDir, "reset.json"), "utf-8"));
  expect(Date.parse(marker.compiledResetAt)).not.toBeNaN();
  expect(fs.existsSync(path.join(agent.summariesDir, "old-session.json"))).toBe(false);
  expect(fs.existsSync(path.join(agent.summariesDir, "keep.tmp"))).toBe(true);
  expect(agent.summaryManager.clearCache).toHaveBeenCalledOnce();
}

describe("memory routes", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-memory-routes-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("clears compiled memory sources and writes a reset watermark", async () => {
    const agent = makeAgent(tmpDir);
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled?agentId=hana", { method: "DELETE" });

    expect(res.status).toBe(200);
    expectCompiledMemoryCleared(agent);
    expect(agent.factStore.clearAll).not.toHaveBeenCalled();
    expect(engine.updateConfig).toHaveBeenCalledWith({}, { agentId: "hana" });
  });

  it("clears facts, compiled memory sources, and writes a reset watermark", async () => {
    const agent = makeAgent(tmpDir);
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories?agentId=hana", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(agent.factStore.clearAll).toHaveBeenCalledOnce();
    expectCompiledMemoryCleared(agent);
    expect(engine.updateConfig).toHaveBeenCalledWith({}, { agentId: "hana" });
  });

  it("requires an explicit agentId for memory delete operations", async () => {
    const agent = makeAgent(tmpDir);
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled", { method: "DELETE" });
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toContain("missing agentId");
    expect(agent.summaryManager.clearCache).not.toHaveBeenCalled();
    expect(agent.factStore.clearAll).not.toHaveBeenCalled();
    expect(engine.updateConfig).not.toHaveBeenCalled();
  });

  it("reports memory health for an explicit agent", async () => {
    const health = {
      rollingSummary: { lastSuccessAt: "2026-06-01T10:00:00.000Z", lastErrorAt: null, lastErrorMsg: null, failCount: 0 },
      compileToday: { lastSuccessAt: "2026-06-01T10:05:00.000Z", lastErrorAt: null, lastErrorMsg: null, failCount: 0 },
      compileDaily: { lastSuccessAt: null, lastErrorAt: null, lastErrorMsg: null, failCount: 0 },
      rollDailyWindow: { lastSuccessAt: null, lastErrorAt: null, lastErrorMsg: null, failCount: 0 },
      compileFacts: { lastSuccessAt: null, lastErrorAt: null, lastErrorMsg: null, failCount: 0 },
      deepMemory: { lastSuccessAt: null, lastErrorAt: "2026-06-01T10:10:00.000Z", lastErrorMsg: "LLM timeout", failCount: 2 },
    };
    const memoryTicker = { getHealthStatus: vi.fn(() => health) };
    const agent = makeAgent(tmpDir, { memoryTicker });
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/health?agentId=hana");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(memoryTicker.getHealthStatus).toHaveBeenCalledOnce();
    expect(data).toMatchObject({
      agentId: "hana",
      status: "degraded",
      reason: null,
      failedSteps: ["deepMemory"],
      maxFailCount: 2,
      lastSuccessAt: "2026-06-01T10:05:00.000Z",
      lastErrorAt: "2026-06-01T10:10:00.000Z",
      steps: {
        deepMemory: health.deepMemory,
      },
    });
  });

  it("requires an explicit agentId for memory health", async () => {
    const agent = makeAgent(tmpDir, {
      memoryTicker: { getHealthStatus: vi.fn(() => ({})) },
    });
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/health");
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toContain("missing agentId");
    expect(agent.memoryTicker.getHealthStatus).not.toHaveBeenCalled();
  });

  it("requires an explicit agentId to read compiled memory", async () => {
    const agent = makeAgent(tmpDir);
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled");
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toContain("missing agentId");
  });

  it("requires an explicit agentId to list compiled week days", async () => {
    const agent = makeAgent(tmpDir);
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled/week/days");
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toContain("missing agentId");
  });

  it("returns compiled memory sections reading facts.md as the canonical facts source", async () => {
    const agent = makeAgent(tmpDir);
    const memoryDir = path.dirname(agent.memoryMdPath);
    fs.writeFileSync(path.join(memoryDir, "facts.md"), "current facts", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "today.md"), "today part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "week.md"), "week part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "longterm.md"), "longterm part", "utf-8");
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled?agentId=hana");
    const data = await res.json();

    expect(res.status).toBe(200);
    // facts 转正后恒为 true：字段保留只为兼容前端既有契约，不再受任何实验开关影响。
    expect(data.editableFactsEnabled).toBe(true);
    expect(data.sections).toMatchObject({
      facts: "current facts",
      today: "today part",
      week: "week part",
      longterm: "longterm part",
    });
    expect(data.content).toContain("## 重要事实\n\ncurrent facts");
  });

  it("saves edited facts straight to facts.md and rebuilds compiled memory", async () => {
    const agent = makeAgent(tmpDir);
    const memoryDir = path.dirname(agent.memoryMdPath);
    fs.writeFileSync(path.join(memoryDir, "facts.md"), "old facts", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "today.md"), "today part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "week.md"), "week part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "longterm.md"), "longterm part", "utf-8");
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled/facts?agentId=hana", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facts: "edited facts" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(fs.readFileSync(path.join(memoryDir, "facts.md"), "utf-8")).toBe("edited facts\n");
    const memoryMd = fs.readFileSync(agent.memoryMdPath, "utf-8");
    expect(memoryMd).toContain("## 重要事实\n\nedited facts");
    expect(memoryMd).toContain("## 今天\n\ntoday part");
    expect(engine.updateConfig).toHaveBeenCalledWith({}, { agentId: "hana" });
  });

  it("saves edited today straight to today.md and rebuilds compiled memory", async () => {
    const agent = makeAgent(tmpDir);
    const memoryDir = path.dirname(agent.memoryMdPath);
    fs.writeFileSync(path.join(memoryDir, "facts.md"), "facts part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "today.md"), "old today", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "week.md"), "week part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "longterm.md"), "longterm part", "utf-8");
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled/today?agentId=hana", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ today: "edited today" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.today).toBe("edited today");
    expect(fs.readFileSync(path.join(memoryDir, "today.md"), "utf-8")).toBe("edited today\n");
    const memoryMd = fs.readFileSync(agent.memoryMdPath, "utf-8");
    expect(memoryMd).toContain("## 今天\n\nedited today");
    expect(memoryMd).toContain("## 重要事实\n\nfacts part");
    expect(engine.updateConfig).toHaveBeenCalledWith({}, { agentId: "hana" });
  });

  it("rejects a non-string today payload", async () => {
    const agent = makeAgent(tmpDir);
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled/today?agentId=hana", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ today: 123 }),
    });

    expect(res.status).toBe(400);
  });

  it("saves edited longterm straight to longterm.md and rebuilds compiled memory", async () => {
    const agent = makeAgent(tmpDir);
    const memoryDir = path.dirname(agent.memoryMdPath);
    fs.writeFileSync(path.join(memoryDir, "facts.md"), "facts part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "today.md"), "today part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "week.md"), "week part", "utf-8");
    fs.writeFileSync(path.join(memoryDir, "longterm.md"), "old longterm", "utf-8");
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled/longterm?agentId=hana", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ longterm: "edited longterm" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.longterm).toBe("edited longterm");
    expect(fs.readFileSync(path.join(memoryDir, "longterm.md"), "utf-8")).toBe("edited longterm\n");
    const memoryMd = fs.readFileSync(agent.memoryMdPath, "utf-8");
    expect(memoryMd).toContain("## 长期情况\n\nedited longterm");
    expect(engine.updateConfig).toHaveBeenCalledWith({}, { agentId: "hana" });
  });

  it("rejects a non-string longterm payload", async () => {
    const agent = makeAgent(tmpDir);
    const engine = makeEngine(agent, tmpDir);
    const app = mountConfigRoute(engine);

    const res = await app.request("/api/memories/compiled/longterm?agentId=hana", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ longterm: null }),
    });

    expect(res.status).toBe(400);
  });

  describe("week day entries", () => {
    function writeDailyFile(memoryDir, date, body) {
      const dailyDir = path.join(memoryDir, "daily");
      fs.mkdirSync(dailyDir, { recursive: true });
      fs.writeFileSync(path.join(dailyDir, `${date}.md`), `## ${date}\n\n${body}\n`, "utf-8");
    }

    it("lists existing daily entries with heading-stripped bodies", async () => {
      const agent = makeAgent(tmpDir);
      const memoryDir = path.dirname(agent.memoryMdPath);
      writeDailyFile(memoryDir, "2026-07-01", "第一天的记录。");
      writeDailyFile(memoryDir, "2026-07-02", "第二天的记录。");
      const engine = makeEngine(agent, tmpDir);
      const app = mountConfigRoute(engine);

      const res = await app.request("/api/memories/compiled/week/days?agentId=hana");
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.days).toEqual([
        { date: "2026-07-01", body: "第一天的记录。" },
        { date: "2026-07-02", body: "第二天的记录。" },
      ]);
    });

    it("saves an edited day, reassembles week.md from daily/, and rebuilds memory.md", async () => {
      const agent = makeAgent(tmpDir);
      const memoryDir = path.dirname(agent.memoryMdPath);
      fs.writeFileSync(path.join(memoryDir, "facts.md"), "facts part", "utf-8");
      fs.writeFileSync(path.join(memoryDir, "today.md"), "today part", "utf-8");
      fs.writeFileSync(path.join(memoryDir, "longterm.md"), "longterm part", "utf-8");
      writeDailyFile(memoryDir, "2026-07-01", "旧的第一天记录。");
      writeDailyFile(memoryDir, "2026-07-02", "第二天的记录。");
      const engine = makeEngine(agent, tmpDir);
      const app = mountConfigRoute(engine);

      const res = await app.request("/api/memories/compiled/week/days/2026-07-01?agentId=hana", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "编辑后的第一天记录。" }),
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.body).toBe("编辑后的第一天记录。");

      const dailyFile = fs.readFileSync(path.join(memoryDir, "daily", "2026-07-01.md"), "utf-8");
      expect(dailyFile).toBe("## 2026-07-01\n\n编辑后的第一天记录。\n");

      // week.md must be reassembled purely from daily/ (no LLM call in this route)
      const weekMd = fs.readFileSync(path.join(memoryDir, "week.md"), "utf-8");
      expect(weekMd).toContain("编辑后的第一天记录。");
      expect(weekMd).not.toContain("旧的第一天记录。");
      expect(weekMd).toContain("第二天的记录。");

      const memoryMd = fs.readFileSync(agent.memoryMdPath, "utf-8");
      expect(memoryMd).toContain("编辑后的第一天记录。");
      expect(engine.updateConfig).toHaveBeenCalledWith({}, { agentId: "hana" });
    });

    it("rejects editing a date with no existing daily entry", async () => {
      const agent = makeAgent(tmpDir);
      const memoryDir = path.dirname(agent.memoryMdPath);
      writeDailyFile(memoryDir, "2026-07-02", "第二天的记录。");
      const engine = makeEngine(agent, tmpDir);
      const app = mountConfigRoute(engine);

      const res = await app.request("/api/memories/compiled/week/days/2026-07-01?agentId=hana", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "凭空造出的一天" }),
      });

      expect(res.status).toBe(404);
    });

    it("rejects a malformed date parameter", async () => {
      const agent = makeAgent(tmpDir);
      const engine = makeEngine(agent, tmpDir);
      const app = mountConfigRoute(engine);

      const res = await app.request("/api/memories/compiled/week/days/not-a-date?agentId=hana", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "x" }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects a non-string body payload", async () => {
      const agent = makeAgent(tmpDir);
      const memoryDir = path.dirname(agent.memoryMdPath);
      writeDailyFile(memoryDir, "2026-07-01", "第一天的记录。");
      const engine = makeEngine(agent, tmpDir);
      const app = mountConfigRoute(engine);

      const res = await app.request("/api/memories/compiled/week/days/2026-07-01?agentId=hana", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: 42 }),
      });

      expect(res.status).toBe(400);
    });
  });
});
