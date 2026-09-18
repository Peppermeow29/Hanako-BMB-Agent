import { describe, it, expect, vi } from "vitest";
import { createPluginContext } from "../core/plugin-context.ts";

async function makeBus() {
  const { EventBus } = await import("../hub/event-bus.ts");
  return new EventBus();
}

describe("createPluginContext", () => {
  it("returns ctx with all required properties", () => {
    const bus = { emit() {}, subscribe() {}, request() {}, hasHandler() {} };
    const ctx = createPluginContext({
      pluginId: "test-plugin",
      pluginDir: "/plugins/test-plugin",
      dataDir: "/plugin-data/test-plugin",
      bus,
    } as any);
    expect(ctx.pluginId).toBe("test-plugin");
    expect(ctx.pluginDir).toBe("/plugins/test-plugin");
    expect(ctx.dataDir).toBe("/plugin-data/test-plugin");
    expect(ctx.bus).toBeDefined();
    expect(typeof ctx.bus.emit).toBe("function");
    expect(ctx.log).toBeDefined();
    expect(ctx.config).toBeDefined();
    expect(typeof ctx.config.get).toBe("function");
    expect(typeof ctx.config.set).toBe("function");
  });

  it("exposes declared ordinary and sensitive capabilities on ctx", () => {
    const bus = { emit() {}, subscribe() {}, request() {}, hasHandler() {} };
    const ctx = createPluginContext({
      pluginId: "cap-plugin",
      pluginDir: "/plugins/cap-plugin",
      dataDir: "/plugin-data/cap-plugin",
      bus,
      capabilities: ["session", "agent", "session"],
      sensitiveCapabilities: ["filesystem.write"],
    } as any);

    expect(ctx.capabilities).toEqual(["session", "agent"]);
    expect(ctx.sensitiveCapabilities).toEqual(["filesystem.write"]);
  });

  it("exposes a controlled app event emitter", () => {
    const bus = { emit: vi.fn(), subscribe() {}, request() {}, hasHandler() {} };
    const ctx = createPluginContext({
      pluginId: "cover-plugin",
      pluginDir: "/plugins/cover-plugin",
      dataDir: "/plugin-data/cover-plugin",
      bus,
    } as any);

    expect(ctx.appEvents.emit("models-changed", { agentId: "agent-1" })).toBe(true);
    expect(ctx.appEvents.emit("bad", "payload")).toBe(false);
    expect(bus.emit).toHaveBeenCalledOnce();
    expect(bus.emit).toHaveBeenCalledWith({
      type: "app_event",
      event: {
        type: "models-changed",
        payload: { agentId: "agent-1" },
        source: "plugin:cover-plugin",
      },
    }, null);
  });

  it("exposes ResourceEventBus-backed change emission to plugins", () => {
    const emitResourceChanged = vi.fn();
    const ctx = createPluginContext({
      pluginId: "resource-plugin",
      pluginDir: "/plugins/resource-plugin",
      dataDir: "/plugin-data/resource-plugin",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      emitResourceChanged,
    } as any);
    const input = {
      changeType: "modified",
      resourceKey: "local_fs:/tmp/a.md",
      resource: { kind: "local-file", provider: "local_fs", path: "/tmp/a.md" },
      source: "agent_tool",
    };

    expect(ctx.resourceEvents.changed(input)).toBe(true);
    expect(emitResourceChanged).toHaveBeenCalledWith(input);
  });

  it("exposes a ResourceIO-backed resource facade with explicit capability checks", async () => {
    const resourceIO = {
      stat: vi.fn(async () => ({
        resourceKey: "local_fs:/workspace",
        resource: { kind: "local-file", path: "/workspace" },
        exists: true,
        isDirectory: true,
      })),
      read: vi.fn(async () => ({
        resourceKey: "local_fs:/workspace/note.md",
        resource: { kind: "local-file", path: "/workspace/note.md" },
        content: Buffer.from("hello"),
      })),
      list: vi.fn(async () => ({
        resourceKey: "local_fs:/workspace",
        resource: { kind: "local-file", path: "/workspace" },
        items: [],
      })),
      search: vi.fn(async () => ({
        resourceKey: "mount:docs:",
        resource: { kind: "mount", mountId: "docs", path: "" },
        matches: [],
      })),
      materialize: vi.fn(async () => ({
        resourceKey: "session_file:sf_1",
        resource: { kind: "session-file", fileId: "sf_1" },
        filePath: "/tmp/session-file.md",
      })),
      resolveWatchTarget: vi.fn(() => ({
        resourceKey: "mount:docs:",
        resource: { kind: "mount", mountId: "docs", path: "" },
        filePath: "/tmp/docs",
      })),
      write: vi.fn(async (ref, content, options) => ({
        changeType: "modified",
        resourceKey: "local_fs:/workspace/note.md",
        resource: { kind: "local-file", path: "/workspace/note.md" },
        content,
        options,
      })),
      rename: vi.fn(async () => ({
        oldResourceKey: "local_fs:/workspace/old.md",
        newResourceKey: "local_fs:/workspace/new.md",
      })),
      trash: vi.fn(async () => ({
        resourceKey: "local_fs:/workspace/new.md",
        trashId: "trash_1",
      })),
    };
    const resourceWatch = {
      subscribe: vi.fn((input) => ({
        subscriptionId: input.resource ? "sub-one" : "sub-many",
        resourceKeys: input.resource
          ? ["mount:docs:"]
          : ["mount:docs:", "local_fs:/workspace"],
      })),
      unsubscribe: vi.fn(() => true),
    };
    const ctx = createPluginContext({
      pluginId: "resource-plugin",
      pluginDir: "/plugins/resource-plugin",
      dataDir: "/plugin-data/resource-plugin",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      capabilities: ["resource.read", "resource.search", "resource.materialize", "resource.watch"],
      resourceIO,
      resourceWatch,
      runtimeContext: {
        userId: "user_1",
        studioId: "studio_1",
        connectionKind: "local",
        credentialKind: "loopback_token",
        sessionId: "sess_1",
        sessionPath: "/sessions/current.jsonl",
      },
    } as any);

    const expectedPluginContext = (reason: string) => expect.objectContaining({
      source: "plugin",
      reason,
      sessionId: "sess_1",
      sessionPath: "/sessions/current.jsonl",
      principal: expect.objectContaining({
        kind: "plugin",
        pluginId: "resource-plugin",
        userId: "user_1",
        studioId: "studio_1",
        sessionId: "sess_1",
        sessionPath: "/sessions/current.jsonl",
        connectionKind: "local",
        credentialKind: "loopback_token",
      }),
    });

    await ctx.resources.stat({ kind: "local-file", path: "/workspace" });
    const readResult = await ctx.resources.read({ kind: "local-file", path: "/workspace/note.md" });
    await ctx.resources.list({ kind: "local-file", path: "/workspace" });
    await ctx.resources.search({ kind: "mount", mountId: "docs", path: "" }, { query: "note" });
    await ctx.resources.materialize({ kind: "session-file", fileId: "sf_1" });
    ctx.resources.resolveWatchTarget({ kind: "mount", mountId: "docs", path: "" });
    const watchHandle = ctx.resources.watch(
      { kind: "mount", mountId: "docs", path: "" },
      { purpose: "preview" },
    );
    const subscribeHandle = ctx.resources.subscribe([
      { kind: "mount", mountId: "docs", path: "" },
      { kind: "local-file", path: "/workspace" },
    ]);

    expect(readResult.content.toString("utf-8")).toBe("hello");
    expect(resourceIO.stat).toHaveBeenCalledWith(
      { kind: "local-file", path: "/workspace" },
      expectedPluginContext("plugin:resource-plugin:stat"),
    );
    expect(resourceIO.read).toHaveBeenCalledWith(
      { kind: "local-file", path: "/workspace/note.md" },
      expectedPluginContext("plugin:resource-plugin:read"),
    );
    expect(resourceIO.list).toHaveBeenCalledWith(
      { kind: "local-file", path: "/workspace" },
      expectedPluginContext("plugin:resource-plugin:list"),
    );
    expect(resourceIO.search).toHaveBeenCalledWith(
      { kind: "mount", mountId: "docs", path: "" },
      { query: "note" },
      expectedPluginContext("plugin:resource-plugin:search"),
    );
    expect(resourceIO.materialize).toHaveBeenCalledWith(
      { kind: "session-file", fileId: "sf_1" },
      expectedPluginContext("plugin:resource-plugin:materialize"),
    );
    expect(resourceIO.resolveWatchTarget).toHaveBeenCalledWith(
      { kind: "mount", mountId: "docs", path: "" },
      expectedPluginContext("plugin:resource-plugin:watch"),
    );
    expect(resourceWatch.subscribe).toHaveBeenCalledWith({
      resource: { kind: "mount", mountId: "docs", path: "" },
      purpose: "preview",
      sessionPath: "/sessions/current.jsonl",
    });
    expect(resourceWatch.subscribe).toHaveBeenCalledWith({
      resources: [
        { kind: "mount", mountId: "docs", path: "" },
        { kind: "local-file", path: "/workspace" },
      ],
      purpose: "plugin:resource-plugin:subscribe",
      sessionPath: "/sessions/current.jsonl",
    });
    expect(watchHandle).toMatchObject({
      subscriptionId: "sub-one",
      resourceKeys: ["mount:docs:"],
    });
    expect(watchHandle.unsubscribe()).toBe(true);
    expect(watchHandle.unsubscribe()).toBe(false);
    expect(subscribeHandle.close()).toBe(true);
    expect(resourceWatch.unsubscribe).toHaveBeenCalledWith("sub-one");
    expect(resourceWatch.unsubscribe).toHaveBeenCalledWith("sub-many");
    await expect(ctx.resources.write({ kind: "local-file", path: "/workspace/note.md" }, "updated"))
      .rejects.toMatchObject({
        code: "PLUGIN_RESOURCE_CAPABILITY_NOT_DECLARED",
        capability: "resource.write",
      });
    expect(resourceIO.write).not.toHaveBeenCalled();

    const writeCtx = createPluginContext({
      pluginId: "resource-plugin",
      pluginDir: "/plugins/resource-plugin",
      dataDir: "/plugin-data/resource-plugin",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      capabilities: ["resource.write"],
      resourceIO,
      runtimeContext: {
        userId: "user_1",
        studioId: "studio_1",
        connectionKind: "local",
        credentialKind: "loopback_token",
        sessionId: "sess_1",
        sessionPath: "/sessions/current.jsonl",
      },
    } as any);
    await writeCtx.resources.rename(
      { kind: "local-file", path: "/workspace/old.md" },
      { kind: "local-file", path: "/workspace/new.md" },
    );
    await writeCtx.resources.trash(
      { kind: "local-file", path: "/workspace/new.md" },
      { namespace: "plugin-test" },
    );
    expect(() => writeCtx.resources.watch({ kind: "local-file", path: "/workspace/new.md" }))
      .toThrow(/resource.watch/);
    expect(resourceIO.rename).toHaveBeenCalledWith(
      { kind: "local-file", path: "/workspace/old.md" },
      { kind: "local-file", path: "/workspace/new.md" },
      expect.objectContaining({
        source: "plugin",
        reason: "plugin:resource-plugin:rename",
        sessionId: "sess_1",
        sessionPath: "/sessions/current.jsonl",
        principal: expect.objectContaining({
          kind: "plugin",
          pluginId: "resource-plugin",
        }),
      }),
    );
    expect(resourceIO.trash).toHaveBeenCalledWith(
      { kind: "local-file", path: "/workspace/new.md" },
      { namespace: "plugin-test" },
      expect.objectContaining({
        source: "plugin",
        reason: "plugin:resource-plugin:trash",
        sessionId: "sess_1",
        sessionPath: "/sessions/current.jsonl",
        principal: expect.objectContaining({
          kind: "plugin",
          pluginId: "resource-plugin",
        }),
      }),
    );
  });

  it("rejects resource operations when ResourceIO was not injected", async () => {
    const ctx = createPluginContext({
      pluginId: "resource-plugin",
      pluginDir: "/plugins/resource-plugin",
      dataDir: "/plugin-data/resource-plugin",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      capabilities: ["resource.read"],
    } as any);

    await expect(ctx.resources.read({ kind: "local-file", path: "/workspace/note.md" }))
      .rejects.toMatchObject({
        code: "PLUGIN_RESOURCE_IO_UNAVAILABLE",
        pluginId: "resource-plugin",
      });
  });

  it("exposes server runtime scope when provided", () => {
    const bus = { emit() {}, subscribe() {}, request() {}, hasHandler() {} };
    const ctx = createPluginContext({
      pluginId: "scoped-plugin",
      pluginDir: "/plugins/scoped-plugin",
      dataDir: "/plugin-data/scoped-plugin",
      bus,
      runtimeContext: {
        serverId: "server_scope",
        serverNodeId: "node_scope",
        userId: "user_scope",
        studioId: "studio_scope",
        connectionKind: "local",
        credentialKind: "loopback_token",
        platformAccountId: null,
        officialServiceKind: null,
        executionBoundary: {
          schemaVersion: 1,
          boundaryId: "execb_node_scope_studio_scope",
          kind: "local_process",
          serverNodeId: "node_scope",
          studioId: "studio_scope",
        },
      },
    } as any);

    expect(ctx.serverId).toBe("server_scope");
    expect(ctx.serverNodeId).toBe("node_scope");
    expect(ctx.userId).toBe("user_scope");
    expect(ctx.studioId).toBe("studio_scope");
    expect(ctx.connectionKind).toBe("local");
    expect(ctx.credentialKind).toBe("loopback_token");
    expect(ctx.platformAccountId).toBeNull();
    expect(ctx.officialServiceKind).toBeNull();
    expect(ctx.executionBoundary).toMatchObject({
      boundaryId: "execb_node_scope_studio_scope",
      serverNodeId: "node_scope",
      studioId: "studio_scope",
    });
  });

  it("exposes session identity from runtime scope and lets staged files inherit it", () => {
    const bus = { emit() {}, subscribe() {}, request() {}, hasHandler() {} };
    const registerSessionFile = vi.fn((entry) => ({
      id: "sf_plugin_output",
      ...entry,
      filename: "generated.png",
      status: "available",
    }));
    const ctx = createPluginContext({
      pluginId: "identity-plugin",
      pluginDir: "/plugins/identity-plugin",
      dataDir: "/plugin-data/identity-plugin",
      bus,
      registerSessionFile,
      runtimeContext: {
        serverId: "server_scope",
        userId: "user_scope",
        studioId: "studio_scope",
        sessionId: "sess_plugin_ctx",
        sessionPath: "/sessions/current.jsonl",
        sessionRef: {
          sessionId: "sess_plugin_ctx",
          sessionPath: "/sessions/current.jsonl",
          legacySessionPath: "/sessions/legacy.jsonl",
        },
      },
    } as any);

    const staged = ctx.stageFile({
      filePath: "/plugin-data/identity-plugin/generated.png",
      label: "generated.png",
    });

    expect(ctx.sessionId).toBe("sess_plugin_ctx");
    expect(ctx.sessionRef).toEqual({
      sessionId: "sess_plugin_ctx",
      sessionPath: "/sessions/current.jsonl",
      legacySessionPath: "/sessions/legacy.jsonl",
    });
    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess_plugin_ctx",
      sessionPath: "/sessions/current.jsonl",
      sessionRef: {
        sessionId: "sess_plugin_ctx",
        sessionPath: "/sessions/current.jsonl",
        legacySessionPath: "/sessions/legacy.jsonl",
      },
    }));
    expect(staged.mediaItem).toMatchObject({
      type: "session_file",
      fileId: "sf_plugin_output",
      sessionId: "sess_plugin_ctx",
      sessionPath: "/sessions/current.jsonl",
    });
  });

  it("registers plugin session files with resource content links when runtime scope is available", () => {
    const bus = { emit() {}, subscribe() {}, request() {}, hasHandler() {} };
    const registerSessionFile = vi.fn((entry) => ({
      id: "sf_plugin_output",
      ...entry,
      ext: "png",
      mime: "image/png",
      kind: "image",
      status: "available",
    }));
    const ctx = createPluginContext({
      pluginId: "image-gen",
      pluginDir: "/plugins/image-gen",
      dataDir: "/plugin-data/image-gen",
      bus,
      registerSessionFile,
      runtimeContext: {
        serverId: "server_scope",
        serverNodeId: "node_scope",
        userId: "user_scope",
        studioId: "studio_scope",
        connectionKind: "local",
        credentialKind: "loopback_token",
      },
    } as any);

    const file = ctx.registerSessionFile({
      sessionPath: "/sessions/a.jsonl",
      filePath: "/plugin-data/image-gen/generated.png",
      label: "generated.png",
    });

    expect(file.resource).toMatchObject({
      resourceId: "res_sf_plugin_output",
      studioId: "studio_scope",
      links: {
        self: "/api/resources/res_sf_plugin_output",
        content: "/api/resources/res_sf_plugin_output/content",
      },
    });
  });

  it("config.get/set reads and writes plugin-data config.json", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const tmpDir = path.join(os.tmpdir(), "hana-ctx-test-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const ctx = createPluginContext({
        pluginId: "x", pluginDir: "/tmp", dataDir: tmpDir,
        bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      } as any);
      ctx.config.set("foo", 42);
      expect(ctx.config.get("foo")).toBe(42);
      const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"));
      expect(raw.global.foo).toBe(42);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("log has scoped prefix", () => {
    const ctx = createPluginContext({
      pluginId: "my-plug", pluginDir: "/tmp", dataDir: "/tmp",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
    } as any);
    expect(typeof ctx.log.info).toBe("function");
    expect(typeof ctx.log.error).toBe("function");
  });

  it("forwards log entries to an optional log sink", () => {
    const logSink = vi.fn();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const ctx = createPluginContext({
        pluginId: "my-plug", pluginDir: "/tmp", dataDir: "/tmp",
        bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
        logSink,
      } as any);
      ctx.log.info("hello", { token: "secret-token", count: 2 });
      expect(logSink).toHaveBeenCalledWith(expect.objectContaining({
        pluginId: "my-plug",
        level: "info",
        args: ["hello", { token: "secret-token", count: 2 }],
      }));
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("exposes declared network.fetch with host allowlist, timeout, and cache controls", async () => {
    const fetchImpl = vi.fn(async (url, init) => new Response(JSON.stringify({
      ok: true,
      url: String(url),
      signal: !!init?.signal,
      call: fetchImpl.mock.calls.length,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const ctx = createPluginContext({
      pluginId: "scores-plugin",
      pluginDir: "/plugins/scores-plugin",
      dataDir: "/plugin-data/scores-plugin",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      capabilities: ["network.fetch"],
      network: {
        allowedHosts: ["api.example.com"],
        methods: ["GET"],
        defaultTimeoutMs: 2500,
        maxResponseBytes: 1024,
      },
      fetchImpl,
    } as any);

    const first = await ctx.network.fetch("https://api.example.com/live?league=world-cup", {
      cacheTtlMs: 1000,
    });
    const second = await ctx.network.fetch("https://api.example.com/live?league=world-cup", {
      cacheTtlMs: 1000,
    });

    await expect(first.json()).resolves.toMatchObject({ ok: true, signal: true, call: 1 });
    await expect(second.json()).resolves.toMatchObject({ ok: true, signal: true, call: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("GET");
  });

  it("rejects network.fetch when the manifest did not declare the capability", async () => {
    const ctx = createPluginContext({
      pluginId: "scores-plugin",
      pluginDir: "/plugins/scores-plugin",
      dataDir: "/plugin-data/scores-plugin",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      capabilities: ["session"],
      network: { allowedHosts: ["api.example.com"] },
      fetchImpl: vi.fn(),
    } as any);

    await expect(ctx.network.fetch("https://api.example.com/live"))
      .rejects.toMatchObject({ code: "PLUGIN_NETWORK_CAPABILITY_NOT_DECLARED" });
  });

  it("rejects network.fetch hosts outside the manifest allowlist", async () => {
    const ctx = createPluginContext({
      pluginId: "scores-plugin",
      pluginDir: "/plugins/scores-plugin",
      dataDir: "/plugin-data/scores-plugin",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      capabilities: ["network.fetch"],
      network: { allowedHosts: ["api.example.com"] },
      fetchImpl: vi.fn(),
    } as any);

    await expect(ctx.network.fetch("https://evil.example.net/live"))
      .rejects.toMatchObject({
        code: "PLUGIN_NETWORK_HOST_NOT_ALLOWED",
        host: "evil.example.net",
      });
  });

  it("blocks network.fetch private targets unless localhost access is explicitly declared", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const blockedCtx = createPluginContext({
      pluginId: "local-plugin",
      pluginDir: "/plugins/local-plugin",
      dataDir: "/plugin-data/local-plugin",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      capabilities: ["network.fetch"],
      network: { allowedHosts: ["127.0.0.1"] },
      fetchImpl,
    } as any);
    const allowedCtx = createPluginContext({
      pluginId: "local-plugin",
      pluginDir: "/plugins/local-plugin",
      dataDir: "/plugin-data/local-plugin",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      capabilities: ["network.fetch"],
      network: { allowedHosts: ["127.0.0.1"], allowLocalhost: true },
      fetchImpl,
    } as any);

    await expect(blockedCtx.network.fetch("http://127.0.0.1:11434/api/tags"))
      .rejects.toMatchObject({ code: "PLUGIN_NETWORK_PRIVATE_HOST_FORBIDDEN" });
    await expect(allowedCtx.network.fetch("http://127.0.0.1:11434/api/tags"))
      .resolves.toBeInstanceOf(Response);
  });

  it("rejects network.fetch responses larger than the declared byte limit", async () => {
    const ctx = createPluginContext({
      pluginId: "scores-plugin",
      pluginDir: "/plugins/scores-plugin",
      dataDir: "/plugin-data/scores-plugin",
      bus: { emit() {}, subscribe() {}, request() {}, hasHandler() {} },
      capabilities: ["network.fetch"],
      network: { allowedHosts: ["api.example.com"], maxResponseBytes: 3 },
      fetchImpl: vi.fn(async () => new Response("1234")),
    } as any);

    await expect(ctx.network.fetch("https://api.example.com/live"))
      .rejects.toMatchObject({
        code: "PLUGIN_NETWORK_RESPONSE_TOO_LARGE",
        maxResponseBytes: 3,
      });
  });
});

describe("createPluginContext with accessLevel", () => {
  it("full-access context exposes bus.handle", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "full-access",
    } as any);
    expect(typeof ctx.bus.handle).toBe("function");
    expect(typeof ctx.bus.request).toBe("function");
    expect(typeof ctx.bus.emit).toBe("function");
    expect(typeof ctx.bus.listCapabilities).toBe("function");
    expect(typeof ctx.bus.getCapability).toBe("function");
  });

  it("restricted context does NOT expose bus.handle", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "restricted",
    } as any);
    expect(ctx.bus.handle).toBeUndefined();
    expect(typeof ctx.bus.request).toBe("function");
    expect(typeof ctx.bus.emit).toBe("function");
    expect(typeof ctx.bus.subscribe).toBe("function");
    expect(typeof ctx.bus.listCapabilities).toBe("function");
    expect(typeof ctx.bus.getCapability).toBe("function");
  });

  it("restricted bus proxy is frozen", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "restricted",
    } as any);
    expect(Object.isFrozen(ctx.bus)).toBe(true);
    expect(() => { (ctx.bus as any).handle = () => {}; }).toThrow();
  });

  it("defaults to restricted when accessLevel omitted", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus,
    } as any);
    expect(ctx.bus.handle).toBeUndefined();
  });

  it("requires usage.read before a restricted plugin can request usage entries", async () => {
    const bus = await makeBus();
    bus.handle("usage:list", () => ({ entries: [], nextCursor: null }));
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "restricted",
    } as any);

    await expect(ctx.bus.request("usage:list", {})).rejects.toMatchObject({
      code: "FORBIDDEN",
      permission: "usage.read",
    });
  });

  it("allows usage.read restricted plugins to request and subscribe to usage entries", async () => {
    const bus = await makeBus();
    bus.handle("usage:list", () => ({ entries: [{ requestId: "req-1" }], nextCursor: null }));
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "restricted",
      permissions: ["usage.read"],
    } as any);

    await expect(ctx.bus.request("usage:list", {})).resolves.toMatchObject({
      entries: [{ requestId: "req-1" }],
    });
    const events = [];
    const off = ctx.bus.subscribe((event) => events.push(event), { types: ["llm_usage"] });
    bus.emit({ type: "llm_usage", entry: { requestId: "req-2" } }, null);
    off();
    expect(events).toEqual([{ type: "llm_usage", entry: { requestId: "req-2" } }]);
  });

  it("filters llm_usage out of global restricted subscriptions without usage.read", async () => {
    const bus = await makeBus();
    const ctx = createPluginContext({
      pluginId: "test", pluginDir: "/tmp/test",
      dataDir: "/tmp/data", bus, accessLevel: "restricted",
    } as any);
    const events = [];
    const off = ctx.bus.subscribe((event) => events.push(event));
    bus.emit({ type: "llm_usage", entry: { requestId: "req-1" } }, null);
    bus.emit({ type: "other_event" }, null);
    off();
    expect(events).toEqual([{ type: "other_event" }]);
  });
});
