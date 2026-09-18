import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  McpManager,
  MCP_CONNECTORS_STATUS_TOOL_NAME,
  createMcpConnectorsStatusToolDefinition,
  createMcpToolDefinition,
  computeMcpToolIdCollisions,
  isMcpToolEnabledForAgentConfig,
  normalizeMcpConfig,
  resolveMcpToolPermissionKind,
  toMcpToolId,
} from "../core/mcp/manager.ts";
import { McpHttpError } from "../core/mcp/clients/http-client.ts";
import { resolveToolInvocationPermission } from "../lib/permission/tool-invocation-permission.ts";

/**
 * Build a manager with an in-memory config store. Production injects the
 * on-disk store; these tests keep config in memory so they can assert exactly
 * which writes happen.
 */
function createManager({ dataDir, config, log = console }: any = {}, options: any = {}) {
  return new McpManager({ dataDir, log }, { configStore: config, ...options });
}

describe("MCP runtime policy", () => {
  it("uses stable sanitized tool ids for dynamic MCP tools", () => {
    expect(toMcpToolId("github.com", "search/repositories")).toBe("github_com_search_repositories");
  });

  it("keeps display and wire names intact while publishing a lowercase internal id", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const definition = createMcpToolDefinition({
      connectorId: "GitHub",
      toolName: "SearchIssues",
      description: "Search GitHub issues",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      getGlobalEnabled: () => true,
      getAgentConfig: async () => ({
        mcp: { connectors: { GitHub: { enabled: true, tools: { SearchIssues: true } } } },
      }),
      callTool,
    });

    expect(definition.name).toBe("github_searchissues");
    expect(definition.name).toMatch(/^[a-z][a-z0-9_-]*$/);
    expect(definition.sessionPermission.resolveInvocation()).toEqual({
      action: "invoke",
      kind: "review",
      capability: "github_searchissues.invoke",
    });

    await definition.execute("call-1", { query: "uppercase" }, { agentId: "hana" });
    expect(callTool).toHaveBeenCalledWith(
      "GitHub",
      "SearchIssues",
      { query: "uppercase" },
      { agentId: "hana" },
    );

    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-uppercase-id"),
      config: {
        get: vi.fn(() => ({
          enabled: true,
          connectors: [{
            id: "GitHub",
            name: "GitHub Enterprise",
            url: "https://mcp.example.test",
            permissionMode: "allowlist",
            toolPermissions: { mcp_GitHub_SearchIssues: "allow" },
            pinnedTools: { GitHub_SearchIssues: true },
            tools: [{ name: "SearchIssues", title: "Search Issues" }],
          }],
        })),
        set: vi.fn(),
      },
      log: console,
    });
    runtime.registerCachedTools();
    const published = runtime.getAllTools().find((tool) => tool.name === "mcp_github_searchissues");
    expect(published).toBeTruthy();
    expect(resolveToolInvocationPermission(published, {})).toMatchObject({
      ok: true,
      source: "descriptor",
      descriptor: { kind: "read", capability: "github_searchissues.invoke" },
    });
    expect(runtime.getState().connectors[0]).toMatchObject({
      id: "GitHub",
      name: "GitHub Enterprise",
      toolPermissions: { SearchIssues: "allow" },
      pinnedTools: { SearchIssues: true },
      tools: [{
        name: "SearchIssues",
        title: "Search Issues",
        qualifiedName: "github_searchissues",
        capability: "github_searchissues.invoke",
      }],
    });
    expect(isMcpToolEnabledForAgentConfig({
      mcp: {
        connectors: {
          GitHub: {
            enabled: true,
            tools: { mcp_GitHub_SearchIssues: true },
          },
        },
      },
    }, {
      globalEnabled: true,
      connectorId: "GitHub",
      toolName: "SearchIssues",
    })).toBe(true);
  });

  it("reads back raw MCP identities that collapse to the same lowercase tool id", () => {
    // Reading a config must never fail on account of its contents: every read
    // of every session goes through here, so an exception raised on a bad pair
    // used to take the whole runtime down with it. The ambiguity is reported
    // instead, and acted on where the tools are published.
    for (const collidingTools of [
      [{ name: "SearchIssues" }, { name: "searchissues" }],
      [{ name: "search/issues" }, { name: "search.issues" }],
    ]) {
      const config = normalizeMcpConfig({
        enabled: true,
        connectors: [{ id: "GitHub", url: "https://mcp.example.test", tools: collidingTools }],
      });
      expect(config.connectors[0].tools.map((tool) => tool.name))
        .toEqual(collidingTools.map((tool) => tool.name));
      const collisions = computeMcpToolIdCollisions(config.connectors);
      expect([...collisions.values()][0]).toEqual(
        collidingTools.map((tool) => ({ connectorId: "GitHub", toolName: tool.name })),
      );
    }

    const crossConnector = normalizeMcpConfig({
      enabled: true,
      connectors: [
        { id: "GitHub", url: "https://one.example.test", tools: [{ name: "Search" }] },
        { id: "github", url: "https://two.example.test", tools: [{ name: "search" }] },
      ],
    });
    expect(computeMcpToolIdCollisions(crossConnector.connectors).get("github_search")).toEqual([
      { connectorId: "GitHub", toolName: "Search" },
      { connectorId: "github", toolName: "search" },
    ]);
  });

  it("folds repeated tool names to their first occurrence within a connector", () => {
    const config = normalizeMcpConfig({
      enabled: true,
      connectors: [{
        id: "tushare",
        transport: "stdio",
        command: "python",
        // Repeats are neither adjacent nor limited to a single pair: the fold
        // is by name across the whole list, not a neighbour comparison.
        tools: [
          { name: "daily_report", description: "first", inputSchema: { type: "object" } },
          { name: "daily_basic", description: "ok", inputSchema: { type: "object" } },
          { name: "daily_report", description: "second copy", inputSchema: { type: "object" } },
          { name: "daily_report", description: "third copy", inputSchema: { type: "object" } },
        ],
      }],
    });

    const tools = config.connectors[0].tools;
    expect(tools.map((tool) => tool.name)).toEqual(["daily_report", "daily_basic"]);
    expect(tools[0].description).toBe("first");
  });

  it("keeps legacy lowercase qualified names and raw permission keys compatible", () => {
    const config = normalizeMcpConfig({
      enabled: true,
      connectors: [{
        id: "github.com",
        url: "https://mcp.example.test",
        permissionMode: "allowlist",
        // A short-lived historical shape stored the qualified model-facing id
        // instead of the MCP server's exact tool name.
        toolPermissions: { github_com_search_repositories: "allow" },
        tools: [{ name: "search/repositories" }],
      }],
    });

    expect(toMcpToolId("github.com", "search/repositories")).toBe("github_com_search_repositories");
    expect(config.connectors[0].toolPermissions).toEqual({ "search/repositories": "allow" });
    expect(isMcpToolEnabledForAgentConfig({
      mcp: {
        connectors: {
          "github.com": {
            enabled: true,
            tools: { github_com_search_repositories: true },
          },
        },
      },
    }, {
      globalEnabled: true,
      connectorId: "github.com",
      toolName: "search/repositories",
    })).toBe(true);

    const definition = createMcpToolDefinition({
      connectorId: config.connectors[0].id,
      toolName: config.connectors[0].tools[0].name,
      getGlobalEnabled: () => true,
      getAgentConfig: async () => ({}),
      callTool: vi.fn(),
      getPermissionPolicy: () => ({
        permissionMode: config.connectors[0].permissionMode,
        toolPermission: config.connectors[0].toolPermissions["search/repositories"],
      }),
    });
    expect(resolveToolInvocationPermission(definition, {})).toMatchObject({
      ok: true,
      source: "descriptor",
      descriptor: {
        kind: "read",
        capability: "github_com_search_repositories.invoke",
      },
    });
  });

  it("publishes agent-facing tool names as the mcp namespace plus the sanitized tool id", () => {
    const stored = {
      enabled: true,
      connectors: [{
        id: "github.com",
        name: "GitHub",
        url: "https://mcp.github.com/mcp",
        tools: [{ name: "search/repositories" }],
      }],
    };
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-test"),
      config: { get: vi.fn(() => stored), set: vi.fn() },
      log: console,
    });

    runtime.registerCachedTools();

    // These are the exact names the model sees. They must not drift: the
    // namespace prefix used to be applied by the plugin host, and the ids are
    // persisted in per-agent enablement config.
    expect(runtime.getAllTools().map((tool) => tool.name)).toEqual([
      `mcp_${MCP_CONNECTORS_STATUS_TOOL_NAME}`,
      `mcp_${toMcpToolId("github_com", "search/repositories")}`,
    ]);
    expect(runtime.getAllTools().map((tool) => tool.name)).toEqual([
      "mcp_connectors_status",
      "mcp_github_com_search_repositories",
    ]);
    // Tool categorization and permission classification both key off this.
    expect(runtime.getAllTools().every((tool) => tool._pluginId === "mcp")).toBe(true);
  });

  it("marks MCP dynamic tools as legacy Pi-signature tools", () => {
    const tool = createMcpToolDefinition({
      connectorId: "github",
      toolName: "search",
      getGlobalEnabled: () => true,
      getAgentConfig: vi.fn(async () => ({})),
      callTool: vi.fn(),
    } as any);

    expect(tool.invocationStyle).toBe("pi_tool");
  });

  it("requires global, server, and tool-level agent enablement before exposing a tool", () => {
    const enabledAgent = {
      mcp: {
        connectors: {
          github: {
            enabled: true,
            tools: { search: true },
          },
        },
      },
    };

    expect(isMcpToolEnabledForAgentConfig(enabledAgent, {
      globalEnabled: true,
      serverId: "github",
      toolName: "search",
    })).toBe(true);

    expect(isMcpToolEnabledForAgentConfig(enabledAgent, {
      globalEnabled: false,
      serverId: "github",
      toolName: "search",
    })).toBe(false);

    expect(isMcpToolEnabledForAgentConfig({
      mcp: { connectors: { github: { enabled: false, tools: { search: true } } } },
    }, {
      globalEnabled: true,
      serverId: "github",
      toolName: "search",
    })).toBe(false);

    expect(isMcpToolEnabledForAgentConfig({
      mcp: { connectors: { github: { enabled: true, tools: { search: false } } } },
    }, {
      globalEnabled: true,
      serverId: "github",
      toolName: "search",
    })).toBe(false);
  });

  it("reports ready MCP tools as live for Reminder preflight", () => {
    const stored = {
      enabled: true,
      connectors: [{
        id: "github",
        name: "GitHub",
        url: "https://mcp.github.com/mcp",
        tools: [{ name: "search" }],
      }],
    };
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-test"),
      config: { get: vi.fn(() => stored), set: vi.fn() },
      log: console,
    });
    runtime.clients.set("github", { running: true });
    runtime.registerCachedTools();
    const tool = runtime.getAllTools().find((candidate) => candidate.name === "mcp_github_search");
    const probe = tool.metadata.reminderLiveAvailabilityProbe;
    const agentConfig = {
      mcp: { connectors: { github: { enabled: true, tools: { search: true } } } },
    };

    expect(probe(agentConfig)).toEqual({ available: true });
  });

  it("reports stopped, needs-auth/revoked, removed, and unavailable transports without side effects", () => {
    let stored = {
      enabled: true,
      connectors: [{
        id: "github",
        name: "GitHub",
        url: "https://mcp.github.com/mcp",
        tools: [{ name: "search" }],
      }],
    };
    const setConfig = vi.fn();
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-test"),
      config: { get: vi.fn(() => stored), set: setConfig },
      log: console,
    });
    runtime.registerCachedTools();
    const tool = runtime.getAllTools().find((candidate) => candidate.name === "mcp_github_search");
    const probe = tool.metadata.reminderLiveAvailabilityProbe;
    const enabledAgent = {
      mcp: { connectors: { github: { enabled: true, tools: { search: true } } } },
    };

    expect(probe(enabledAgent)).toMatchObject({
      available: false,
      reason: "mcp_connector_stopped",
      diagnostics: { connectorId: "github", status: "stopped" },
    });

    runtime.connectorStatus.set("github", "needs-auth");
    runtime.clientErrors.set("github", "token revoked");
    expect(probe(enabledAgent)).toMatchObject({
      available: false,
      reason: "mcp_needs_auth",
      diagnostics: { connectorId: "github", status: "needs-auth", error: "token revoked" },
    });

    runtime.connectorStatus.set("github", "reconnecting");
    runtime.clientErrors.set("github", "transport unavailable");
    expect(probe(enabledAgent)).toMatchObject({
      available: false,
      reason: "mcp_transport_unavailable",
      diagnostics: { connectorId: "github", status: "reconnecting" },
    });

    runtime.connectorStatus.delete("github");
    runtime.clientErrors.delete("github");
    stored = { enabled: true, connectors: [] };
    expect(probe(enabledAgent)).toMatchObject({
      available: false,
      reason: "mcp_connector_removed",
      diagnostics: { connectorId: "github" },
    });

    expect(setConfig).not.toHaveBeenCalled();
  });

  it("reports global and agent MCP disablement through the read-only probe", () => {
    let stored = {
      enabled: true,
      connectors: [{
        id: "github",
        name: "GitHub",
        url: "https://mcp.github.com/mcp",
        tools: [{ name: "search" }],
      }],
    };
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-test"),
      config: { get: vi.fn(() => stored), set: vi.fn() },
      log: console,
    });
    runtime.clients.set("github", { running: true });
    runtime.registerCachedTools();
    const probe = runtime.getAllTools().find((candidate) => candidate.name === "mcp_github_search")
      .metadata.reminderLiveAvailabilityProbe;

    expect(probe({ mcp: { connectors: { github: { enabled: false, tools: { search: true } } } } }))
      .toMatchObject({ available: false, reason: "mcp_agent_disabled" });

    stored = { ...stored, enabled: false };
    expect(probe({ mcp: { connectors: { github: { enabled: true, tools: { search: true } } } } }))
      .toMatchObject({ available: false, reason: "mcp_global_disabled" });
  });

  it("keeps backward compatibility with the previous mcp.servers agent config shape", () => {
    expect(isMcpToolEnabledForAgentConfig({
      mcp: { servers: { github: { enabled: true, tools: { search: true } } } },
    }, {
      globalEnabled: true,
      serverId: "github",
      toolName: "search",
    })).toBe(true);
  });

  it("normalizes remote connectors as the primary config shape", () => {
    const config = normalizeMcpConfig({
      enabled: true,
      connectors: [
        {
          id: "github.com",
          name: "GitHub",
          url: "https://mcp.github.com/mcp",
          authType: "bearer",
          authorizationToken: "token-123",
          tools: [{ name: "search", description: "Search repositories" }],
        },
      ],
    });

    expect(config.enabled).toBe(true);
    expect(config.connectors[0]).toMatchObject({
      id: "github_com",
      name: "GitHub",
      transport: "remote",
      url: "https://mcp.github.com/mcp",
      authType: "bearer",
      authorizationToken: "token-123",
    });
    expect(config.servers).toEqual(config.connectors);
  });

  it("normalizes Cherry-style MCP server fields into Hana connectors", () => {
    const config = normalizeMcpConfig({
      enabled: true,
      connectors: [
        {
          id: "cherry-http",
          name: "Cherry HTTP",
          type: "streamableHttp",
          baseUrl: "https://mcp.example.com/mcp",
          description: "Remote MCP server",
          headers: {
            Authorization: "Bearer header-token",
            "X-API-Key": "key-123",
          },
          timeout: "45",
          isActive: true,
        },
        {
          id: "cherry-stdio",
          name: "Cherry Stdio",
          type: "stdio",
          command: "npx",
          args: ["-y", "mcp-server-example"],
          env: { API_KEY: "secret" },
          registryUrl: "https://registry.npmmirror.com",
          autoStart: true,
        },
      ],
    });

    expect(config.connectors[0]).toMatchObject({
      id: "cherry-http",
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
      description: "Remote MCP server",
      headers: {
        Authorization: "Bearer header-token",
        "X-API-Key": "key-123",
      },
      timeout: 45,
      // An imported server is on by default; neither isActive nor autoStart is
      // read as a gate any more.
      enabled: true,
    });
    expect(config.connectors[1]).toMatchObject({
      id: "cherry-stdio",
      transport: "stdio",
      command: "npx",
      env: { API_KEY: "secret" },
      registryUrl: "https://registry.npmmirror.com",
      enabled: true,
    });
  });

  it("migrates the earlier local server config into connectors", () => {
    const config = normalizeMcpConfig({
      servers: [
        {
          id: "local-github",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
        },
      ],
    });

    expect(config.connectors[0]).toMatchObject({
      id: "local-github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
    expect(config.servers).toEqual(config.connectors);
  });

  it("returns connector state and a servers alias for API compatibility", () => {
    const stored = {
      enabled: true,
      connectors: [
        {
          id: "github",
          name: "GitHub",
          url: "https://mcp.github.com/mcp",
          tools: [{ name: "search" }],
        },
      ],
    };
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-test"),
      config: {
        get: vi.fn(() => stored),
        set: vi.fn(),
      },
      log: console,
    });

    const state = runtime.getState({
      mcp: {
        connectors: {
          github: { enabled: true, tools: { search: true } },
        },
      },
    });

    expect(state.connectors[0]).toMatchObject({
      id: "github",
      transport: "remote",
      status: "stopped",
    });
    expect(state.servers).toEqual(state.connectors);
    expect(state.agentConfig).toEqual({
      connectors: {
        github: { enabled: true, tools: { search: true } },
      },
      servers: {
        github: { enabled: true, tools: { search: true } },
      },
    });
  });

  it("redacts connector secrets from public state without dropping their keys", () => {
    const stored = {
      enabled: true,
      connectors: [
        {
          id: "private",
          name: "Private",
          command: "npx",
          env: {
            BASE_URL: "https://internal.example.com",
            API_KEY: "secret",
          },
          headers: {
            Authorization: "Bearer secret",
            "X-Trace": "trace-id",
          },
          authorizationToken: "token-123",
          oauthClientSecret: "client-secret",
        },
      ],
    };
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-test"),
      config: {
        get: vi.fn(() => stored),
        set: vi.fn(),
      },
      log: console,
    });

    const [connector] = runtime.getState().connectors;

    expect(connector.env).toEqual({
      BASE_URL: "********",
      API_KEY: "********",
    });
    expect(connector.headers).toEqual({
      Authorization: "********",
      "X-Trace": "********",
    });
    expect(connector.authorizationToken).toBe("********");
    expect(connector.oauthClientSecret).toBe("********");
  });

  it("surfaces tool-list freshness hints in public state without persisting them", async () => {
    async function stateAfterRefresh(toolListFreshness) {
      const stored = {
        enabled: true,
        connectors: [{ id: "remote", name: "Remote", url: "https://mcp.example.com/mcp" }],
      };
      const set = vi.fn();
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-test"),
        config: { get: vi.fn(() => stored), set },
        log: console,
      }, {
        clientFactory: () => ({
          running: true,
          toolListFreshness,
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          listTools: vi.fn(async () => [{ name: "search", inputSchema: { type: "object" } }]),
        }),
      });
      await runtime.startConnector("remote");
      await runtime.refreshTools("remote");
      return { connector: runtime.getState().connectors[0], set };
    }

    const hints = { ttlMs: 300000, cacheScope: "public", fetchedAt: 1234 };
    const { connector, set } = await stateAfterRefresh(hints);
    expect(connector.toolListFreshness).toEqual(hints);

    // A caching hint describes one live response, so it belongs in memory only.
    // Persisting it would outlive the answer it describes.
    for (const [, value] of set.mock.calls) {
      expect(JSON.stringify(value)).not.toContain("toolListFreshness");
    }

    const { connector: bare } = await stateAfterRefresh(null);
    expect(bare.toolListFreshness).toBeNull();
  });

  describe("input_required tool calls", () => {
    const ELICIT_REQUEST = {
      github_login: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: "Please provide your GitHub username",
          requestedSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
      },
    };

    // A confirm store stand-in that hands the test the decision knob, keeping
    // the assertions on the manager rather than on real timers.
    function fakeConfirmStore() {
      const created = [];
      let resolveCurrent = null;
      const store = {
        created,
        create: vi.fn((kind, payload, sessionRef, timeoutMs) => {
          created.push({ kind, payload, sessionRef, timeoutMs });
          return {
            confirmId: `confirm-${created.length}`,
            promise: new Promise((resolve) => { resolveCurrent = resolve; }),
          };
        }),
        settle: (decision) => resolveCurrent(decision),
      };
      return store;
    }

    function buildRuntime({ results, confirmStore, emitEvent }) {
      const stored = {
        enabled: true,
        connectors: [{
          id: "remote",
          name: "Remote Service",
          url: "https://mcp.example.com/mcp",
          tools: [{ name: "deploy", inputSchema: { type: "object" } }],
        }],
      };
      const calls = [];
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-test"),
        config: { get: vi.fn(() => stored), set: vi.fn() },
        log: console,
      }, {
        confirmStore,
        emitEvent,
        clientFactory: () => ({
          running: true,
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          listTools: vi.fn(async () => [{ name: "deploy", inputSchema: { type: "object" } }]),
          callTool: vi.fn(async (toolName, args, opts) => {
            calls.push({ toolName, args, opts });
            return results[calls.length - 1];
          }),
        }),
      });
      return { runtime, calls };
    }

    it("asks the user for the requested input and replays the call with the answer", async () => {
      const confirmStore = fakeConfirmStore();
      const emitEvent = vi.fn();
      const { runtime, calls } = buildRuntime({
        confirmStore,
        emitEvent,
        results: [
          { resultType: "input_required", inputRequests: ELICIT_REQUEST, requestState: "opaque-blob" },
          { resultType: "complete", content: [{ type: "text", text: "deployed" }] },
        ],
      });
      await runtime.startConnector("remote");

      const pending = runtime.callTool("remote", "deploy", { env: "prod" }, {
        sessionPath: "/tmp/session.jsonl",
      });
      await vi.waitFor(() => expect(confirmStore.create).toHaveBeenCalled());

      // The waiting card carries what the server asked and why.
      const [kind, payload, sessionRef, timeoutMs] = confirmStore.create.mock.calls[0];
      expect(kind).toBe("mcp_elicitation");
      expect(payload).toMatchObject({
        toolName: "deploy",
        message: "Please provide your GitHub username",
        requestedSchema: ELICIT_REQUEST.github_login.params.requestedSchema,
      });
      expect(sessionRef).toBe("/tmp/session.jsonl");
      expect(timeoutMs).toBe(10 * 60 * 1000);

      const [event] = emitEvent.mock.calls[0];
      expect(event.type).toBe("session_confirmation");
      expect(event.request).toMatchObject({
        kind: "mcp_elicitation",
        surface: "input",
      });
      expect(JSON.stringify(event.request)).toContain("deploy");

      confirmStore.settle({ action: "confirmed", value: { name: "octocat" } });
      const result = await pending;

      expect(result).toMatchObject({ resultType: "complete" });
      // The retry repeats the original arguments and adds the answer plus the
      // server's opaque state, echoed back untouched.
      expect(calls[1].args).toEqual({ env: "prod" });
      expect(calls[1].opts).toMatchObject({
        requestState: "opaque-blob",
        inputResponses: { github_login: { action: "accept", content: { name: "octocat" } } },
      });
    });

    // A user who refuses the form made a decision the server is entitled to
    // hear: the spec's ElicitResult has a "decline" action for exactly this, and
    // relaying it lets the server unwind its own pending work. What the model
    // sees is unchanged — the tool call still fails loudly, naming the server
    // and the outcome.
    it("relays the user's refusal to the server as a decline before failing the call", async () => {
      const confirmStore = fakeConfirmStore();
      const { runtime, calls } = buildRuntime({
        confirmStore,
        emitEvent: vi.fn(),
        results: [
          { resultType: "input_required", inputRequests: ELICIT_REQUEST, requestState: "opaque-blob" },
          { resultType: "complete", content: [] },
        ],
      });
      await runtime.startConnector("remote");

      const pending = runtime.callTool("remote", "deploy", { env: "prod" }, { sessionPath: "/tmp/session.jsonl" });
      await vi.waitFor(() => expect(confirmStore.create).toHaveBeenCalled());
      confirmStore.settle({ action: "rejected" });

      await expect(pending).rejects.toThrow(/Remote Service/);
      await expect(pending).rejects.toThrow(/rejected/);

      // The decline round goes out on the wire, repeating the original
      // arguments and echoing the server's opaque state back untouched. No
      // content rides along: a decline carries no submitted data.
      expect(calls).toHaveLength(2);
      expect(calls[1].args).toEqual({ env: "prod" });
      expect(calls[1].opts).toMatchObject({
        requestState: "opaque-blob",
        inputResponses: { github_login: { action: "decline" } },
      });
      expect(calls[1].opts.inputResponses.github_login).not.toHaveProperty("content");
      // The user is asked exactly once; the decline round is not another prompt.
      expect(confirmStore.create).toHaveBeenCalledTimes(1);
    });

    it("still fails the call when the decline round itself cannot be delivered", async () => {
      const confirmStore = fakeConfirmStore();
      const { runtime } = buildRuntime({
        confirmStore,
        emitEvent: vi.fn(),
        results: [
          { resultType: "input_required", inputRequests: ELICIT_REQUEST },
          new Error("connection reset"),
        ],
      });
      await runtime.startConnector("remote");

      const pending = runtime.callTool("remote", "deploy", {}, { sessionPath: "/tmp/session.jsonl" });
      await vi.waitFor(() => expect(confirmStore.create).toHaveBeenCalled());
      confirmStore.settle({ action: "rejected" });

      // A transport failure while telling the server "no" must not turn the
      // refusal into a different-looking outcome.
      await expect(pending).rejects.toThrow(/Remote Service/);
      await expect(pending).rejects.toThrow(/rejected/);
    });

    for (const action of ["timeout", "aborted"]) {
      it(`fails loudly with the server name and reason when the user answer is ${action}`, async () => {
        const confirmStore = fakeConfirmStore();
        const { runtime, calls } = buildRuntime({
          confirmStore,
          emitEvent: vi.fn(),
          results: [
            { resultType: "input_required", inputRequests: ELICIT_REQUEST },
            { resultType: "complete", content: [] },
          ],
        });
        await runtime.startConnector("remote");

        const pending = runtime.callTool("remote", "deploy", {}, { sessionPath: "/tmp/session.jsonl" });
        await vi.waitFor(() => expect(confirmStore.create).toHaveBeenCalled());
        confirmStore.settle({ action });

        await expect(pending).rejects.toThrow(/Remote Service/);
        await expect(pending).rejects.toThrow(new RegExp(action));
        // No silent retry: an unanswered prompt is not a decision to relay.
        expect(calls).toHaveLength(1);
      });
    }

    it("stops asking after three rounds instead of looping on a server that never settles", async () => {
      const confirmStore = fakeConfirmStore();
      const { runtime, calls } = buildRuntime({
        confirmStore,
        emitEvent: vi.fn(),
        results: Array.from({ length: 10 }, () => ({
          resultType: "input_required",
          inputRequests: ELICIT_REQUEST,
        })),
      });
      await runtime.startConnector("remote");

      const pending = runtime.callTool("remote", "deploy", {}, { sessionPath: "/tmp/session.jsonl" });
      const settleWhenAsked = async (times) => {
        for (let i = 0; i < times; i += 1) {
          await vi.waitFor(() => expect(confirmStore.create).toHaveBeenCalledTimes(i + 1));
          confirmStore.settle({ action: "confirmed", value: { name: `round-${i}` } });
        }
      };
      await settleWhenAsked(3);

      await expect(pending).rejects.toThrow(/too many/i);
      expect(confirmStore.create).toHaveBeenCalledTimes(3);
      expect(calls.length).toBeLessThanOrEqual(4);
    });

    it("retries immediately when the server sends state but asks for nothing", async () => {
      const confirmStore = fakeConfirmStore();
      const { runtime, calls } = buildRuntime({
        confirmStore,
        emitEvent: vi.fn(),
        results: [
          { resultType: "input_required", requestState: "just-state" },
          { resultType: "complete", content: [] },
        ],
      });
      await runtime.startConnector("remote");

      const result = await runtime.callTool("remote", "deploy", {}, { sessionPath: "/tmp/session.jsonl" });

      expect(result).toMatchObject({ resultType: "complete" });
      expect(confirmStore.create).not.toHaveBeenCalled();
      expect(calls[1].opts).toMatchObject({ requestState: "just-state" });
    });

    it("refuses an input request of a kind it never advertised", async () => {
      const confirmStore = fakeConfirmStore();
      const { runtime } = buildRuntime({
        confirmStore,
        emitEvent: vi.fn(),
        results: [{
          resultType: "input_required",
          inputRequests: { pick: { method: "sampling/createMessage", params: {} } },
        }],
      });
      await runtime.startConnector("remote");

      await expect(runtime.callTool("remote", "deploy", {}, { sessionPath: "/tmp/session.jsonl" }))
        .rejects.toThrow(/sampling\/createMessage/);
      expect(confirmStore.create).not.toHaveBeenCalled();
    });
  });

  it("surfaces connector start errors in public state", async () => {
    const stored = {
      enabled: true,
      connectors: [
        {
          id: "local",
          name: "Local",
          command: "npx",
          args: ["-y", "broken-mcp"],
        },
      ],
    };
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-test"),
      config: {
        get: vi.fn(() => stored),
        set: vi.fn(),
      },
      log: console,
    }, {
      clientFactory: () => ({
        running: false,
        start: vi.fn(async () => {
          throw new Error("spawn EINVAL");
        }),
        stop: vi.fn(async () => {}),
      }),
    });

    await expect(runtime.startConnector("local")).rejects.toThrow("spawn EINVAL");

    expect(runtime.getState().connectors[0]).toMatchObject({
      id: "local",
      status: "stopped",
      error: "spawn EINVAL",
    });
  });

  it("executes settings actions through the runtime and returns a settings update", async () => {
    let stored = { enabled: false, connectors: [] };
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-test"),
      config: {
        get: vi.fn(() => stored),
        set: vi.fn((_key, value) => {
          stored = value;
        }),
      },
      log: console,
    });

    const result = await runtime.handleSettingsAction({
      action: "mcp.connector.add",
      agentId: "hana",
      payload: {
        name: "GitHub",
        transport: "remote",
        url: "https://mcp.github.com/mcp",
        authType: "bearer",
        authorizationToken: "secret-token",
        enableGlobal: true,
      },
    } as any);

    expect(stored.enabled).toBe(true);
    expect(stored.connectors[0]).toMatchObject({
      id: "GitHub",
      name: "GitHub",
      url: "https://mcp.github.com/mcp",
      authorizationToken: "secret-token",
    });
    expect(result.settingsUpdate).toMatchObject({
      status: "applied",
      action: "mcp.connector.add",
      key: "mcp.connector.GitHub",
      changes: [
        expect.objectContaining({
          key: "mcp.connector.GitHub",
          after: "added",
        }),
        expect.objectContaining({
          key: "mcp.enabled",
          after: "true",
        }),
      ],
    });
    expect(result.settingsUpdate.summary).not.toContain("secret-token");
  });

  it("returns an explicit tool error when MCP is globally disabled at call time", async () => {
    const callTool = vi.fn();
    const tool = createMcpToolDefinition({
      serverId: "github",
      toolName: "search",
      description: "Search repositories",
      inputSchema: { type: "object", properties: {} },
      getGlobalEnabled: () => false,
      getAgentConfig: () => ({
        mcp: { connectors: { github: { enabled: true, tools: { search: true } } } },
      }),
      callTool,
    });

    const result = await tool.execute({}, { agentId: "hana" });

    expect(callTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toMatch(/MCP is disabled/);
  });

  it("marks connector invocations for review at the plugin boundary", () => {
    const tool = createMcpToolDefinition({
      serverId: "github",
      toolName: "search",
      description: "Search repositories",
      inputSchema: { type: "object", properties: {} },
      getGlobalEnabled: () => true,
      getAgentConfig: () => ({}),
      callTool: vi.fn(),
    });

    expect(tool.sessionPermission.resolveInvocation()).toEqual({
      action: "invoke",
      kind: "review",
      capability: "github_search.invoke",
    });
  });

  it("returns an explicit tool error when the per-agent MCP tool switch is off", async () => {
    const callTool = vi.fn();
    const tool = createMcpToolDefinition({
      serverId: "github",
      toolName: "search",
      description: "Search repositories",
      inputSchema: { type: "object", properties: {} },
      getGlobalEnabled: () => true,
      getAgentConfig: () => ({
        mcp: { connectors: { github: { enabled: true, tools: { search: false } } } },
      }),
      callTool,
    });

    const result = await tool.execute({}, { agentId: "hana" });

    expect(callTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toMatch(/not enabled for this agent/);
  });
});

