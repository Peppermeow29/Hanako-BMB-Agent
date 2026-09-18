import { describe, expect, it, vi } from "vitest";
import { createToolCatalog } from "../core/tool-catalog.ts";
import {
  BRIDGE_TOOL_NAMES,
  createBridgeTools,
  registerBridgeCapabilityDelegates,
} from "../core/tool-catalog-bridge.ts";
import { resolveToolInvocationPermission } from "../lib/permission/tool-invocation-permission.ts";

const createIssueSchema = {
  type: "object",
  properties: {
    owner: { type: "string", description: "Repository owner" },
    repo: { type: "string", description: "Repository name" },
    title: { type: "string", description: "Issue title" },
    labels: { type: "array", description: "Label names" },
    draft: { type: "boolean", description: "Open as draft" },
    count: { type: "number", description: "How many" },
  },
  required: ["owner", "repo", "title"],
};

function seededCatalog() {
  const catalog = createToolCatalog();
  catalog.registerSource("mcp:github", [
    {
      name: "github_create_issue",
      toolName: "create_issue",
      description: "Create a new issue in a repository.",
      paramsSummary: "owner (string, required), repo (string, required), title (string, required)",
      serverId: "github",
      serverLabel: "GitHub",
      schemaRef: () => createIssueSchema,
    },
    {
      name: "github_list_issues",
      toolName: "list_issues",
      description: "List issues in a repository.",
      paramsSummary: "owner (string, required)",
      serverId: "github",
      serverLabel: "GitHub",
      schemaRef: () => ({ type: "object", properties: { owner: { type: "string" } }, required: ["owner"] }),
    },
  ]);
  catalog.registerSource("mcp:notion", [
    {
      name: "notion_create_page",
      toolName: "create_page",
      description: "Create a page in a Notion database.",
      paramsSummary: "parent_id (string, required)",
      serverId: "notion",
      serverLabel: "Notion",
      schemaRef: () => ({ type: "object", properties: { parent_id: { type: "string" } }, required: ["parent_id"] }),
    },
  ]);
  return catalog;
}

function makeBridge(overrides: Record<string, any> = {}) {
  const catalog = overrides.catalog ?? seededCatalog();
  const mcpCall = overrides.mcpCall ?? vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  const resolveMcpPermission = overrides.resolveMcpPermission ?? vi.fn(() => "review");
  const tools = createBridgeTools({ catalog, mcpCall, resolveMcpPermission, log: { warn() {}, log() {} } });
  const byName = Object.fromEntries(tools.map((tool: any) => [tool.name, tool]));
  return { catalog, mcpCall, resolveMcpPermission, tools, byName };
}

async function run(tool: any, params: unknown) {
  const result = await tool.execute("call-1", params, undefined, undefined, {});
  return result.content.map((block: any) => block.text).join("\n");
}

describe("bridge tool shape", () => {
  it("returns exactly the three bridge tools", () => {
    const { tools } = makeBridge();
    expect(tools.map((tool: any) => tool.name)).toEqual([
      "mcp_search_tools",
      "mcp_describe_tool",
      "mcp_call",
    ]);
    expect(BRIDGE_TOOL_NAMES).toEqual(["mcp_search_tools", "mcp_describe_tool", "mcp_call"]);
  });

  it("scopes every description to external connector tools", () => {
    for (const tool of makeBridge().tools) {
      expect(tool.description.toLowerCase()).toContain("external");
    }
  });

  it("declares the two lookup tools as read and the call tool as an invocation", () => {
    const { byName } = makeBridge();
    expect(resolveToolInvocationPermission(byName.mcp_search_tools, { query: "x" })).toMatchObject({
      ok: true,
      descriptor: { kind: "read", capability: "mcp_search_tools.read" },
    });
    expect(resolveToolInvocationPermission(byName.mcp_describe_tool, { name: "x" })).toMatchObject({
      ok: true,
      descriptor: { kind: "read", capability: "mcp_describe_tool.read" },
    });
  });
});

