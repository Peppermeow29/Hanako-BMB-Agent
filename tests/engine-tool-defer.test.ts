import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HanaEngine } from "../core/engine.ts";
import { toMcpToolId } from "../core/mcp/manager.ts";
import { resolveToolInvocationPermission } from "../lib/permission/tool-invocation-permission.ts";

const BRIDGE_NAMES = ["mcp_search_tools", "mcp_describe_tool", "mcp_call"];

function connectorTool(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    description: `Tool ${name} for repository work.`,
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, note: { type: "string" } },
      required: ["owner"],
    },
    ...extra,
  };
}

/**
 * Builds the engine stub the same way the existing buildTools suite does, with
 * an MCP manager whose published tools and catalog entries agree.
 */
function makeEngine({
  connectors,
  deferEnabled = true,
  deferThreshold = 10,
  pluginTools = [],
  builtinDefer = false,
}: {
  connectors: { id: string; name?: string; tools: any[]; pinnedTools?: Record<string, boolean> }[];
  deferEnabled?: boolean;
  deferThreshold?: number;
  pluginTools?: any[];
  builtinDefer?: boolean;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-defer-engine-"));
  const agentDir = path.join(tmpDir, "agents", "focus");
  const workspace = path.join(tmpDir, "workspace");
  const agent = { id: "focus", agentDir, config: {}, tools: [] };

  const normalized = connectors.map((connector) => ({
    id: connector.id,
    name: connector.name || connector.id,
    tools: connector.tools,
    pinnedTools: connector.pinnedTools || {},
  }));

  const published = normalized.flatMap((connector) => connector.tools.map((tool: any) => ({
    name: `mcp_${toMcpToolId(connector.id, tool.name)}`,
    description: tool.description,
    parameters: tool.inputSchema,
    _pluginId: "mcp",
    sessionPermission: {
      resolveInvocation: () => ({
        action: "invoke",
        kind: "review",
        capability: `${toMcpToolId(connector.id, tool.name)}.invoke`,
      }),
    },
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
  })));

  const engine = Object.create(HanaEngine.prototype);
  engine.hanakoHome = tmpDir;
  engine.getAgent = vi.fn(() => agent);
  engine._pluginManager = pluginTools.length > 0 ? { getAllTools: () => pluginTools } : null;
  engine._mcp = {
    getAllTools: () => published,
    getConfig: () => ({ enabled: true, deferEnabled, deferThreshold, connectors: normalized }),
    getCatalogEntries: () => normalized.flatMap((connector) => connector.tools.map((tool: any) => ({
      name: toMcpToolId(connector.id, tool.name),
      toolName: tool.name,
      description: tool.description,
      paramsSummary: "owner (string, required)",
      serverId: connector.id,
      serverLabel: connector.name,
      deferrable: tool.deferrable !== false,
      pinned: connector.pinnedTools?.[tool.name] === true,
      schemaRef: () => tool.inputSchema,
    }))),
    resolveToolPermissionKind: () => "review",
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
  };
  engine._prefs = {
    getFileBackup: () => ({ enabled: false }),
    getBuiltinToolDeferEnabled: () => builtinDefer,
  };
  engine._readPreferences = () => ({ sandbox: true });
  engine._confirmStore = null;
  engine._emitEvent = vi.fn();
  engine.getSessionPermissionMode = vi.fn(() => "operate");
  engine._agentMgr = { agent };

  const build = () => engine.buildTools(workspace, [], {
    agentDir,
    workspace,
    getSessionPath: () => path.join(agentDir, "sessions", "main.jsonl"),
    getPermissionMode: () => "operate",
  });
  return { engine, build, tmpDir, agentDir, workspace };
}

function manyTools(count: number, prefix = "t") {
  return Array.from({ length: count }, (_, index) => connectorTool(`${prefix}_${index}`));
}

describe("engine deferred tool assembly", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function build(options: Parameters<typeof makeEngine>[0]) {
    const made = makeEngine(options);
    dirs.push(made.tmpDir);
    return made.build();
  }

  it("loads every tool directly when the count equals the threshold", () => {
    const { customTools } = build({
      connectors: [{ id: "github", tools: manyTools(10) }],
      deferThreshold: 10,
    });
    const names = customTools.map((tool: any) => tool.name);
    expect(names).toContain("mcp_github_t_0");
    expect(names).toContain("mcp_github_t_9");
    for (const bridge of BRIDGE_NAMES) expect(names).not.toContain(bridge);
  });

  it("switches to catalog mode one tool past the threshold", () => {
    const { customTools } = build({
      connectors: [{ id: "github", tools: manyTools(11) }],
      deferThreshold: 10,
    });
    const names = customTools.map((tool: any) => tool.name);
    for (const bridge of BRIDGE_NAMES) expect(names).toContain(bridge);
    expect(names.filter((name: string) => name.startsWith("mcp_github_t_"))).toEqual([]);
  });

  it("loads everything directly when defer is turned off", () => {
    const { customTools } = build({
      connectors: [{ id: "github", tools: manyTools(40) }],
      deferEnabled: false,
    });
    const names = customTools.map((tool: any) => tool.name);
    expect(names).toContain("mcp_github_t_0");
    for (const bridge of BRIDGE_NAMES) expect(names).not.toContain(bridge);
  });

  it("defers every server's tools together rather than leaving a mixed state", () => {
    const { customTools } = build({
      connectors: [
        { id: "github", tools: manyTools(8, "g") },
        { id: "notion", tools: manyTools(8, "n") },
      ],
      deferThreshold: 10,
    });
    const names = customTools.map((tool: any) => tool.name);
    expect(names.filter((name: string) => name.startsWith("mcp_github_"))).toEqual([]);
    expect(names.filter((name: string) => name.startsWith("mcp_notion_"))).toEqual([]);
    for (const bridge of BRIDGE_NAMES) expect(names).toContain(bridge);
  });

  it("keeps pinned tools loaded while the rest defer", () => {
    const { customTools } = build({
      connectors: [{
        id: "github",
        tools: manyTools(12),
        pinnedTools: { t_0: true },
      }],
      deferThreshold: 10,
    });
    const names = customTools.map((tool: any) => tool.name);
    expect(names).toContain("mcp_github_t_0");
    expect(names).not.toContain("mcp_github_t_1");
    for (const bridge of BRIDGE_NAMES) expect(names).toContain(bridge);
  });

  it("does not count pinned tools toward the defer threshold", () => {
    // 11 tools, but one is pinned, so only 10 are deferrable: still direct load.
    const { customTools } = build({
      connectors: [{ id: "github", tools: manyTools(11), pinnedTools: { t_0: true } }],
      deferThreshold: 10,
    });
    const names = customTools.map((tool: any) => tool.name);
    expect(names).toContain("mcp_github_t_5");
    for (const bridge of BRIDGE_NAMES) expect(names).not.toContain(bridge);
  });

  it("keeps a tool that declares itself non deferrable loaded", () => {
    const tools = manyTools(12);
    (tools[3] as any).deferrable = false;
    const { customTools } = build({
      connectors: [{ id: "github", tools }],
      deferThreshold: 10,
    });
    const names = customTools.map((tool: any) => tool.name);
    expect(names).toContain("mcp_github_t_3");
    expect(names).not.toContain("mcp_github_t_4");
  });

  it("leaves plugin tools alone while builtin defer is off", () => {
    const pluginTools = Array.from({ length: 15 }, (_, index) => ({
      name: `plugin_tool_${index}`,
      description: "A plugin tool.",
      _pluginId: "demo",
      execute: vi.fn(),
    }));
    const { customTools } = build({
      connectors: [{ id: "github", tools: manyTools(11) }],
      deferThreshold: 10,
      pluginTools,
    });
    const names = customTools.map((tool: any) => tool.name);
    expect(names).toContain("plugin_tool_0");
    expect(names).toContain("plugin_tool_14");
  });
});