// App-capable connectors: a tool may carry a `ui://` resource that renders its
// own interface, declared through either the native `_meta.ui` shape or the
// `openai/outputTemplate` dialect.
describe("MCP app resources", () => {
  const APP_TOOL = {
    name: "board",
    title: "Board",
    description: "Interactive board",
    _meta: { ui: { resourceUri: "ui://board/main" } },
  };

  function managerWith(tools) {
    const stored = {
      enabled: true,
      connectors: [{ id: "acme", name: "Acme", url: "https://mcp.acme.test/mcp", tools }],
    };
    return createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-apps-test"),
      config: { get: vi.fn(() => stored), set: vi.fn() },
      log: console,
    });
  }

  it("passes a tool's _meta through to the published tool definition", () => {
    const runtime = managerWith([APP_TOOL]);
    runtime.registerCachedTools();

    const [app] = runtime.listApps();
    expect(app).toMatchObject({
      connectorId: "acme",
      toolName: "board",
      resourceUri: "ui://board/main",
      _meta: { ui: { resourceUri: "ui://board/main" } },
    });
  });

  it("recognizes the openai/outputTemplate dialect as an app resource", () => {
    const runtime = managerWith([{
      name: "sheet",
      _meta: { "openai/outputTemplate": "ui://sheet/main" },
    }]);

    expect(runtime.listApps()).toEqual([
      expect.objectContaining({ toolName: "sheet", resourceUri: "ui://sheet/main" }),
    ]);
  });

  it("ignores a resource uri that is not a ui:// resource", () => {
    const runtime = managerWith([{
      name: "sneaky",
      _meta: { ui: { resourceUri: "file:///etc/passwd" } },
    }]);

    expect(runtime.listApps()).toEqual([]);
  });

  it("refuses to read a resource uri outside the ui:// scheme", async () => {
    const runtime = managerWith([APP_TOOL]);
    runtime.clients.set("acme", { running: true, readResource: vi.fn() });

    await expect(runtime.readResource("acme", "https://evil.test/steal"))
      .rejects.toThrow(/must start with ui:\/\//);
  });

  it("reads a ui:// resource through the connector client", async () => {
    const runtime = managerWith([APP_TOOL]);
    const readResource = vi.fn(async () => ({
      contents: [{ uri: "ui://board/main", mimeType: "text/html", text: "<h1>board</h1>" }],
    }));
    runtime.clients.set("acme", { running: true, readResource });

    const result = await runtime.readResource("acme", "ui://board/main");

    expect(readResource).toHaveBeenCalledWith("ui://board/main");
    expect(result.contents[0].text).toBe("<h1>board</h1>");
  });

  it("keeps a model-only tool out of the app list and refuses app tool calls", async () => {
    const runtime = managerWith([{
      name: "private",
      _meta: { ui: { resourceUri: "ui://private/main", visibility: ["model"] } },
    }]);

    expect(runtime.listApps()).toEqual([]);
    await expect(runtime.callAppTool("acme", "private", {}))
      .rejects.toThrow(/not visible to apps/);
  });

  it("attaches an app card to the tool result of an app-capable tool", async () => {
    const runtime = managerWith([APP_TOOL]);
    const request = vi.fn(async (type) => (type === "agent:config"
      ? { config: { mcp: { connectors: { acme: { enabled: true, tools: { board: true } } } } } }
      : {}));
    await runtime.start({ request });
    runtime.clients.set("acme", {
      running: true,
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: "done" }] })),
    });
    runtime.registerCachedTools();

    const tool = runtime.getAllTools().find((item) => item.name === "mcp_acme_board");
    const result = await tool.execute("call-7", { q: 1 }, null, undefined, {
      agentId: "hana",
      sessionId: "sess_1",
    });

    expect(result.details.mcpAppCard).toMatchObject({
      type: "mcp_app",
      connectorId: "acme",
      toolName: "board",
      resourceUri: "ui://board/main",
      toolCallId: "call-7",
      sourceAgentId: "hana",
      sourceSessionId: "sess_1",
    });
  });
});