describe("mcp_search_tools", () => {
  it("lists matches with server, description and required parameters", async () => {
    const { byName } = makeBridge();
    const text = await run(byName.mcp_search_tools, { query: "issue" });
    expect(text).toContain("github_create_issue");
    expect(text).toContain("GitHub");
    expect(text).toContain("Create a new issue");
    expect(text).toContain("owner");
  });

  it("guides the model when nothing matches", async () => {
    const { byName } = makeBridge();
    const text = await run(byName.mcp_search_tools, { query: "zzzzqqqq" });
    expect(text).toMatch(/no match|无匹配/i);
    expect(text).toContain("mcp_describe_tool");
  });

  it("honours an explicit limit", async () => {
    const { byName } = makeBridge();
    const text = await run(byName.mcp_search_tools, { query: "issue", limit: 1 });
    const listed = ["github_create_issue", "github_list_issues"].filter((name) => text.includes(name));
    expect(listed).toHaveLength(1);
  });
});

describe("mcp_describe_tool", () => {
  it("renders the full schema and a call example", async () => {
    const { byName } = makeBridge();
    const text = await run(byName.mcp_describe_tool, { name: "github_create_issue" });
    expect(text).toContain("github_create_issue");
    expect(text).toContain("owner");
    expect(text).toContain("labels");
    expect(text).toContain("mcp_call");
    expect(text).toContain("\"server\"");
  });

  it("suggests near names when the tool is unknown", async () => {
    const { byName } = makeBridge();
    const text = await run(byName.mcp_describe_tool, { name: "issue" });
    expect(text).toMatch(/github_create_issue|github_list_issues/);
  });

  it("reports a clean miss when nothing is even close", async () => {
    const { byName } = makeBridge();
    const text = await run(byName.mcp_describe_tool, { name: "zzzzqqqq" });
    expect(text).toMatch(/not found|未找到|no tool/i);
  });
});

