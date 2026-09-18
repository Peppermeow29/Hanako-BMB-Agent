import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HanaEngine } from "../core/engine.ts";
import { SessionExecutionRegistry } from "../lib/session-execution-registry.ts";

function permissionTool(name, execute = vi.fn(), kind: "read" | "routine" | "review" = "routine") {
  return {
    name,
    sessionPermission: {
      resolveInvocation: () => ({
        action: "execute",
        kind,
        capability: `${name}.execute`,
      }),
    },
    execute,
  };
}

describe("HanaEngine.buildTools", () => {
  let tmpDir;
  let engines: HanaEngine[] = [];

  afterEach(async () => {
    for (const engine of engines.splice(0).reverse()) {
      await engine.dispose();
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("rejects strict tool assembly without a complete runtime SessionRef", () => {
    const engine = Object.create(HanaEngine.prototype);

    expect(() => engine.buildTools("/tmp", [], {
      requireSessionIdentity: true,
    })).toThrow(expect.objectContaining({ code: "session_manifest_ref_required" }));
    expect(() => engine.buildTools("/tmp", [], {
      runtimeSessionRef: { sessionId: "sess_missing_path" },
      requireSessionIdentity: true,
    })).toThrow(expect.objectContaining({ code: "session_manifest_ref_required" }));
  });

  it("throws when opts.agentDir points at an unknown agent instead of using focus tools", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-"));
    const focusAgentDir = path.join(tmpDir, "agents", "focus");
    const missingAgentDir = path.join(tmpDir, "agents", "missing");

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => null);
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir: focusAgentDir,
        tools: [{ name: "focus_custom_tool", execute: vi.fn() }],
      },
    };

    expect(() => engine.buildTools(tmpDir, undefined, {
      agentDir: missingAgentDir,
      workspace: tmpDir,
    })).toThrow(/agent "missing" not found/);
  });

  it("rejects a custom tool that shadows a Pi built-in tool", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-duplicate-pi-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const agent = { id: "focus", agentDir, config: {}, tools: [] };
    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => agent);
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._agentMgr = { agent };

    expect(() => engine.buildTools(tmpDir, [], {
      agentDir,
      workspace: tmpDir,
      extraCustomTools: [permissionTool("read")],
    })).toThrow(/duplicate tool name "read" across Pi built-in tools and runtime custom tools/);
  });

  it("rejects duplicate names across custom, extra, plugin, and plugin development tools", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-duplicate-custom-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const agent = { id: "focus", agentDir, config: {}, tools: [] };

    const makeEngine = (pluginTools: any[] = [], pluginDevToolsEnabled = false) => {
      const engine = Object.create(HanaEngine.prototype);
      engine.hanakoHome = tmpDir;
      engine.getAgent = vi.fn(() => agent);
      engine._pluginManager = pluginTools.length ? { getAllTools: () => pluginTools } : null;
      engine._pluginDevService = pluginDevToolsEnabled ? {} : null;
      engine._prefs = {
        getFileBackup: () => ({ enabled: false }),
        getPluginDevToolsEnabled: () => pluginDevToolsEnabled,
      };
      engine._readPreferences = () => ({ sandbox: true });
      engine._agentMgr = { agent };
      return engine;
    };

    expect(() => makeEngine().buildTools(tmpDir, [permissionTool("duplicate")], {
      agentDir,
      workspace: tmpDir,
      extraCustomTools: [permissionTool("duplicate")],
    })).toThrow(/duplicate tool name "duplicate" across custom tools and extra custom tools/);

    expect(() => makeEngine([
      { ...permissionTool("duplicate"), _pluginId: "test_plugin" },
    ]).buildTools(tmpDir, [permissionTool("duplicate")], {
      agentDir,
      workspace: tmpDir,
    })).toThrow(/duplicate tool name "duplicate" across custom tools and plugin tools/);

    expect(() => makeEngine([], true).buildTools(
      tmpDir,
      [permissionTool("plugin_dev_diagnostics")],
      { agentDir, workspace: tmpDir },
    )).toThrow(
      /duplicate tool name "plugin_dev_diagnostics" across custom tools and plugin development tools/,
    );
  });

  it("uses an explicit permission mode provider instead of the desktop session default", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const sessionPath = path.join(tmpDir, "sessions", "bridge.jsonl");
    const execute = vi.fn(async () => ({ details: { executed: true } }));
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-tool-1",
        promise: Promise.resolve({ action: "rejected" }),
      })),
    };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = confirmStore;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "ask");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { customTools } = engine.buildTools(tmpDir, [
      permissionTool("stage_files", execute),
    ], {
      agentDir,
      workspace: tmpDir,
      getPermissionMode: () => "operate",
    });

    const result = await customTools[0].execute(
      "call-1",
      { path: "x" },
      { sessionManager: { getSessionFile: () => sessionPath } },
    );

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("passes the engine approval gateway into auto-mode tool execution", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-auto-approval-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const sessionPath = path.join(tmpDir, "sessions", "auto.jsonl");
    const execute = vi.fn(async () => ({ details: { executed: true } }));
    const approvalGateway = {
      review: vi.fn(async () => ({
        action: "allow",
        reviewer: "small_tool_model",
        reason: "test-approved",
        risk: "low",
      })),
    };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._approvalGateway = approvalGateway;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "auto");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { customTools } = engine.buildTools(tmpDir, [
      permissionTool("stage_files", execute, "review"),
    ], {
      agentDir,
      workspace: tmpDir,
      workspaceFolders: [path.join(tmpDir, "shared")],
      authorizedFolders: [path.join(tmpDir, "assets-static")],
      getAuthorizedFolders: () => [path.join(tmpDir, "assets-live")],
      getPermissionMode: () => "auto",
    });

    const result = await customTools[0].execute(
      "call-1",
      { path: "x" },
      { sessionManager: { getSessionFile: () => sessionPath } },
    );

    expect(approvalGateway.review).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "stage_files", sessionPath, agentId: "focus" }),
      expect.objectContaining({
        sessionPath,
        agentId: "focus",
        cwd: tmpDir,
        workspaceFolders: [path.join(tmpDir, "shared")],
        authorizedFolders: [path.join(tmpDir, "assets-live")],
      }),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("wraps isolated extra custom tools in the same Auto permission gateway", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-extra-permission-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const sessionPath = path.join(tmpDir, "sessions", "isolated.jsonl");
    const execute = vi.fn(async () => ({ details: { executed: true } }));
    const approvalGateway = { review: vi.fn() };
    const agent = { id: "focus", agentDir, config: {}, tools: [] };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => agent);
    engine.getSessionIdForPath = vi.fn(() => "sess_isolated");
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._approvalGateway = approvalGateway;
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine._agentMgr = { agent };

    const { customTools } = engine.buildTools(tmpDir, [], {
      agentDir,
      workspace: tmpDir,
      runtimeSessionRef: { sessionId: "sess_isolated", sessionPath },
      requireSessionIdentity: true,
      getPermissionMode: () => "auto",
      extraCustomTools: [permissionTool("structured_output", execute, "routine")],
    });
    const extra = customTools.find((tool) => tool.name === "structured_output");
    const result = await extra.execute("call-extra", { value: "ok" }, null, null, {
      sessionId: "sess_isolated",
      sessionPath,
    });

    expect(approvalGateway.review).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(result.details.executed).toBe(true);
  });

  it("wires utility model reviewers into the default approval gateway", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-engine-approval-gateway-"));
    const engine = new HanaEngine({
      hanakoHome: tmpDir,
      productDir: tmpDir,
      agentId: "hana",
    } as any);
    engines.push(engine);
    engine.resolveUtilityConfigFresh = vi.fn(async () => ({
      utility: { id: "small-reviewer", provider: "test" },
      utility_large: { id: "large-reviewer", provider: "test" },
      api: "openai-completions",
      api_key: "small-key",
      base_url: "https://small.example.test",
      large_api: "openai-completions",
      large_api_key: "large-key",
      large_base_url: "https://large.example.test",
    }));
    engine._callApprovalReviewerText = vi.fn(async () => JSON.stringify({
      action: "allow",
      reason: "workspace edit is in scope",
      risk: "low",
    }));

    const decision = await engine._approvalGateway.review({
      id: "approval-1",
      kind: "tool_action",
      sessionPath: path.join(tmpDir, "sessions", "approval.jsonl"),
      agentId: "hana",
      toolName: "write",
      actionName: "execute",
      params: { path: "notes.md" },
      target: { type: "file", label: "notes.md", path: "notes.md" },
      blastRadius: "workspace",
      reversibility: "moderate",
    });

    expect(engine.resolveUtilityConfigFresh).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "hana",
    }));
    expect(engine._callApprovalReviewerText).toHaveBeenCalledWith(expect.objectContaining({
      model: { id: "small-reviewer", provider: "test" },
      apiKey: "small-key",
      baseUrl: "https://small.example.test",
    }));
    expect(decision).toMatchObject({
      action: "allow",
      reviewer: "small_tool_model",
      reason: "workspace edit is in scope",
    });
  });

  it("resolves utility config through the session owner when only sessionPath is known", () => {
    const sessionPath = "/tmp/agents/target/sessions/s1.jsonl";
    const engine = Object.create(HanaEngine.prototype);
    engine._agentMgr = { activeAgentId: "focus" };
    engine.agentIdFromSessionPath = vi.fn(() => "target");
    engine.resolveSessionOwnership = vi.fn((ref) => {
      const sp = typeof ref === "string" ? ref : ref?.sessionPath || null;
      const agentId = sp ? engine.agentIdFromSessionPath?.(sp) || null : null;
      return { agentId, source: agentId ? "path" : "none", agentDeleted: false };
    });
    engine._configCoord = {
      resolveUtilityConfig: vi.fn(() => ({ utility: { id: "target-utility" } })),
    };
    engine._usageLedger = { id: "ledger" };
    engine.getSessionIdForPath = vi.fn(() => "sess_target_1");

    const result = engine.resolveUtilityConfig({ sessionPath });

    expect(engine.agentIdFromSessionPath).toHaveBeenCalledWith(sessionPath);
    expect(engine.getSessionIdForPath).toHaveBeenCalledWith(sessionPath);
    expect(engine._configCoord.resolveUtilityConfig).toHaveBeenCalledWith({
      sessionPath,
      agentId: "target",
    });
    expect(result).toMatchObject({
      utility: { id: "target-utility" },
      usageAgentId: "target",
      usageSessionPath: sessionPath,
      usageSessionId: "sess_target_1",
    });
  });

  it("hides stable availability-disabled tools before building the model schema", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-availability-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const agent = {
      id: "focus",
      agentDir,
      config: { tools: { disabled: ["browser"] } },
      tools: [],
    };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => agent);
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = {
      agent,
    };

    const { customTools } = engine.buildTools(tmpDir, [
      permissionTool("browser"),
      permissionTool("automation"),
    ], {
      agentDir,
      workspace: tmpDir,
      getPermissionMode: () => "operate",
    });

    expect(customTools.map((tool) => tool.name)).toEqual(["automation"]);
  });

  it("composes MCP manager tools with the same session context as plugin tools", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-mcp-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const sessionPath = path.join(agentDir, "sessions", "main.jsonl");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const agent = { id: "focus", agentDir, config: {}, tools: [] };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => agent);
    engine._pluginManager = null;
    // MCP tools come from the engine-owned manager, not the plugin registry.
    engine._mcp = {
      getAllTools: () => [{
        name: "mcp_github_search",
        _pluginId: "mcp",
        execute,
      }],
    };
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = { agent };

    const { customTools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getSessionPath: () => sessionPath,
      getPermissionMode: () => "operate",
    });

    const mcpTool = customTools.find((tool) => tool.name === "mcp_github_search");
    expect(mcpTool).toBeTruthy();

    await mcpTool.execute("call-1", { q: "hana" }, {
      sessionManager: { getSessionFile: () => sessionPath },
    });

    // Same wrapper as plugin tools: the runtime context arrives as the fifth
    // argument, carrying the resolved agent and session identity.
    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { q: "hana" },
      expect.objectContaining({ sessionManager: expect.any(Object) }),
      undefined,
      expect.objectContaining({ agentId: "focus", sessionPath }),
    );
  });

  it("rejects duplicate names between MCP tools and custom tools", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-mcp-duplicate-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const agent = { id: "focus", agentDir, config: {}, tools: [] };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => agent);
    engine._pluginManager = null;
    engine._mcp = {
      getAllTools: () => [{ ...permissionTool("mcp_duplicate"), _pluginId: "mcp" }],
    };
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._agentMgr = { agent };

    expect(() => engine.buildTools(tmpDir, [permissionTool("mcp_duplicate")], {
      agentDir,
      workspace: tmpDir,
    })).toThrow(/duplicate tool name "mcp_duplicate" across custom tools and mcp tools/);
  });

  it("passes a session workbench execution boundary into plugin tools", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-boundary-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const sessionPath = path.join(agentDir, "sessions", "main.jsonl");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const agent = {
      id: "focus",
      agentDir,
      config: {},
      tools: [],
    };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine._runtimeContext = {
      serverId: "server_engine",
      serverNodeId: "node_engine",
      studioId: "studio_engine",
    };
    engine.getAgent = vi.fn(() => agent);
    engine._pluginManager = {
      getAllTools: () => [{
        name: "plugin_tool",
        _pluginId: "test_plugin",
        execute,
      }],
    };
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = { agent };

    const { customTools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getSessionPath: () => sessionPath,
      getPermissionMode: () => "operate",
    });
    const pluginTool = customTools.find((tool) => tool.name === "plugin_tool");

    await pluginTool.execute("call-1", { ok: true }, {
      sessionManager: { getSessionFile: () => sessionPath },
    });

    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { ok: true },
      expect.objectContaining({
        sessionManager: expect.any(Object),
      }),
      undefined,
      expect.objectContaining({
        agentId: "focus",
        serverNodeId: "node_engine",
        sessionPath,
        executionBoundary: expect.objectContaining({
          boundaryId: "execb_node_engine_studio_engine",
          serverNodeId: "node_engine",
          studioId: "studio_engine",
          workbench: {
            kind: "legacy_agent_workbench",
            root: workspace,
          },
        }),
      }),
    );
  });

  it("passes the explicit buildTools SessionRef into plugin tool runtime context", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-plugin-session-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const bridgeSessionPath = path.join(agentDir, "sessions", "bridge", "owner", "chat.jsonl");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const agent = {
      id: "focus",
      agentDir,
      config: {},
      tools: [],
    };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine._runtimeContext = {
      serverId: "server_engine",
      serverNodeId: "node_engine",
      studioId: "studio_engine",
    };
    engine.getAgent = vi.fn(() => agent);
    engine._pluginManager = {
      getAllTools: () => [{
        name: "plugin_tool",
        _pluginId: "test_plugin",
        execute,
      }],
    };
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = { agent };

    const { customTools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getSessionPath: () => bridgeSessionPath,
      getSessionRef: () => ({
        sessionId: "sess_bridge_owner",
        sessionPath: bridgeSessionPath,
      }),
      getPermissionMode: () => "operate",
    });
    const pluginTool = customTools.find((tool) => tool.name === "plugin_tool");

    await pluginTool.execute("call-1", { ok: true }, {});

    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { ok: true },
      {},
      undefined,
      expect.objectContaining({
        sessionId: "sess_bridge_owner",
        sessionPath: bridgeSessionPath,
        sessionRef: {
          sessionId: "sess_bridge_owner",
          sessionPath: bridgeSessionPath,
        },
      }),
    );
  });

  it("freezes and injects the explicit runtime SessionRef into agent tool context", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-agent-session-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const sessionPath = path.join(agentDir, "sessions", "phone", "chat.jsonl");
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const agent = { id: "focus", agentDir, config: {}, tools: [] };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => agent);
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = { agent };

    const sessionRef = { sessionId: "sess_phone", sessionPath };
    const { customTools } = engine.buildTools(workspace, [permissionTool("stage_files", execute)], {
      agentDir,
      workspace,
      runtimeSessionRef: sessionRef,
      requireSessionIdentity: true,
      getPermissionMode: () => "operate",
    });
    sessionRef.sessionId = "sess_mutated_after_assembly";
    sessionRef.sessionPath = path.join(tmpDir, "mutated.jsonl");

    await customTools.find((tool) => tool.name === "stage_files").execute("call-1", {}, {});

    expect(execute).toHaveBeenCalledWith(
      "call-1",
      {},
      {},
      undefined,
      expect.objectContaining({
        sessionId: "sess_phone",
        sessionPath,
        sessionRef: { sessionId: "sess_phone", sessionPath },
      }),
    );
    const injectedCtx = (execute.mock.calls[0] as any)[4];
    expect(Object.isFrozen(injectedCtx.sessionRef)).toBe(true);
  });

  it("keeps Hana and Pi runtime-native identities separate across the full tool wrapper chain", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-plugin-pi-ctx-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const desktopSessionPath = path.join(agentDir, "sessions", "desktop.jsonl");
    const hanaSessionId = "sess_desktop";
    const piSessionId = "019f7dca-9ff4-7031-ba7f-cdcd5f7b3198";
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const agent = {
      id: "focus",
      agentDir,
      config: {},
      tools: [],
    };

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine._runtimeContext = {
      serverId: "server_engine",
      serverNodeId: "node_engine",
      studioId: "studio_engine",
    };
    engine.getAgent = vi.fn(() => agent);
    engine.getSessionIdForPath = vi.fn((candidatePath) => (
      candidatePath === desktopSessionPath ? hanaSessionId : null
    ));
    engine._sessionExecutions = new SessionExecutionRegistry();
    engine._pluginManager = {
      getAllTools: () => [{
        name: "plugin_tool",
        _pluginId: "test_plugin",
        execute,
      }],
    };
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = { agent };

    const { customTools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getPermissionMode: () => "operate",
    });
    const pluginTool = customTools.find((tool) => tool.name === "plugin_tool");
    const signal = new AbortController().signal;
    const onUpdate = vi.fn();

    await pluginTool.execute("call-1", { ok: true }, signal, onUpdate, {
      sessionManager: {
        getSessionFile: () => desktopSessionPath,
        getSessionId: () => piSessionId,
        getCwd: () => workspace,
      },
    });

    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { ok: true },
      expect.objectContaining({ aborted: false }),
      onUpdate,
      expect.objectContaining({
        sessionId: hanaSessionId,
        sessionPath: desktopSessionPath,
        sessionRef: {
          sessionId: hanaSessionId,
          sessionPath: desktopSessionPath,
        },
      }),
    );
    const receivedCtx = (execute.mock.calls[0] as any)[4];
    expect(receivedCtx.sessionManager.getSessionId()).toBe(piSessionId);
    expect(engine._sessionExecutions.activeCount(hanaSessionId)).toBe(0);
  });

  it("registers files created or modified by write and edit tools in the active session", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-touch-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const sessionPath = path.join(agentDir, "sessions", "touch.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n");

    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, operation }) => ({
      id: `sf_${operation}`,
      sessionPath,
      filePath,
      label,
      origin,
      operation,
    }));
    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.registerSessionFile = registerSessionFile;
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: false });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { tools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getSessionPath: () => sessionPath,
    });
    const write = tools.find(tool => tool.name === "write");
    const edit = tools.find(tool => tool.name === "edit");

    const writeResult = await write.execute("write-1", { path: "draft.md", content: "hello\n" });
    const editResult = await edit.execute("edit-1", {
      path: "draft.md",
      edits: [{ oldText: "hello", newText: "hello Hana" }],
    });

    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath,
      filePath: path.join(workspace, "draft.md"),
      label: "draft.md",
      origin: "agent_write",
      operation: "created",
    }));
    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath,
      filePath: path.join(workspace, "draft.md"),
      label: "draft.md",
      origin: "agent_edit",
      operation: "modified",
    }));
    expect(writeResult.details.sessionFile).toMatchObject({
      id: "sf_created",
      filePath: path.join(workspace, "draft.md"),
      origin: "agent_write",
    });
    expect(editResult.details.sessionFile).toMatchObject({
      id: "sf_modified",
      filePath: path.join(workspace, "draft.md"),
      origin: "agent_edit",
    });
    expect(engine._emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "resource.changed",
      source: "agent_tool",
      reason: "agent_write",
      sessionPath,
      fileId: "sf_created",
      origin: "agent_write",
      operation: "created",
      resource: expect.objectContaining({
        filePath: path.join(workspace, "draft.md"),
      }),
    }), sessionPath);
    expect(engine._emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "resource.changed",
      source: "agent_tool",
      reason: "agent_edit",
      sessionPath,
      fileId: "sf_modified",
      origin: "agent_edit",
      operation: "modified",
      resource: expect.objectContaining({
        filePath: path.join(workspace, "draft.md"),
      }),
    }), sessionPath);
  });

  it("registers write and edit session files when Pi SDK uses the file_path alias", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-file-path-alias-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const sessionPath = path.join(agentDir, "sessions", "touch-alias.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n");

    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, operation }) => ({
      id: `sf_${operation}`,
      sessionPath,
      filePath,
      label,
      origin,
      operation,
    }));
    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.registerSessionFile = registerSessionFile;
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: false });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { tools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getSessionPath: () => sessionPath,
    });
    const write = tools.find(tool => tool.name === "write");
    const edit = tools.find(tool => tool.name === "edit");

    const writeResult = await write.execute("write-1", { file_path: "alias.md", content: "hello\n" });
    const editResult = await edit.execute("edit-1", {
      file_path: "alias.md",
      edits: [{ oldText: "hello", newText: "hello Hana" }],
    });

    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath,
      filePath: path.join(workspace, "alias.md"),
      label: "alias.md",
      origin: "agent_write",
      operation: "created",
    }));
    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath,
      filePath: path.join(workspace, "alias.md"),
      label: "alias.md",
      origin: "agent_edit",
      operation: "modified",
    }));
    expect(writeResult.details.sessionFile).toMatchObject({
      id: "sf_created",
      filePath: path.join(workspace, "alias.md"),
      origin: "agent_write",
    });
    expect(editResult.details.sessionFile).toMatchObject({
      id: "sf_modified",
      filePath: path.join(workspace, "alias.md"),
      origin: "agent_edit",
    });
  });

  it("lets built-in file tools pick up newly authorized session folders without rebuilding tools", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-authorized-folders-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const authorized = path.join(tmpDir, "authorized");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(authorized, { recursive: true });
    const hanakoHome = path.join(tmpDir, "hanako-home");
    fs.mkdirSync(hanakoHome, { recursive: true });
    let authorizedFolders = [];

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = hanakoHome;
    engine.registerSessionFile = vi.fn((entry) => ({
      id: "sf-authorized",
      ...entry,
    }));
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { tools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
      getAuthorizedFolders: () => authorizedFolders,
      getSessionPath: () => path.join(agentDir, "sessions", "authorized.jsonl"),
      getPermissionMode: () => "operate",
    });
    const write = tools.find(tool => tool.name === "write");
    const targetPath = path.join(authorized, "note.md");

    const blocked = await write.execute("write-blocked", {
      path: targetPath,
      content: "before\n",
    });
    expect(blocked.content[0].text).toContain("Resource is outside authorized roots");
    expect(blocked.content[0].text).not.toContain(targetPath);
    expect(fs.existsSync(targetPath)).toBe(false);

    authorizedFolders = [authorized];
    const allowed = await write.execute("write-allowed", {
      path: targetPath,
      content: "after\n",
    });

    expect(fs.readFileSync(targetPath, "utf-8")).toBe("after\n");
    expect(allowed.details.sessionFile).toMatchObject({
      id: "sf-authorized",
      filePath: targetPath,
      origin: "agent_write",
    });
  });

  it("blocks direct agent config edits from built-in file tools even when sandbox is disabled", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-managed-config-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const workspace = path.join(tmpDir, "workspace");
    const configPath = path.join(agentDir, "config.yaml");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(configPath, "agent:\n  name: Hana\n  yuan: hanako\n", "utf-8");

    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.registerSessionFile = vi.fn();
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._prefs = { getFileBackup: () => ({ enabled: false }) };
    engine._readPreferences = () => ({ sandbox: false });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { tools } = engine.buildTools(workspace, [], {
      agentDir,
      workspace,
    });
    const write = tools.find(tool => tool.name === "write");
    const edit = tools.find(tool => tool.name === "edit");

    const writeResult = await write.execute("write-config", {
      path: configPath,
      content: "agent:\n  name: Hana\n  yuan: caikangyong\n",
    });
    const editResult = await edit.execute("edit-config", {
      path: configPath,
      edits: [{ oldText: "yuan: hanako", newText: "yuan: caikangyong" }],
    });

    expect(writeResult.content[0].text.toLowerCase()).toContain("managed");
    expect(editResult.content[0].text.toLowerCase()).toContain("managed");
    expect(fs.readFileSync(configPath, "utf-8")).toContain("yuan: hanako");
    expect(engine.registerSessionFile).not.toHaveBeenCalled();
  });

  it("keeps plugin dev Agent tools hidden until the global dev setting is enabled", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-dev-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._pluginDevService = { getDiagnostics: vi.fn() };
    engine._prefs = {
      getFileBackup: () => ({ enabled: false }),
      getPluginDevToolsEnabled: () => false,
    };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { customTools } = engine.buildTools(tmpDir, [], {
      agentDir,
      workspace: tmpDir,
      getPermissionMode: () => "operate",
    });

    expect(customTools.some((tool) => tool.name.startsWith("plugin_dev_"))).toBe(false);
  });

  it("adds plugin dev Agent tools when the user enables the dev setting", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-build-tools-dev-"));
    const agentDir = path.join(tmpDir, "agents", "focus");
    const engine = Object.create(HanaEngine.prototype);
    engine.hanakoHome = tmpDir;
    engine.getAgent = vi.fn(() => ({ id: "focus", agentDir, tools: [] }));
    engine._pluginManager = null;
    engine._pluginDevService = {
      installFromSource: vi.fn(),
      reloadPlugin: vi.fn(),
      enablePlugin: vi.fn(),
      disablePlugin: vi.fn(),
      resetPlugin: vi.fn(),
      uninstallPlugin: vi.fn(),
      invokeTool: vi.fn(),
      getDiagnostics: vi.fn(),
      listSurfaces: vi.fn(),
      describeSurfaceDebug: vi.fn(),
      runScenario: vi.fn(),
    };
    engine._prefs = {
      getFileBackup: () => ({ enabled: false }),
      getPluginDevToolsEnabled: () => true,
    };
    engine._readPreferences = () => ({ sandbox: true });
    engine._confirmStore = null;
    engine._emitEvent = vi.fn();
    engine.getSessionPermissionMode = vi.fn(() => "operate");
    engine._agentMgr = {
      agent: {
        id: "focus",
        agentDir,
        tools: [],
      },
    };

    const { customTools } = engine.buildTools(tmpDir, [], {
      agentDir,
      workspace: tmpDir,
      getPermissionMode: () => "operate",
    });

    expect(customTools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "plugin_dev_install",
      "plugin_dev_reload",
      "plugin_dev_uninstall",
      "plugin_dev_invoke_tool",
      "plugin_dev_run_scenario",
    ]));
  });
});