describe("MCP connectors status tool", () => {
  // The agent-facing name: the manager namespaces every tool it publishes.
  const STATUS_TOOL_PUBLIC_NAME = `mcp_${MCP_CONNECTORS_STATUS_TOOL_NAME}`;

  function createStoredRuntime(stored) {
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-test"),
      config: {
        get: vi.fn(() => stored),
        set: vi.fn(),
      },
      log: console,
    });
    return { runtime };
  }

  function findStatusTool(runtime) {
    return runtime.getAllTools().find((tool) => tool.name === STATUS_TOOL_PUBLIC_NAME);
  }

  it("registers a read-only connectors-status tool alongside cached tools", () => {
    const stored = {
      enabled: true,
      connectors: [
        { id: "github", name: "GitHub", url: "https://mcp.github.com/mcp", tools: [{ name: "search" }] },
      ],
    };
    const { runtime } = createStoredRuntime(stored);

    runtime.registerCachedTools();

    const statusTool = findStatusTool(runtime);
    expect(statusTool).toBeTruthy();
    expect(statusTool.name).toBe(STATUS_TOOL_PUBLIC_NAME);
    expect(statusTool.sessionPermission.resolveInvocation({})).toEqual({
      action: "read",
      kind: "read",
      capability: "connectors_status.read",
    });
    // The definition still declares the legacy Pi signature; the manager bakes
    // that calling convention into the published tool's execute wrapper.
    expect(createMcpConnectorsStatusToolDefinition({
      getState: () => ({}),
      getGlobalEnabled: () => true,
    }).invocationStyle).toBe("pi_tool");
    expect(statusTool.metadata).toMatchObject({ kind: "mcp", readOnly: true });
    // Diagnostic tool takes no input.
    expect(statusTool.parameters).toEqual({ type: "object", properties: {} });
  });

  it("reports each connector status and tool count from getState", async () => {
    const stored = {
      enabled: true,
      connectors: [
        { id: "github", name: "GitHub", url: "https://mcp.github.com/mcp", tools: [{ name: "search" }, { name: "issues" }] },
        { id: "local", name: "Local", command: "npx", tools: [] },
      ],
    };
    const { runtime } = createStoredRuntime(stored);
    runtime.registerCachedTools();
    const statusTool = findStatusTool(runtime);

    const result = await statusTool.execute("call-1", {}, { agentId: "hana" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.enabled).toBe(true);
    expect(payload.connectors).toEqual([
      expect.objectContaining({
        id: "github",
        name: "GitHub",
        transport: "remote",
        status: "stopped",
        error: "",
        toolCount: 2,
      }),
      expect.objectContaining({
        id: "local",
        name: "Local",
        transport: "stdio",
        status: "stopped",
        toolCount: 0,
      }),
    ]);
  });

  it("surfaces connector errors and running status without leaking secrets", async () => {
    const stored = {
      enabled: true,
      connectors: [
        {
          id: "private",
          name: "Private",
          command: "npx",
          env: { API_KEY: "super-secret-value" },
          headers: { Authorization: "Bearer super-secret-token" },
          authorizationToken: "raw-bearer-token",
          oauthClientSecret: "raw-client-secret",
          tools: [{ name: "ping" }],
        },
      ],
    };
    const { runtime } = createStoredRuntime(stored);
    // Simulate a running client and a recorded error to prove status is sourced live.
    runtime.clients.set("private", { running: true });
    runtime.clientErrors.set("private", "spawn EACCES");
    runtime.registerCachedTools();
    const statusTool = findStatusTool(runtime);

    const result = await statusTool.execute("call-1", {}, { agentId: "hana" });
    const text = result.content[0].text;
    const payload = JSON.parse(text);

    expect(payload.connectors[0]).toMatchObject({
      id: "private",
      status: "running",
      error: "spawn EACCES",
    });

    // Hard guarantee: no raw secret material anywhere in the serialized output.
    expect(text).not.toContain("super-secret-value");
    expect(text).not.toContain("super-secret-token");
    expect(text).not.toContain("raw-bearer-token");
    expect(text).not.toContain("raw-client-secret");
  });

  it("only exposes the status tool while MCP is globally enabled", async () => {
    const stored = {
      enabled: false,
      connectors: [
        { id: "github", name: "GitHub", url: "https://mcp.github.com/mcp", tools: [{ name: "search" }] },
      ],
    };
    const { runtime } = createStoredRuntime(stored);
    runtime.registerCachedTools();
    const statusTool = findStatusTool(runtime);

    expect(statusTool.isEnabledForAgentConfig({})).toBe(false);

    stored.enabled = true;
    expect(statusTool.isEnabledForAgentConfig({})).toBe(true);
  });

  it("replaces the status tool on re-registration instead of accumulating duplicates", () => {
    const stored = {
      enabled: true,
      connectors: [
        { id: "github", name: "GitHub", url: "https://mcp.github.com/mcp", tools: [{ name: "search" }] },
      ],
    };
    const { runtime } = createStoredRuntime(stored);
    runtime.registerCachedTools();

    const firstStatusTool = findStatusTool(runtime);
    expect(firstStatusTool).toBeTruthy();
    const firstNames = runtime.getAllTools().map((tool) => tool.name);
    expect(firstNames).toEqual([STATUS_TOOL_PUBLIC_NAME, "mcp_github_search"]);

    // Re-registering rebuilds the list: the stale tool objects are dropped
    // rather than left behind alongside the fresh ones.
    runtime.registerCachedTools();
    const secondNames = runtime.getAllTools().map((tool) => tool.name);
    expect(secondNames).toEqual(firstNames);
    expect(findStatusTool(runtime)).not.toBe(firstStatusTool);
  });

  it("drops every cached tool on dispose", async () => {
    const stored = {
      enabled: true,
      connectors: [
        { id: "github", name: "GitHub", url: "https://mcp.github.com/mcp", tools: [{ name: "search" }] },
      ],
    };
    const { runtime } = createStoredRuntime(stored);
    runtime.registerCachedTools();
    expect(runtime.getAllTools()).not.toHaveLength(0);

    await runtime.dispose();
    expect(runtime.getAllTools()).toEqual([]);
  });

  it("builds a status definition decoupled from any specific connector", async () => {
    const getState = vi.fn(() => ({
      enabled: true,
      connectors: [
        {
          id: "github",
          name: "GitHub",
          transport: "remote",
          status: "running",
          error: "",
          authStatus: "token",
          authorizationToken: "********",
          oauthClientSecret: "********",
          env: { API_KEY: "********" },
          headers: { Authorization: "********" },
          tools: [{ name: "search" }, { name: "issues" }],
        },
      ],
    }));
    const tool = createMcpConnectorsStatusToolDefinition({
      getState,
      getGlobalEnabled: () => true,
    });

    expect(tool.name).toBe(MCP_CONNECTORS_STATUS_TOOL_NAME);
    expect(tool.metadata).not.toHaveProperty("connectorId");

    const result = await (tool.execute as any)("call-1", {}, {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.connectors[0]).toMatchObject({
      id: "github",
      transport: "remote",
      status: "running",
      authStatus: "token",
      toolCount: 2,
    });
    expect(getState).toHaveBeenCalled();
  });
});

