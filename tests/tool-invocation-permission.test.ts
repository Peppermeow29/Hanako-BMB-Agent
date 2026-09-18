import { describe, expect, it, vi } from "vitest";
import {
  invocationTargetKey,
  resolveToolInvocationPermission,
  snapshotToolInvocationInput,
} from "../lib/permission/tool-invocation-permission.ts";
import { createDmTool } from "../lib/tools/dm-tool.ts";
import { createNotifyTool } from "../lib/tools/notify-tool.ts";
import { createPinnedMemoryTools } from "../lib/tools/pinned-memory.ts";
import { createExperienceTools } from "../lib/tools/experience.ts";
import {
  createStageFilesTool,
  normalizeStageFilesParams,
} from "../lib/tools/output-file-tool.ts";
import { createExecCommandTools } from "../lib/exec-command/tool.ts";

function resolveDescriptor(tool: Record<string, unknown>, input: unknown) {
  const result = resolveToolInvocationPermission(tool, input);
  expect(result).toMatchObject({ ok: true, source: "descriptor" });
  if (!result.ok || result.source !== "descriptor") {
    throw new Error("expected a normalized invocation descriptor");
  }
  return result;
}

function resolveInvocationForTest({ sideEffect }: { sideEffect: Record<string, unknown> }) {
  const tool = {
    name: "side_effect_probe",
    sessionPermission: {
      resolveInvocation: () => ({
        action: "run",
        kind: "review",
        capability: "side_effect_probe.run",
        sideEffect,
      }),
    },
  };
  return resolveToolInvocationPermission(tool, {});
}

