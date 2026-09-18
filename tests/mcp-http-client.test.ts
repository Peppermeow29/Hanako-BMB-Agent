import { describe, it, expect, vi } from "vitest";
import { MCP_PROTOCOL_VERSION } from "../core/mcp/clients/stdio-client.ts";
import { MCP_PROTOCOL_VERSION_2026_07_28 } from "../core/mcp/clients/protocol-version.ts";
import {
  McpAutoHttpClient,
  McpHttpError,
  McpLegacySseClient,
  McpStreamableHttpClient,
  resolveMcpHttpProxyDiagnostics,
} from "../core/mcp/clients/http-client.ts";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function emptyResponse({ status = 202, headers = {} } = {}) {
  return new Response(null, { status, headers });
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(name);
  const found = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === lower);
  return found?.[1];
}

function requestBody(init) {
  return init?.body ? JSON.parse(String(init.body)) : null;
}

// A real pre-2026-07-28 server does not implement server/discover. It answers
// the era probe with a plain HTTP rejection that carries no recognizable modern
// JSON-RPC error, which is exactly the signal that sends the client back to the
// initialize handshake.
function legacyDiscoverRejection() {
  return new Response("Not Found", { status: 404 });
}

// A 2026-07-28 server answers the probe with the versions it speaks.
function modernDiscoverResult(body, { supportedVersions = [MCP_PROTOCOL_VERSION_2026_07_28] } = {}) {
  return jsonResponse({
    jsonrpc: "2.0",
    id: body.id,
    result: {
      resultType: "complete",
      supportedVersions,
      capabilities: { tools: {} },
      _meta: {
        "io.modelcontextprotocol/serverInfo": { name: "ExampleServer", version: "1.0.0" },
      },
    },
  });
}

function requestMeta(body) {
  return body?.params?._meta || {};
}