// #1286 ③a — OAuth self-heal at the runtime layer: near-expiry refresh, in-flight
// dedup, persistence of DCR products, and the two distinct write-back paths
// (refresh keeps the live client; full re-auth stops it).
describe("MCP runtime OAuth token refresh", () => {
  function makeRefreshRuntime(connector, { fetchImpl }: any = {}) {
    let current = { enabled: true, connectors: [connector] };
    const setSpy = vi.fn((_key, value) => { current = { ...current, ...value }; });
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-refresh-test"),
      config: {
        get: vi.fn(() => current),
        set: setSpy,
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }, { fetchImpl });
    return { runtime, setSpy, getConfig: () => current };
  }

  function tokenResponse(body) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const BASE_OAUTH_CONNECTOR = {
    id: "notion",
    name: "Notion",
    url: "https://mcp.example.com/mcp",
    authType: "oauth",
    oauthClientId: "client-id",
  };

  it("returns the existing access token when it is not near expiry", async () => {
    const fetchImpl = vi.fn();
    const { runtime } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-current",
        refreshToken: "refresh-current",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 3_600_000,
      },
    }, { fetchImpl });

    const token = await runtime.getValidToken("notion");

    expect(token).toBe("access-current");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes and persists a new access token when the current one is near expiry", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse({
      access_token: "access-refreshed",
      refresh_token: "refresh-rotated",
      expires_in: 3600,
      token_type: "Bearer",
    }));
    const { runtime, getConfig } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-stale",
        refreshToken: "refresh-current",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 30_000, // inside the 60s pre-expiry window
      },
    }, { fetchImpl });

    const token = await runtime.getValidToken("notion");

    expect(token).toBe("access-refreshed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const saved = getConfig().connectors[0];
    expect(saved.oauth.accessToken).toBe("access-refreshed");
    expect(saved.oauth.refreshToken).toBe("refresh-rotated");
  });

  it("does NOT stop the connector when writing back a refreshed token", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse({
      access_token: "access-refreshed",
      expires_in: 3600,
      token_type: "Bearer",
    }));
    const { runtime } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-stale",
        refreshToken: "refresh-current",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 30_000,
      },
    }, { fetchImpl });
    const stopSpy = vi.spyOn(runtime, "stopConnector");

    await runtime.getValidToken("notion");

    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent refreshes for the same connector into one token request", async () => {
    let resolveFetch;
    const fetchImpl = vi.fn(() => new Promise((resolve) => {
      resolveFetch = () => resolve(tokenResponse({
        access_token: "access-refreshed",
        refresh_token: "refresh-rotated",
        expires_in: 3600,
        token_type: "Bearer",
      }));
    }));
    const { runtime } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-stale",
        refreshToken: "refresh-current",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 30_000,
      },
    }, { fetchImpl });

    // Three callers race in while the token is near-expiry.
    const p1 = runtime.getValidToken("notion");
    const p2 = runtime.getValidToken("notion");
    const p3 = runtime.getValidToken("notion");
    resolveFetch();
    const [t1, t2, t3] = await Promise.all([p1, p2, p3]);

    // Exactly one network refresh despite three concurrent callers.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(t1).toBe("access-refreshed");
    expect(t2).toBe("access-refreshed");
    expect(t3).toBe("access-refreshed");
  });

  it("clears the in-flight refresh so a later near-expiry triggers a fresh refresh", async () => {
    // A short-lived token (30s) lands back inside the 60s pre-expiry window, so
    // the next getValidToken is still near-expiry and must refresh again. This
    // only happens if the in-flight dedup map was cleared after the first refresh.
    const fetchImpl = vi.fn(async () => tokenResponse({
      access_token: "access-refreshed",
      refresh_token: "refresh-rotated",
      expires_in: 30,
      token_type: "Bearer",
    }));
    const { runtime } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-stale",
        refreshToken: "refresh-current",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 30_000,
      },
    }, { fetchImpl });

    await runtime.getValidToken("notion");
    await runtime.getValidToken("notion");

    // Two sequential near-expiry calls => two refreshes (in-flight map cleared between them).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns the existing token without refreshing when there is no refresh token", async () => {
    const fetchImpl = vi.fn();
    const { runtime } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-current",
        refreshToken: "",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 30_000,
      },
    }, { fetchImpl });

    const token = await runtime.getValidToken("notion");

    expect(token).toBe("access-current");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // #1286 ③a I1: when the refresh token itself is dead, the token endpoint returns
  // 400 invalid_grant. Both refresh entry points (force-refresh on 401, and the
  // pre-request near-expiry refresh) must surface a STRUCTURED auth-terminal error
  // so the http-client/runtime classify it as needs-auth instead of a transient
  // failure that loops backoff and re-hammers the AS with a dead refresh token.
  it("propagates an auth-terminal McpHttpError from refreshIfPossible when the refresh token is dead", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "refresh token expired" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    ));
    const { runtime } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-stale",
        refreshToken: "refresh-dead",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 30_000,
      },
    }, { fetchImpl });

    const err = await runtime.refreshIfPossible("notion").catch((e) => e);

    expect(err).toBeInstanceOf(McpHttpError);
    expect(err.status).toBe(400);
    expect(err.oauthError).toBe("invalid_grant");
  });

  it("propagates an auth-terminal McpHttpError from getValidToken pre-refresh when the refresh token is dead", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "refresh token expired" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    ));
    const { runtime } = makeRefreshRuntime({
      ...BASE_OAUTH_CONNECTOR,
      oauth: {
        accessToken: "access-stale",
        refreshToken: "refresh-dead",
        tokenEndpoint: "https://auth.example.com/token",
        expiresAt: Date.now() + 30_000, // inside the pre-expiry window → triggers refresh
      },
    }, { fetchImpl });

    const err = await runtime.getValidToken("notion").catch((e) => e);

    expect(err).toBeInstanceOf(McpHttpError);
    expect(err.oauthError).toBe("invalid_grant");
  });
});

