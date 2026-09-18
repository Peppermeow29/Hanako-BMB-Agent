import { describe, expect, it } from "vitest";
import {
  buildLlmContextCachePrefixContract,
  diffCachePrefixContracts,
} from "../lib/llm/cache-prefix-contract.ts";

function tool(name, description = "desc") {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
    },
    execute: () => {},
  };
}

describe("LLM cache prefix contract", () => {
  it("keeps the contract stable when only conversation messages change", () => {
    const base = buildLlmContextCachePrefixContract({
      model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
      systemPrompt: "stable system prompt",
      tools: [tool("read"), tool("exec_command")],
      messages: [{ role: "user", content: "first turn" }],
    } as any);
    const afterToolCall = buildLlmContextCachePrefixContract({
      model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
      systemPrompt: "stable system prompt",
      tools: [tool("read"), tool("exec_command")],
      messages: [
        { role: "user", content: "first turn" },
        { role: "assistant", tool_calls: [{ id: "call_1", function: { name: "read" } }] },
        { role: "tool", content: "dynamic tool result", tool_call_id: "call_1" },
      ],
    } as any);

    expect(afterToolCall.cachePrefixHash).toBe(base.cachePrefixHash);
    expect(diffCachePrefixContracts(base, afterToolCall)).toEqual([]);
  });

  it("detects changes to system prompt, tool schema, and model route", () => {
    const base = buildLlmContextCachePrefixContract({
      model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
      systemPrompt: "stable system prompt",
      tools: [tool("read")],
    });

    expect(diffCachePrefixContracts(base, buildLlmContextCachePrefixContract({
      model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
      systemPrompt: "mutated system prompt",
      tools: [tool("read")],
    })).map((d) => d.field)).toContain("systemPromptHash");

    expect(diffCachePrefixContracts(base, buildLlmContextCachePrefixContract({
      model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
      systemPrompt: "stable system prompt",
      tools: [tool("read", "changed desc")],
    })).map((d) => d.field)).toContain("toolSchemaHash");

    expect(diffCachePrefixContracts(base, buildLlmContextCachePrefixContract({
      model: { id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
      systemPrompt: "stable system prompt",
      tools: [tool("read")],
    })).map((d) => d.field)).toContain("modelHash");
  });
});