describe("bridge permission through the real engine assembly", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Builds a catalog-mode tool set whose session is read-only, so a review-kind
   * invocation only proceeds when the session already granted its capability.
   * That makes the grant the thing under test.
   */
  function readOnlySessionWithGrants(grants: string[]) {
    const made = makeEngine({
      connectors: [{ id: "github", name: "GitHub", tools: manyTools(11) }],
      deferThreshold: 10,
    });
    dirs.push(made.tmpDir);
    made.engine.getSessionAllowedInvocationCapabilities = () => grants;
    made.engine.getSessionPermissionMode = () => "read_only";
    const { customTools } = made.engine.buildTools(made.workspace, [], {
      agentDir: made.agentDir,
      workspace: made.workspace,
      getSessionPath: () => path.join(made.agentDir, "sessions", "main.jsonl"),
      getPermissionMode: () => "read_only",
      allowHumanApproval: false,
    });
    return { made, customTools, sessionPath: path.join(made.agentDir, "sessions", "main.jsonl") };
  }

  async function callBridge(customTools: any[], tool: string, sessionPath: string) {
    const callTool = customTools.find((entry: any) => entry.name === "mcp_call");
    expect(callTool).toBeTruthy();
    return callTool.execute("call-1", {
      server: "github",
      tool,
      arguments: { owner: "acme" },
    }, { sessionPath, sessionManager: { getSessionFile: () => sessionPath } });
  }

  it("lets a bridged call through on a grant issued for the real target tool", async () => {
    // The grant names the tool itself, exactly as the direct-load path would
    // have recorded it. Reaching the tool through the bridge must honour it.
    const { made, customTools, sessionPath } = readOnlySessionWithGrants(["github_t_0.invoke"]);
    await callBridge(customTools, "github_t_0", sessionPath);
    expect(made.engine._mcp.callTool).toHaveBeenCalledTimes(1);
    expect((made.engine._mcp.callTool as any).mock.calls[0][1]).toBe("t_0");
  });

  it("does not let a grant for one tool carry over to another", async () => {
    const { made, customTools, sessionPath } = readOnlySessionWithGrants(["github_t_0.invoke"]);
    await callBridge(customTools, "github_t_1", sessionPath);
    expect(made.engine._mcp.callTool).not.toHaveBeenCalled();
  });

  it("refuses a bridged call when the session granted nothing", async () => {
    const { made, customTools, sessionPath } = readOnlySessionWithGrants([]);
    await callBridge(customTools, "github_t_0", sessionPath);
    expect(made.engine._mcp.callTool).not.toHaveBeenCalled();
  });

  it("never accepts a grant issued for the bridge itself", async () => {
    const { made, customTools, sessionPath } = readOnlySessionWithGrants(["mcp_call.invoke"]);
    await callBridge(customTools, "github_t_0", sessionPath);
    expect(made.engine._mcp.callTool).not.toHaveBeenCalled();
  });
});

