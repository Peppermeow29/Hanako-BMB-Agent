import { describe, expect, it } from "vitest";

describe("remote execution boundary", () => {
  it("validates a cloud Studio link to a local resource and execution node", async () => {
    const { validateServerNodeLink } = await import("../core/remote-execution-boundary.ts");

    expect(validateServerNodeLink({
      schemaVersion: 1,
      linkId: "link_home_mac",
      studioId: "studio_cloud",
      serverNodeId: "node_home_mac",
      nodeRole: "execution_node",
      transportKind: "relay",
      capabilities: ["resources.read", "execution.command", "resources.read"],
      status: "active",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    })).toMatchObject({
      studioId: "studio_cloud",
      serverNodeId: "node_home_mac",
      nodeRole: "execution_node",
      transportKind: "relay",
      capabilities: ["resources.read", "execution.command"],
    });
  });

  it("rejects unknown server node capabilities", async () => {
    const { validateServerNodeLink } = await import("../core/remote-execution-boundary.ts");

    expect(() => validateServerNodeLink({
      schemaVersion: 1,
      linkId: "link_bad",
      studioId: "studio_cloud",
      serverNodeId: "node_home_mac",
      nodeRole: "execution_node",
      transportKind: "relay",
      capabilities: ["resources.read", "shell.root"],
      status: "active",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    })).toThrow("unknown server node capability: shell.root");
  });

  it("validates an unexpired read-only execution lease", async () => {
    const { validateExecutionLease } = await import("../core/remote-execution-boundary.ts");

    expect(validateExecutionLease({
      schemaVersion: 1,
      leaseId: "lease_read",
      studioId: "studio_cloud",
      targetServerNodeId: "node_home_mac",
      agentId: "agent_writer",
      sessionId: "session_1",
      actorPrincipalId: "device_phone",
      mountId: "mount_projects",
      resourceIds: ["res_readme"],
      commandClass: "read_only",
      sandboxProfile: "read_only",
      backupPolicy: "none",
      expiresAt: "2026-05-16T00:05:00.000Z",
      createdAt: "2026-05-16T00:00:00.000Z",
    }, { now: "2026-05-16T00:01:00.000Z" })).toMatchObject({
      leaseId: "lease_read",
      commandClass: "read_only",
      sandboxProfile: "read_only",
      backupPolicy: "none",
    });
  });

  it("requires backup policy for write-capable execution leases", async () => {
    const { validateExecutionLease } = await import("../core/remote-execution-boundary.ts");

    expect(() => validateExecutionLease({
      schemaVersion: 1,
      leaseId: "lease_write",
      studioId: "studio_cloud",
      targetServerNodeId: "node_home_mac",
      agentId: "agent_writer",
      sessionId: "session_1",
      actorPrincipalId: "device_phone",
      commandClass: "write_files",
      sandboxProfile: "workspace_write",
      backupPolicy: "none",
      expiresAt: "2026-05-16T00:05:00.000Z",
      createdAt: "2026-05-16T00:00:00.000Z",
    }, { now: "2026-05-16T00:01:00.000Z" })).toThrow("write-capable execution lease requires backup policy");
  });

  it("rejects expired execution leases", async () => {
    const { validateExecutionLease } = await import("../core/remote-execution-boundary.ts");

    expect(() => validateExecutionLease({
      schemaVersion: 1,
      leaseId: "lease_expired",
      studioId: "studio_cloud",
      targetServerNodeId: "node_home_mac",
      agentId: "agent_writer",
      sessionId: "session_1",
      actorPrincipalId: "device_phone",
      commandClass: "read_only",
      sandboxProfile: "read_only",
      backupPolicy: "none",
      expiresAt: "2026-05-16T00:00:30.000Z",
      createdAt: "2026-05-16T00:00:00.000Z",
    }, { now: "2026-05-16T00:01:00.000Z" })).toThrow("execution lease expired");
  });
});