describe("MCP HTTP clients", () => {
  it("uses Streamable HTTP JSON-RPC POST with bearer auth and session headers", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      requests.push({ url: String(url), init, body });
      if (body?.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        }, { headers: { "MCP-Session-Id": "session-a" } });
      }
      if (body?.method === "server/discover") return legacyDiscoverRejection();
      if (body?.method === "notifications/initialized") return emptyResponse();
      if (body?.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "search", inputSchema: { type: "object" } }] },
        });
      }
      if (body?.method === "tools/call") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "ok" }] },
        });
      }
      throw new Error(`unexpected method ${body?.method}`);
    });

    const client = new McpStreamableHttpClient({
      id: "github",
      url: "https://mcp.github.com/mcp",
      authorizationToken: "token-123",
    }, { fetchImpl });

    await client.start();
    const tools = await client.listTools();
    const result = await client.callTool("search", { q: "hana" });

    expect(tools).toEqual([{ name: "search", inputSchema: { type: "object" } }]);
    expect(result.content[0].text).toBe("ok");
    expect(requests.map(r => r.body?.method)).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    const initialize = requests[1];
    const list = requests[3];
    expect(headerValue(initialize.init.headers, "Accept")).toBe("application/json, text/event-stream");
    expect(headerValue(initialize.init.headers, "Content-Type")).toBe("application/json");
    expect(headerValue(initialize.init.headers, "Authorization")).toBe("Bearer token-123");
    expect(headerValue(list.init.headers, "MCP-Protocol-Version")).toBe(MCP_PROTOCOL_VERSION);
    expect(headerValue(list.init.headers, "MCP-Session-Id")).toBe("session-a");
  });

  it("skips the handshake entirely against a 2026-07-28 server and carries per-request metadata", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      requests.push({ url: String(url), init, body });
      if (body?.method === "server/discover") return modernDiscoverResult(body);
      if (body?.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { resultType: "complete", tools: [{ name: "search" }] },
        });
      }
      throw new Error(`unexpected method ${body?.method}`);
    });

    const client = new McpStreamableHttpClient({
      id: "modern",
      url: "https://mcp.example.com/mcp",
    }, { fetchImpl });

    await client.start();
    const tools = await client.listTools();

    expect(tools).toEqual([{ name: "search" }]);
    // No initialize, no notifications/initialized, no session: the probe is the
    // only thing that precedes ordinary business traffic.
    expect(requests.map(r => r.body?.method)).toEqual(["server/discover", "tools/list"]);
    expect(client.protocolVersion).toBe(MCP_PROTOCOL_VERSION_2026_07_28);
    expect(client.sessionId).toBe("");

    const list = requests.at(-1);
    expect(headerValue(list.init.headers, "MCP-Protocol-Version")).toBe(MCP_PROTOCOL_VERSION_2026_07_28);
    expect(headerValue(list.init.headers, "MCP-Session-Id")).toBeFalsy();
    expect(requestMeta(list.body)["io.modelcontextprotocol/protocolVersion"]).toBe(MCP_PROTOCOL_VERSION_2026_07_28);
    expect(requestMeta(list.body)["io.modelcontextprotocol/clientInfo"]).toMatchObject({ name: "hana" });
    expect(requestMeta(list.body)["io.modelcontextprotocol/clientCapabilities"]).toBeTypeOf("object");
  });

  it("falls back to the legacy handshake when the probe is not a valid DiscoverResult", async () => {
    // Each entry is a way the probe can fail to prove a modern server. Every one
    // of them must land on the initialize handshake rather than guessing modern.
    const malformed = [
      () => { throw new Error("network down"); },
      (body) => jsonResponse({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete" } }),
      (body) => jsonResponse({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", supportedVersions: [] } }),
      (body) => jsonResponse({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", supportedVersions: "2026-07-28" } }),
      (body) => jsonResponse({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", supportedVersions: [42] } }),
      (body) => jsonResponse({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", supportedVersions: ["2025-11-25"] } }),
      () => legacyDiscoverRejection(),
    ];

    for (const probeResponse of malformed) {
      const requests = [];
      const fetchImpl = vi.fn(async (url, init) => {
        const body = requestBody(init);
        requests.push(body);
        if (body?.method === "server/discover") return probeResponse(body);
        if (body?.method === "initialize") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
          }, { headers: { "MCP-Session-Id": "session-a" } });
        }
        if (body?.method === "notifications/initialized") return emptyResponse();
        if (body?.method === "tools/list") {
          return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
        }
        throw new Error(`unexpected method ${body?.method}`);
      });

      const client = new McpStreamableHttpClient({
        id: "legacy",
        url: "https://mcp.example.com/mcp",
      }, { fetchImpl });

      await client.start();
      await client.listTools();

      expect(requests.map(r => r?.method)).toEqual([
        "server/discover",
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
      expect(client.sessionId).toBe("session-a");
      expect(requestMeta(requests.at(-1))["io.modelcontextprotocol/protocolVersion"]).toBeUndefined();
    }
  });

  it("skips the probe when the connector pins a protocol version", async () => {
    async function connect(protocolVersion) {
      const requests = [];
      const fetchImpl = vi.fn(async (url, init) => {
        const body = requestBody(init);
        requests.push(body);
        if (body?.method === "initialize") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion, capabilities: {} },
          }, { headers: { "MCP-Session-Id": "session-a" } });
        }
        if (body?.method === "notifications/initialized") return emptyResponse();
        if (body?.method === "tools/list") {
          return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
        }
        throw new Error(`unexpected method ${body?.method}`);
      });
      const client = new McpStreamableHttpClient({
        id: "pinned",
        url: "https://mcp.example.com/mcp",
        protocolVersion,
      }, { fetchImpl });
      await client.start();
      await client.listTools();
      return requests.map(r => r?.method);
    }

    // Pinned modern: straight onto the stateless track, no probe, no handshake.
    expect(await connect(MCP_PROTOCOL_VERSION_2026_07_28)).toEqual(["tools/list"]);
    // Pinned legacy: straight onto the handshake, no probe.
    expect(await connect(MCP_PROTOCOL_VERSION)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });

  function modernServer({ tools = [] } = {}) {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      requests.push({ url: String(url), init, body });
      if (body?.method === "server/discover") return modernDiscoverResult(body);
      if (body?.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { resultType: "complete", tools },
        });
      }
      if (body?.method === "tools/call") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { resultType: "complete", content: [{ type: "text", text: "ok" }] },
        });
      }
      if (body?.method === "resources/read") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { resultType: "complete", contents: [] },
        });
      }
      throw new Error(`unexpected method ${body?.method}`);
    });
    const client = new McpStreamableHttpClient({
      id: "modern",
      url: "https://mcp.example.com/mcp",
    }, { fetchImpl });
    return { requests, client, lastFor: (method) => requests.filter(r => r.body?.method === method).at(-1) };
  }

  it("mirrors method and name into routing headers on the stateless path", async () => {
    const { requests, client, lastFor } = modernServer({ tools: [{ name: "search" }] });
    await client.start();
    await client.listTools();
    await client.callTool("search", { q: "hana" });
    await client.readResource("file:///projects/app/config.json");

    // Every request mirrors its method; only the name-bearing methods mirror a name.
    expect(headerValue(requests[0].init.headers, "Mcp-Method")).toBe("server/discover");
    expect(headerValue(lastFor("tools/list").init.headers, "Mcp-Method")).toBe("tools/list");
    expect(headerValue(lastFor("tools/list").init.headers, "Mcp-Name")).toBeFalsy();
    expect(headerValue(lastFor("tools/call").init.headers, "Mcp-Method")).toBe("tools/call");
    expect(headerValue(lastFor("tools/call").init.headers, "Mcp-Name")).toBe("search");
    expect(headerValue(lastFor("resources/read").init.headers, "Mcp-Name"))
      .toBe("file:///projects/app/config.json");
  });

  it("does not send routing headers on the legacy path", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      requests.push({ url: String(url), init, body });
      if (body?.method === "server/discover") return legacyDiscoverRejection();
      if (body?.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        }, { headers: { "MCP-Session-Id": "session-a" } });
      }
      if (body?.method === "notifications/initialized") return emptyResponse();
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { content: [] } });
    });
    const client = new McpStreamableHttpClient({
      id: "legacy",
      url: "https://mcp.example.com/mcp",
    }, { fetchImpl });

    await client.start();
    await client.callTool("search", { q: "hana" });

    const call = requests.filter(r => r.body?.method === "tools/call").at(-1);
    expect(headerValue(call.init.headers, "Mcp-Method")).toBeFalsy();
    expect(headerValue(call.init.headers, "Mcp-Name")).toBeFalsy();
  });

  it("mirrors annotated tool arguments into Mcp-Param headers", async () => {
    const { client, lastFor } = modernServer({
      tools: [{
        name: "execute_sql",
        inputSchema: {
          type: "object",
          properties: {
            region: { type: "string", "x-mcp-header": "Region" },
            dry_run: { type: "boolean", "x-mcp-header": "DryRun" },
            attempt: { type: "integer", "x-mcp-header": "Attempt" },
            query: { type: "string" },
          },
        },
      }],
    });
    await client.start();
    await client.listTools();
    await client.callTool("execute_sql", {
      region: "us-west1",
      dry_run: false,
      attempt: 42,
      query: "SELECT 1",
    });

    const headers = lastFor("tools/call").init.headers;
    expect(headerValue(headers, "Mcp-Param-Region")).toBe("us-west1");
    expect(headerValue(headers, "Mcp-Param-DryRun")).toBe("false");
    expect(headerValue(headers, "Mcp-Param-Attempt")).toBe("42");
    // An unannotated argument stays in the body only.
    expect(headerValue(headers, "Mcp-Param-Query")).toBeFalsy();
  });

  it("omits an Mcp-Param header when the annotated argument is absent or null", async () => {
    const { client, lastFor } = modernServer({
      tools: [{
        name: "execute_sql",
        inputSchema: {
          type: "object",
          properties: {
            region: { type: "string", "x-mcp-header": "Region" },
            tenant: { type: "string", "x-mcp-header": "Tenant" },
          },
        },
      }],
    });
    await client.start();
    await client.listTools();
    await client.callTool("execute_sql", { tenant: null });

    const headers = lastFor("tools/call").init.headers;
    expect(headerValue(headers, "Mcp-Param-Region")).toBeFalsy();
    expect(headerValue(headers, "Mcp-Param-Tenant")).toBeFalsy();
  });

  it("base64-encodes header values that cannot travel as plain ASCII", async () => {
    const { client, lastFor } = modernServer({
      tools: [{
        name: "greet",
        inputSchema: {
          type: "object",
          properties: { greeting: { type: "string", "x-mcp-header": "Greeting" } },
        },
      }],
    });
    await client.start();
    await client.listTools();
    await client.callTool("greet", { greeting: "Hello, 世界" });

    expect(headerValue(lastFor("tools/call").init.headers, "Mcp-Param-Greeting"))
      .toBe("=?base64?SGVsbG8sIOS4lueVjA==?=");
  });

  it("excludes tools whose x-mcp-header annotation violates the spec", async () => {
    const { client } = modernServer({
      tools: [
        { name: "ok_tool", inputSchema: { type: "object", properties: { a: { type: "string", "x-mcp-header": "A" } } } },
        // number is explicitly not permitted for a mirrored parameter
        { name: "number_param", inputSchema: { type: "object", properties: { n: { type: "number", "x-mcp-header": "N" } } } },
        // duplicate names, compared case-insensitively
        { name: "dupe", inputSchema: { type: "object", properties: {
          a: { type: "string", "x-mcp-header": "Dup" },
          b: { type: "string", "x-mcp-header": "dup" },
        } } },
        // not statically reachable: the annotation hides inside an array item
        { name: "nested", inputSchema: { type: "object", properties: {
          rows: { type: "array", items: { type: "object", properties: { r: { type: "string", "x-mcp-header": "R" } } } },
        } } },
        // illegal header token
        { name: "bad_token", inputSchema: { type: "object", properties: { a: { type: "string", "x-mcp-header": "Bad Name" } } } },
      ],
    });
    await client.start();
    const tools = await client.listTools();

    // One malformed definition must not cost us the healthy tools.
    expect(tools.map(t => t.name)).toEqual(["ok_tool"]);
  });

  it("captures tool-list freshness hints when the server sends them", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      if (body?.method === "server/discover") return modernDiscoverResult(body);
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { resultType: "complete", tools: [], ttlMs: 300000, cacheScope: "public" },
      });
    });
    const client = new McpStreamableHttpClient({
      id: "modern",
      url: "https://mcp.example.com/mcp",
    }, { fetchImpl });

    const before = Date.now();
    await client.start();
    await client.listTools();

    expect(client.toolListFreshness).toMatchObject({ ttlMs: 300000, cacheScope: "public" });
    expect(client.toolListFreshness.fetchedAt).toBeGreaterThanOrEqual(before);
  });

  it("leaves tool-list freshness null when the server sends no hints", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      if (body?.method === "server/discover") return modernDiscoverResult(body);
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { resultType: "complete", tools: [] },
      });
    });
    const client = new McpStreamableHttpClient({
      id: "modern",
      url: "https://mcp.example.com/mcp",
    }, { fetchImpl });

    await client.start();
    await client.listTools();

    expect(client.toolListFreshness).toBeNull();
  });

  it("declares form elicitation support and carries input responses on a retry", async () => {
    const { requests, client, lastFor } = modernServer({ tools: [{ name: "deploy" }] });
    await client.start();
    await client.callTool("deploy", { env: "prod" }, {
      inputResponses: { github_login: { action: "accept", content: { name: "octocat" } } },
      requestState: "opaque-blob",
    });

    // A server may only ask for input of a kind we declared.
    expect(requestMeta(requests[0].body)["io.modelcontextprotocol/clientCapabilities"])
      .toMatchObject({ elicitation: { form: {} } });

    const call = lastFor("tools/call").body;
    expect(call.params.name).toBe("deploy");
    expect(call.params.arguments).toEqual({ env: "prod" });
    expect(call.params.inputResponses).toEqual({
      github_login: { action: "accept", content: { name: "octocat" } },
    });
    expect(call.params.requestState).toBe("opaque-blob");
  });

  it("sends custom connector headers while preserving protocol headers", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      requests.push({ url: String(url), init, body });
      if (body?.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        });
      }
      if (body?.method === "server/discover") return legacyDiscoverRejection();
      if (body?.method === "notifications/initialized") return emptyResponse();
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [] },
      });
    });

    const client = new McpStreamableHttpClient({
      id: "private",
      url: "https://mcp.example.com/mcp",
      headers: {
        Accept: "text/plain",
        "X-API-Key": "key-123",
        Authorization: "Bearer header-token",
      },
    }, { fetchImpl });

    await client.start();
    await client.listTools();

    expect(headerValue(requests[0].init.headers, "Accept")).toBe("application/json, text/event-stream");
    expect(headerValue(requests[0].init.headers, "Content-Type")).toBe("application/json");
    expect(headerValue(requests[0].init.headers, "X-API-Key")).toBe("key-123");
    expect(headerValue(requests[0].init.headers, "Authorization")).toBe("Bearer header-token");
  });

  it("falls back to the configured bearer token when the injected OAuth token lookup is empty", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      requests.push({ url: String(url), init, body });
      if (body?.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        });
      }
      if (body?.method === "server/discover") return legacyDiscoverRejection();
      if (body?.method === "notifications/initialized") return emptyResponse();
      if (body?.method === "tools/list") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
      }
      throw new Error(`unexpected method ${body?.method}`);
    });

    const client = new McpStreamableHttpClient({
      id: "bearer",
      url: "https://mcp.example.com/mcp",
      authType: "bearer",
      authorizationToken: "static-token",
    }, {
      fetchImpl,
      getAuthToken: vi.fn(async () => ""),
    });

    await client.start();
    await client.listTools();

    expect(headerValue(requests[0].init.headers, "Authorization")).toBe("Bearer static-token");
    expect(headerValue(requests.at(-1).init.headers, "Authorization")).toBe("Bearer static-token");
  });

  it("uses explicit auth precedence: OAuth token, then static bearer token, then custom Authorization header", async () => {
    const oauthClient = new McpStreamableHttpClient({
      id: "oauth",
      url: "https://mcp.example.com/mcp",
      authType: "oauth",
      authorizationToken: "static-token",
      oauth: { accessToken: "oauth-token" },
      headers: { Authorization: "Bearer header-token" },
    }, { fetchImpl: vi.fn() });
    await expect(oauthClient._headers()).resolves.toMatchObject({
      Authorization: "Bearer oauth-token",
    });

    const bearerClient = new McpStreamableHttpClient({
      id: "bearer",
      url: "https://mcp.example.com/mcp",
      authType: "bearer",
      authorizationToken: "static-token",
      oauth: { accessToken: "oauth-token" },
      headers: { Authorization: "Bearer header-token" },
    }, { fetchImpl: vi.fn() });
    await expect(bearerClient._headers()).resolves.toMatchObject({
      Authorization: "Bearer static-token",
    });

    const headerClient = new McpStreamableHttpClient({
      id: "headers",
      url: "https://mcp.example.com/mcp",
      authType: "none",
      headers: { Authorization: "Bearer header-token" },
    }, { fetchImpl: vi.fn() });
    await expect(headerClient._headers()).resolves.toMatchObject({
      Authorization: "Bearer header-token",
    });
  });

  it("reports the effective HTTP proxy from the app proxy config and ignores connector env proxy hints", () => {
    expect(resolveMcpHttpProxyDiagnostics({
      id: "remote",
      transport: "remote",
      url: "https://mcp.example.com/mcp",
      env: { HTTPS_PROXY: "http://connector-env-proxy.example:8080" },
    }, {
      proxyConfig: { mode: "direct" } as any,
      env: { HTTPS_PROXY: "http://system-proxy.example:8080" },
    })).toMatchObject({
      applicable: true,
      proxyUrl: "",
      source: "direct",
      connectorEnvProxyIgnored: true,
    });

    expect(resolveMcpHttpProxyDiagnostics({
      id: "remote",
      transport: "remote",
      url: "https://mcp.example.com/mcp",
      env: { HTTPS_PROXY: "http://connector-env-proxy.example:8080" },
    }, {
      proxyConfig: { mode: "manual", httpsProxy: "http://app-proxy.example:8080", noProxy: "" } as any,
      env: {},
    })).toMatchObject({
      applicable: true,
      proxyUrl: "http://app-proxy.example:8080",
      source: "app",
      connectorEnvProxyIgnored: true,
    });
  });

  it("reinitializes once when a Streamable HTTP session expires", async () => {
    const requests = [];
    let initializeCount = 0;
    let expiredOnce = false;
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      requests.push({ url: String(url), init, body });
      if (body?.method === "initialize") {
        initializeCount += 1;
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        }, { headers: { "MCP-Session-Id": `session-${initializeCount}` } });
      }
      if (body?.method === "server/discover") return legacyDiscoverRejection();
      if (body?.method === "notifications/initialized") return emptyResponse();
      if (body?.method === "tools/list" && headerValue(init.headers, "MCP-Session-Id") === "session-1" && !expiredOnce) {
        expiredOnce = true;
        return jsonResponse({ error: "expired" }, { status: 404 });
      }
      if (body?.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "fresh" }] },
        });
      }
      throw new Error(`unexpected method ${body?.method}`);
    });

    const client = new McpStreamableHttpClient({
      id: "github",
      url: "https://mcp.github.com/mcp",
    }, { fetchImpl });

    await client.start();
    const tools = await client.listTools();

    expect(tools).toEqual([{ name: "fresh" }]);
    expect(initializeCount).toBe(2);
    const listRequests = requests.filter(r => r.body?.method === "tools/list");
    expect(headerValue(listRequests.at(-1).init.headers, "MCP-Session-Id")).toBe("session-2");
  });

  it("reinitializes once when a Streamable HTTP session reports Invalid session ID with status 400", async () => {
    const requests = [];
    let initializeCount = 0;
    let expiredOnce = false;
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      requests.push({ url: String(url), init, body });
      if (body?.method === "initialize") {
        initializeCount += 1;
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        }, { headers: { "MCP-Session-Id": `session-${initializeCount}` } });
      }
      if (body?.method === "server/discover") return legacyDiscoverRejection();
      if (body?.method === "notifications/initialized") return emptyResponse();
      if (body?.method === "tools/list" && headerValue(init.headers, "MCP-Session-Id") === "session-1" && !expiredOnce) {
        expiredOnce = true;
        return new Response("Invalid session ID", { status: 400 });
      }
      if (body?.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "fresh" }] },
        });
      }
      throw new Error(`unexpected method ${body?.method}`);
    });

    const client = new McpStreamableHttpClient({
      id: "github",
      url: "https://mcp.github.com/mcp",
    }, { fetchImpl });

    await client.start();
    const tools = await client.listTools();

    expect(tools).toEqual([{ name: "fresh" }]);
    expect(initializeCount).toBe(2);
    const listRequests = requests.filter(r => r.body?.method === "tools/list");
    expect(headerValue(listRequests.at(-1).init.headers, "MCP-Session-Id")).toBe("session-2");
  });

  it("uses one initial Streamable HTTP protocol version source and then negotiated headers", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      requests.push({ url: String(url), init, body });
      if (body?.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2026-01-01", capabilities: {} },
        }, { headers: { "MCP-Session-Id": "session-a" } });
      }
      if (body?.method === "server/discover") return legacyDiscoverRejection();
      if (body?.method === "notifications/initialized") return emptyResponse();
      if (body?.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [] },
        });
      }
      throw new Error(`unexpected method ${body?.method}`);
    });

    const client = new McpStreamableHttpClient({
      id: "versioned",
      url: "https://mcp.example.com/mcp",
      headers: {
        "MCP-Protocol-Version": "2024-11-05",
      },
    }, { fetchImpl });

    await client.start();
    await client.listTools();

    expect(requests[0].body.params.protocolVersion).toBe("2024-11-05");
    expect(headerValue(requests[0].init.headers, "MCP-Protocol-Version")).toBe("2024-11-05");
    expect(headerValue(requests[2].init.headers, "MCP-Protocol-Version")).toBe("2026-01-01");
  });

  it("rejects invalid Unicode in outgoing JSON-RPC payloads with a boundary diagnostic", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      requests.push({ url: String(url), init, body });
      if (body?.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        });
      }
      if (body?.method === "server/discover") return legacyDiscoverRejection();
      if (body?.method === "notifications/initialized") return emptyResponse();
      throw new Error(`unexpected method ${body?.method}`);
    });

    const client = new McpStreamableHttpClient({
      id: "metaso",
      url: "https://mcp.example.com/mcp",
    }, { fetchImpl });

    await client.start();
    await expect(client.callTool("search", { q: "\uD800" }))
      .rejects.toThrow(/invalid Unicode.*params\.arguments\.q/i);

    expect(requests.map((request) => request.body?.method)).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
    ]);
  });

  it("does not let a legacy SSE server ping with the same id satisfy a tool response", async () => {
    const encoder = new TextEncoder();
    let streamController;
    const fetchImpl = vi.fn(async (url, init: any = {}) => {
      const body = requestBody(init);
      if (init.method === "POST" && body?.method === "tools/call") {
        queueMicrotask(() => {
          streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, method: "ping", params: {} })}\n\n`));
          streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } })}\n\n`));
        });
        return emptyResponse();
      }
      throw new Error(`unexpected request ${url}`);
    });
    const client = new McpLegacySseClient({
      id: "legacy",
      url: "https://legacy.example.com/sse",
    }, { fetchImpl });
    const stream = new ReadableStream({
      start(controller) {
        streamController = controller;
      },
    });
    client.messageEndpoint = "https://legacy.example.com/messages";
    client._closed = false;
    client._handleSseEvent({
      event: "message",
      data: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    });
    client._readSse(stream).catch((err) => {
      throw err;
    });

    const result = await client.callTool("search", { q: "hana" });
    await client.stop();

    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(client._queued.size).toBe(0);
  });

  it("answers an inbound legacy SSE server request with method-not-found instead of dropping it", async () => {
    const posted = [];
    const fetchImpl = vi.fn(async (url, init: any = {}) => {
      posted.push(requestBody(init));
      return emptyResponse();
    });
    const client = new McpLegacySseClient({
      id: "legacy",
      url: "https://legacy.example.com/sse",
    }, { fetchImpl });
    client.messageEndpoint = "https://legacy.example.com/messages";
    client._closed = false;

    client._handleSseEvent({
      event: "message",
      data: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "elicitation/create", params: {} }),
    });
    await vi.waitFor(() => expect(posted.length).toBe(1));

    // A server-initiated request is not a response. It must never be filed in
    // the response queue, and leaving it unanswered strands the server waiting
    // forever — say "method not found" out loud instead.
    expect(client._queued.size).toBe(0);
    expect(posted[0]).toEqual({
      jsonrpc: "2.0",
      id: 99,
      error: { code: -32601, message: "Method not found: elicitation/create" },
    });
  });

  it("answers an inbound server request on a Streamable HTTP SSE reply stream", async () => {
    const posted = [];
    const fetchImpl = vi.fn(async (url, init: any = {}) => {
      const body = requestBody(init);
      posted.push(body);
      if (body?.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        });
      }
      if (body?.method === "server/discover") return legacyDiscoverRejection();
      if (body?.method === "notifications/initialized") return emptyResponse();
      if (body?.method === "tools/call") {
        const stream = [
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: 4242, method: "elicitation/create", params: {} })}\n\n`,
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } })}\n\n`,
        ].join("");
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return emptyResponse();
    });

    const client = new McpStreamableHttpClient({
      id: "stateful",
      url: "https://mcp.example.com/mcp",
    }, { fetchImpl });

    await client.start();
    const result = await client.callTool("search", { q: "hana" });

    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
    await vi.waitFor(() => {
      expect(posted.some((body) => body?.error?.code === -32601)).toBe(true);
    });
    expect(posted.find((body) => body?.error)).toEqual({
      jsonrpc: "2.0",
      id: 4242,
      error: { code: -32601, message: "Method not found: elicitation/create" },
    });
  });

  it("resets running to false and reports an unexpected close when the SSE stream ends", async () => {
    const onClose = vi.fn();
    const fetchImpl = vi.fn(async () => emptyResponse());
    const client = new McpLegacySseClient({
      id: "legacy",
      url: "https://legacy.example.com/sse",
    }, { fetchImpl, onClose });

    // Simulate an established SSE session.
    client.messageEndpoint = "https://legacy.example.com/messages";
    client._closed = false;
    expect(client.running).toBe(true);

    // The remote silently closes the stream: reader returns done immediately.
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    await client._readSse(stream);

    // :288 stale-positive must be gone — a finished stream is not "running".
    expect(client.running).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ expected: false }));
  });

  it("reports an unexpected close when legacy SSE message POST says Invalid session ID", async () => {
    const onClose = vi.fn();
    const fetchImpl = vi.fn(async () => new Response("Invalid session ID", { status: 400 }));
    const client = new McpLegacySseClient({
      id: "legacy",
      url: "https://legacy.example.com/sse",
    }, { fetchImpl, onClose });

    client.messageEndpoint = "https://legacy.example.com/messages";
    client._closed = false;

    await expect(client.callTool("search", { q: "hana" })).rejects.toThrow(/Invalid session ID/i);

    expect(client.running).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({
      expected: false,
      needsAuth: false,
    }));
  });

  it("does not report an unexpected close after the SSE stream ends due to stop()", async () => {
    const onClose = vi.fn();
    const fetchImpl = vi.fn(async () => emptyResponse());
    const client = new McpLegacySseClient({
      id: "legacy",
      url: "https://legacy.example.com/sse",
    }, { fetchImpl, onClose });

    client.messageEndpoint = "https://legacy.example.com/messages";
    client._closed = false;

    // stop() flips _closed true and aborts; the subsequent stream end is expected.
    await client.stop();
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    await client._readSse(stream);

    const unexpectedCalls = onClose.mock.calls.filter(([info]) => info && info.expected === false);
    expect(unexpectedCalls).toHaveLength(0);
  });

  it("reports an unexpected close when a Streamable HTTP request hits a 5xx", async () => {
    const onClose = vi.fn();
    let initialized = false;
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      if (body?.method === "initialize") {
        initialized = true;
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        }, { headers: { "MCP-Session-Id": "session-a" } });
      }
      if (body?.method === "server/discover") return legacyDiscoverRejection();
      if (body?.method === "notifications/initialized") return emptyResponse();
      if (body?.method === "tools/list" && initialized) {
        return jsonResponse({ error: "boom" }, { status: 503 });
      }
      throw new Error(`unexpected method ${body?.method}`);
    });

    const client = new McpStreamableHttpClient({
      id: "github",
      url: "https://mcp.github.com/mcp",
    }, { fetchImpl, onClose });

    await client.start();
    await expect(client.listTools()).rejects.toThrow();

    // A 5xx kills the live session; the runtime must learn about it to reconnect.
    expect(client.running).toBe(false);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ expected: false }));
  });

  it("marks a Streamable HTTP 401 as needs-auth without a bare rethrow swallowing context", async () => {
    const onClose = vi.fn();
    let initialized = false;
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      if (body?.method === "initialize") {
        initialized = true;
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        }, { headers: { "MCP-Session-Id": "session-a" } });
      }
      if (body?.method === "server/discover") return legacyDiscoverRejection();
      if (body?.method === "notifications/initialized") return emptyResponse();
      if (body?.method === "tools/list" && initialized) {
        return jsonResponse({ error: "unauthorized" }, { status: 401 });
      }
      throw new Error(`unexpected method ${body?.method}`);
    });

    const client = new McpStreamableHttpClient({
      id: "github",
      url: "https://mcp.github.com/mcp",
    }, { fetchImpl, onClose });

    await client.start();
    await expect(client.listTools()).rejects.toThrow();

    // 401 surfaces as an auth-needed close (stage 3 OAuth self-heal will consume this).
    expect(client.running).toBe(false);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ expected: false, needsAuth: true }));
  });

  it("does not report an unexpected close on the inline 404 session refresh path", async () => {
    const onClose = vi.fn();
    let initializeCount = 0;
    let expiredOnce = false;
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      if (body?.method === "initialize") {
        initializeCount += 1;
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        }, { headers: { "MCP-Session-Id": `session-${initializeCount}` } });
      }
      if (body?.method === "server/discover") return legacyDiscoverRejection();
      if (body?.method === "notifications/initialized") return emptyResponse();
      if (body?.method === "tools/list" && headerValue(init.headers, "MCP-Session-Id") === "session-1" && !expiredOnce) {
        expiredOnce = true;
        return jsonResponse({ error: "expired" }, { status: 404 });
      }
      if (body?.method === "tools/list") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
      }
      throw new Error(`unexpected method ${body?.method}`);
    });

    const client = new McpStreamableHttpClient({
      id: "github",
      url: "https://mcp.github.com/mcp",
    }, { fetchImpl, onClose });

    await client.start();
    await client.listTools();

    // The 404 self-heal re-initializes in place; it is NOT a connection death.
    const unexpectedCalls = onClose.mock.calls.filter(([info]) => info && info.expected === false);
    expect(unexpectedCalls).toHaveLength(0);
    expect(client.running).toBe(true);
  });

  it("falls back from Streamable HTTP to legacy SSE endpoint transport", async () => {
    const requests = [];
    const encoder = new TextEncoder();
    let sseController;

    function sendSse(event, data) {
      sseController.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
    }

    const fetchImpl = vi.fn(async (url, init: any = {}) => {
      const body = requestBody(init);
      requests.push({ url: String(url), init, body });
      if (init.method === "GET") {
        const stream = new ReadableStream({
          start(controller) {
            sseController = controller;
            queueMicrotask(() => sendSse("endpoint", "/messages"));
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (body?.method === "server/discover") return legacyDiscoverRejection();
      if (String(url) === "https://legacy.example.com/sse" && body?.method === "initialize") {
        return jsonResponse({ error: "not found" }, { status: 404 });
      }
      if (String(url) === "https://legacy.example.com/messages") {
        if (body?.id != null) {
          queueMicrotask(() => {
            const result = body.method === "tools/list"
              ? { tools: [{ name: "legacy-search" }] }
              : { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} };
            sendSse("message", JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
          });
        }
        return emptyResponse();
      }
      throw new Error(`unexpected request ${url}`);
    });

    const client = new McpAutoHttpClient({
      id: "legacy",
      url: "https://legacy.example.com/sse",
    }, { fetchImpl });

    await client.start();
    const tools = await client.listTools();
    await client.stop();

    expect(tools).toEqual([{ name: "legacy-search" }]);
    expect(requests.map(r => `${r.init.method || "POST"} ${r.url}`)).toContain("GET https://legacy.example.com/sse");
    expect(requests.map(r => r.url)).toContain("https://legacy.example.com/messages");
  });

  it("forwards onClose through McpAutoHttpClient to its chosen inner transport", async () => {
    const onClose = vi.fn();
    let initialized = false;
    const fetchImpl = vi.fn(async (url, init) => {
      const body = requestBody(init);
      if (body?.method === "initialize") {
        initialized = true;
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        }, { headers: { "MCP-Session-Id": "session-a" } });
      }
      if (body?.method === "server/discover") return legacyDiscoverRejection();
      if (body?.method === "notifications/initialized") return emptyResponse();
      if (body?.method === "tools/call" && initialized) {
        return jsonResponse({ error: "gateway down" }, { status: 502 });
      }
      throw new Error(`unexpected method ${body?.method}`);
    });

    const client = new McpAutoHttpClient({
      id: "auto",
      url: "https://mcp.example.com/mcp",
    }, { fetchImpl, onClose });

    await client.start();
    await expect(client.callTool("ping", {})).rejects.toThrow();

    // The wrapper must propagate the inner transport's unexpected-close report
    // so the runtime can reconnect the auto-detected connector.
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ expected: false }));
  });
});