describe("mcp_call argument validation", () => {
  it("advertises arguments as an open JSON object instead of an unconstrained value", () => {
    const { byName } = makeBridge();
    const schema = (byName.mcp_call as any).parameters.properties.arguments;

    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: true,
    });
  });

  it("refuses to call remotely when a required argument is missing", async () => {
    const { byName, mcpCall } = makeBridge();
    const text = await run(byName.mcp_call, {
      server: "github",
      tool: "github_create_issue",
      arguments: { owner: "acme" },
    });
    expect(text).toMatch(/repo/);
    expect(text).toMatch(/title/);
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it("refuses to call remotely when an argument has the wrong type", async () => {
    const { byName, mcpCall } = makeBridge();
    const text = await run(byName.mcp_call, {
      server: "github",
      tool: "github_create_issue",
      arguments: { owner: "acme", repo: "widgets", title: 42 },
    });
    expect(text).toMatch(/title/);
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it("rejects a non object arguments value", async () => {
    const { byName, mcpCall } = makeBridge();
    const text = await run(byName.mcp_call, { server: "github", tool: "github_create_issue", arguments: "nope" });
    expect(text).toMatch(/object|对象/i);
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it("forwards a valid call with the server side tool name", async () => {
    const { byName, mcpCall } = makeBridge();
    await run(byName.mcp_call, {
      server: "github",
      tool: "github_create_issue",
      arguments: { owner: "acme", repo: "widgets", title: "Bug" },
    });
    expect(mcpCall).toHaveBeenCalledTimes(1);
    const [serverId, toolName, args] = (mcpCall as any).mock.calls[0];
    expect(serverId).toBe("github");
    expect(toolName).toBe("create_issue");
    expect(args).toEqual({ owner: "acme", repo: "widgets", title: "Bug" });
  });

  it("accepts the server side tool name as well as the catalog name", async () => {
    const { byName, mcpCall } = makeBridge();
    await run(byName.mcp_call, {
      server: "github",
      tool: "create_issue",
      arguments: { owner: "acme", repo: "widgets", title: "Bug" },
    });
    expect(mcpCall).toHaveBeenCalledTimes(1);
  });

  it("reports an unknown target without calling out", async () => {
    const { byName, mcpCall } = makeBridge();
    const text = await run(byName.mcp_call, { server: "github", tool: "nope", arguments: {} });
    expect(text).toMatch(/not found|未找到|unknown/i);
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it("allows optional arguments to be omitted", async () => {
    const { byName, mcpCall } = makeBridge();
    await run(byName.mcp_call, {
      server: "github",
      tool: "github_create_issue",
      arguments: { owner: "a", repo: "b", title: "c", draft: true, count: 2, labels: ["x"] },
    });
    expect(mcpCall).toHaveBeenCalledTimes(1);
  });
});

describe("mcp_call permission unwrapping", () => {
  function registered() {
    const bridge = makeBridge();
    registerBridgeCapabilityDelegates(bridge.tools, { catalog: bridge.catalog });
    return bridge;
  }

  it("resolves the descriptor under the real target tool name", () => {
    const { byName, resolveMcpPermission } = registered();
    const result = resolveToolInvocationPermission(byName.mcp_call, {
      server: "github",
      tool: "github_create_issue",
      arguments: {},
    });
    expect(result).toMatchObject({
      ok: true,
      source: "descriptor",
      descriptor: { action: "invoke", capability: "github_create_issue.invoke" },
    });
    expect(resolveMcpPermission).toHaveBeenCalledWith("github", "create_issue");
  });

  it("carries the permission kind decided for the real tool", () => {
    const bridge = makeBridge({ resolveMcpPermission: vi.fn(() => "read") });
    registerBridgeCapabilityDelegates(bridge.tools, { catalog: bridge.catalog });
    expect(resolveToolInvocationPermission(bridge.byName.mcp_call, {
      server: "github",
      tool: "github_create_issue",
    })).toMatchObject({ descriptor: { kind: "read" } });
  });

  it("never presents mcp_call.invoke as the granted capability", () => {
    const { byName } = registered();
    const result = resolveToolInvocationPermission(byName.mcp_call, {
      server: "github",
      tool: "github_create_issue",
    });
    expect((result as any).descriptor.capability).not.toBe("mcp_call.invoke");
  });

  it("produces the same capability the direct load path would use", () => {
    // The direct path builds `${toMcpToolId(server, tool)}.invoke`; a session
    // grant is keyed on that string alone, so both paths must agree exactly.
    const { byName } = registered();
    const result = resolveToolInvocationPermission(byName.mcp_call, {
      server: "notion",
      tool: "notion_create_page",
    });
    expect((result as any).descriptor.capability).toBe("notion_create_page.invoke");
  });

  it("fails closed for a target that is not in the catalog", () => {
    const { byName } = registered();
    expect(resolveToolInvocationPermission(byName.mcp_call, {
      server: "github",
      tool: "mcp_connectors_status",
    })).toMatchObject({ ok: false });
  });

  it("fails closed when the server does not own the named tool", () => {
    const { byName } = registered();
    expect(resolveToolInvocationPermission(byName.mcp_call, {
      server: "notion",
      tool: "github_create_issue",
    })).toMatchObject({ ok: false });
  });

  it("fails closed when the host never registered the delegate", () => {
    const { byName } = makeBridge();
    expect(resolveToolInvocationPermission(byName.mcp_call, {
      server: "github",
      tool: "github_create_issue",
    })).toMatchObject({ ok: false, error: { reason: "unknown_capability" } });
  });

  it("stops resolving once a tool leaves the catalog", () => {
    const { byName, catalog } = registered();
    catalog.removeSource("mcp:github");
    expect(resolveToolInvocationPermission(byName.mcp_call, {
      server: "github",
      tool: "github_create_issue",
    })).toMatchObject({ ok: false });
  });
});