describe("build result carries the catalog manifest", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function build(options: Parameters<typeof makeEngine>[0]) {
    const made = makeEngine(options);
    dirs.push(made.tmpDir);
    return made.build();
  }

  it("returns the manifest text, tier and fingerprint in catalog mode", () => {
    const result = build({
      connectors: [{ id: "github", name: "GitHub", tools: manyTools(11) }],
      deferThreshold: 10,
    });
    expect(result.toolCatalogManifest).toBeTruthy();
    expect(result.toolCatalogManifest.text).toContain("github_t_0");
    expect(result.toolCatalogManifest.text).toContain("GitHub");
    expect(result.toolCatalogManifest.tier).toBe(1);
    expect(typeof result.toolCatalogManifest.fingerprint).toBe("string");
    expect(result.toolCatalogManifest.fingerprint.length).toBeGreaterThan(0);
  });

  it("returns null outside catalog mode", () => {
    expect(build({
      connectors: [{ id: "github", tools: manyTools(10) }],
      deferThreshold: 10,
    }).toolCatalogManifest).toBeNull();
    expect(build({
      connectors: [{ id: "github", tools: manyTools(40) }],
      deferEnabled: false,
    }).toolCatalogManifest).toBeNull();
    // The built-in switch is the second tier of a hierarchy: with the master
    // defer switch off it must be inert, however many tools would qualify.
    expect(build({
      connectors: [{ id: "github", tools: manyTools(40) }],
      deferEnabled: false,
      builtinDefer: true,
    }).toolCatalogManifest).toBeNull();
  });

  it("gives the same catalog the same fingerprint and a changed catalog a different one", () => {
    const first = build({
      connectors: [{ id: "github", name: "GitHub", tools: manyTools(11) }],
      deferThreshold: 10,
    });
    const same = build({
      connectors: [{ id: "github", name: "GitHub", tools: manyTools(11) }],
      deferThreshold: 10,
    });
    const changed = build({
      connectors: [{ id: "github", name: "GitHub", tools: manyTools(12) }],
      deferThreshold: 10,
    });
    expect(same.toolCatalogManifest.fingerprint).toBe(first.toolCatalogManifest.fingerprint);
    expect(changed.toolCatalogManifest.fingerprint).not.toBe(first.toolCatalogManifest.fingerprint);
  });

  it("degrades to tier 2 when the model's context leaves little room", () => {
    const made = makeEngine({
      connectors: [{ id: "github", name: "GitHub", tools: manyTools(60) }],
      deferThreshold: 10,
    });
    dirs.push(made.tmpDir);
    const result = made.engine.buildTools(made.workspace, [], {
      agentDir: made.agentDir,
      workspace: made.workspace,
      getSessionPath: () => path.join(made.agentDir, "sessions", "main.jsonl"),
      getPermissionMode: () => "operate",
      modelContextWindowTokens: 2000,
    });
    expect(result.toolCatalogManifest.tier).toBe(2);
    expect(result.toolCatalogManifest.text).not.toContain("github_t_0");
  });
});
