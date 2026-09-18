/**
 * Rolling summary 格式契约测试 (#1628)
 *
 * 契约：所有 rolling summary 落盘路径（legacy utility 路径 + cache snapshot
 * reflection write 路径）产出的摘要必须满足 compileEditableFacts 的提取假设
 * （存在 重要事实 / Key Facts 标题段）。格式知识的单一源头是
 * lib/memory/rolling-summary-format.ts：
 *   - prompt 输出格式要求（两条产出路径共用）
 *   - 写入前结构校验 validateRollingSummaryFormat
 *   - 有限次数的格式修复（MAX_ROLLING_SUMMARY_FORMAT_REPAIRS）
 *   - compileEditableFacts 的 facts 段提取规则
 * 最终校验失败时禁止覆盖旧摘要；读取侧对旧自由格式摘要显式跳过并记录。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const loggers = vi.hoisted(() => new Map());

vi.mock("../lib/i18n.js", () => ({
  getLocale: () => "zh-CN",
}));

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(),
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  initDebugLog: vi.fn(),
  createModuleLogger: (name) => {
    if (!loggers.has(name)) {
      loggers.set(name, { log: vi.fn(), warn: vi.fn(), error: vi.fn() });
    }
    return loggers.get(name);
  },
}));

import {
  MAX_ROLLING_SUMMARY_FORMAT_REPAIRS,
  buildRollingSummaryFormatRequirements,
  buildRollingSummaryRepairPrompt,
  buildRollingSummaryRepairInput,
  validateRollingSummaryFormat,
  hasFactSectionHeading,
  extractFactSection,
  isEmptyFactSection,
} from "../lib/memory/rolling-summary-format.ts";
import {
  runMemoryReflection,
  buildMemoryReflectionSuffix,
} from "../lib/memory/memory-reflection-runner.ts";
import { buildRollingSummaryPrompt } from "../lib/memory/prompts/rolling-summary.ts";
import { SessionSummaryManager } from "../lib/memory/session-summary.ts";
import { compileEditableFacts } from "../lib/memory/compile.ts";
import { buildSessionCacheSnapshot } from "../core/session-cache-snapshot.ts";
import { callText } from "../core/llm-client.ts";

const VALID_ZH_SUMMARY = "### 重要事实\n- 用户长期关注记忆系统\n\n### 事情经过\n- [2026-06-03 10:00] 用户在调缓存快照。";
const VALID_EN_SUMMARY = "### Key Facts\n- The user cares about memory systems\n\n### Timeline\n- [2026-06-03 10:00] The user tuned cache snapshots.";
const FREE_FORM_SUMMARY = "用户今天聊了聊记忆系统的缓存快照，整体进展顺利，没有别的事。";

const RESOLVED_MODEL = { model: "m", api: "openai-completions", api_key: "k", base_url: "http://x" };

// ---------------------------------------------------------------------------
// 1. validateRollingSummaryFormat — 校验规则即 compileEditableFacts 提取假设
// ---------------------------------------------------------------------------

describe("validateRollingSummaryFormat", () => {
  it("accepts the canonical two-section zh summary", () => {
    expect(validateRollingSummaryFormat(VALID_ZH_SUMMARY)).toEqual({ ok: true, issues: [] });
  });

  it("accepts the canonical two-section en summary", () => {
    expect(validateRollingSummaryFormat(VALID_EN_SUMMARY)).toEqual({ ok: true, issues: [] });
  });

  it("accepts legacy H2 headings (compileEditableFacts accepts any heading level)", () => {
    const result = validateRollingSummaryFormat("## 重要事实\n- 用户喜欢宋体\n\n## 事情经过\n- 用户调整了字体。");
    expect(result.ok).toBe(true);
  });

  it("accepts an explicit empty fact marker", () => {
    const result = validateRollingSummaryFormat("### 重要事实\n- 无\n\n### 事情经过\n- [10:00] 闲聊。");
    expect(result.ok).toBe(true);
  });

  it("rejects free-form text without any contract headings", () => {
    const result = validateRollingSummaryFormat(FREE_FORM_SUMMARY);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("rejects a summary missing the timeline heading", () => {
    const result = validateRollingSummaryFormat("### 重要事实\n- 用户喜欢宋体\n后面是流水账但没有标题。");
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/事情经过|Timeline/);
  });

  it("rejects a summary missing the fact heading", () => {
    const result = validateRollingSummaryFormat("### 事情经过\n- [10:00] 用户在聊记忆系统。");
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/重要事实|Key Facts/);
  });

  it("rejects an empty fact section body", () => {
    const result = validateRollingSummaryFormat("### 重要事实\n\n### 事情经过\n- [10:00] 闲聊。");
    expect(result.ok).toBe(false);
  });

  it("rejects a timeline heading nested deeper than the fact heading (fact section not delimited)", () => {
    const result = validateRollingSummaryFormat("### 重要事实\n- 用户喜欢宋体\n\n#### 事情经过\n- [10:00] 闲聊。");
    expect(result.ok).toBe(false);
  });

  it("exposes a bounded explicit repair constant", () => {
    expect(Number.isInteger(MAX_ROLLING_SUMMARY_FORMAT_REPAIRS)).toBe(true);
    expect(MAX_ROLLING_SUMMARY_FORMAT_REPAIRS).toBeGreaterThanOrEqual(1);
    expect(MAX_ROLLING_SUMMARY_FORMAT_REPAIRS).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 2. 格式知识单一来源 — 所有 prompt 产出方共用同一段输出格式要求
// ---------------------------------------------------------------------------

describe("rolling summary format single source", () => {
  it("memory reflection suffix carries the shared format requirements", () => {
    const suffix = buildMemoryReflectionSuffix({ previousSummary: "", timeZone: "Asia/Shanghai", locale: "zh-CN" });
    const text = suffix.content[0].text;
    expect(text).toContain(buildRollingSummaryFormatRequirements("zh-CN"));
    expect(text).toContain("### 重要事实");
    expect(text).toContain("### 事情经过");
    expect(text).toContain("YYYY-MM-DD HH:MM");
    expect(text).toContain("不要只写 HH:MM");
  });

  it("the legacy utility rolling summary prompt embeds the shared format requirements verbatim", async () => {
    (callText as any).mockResolvedValueOnce(VALID_ZH_SUMMARY);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-format-source-"));
    try {
      const manager = new SessionSummaryManager(tmpDir);
      await manager.rollingSummary(
        "s1",
        [{ role: "user", content: "聊聊记忆系统。", timestamp: "2026-06-03T10:00:00.000Z" }],
        RESOLVED_MODEL,
      );
      const prompt = (callText as any).mock.calls[0][0].systemPrompt;
      expect(prompt).toContain(buildRollingSummaryFormatRequirements("zh-CN"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("buildRollingSummaryPrompt embeds the shared format requirements in both locales", () => {
    const zhPrompt = buildRollingSummaryPrompt({ locale: "zh-CN" }).systemPrompt;
    const enPrompt = buildRollingSummaryPrompt({ locale: "en-US" }).systemPrompt;
    expect(zhPrompt).toContain(buildRollingSummaryFormatRequirements("zh-CN"));
    expect(enPrompt).toContain(buildRollingSummaryFormatRequirements("en-US"));
    expect(zhPrompt).toContain("YYYY-MM-DD HH:MM");
    expect(enPrompt).toContain("YYYY-MM-DD HH:MM");
    expect(enPrompt).toContain("do not use date-less HH:MM only");
  });
});

// ---------------------------------------------------------------------------
// 3. cache snapshot reflection — 写入前校验 + bounded repair
// ---------------------------------------------------------------------------

function makeReflectionFixture(responses) {
  const model = {
    id: "memory-model",
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: "http://localhost:1234",
  };
  const messages = [
    { role: "user", content: "我们聊聊记忆系统。", timestamp: "2026-06-03T10:00:00.000Z" },
    { role: "assistant", content: "好的，先看缓存快照。", timestamp: "2026-06-03T10:01:00.000Z" },
  ];
  const snapshot = buildSessionCacheSnapshot({
    sessionPath: "/tmp/sessions/s1.jsonl",
    reason: "memory.reflection",
    model,
    cacheKeyParams: {},
    systemPrompt: "You are Hana.",
    tools: [],
    messages,
  });
  const calls = [];
  const streamFn = vi.fn(async (_model, context) => {
    calls.push(context);
    const text = responses[Math.min(calls.length - 1, responses.length - 1)];
    return {
      result: async () => ({
        content: [{ type: "text", text }],
        stopReason: "stop",
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    };
  });
  return { snapshot, model, messages, streamFn, calls };
}

describe("runMemoryReflection format validation and bounded repair", () => {
  it("repairs a format-violating reflection output with validation feedback", async () => {
    const { snapshot, model, messages, streamFn, calls } = makeReflectionFixture([
      FREE_FORM_SUMMARY,
      VALID_ZH_SUMMARY,
    ]);
    const ledgerStarts = [];
    const usageLedger = {
      start: vi.fn((meta) => {
        ledgerStarts.push(meta);
        return { requestId: `req-${ledgerStarts.length}` };
      }),
      finish: vi.fn(),
      recordError: vi.fn(),
    };
    const usageContext = {
      source: { subsystem: "memory", operation: "cache_snapshot_reflection", surface: "system", trigger: "threshold" },
      attribution: { kind: "memory", agentId: "hana" },
    };

    const result = await runMemoryReflection({
      snapshot,
      model,
      cacheKeyParams: {},
      previousSummary: "",
      sessionId: "s1",
      messages,
      timeZone: "Asia/Shanghai",
      streamFn,
      usageLedger,
      usageContext,
    });

    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(result.summary).toBe(VALID_ZH_SUMMARY);
    expect(result.data.summary).toBe(VALID_ZH_SUMMARY);

    // 修复请求必须带上校验失败反馈和原始草稿，且仍基于同一 session 前缀
    const repairText = calls[1].messages.at(-1).content[0].text;
    expect(repairText).toContain(FREE_FORM_SUMMARY);
    expect(repairText).toContain(buildRollingSummaryFormatRequirements("zh-CN"));
    expect(calls[1].messages.length).toBe(snapshot.messageCount + 1);

    // 修复子任务必须用独立 usageContext：operation 可区分、attribution 原样继承、
    // 结构保持一等 { source, attribution }，且不得原地改写初次的 context 对象
    expect(ledgerStarts).toHaveLength(2);
    expect(ledgerStarts[0].usageContext.source.operation).toBe("cache_snapshot_reflection");
    expect(ledgerStarts[1].usageContext.source).toEqual({
      subsystem: "memory",
      operation: "cache_snapshot_reflection_repair",
      surface: "system",
      trigger: "threshold",
    });
    expect(ledgerStarts[1].usageContext.attribution).toEqual({ kind: "memory", agentId: "hana" });
    expect(ledgerStarts[1].metadata.templateVersion).toBe("memory-reflection-repair.v1");
    expect(usageContext.source.operation).toBe("cache_snapshot_reflection");
  });

  it("throws after the bounded repair budget is exhausted instead of returning a bad summary", async () => {
    const { snapshot, model, messages, streamFn } = makeReflectionFixture([FREE_FORM_SUMMARY]);

    await expect(runMemoryReflection({
      snapshot,
      model,
      cacheKeyParams: {},
      previousSummary: "",
      sessionId: "s1",
      messages,
      timeZone: "Asia/Shanghai",
      streamFn,
    })).rejects.toThrow(/rolling summary format/i);

    expect(streamFn).toHaveBeenCalledTimes(1 + MAX_ROLLING_SUMMARY_FORMAT_REPAIRS);
  });

  it("keeps the empty-output no-change semantics without triggering repair", async () => {
    const { snapshot, model, messages, streamFn } = makeReflectionFixture([""]);

    const result = await runMemoryReflection({
      snapshot,
      model,
      cacheKeyParams: {},
      previousSummary: "",
      sessionId: "s1",
      messages,
      timeZone: "Asia/Shanghai",
      streamFn,
    });

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(result.changed).toBe(false);
    expect(result.data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. legacy utility 路径 — 同一校验与 bounded repair，最终失败不覆盖旧摘要
// ---------------------------------------------------------------------------

describe("SessionSummaryManager rolling summary format validation", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-rolling-format-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const MESSAGES = [{ role: "user", content: "聊聊记忆系统。", timestamp: "2026-06-03T10:00:00.000Z" }];

  it("repairs a format-violating draft before saving", async () => {
    (callText as any)
      .mockResolvedValueOnce(FREE_FORM_SUMMARY)
      .mockResolvedValueOnce(VALID_ZH_SUMMARY);
    const manager = new SessionSummaryManager(tmpDir);

    const summary = await manager.rollingSummary("s1", MESSAGES, RESOLVED_MODEL);

    expect(summary).toBe(VALID_ZH_SUMMARY);
    expect(manager.getSummary("s1").summary).toBe(VALID_ZH_SUMMARY);
    expect(callText).toHaveBeenCalledTimes(2);

    const repairRequest = (callText as any).mock.calls[1][0];
    expect(repairRequest.systemPrompt).toBe(buildRollingSummaryRepairPrompt("zh-CN"));
    expect(repairRequest.messages[0].content).toContain(FREE_FORM_SUMMARY);

    // 修复调用必须用独立 usageContext，operation 与初次生成可区分（账目不混）
    const initialRequest = (callText as any).mock.calls[0][0];
    expect(initialRequest.usageContext.source.operation).toBe("rolling_summary");
    expect(repairRequest.usageContext.source.operation).toBe("rolling_summary_repair");
    expect(repairRequest.usageContext.attribution).toEqual(initialRequest.usageContext.attribution);
  });

  it("throws after the bounded repair budget and keeps the previous summary", async () => {
    const manager = new SessionSummaryManager(tmpDir);
    manager.saveSummary("s1", {
      session_id: "s1",
      created_at: "2026-06-03T09:00:00.000Z",
      updated_at: "2026-06-03T09:00:00.000Z",
      summary: VALID_ZH_SUMMARY,
      messageCount: 0,
    });
    (callText as any).mockResolvedValue(FREE_FORM_SUMMARY);

    await expect(manager.rollingSummary("s1", MESSAGES, RESOLVED_MODEL))
      .rejects.toThrow(/rolling summary format/i);

    expect(callText).toHaveBeenCalledTimes(1 + MAX_ROLLING_SUMMARY_FORMAT_REPAIRS);
    expect(manager.getSummary("s1").summary).toBe(VALID_ZH_SUMMARY);
  });

  it("builds repair input with issues and the draft body", () => {
    const input = buildRollingSummaryRepairInput({
      locale: "zh-CN",
      issues: ["missing fact section heading"],
      summaryText: FREE_FORM_SUMMARY,
    });
    expect(input).toContain("missing fact section heading");
    expect(input).toContain(FREE_FORM_SUMMARY);
  });
});

// ---------------------------------------------------------------------------
// 5. compileEditableFacts 读时兼容 — 旧自由格式摘要显式跳过并记录，不崩溃不污染
// ---------------------------------------------------------------------------

describe("compileEditableFacts legacy free-form summary compatibility", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const logger of loggers.values()) {
      logger.log.mockClear();
      logger.warn.mockClear();
      logger.error.mockClear();
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-compile-legacy-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips free-form summaries explicitly, records the skip, and preserves previous facts", async () => {
    const factsPath = path.join(tmpDir, "facts.md");
    const statePath = path.join(tmpDir, "editable-facts-state.json");
    fs.writeFileSync(factsPath, "用户喜欢清晰边界。", "utf-8");
    // 预先落一个早于本次摘要的水位线，避免基线回填分支吞掉这次调用。
    fs.writeFileSync(statePath, JSON.stringify({
      lastCompiledSummaryUpdatedAt: "2026-06-01T00:00:00.000Z",
    }), "utf-8");
    const mgr = {
      getAllSummaries: vi.fn(() => [
        { session_id: "legacy-1", updated_at: "2026-06-03T10:00:00.000Z", summary: FREE_FORM_SUMMARY },
      ]),
    };

    await compileEditableFacts(mgr, factsPath, RESOLVED_MODEL, { statePath });

    expect(callText).not.toHaveBeenCalled();
    expect(fs.readFileSync(factsPath, "utf-8")).toBe("用户喜欢清晰边界。");

    const warnCalls = [...loggers.values()].flatMap((logger) => logger.warn.mock.calls.map((c) => String(c[0])));
    expect(warnCalls.some((line) => line.includes("legacy-1"))).toBe(true);
  });

  it("does not record a skip for well-formed summaries with an explicit empty fact marker", async () => {
    const factsPath = path.join(tmpDir, "facts.md");
    const statePath = path.join(tmpDir, "editable-facts-state.json");
    fs.writeFileSync(factsPath, "", "utf-8");
    fs.writeFileSync(statePath, JSON.stringify({
      lastCompiledSummaryUpdatedAt: "2026-06-01T00:00:00.000Z",
    }), "utf-8");
    const mgr = {
      getAllSummaries: vi.fn(() => [
        { session_id: "ok-1", updated_at: "2026-06-03T10:00:00.000Z", summary: "### 重要事实\n- 无\n\n### 事情经过\n- 闲聊。" },
      ]),
    };

    await compileEditableFacts(mgr, factsPath, RESOLVED_MODEL, { statePath });

    expect(callText).not.toHaveBeenCalled();
    const warnCalls = [...loggers.values()].flatMap((logger) => logger.warn.mock.calls.map((c) => String(c[0])));
    expect(warnCalls.some((line) => line.includes("ok-1"))).toBe(false);
  });

  it("extraction helpers share one source of truth with the validator", () => {
    expect(hasFactSectionHeading(VALID_ZH_SUMMARY)).toBe(true);
    expect(hasFactSectionHeading(FREE_FORM_SUMMARY)).toBe(false);
    expect(extractFactSection(VALID_ZH_SUMMARY)).toBe("- 用户长期关注记忆系统");
    expect(isEmptyFactSection("- 无")).toBe(true);
    expect(isEmptyFactSection("- None")).toBe(true);
    expect(isEmptyFactSection("- 用户长期关注记忆系统")).toBe(false);
  });
});
