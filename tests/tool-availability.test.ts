import { describe, expect, it, vi } from "vitest";
import {
  computeAvailableToolNames,
  computeReminderLiveToolAvailability,
  filterToolObjectsByAvailability,
} from "../core/tool-availability.ts";
import { buildLlmContextCachePrefixContract } from "../lib/llm/cache-prefix-contract.ts";

describe("Reminder live tool availability", () => {
  const agentConfig = { tools: { disabled: [] } };

  it("keeps ordinary tools and ready probed tools in the normal live-name baseline", () => {
    const tools = [
      { name: "read" },
      {
        name: "mcp_github_search",
        metadata: {
          reminderLiveAvailabilityProbe: () => ({ available: true }),
        },
      },
    ];

    expect(computeAvailableToolNames(tools, agentConfig)).toEqual([
      "read",
      "mcp_github_search",
    ]);
    expect(computeReminderLiveToolAvailability(tools, agentConfig)).toEqual({
      availableToolNames: ["read", "mcp_github_search"],
      diagnostics: [],
    });
  });

  it("removes a probe-reported outage only from Reminder availability", () => {
    const unavailableTool = {
      name: "mcp_github_search",
      metadata: {
        reminderLiveAvailabilityProbe: () => ({
          available: false,
          reason: "mcp_connector_stopped",
          diagnostics: { connectorId: "github", status: "stopped" },
        }),
      },
    };
    const tools = [{ name: "read" }, unavailableTool];

    expect(computeAvailableToolNames(tools, agentConfig)).toContain("mcp_github_search");
    expect(filterToolObjectsByAvailability(tools, agentConfig)).toContain(unavailableTool);
    expect(computeReminderLiveToolAvailability(tools, agentConfig)).toEqual({
      availableToolNames: ["read"],
      diagnostics: [{
        toolName: "mcp_github_search",
        reason: "mcp_connector_stopped",
        diagnostics: { connectorId: "github", status: "stopped" },
      }],
    });
  });

  it("fails a throwing probe open without inventing an unavailable-tool reminder", () => {
    const warn = vi.fn();
    const throwingTool = {
      name: "mcp_github_search",
      reminderLiveAvailabilityProbe: () => {
        throw new Error("status registry temporarily unavailable");
      },
    };
    const tools = [{ name: "read" }, throwingTool];

    expect(computeAvailableToolNames(tools, agentConfig)).toContain("mcp_github_search");
    expect(filterToolObjectsByAvailability(tools, agentConfig)).toContain(throwingTool);
    expect(computeReminderLiveToolAvailability(tools, agentConfig, {}, { warn })).toEqual({
      availableToolNames: ["read", "mcp_github_search"],
      diagnostics: [{
        toolName: "mcp_github_search",
        reason: "probe_error",
        diagnostics: { message: "status registry temporarily unavailable" },
      }],
    });
    expect(warn).toHaveBeenCalledWith(
      'tool "mcp_github_search" Reminder live availability probe failed: status registry temporarily unavailable',
    );
  });

  it("preserves the existing behavior for tools without a Reminder probe", () => {
    const tools = [{ name: "read" }, { name: "plain_plugin_tool", _pluginId: "plain" }];

    expect(computeReminderLiveToolAvailability(tools, agentConfig)).toEqual({
      availableToolNames: computeAvailableToolNames(tools, agentConfig),
      diagnostics: [],
    });
  });

  it("keeps the optional probe outside the provider cache-prefix contract", () => {
    const baseTool = {
      name: "mcp_github_search",
      description: "Search GitHub",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    };
    const probedTool = {
      ...baseTool,
      metadata: {
        reminderLiveAvailabilityProbe: () => ({ available: false }),
      },
    };

    const base = buildLlmContextCachePrefixContract({ tools: [baseTool] });
    const withProbe = buildLlmContextCachePrefixContract({ tools: [probedTool] });
    expect(withProbe.toolSchemaHash).toBe(base.toolSchemaHash);
    expect(withProbe.cachePrefixHash).toBe(base.cachePrefixHash);
  });
});