describe("tool invocation permission contract", () => {
  it("snapshots bounded plain JSON without evaluating accessors", () => {
    const getter = vi.fn(() => "secret");
    const unsafe = {} as Record<string, unknown>;
    Object.defineProperty(unsafe, "value", { enumerable: true, get: getter });

    expect(snapshotToolInvocationInput({ nested: [1, "two", true] })).toMatchObject({
      ok: true,
      value: { nested: [1, "two", true] },
    });
    expect(snapshotToolInvocationInput(unsafe)).toEqual({ ok: false, reason: "invalid_input" });
    expect(getter).not.toHaveBeenCalled();

    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(snapshotToolInvocationInput(cyclic)).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("normalizes a tool-owned descriptor and excludes labels from target revalidation", () => {
    const makeTool = (label: string) => ({
      name: "channel",
      sessionPermission: {
        resolveInvocation: () => ({
          action: "post",
          kind: "review",
          capability: "channel.post",
          target: { type: "channel", id: "ch_team", label },
        }),
      },
    });

    const first = resolveDescriptor(makeTool("Team"), {});
    const renamed = resolveDescriptor(makeTool("Renamed Team"), {});

    expect(first.descriptor).toEqual({
      action: "post",
      kind: "review",
      capability: "channel.post",
      target: { type: "channel", id: "ch_team", label: "Team" },
    });
    expect(first.targetKey).toBe(renamed.targetKey);
    expect(first.targetKey).toBe(invocationTargetKey({ type: "channel", id: "ch_team" }));
  });

  it("accepts read, routine, and review as the complete action-class vocabulary", () => {
    for (const kind of ["read", "routine", "review"] as const) {
      const descriptor = resolveDescriptor({
        name: "terminal",
        sessionPermission: {
          resolveInvocation: () => ({
            action: "start",
            kind,
            capability: "terminal.start",
          }),
        },
      }, {});

      expect(descriptor.descriptor).toMatchObject({ action: "start", kind, capability: "terminal.start" });
    }
  });

  it("keeps resolver-less plugin tools on the legacy static permission path", () => {
    const sessionPermission = {
      kind: "external_side_effect",
      describeSideEffect: () => ({ kind: "external_api" }),
    };
    const tool = {
      name: "calendar_create",
      _pluginId: "calendar",
      sessionPermission,
    };

    const result = resolveToolInvocationPermission(tool, { title: "Review" });

    expect(result).toMatchObject({
      ok: true,
      source: "legacy",
      descriptor: null,
      targetKey: null,
      sessionPermission: {
        kind: "external_side_effect",
        describeSideEffect: sessionPermission.describeSideEffect,
      },
    });
    if (!result.ok || result.source !== "legacy") throw new Error("expected legacy permission metadata");
    expect(result.sessionPermission).not.toBe(sessionPermission);
  });

  it("fails closed on permission accessors, non-plain metadata, and inherited resolvers", () => {
    const accessorTool = { name: "channel" } as Record<string, unknown>;
    Object.defineProperty(accessorTool, "sessionPermission", {
      configurable: true,
      get() { throw new Error("private getter detail"); },
    });

    const resolverAccessor: Record<string, unknown> = {};
    Object.defineProperty(resolverAccessor, "resolveInvocation", {
      configurable: true,
      get() { throw new Error("private resolver getter detail"); },
    });

    const inheritedResolver = Object.create({
      resolveInvocation: () => ({ action: "read", kind: "read", capability: "channel.read" }),
    });

    for (const tool of [
      accessorTool,
      { name: "channel", sessionPermission: new Map() },
      { name: "channel", sessionPermission: resolverAccessor },
      { name: "channel", sessionPermission: inheritedResolver },
    ]) {
      expect(resolveToolInvocationPermission(tool, { action: "read" })).toMatchObject({
        ok: false,
        source: "resolver",
      });
    }
  });

  it("copies only own legacy metadata and ignores a polluted prototype readOnly", () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "readOnly");
    Object.defineProperty(Object.prototype, "readOnly", {
      configurable: true,
      value: true,
    });
    try {
      const result = resolveToolInvocationPermission({
        name: "legacy_status",
        sessionPermission: { kind: "external_side_effect" },
      }, {});

      expect(result).toMatchObject({ ok: true, source: "legacy" });
      if (!result.ok || result.source !== "legacy") throw new Error("expected sanitized legacy metadata");
      expect(result.sessionPermission?.readOnly).toBeUndefined();
      expect(Object.hasOwn(result.sessionPermission || {}, "readOnly")).toBe(false);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "readOnly", previous);
      else delete (Object.prototype as Record<string, unknown>).readOnly;
    }
  });

  it("consumes rejected async resolvers without leaking or emitting unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = resolveToolInvocationPermission({
        name: "channel",
        sessionPermission: {
          resolveInvocation: async () => { throw new Error("private async rejection"); },
        },
      }, { action: "read" });

      expect(result).toMatchObject({
        ok: false,
        error: { reason: "async_resolver" },
      });
      if (!("error" in result)) throw new Error("expected async resolver failure");
      expect(result.error.message).not.toContain("private async rejection");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not assume a generic input action field is the permission discriminator", () => {
    const connector = {
      name: "connector",
      sessionPermission: {
        resolveInvocation: () => ({
          action: "invoke",
          kind: "review",
          capability: "connector.invoke",
        }),
      },
    };

    expect(resolveToolInvocationPermission(connector, { action: "delete_calendar_event" })).toMatchObject({
      ok: true,
      descriptor: { action: "invoke", kind: "review" },
    });
  });

  it.each([
    ["resolver throws", {
      name: "channel",
      sessionPermission: { resolveInvocation: () => { throw new Error("boom"); } },
    }, "resolver_threw"],
    ["resolver rejects unknown action", {
      name: "channel",
      sessionPermission: { resolveInvocation: () => null },
    }, "resolver_rejected"],
    ["resolver is asynchronous", {
      name: "channel",
      sessionPermission: { resolveInvocation: async () => ({ action: "read" }) },
    }, "async_resolver"],
    ["kind is unknown", {
      name: "channel",
      sessionPermission: { resolveInvocation: () => ({ action: "read", kind: "readonly", capability: "channel.read" }) },
    }, "unknown_kind"],
    ["capability does not match the executing tool and action", {
      name: "channel",
      sessionPermission: { resolveInvocation: () => ({ action: "read", kind: "read", capability: "terminal.read" }) },
    }, "unknown_capability"],
    ["target contains a wildcard", {
      name: "channel",
      sessionPermission: { resolveInvocation: () => ({
        action: "post",
        kind: "review",
        capability: "channel.post",
        target: { type: "channel", id: "ch_*" },
      }) },
    }, "invalid_target"],
    ["tool declares host-owned session identity", {
      name: "channel",
      sessionPermission: { resolveInvocation: () => ({
        action: "post",
        kind: "review",
        capability: "channel.post",
        target: { type: "channel", id: "ch_team" },
        sideEffect: { context: { sessionId: "sess_forged" } },
      }) },
    }, "host_identity_forbidden"],
  ])("fails closed when %s", (_label, tool, reason) => {
    const result = resolveToolInvocationPermission(tool, { action: "delete" });

    expect(result).toMatchObject({
      ok: false,
      source: "resolver",
      error: { reason },
    });
  });

  it("uses the unprefixed plugin tool name for capability binding", () => {
    const tool = {
      name: "calendar_send",
      _pluginId: "calendar",
      sessionPermission: {
        resolveInvocation: () => ({
          action: "deliver",
          kind: "review",
          capability: "send.deliver",
        }),
      },
    };

    expect(resolveDescriptor(tool, {}).descriptor.capability).toBe("send.deliver");
  });

  it("accepts sideEffect strings containing newlines and tabs", () => {
    const result = resolveInvocationForTest({
      sideEffect: { kind: "command", command: "python - <<'EOF'\nprint(1)\nEOF\t# done" },
    });
    expect(result.ok).toBe(true);
  });

  it("still rejects sideEffect strings containing ESC and other control characters", () => {
    const result = resolveInvocationForTest({
      sideEffect: { kind: "command", command: "echo \x1b[31mred" },
    });
    expect(result.ok).toBe(false);
  });

  it("does not expose resolver exceptions and rejects control characters in targets", () => {
    const thrown = resolveToolInvocationPermission({
      name: "channel",
      sessionPermission: {
        resolveInvocation: () => { throw new Error("private filesystem detail"); },
      },
    }, {});
    const controlled = resolveToolInvocationPermission({
      name: "channel",
      sessionPermission: {
        resolveInvocation: () => ({
          action: "post",
          kind: "review",
          capability: "channel.post",
          target: { type: "channel", id: "ch_team\u0001" },
        }),
      },
    }, {});

    expect(thrown).toMatchObject({ ok: false, error: { reason: "resolver_threw" } });
    if (!("error" in thrown)) throw new Error("expected resolver failure");
    expect(thrown.error.message).not.toContain("private filesystem detail");
    expect(controlled).toMatchObject({ ok: false, error: { reason: "invalid_target" } });
  });

  it("limits target ids passed to reviewer and revalidation boundaries", () => {
    const makeTool = (id: string) => ({
      name: "channel",
      sessionPermission: {
        resolveInvocation: () => ({
          action: "post",
          kind: "review",
          capability: "channel.post",
          target: { type: "channel", id, label: "Team" },
        }),
      },
    });

    expect(resolveToolInvocationPermission(makeTool("a".repeat(4096)), {})).toMatchObject({ ok: true });
    expect(resolveToolInvocationPermission(makeTool("a".repeat(4097)), {})).toMatchObject({
      ok: false,
      error: { reason: "invalid_target" },
    });
  });
});