describe("MCP runtime OAuth persistence", () => {
  it("persists DCR client id, secret, and source when completing OAuth", async () => {
    let current = {
      enabled: true,
      connectors: [{ id: "notion", name: "Notion", url: "https://mcp.example.com/mcp", authType: "oauth" }],
    };
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-dcr-test"),
      config: {
        get: vi.fn(() => current),
        set: vi.fn((_key, value) => { current = { ...current, ...value }; }),
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    // Seed a pending OAuth session as if DCR had produced these products.
    runtime.oauthSessions.set("state-1", {
      status: "pending",
      state: "state-1",
      connectorId: "notion",
      connectorUrl: "https://mcp.example.com/mcp",
      clientId: "dcr-client",
      clientSecret: "dcr-secret",
      clientIdSource: "dcr",
      redirectUri: "http://127.0.0.1:3210/api/plugins/mcp/oauth/callback",
      codeVerifier: "verifier-1",
      tokenEndpoint: "https://auth.example.com/token",
      scope: "files:read offline_access",
      resource: "https://mcp.example.com/mcp",
    });

    // Stub the token exchange via fetchImpl by pointing the runtime's fetch at a fake.
    runtime.fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
      token_type: "Bearer",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await runtime.completeOAuth({ state: "state-1", code: "code-1" } as any);

    const saved = current.connectors[0] as any;
    expect(saved.oauthClientId).toBe("dcr-client");
    expect(saved.oauthClientSecret).toBe("dcr-secret");
    expect(saved.clientIdSource).toBe("dcr");
    expect(saved.oauth.accessToken).toBe("access-1");
    expect(saved.oauth.refreshToken).toBe("refresh-1");
  });

  it("fails OAuth completion when the saved connector cannot read back the token", async () => {
    let current = {
      enabled: true,
      connectors: [{ id: "notion", name: "Notion", url: "https://mcp.example.com/mcp", authType: "oauth" }],
    };
    const runtime = createManager({
      dataDir: "/tmp/mcp-readback-test",
      config: {
        get: vi.fn(() => current),
        set: vi.fn((_key, value) => {
          current = {
            ...current,
            ...value,
            connectors: (value.connectors || []).map((connector: any) => {
              const { oauth, ...rest } = connector;
              return rest;
            }),
          };
        }),
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    runtime.oauthSessions.set("state-1", {
      status: "pending",
      state: "state-1",
      connectorId: "notion",
      connectorUrl: "https://mcp.example.com/mcp",
      clientId: "dcr-client",
      clientSecret: "dcr-secret",
      clientIdSource: "dcr",
      redirectUri: "http://127.0.0.1:3210/api/plugins/mcp/oauth/callback",
      codeVerifier: "verifier-1",
      tokenEndpoint: "https://auth.example.com/token",
      scope: "files:read offline_access",
      resource: "https://mcp.example.com/mcp",
    });
    runtime.fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
      token_type: "Bearer",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(runtime.completeOAuth({ state: "state-1", code: "code-1" } as any))
      .rejects
      .toThrow("OAuth token was not persisted");
    expect(runtime.getOAuthStatus("state-1")).toMatchObject({
      status: "error",
      error: expect.stringContaining("OAuth token was not persisted"),
    });
  });

  it("defaults clientIdSource to manual for legacy connectors that already have a client id", () => {
    const config = normalizeMcpConfig({
      enabled: true,
      connectors: [
        { id: "legacy-oauth", url: "https://mcp.example.com/mcp", authType: "oauth", oauthClientId: "old-client" },
        { id: "no-client", url: "https://mcp.example.com/mcp", authType: "oauth" },
      ],
    });

    expect(config.connectors[0].clientIdSource).toBe("manual");
    expect(config.connectors[1].clientIdSource).toBe("");
  });

  it("preserves an explicit clientIdSource of dcr through normalization", () => {
    const config = normalizeMcpConfig({
      enabled: true,
      connectors: [
        { id: "auto", url: "https://mcp.example.com/mcp", authType: "oauth", oauthClientId: "auto-client", clientIdSource: "dcr" },
      ],
    });

    expect(config.connectors[0].clientIdSource).toBe("dcr");
  });

  it("never leaks the refresh token or DCR client secret through public state", () => {
    const stored = {
      enabled: true,
      connectors: [{
        id: "notion",
        name: "Notion",
        url: "https://mcp.example.com/mcp",
        authType: "oauth",
        oauthClientId: "dcr-client",
        oauthClientSecret: "super-secret-dcr",
        clientIdSource: "dcr",
        oauth: {
          accessToken: "AT-do-not-leak",
          refreshToken: "RT-do-not-leak",
          scope: "files:read offline_access",
          expiresAt: Date.now() + 3_600_000,
          tokenEndpoint: "https://auth.example.com/token",
        },
      }],
    };
    const runtime = createManager({
      dataDir: "/tmp/mcp-leak-test",
      config: { get: vi.fn(() => stored), set: vi.fn() },
      log: console,
    });

    const serialized = JSON.stringify(runtime.getState());
    expect(serialized).not.toContain("AT-do-not-leak");
    expect(serialized).not.toContain("RT-do-not-leak");
    expect(serialized).not.toContain("super-secret-dcr");

    const [connector] = runtime.getState().connectors;
    // Provenance is safe to expose (drives UI), the secret is masked.
    expect(connector.clientIdSource).toBe("dcr");
    expect(connector.oauthClientSecret).toBe("********");
    // The oauth view exposes only connection status, never raw tokens.
    expect(connector.oauth).toEqual({
      connected: true,
      scope: "files:read offline_access",
      expiresAt: stored.connectors[0].oauth.expiresAt,
    });
  });

  describe("tool invocation permission resolution", () => {
    // One row per decision-matrix line. `annotations: undefined` means the
    // runtime side table has no live entry for this tool.
    const MATRIX: Array<{
      row: string;
      policy: any;
      annotations: any;
      expected: string;
    }> = [
      {
        row: "review-all reviews everything regardless of hints or overrides",
        policy: { permissionMode: "review-all", toolPermission: "allow", trustReadOnlyHint: true },
        annotations: { readOnlyHint: true, destructiveHint: false },
        expected: "review",
      },
      {
        row: "allowlist + explicit allow + non-destructive passes",
        policy: { permissionMode: "allowlist", toolPermission: "allow" },
        annotations: { destructiveHint: false },
        expected: "read",
      },
      {
        row: "allowlist + no override + untrusted read-only reviews",
        policy: { permissionMode: "allowlist", trustReadOnlyHint: false },
        annotations: { readOnlyHint: false },
        expected: "review",
      },
      {
        row: "allowlist + trusted read-only hint passes",
        policy: { permissionMode: "allowlist", trustReadOnlyHint: true },
        annotations: { readOnlyHint: true, destructiveHint: false },
        expected: "read",
      },
      {
        row: "allowlist + read-only hint but trust disabled reviews",
        policy: { permissionMode: "allowlist", trustReadOnlyHint: false },
        annotations: { readOnlyHint: true },
        expected: "review",
      },
      {
        row: "destructive vetoes an explicit allow",
        policy: { permissionMode: "allowlist", toolPermission: "allow" },
        annotations: { destructiveHint: true },
        expected: "review",
      },
      // The three annotation-absence rows: explicit grants need no evidence,
      // implicit ones need fresh evidence, known danger vetoes either.
      {
        row: "explicit allow still passes with an empty side table",
        policy: { permissionMode: "allowlist", toolPermission: "allow" },
        annotations: undefined,
        expected: "read",
      },
      {
        row: "trustReadOnlyHint fails closed with an empty side table",
        policy: { permissionMode: "allowlist", trustReadOnlyHint: true },
        annotations: undefined,
        expected: "review",
      },
      {
        row: "explicit allow is vetoed by a live destructive annotation",
        policy: { permissionMode: "allowlist", toolPermission: "allow", trustReadOnlyHint: true },
        annotations: { readOnlyHint: true, destructiveHint: true },
        expected: "review",
      },
      {
        row: "an explicit review override outranks the read-only trust toggle",
        policy: { permissionMode: "allowlist", toolPermission: "review", trustReadOnlyHint: true },
        annotations: { readOnlyHint: true, destructiveHint: false },
        expected: "review",
      },
    ];

    for (const { row, policy, annotations, expected } of MATRIX) {
      it(row, () => {
        expect(resolveMcpToolPermissionKind(policy, annotations)).toBe(expected);
      });
    }

    it("defaults to review for an empty policy", () => {
      expect(resolveMcpToolPermissionKind({}, undefined)).toBe("review");
      expect(resolveMcpToolPermissionKind(undefined, undefined)).toBe("review");
    });

    it("keeps the diagnostics tool read-only regardless of connector policy", () => {
      const definition = createMcpConnectorsStatusToolDefinition({
        getState: () => ({ enabled: true, connectors: [] }),
        getGlobalEnabled: () => true,
      });
      expect(definition.sessionPermission.resolveInvocation()).toEqual({
        action: "read",
        kind: "read",
        capability: "connectors_status.read",
      });
    });

    it("always carries the invoke capability on the descriptor", () => {
      // Session-scoped pre-authorization keys off this string, so it must be
      // present on every descriptor whatever the policy decides.
      for (const policy of [
        { permissionMode: "review-all" },
        { permissionMode: "allowlist", toolPermission: "allow" },
      ]) {
        const definition = createMcpToolDefinition({
          serverId: "acme",
          connectorId: "acme",
          toolName: "search",
          inputSchema: { type: "object" },
          getGlobalEnabled: () => true,
          getAgentConfig: async () => ({}),
          callTool: vi.fn(),
          getPermissionPolicy: () => policy,
          getLiveAnnotations: () => undefined,
        });
        expect(definition.sessionPermission.resolveInvocation()).toMatchObject({
          action: "invoke",
          capability: "acme_search.invoke",
        });
      }
    });

    it("defaults a definition built without a policy to review", () => {
      const definition = createMcpToolDefinition({
        serverId: "acme",
        connectorId: "acme",
        toolName: "search",
        inputSchema: { type: "object" },
        getGlobalEnabled: () => true,
        getAgentConfig: async () => ({}),
        callTool: vi.fn(),
      });
      expect(definition.sessionPermission.resolveInvocation().kind).toBe("review");
    });

    async function runtimeWithAnnotations({ connector, annotations }) {
      let stored: any = {
        enabled: true,
        connectors: [{ id: "acme", name: "Acme", url: "https://mcp.example.com/mcp", ...connector }],
      };
      const set = vi.fn();
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-annotations"),
        // Persist writes back so the refreshed tool list is visible to
        // getConfig(), the way the on-disk store behaves in production.
        config: {
          get: vi.fn(() => stored),
          set: (key, value) => {
            stored = value;
            set(key, value);
          },
        },
        log: console,
      }, {
        clientFactory: () => ({
          running: true,
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          listTools: vi.fn(async () => [{
            name: "search",
            inputSchema: { type: "object" },
            ...(annotations ? { annotations } : {}),
          }]),
        }),
      });
      await runtime.startConnector("acme");
      await runtime.refreshTools("acme");
      return { runtime, set };
    }

    function kindOf(runtime) {
      const tool = runtime.getAllTools().find((item) => item.name === "mcp_acme_search");
      return tool.sessionPermission.resolveInvocation().kind;
    }

    it("resolves live annotations through the manager side table", async () => {
      const trusted = await runtimeWithAnnotations({
        connector: { permissionMode: "allowlist", trustReadOnlyHint: true },
        annotations: { readOnlyHint: true },
      });
      expect(kindOf(trusted.runtime)).toBe("read");

      const destructive = await runtimeWithAnnotations({
        connector: { permissionMode: "allowlist", toolPermissions: { search: "allow" } },
        annotations: { destructiveHint: true },
      });
      expect(kindOf(destructive.runtime)).toBe("review");

      // No live annotations at all: implicit trust has no evidence to lean on.
      const bare = await runtimeWithAnnotations({
        connector: { permissionMode: "allowlist", trustReadOnlyHint: true },
        annotations: null,
      });
      expect(kindOf(bare.runtime)).toBe("review");
    });

    it("surfaces live annotations in public state without persisting them", async () => {
      const { runtime, set } = await runtimeWithAnnotations({
        connector: { permissionMode: "allowlist" },
        annotations: { readOnlyHint: true, destructiveHint: false },
      });

      const [connector] = runtime.getState().connectors;
      expect(connector.tools[0].annotations).toEqual({ readOnlyHint: true, destructiveHint: false });

      // Annotations describe one live listing. Persisting them would make a
      // locally writable file the trust input for silent approval, so no write
      // may ever contain them.
      for (const [, value] of set.mock.calls) {
        expect(JSON.stringify(value)).not.toContain("readOnlyHint");
        expect(JSON.stringify(value)).not.toContain("annotations");
      }

      // Even feeding public state back through saveConfig strips them.
      runtime.saveConfig({ enabled: true, connectors: runtime.getState().connectors });
      expect(JSON.stringify(set.mock.calls.at(-1)[1])).not.toContain("readOnlyHint");
    });
  });

  it("normalizes connector permission policy fields with read-time defaults", () => {
    const config = normalizeMcpConfig({
      enabled: true,
      connectors: [
        // Legacy connector: zero policy fields on disk.
        { id: "legacy", url: "https://mcp.example.com/mcp" },
        {
          id: "explicit",
          url: "https://mcp.example.com/mcp",
          permissionMode: "allowlist",
          toolPermissions: { search: "allow", write: "review" },
          trustReadOnlyHint: true,
        },
        {
          id: "invalid",
          url: "https://mcp.example.com/mcp",
          permissionMode: "yolo",
          toolPermissions: { ok: "allow", bad: "sudo", worse: 1, nested: {} },
          trustReadOnlyHint: "yes",
        },
      ],
    });

    const [legacy, explicit, invalid] = config.connectors;

    // Read-time compatibility: configs written before the policy model existed
    // carry none of these fields and must read out as the safe defaults,
    // without any write-time migration.
    expect(legacy.permissionMode).toBe("review-all");
    expect(legacy.toolPermissions).toEqual({});
    expect(legacy.trustReadOnlyHint).toBe(false);

    expect(explicit.permissionMode).toBe("allowlist");
    expect(explicit.toolPermissions).toEqual({ search: "allow", write: "review" });
    expect(explicit.trustReadOnlyHint).toBe(true);

    // An unrecognized mode collapses to the safe default rather than being
    // preserved; only well-formed per-tool entries survive; a non-boolean
    // trust flag is never truthy-coerced into an implicit grant.
    expect(invalid.permissionMode).toBe("review-all");
    expect(invalid.toolPermissions).toEqual({ ok: "allow" });
    expect(invalid.trustReadOnlyHint).toBe(false);
  });

  it("exposes the connector permission policy through public state", () => {
    const stored = {
      enabled: true,
      connectors: [{
        id: "notion",
        url: "https://mcp.example.com/mcp",
        permissionMode: "allowlist",
        toolPermissions: { search: "allow" },
        trustReadOnlyHint: true,
      }],
    };
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-policy-state"),
      config: { get: vi.fn(() => stored), set: vi.fn() },
      log: console,
    });

    const [connector] = runtime.getState().connectors;
    expect(connector.permissionMode).toBe("allowlist");
    expect(connector.toolPermissions).toEqual({ search: "allow" });
    expect(connector.trustReadOnlyHint).toBe(true);
  });

  it("round-trips the connector permission policy through saveConfig", () => {
    const set = vi.fn();
    let stored: any = {
      enabled: true,
      connectors: [{ id: "notion", url: "https://mcp.example.com/mcp" }],
    };
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-policy-roundtrip"),
      config: { get: vi.fn(() => stored), set },
      log: console,
    });

    const config = runtime.getConfig();
    config.connectors[0].permissionMode = "allowlist";
    config.connectors[0].toolPermissions = { search: "allow" };
    config.connectors[0].trustReadOnlyHint = true;
    runtime.saveConfig(config);

    const written = set.mock.calls.at(-1)[1];
    expect(written.connectors[0]).toMatchObject({
      permissionMode: "allowlist",
      toolPermissions: { search: "allow" },
      trustReadOnlyHint: true,
    });

    // Reading the persisted shape back yields the identical policy.
    stored = written;
    expect(runtime.getConfig().connectors[0]).toMatchObject({
      permissionMode: "allowlist",
      toolPermissions: { search: "allow" },
      trustReadOnlyHint: true,
    });
  });
});

describe("MCP duplicate tool listings", () => {
  /**
   * A running connector whose server reports the given tool listing verbatim,
   * duplicates included. Writes are persisted back into the in-memory store so
   * a refresh can be read back the way the on-disk store behaves.
   */
  async function runtimeListing(listed) {
    let stored: any = {
      enabled: true,
      connectors: [{ id: "tushare", name: "Tushare", url: "https://mcp.example.com/mcp" }],
    };
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-duplicate-tools"),
      config: {
        get: vi.fn(() => stored),
        set: (_key, value) => { stored = value; },
      },
    }, {
      clientFactory: () => ({
        running: true,
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        listTools: vi.fn(async () => listed),
      }),
    });
    await runtime.startConnector("tushare");
    return runtime;
  }

  it("returns the folded tool list from refreshTools, identical to what was persisted", async () => {
    const runtime = await runtimeListing([
      { name: "daily_report", description: "first", inputSchema: { type: "object" } },
      { name: "daily_basic", description: "ok", inputSchema: { type: "object" } },
      { name: "daily_report", description: "second copy", inputSchema: { type: "object" } },
    ]);

    const returned = await runtime.refreshTools("tushare");
    expect(returned.map((tool) => tool.name)).toEqual(["daily_report", "daily_basic"]);
    expect(returned[0].description).toBe("first");

    // The caller must not be handed a richer list than the one on disk: the
    // settings page renders this return value directly after a refresh.
    const persisted = runtime.getConfig().connectors.find((item) => item.id === "tushare").tools;
    expect(returned).toEqual(persisted);
  });

  it("keeps a destructive declaration made by any occurrence of a repeated tool name", async () => {
    const runtime = await runtimeListing([
      {
        name: "daily_report",
        inputSchema: { type: "object" },
        annotations: { destructiveHint: true, idempotentHint: true },
      },
      {
        name: "daily_report",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true, idempotentHint: false },
      },
    ]);
    await runtime.refreshTools("tushare");

    // Were the later entry to simply overwrite the earlier one, the side table
    // would report a read-only tool and implicit trust could approve a call the
    // server itself called destructive.
    const annotations = runtime.getRuntimeToolAnnotations("tushare", "daily_report");
    expect(annotations.destructiveHint).toBe(true);
    expect(annotations.readOnlyHint).not.toBe(true);
    // Lowering hints need every occurrence to agree, so one dissent is enough.
    expect(annotations.idempotentHint).not.toBe(true);
  });
});

