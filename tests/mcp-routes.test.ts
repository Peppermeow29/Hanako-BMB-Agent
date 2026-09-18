/**
 * MCP is a first-class core module, so its HTTP surface lives at /api/mcp.
 * The historical /api/plugins/mcp paths stay mounted as an alias: installed
 * clients and any saved OAuth redirect URIs still point at them.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createMcpRoute } from "../server/routes/mcp.ts";
import { createPluginProxyRoute } from "../server/routes/plugins.ts";

function createApp(mcp) {
  const app = new Hono();
  app.route("/api", createMcpRoute({ mcp } as any));
  return app;
}

function fakeMcp(overrides: any = {}) {
  return {
    getState: vi.fn(() => ({ enabled: true, connectors: [], servers: [] })),
    getAgentConfig: vi.fn(async () => ({})),
    setEnabled: vi.fn(async () => ({ enabled: true, connectors: [] })),
    completeOAuth: vi.fn(async () => ({ status: "done" })),
    getOAuthStatus: vi.fn(() => ({ status: "pending" })),
    autoStartAfterAdd: vi.fn(async () => {}),
    setConnectorEnabled: vi.fn(async () => ({})),
    startConnector: vi.fn(async () => {}),
    stopConnector: vi.fn(async () => {}),
    startOAuth: vi.fn(async () => ({ sessionId: "s1", url: "https://auth.example.com/authorize" })),
    listApps: vi.fn(() => []),
    readResource: vi.fn(async () => ({ contents: [] })),
    callAppTool: vi.fn(async () => ({ content: [] })),
    ...overrides,
  };
}

describe("MCP first-class routes", () => {
  it("serves runtime state at /api/mcp/state", async () => {
    const mcp = fakeMcp();
    const res = await createApp(mcp).request("/api/mcp/state");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, connectors: [] });
  });

  it("serves the same state through the legacy /api/plugins/mcp alias", async () => {
    const mcp = fakeMcp();
    const app = createApp(mcp);

    const [primary, alias] = await Promise.all([
      app.request("/api/mcp/state"),
      app.request("/api/plugins/mcp/state"),
    ]);

    expect(alias.status).toBe(200);
    expect(await alias.json()).toEqual(await primary.json());
  });

  it("applies a global enable through /api/mcp/settings/enabled", async () => {
    const mcp = fakeMcp();
    const res = await createApp(mcp).request("/api/mcp/settings/enabled", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(200);
    expect(mcp.setEnabled).toHaveBeenCalledWith(true);
  });

  it("accepts the OAuth callback on both the first-class and legacy paths", async () => {
    const mcp = fakeMcp();
    const app = createApp(mcp);

    for (const routePath of ["/api/mcp/oauth/callback", "/api/plugins/mcp/oauth/callback"]) {
      const res = await app.request(`${routePath}?state=st_1&code=code_1`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Connector connected");
    }

    expect(mcp.completeOAuth).toHaveBeenCalledTimes(2);
  });

  it("hands the connector the first-class callback URL when starting OAuth", async () => {
    const mcp = fakeMcp();
    const res = await createApp(mcp).request("/api/mcp/connectors/github/oauth/start", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(mcp.startOAuth).toHaveBeenCalledWith(
      "github",
      expect.stringContaining("/api/mcp/oauth/callback"),
    );
  });

  it("keeps the historical servers aliases working", async () => {
    const mcp = fakeMcp();
    const app = createApp(mcp);

    const res = await app.request("/api/mcp/servers/github/oauth/start", { method: "POST" });

    expect(res.status).toBe(200);
    expect(mcp.startOAuth).toHaveBeenCalled();
  });

  it("records the user's intent before touching the transport on start and stop", async () => {
    const order: string[] = [];
    const mcp = fakeMcp({
      setConnectorEnabled: vi.fn(async (_id, enabled) => { order.push(`persist:${enabled}`); }),
      startConnector: vi.fn(async () => { order.push("start"); }),
      stopConnector: vi.fn(async () => { order.push("stop"); }),
    });
    const app = createApp(mcp);

    await app.request("/api/mcp/connectors/github/start", { method: "POST" });
    await app.request("/api/mcp/connectors/github/stop", { method: "POST" });

    // Written first, so a connector that fails to come up right now is still
    // wanted at the next launch.
    expect(order).toEqual(["persist:true", "start", "persist:false", "stop"]);
    expect(mcp.setConnectorEnabled).toHaveBeenNthCalledWith(1, "github", true);
    expect(mcp.setConnectorEnabled).toHaveBeenNthCalledWith(2, "github", false);
  });

  it("reports an unknown connector id on stop instead of silently succeeding", async () => {
    const mcp = fakeMcp({
      setConnectorEnabled: vi.fn(async () => { throw new Error('MCP connector "ghost" not found'); }),
      stopConnector: vi.fn(async () => {}),
    });

    const res = await createApp(mcp).request("/api/mcp/connectors/ghost/stop", { method: "POST" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'MCP connector "ghost" not found' });
    expect(mcp.stopConnector).not.toHaveBeenCalled();
  });

  it("wins over the generic plugin proxy for the legacy alias path", async () => {
    // open-root mounts createMcpRoute ahead of the plugin routes. If that order
    // ever flips, /api/plugins/mcp/* falls through to a plugin lookup that no
    // longer has an "mcp" entry, and every legacy client 404s.
    const mcp = fakeMcp();
    const app = new Hono();
    app.route("/api", createMcpRoute({ mcp } as any));
    app.route("/api", createPluginProxyRoute(new Map()));

    const res = await app.request("/api/plugins/mcp/state");

    expect(res.status).toBe(200);
    expect(mcp.getState).toHaveBeenCalled();
  });

  it("serves an app's ui:// resource with the connector's own mime type", async () => {
    const mcp = fakeMcp({
      readResource: vi.fn(async () => ({
        contents: [{ uri: "ui://board/main", mimeType: "text/html", text: "<h1>board</h1>" }],
      })),
    });

    const res = await createApp(mcp).request(
      `/api/mcp/connectors/acme/resources?uri=${encodeURIComponent("ui://board/main")}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<h1>board</h1>");
  });

  it("rejects a resource read outside the ui:// scheme with 400", async () => {
    const mcp = fakeMcp({
      readResource: vi.fn(async () => {
        throw new Error("MCP app resource uri must start with ui://");
      }),
    });

    const res = await createApp(mcp).request(
      `/api/mcp/connectors/acme/resources?uri=${encodeURIComponent("https://evil.test/steal")}`,
    );

    expect(res.status).toBe(400);
  });

  it("maps an app-visibility refusal to 403", async () => {
    const mcp = fakeMcp({
      callAppTool: vi.fn(async () => {
        throw new Error('MCP connector tool "acme/private" is not visible to apps');
      }),
    });

    const res = await createApp(mcp).request("/api/mcp/connectors/acme/app-tools/private/call", {
      method: "POST",
    });

    expect(res.status).toBe(403);
  });

  // A connector the user switched off is a conflict with the current state of
  // the system, the same kind of answer "not running" and "disabled globally"
  // already give. It is emphatically not a bad gateway: nothing upstream failed,
  // and the fix is a switch in Settings the user themselves flipped.
  it("answers 409 and passes the wording through when a resource read hits a switched-off connector", async () => {
    const message = 'MCP connector "acme" is disabled; enable it in Settings → MCP to use this tool';
    const mcp = fakeMcp({
      readResource: vi.fn(async () => { throw new Error(message); }),
    });

    const res = await createApp(mcp).request(
      `/api/mcp/connectors/acme/resources?uri=${encodeURIComponent("ui://board/main")}`,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: message });
  });

  it("answers 409 and passes the wording through when an app tool call hits a switched-off connector", async () => {
    const message = 'MCP connector "acme" is disabled; enable it in Settings → MCP to use this tool';
    const mcp = fakeMcp({
      callAppTool: vi.fn(async () => { throw new Error(message); }),
    });

    const res = await createApp(mcp).request("/api/mcp/connectors/acme/app-tools/board/call", {
      method: "POST",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: message });
  });

  it("answers 409 for the connector-start wording of the same refusal", async () => {
    // The refusal is worded per entry point ("to use this tool" when something
    // needs the connector, "before starting" when a start is refused outright).
    // Both name the same user-flipped switch, so both get the same status.
    const message = 'MCP connector "acme" is disabled; enable it in Settings → MCP before starting';
    const mcp = fakeMcp({
      readResource: vi.fn(async () => { throw new Error(message); }),
    });

    const res = await createApp(mcp).request(
      `/api/mcp/connectors/acme/resources?uri=${encodeURIComponent("ui://board/main")}`,
    );

    expect(res.status).toBe(409);
  });

  it("reports 503 while the manager is not initialized", async () => {
    const app = new Hono();
    app.route("/api", createMcpRoute({ mcp: null } as any));

    const res = await app.request("/api/mcp/state");
    expect(res.status).toBe(503);
  });

  describe("session-scoped permission grants", () => {
    function createSessionApp(overrides: any = {}) {
      const allowSessionInvocationCapability = overrides.allowSessionInvocationCapability
        || vi.fn((ref, capability) => ({ ok: true, sessionId: ref.sessionId, capability }));
      const engine = {
        mcp: fakeMcp(),
        getSessionManifest: overrides.getSessionManifest
          || vi.fn((sessionId) => (sessionId === "sess_1"
            ? { sessionId, currentLocator: { path: "/agents/owner/sessions/a.jsonl" } }
            : null)),
        allowSessionInvocationCapability,
      };
      const app = new Hono();
      app.route("/api", createMcpRoute(engine as any));
      return { app, engine, allowSessionInvocationCapability };
    }

    function post(app, body) {
      return app.request("/api/mcp/session-permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("grants a capability to the addressed session", async () => {
      const { app, allowSessionInvocationCapability } = createSessionApp();

      const res = await post(app, { sessionId: "sess_1", capability: "mcp_acme_search.invoke" });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, capability: "mcp_acme_search.invoke" });
      // The session is addressed by identity, and the resolved locator rides
      // along so the coordinator never has to re-derive it.
      expect(allowSessionInvocationCapability).toHaveBeenCalledWith(
        { sessionId: "sess_1", sessionPath: "/agents/owner/sessions/a.jsonl" },
        "mcp_acme_search.invoke",
      );
    });

    it("is reachable through the legacy alias", async () => {
      const { app } = createSessionApp();
      const res = await app.request("/api/plugins/mcp/session-permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "sess_1", capability: "mcp_acme_search.invoke" }),
      });
      expect(res.status).toBe(200);
    });

    it("rejects a request missing either field", async () => {
      const { app, allowSessionInvocationCapability } = createSessionApp();

      expect((await post(app, { capability: "mcp_acme_search.invoke" })).status).toBe(400);
      expect((await post(app, { sessionId: "sess_1" })).status).toBe(400);
      expect((await post(app, { sessionId: "sess_1", capability: "   " })).status).toBe(400);
      expect(allowSessionInvocationCapability).not.toHaveBeenCalled();
    });

    it("reports an unknown session as not found rather than granting", async () => {
      const { app, allowSessionInvocationCapability } = createSessionApp();

      const res = await post(app, { sessionId: "sess_missing", capability: "mcp_acme_search.invoke" });

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "session_manifest_not_found" });
      expect(allowSessionInvocationCapability).not.toHaveBeenCalled();
    });

    it("surfaces the coordinator's status for an unloaded session", async () => {
      const { app } = createSessionApp({
        allowSessionInvocationCapability: vi.fn(() => {
          const error: any = new Error("allow invocation capability: session runtime is not loaded");
          error.code = "session_not_loaded";
          error.status = 409;
          throw error;
        }),
      });

      const res = await post(app, { sessionId: "sess_1", capability: "mcp_acme_search.invoke" });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "session_not_loaded" });
    });
  });

  describe("bulk connector import", () => {
    function postBulk(app, body, routePath = "/api/mcp/connectors/bulk") {
      return app.request(routePath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("writes every connector and reports one result per item", async () => {
      const mcp = fakeMcp({
        addConnectors: vi.fn(() => [
          { ok: true, id: "alpha" },
          { ok: true, id: "beta" },
        ]),
      });

      const res = await postBulk(createApp(mcp), {
        connectors: [
          { name: "alpha", transport: "remote", url: "https://a.example.com/mcp" },
          { name: "beta", transport: "stdio", command: "npx" },
        ],
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        results: [{ ok: true, id: "alpha" }, { ok: true, id: "beta" }],
      });
      expect(mcp.addConnectors).toHaveBeenCalledTimes(1);
    });

    it("rejects the whole batch without writing when any item fails validation", async () => {
      const mcp = fakeMcp({
        addConnectors: vi.fn(() => {
          const error: any = new Error("connector 2: url is required");
          error.results = [{ ok: true }, { ok: false, error: "url is required" }];
          throw error;
        }),
      });

      const res = await postBulk(createApp(mcp), {
        connectors: [
          { name: "alpha", transport: "remote", url: "https://a.example.com/mcp" },
          { name: "beta", transport: "remote" },
        ],
      });

      expect(res.status).toBe(400);
      // The caller still learns which item was at fault, so the preview list can
      // mark exactly the offending row rather than failing anonymously.
      expect(await res.json()).toMatchObject({
        results: [{ ok: true }, { ok: false, error: "url is required" }],
      });
    });

    it("rejects a body without a connectors array", async () => {
      const mcp = fakeMcp({ addConnectors: vi.fn() });

      const res = await postBulk(createApp(mcp), { connectors: "nope" });

      expect(res.status).toBe(400);
      expect(mcp.addConnectors).not.toHaveBeenCalled();
    });

    it("is reachable through the legacy alias", async () => {
      const mcp = fakeMcp({ addConnectors: vi.fn(() => [{ ok: true, id: "alpha" }]) });

      const res = await postBulk(
        createApp(mcp),
        { connectors: [{ name: "alpha", transport: "stdio", command: "npx" }] },
        "/api/plugins/mcp/connectors/bulk",
      );

      expect(res.status).toBe(200);
    });
  });

  describe("cancellable OAuth waits", () => {
    it("cancels the connector's pending OAuth session", async () => {
      const mcp = fakeMcp({ cancelOAuth: vi.fn(() => ({ cancelled: 1 })) });

      const res = await createApp(mcp).request("/api/mcp/connectors/github/oauth/cancel", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(mcp.cancelOAuth).toHaveBeenCalledWith("github");
    });

    it("is reachable through the legacy and servers aliases", async () => {
      const mcp = fakeMcp({ cancelOAuth: vi.fn(() => ({ cancelled: 0 })) });
      const app = createApp(mcp);

      for (const routePath of [
        "/api/mcp/servers/github/oauth/cancel",
        "/api/plugins/mcp/connectors/github/oauth/cancel",
      ]) {
        expect((await app.request(routePath, { method: "POST" })).status).toBe(200);
      }
    });

    it("reports a cancelled wait through the existing poll endpoint", async () => {
      const mcp = fakeMcp({ getOAuthStatus: vi.fn(() => ({ status: "cancelled" })) });

      const res = await createApp(mcp).request("/api/mcp/oauth/poll/s1");

      expect(await res.json()).toMatchObject({ status: "cancelled" });
    });
  });

  describe("deferred loading settings", () => {
    it("persists the defer switch and threshold", async () => {
      const mcp = fakeMcp({
        setDeferSettings: vi.fn(async () => ({ enabled: true, connectors: [] })),
      });

      const res = await createApp(mcp).request("/api/mcp/settings/defer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deferEnabled: false, deferThreshold: 25 }),
      });

      expect(res.status).toBe(200);
      expect(mcp.setDeferSettings).toHaveBeenCalledWith({ deferEnabled: false, deferThreshold: 25 });
    });

    it("routes the built-in defer switch to preferences and reflects it in state", async () => {
      const setBuiltinToolDeferEnabled = vi.fn();
      const getBuiltinToolDeferEnabled = vi.fn(() => true);
      const mcp = fakeMcp({ setDeferSettings: vi.fn() });
      const app = new Hono();
      app.route("/api", createMcpRoute({
        mcp,
        preferences: { setBuiltinToolDeferEnabled, getBuiltinToolDeferEnabled },
      } as any));

      const res = await app.request("/api/mcp/settings/defer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ builtinDeferEnabled: true }),
      });

      expect(res.status).toBe(200);
      expect(setBuiltinToolDeferEnabled).toHaveBeenCalledWith(true);
      // The pure-preferences patch must not disturb the mcp config store.
      expect(mcp.setDeferSettings).not.toHaveBeenCalled();
      expect(await res.json()).toMatchObject({ builtinDeferEnabled: true });
    });

    it("rejects a non-boolean built-in defer flag", async () => {
      const setBuiltinToolDeferEnabled = vi.fn();
      const app = new Hono();
      app.route("/api", createMcpRoute({
        mcp: fakeMcp({ setDeferSettings: vi.fn() }),
        preferences: { setBuiltinToolDeferEnabled, getBuiltinToolDeferEnabled: vi.fn(() => false) },
      } as any));

      const res = await app.request("/api/mcp/settings/defer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ builtinDeferEnabled: "yes" }),
      });

      expect(res.status).toBe(400);
      expect(setBuiltinToolDeferEnabled).not.toHaveBeenCalled();
    });

    it("rejects a threshold that is not a positive integer", async () => {
      const mcp = fakeMcp({ setDeferSettings: vi.fn() });

      const res = await createApp(mcp).request("/api/mcp/settings/defer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deferThreshold: 0 }),
      });

      expect(res.status).toBe(400);
      expect(mcp.setDeferSettings).not.toHaveBeenCalled();
    });
  });
});
