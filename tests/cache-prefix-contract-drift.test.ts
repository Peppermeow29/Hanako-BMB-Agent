import { describe, expect, it } from "vitest";
import {
  buildLlmContextCachePrefixContract,
  describeCachePrefixDrift,
} from "../lib/llm/cache-prefix-contract.ts";

const MODEL = {
  id: "deepseek-v4-pro",
  provider: "deepseek",
  api: "openai-completions",
  baseUrl: "https://api.deepseek.com",
};

function tool(name, description = "desc", extra = {}) {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, ...extra },
    },
    execute: () => {},
  };
}

function stripOriginals(contract) {
  const { systemPrompt, tools, ...rest } = contract;
  return rest;
}

describe("describeCachePrefixDrift", () => {
  it("locates the first differing character of the system prompt and quotes both sides", () => {
    const head = "H".repeat(300);
    const tail = "T".repeat(300);
    const expected = buildLlmContextCachePrefixContract({
      model: MODEL,
      systemPrompt: `${head}EXPECTED-MARKER${tail}`,
      tools: [tool("read")],
    });
    const actual = buildLlmContextCachePrefixContract({
      model: MODEL,
      systemPrompt: `${head}ACTUAL-MARKER${tail}`,
      tools: [tool("read")],
    });

    const drift = describeCachePrefixDrift(expected, actual);

    expect(drift.fields).toContain("systemPromptHash");
    expect(drift.fields).toContain("cachePrefixHash");
    expect(drift.fields).not.toContain("toolSchemaHash");
    expect(drift.tools).toBeNull();

    expect(drift.systemPrompt).not.toBeNull();
    expect(drift.systemPrompt.firstDiffIndex).toBe(300);
    expect(drift.systemPrompt.expectedBytes).toBe(300 + "EXPECTED-MARKER".length + 300);
    expect(drift.systemPrompt.actualBytes).toBe(300 + "ACTUAL-MARKER".length + 300);
    expect(drift.systemPrompt.expectedExcerpt).toContain("EXPECTED-MARKER");
    expect(drift.systemPrompt.actualExcerpt).toContain("ACTUAL-MARKER");
    // 摘录以差异点为中心、前后各 120 字符，不得把整段 prompt 倒进日志
    expect(drift.systemPrompt.expectedExcerpt.length).toBeLessThanOrEqual(241);
    expect(drift.systemPrompt.actualExcerpt.length).toBeLessThanOrEqual(241);
    expect(drift.systemPrompt.expectedExcerpt.startsWith("H")).toBe(true);
  });

  it("reports added, removed, and schema-changed tools by name", () => {
    const expected = buildLlmContextCachePrefixContract({
      model: MODEL,
      systemPrompt: "stable system prompt",
      tools: [tool("read"), tool("exec_command"), tool("glob")],
    });
    const actual = buildLlmContextCachePrefixContract({
      model: MODEL,
      systemPrompt: "stable system prompt",
      tools: [tool("read", "desc", { limit: { type: "number" } }), tool("glob"), tool("write")],
    });

    const drift = describeCachePrefixDrift(expected, actual);

    expect(drift.fields).toContain("toolSchemaHash");
    expect(drift.systemPrompt).toBeNull();
    expect(drift.tools).not.toBeNull();
    expect(drift.tools.added).toEqual(["write"]);
    expect(drift.tools.removed).toEqual(["exec_command"]);
    expect(drift.tools.changed).toEqual(["read"]);
  });

  it("tolerates legacy contracts that carry only hashes", () => {
    const expected = stripOriginals(buildLlmContextCachePrefixContract({
      model: MODEL,
      systemPrompt: "legacy system prompt",
      tools: [tool("read"), tool("exec_command")],
    }));
    const actual = stripOriginals(buildLlmContextCachePrefixContract({
      model: MODEL,
      systemPrompt: "mutated system prompt with more words",
      tools: [tool("read")],
    }));

    expect(expected.systemPrompt).toBeUndefined();
    expect(actual.tools).toBeUndefined();

    const drift = describeCachePrefixDrift(expected, actual);

    expect(drift.systemPrompt.firstDiffIndex).toBe(-1);
    expect(drift.systemPrompt.expectedExcerpt).toBeNull();
    expect(drift.systemPrompt.actualExcerpt).toBeNull();
    // 哈希之外的元数据仍然可用，字节数照填
    expect(drift.systemPrompt.expectedBytes).toBe("legacy system prompt".length);
    expect(drift.systemPrompt.actualBytes).toBe("mutated system prompt with more words".length);
    // 原文缺失时只能凭工具名列出增删，改动无从判断
    expect(drift.tools.removed).toEqual(["exec_command"]);
    expect(drift.tools.added).toEqual([]);
    expect(drift.tools.changed).toEqual([]);
  });

  it("returns an empty drift for identical contracts", () => {
    const input = {
      model: MODEL,
      systemPrompt: "stable system prompt",
      tools: [tool("read"), tool("exec_command")],
    };
    const drift = describeCachePrefixDrift(
      buildLlmContextCachePrefixContract(input),
      buildLlmContextCachePrefixContract(input),
    );

    expect(drift.fields).toEqual([]);
    expect(drift.systemPrompt).toBeNull();
    expect(drift.tools).toBeNull();
  });

  it("keeps the prompt and tool originals out of the event summary", async () => {
    const { summarizeCachePrefixContract } = await import("../lib/llm/cache-prefix-contract.ts");
    const contract = buildLlmContextCachePrefixContract({
      model: MODEL,
      systemPrompt: "a secret-bearing system prompt",
      tools: [tool("read")],
    });
    expect(contract.systemPrompt).toBe("a secret-bearing system prompt");
    const summary = summarizeCachePrefixContract(contract) as any;
    expect(summary.systemPrompt).toBeUndefined();
    expect(summary.tools).toBeUndefined();
  });
});
