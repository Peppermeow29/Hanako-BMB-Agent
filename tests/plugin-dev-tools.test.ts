import { describe, expect, it, vi } from "vitest";
import { createPluginDevTools } from "../core/plugin-dev-tools.ts";

describe("createPluginDevTools", () => {
  it("wraps dev lifecycle operations as Agent-callable tools", async () => {
    const service = {
      installFromSource: vi.fn(async () => ({ ok: true, plugin: { id: "demo" } })),
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
    const tools = createPluginDevTools({ pluginDevService: service });
    const install = tools.find((tool) => tool.name === "plugin_dev_install");

    expect(tools.map((tool) => tool.name)).toContain("plugin_dev_uninstall");
    const result = await install.execute("call-1", {
      sourcePath: "/workspace/demo",
      pluginId: "demo",
      allowFullAccess: true,
    });

    expect(service.installFromSource).toHaveBeenCalledWith({
      sourcePath: "/workspace/demo",
      pluginId: "demo",
      allowFullAccess: true,
    });
    expect(result.details).toMatchObject({ ok: true, plugin: { id: "demo" } });
  });

  it("marks diagnostics as read-only and every dev mutation for review", () => {
    const service = {
      installFromSource: vi.fn(), reloadPlugin: vi.fn(), enablePlugin: vi.fn(),
      disablePlugin: vi.fn(), resetPlugin: vi.fn(), uninstallPlugin: vi.fn(),
      invokeTool: vi.fn(), getDiagnostics: vi.fn(), listSurfaces: vi.fn(),
      describeSurfaceDebug: vi.fn(), runScenario: vi.fn(),
    };
    const tools = createPluginDevTools({ pluginDevService: service });
    const descriptors = Object.fromEntries(tools.map((tool) => [
      tool.name,
      tool.sessionPermission.resolveInvocation(),
    ]));

    expect(descriptors.plugin_dev_diagnostics).toMatchObject({
      action: "diagnose",
      kind: "read",
      capability: "plugin_dev_diagnostics.diagnose",
    });
    expect(descriptors.plugin_dev_list_surfaces).toMatchObject({ kind: "read" });
    expect(descriptors.plugin_dev_describe_surface).toMatchObject({ kind: "read" });
    for (const name of [
      "plugin_dev_install",
      "plugin_dev_reload",
      "plugin_dev_enable",
      "plugin_dev_disable",
      "plugin_dev_reset",
      "plugin_dev_uninstall",
      "plugin_dev_invoke_tool",
      "plugin_dev_run_scenario",
    ]) {
      expect(descriptors[name], name).toMatchObject({ kind: "review" });
    }
  });

  it("passes session identity and agent context to dev plugin tool invocations", async () => {
    const service = {
      installFromSource: vi.fn(),
      reloadPlugin: vi.fn(),
      enablePlugin: vi.fn(),
      disablePlugin: vi.fn(),
      resetPlugin: vi.fn(),
      uninstallPlugin: vi.fn(),
      invokeTool: vi.fn(async () => ({ ok: true })),
      getDiagnostics: vi.fn(),
      listSurfaces: vi.fn(),
      describeSurfaceDebug: vi.fn(),
      runScenario: vi.fn(),
    };
    const tools = createPluginDevTools({
      pluginDevService: service,
      getAgentId: () => "hanako",
    });
    const invoke = tools.find((tool) => tool.name === "plugin_dev_invoke_tool");

    await invoke.execute(
      "call-1",
      { pluginId: "demo", toolName: "echo", input: { text: "hi" } },
      null,
      null,
      {
        sessionId: "sess_dev_tool",
        sessionRef: {
          sessionId: "sess_dev_tool",
          sessionPath: "/tmp/session.jsonl",
          legacySessionPath: "/tmp/legacy.jsonl",
        },
        sessionManager: { getSessionFile: () => "/tmp/ignored.jsonl" },
      },
    );

    expect(service.invokeTool).toHaveBeenCalledWith({
      pluginId: "demo",
      toolName: "echo",
      input: { text: "hi" },
      sessionPath: "/tmp/session.jsonl",
      sessionId: "sess_dev_tool",
      sessionRef: {
        sessionId: "sess_dev_tool",
        sessionPath: "/tmp/session.jsonl",
        legacySessionPath: "/tmp/legacy.jsonl",
      },
      agentId: "hanako",
    });
  });
});
