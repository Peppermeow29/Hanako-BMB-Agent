import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../hub/event-bus.ts";
import {
  PluginBusCapabilityError,
  createPluginRouteRequestContext,
} from "../core/plugin-route-request-context.ts";

function makeBusWithSessionCreate() {
  const bus = new EventBus();
  const handler = vi.fn(async () => ({ ok: true, sessionPath: "/agents/hana/sessions/new.jsonl" }));
  bus.handle("session:create", handler);
  return { bus, handler };
}

function makeContext(overrides: any = {}) {
  const bus = overrides.bus || makeBusWithSessionCreate().bus;
  return createPluginRouteRequestContext({
    pluginCtx: { pluginId: "media-board", bus },
    accessLevel: overrides.accessLevel ?? "full-access",
    // 不做 ?? [] 兜底：null / undefined 表示"manifest 缺失该字段"（legacy 候选），
    // [] 表示"显式声明空"，两者契约不同，必须由各测试显式给出。
    capabilities: overrides.capabilities,
    sensitiveCapabilities: overrides.sensitiveCapabilities,
    principal: overrides.principal ?? null,
    agentId: overrides.agentId ?? null,
  });
}

describe("createPluginRouteRequestContext", () => {
  it("exposes request principal, plugin identity, and capability grant", () => {
    const principal = {
      kind: "plugin",
      pluginId: "media-board",
      credentialKind: "plugin_surface_session",
      connectionKind: "local",
    };
    const ctx = makeContext({
      capabilities: ["session"],
      principal,
      agentId: "hanako",
    });

    expect(ctx.pluginId).toBe("media-board");
    expect(ctx.agentId).toBe("hanako");
    expect(ctx.principal).toMatchObject({
      kind: "plugin",
      pluginId: "media-board",
      credentialKind: "plugin_surface_session",
    });
    expect(ctx.capabilityGrant).toMatchObject({
      accessLevel: "full-access",
      declaredPermissions: ["session"],
      legacyDeclaration: false,
    });
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it("allows declared sensitive capabilities for granted full-access plugins", async () => {
    const { bus, handler } = makeBusWithSessionCreate();
    const ctx = makeContext({ bus, capabilities: ["session"] });

    const result = await ctx.bus.request("session:create", { agentId: "hanako" });

    expect(result).toMatchObject({ ok: true, sessionPath: expect.any(String) });
    expect(handler).toHaveBeenCalledWith({ agentId: "hanako" }, null);
  });

  it("accepts exact permission declarations through sensitiveCapabilities", async () => {
    const { bus, handler } = makeBusWithSessionCreate();
    const ctx = makeContext({ bus, sensitiveCapabilities: ["session.write"] });

    await ctx.bus.request("session:create", {});

    expect(handler).toHaveBeenCalled();
  });

  it("keeps legacy manifests without capability declarations working", async () => {
    const { bus, handler } = makeBusWithSessionCreate();
    // 老 manifest 完全没写两个声明字段 → null/undefined 透传 → legacy 放行
    const ctx = makeContext({ bus, capabilities: null, sensitiveCapabilities: undefined });

    await ctx.bus.request("session:create", {});

    expect(handler).toHaveBeenCalled();
    expect(ctx.capabilityGrant.legacyDeclaration).toBe(true);
  });

  it("treats explicitly empty capability declarations as strict denial, not legacy", async () => {
    const { bus, handler } = makeBusWithSessionCreate();
    // 作者显式声明"我不需要任何敏感 capability"——必须严格拒绝，不得全放行
    const ctx = makeContext({ bus, capabilities: [], sensitiveCapabilities: [] });

    expect(ctx.capabilityGrant.legacyDeclaration).toBe(false);
    expect(ctx.capabilityGrant.declaredPermissions).toEqual([]);
    try {
      await ctx.bus.request("session:create", {});
      throw new Error("expected capability rejection");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PluginBusCapabilityError);
      expect(err.code).toBe("PLUGIN_CAPABILITY_NOT_DECLARED");
      expect(err.status).toBe(403);
      expect(err.declared).toBe(false);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("treats a single explicitly declared list as strict even when the other is missing", async () => {
    const { bus, handler } = makeBusWithSessionCreate();
    // 一旦显式声明任一列表（这里是空 capabilities），legacy 不再成立
    const ctx = makeContext({ bus, capabilities: [], sensitiveCapabilities: null });

    expect(ctx.capabilityGrant.legacyDeclaration).toBe(false);
    await expect(ctx.bus.request("session:create", {})).rejects.toMatchObject({
      code: "PLUGIN_CAPABILITY_NOT_DECLARED",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects undeclared sensitive capabilities with a diagnosable error", async () => {
    const { bus, handler } = makeBusWithSessionCreate();
    const ctx = makeContext({ bus, capabilities: ["agent"] });

    try {
      await ctx.bus.request("session:create", {});
      throw new Error("expected capability rejection");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PluginBusCapabilityError);
      expect(err.code).toBe("PLUGIN_CAPABILITY_NOT_DECLARED");
      expect(err.status).toBe(403);
      expect(err.capability).toBe("session:create");
      expect(err.permission).toBe("session.write");
      expect(err.pluginId).toBe("media-board");
      expect(err.declared).toBe(false);
      expect(err.granted).toBe(true);
      expect(err.message).toContain("session:create");
      expect(err.message).toContain("session.write");
      expect(err.message).toContain("manifest");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects sensitive capabilities for plugins without user-granted full access", async () => {
    const { bus, handler } = makeBusWithSessionCreate();
    const ctx = makeContext({ bus, accessLevel: "restricted", capabilities: ["session"] });

    try {
      await ctx.bus.request("session:create", {});
      throw new Error("expected grant rejection");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PluginBusCapabilityError);
      expect(err.code).toBe("PLUGIN_CAPABILITY_NOT_GRANTED");
      expect(err.capability).toBe("session:create");
      expect(err.permission).toBe("session.write");
      expect(err.declared).toBe(true);
      expect(err.granted).toBe(false);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes plugin-owned and unregistered capability types through without the gate", async () => {
    const bus = new EventBus();
    const customHandler = vi.fn(async () => ({ ok: true }));
    bus.handle("media-board:refresh", customHandler, {
      capability: {
        type: "media-board:refresh",
        owner: "plugin",
        permission: "plugin.bus.request",
      },
    });
    const unregisteredHandler = vi.fn(async () => "pong");
    bus.handle("media-board:ping", unregisteredHandler);
    const ctx = makeContext({ bus, capabilities: ["agent"] });

    await ctx.bus.request("media-board:refresh", {});
    await ctx.bus.request("media-board:ping", {});

    expect(customHandler).toHaveBeenCalled();
    expect(unregisteredHandler).toHaveBeenCalled();
  });

  it("delegates emit, subscribe, and capability lookups to the plugin bus", () => {
    const { bus } = makeBusWithSessionCreate();
    const ctx = makeContext({ bus, capabilities: ["session"] });
    const seen: any[] = [];
    const unsubscribe = ctx.bus.subscribe((event: any) => seen.push(event), { types: ["demo_event"] });

    ctx.bus.emit({ type: "demo_event", value: 1 }, null);
    unsubscribe();
    ctx.bus.emit({ type: "demo_event", value: 2 }, null);

    expect(seen).toEqual([{ type: "demo_event", value: 1 }]);
    expect(ctx.bus.hasHandler("session:create")).toBe(true);
    expect(ctx.bus.getCapability("session:create")).toMatchObject({ permission: "session.write" });
  });
});