describe("action-level tool descriptors", () => {
  it("canonicalizes DM recipients to one stable reviewer target", () => {
    const tool = createDmTool({
      agentId: "hana",
      agentsDir: "/tmp/agents",
      listAgents: () => [
        { id: "hana", name: "Hana" },
        { id: "yui", name: "Yui" },
      ],
      onDmSent: undefined,
      isEnabled: undefined,
    });

    const result = resolveDescriptor(tool, { to: "Yui", message: "hello" });

    expect(result.descriptor).toMatchObject({
      action: "send",
      kind: "review",
      capability: "dm.send",
      target: { type: "agent", id: "yui", label: "Yui" },
    });

    const unnamedTool = createDmTool({
      agentId: "hana",
      agentsDir: "/tmp/agents",
      listAgents: () => [{ id: "hana" }, { id: "yui" }],
      onDmSent: undefined,
      isEnabled: undefined,
    });
    expect(resolveDescriptor(unnamedTool, { to: "yui", message: "hello" }).descriptor)
      .toMatchObject({ target: { id: "yui", label: "yui" } });
  });

  it("builds a stable notification route independent of array order", () => {
    const tool = createNotifyTool({ onNotify: async () => ({ ok: true }) });
    const first = resolveDescriptor(tool, {
      title: "Build",
      body: "Done",
      channels: ["bridge_owner", "desktop"],
      bridgePlatforms: ["wechat", "feishu"],
    });
    const reordered = resolveDescriptor(tool, {
      title: "Build",
      body: "Done",
      channels: ["desktop", "bridge_owner"],
      bridgePlatforms: ["feishu", "wechat"],
    });

    expect(first.descriptor).toMatchObject({
      action: "send",
      capability: "notify.send",
      target: { type: "notification_route" },
    });
    expect(first.targetKey).toBe(reordered.targetKey);

    expect(resolveDescriptor(tool, { title: "Build", body: "Done" }).descriptor)
      .toMatchObject({
        target: { type: "notification_route", label: "context default" },
      });
  });

  it("describes pinned-memory and experience write targets", () => {
    const [pin, unpin] = createPinnedMemoryTools("/tmp/agent");
    const [, record] = createExperienceTools("/tmp/agent", { isEnabled: () => true });

    expect(resolveDescriptor(pin, { content: "Remember this" }).descriptor).toMatchObject({
      action: "pin",
      capability: "pin_memory.pin",
      target: { type: "memory_store", id: "pinned" },
    });
    expect(resolveDescriptor(unpin, { id: "pin_1", keyword: "old" }).descriptor).toMatchObject({
      action: "unpin",
      capability: "unpin_memory.unpin",
      target: { type: "pinned_memory_query" },
    });
    expect(resolveDescriptor(record, { category: "Tool usage", content: "Use exact ids" }).descriptor).toMatchObject({
      action: "record",
      capability: "record_experience.record",
      target: { type: "experience_category", label: "Tool usage" },
    });
  });

  it("describes experience read targets", () => {
    const [recall] = createExperienceTools("/tmp/agent", { isEnabled: () => true });

    const overview = resolveDescriptor(recall, {}).descriptor;
    expect(overview).toMatchObject({
      action: "read",
      kind: "read",
      capability: "recall_experience.read",
    });
    expect(overview.target).toBeUndefined();

    expect(resolveDescriptor(recall, { category: "Tool usage" }).descriptor).toMatchObject({
      action: "read",
      kind: "read",
      capability: "recall_experience.read",
      target: { type: "experience_category", label: "Tool usage" },
    });

    const invalidCategory = resolveDescriptor(recall, { category: "bad/../name" }).descriptor;
    expect(invalidCategory).toMatchObject({
      action: "read",
      kind: "read",
      capability: "recall_experience.read",
    });
    expect(invalidCategory.target).toBeUndefined();

    expect(resolveToolInvocationPermission(recall, { category: 42 })).toMatchObject({
      ok: false,
      source: "resolver",
      error: { reason: "resolver_rejected" },
    });
  });

  it("sorts multi-file targets and classifies direct terminal input for review", () => {
    const stage = createStageFilesTool();
    const [, writeStdin] = createExecCommandTools();

    const first = resolveDescriptor(stage, { fileIds: ["sf_b", "sf_a"] });
    const reordered = resolveDescriptor(stage, { fileIds: ["sf_a", "sf_b"] });
    const stdin = resolveDescriptor(writeStdin, { process_id: "term_1", chars: "q" });
    const poll = resolveDescriptor(writeStdin, { process_id: "term_1" });

    expect(first.descriptor).toMatchObject({
      action: "stage",
      capability: "stage_files.stage",
      target: { type: "session_files" },
    });
    expect(first.targetKey).toBe(reordered.targetKey);
    expect(stdin.descriptor).toMatchObject({
      action: "write",
      kind: "review",
      capability: "write_stdin.write",
      target: { type: "terminal_process", id: "term_1" },
    });
    expect(poll.descriptor).toMatchObject({
      action: "poll",
      kind: "read",
      capability: "write_stdin.poll",
      target: { type: "terminal_process", id: "term_1" },
    });
  });

  it("treats contained one-shot commands as routine while preserving boundary details", () => {
    let sandboxed = true;
    const [execCommand] = createExecCommandTools({
      isOneShotSandboxEnforced: () => sandboxed,
      platform: "linux",
    });

    expect(resolveDescriptor(execCommand, { cmd: "npm test" }).descriptor).toMatchObject({
      kind: "routine",
      sideEffect: {
        sandboxPermissions: "use_default",
        networkAccess: "blocked",
        hostIpcAccess: "available",
      },
    });
    expect(resolveDescriptor(execCommand, {
      cmd: "npm view vitest version",
      sandbox_permissions: "require_escalated",
    }).descriptor).toMatchObject({
      kind: "review",
      sideEffect: {
        sandboxPermissions: "require_escalated",
        networkAccess: "review_required",
        hostIpcAccess: "review_required",
      },
    });
    sandboxed = false;
    expect(resolveDescriptor(execCommand, { cmd: "npm test" }).descriptor.kind).toBe("review");
    sandboxed = true;
    expect(resolveDescriptor(execCommand, { cmd: "npm test", tty: true }).descriptor.kind).toBe("review");

    const [windowsExecCommand] = createExecCommandTools({
      isOneShotSandboxEnforced: () => true,
      platform: "win32",
    });
    expect(resolveDescriptor(windowsExecCommand, { cmd: "Get-Location" }).descriptor.kind).toBe("review");
  });

  it("normalizes empty plural and singular stage_files inputs through one contract", () => {
    expect(normalizeStageFilesParams({ fileIds: [], fileId: "sf_single" })).toMatchObject({
      ok: true,
      value: { fileIds: ["sf_single"], filepaths: [] },
    });
    expect(normalizeStageFilesParams({ fileIds: ["sf_plural"], fileId: "sf_ignored" })).toMatchObject({
      ok: true,
      value: { fileIds: ["sf_plural"], filepaths: [] },
    });
    expect(normalizeStageFilesParams({ filepaths: [], filePath: "/tmp/single.txt" })).toMatchObject({
      ok: true,
      value: { fileIds: [], filepaths: ["/tmp/single.txt"] },
    });
    expect(normalizeStageFilesParams({ filepaths: ["/tmp/plural.txt"], filePath: "/tmp/ignored.txt" })).toMatchObject({
      ok: true,
      value: { fileIds: [], filepaths: ["/tmp/plural.txt"] },
    });
  });
});
