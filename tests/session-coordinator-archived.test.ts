import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";
import { SessionManifestStore } from "../core/session-manifest/store.ts";

async function loadCoord(tmpDir, overrides: any = {}) {
  const { SessionCoordinator } = await import("../core/session-coordinator.ts");
  const deps = {
    agentsDir: path.join(tmpDir, "agents"),
    listAgents: () => [
      { id: "a", name: "AgentA" },
      { id: "b", name: "AgentB" },
    ],
    getAgent: (id) => id
      ? { id, agentName: `Agent${id.toUpperCase()}` }
      : { id: "a", agentName: "AgentA" },
    getActiveAgentId: () => "a",
    agentIdFromSessionPath: (p) => {
      const rel = path.relative(path.join(tmpDir, "agents"), p);
      return rel.split(path.sep)[0];
    },
    listDeletedAgents: () => [],
    isAgentDeleted: () => false,
    ...overrides,
  };
  return new SessionCoordinator(deps);
}

describe("session-coordinator: archived helpers", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "hana-coord-arch-"));
  });

  afterEach(() => {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clearSessionTitle removes entry from session-titles.json", async () => {
    const sessDir = path.join(tmpDir, "agents", "a", "sessions");
    await fs.mkdir(sessDir, { recursive: true });
    const sessionPath = path.join(sessDir, "s1.jsonl");
    const titlePath = path.join(sessDir, "session-titles.json");
    await fs.writeFile(
      titlePath,
      JSON.stringify({ [sessionPath]: "My Title", other: "keep" }),
    );

    const coord = await loadCoord(tmpDir);
    await coord.clearSessionTitle(sessionPath);

    const raw = JSON.parse(await fs.readFile(titlePath, "utf-8"));
    expect(raw[sessionPath]).toBeUndefined();
    expect(raw.other).toBe("keep");
  });

  it("clearSessionTitle is a no-op when titles.json missing", async () => {
    const sessDir = path.join(tmpDir, "agents", "a", "sessions");
    await fs.mkdir(sessDir, { recursive: true });
    const coord = await loadCoord(tmpDir);
    await expect(
      coord.clearSessionTitle(path.join(sessDir, "s1.jsonl")),
    ).resolves.toBeUndefined();
  });

  it("listArchivedSessions aggregates across agents, sorts by mtime desc", async () => {
    const aArch = path.join(tmpDir, "agents", "a", "sessions", "archived");
    const bArch = path.join(tmpDir, "agents", "b", "sessions", "archived");
    await fs.mkdir(aArch, { recursive: true });
    await fs.mkdir(bArch, { recursive: true });
    const now = Date.now();
    await fs.writeFile(path.join(aArch, "a1.jsonl"), "{}\n");
    await fs.utimes(
      path.join(aArch, "a1.jsonl"),
      (now - 86400000) / 1000,
      (now - 86400000) / 1000,
    );
    await fs.writeFile(path.join(bArch, "b1.jsonl"), "{}\n");
    await fs.utimes(
      path.join(bArch, "b1.jsonl"),
      (now - 3600_000) / 1000,
      (now - 3600_000) / 1000,
    );
    await fs.writeFile(path.join(bArch, "b2.jsonl"), "{}\n");
    await fs.utimes(path.join(bArch, "b2.jsonl"), now / 1000, now / 1000);

    const coord = await loadCoord(tmpDir);
    const list = await coord.listArchivedSessions();

    expect(list.length).toBe(3);
    expect(list.map((s) => path.basename(s.path))).toEqual([
      "b2.jsonl",
      "b1.jsonl",
      "a1.jsonl",
    ]);
    expect(list[0].agentId).toBe("b");
    expect(list[0].agentName).toBe("AgentB");
    expect(typeof list[0].sizeBytes).toBe("number");
    expect(list[0].archivedAt).toBeTruthy();
  });

  it("listArchivedSessions reads title from session-titles.json by active-path key", async () => {
    const sessDir = path.join(tmpDir, "agents", "a", "sessions");
    const aArch = path.join(sessDir, "archived");
    await fs.mkdir(aArch, { recursive: true });
    await fs.writeFile(path.join(aArch, "x.jsonl"), "{}\n");
    const activeKey = path.join(sessDir, "x.jsonl");
    await fs.writeFile(
      path.join(sessDir, "session-titles.json"),
      JSON.stringify({ [activeKey]: "Preserved" }),
    );

    const coord = await loadCoord(tmpDir);
    const list = await coord.listArchivedSessions();
    expect(list[0].title).toBe("Preserved");
  });

  it("listArchivedSessions reads title from legacy active-path sessionId", async () => {
    const sessDir = path.join(tmpDir, "agents", "a", "sessions");
    const aArch = path.join(sessDir, "archived");
    await fs.mkdir(aArch, { recursive: true });
    const archivedPath = path.join(aArch, "legacy.jsonl");
    const activeKey = path.join(sessDir, "legacy.jsonl");
    await fs.writeFile(archivedPath, "{}\n");
    const store = new SessionManifestStore({
      dbPath: path.join(tmpDir, "session-manifest.db"),
      idGenerator: () => "sess_legacy_active_title",
      now: () => "2026-06-25T01:00:00.000Z",
    });
    try {
      store.createForPath({
        sessionPath: activeKey,
        ownerAgentId: "a",
        domain: "desktop",
        kind: "chat",
        lifecycle: "active",
      });
      await fs.writeFile(
        path.join(sessDir, "session-titles.json"),
        JSON.stringify({ sess_legacy_active_title: "Legacy ID title" }),
      );

      const coord = await loadCoord(tmpDir, { sessionManifestStore: store });
      const list = await coord.listArchivedSessions();
      expect(list[0].title).toBe("Legacy ID title");
    } finally {
      store.close();
    }
  });

  it("listArchivedSessions returns stable sessionId for archived rows", async () => {
    const sessDir = path.join(tmpDir, "agents", "a", "sessions");
    const aArch = path.join(sessDir, "archived");
    await fs.mkdir(aArch, { recursive: true });
    const archivedPath = path.join(aArch, "stable.jsonl");
    await fs.writeFile(archivedPath, "{}\n");
    const store = new SessionManifestStore({
      dbPath: path.join(tmpDir, "session-manifest.db"),
      idGenerator: () => "sess_archived_stable",
      now: () => "2026-06-25T01:00:00.000Z",
    });
    try {
      const coord = await loadCoord(tmpDir, { sessionManifestStore: store });
      const list = await coord.listArchivedSessions();

      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        path: archivedPath,
        sessionId: "sess_archived_stable",
        agentId: "a",
      });
      expect(store.getBySessionId("sess_archived_stable")).toMatchObject({
        lifecycle: "archived",
        currentLocator: { path: path.resolve(archivedPath) },
      });
    } finally {
      store.close();
    }
  });

  it("listArchivedSessions includes deleted-agent archived sessions", async () => {
    const deletedArch = path.join(tmpDir, "agents", "deleted", "sessions", "archived");
    await fs.mkdir(deletedArch, { recursive: true });
    const archivedPath = path.join(deletedArch, "old.jsonl");
    await fs.writeFile(archivedPath, "{}\n");

    const coord = await loadCoord(tmpDir, {
      listAgents: () => [],
      listDeletedAgents: () => [{ id: "deleted", name: "Deleted Agent", deletedAt: "2026-06-03T01:03:00.000Z" }],
      isAgentDeleted: (id) => id === "deleted",
    });
    const list = await coord.listArchivedSessions();

    expect(list).toEqual([
      expect.objectContaining({
        path: archivedPath,
        agentId: "deleted",
        agentName: "Deleted Agent",
        agentDeleted: true,
        readOnlyReason: "agent_deleted",
        deletedAt: "2026-06-03T01:03:00.000Z",
      }),
    ]);
  });

  it("listSessions includes tombstoned agent sessions as read-only deleted-agent history", async () => {
    const sessDir = path.join(tmpDir, "agents", "deleted", "sessions");
    await fs.mkdir(sessDir, { recursive: true });
    const sessionPath = path.join(sessDir, "d1.jsonl");
    await fs.writeFile(
      sessionPath,
      [
        JSON.stringify({ type: "session", version: 3, id: "d1", timestamp: "2026-06-03T01:00:00.000Z", cwd: "/tmp/deleted" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-06-03T01:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "old hello" }], timestamp: 1 } }),
        JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-06-03T01:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "old reply" }], timestamp: 2 } }),
      ].join("\n") + "\n",
    );

    const { SessionCoordinator } = await import("../core/session-coordinator.ts");
    const coord = new SessionCoordinator({
      agentsDir: path.join(tmpDir, "agents"),
      listAgents: () => [],
      listDeletedAgents: () => [{ id: "deleted", name: "Deleted Agent", deletedAt: "2026-06-03T01:03:00.000Z" }],
      isAgentDeleted: (id) => id === "deleted",
      getAgent: () => ({ id: "a", agentName: "AgentA" }),
      getActiveAgentId: () => "a",
      agentIdFromSessionPath: (p) => path.relative(path.join(tmpDir, "agents"), p).split(path.sep)[0],
    });

    const list = await coord.listSessions();
    expect(list).toEqual([
      expect.objectContaining({
        path: sessionPath,
        agentId: "deleted",
        agentName: "Deleted Agent",
        agentDeleted: true,
        readOnlyReason: "agent_deleted",
        continuationAvailable: true,
      }),
    ]);
  });
});