describe("MCP canonical tool id collisions", () => {
  /** A manager reading a fixed config out of memory, with writes captured. */
  function runtimeWithConnectors(connectors) {
    let stored: any = { enabled: true, connectors };
    const set = vi.fn((_key, value) => { stored = value; });
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-tool-collisions"),
      config: { get: () => stored, set },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }, {
      // A stub transport, so a test that loads the config does not dial the
      // example addresses these fixtures carry.
      clientFactory: () => ({
        running: true,
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        listTools: vi.fn(async () => []),
      }),
    });
    return { runtime, set };
  }

  it("reports every ambiguous canonical id and leaves unambiguous ones out", () => {
    const { runtime } = runtimeWithConnectors([
      { id: "Tushare", url: "https://one.example.test", tools: [{ name: "daily_report" }] },
      {
        id: "tushare",
        url: "https://two.example.test",
        tools: [{ name: "daily_report" }, { name: "daily_basic" }],
      },
    ]);

    const collisions = computeMcpToolIdCollisions(runtime.getConfig().connectors);
    expect(collisions.get("tushare_daily_report")).toEqual([
      { connectorId: "Tushare", toolName: "daily_report" },
      { connectorId: "tushare", toolName: "daily_report" },
    ]);
    // A tool only one identity claims is not ambiguous and must not be reported.
    expect(collisions.has("tushare_daily_basic")).toBe(false);
  });

  it("skips every ambiguous entry when publishing and keeps the rest", () => {
    const { runtime } = runtimeWithConnectors([
      { id: "Tushare", url: "https://one.example.test", tools: [{ name: "daily_report" }] },
      {
        id: "tushare",
        url: "https://two.example.test",
        tools: [{ name: "daily_report" }, { name: "daily_basic" }],
      },
    ]);
    runtime.registerCachedTools();

    const published = runtime.getAllTools().map((tool) => tool.name);
    // Neither claimant is published: with two identities behind one name there
    // is no way to say which executor a call was meant for, so picking either
    // would be routing the user's call by coin flip.
    expect(published).not.toContain("mcp_tushare_daily_report");
    expect(published).toContain("mcp_tushare_daily_basic");

    // Both sides carry the notice, since either one of them is the fix.
    const state = runtime.getState();
    expect(state.connectors[0].collisions).toEqual([{
      canonical: "tushare_daily_report",
      toolName: "daily_report",
      otherConnectorId: "tushare",
      otherToolName: "daily_report",
    }]);
    expect(state.connectors[1].collisions).toEqual([{
      canonical: "tushare_daily_report",
      toolName: "daily_report",
      otherConnectorId: "Tushare",
      otherToolName: "daily_report",
    }]);
  });

  it("detects sanitize-induced collisions within one connector", () => {
    // Trailing characters outside [A-Za-z0-9_-] are folded to an underscore by
    // sanitizeId and then stripped off the end, so a tool name and a suffixed
    // variant of it collapse to one canonical id.
    const { runtime } = runtimeWithConnectors([{
      id: "financeMcp",
      url: "https://one.example.test",
      tools: [{ name: "daily_report" }, { name: "daily_report_备份" }],
    }]);

    const collisions = computeMcpToolIdCollisions(runtime.getConfig().connectors);
    expect(collisions.get("financemcp_daily_report")).toEqual([
      { connectorId: "financeMcp", toolName: "daily_report" },
      { connectorId: "financeMcp", toolName: "daily_report_备份" },
    ]);

    runtime.registerCachedTools();
    expect(runtime.getAllTools().map((tool) => tool.name))
      .not.toContain("mcp_financemcp_daily_report");
    // Self-collision: the other claimant is this same connector, so the notice
    // names it rather than inventing a second connector.
    expect(runtime.getState().connectors[0].collisions).toEqual([
      {
        canonical: "financemcp_daily_report",
        toolName: "daily_report",
        otherConnectorId: "financeMcp",
        otherToolName: "daily_report_备份",
      },
      {
        canonical: "financemcp_daily_report",
        toolName: "daily_report_备份",
        otherConnectorId: "financeMcp",
        otherToolName: "daily_report",
      },
    ]);
  });

  it("still starts a connector whose config carries a collision", async () => {
    // The whole point of the change: a bad pair may cost its own two tools and
    // nothing else. Loading the runtime must still bring the config up.
    const { runtime } = runtimeWithConnectors([{
      id: "financeMcp",
      url: "https://one.example.test",
      tools: [{ name: "daily_report" }, { name: "daily_report_备份" }, { name: "daily_basic" }],
    }]);
    await runtime.load();
    expect(runtime.getAllTools().map((tool) => tool.name)).toContain("mcp_financemcp_daily_basic");
  });

  it("tells the agent through connectors_status which tools were dropped and why", async () => {
    const { runtime } = runtimeWithConnectors([{
      id: "financeMcp",
      name: "Finance",
      url: "https://one.example.test",
      tools: [{ name: "daily_report" }, { name: "daily_report_备份" }, { name: "daily_basic" }],
    }]);
    runtime.registerCachedTools();

    const statusTool = runtime.getAllTools().find((tool) => tool.name === "mcp_connectors_status");
    const result = await statusTool.execute("call-1", {}, { agentId: "hana" });
    const payload = JSON.parse(result.content[0].text);

    // Without this the agent's own diagnostic shows a connector in perfect
    // health while two of its tools are simply not there, which reads as the
    // server never having offered them.
    expect(payload.connectors[0].collisions).toEqual([
      {
        canonical: "financemcp_daily_report",
        toolName: "daily_report",
        otherConnectorId: "financeMcp",
        otherToolName: "daily_report_备份",
      },
      {
        canonical: "financemcp_daily_report",
        toolName: "daily_report_备份",
        otherConnectorId: "financeMcp",
        otherToolName: "daily_report",
      },
    ]);
    // The count still describes the configured list, so the two numbers only
    // agree once the collision is fixed.
    expect(payload.connectors[0].toolCount).toBe(3);
  });

  it("keeps the built-in status tool and marks the connector side of that clash", () => {
    // The host tool is published before the connector loop runs, so this is the
    // one clash that is not symmetric: the diagnostic survives and only the
    // connector's tool is dropped. The entry says so, so the notice can avoid
    // claiming both sides went away.
    const { runtime } = runtimeWithConnectors([
      { id: "connectors", url: "https://one.example.test", tools: [{ name: "status" }] },
    ]);
    runtime.registerCachedTools();

    const published = runtime.getAllTools().map((tool) => tool.name);
    expect(published).toContain("mcp_connectors_status");
    expect(published).toHaveLength(1);
    expect(runtime.getState().connectors[0].collisions).toEqual([{
      canonical: "connectors_status",
      toolName: "status",
      otherConnectorId: "mcp",
      otherToolName: "connectors_status",
      host: true,
    }]);
  });

  it("rejects a batch whose own rows normalize onto one another", () => {
    const { runtime, set } = runtimeWithConnectors([]);

    // The clash is between two rows of the same import, neither of which is on
    // disk yet, so checking only against the saved connectors would let it
    // through and cost both connectors all of their tools afterwards.
    expect(() => runtime.addConnectors([
      { id: "Alpha", url: "https://one.example.test" },
      { id: "alpha", url: "https://two.example.test" },
    ])).toThrow(/connector 2:.*conflicts with existing connector "Alpha"/i);
    expect(set).not.toHaveBeenCalled();
  });

  it("rejects an added id whose sanitized form collides with an existing connector", () => {
    const { runtime, set } = runtimeWithConnectors([
      { id: "Tushare", url: "https://one.example.test", tools: [] },
    ]);

    // Refused at the boundary that can still name the fix, before anything is
    // written: after the fact the reader can only drop tools.
    expect(() => runtime.addConnector({ id: "tushare", url: "https://two.example.test" }))
      .toThrow(/conflicts with existing connector "Tushare"/i);
    expect(set).not.toHaveBeenCalled();
  });
});

