import { describe, expect, it } from "vitest";
import {
  registerToolCapabilityDelegate,
  resolveToolInvocationPermission,
  unregisterToolCapabilityDelegate,
} from "../lib/permission/tool-invocation-permission.ts";

function bridgeLikeTool(extra: Record<string, unknown> = {}) {
  return {
    name: "mcp_call",
    sessionPermission: {
      resolveInvocation: (params: any) => ({
        action: "invoke",
        kind: "review",
        capability: `${params?.tool}.invoke`,
      }),
    },
    ...extra,
  };
}

describe("tool capability delegation registry", () => {
  it("rejects a foreign capability when the tool object is not registered", () => {
    const tool = bridgeLikeTool();
    const result = resolveToolInvocationPermission(tool, { tool: "github_create_issue" });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "unknown_capability" },
    });
  });

  it("accepts a foreign capability once the host registers the object and the predicate passes", () => {
    const tool = bridgeLikeTool();
    registerToolCapabilityDelegate(tool, (capability) => capability === "github_create_issue.invoke");
    try {
      const result = resolveToolInvocationPermission(tool, { tool: "github_create_issue" });
      expect(result).toMatchObject({
        ok: true,
        source: "descriptor",
        descriptor: { capability: "github_create_issue.invoke", action: "invoke", kind: "review" },
      });
    } finally {
      unregisterToolCapabilityDelegate(tool);
    }
  });

  it("rejects when the predicate returns false", () => {
    const tool = bridgeLikeTool();
    registerToolCapabilityDelegate(tool, (capability) => capability === "only_this.invoke");
    try {
      expect(resolveToolInvocationPermission(tool, { tool: "something_else" })).toMatchObject({
        ok: false,
        error: { reason: "unknown_capability" },
      });
    } finally {
      unregisterToolCapabilityDelegate(tool);
    }
  });

  it("requires exactly true from the predicate", () => {
    const tool = bridgeLikeTool();
    registerToolCapabilityDelegate(tool, (() => "yes") as any);
    try {
      expect(resolveToolInvocationPermission(tool, { tool: "github_create_issue" })).toMatchObject({
        ok: false,
        error: { reason: "unknown_capability" },
      });
    } finally {
      unregisterToolCapabilityDelegate(tool);
    }
  });

  it("fails closed when the predicate throws", () => {
    const tool = bridgeLikeTool();
    registerToolCapabilityDelegate(tool, () => {
      throw new Error("hostile");
    });
    try {
      expect(resolveToolInvocationPermission(tool, { tool: "github_create_issue" })).toMatchObject({
        ok: false,
        error: { reason: "unknown_capability" },
      });
    } finally {
      unregisterToolCapabilityDelegate(tool);
    }
  });

  it("ignores a delegation field the tool declares about itself", () => {
    // Self-declared trust must be worthless: only the host-held registry counts.
    const tool = bridgeLikeTool({
      capabilityDelegate: () => true,
      _capabilityDelegate: () => true,
      allowForeignCapability: true,
    });
    expect(resolveToolInvocationPermission(tool, { tool: "github_create_issue" })).toMatchObject({
      ok: false,
      error: { reason: "unknown_capability" },
    });
  });

  it("does not extend a registration to a structurally identical copy", () => {
    const tool = bridgeLikeTool();
    registerToolCapabilityDelegate(tool, () => true);
    try {
      const impostor = { ...tool };
      expect(resolveToolInvocationPermission(impostor, { tool: "github_create_issue" })).toMatchObject({
        ok: false,
        error: { reason: "unknown_capability" },
      });
    } finally {
      unregisterToolCapabilityDelegate(tool);
    }
  });

  it("stops honouring delegation after the registration is withdrawn", () => {
    const tool = bridgeLikeTool();
    registerToolCapabilityDelegate(tool, () => true);
    expect(resolveToolInvocationPermission(tool, { tool: "github_create_issue" })).toMatchObject({ ok: true });
    unregisterToolCapabilityDelegate(tool);
    expect(resolveToolInvocationPermission(tool, { tool: "github_create_issue" })).toMatchObject({
      ok: false,
      error: { reason: "unknown_capability" },
    });
  });

  it("still rejects an empty or malformed capability from a registered tool", () => {
    const tool = {
      name: "mcp_call",
      sessionPermission: {
        resolveInvocation: () => ({ action: "invoke", kind: "review", capability: "" }),
      },
    };
    registerToolCapabilityDelegate(tool, () => true);
    try {
      expect(resolveToolInvocationPermission(tool, {})).toMatchObject({
        ok: false,
        error: { reason: "unknown_capability" },
      });
    } finally {
      unregisterToolCapabilityDelegate(tool);
    }
  });

  it("leaves a tool that declares its own capability entirely unaffected", () => {
    const tool = {
      name: "plain_tool",
      sessionPermission: {
        resolveInvocation: () => ({ action: "read", kind: "read", capability: "plain_tool.read" }),
      },
    };
    expect(resolveToolInvocationPermission(tool, {})).toMatchObject({
      ok: true,
      source: "descriptor",
      descriptor: { capability: "plain_tool.read" },
    });
  });

  it("refuses to register a non object or a non function predicate", () => {
    expect(() => registerToolCapabilityDelegate(null as any, () => true)).toThrow(/tool object/i);
    expect(() => registerToolCapabilityDelegate({}, null as any)).toThrow(/predicate/i);
  });
});