// #1286 ③a — 401 self-heal (方案 A: per-request closed loop). The live client
// snapshots the connector, so a refresh written to config never reaches it. The
// runtime injects getAuthToken (pre-request fresh token) and refreshAuthToken
// (force refresh on 401); the client retries the failed request exactly once.
describe("MCP Streamable HTTP OAuth self-heal", () => {
  function streamableInitResponder(extra) {
    return (url, init) => {
      const body = requestBody(init);
      if (body?.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        }, { headers: { "MCP-Session-Id": "session-a" } });
      }
      if (body?.method === "server/discover") return legacyDiscoverRejection();
      if (body?.method === "notifications/initialized") return emptyResponse();
      return extra(body, init);
    };
  }

  it("uses the injected getAuthToken for the Authorization header instead of the snapshot", async () => {
    const requests = [];
    const fetchImpl = vi.fn(streamableInitResponder((body, init) => {
      requests.push({ body, init });
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    }));
    const getAuthToken = vi.fn(async () => "fresh-token");

    const client = new McpStreamableHttpClient({
      id: "github",
      url: "https://mcp.github.com/mcp",
      oauth: { accessToken: "stale-snapshot-token" },
    }, { fetchImpl, getAuthToken });

    await client.start();
    await client.listTools();

    // Every request carried the callback's token, never the stale snapshot.
    expect(getAuthToken).toHaveBeenCalled();
    const listReq = requests.find((r) => r.body?.method === "tools/list");
    expect(headerValue(listReq.init.headers, "Authorization")).toBe("Bearer fresh-token");
  });

  it("retries a 401 once after a successful forced refresh, then succeeds", async () => {
    let tokenInUse = "stale-token";
    const seenAuth = [];
    const fetchImpl = vi.fn(streamableInitResponder((body, init) => {
      if (body?.method === "tools/list") {
        seenAuth.push(headerValue(init.headers, "Authorization"));
        if (headerValue(init.headers, "Authorization") === "Bearer stale-token") {
          return jsonResponse({ error: "unauthorized" }, { status: 401 });
        }
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "ok" }] } });
      }
      throw new Error(`unexpected method ${body?.method}`);
    }));
    const getAuthToken = vi.fn(async () => tokenInUse);
    const refreshAuthToken = vi.fn(async () => {
      tokenInUse = "refreshed-token";
      return tokenInUse;
    });
    const onClose = vi.fn();

    const client = new McpStreamableHttpClient({
      id: "github",
      url: "https://mcp.github.com/mcp",
    }, { fetchImpl, getAuthToken, refreshAuthToken, onClose });

    await client.start();
    const tools = await client.listTools();

    expect(tools).toEqual([{ name: "ok" }]);
    expect(refreshAuthToken).toHaveBeenCalledTimes(1);
    // First attempt with stale token (401), retry with refreshed token (200).
    expect(seenAuth).toEqual(["Bearer stale-token", "Bearer refreshed-token"]);
    // The session survived — a recovered 401 must NOT tear the client down.
    expect(client.running).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("retries at most once: a second 401 after refresh fails the session as needs-auth", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(streamableInitResponder((body) => {
      if (body?.method === "tools/list") {
        attempts += 1;
        return jsonResponse({ error: "unauthorized" }, { status: 401 });
      }
      throw new Error(`unexpected method ${body?.method}`);
    }));
    const refreshAuthToken = vi.fn(async () => "refreshed-but-still-bad");
    const onClose = vi.fn();

    const client = new McpStreamableHttpClient({
      id: "github",
      url: "https://mcp.github.com/mcp",
    }, { fetchImpl, getAuthToken: async () => "tok", refreshAuthToken, onClose });

    await client.start();
    await expect(client.listTools()).rejects.toThrow();

    // Exactly two tool requests: original + one retry. No loop.
    expect(attempts).toBe(2);
    expect(refreshAuthToken).toHaveBeenCalledTimes(1);
    expect(client.running).toBe(false);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ expected: false, needsAuth: true }));
  });

  it("does not retry a 401 when no refresh is possible", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(streamableInitResponder((body) => {
      if (body?.method === "tools/list") {
        attempts += 1;
        return jsonResponse({ error: "unauthorized" }, { status: 401 });
      }
      throw new Error(`unexpected method ${body?.method}`);
    }));
    // refreshAuthToken returns "" → refresh impossible (no refresh token).
    const refreshAuthToken = vi.fn(async () => "");
    const onClose = vi.fn();

    const client = new McpStreamableHttpClient({
      id: "github",
      url: "https://mcp.github.com/mcp",
    }, { fetchImpl, getAuthToken: async () => "tok", refreshAuthToken, onClose });

    await client.start();
    await expect(client.listTools()).rejects.toThrow();

    expect(attempts).toBe(1);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ expected: false, needsAuth: true }));
  });

  // #1286 ③a I1: the refresh ITSELF fails because the refresh token is dead
  // (invalid_grant). The forced refresh throws an McpHttpError(400, invalid_grant);
  // that auth-terminal error must close the session as needs-auth — NOT a generic
  // close that the runtime would back off and reconnect (re-hammering the AS).
  it("fails as needs-auth when the forced refresh itself dies with invalid_grant", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(streamableInitResponder((body) => {
      if (body?.method === "tools/list") {
        attempts += 1;
        return jsonResponse({ error: "unauthorized" }, { status: 401 });
      }
      throw new Error(`unexpected method ${body?.method}`);
    }));
    // The refresh token is also dead: the token endpoint returns 400 invalid_grant.
    const refreshAuthToken = vi.fn(async () => {
      throw new McpHttpError("OAuth token refresh failed: refresh token expired", {
        status: 400,
        oauthError: "invalid_grant",
      });
    });
    const onClose = vi.fn();

    const client = new McpStreamableHttpClient({
      id: "github",
      url: "https://mcp.github.com/mcp",
    }, { fetchImpl, getAuthToken: async () => "tok", refreshAuthToken, onClose });

    await client.start();
    await expect(client.listTools()).rejects.toThrow();

    // No retry happened (refresh failed before replay), and the dead refresh token
    // is terminal → needs-auth, so the runtime re-auths instead of backing off.
    expect(attempts).toBe(1);
    expect(refreshAuthToken).toHaveBeenCalledTimes(1);
    expect(client.running).toBe(false);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ expected: false, needsAuth: true }));
  });

  // #1286 ③a I1 (counter-case): a TRANSIENT refresh failure (token endpoint 5xx,
  // refresh token still valid) must NOT be classified needs-auth — it is generic
  // so the runtime keeps backoff reconnect rather than forcing the user to re-auth.
  it("fails as a generic (non-auth) close when the forced refresh hits a transient 5xx", async () => {
    const fetchImpl = vi.fn(streamableInitResponder((body) => {
      if (body?.method === "tools/list") {
        return jsonResponse({ error: "unauthorized" }, { status: 401 });
      }
      throw new Error(`unexpected method ${body?.method}`);
    }));
    const refreshAuthToken = vi.fn(async () => {
      throw new McpHttpError("OAuth token refresh failed with status 503", { status: 503, oauthError: "" });
    });
    const onClose = vi.fn();

    const client = new McpStreamableHttpClient({
      id: "github",
      url: "https://mcp.github.com/mcp",
    }, { fetchImpl, getAuthToken: async () => "tok", refreshAuthToken, onClose });

    await client.start();
    await expect(client.listTools()).rejects.toThrow();

    expect(client.running).toBe(false);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ expected: false, needsAuth: false }));
  });
});

