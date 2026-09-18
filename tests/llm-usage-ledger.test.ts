import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsageLedger } from "../lib/llm/usage-ledger.ts";

function sessionContext(sessionPath = "/tmp/session.jsonl", sessionId: string | null = null) {
  return {
    source: {
      subsystem: "session",
      operation: "reply",
      surface: "desktop",
      trigger: "user",
    },
    attribution: {
      kind: "session",
      agentId: "agent-1",
      ...(sessionId ? { sessionId } : {}),
      sessionPath,
    },
  };
}

describe("Usage ledger", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("records a completed request with normalized usage and emits llm_usage", () => {
    const events = [];
    const ledger = createUsageLedger({
      now: () => 1_000,
      eventBus: { emit: (event, scope) => events.push({ event, scope }) },
      requestIdFactory: () => "req-1",
    });

    const req = ledger.start({
      model: { provider: "openai", modelId: "gpt-5", api: "openai-completions" },
      usageContext: sessionContext("/sessions/a.jsonl"),
    });
    const entry = ledger.finish(req.requestId, {
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });

    expect(entry).toMatchObject({
      schemaVersion: 1,
      requestId: "req-1",
      status: "ok",
      source: { subsystem: "session", operation: "reply" },
      attribution: { kind: "session", sessionPath: "/sessions/a.jsonl" },
      model: { provider: "openai", modelId: "gpt-5", api: "openai-completions" },
      usage: { input: { totalTokens: 10 }, output: { totalTokens: 2 }, totalTokens: 12 },
    });
    expect(ledger.list({}).entries).toHaveLength(1);
    expect(events).toEqual([
      { event: { type: "llm_usage", entry }, scope: "/sessions/a.jsonl" },
    ]);
  });

  it("list 支持 childSessionPath 过滤（workflow 节点级 token 查询）", () => {
    const ledger = createUsageLedger({ now: () => 1000, requestIdFactory: () => "req-cs" });
    const req = ledger.start({
      model: { provider: "openai", modelId: "gpt-5", api: "openai-completions" },
      usageContext: {
        source: { subsystem: "subagent", operation: "run", surface: "desktop", trigger: "tool" },
        attribution: { kind: "session", sessionPath: "/parent.jsonl", childSessionPath: "/child-1.jsonl" },
      },
    });
    ledger.finish(req.requestId, { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
    expect(ledger.list({ childSessionPath: "/child-1.jsonl" }).entries).toHaveLength(1);
    expect(ledger.list({ childSessionPath: "/other.jsonl" }).entries).toHaveLength(0);
  });

  it("records usage_missing for completed requests without provider usage", () => {
    const ledger = createUsageLedger({ now: () => 1_000, requestIdFactory: () => "req-missing" });

    const req = ledger.start({
      model: { provider: "anthropic", modelId: "claude", api: "anthropic-messages" },
      usageContext: sessionContext(),
    });
    const entry = ledger.finish(req.requestId, { usage: null });

    expect(entry).toMatchObject({
      requestId: "req-missing",
      status: "usage_missing",
      usage: null,
    });
  });

  it("preserves cache strategy metadata on entries", () => {
    const ledger = createUsageLedger({ now: () => 1_000, requestIdFactory: () => "req-cache-meta" });
    const req = ledger.start({
      model: { provider: "openai", modelId: "gpt-5.1", api: "openai-responses" },
      usageContext: sessionContext("/sessions/cache.jsonl"),
      metadata: {
        cacheStrategy: "session_snapshot",
        cacheGroup: "memory.reflection",
        strict: true,
        cachePrefixHash: "b".repeat(64),
        parentCachePrefixHash: "a".repeat(64),
      },
    });

    const entry = ledger.finish(req.requestId, {
      usage: { input_tokens: 100, cache_read_input_tokens: 90, output_tokens: 10 },
    });

    expect(entry.metadata).toMatchObject({
      cacheStrategy: "session_snapshot",
      cacheGroup: "memory.reflection",
      strict: true,
      parentCachePrefixHash: "a".repeat(64),
    });
    expect(ledger.list({ sessionPath: "/sessions/cache.jsonl" }).entries[0].metadata).toMatchObject({
      cacheStrategy: "session_snapshot",
    });
  });

  it("filters by sessionId so usage survives session path moves", () => {
    const ledger = createUsageLedger({ now: () => 1_000, requestIdFactory: () => "req-session-id" });

    ledger.record({
      model: { provider: "openai", modelId: "gpt-5", api: "openai-completions" },
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      usageContext: sessionContext("/sessions/original.jsonl", "sess_usage_stable"),
    });

    expect(ledger.list({ sessionId: "sess_usage_stable" }).entries).toMatchObject([
      {
        requestId: "req-session-id",
        attribution: {
          kind: "session",
          sessionId: "sess_usage_stable",
          sessionPath: "/sessions/original.jsonl",
        },
      },
    ]);
    expect(ledger.list({ sessionId: "sess_other" }).entries).toHaveLength(0);
  });

  it("records errors without prompt content", () => {
    const ledger = createUsageLedger({ now: () => 1_000, requestIdFactory: () => "req-error" });
    const req = ledger.start({
      model: { provider: "openai", modelId: "gpt-5", api: "openai-completions" },
      usageContext: sessionContext(),
    });

    const entry = ledger.recordError(req.requestId, new Error("boom"));

    expect(entry).toMatchObject({
      requestId: "req-error",
      status: "error",
      error: { name: "Error", message: "boom" },
    });
    expect(JSON.stringify(entry)).not.toContain("prompt");
  });

  it("bounds entries and filters by model, subsystem, status, and session", () => {
    let clock = 1_000;
    let id = 0;
    const ledger = createUsageLedger({
      maxEntries: 2,
      now: () => clock,
      requestIdFactory: () => `req-${++id}`,
    });

    ledger.record({
      model: { provider: "openai", modelId: "gpt-5", api: "openai-completions" },
      usage: { prompt_tokens: 10, completion_tokens: 1 },
      usageContext: sessionContext("/sessions/a.jsonl"),
    });
    clock += 1_000;
    ledger.record({
      model: { provider: "anthropic", modelId: "claude", api: "anthropic-messages" },
      usage: { input: 20, output: 2 },
      usageContext: sessionContext("/sessions/b.jsonl"),
    });
    clock += 1_000;
    ledger.recordError(
      ledger.start({
        model: { provider: "openai", modelId: "gpt-5-mini", api: "openai-completions" },
        usageContext: {
          source: { subsystem: "memory", operation: "compile_today", surface: "system", trigger: "daily" },
          attribution: { kind: "memory", agentId: "agent-1" },
        },
      }).requestId,
      new Error("daily failed")
    );

    expect(ledger.list({}).entries.map(entry => entry.requestId)).toEqual(["req-2", "req-3"]);
    expect(ledger.list({ provider: "anthropic" }).entries).toHaveLength(1);
    expect(ledger.list({ subsystem: "memory", status: "error" }).entries).toHaveLength(1);
    expect(ledger.list({ sessionPath: "/sessions/a.jsonl" }).entries).toHaveLength(0);
    expect(ledger.list({ attributionKind: "memory" }).entries[0].model.modelId).toBe("gpt-5-mini");
  });

  it("warns when a first-party call records unknown usage context", () => {
    const logger = { warn: vi.fn() };
    const ledger = createUsageLedger({ logger, requestIdFactory: () => "req-unknown" });

    ledger.record({
      model: { provider: null, modelId: null, api: null },
      usage: { input: 1, output: 1 },
      usageContext: null,
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("unknown usage context"));
  });

  it("persists completed entries so a new ledger can restore them after restart", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-usage-ledger-"));
    const storagePath = path.join(tmpDir, "usage-ledger.json");
    const ledger = createUsageLedger({
      storagePath,
      requestIdFactory: () => "req-persisted",
      now: () => 1_000,
    });

    ledger.record({
      model: { provider: "openai", modelId: "gpt-5", api: "openai-completions" },
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      usageContext: sessionContext("/sessions/persisted.jsonl"),
    });

    const restored = createUsageLedger({ storagePath });

    expect(restored.list({}).entries).toMatchObject([
      {
        requestId: "req-persisted",
        attribution: { kind: "session", sessionPath: "/sessions/persisted.jsonl" },
        usage: { totalTokens: 12 },
      },
    ]);
    expect(JSON.parse(fs.readFileSync(storagePath, "utf-8"))).toMatchObject({
      version: 1,
      entries: [{ requestId: "req-persisted" }],
    });
  });

  it("returns every entry in an explicit date window before applying any default list cap", () => {
    let clock = Date.parse("2026-05-20T00:00:00.000Z");
    let id = 0;
    const ledger = createUsageLedger({
      maxEntries: 1_000,
      now: () => clock,
      requestIdFactory: () => `req-${++id}`,
    });

    for (let index = 0; index < 600; index += 1) {
      ledger.record({
        model: { provider: "openai", modelId: "gpt-5", api: "openai-responses" },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        usageContext: sessionContext(`/sessions/day-${index}.jsonl`),
      });
      clock += 1_000;
    }

    const result = ledger.list({
      since: "2026-05-20T00:00:00.000Z",
      until: "2026-05-21T00:00:00.000Z",
    });

    expect(result.entries).toHaveLength(600);
    expect(result.entries[0].requestId).toBe("req-1");
    expect(result.entries.at(-1)?.requestId).toBe("req-600");
  });
});