describe("MCP management-center seams", () => {
  function memoryStore(initial: any = { enabled: true, connectors: [] }) {
    let value = initial;
    return {
      get: vi.fn(() => value),
      set: vi.fn((_key, next) => { value = next; }),
      read: () => value,
    };
  }

  describe("bulk connector import", () => {
    it("writes the whole batch in one save and returns an id per item", () => {
      const store = memoryStore();
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-bulk"),
        config: store,
        log: console,
      });

      const results = runtime.addConnectors([
        { name: "Alpha", transport: "remote", url: "https://alpha.example.com/mcp" },
        { name: "Beta", transport: "stdio", command: "npx" },
      ]);

      expect(results).toEqual([
        { ok: true, id: "Alpha" },
        { ok: true, id: "Beta" },
      ]);
      // One transaction, not one write per connector.
      expect(store.set).toHaveBeenCalledTimes(1);
      expect(store.read().connectors.map((c) => c.name)).toEqual(["Alpha", "Beta"]);
    });

    it("writes nothing at all when any item fails validation", () => {
      const store = memoryStore();
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-bulk-invalid"),
        config: store,
        log: console,
      });

      let thrown: any = null;
      try {
        runtime.addConnectors([
          { name: "Alpha", transport: "remote", url: "https://alpha.example.com/mcp" },
          { name: "Beta", transport: "remote" },
        ]);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeTruthy();
      // Validate-then-write: a bad row anywhere leaves the config untouched, so
      // the user never has to undo a half-applied import.
      expect(store.set).not.toHaveBeenCalled();
      expect(thrown.results).toEqual([
        { ok: true },
        { ok: false, error: expect.stringContaining("url") },
      ]);
    });

    it("gives colliding names distinct ids inside one batch", () => {
      const store = memoryStore();
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-bulk-collide"),
        config: store,
        log: console,
      });

      const results = runtime.addConnectors([
        { name: "Same", transport: "stdio", command: "a" },
        { name: "Same", transport: "stdio", command: "b" },
      ]);

      expect(results.map((r: any) => r.id)).toEqual(["Same", "Same_2"]);
    });

    it("reports a clear message instead of a bare Invalid URL", () => {
      const store = memoryStore();
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-bad-url"),
        config: store,
        log: console,
      });

      expect(() => runtime.addConnector({ name: "NoScheme", transport: "remote", url: "example.com/mcp" }))
        .toThrow(/example\.com\/mcp/);
      expect(() => runtime.addConnector({ name: "NoScheme", transport: "remote", url: "example.com/mcp" }))
        .not.toThrow(/^Invalid URL$/);
    });
  });

  describe("cancellable OAuth waits", () => {
    it("cancels the connector's pending session so the poll reports cancelled", async () => {
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-oauth-cancel"),
        config: memoryStore(),
        log: console,
      });
      runtime.oauthSessions.set("state-1", { status: "pending", connectorId: "github" });
      runtime.oauthSessions.set("state-2", { status: "pending", connectorId: "other" });

      expect(runtime.cancelOAuth("github")).toMatchObject({ cancelled: 1 });

      expect(runtime.getOAuthStatus("state-1")).toEqual({ status: "cancelled" });
      // Another connector's wait is untouched.
      expect(runtime.getOAuthStatus("state-2")).toEqual({ status: "pending" });
    });

    it("leaves an already finished session alone", () => {
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-oauth-cancel-done"),
        config: memoryStore(),
        log: console,
      });
      runtime.oauthSessions.set("state-1", { status: "done", connectorId: "github", result: { connectorId: "github" } });

      expect(runtime.cancelOAuth("github")).toMatchObject({ cancelled: 0 });
      expect(runtime.getOAuthStatus("state-1")).toMatchObject({ status: "done" });
    });

    it("completing a cancelled session does not write a token", async () => {
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-oauth-cancel-race"),
        config: memoryStore(),
        log: console,
      });
      runtime.oauthSessions.set("state-1", { status: "pending", connectorId: "github" });
      runtime.cancelOAuth("github");

      // The browser tab may still come back after the user cancelled. A
      // cancelled wait must not silently reopen into a granted connection.
      await expect(runtime.completeOAuth({ state: "state-1", code: "code-1", error: "" }))
        .rejects.toThrow(/cancel/i);
      expect(runtime.getOAuthStatus("state-1")).toEqual({ status: "cancelled" });
    });
  });

  describe("auto-start after add", () => {
    it("starts the freshly added connector", async () => {
      const store = memoryStore();
      const start = vi.fn(async () => {});
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-autostart"),
        config: store,
        log: console,
      }, {
        clientFactory: () => ({
          running: true,
          start,
          stop: vi.fn(async () => {}),
          listTools: vi.fn(async () => [{ name: "search", inputSchema: { type: "object" } }]),
        }),
      });
      const connector = runtime.addConnector({ name: "Alpha", transport: "stdio", command: "npx" });

      await runtime.autoStartAfterAdd(connector.id);

      expect(start).toHaveBeenCalledTimes(1);
      expect(runtime.getState().connectors[0]).toMatchObject({ status: "running" });
    });

    it("records a failed start as the connector's error instead of throwing", async () => {
      const store = memoryStore();
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-autostart-fail"),
        config: store,
        log: console,
      }, {
        clientFactory: () => ({
          running: false,
          start: vi.fn(async () => { throw new Error("spawn ENOENT"); }),
          stop: vi.fn(async () => {}),
        }),
      });
      const connector = runtime.addConnector({ name: "Alpha", transport: "stdio", command: "nope" });

      // Adding succeeded; the connector simply is not up yet. The failure is
      // reported where the user is looking, not thrown at the add request.
      await expect(runtime.autoStartAfterAdd(connector.id)).resolves.toBeUndefined();
      expect(runtime.getState().connectors[0]).toMatchObject({ error: "spawn ENOENT" });
    });

    it("does not dial a connector that was added switched off", async () => {
      const store = memoryStore();
      const start = vi.fn(async () => {});
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-autostart-off"),
        config: store,
        log: console,
      }, {
        clientFactory: () => ({ running: false, start, stop: vi.fn(async () => {}) }),
      });
      const connector = runtime.addConnector({
        name: "Alpha",
        transport: "stdio",
        command: "npx",
        enabled: false,
      });

      await runtime.autoStartAfterAdd(connector.id);

      expect(start).not.toHaveBeenCalled();
      // Nothing was started, so nothing claims to be wanted running — which is
      // what keeps the switch and the live intent from drifting apart.
      expect(runtime.desiredStates.get(connector.id)).toBeUndefined();
    });

    it("dials the enabled rows of a bulk import and leaves a switched-off row alone", async () => {
      const store = memoryStore();
      const started: string[] = [];
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-autostart-bulk"),
        config: store,
        log: console,
      }, {
        clientFactory: (connector) => ({
          running: true,
          start: vi.fn(async () => { started.push(connector.id); }),
          stop: vi.fn(async () => {}),
          listTools: vi.fn(async () => []),
        }),
      });

      const results = runtime.addConnectors([
        { name: "Alpha", transport: "stdio", command: "npx" },
        { name: "Beta", transport: "stdio", command: "npx", enabled: false },
      ]);
      // The import route starts each accepted row exactly this way.
      for (const result of results) await runtime.autoStartAfterAdd(result.id);

      expect(started).toEqual(["Alpha"]);
    });

    it("does not try to start while MCP is globally disabled", async () => {
      const store = memoryStore({ enabled: false, connectors: [] });
      const start = vi.fn(async () => {});
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-autostart-disabled"),
        config: store,
        log: console,
      }, {
        clientFactory: () => ({ running: false, start, stop: vi.fn(async () => {}) }),
      });
      const connector = runtime.addConnector({ name: "Alpha", transport: "stdio", command: "npx" });

      await runtime.autoStartAfterAdd(connector.id);

      expect(start).not.toHaveBeenCalled();
      expect(runtime.getState().connectors[0].error).toBe("");
    });
  });

  describe("deferred loading settings", () => {
    it("persists the switch and threshold across a save", async () => {
      const store = memoryStore();
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-defer-persist"),
        config: store,
        log: console,
      });

      await runtime.setDeferSettings({ deferEnabled: false, deferThreshold: 25 });

      // Regression guard: saveConfig used to write only { enabled, connectors },
      // so every defer edit was silently discarded on the next read.
      expect(store.read()).toMatchObject({ deferEnabled: false, deferThreshold: 25 });
      expect(runtime.getConfig()).toMatchObject({ deferEnabled: false, deferThreshold: 25 });
    });

    it("keeps defer settings when an unrelated connector edit saves the config", async () => {
      const store = memoryStore();
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-defer-survives"),
        config: store,
        log: console,
      });
      await runtime.setDeferSettings({ deferEnabled: false, deferThreshold: 25 });

      runtime.addConnector({ name: "Alpha", transport: "stdio", command: "npx" });

      expect(runtime.getConfig()).toMatchObject({ deferEnabled: false, deferThreshold: 25 });
    });

    it("rejects a threshold that is not a positive integer", async () => {
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-defer-invalid"),
        config: memoryStore(),
        log: console,
      });

      for (const deferThreshold of [0, -1, 2.5, "ten"]) {
        await expect(runtime.setDeferSettings({ deferThreshold })).rejects.toThrow(/threshold/i);
      }
    });

    it("exposes the defer settings through getState so the settings page can read them", () => {
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-defer-state"),
        config: memoryStore(),
        log: console,
      });

      expect(runtime.getState()).toMatchObject({ deferEnabled: true, deferThreshold: 10 });
    });
  });

  it("publishes each tool's agent-facing identity in state", () => {
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-qualified"),
      config: {
        get: vi.fn(() => ({
          enabled: true,
          connectors: [{
            id: "github.com",
            name: "GitHub",
            url: "https://mcp.github.com/mcp",
            tools: [{ name: "search/repositories" }],
          }],
        })),
        set: vi.fn(),
      },
      log: console,
    });

    // The approval prompt needs to map a pending invocation back to a connector
    // and tool without re-deriving the id-sanitizing rules in the renderer.
    const [tool] = runtime.getState().connectors[0].tools;
    expect(tool).toMatchObject({
      name: "search/repositories",
      qualifiedName: "github_com_search_repositories",
      capability: "github_com_search_repositories.invoke",
    });
  });

  describe("single persisted enabled switch", () => {
    /** Let every already-queued continuation run, including fire-and-forget starts. */
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    function enabledSwitchRuntime(connectors, { start = vi.fn(async () => {}), running = true }: any = {}) {
      const store = memoryStore({ enabled: true, connectors });
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-enabled-switch"),
        config: store,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      }, {
        clientFactory: () => ({
          running,
          start,
          stop: vi.fn(async () => {}),
          listTools: vi.fn(async () => []),
          callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
        }),
      });
      return { runtime, store, start };
    }

    it("read-time migration: connectors without enabled default to enabled=true regardless of autoStart", () => {
      // The old autoStart field never had a runtime writer, so nearly every
      // real config says false while the user expects the connector to work.
      // Presence means enabled; only an explicit opt-out disables.
      const { runtime } = enabledSwitchRuntime([
        { id: "a", url: "https://a.example.test" },
        { id: "b", url: "https://b.example.test", autoStart: false },
        { id: "c", url: "https://c.example.test", enabled: false },
      ]);

      expect(runtime.getConfig().connectors.map((connector) => [connector.id, connector.enabled])).toEqual([
        ["a", true],
        ["b", true],
        ["c", false],
      ]);
    });

    it("mirrors enabled onto autoStart on write for downgrade safety", () => {
      const { runtime, store } = enabledSwitchRuntime([
        { id: "on", url: "https://on.example.test" },
        { id: "off", url: "https://off.example.test", enabled: false },
      ]);

      runtime.saveConfig(runtime.getConfig());

      // A build rolled back to the previous release reads autoStart only; the
      // mirror keeps it behaving like the user's current intent.
      expect(store.read().connectors[0]).toMatchObject({ enabled: true, autoStart: true });
      expect(store.read().connectors[1]).toMatchObject({ enabled: false, autoStart: false });
    });

    it("load() starts every enabled connector and skips disabled ones", async () => {
      const started: string[] = [];
      const store = memoryStore({
        enabled: true,
        connectors: [
          { id: "live", url: "https://live.example.test" },
          { id: "legacy", url: "https://legacy.example.test", autoStart: false },
          { id: "off", url: "https://off.example.test", enabled: false },
        ],
      });
      const runtime = createManager({
        dataDir: path.join(os.tmpdir(), "hana-mcp-enabled-load"),
        config: store,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      }, {
        clientFactory: (connector) => ({
          running: true,
          start: vi.fn(async () => { started.push(connector.id); }),
          stop: vi.fn(async () => {}),
          listTools: vi.fn(async () => []),
        }),
      });

      await runtime.load();
      await flush();

      expect(started.sort()).toEqual(["legacy", "live"]);
      await runtime.dispose();
    });

    it("stop via settings action persists enabled=false; start persists enabled=true", async () => {
      const { runtime, store } = enabledSwitchRuntime([{ id: "alpha", url: "https://alpha.example.test" }]);

      await runtime.handleSettingsAction({ action: "mcp.connector.stop", payload: { connectorId: "alpha" } });
      expect(store.read().connectors[0]).toMatchObject({ enabled: false });

      await runtime.handleSettingsAction({ action: "mcp.connector.start", payload: { connectorId: "alpha" } });
      expect(store.read().connectors[0]).toMatchObject({ enabled: true });

      await runtime.dispose();
    });

    it("records intent before touching the transport in the settings action too", async () => {
      const { runtime } = enabledSwitchRuntime([{ id: "alpha", url: "https://alpha.example.test" }]);
      const order: string[] = [];
      const persist = runtime.setConnectorEnabled.bind(runtime);
      runtime.setConnectorEnabled = async (id, enabled) => {
        order.push(`persist:${enabled}`);
        return persist(id, enabled);
      };
      runtime.startConnector = async () => {
        order.push("start");
        return runtime.getConfig().connectors[0];
      };
      runtime.stopConnector = async () => { order.push("stop"); };

      await runtime.handleSettingsAction({ action: "mcp.connector.start", payload: { connectorId: "alpha" } });
      await runtime.handleSettingsAction({ action: "mcp.connector.stop", payload: { connectorId: "alpha" } });

      // Same pairing the HTTP route is held to: persist, then transport.
      expect(order).toEqual(["persist:true", "start", "persist:false", "stop"]);
    });

    it("internal reconnect paths never rewrite enabled", async () => {
      const start = vi.fn(async () => { throw new Error("connection refused"); });
      const { runtime, store } = enabledSwitchRuntime(
        [{ id: "alpha", url: "https://alpha.example.test", enabled: true }],
        { start, running: false },
      );

      // A failed auto-start, the backoff teardown behind it, and a dropped
      // connection are the runtime's own business. Only the user's start/stop
      // is an intent worth writing down.
      await runtime.load();
      await flush();
      await runtime.stopConnector("alpha");
      runtime._onClientClose("alpha", { reason: "connection lost" });

      expect(store.read().connectors[0]).toMatchObject({ enabled: true });
      await runtime.dispose();
    });

    it("callTool lazily starts an enabled-but-idle connector once, coalescing concurrent calls", async () => {
      const { runtime } = enabledSwitchRuntime([
        { id: "alpha", url: "https://alpha.example.test", tools: [{ name: "search" }] },
      ]);
      let openGate = () => {};
      const gate = new Promise<void>((resolve) => { openGate = resolve; });
      const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
      const startConnector = vi.fn(async () => {
        await gate;
        runtime.clients.set("alpha", { running: true, callTool, stop: vi.fn(async () => {}) });
      });
      runtime.startConnector = startConnector;

      const calls = Promise.all([
        runtime.callTool("alpha", "search", {}),
        runtime.callTool("alpha", "search", {}),
      ]);
      openGate();
      const results = await calls;

      expect(startConnector).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledTimes(2);
      expect(results[0]).toMatchObject({ content: [{ type: "text", text: "ok" }] });
    });

    it("keeps a disabled connector's tools out of the model-facing tool list", () => {
      const { runtime } = enabledSwitchRuntime([
        { id: "live", url: "https://live.example.test", tools: [{ name: "search" }] },
        { id: "off", url: "https://off.example.test", enabled: false, tools: [{ name: "lookup" }] },
      ]);

      runtime.registerCachedTools();
      const names = runtime.getAllTools().map((tool) => tool.name);

      expect(names).toContain("mcp_live_search");
      expect(names).not.toContain("mcp_off_lookup");
      // The host diagnostic is not a connector capability and stays published.
      expect(names).toContain("mcp_connectors_status");
    });

    it("keeps the deferred catalog on the same footing as the published tools", () => {
      const { runtime } = enabledSwitchRuntime([
        { id: "live", url: "https://live.example.test", tools: [{ name: "search" }] },
        { id: "off", url: "https://off.example.test", enabled: false, tools: [{ name: "lookup" }] },
      ]);

      // Two projections of one config: a tool missing from the direct path but
      // present in the catalog would let the model ask for something that
      // cannot be loaded.
      expect(runtime.getCatalogEntries().map((entry) => entry.name)).toEqual(["live_search"]);
    });

    it("does not let a disabled connector drag a live connector's tool down with it", () => {
      const { runtime } = enabledSwitchRuntime([
        { id: "Finance", url: "https://one.example.test", tools: [{ name: "daily_report" }] },
        { id: "finance", url: "https://two.example.test", enabled: false, tools: [{ name: "daily_report" }] },
      ]);

      runtime.registerCachedTools();

      // Ambiguity is what costs a tool its place, and a connector nobody can
      // call is not a claimant. Switching one off has to resolve the clash, not
      // preserve it.
      expect(runtime.getAllTools().map((tool) => tool.name)).toContain("mcp_finance_daily_report");
      const byId = new Map<string, any>(runtime.getState().connectors.map((item) => [item.id, item]));
      expect(byId.get("Finance").collisions).toEqual([]);
      expect(byId.get("finance").collisions).toEqual([]);
    });

    it("restores the collision verdict when the disabled claimant is switched back on", async () => {
      const { runtime } = enabledSwitchRuntime([
        { id: "Finance", url: "https://one.example.test", tools: [{ name: "daily_report" }] },
        { id: "finance", url: "https://two.example.test", enabled: false, tools: [{ name: "daily_report" }] },
      ]);

      await runtime.setConnectorEnabled("finance", true);
      runtime.registerCachedTools();

      expect(runtime.getAllTools().map((tool) => tool.name)).not.toContain("mcp_finance_daily_report");
      const byId = new Map<string, any>(runtime.getState().connectors.map((item) => [item.id, item]));
      expect(byId.get("Finance").collisions).toMatchObject([{ canonical: "finance_daily_report" }]);
      expect(byId.get("finance").collisions).toMatchObject([{ canonical: "finance_daily_report" }]);
    });

    it("keeps a disabled connector visible in the settings projection", () => {
      const { runtime } = enabledSwitchRuntime([
        { id: "live", url: "https://live.example.test" },
        { id: "off", url: "https://off.example.test", enabled: false },
      ]);

      // Leaving the model's view is not leaving the user's view: a connector
      // the user cannot see is a connector the user cannot switch back on.
      expect(runtime.getState().connectors.map((item) => [item.id, item.enabled])).toEqual([
        ["live", true],
        ["off", false],
      ]);
    });

    it("holds the connector id namespace against disabled connectors too", () => {
      const { runtime } = enabledSwitchRuntime([
        { id: "Finance", url: "https://one.example.test", enabled: false },
      ]);

      // Switching a connector off does not surrender its name; taking it would
      // make both connectors' tools ambiguous the moment it comes back.
      expect(() => runtime.addConnector({
        id: "finance",
        name: "finance",
        transport: "remote",
        url: "https://two.example.test",
      })).toThrow(/conflicts with existing connector/);
    });

    it("refuses to move the switch through a connector update", async () => {
      const { runtime, store } = enabledSwitchRuntime([
        { id: "alpha", url: "https://alpha.example.test", enabled: true },
      ]);

      await runtime.handleSettingsAction({
        action: "mcp.connector.update",
        payload: { connectorId: "alpha", name: "Alpha", enabled: false },
      });
      expect(store.read().connectors[0]).toMatchObject({ enabled: true, name: "Alpha" });

      // The HTTP route hands its request body straight to updateConnector, so
      // the guard has to hold one level below the settings action too.
      await runtime.updateConnector("alpha", { name: "Alpha two", enabled: false });
      expect(store.read().connectors[0]).toMatchObject({ enabled: true, name: "Alpha two" });
    });

    it("refuses a direct start of a switched-off connector instead of forking intent", async () => {
      const { runtime, start } = enabledSwitchRuntime([
        { id: "off", url: "https://off.example.test", enabled: false },
      ]);

      await expect(runtime.startConnector("off"))
        .rejects.toThrow(/is disabled; enable it in Settings . MCP before starting/);
      expect(start).not.toHaveBeenCalled();
      // The refusal has to land before the intent is recorded, or the very
      // divergence the switch exists to prevent is created by the guard itself.
      expect(runtime.desiredStates.get("off")).toBeUndefined();
    });

    it("refuses to reconnect a connector the switch says is off, whatever memory claims", () => {
      const { runtime } = enabledSwitchRuntime([
        { id: "off", url: "https://off.example.test", enabled: false },
      ]);
      // A hand-made fork of the two sources of truth: the process still thinks
      // this connector is wanted, the disk says it was switched off. The disk
      // is the one the user edited, so it wins.
      runtime.desiredStates.set("off", "running");

      expect(runtime._isDesiredLiveConnector("off")).toBe(false);
      expect(runtime._canAutoReconnect("off")).toBe(false);
    });

    it("drops in-flight lazy starts on dispose", async () => {
      const { runtime } = enabledSwitchRuntime([
        { id: "alpha", url: "https://alpha.example.test", tools: [{ name: "search" }] },
      ]);
      runtime._lazyStarts.set("alpha", Promise.resolve());

      await runtime.dispose();

      expect(runtime._lazyStarts.size).toBe(0);
    });

    it("tells the agent's own diagnostic which connectors are switched off", async () => {
      const { runtime } = enabledSwitchRuntime([
        { id: "live", url: "https://live.example.test", tools: [{ name: "search" }] },
        { id: "off", url: "https://off.example.test", enabled: false, tools: [{ name: "lookup" }] },
      ]);
      runtime.registerCachedTools();

      const statusTool = runtime.getAllTools().find((tool) => tool.name === "mcp_connectors_status");
      const payload = JSON.parse((await statusTool.execute("call-1", {}, { agentId: "hana" })).content[0].text);

      // Without this the agent sees a stopped connector and keeps suggesting a
      // start, which is not the action that would fix it.
      expect(payload.connectors.map((item) => [item.id, item.enabled])).toEqual([
        ["live", true],
        ["off", false],
      ]);
    });

    it("diagnoses a switched-off connector as disabled rather than stopped", () => {
      const { runtime } = enabledSwitchRuntime([
        { id: "off", url: "https://off.example.test", enabled: false, tools: [{ name: "lookup" }] },
      ]);

      expect(runtime.probeToolLiveAvailability("off", "lookup", {
        mcp: { connectors: { off: { enabled: true, tools: { lookup: true } } } },
      })).toMatchObject({
        available: false,
        reason: "mcp_connector_disabled",
      });
    });

    it("names an unknown connector instead of reporting it as not running", async () => {
      const { runtime } = enabledSwitchRuntime([]);

      await expect(runtime.callTool("ghost", "search", {}))
        .rejects.toThrow('MCP connector "ghost" not found');
    });

    it("says where to look when the on-demand start fails", async () => {
      const start = vi.fn(async () => { throw new Error("spawn ENOENT"); });
      const { runtime } = enabledSwitchRuntime(
        [{ id: "alpha", url: "https://alpha.example.test", tools: [{ name: "search" }] }],
        { start, running: false },
      );

      // The transport's own reason survives; the pointer to the settings page
      // is appended, because that is where the retry and the detail live.
      await expect(runtime.callTool("alpha", "search", {})).rejects.toThrow(
        "spawn ENOENT (automatic reconnect failed; start it manually in Settings → MCP for details)",
      );
    });

    it("callTool refuses a disabled connector with an actionable message", async () => {
      const { runtime, start } = enabledSwitchRuntime([
        { id: "alpha", url: "https://alpha.example.test", enabled: false, tools: [{ name: "search" }] },
      ]);

      await expect(runtime.callTool("alpha", "search", {}))
        .rejects.toThrow(/is disabled; enable it in Settings/);
      // A disabled connector must not be woken up by the refusal path either.
      expect(start).not.toHaveBeenCalled();
    });
  });
});