describe("MCP legacy SSE OAuth self-heal", () => {
  it("uses the injected getAuthToken for the Authorization header on posted messages", async () => {
    const posts = [];
    const getAuthToken = vi.fn(async () => "fresh-token");
    const fetchImpl = vi.fn(async (url, init: any = {}) => {
      const body = requestBody(init);
      if (init.method === "POST") {
        posts.push({ body, init });
        queueMicrotask(() => {
          streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } })}\n\n`));
        });
        return emptyResponse();
      }
      throw new Error(`unexpected request ${url}`);
    });
    const encoder = new TextEncoder();
    let streamController;
    const stream = new ReadableStream({ start(controller) { streamController = controller; } });

    const client = new McpLegacySseClient({
      id: "legacy",
      url: "https://legacy.example.com/sse",
      oauth: { accessToken: "stale-snapshot-token" },
    }, { fetchImpl, getAuthToken });
    client.messageEndpoint = "https://legacy.example.com/messages";
    client._closed = false;
    client._readSse(stream).catch(() => {});

    await client.request("tools/list", {});
    await client.stop();

    expect(getAuthToken).toHaveBeenCalled();
    expect(headerValue(posts[0].init.headers, "Authorization")).toBe("Bearer fresh-token");
  });

  it("retries a legacy SSE 401 once after a forced refresh, then succeeds", async () => {
    let tokenInUse = "stale-token";
    const seenAuth = [];
    const encoder = new TextEncoder();
    let streamController;
    const stream = new ReadableStream({ start(controller) { streamController = controller; } });
    const fetchImpl = vi.fn(async (url, init: any = {}) => {
      const body = requestBody(init);
      if (init.method === "POST") {
        seenAuth.push(headerValue(init.headers, "Authorization"));
        if (headerValue(init.headers, "Authorization") === "Bearer stale-token") {
          return jsonResponse({ error: "unauthorized" }, { status: 401 });
        }
        queueMicrotask(() => {
          streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "ok" }] } })}\n\n`));
        });
        return emptyResponse();
      }
      throw new Error(`unexpected request ${url}`);
    });
    const getAuthToken = vi.fn(async () => tokenInUse);
    const refreshAuthToken = vi.fn(async () => { tokenInUse = "refreshed-token"; return tokenInUse; });

    const client = new McpLegacySseClient({
      id: "legacy",
      url: "https://legacy.example.com/sse",
    }, { fetchImpl, getAuthToken, refreshAuthToken });
    client.messageEndpoint = "https://legacy.example.com/messages";
    client._closed = false;
    client._readSse(stream).catch(() => {});

    const tools = await client.request("tools/list", {});
    await client.stop();

    expect(tools).toEqual({ tools: [{ name: "ok" }] });
    expect(refreshAuthToken).toHaveBeenCalledTimes(1);
    expect(seenAuth).toEqual(["Bearer stale-token", "Bearer refreshed-token"]);
  });
});
