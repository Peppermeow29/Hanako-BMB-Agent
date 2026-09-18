import { describe, expect, it, vi } from "vitest";
import {
  PI_BUILTIN_TOOL_NAMES,
  agentToolToToolDefinition,
  normalizeCreateAgentSessionOptions,
  uniqueToolNames,
} from "../lib/pi-sdk/session-options.ts";

function makeAgentTool(name) {
  return {
    name,
    label: `${name} label`,
    description: `${name} description`,
    parameters: { type: "object", properties: {} },
    prepareArguments: vi.fn(args => args),
    executionMode: "foreground",
    renderCall: vi.fn(),
    renderResult: vi.fn(),
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
  };
}

describe("Pi SDK session option normalization", () => {
  it("exposes stable Hana built-in tool names without SDK prebuilt objects", () => {
    expect(PI_BUILTIN_TOOL_NAMES).toEqual(["read", "write", "edit", "exec_command", "write_stdin", "grep", "find", "ls"]);
    expect(Object.isFrozen(PI_BUILTIN_TOOL_NAMES)).toBe(true);
  });

  it("converts AgentTool objects into SDK ToolDefinition objects", async () => {
    const read = makeAgentTool("read");
    const definition = agentToolToToolDefinition(read);

    expect(definition).toMatchObject({
      name: "read",
      label: "read label",
      description: "read description",
      parameters: { type: "object", properties: {} },
      executionMode: "foreground",
    });

    const result = await definition.execute("call-1", { path: "a.txt" }, "signal", "update", { session: true });
    expect(read.execute).toHaveBeenCalledWith("call-1", { path: "a.txt" }, "signal", "update", { session: true });
    expect(result.content[0].text).toBe("ok");
  });

  it("executes the same toolCallId only once and reuses the first result", async () => {
    const read = makeAgentTool("read");
    const definition = agentToolToToolDefinition(read);

    const first = await definition.execute("call-repeat", { path: "a.txt" }, "signal", "update", { session: true });
    const second = await definition.execute("call-repeat", { path: "a.txt" }, "signal", "update", { session: true });

    expect(read.execute).toHaveBeenCalledOnce();
    expect(second).toBe(first);
  });

  it("dedupes missing-id calls by normalized name, args, and assistantMessageId", async () => {
    const custom = {
      name: "web_search",
      description: "search",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => ({ content: [{ type: "text", text: "searched" }] })),
    };

    const normalized = normalizeCreateAgentSessionOptions({
      tools: [],
      customTools: [custom],
    }, "0.70.2");
    const definition = normalized.customTools[0];

    const first = await definition.execute("", { query: "Hana", filters: { b: 2, a: 1 } }, null, null, { assistantMessageId: "assistant-1" });
    const second = await definition.execute(null, { filters: { a: 1, b: 2 }, query: "Hana" }, null, null, { assistantMessageId: "assistant-1" });
    const third = await definition.execute(null, { filters: { a: 1, b: 2 }, query: "Hana" }, null, null, { assistantMessageId: "assistant-2" });

    expect(custom.execute).toHaveBeenCalledTimes(2);
    expect(second).toBe(first);
    expect(third.content[0].text).toBe("searched");
  });

  it("normalizes Hana Tool[] plus customTools into Pi 0.68+ name allowlist and SDK custom tools", () => {
    const read = makeAgentTool("read");
    const execCommand = makeAgentTool("exec_command");
    const custom = {
      name: "web_search",
      description: "search",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    };

    const normalized = normalizeCreateAgentSessionOptions({
      cwd: "/tmp/project",
      tools: [read, execCommand],
      customTools: [custom],
      model: { id: "m" },
    }, "0.70.2");

    expect(normalized.tools).toEqual(["read", "exec_command", "web_search"]);
    expect(normalized.customTools.map(t => t.name)).toEqual(["read", "exec_command", "web_search"]);
    expect(normalized.customTools[0]).not.toBe(read);
    expect(normalized.customTools[2]).not.toBe(custom);
    expect(normalized.model).toEqual({ id: "m" });
  });

  it("keeps MCP custom tool definitions in the Pi SDK name allowlist", () => {
    const read = makeAgentTool("read");
    const mcpTool = {
      name: "mcp_github_search",
      description: "Search GitHub through MCP",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      invocationStyle: "pi_tool",
      execute: vi.fn(),
    };

    const normalized = normalizeCreateAgentSessionOptions({
      tools: [read],
      customTools: [mcpTool],
    }, "0.70.2");

    expect(normalized.tools).toEqual(["read", "mcp_github_search"]);
    expect(normalized.customTools.map(t => t.name)).toEqual(["read", "mcp_github_search"]);
    expect(normalized.customTools[1]).not.toBe(mcpTool);
    expect(normalized.customTools[1].parameters).toEqual(mcpTool.parameters);
  });

  it("keeps empty tools empty for explicit no-tools sessions", () => {
    const normalized = normalizeCreateAgentSessionOptions({
      tools: [],
      customTools: [],
    }, "0.70.2");

    expect(normalized.tools).toEqual([]);
    expect(normalized.customTools).toEqual([]);
  });

  it("deduplicates active names while preserving first occurrence order", () => {
    expect(uniqueToolNames(["read", "exec_command", "read", "", null, "web_search"])).toEqual([
      "read",
      "exec_command",
      "web_search",
    ]);
  });

  it("keeps same-name custom definitions after converted base tools so SDK override order remains explicit", () => {
    const read = makeAgentTool("read");
    const customRead = {
      name: "read",
      description: "custom read",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    };

    const normalized = normalizeCreateAgentSessionOptions({
      tools: [read],
      customTools: [customRead],
    }, "0.70.2");

    expect(normalized.tools).toEqual(["read"]);
    expect(normalized.customTools.map(t => t.name)).toEqual(["read", "read"]);
    expect(normalized.customTools[1]).not.toBe(customRead);
    expect(normalized.customTools[1].name).toBe(customRead.name);
  });

  it("throws a clear error for malformed base tools in Pi 0.68+ mode", () => {
    expect(() => normalizeCreateAgentSessionOptions({
      tools: [{ name: "read" }],
      customTools: [],
    }, "0.70.2")).toThrow("createAgentSession.tools.read must have an execute function");
  });

  it("throws a clear error for malformed custom tools in Pi 0.68+ mode", () => {
    const read = makeAgentTool("read");
    expect(() => normalizeCreateAgentSessionOptions({
      tools: [read],
      customTools: [{}],
    }, "0.70.2")).toThrow("createAgentSession.customTools contains a tool without a non-empty string name");
  });

  it("preserves old SDK options for pre-0.68 compatibility", () => {
    const read = makeAgentTool("read");
    const options = { tools: [read], customTools: [] };
    expect(normalizeCreateAgentSessionOptions(options, "0.67.68")).toBe(options);
  });
});