// The app-facing surface — reading a ui:// resource, calling an app-visible
// tool, refreshing a connector's tool list — has to tell the same two states
// apart that callTool does. A connector the user switched off is refused with
// the message that says how to undo it, and is never woken up on the way; a
// connector that merely is not connected yet gets started on demand instead of
// failing a request it is perfectly able to serve.
describe("MCP app-facing calls and the enabled switch", () => {
  const boardTool = () => ({ name: "board", _meta: { ui: { resourceUri: "ui://board/main" } } });

  function appRuntime(connectors, { listTools = vi.fn(async () => [boardTool()]) }: any = {}) {
    let value: any = { enabled: true, connectors };
    const store = {
      get: vi.fn(() => value),
      set: vi.fn((_key: any, next: any) => { value = next; }),
      read: () => value,
    };
    const built: any[] = [];
    const runtime = createManager({
      dataDir: path.join(os.tmpdir(), "hana-mcp-app-switch"),
      config: store,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }, {
      // A fresh client reports itself as not running until start() resolves,
      // which is what makes the on-demand start observable from the outside.
      clientFactory: () => {
        const client: any = {
          running: false,
          start: vi.fn(async () => { client.running = true; }),
          stop: vi.fn(async () => {}),
          listTools,
          readResource: vi.fn(async () => ({
            contents: [{ uri: "ui://board/main", mimeType: "text/html", text: "<h1>board</h1>" }],
          })),
          callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
        };
        built.push(client);
        return client;
      },
    });
    return { runtime, store, built, listTools };
  }

  const offConnector = () => ({
    id: "acme", name: "Acme", url: "https://mcp.acme.test/mcp", enabled: false, tools: [boardTool()],
  });
  const idleConnector = () => ({
    id: "acme", name: "Acme", url: "https://mcp.acme.test/mcp", tools: [boardTool()],
  });

  describe("readResource", () => {
    it("refuses a switched-off connector with an actionable message and never wakes it", async () => {
      const { runtime } = appRuntime([offConnector()]);
      const ensure = vi.spyOn(runtime as any, "_ensureConnectorStarted");

      await expect(runtime.readResource("acme", "ui://board/main"))
        .rejects.toThrow(/is disabled; enable it in Settings/);
      expect(ensure).not.toHaveBeenCalled();
    });

    it("starts an enabled but unconnected connector on demand instead of failing", async () => {
      const { runtime, built } = appRuntime([idleConnector()]);
      const ensure = vi.spyOn(runtime as any, "_ensureConnectorStarted");

      const result = await runtime.readResource("acme", "ui://board/main");

      expect(ensure).toHaveBeenCalledWith("acme");
      expect(result.contents[0].text).toBe("<h1>board</h1>");
      expect(built[0].readResource).toHaveBeenCalledWith("ui://board/main");
    });

    it("names an unknown connector instead of reporting it as not running", async () => {
      const { runtime } = appRuntime([]);

      await expect(runtime.readResource("ghost", "ui://board/main"))
        .rejects.toThrow('MCP connector "ghost" not found');
    });
  });

  describe("callAppTool", () => {
    it("refuses a switched-off connector with an actionable message and never wakes it", async () => {
      const { runtime } = appRuntime([offConnector()]);
      const ensure = vi.spyOn(runtime as any, "_ensureConnectorStarted");

      await expect(runtime.callAppTool("acme", "board", {}))
        .rejects.toThrow(/is disabled; enable it in Settings/);
      expect(ensure).not.toHaveBeenCalled();
    });

    it("starts an enabled but unconnected connector on demand instead of failing", async () => {
      const { runtime, built } = appRuntime([idleConnector()]);
      const ensure = vi.spyOn(runtime as any, "_ensureConnectorStarted");

      const result = await runtime.callAppTool("acme", "board", { q: 1 });

      expect(ensure).toHaveBeenCalledWith("acme");
      expect(result.content[0].text).toBe("ok");
      expect(built[0].callTool).toHaveBeenCalledWith("board", { q: 1 });
    });

    it("names an unknown connector instead of reporting it as not running", async () => {
      const { runtime } = appRuntime([]);

      await expect(runtime.callAppTool("ghost", "board", {}))
        .rejects.toThrow('MCP connector "ghost" not found');
    });
  });

  describe("refreshTools", () => {
    it("refuses a switched-off connector with an actionable message and never wakes it", async () => {
      const { runtime } = appRuntime([offConnector()]);
      const ensure = vi.spyOn(runtime as any, "_ensureConnectorStarted");

      await expect(runtime.refreshTools("acme"))
        .rejects.toThrow(/is disabled; enable it in Settings/);
      expect(ensure).not.toHaveBeenCalled();
    });

    it("starts an enabled but unconnected connector on demand instead of failing", async () => {
      const listTools = vi.fn(async () => [{ name: "fresh" }]);
      const { runtime } = appRuntime(
        [{ id: "acme", name: "Acme", url: "https://mcp.acme.test/mcp", tools: [{ name: "stale" }] }],
        { listTools },
      );
      const ensure = vi.spyOn(runtime as any, "_ensureConnectorStarted");

      const tools = await runtime.refreshTools("acme");

      expect(ensure).toHaveBeenCalledWith("acme");
      // Bringing the connector up lists its tools as part of connecting, so the
      // answer is already the freshest one there is: it must be handed back
      // rather than asked for a second time.
      expect(tools.map((tool) => tool.name)).toEqual(["fresh"]);
      expect(listTools).toHaveBeenCalledTimes(1);
    });

    it("lists the tools itself when the start found the connection already live", async () => {
      // The other half of the same decision. A start that arrives to find a live
      // connection has nothing to list, so there is no fresh answer to inherit
      // and the refresh has to ask for one. Handing back the stored list here
      // would answer a refresh with whatever happened to be on disk.
      const listTools = vi.fn(async () => [{ name: "fresh" }]);
      const { runtime, built } = appRuntime(
        [{ id: "acme", name: "Acme", url: "https://mcp.acme.test/mcp", tools: [{ name: "stale" }] }],
        { listTools },
      );
      // Stubbed deliberately: the real call graph cannot drive this branch —
      // the client is read and the branch entered in one tick, and a concurrent
      // start marks the connector as establishing, which is excluded earlier.
      // The stub reproduces exactly what startConnector does when it finds a
      // running client, so the branch is held to its contract regardless.
      runtime.startConnector = vi.fn(async () => {
        // Adopt the live client and return, without listing anything.
        const live: any = { running: true, stop: vi.fn(async () => {}), listTools };
        built.push(live);
        runtime.clients.set("acme", live);
        return runtime.getConfig().connectors.find((entry) => entry.id === "acme");
      });

      const tools = await runtime.refreshTools("acme");

      expect(tools.map((tool) => tool.name)).toEqual(["fresh"]);
      expect(listTools).toHaveBeenCalledTimes(1);
    });

    it("counts listings from scratch again after the connector was stopped", async () => {
      // Stopping drops the listing count along with the connection it described.
      // The next refresh starts the connector again and must still recognize the
      // listing that start performed, rather than being confused by the reset.
      const listTools = vi.fn(async () => [{ name: "fresh" }]);
      const { runtime } = appRuntime(
        [{ id: "acme", name: "Acme", url: "https://mcp.acme.test/mcp", tools: [{ name: "stale" }] }],
        { listTools },
      );

      await runtime.startConnector("acme");
      await runtime.stopConnector("acme");
      expect((runtime as any)._toolListings.has("acme")).toBe(false);

      const tools = await runtime.refreshTools("acme");

      expect(tools.map((tool) => tool.name)).toEqual(["fresh"]);
      // Once for the first start, once for the restart this refresh triggered —
      // and no third listing, because the restart's own listing was recognized.
      expect(listTools).toHaveBeenCalledTimes(2);
    });

    it("names an unknown connector instead of reporting it as not running", async () => {
      const { runtime } = appRuntime([]);

      await expect(runtime.refreshTools("ghost"))
        .rejects.toThrow('MCP connector "ghost" not found');
    });

    it("does not try to start the connector while it is the one being started", async () => {
      // A connection ends by listing the connector's tools, so this refresh runs
      // from inside the start attempt. A transport that comes back from start()
      // without being usable must surface as a failed connection, not as a
      // refresh waiting on the very attempt it belongs to.
      const { runtime, built } = appRuntime([idleConnector()]);
      const ensure = vi.spyOn(runtime as any, "_ensureConnectorStarted");
      runtime.clientFactory = () => {
        const client: any = {
          running: false,
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          listTools: vi.fn(async () => []),
        };
        built.push(client);
        return client;
      };

      await expect(runtime.startConnector("acme")).rejects.toThrow(/is not running/);
      expect(ensure).not.toHaveBeenCalled();
      expect(built).toHaveLength(1);
    });
  });
});
