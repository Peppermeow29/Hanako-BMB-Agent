import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createMemoryDreamRoute } from "../server/routes/memory-dream.ts";

function mount(agent: any) {
  const engine = {
    getAgent: vi.fn((id) => id === agent.id ? agent : null),
  };
  const app = new Hono();
  app.route("/api", createMemoryDreamRoute(engine));
  return { app, engine };
}

describe("Memory Dream routes", () => {
  it("requires explicit agentId and never falls back to focus", async () => {
    const startDream = vi.fn();
    const { app } = mount({
      id: "hana",
      memoryMasterEnabled: true,
      memoryTicker: { startDream },
    });

    const response = await app.request("/api/memories/dream/runs", { method: "POST" });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toContain("missing agentId");
    expect(startDream).not.toHaveBeenCalled();
  });

  it("starts a manual Dream for exactly the requested Agent", async () => {
    const startDream = vi.fn(() => ({
      status: "running",
      runId: "run-1",
      startedAt: "2026-08-08T10:00:00.000Z",
      lastRun: null,
    }));
    const { app } = mount({
      id: "hana",
      memoryMasterEnabled: true,
      memoryTicker: { startDream },
    });

    const response = await app.request("/api/memories/dream/runs?agentId=hana", { method: "POST" });
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data).toMatchObject({ agentId: "hana", status: "running", runId: "run-1" });
    expect(startDream).toHaveBeenCalledWith({ trigger: "manual" });
  });

  it("returns status, lists and reads revisions, and restores only the selected revision", async () => {
    const getDreamStatus = vi.fn(() => ({
      status: "succeeded",
      runId: null,
      startedAt: null,
      lastRun: { revisionId: "rev-1" },
    }));
    const listDreamRevisions = vi.fn(() => [{ revisionId: "rev-1", bodyChars: 3200 }]);
    const getDreamRevision = vi.fn(() => ({
      revisionId: "rev-1",
      before: { facts: "- fact", today: "", weekDays: [], longterm: "" },
    }));
    const restoreDreamRevision = vi.fn(async () => ({ revisionId: "rev-1", restoredChars: 3200 }));
    const { app } = mount({
      id: "hana",
      memoryMasterEnabled: true,
      memoryTicker: {
        getDreamStatus,
        listDreamRevisions,
        getDreamRevision,
        restoreDreamRevision,
      },
    });

    const statusResponse = await app.request("/api/memories/dream/status?agentId=hana");
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({ agentId: "hana", status: "succeeded" });

    const listResponse = await app.request("/api/memories/dream/revisions?agentId=hana");
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      agentId: "hana",
      revisions: [{ revisionId: "rev-1", bodyChars: 3200 }],
    });

    const detailResponse = await app.request("/api/memories/dream/revisions/rev-1?agentId=hana");
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toMatchObject({
      revision: { revisionId: "rev-1", before: { facts: "- fact" } },
    });

    const restoreResponse = await app.request(
      "/api/memories/dream/revisions/rev-1/restore?agentId=hana",
      { method: "POST" },
    );
    expect(restoreResponse.status).toBe(200);
    expect(await restoreResponse.json()).toMatchObject({ ok: true, revisionId: "rev-1" });
    expect(restoreDreamRevision).toHaveBeenCalledWith("rev-1");
    expect(listDreamRevisions).toHaveBeenCalledOnce();
    expect(getDreamRevision).toHaveBeenCalledWith("rev-1");
  });

  it("refuses concurrent starts with a conflict", async () => {
    const error: Error & { code?: string } = new Error("already running");
    error.code = "dream_already_running";
    const { app } = mount({
      id: "hana",
      memoryMasterEnabled: true,
      memoryTicker: { startDream: vi.fn(() => { throw error; }) },
    });

    const response = await app.request("/api/memories/dream/runs?agentId=hana", { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "dream_already_running",
      error: "already running",
    });
  });

  it("returns stable public codes when Dream is unavailable or memory is disabled", async () => {
    const unavailableApp = mount({ id: "hana", memoryMasterEnabled: true }).app;
    const unavailableResponse = await unavailableApp.request(
      "/api/memories/dream/runs?agentId=hana",
      { method: "POST" },
    );
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.json()).toEqual({
      code: "dream_unavailable",
      error: "Memory Dream is unavailable for this agent",
    });

    const disabledApp = mount({
      id: "hana",
      memoryMasterEnabled: false,
      memoryTicker: { startDream: vi.fn() },
    }).app;
    const disabledResponse = await disabledApp.request(
      "/api/memories/dream/runs?agentId=hana",
      { method: "POST" },
    );
    expect(disabledResponse.status).toBe(409);
    expect(await disabledResponse.json()).toEqual({
      code: "dream_memory_disabled",
      error: "Memory is disabled for this agent",
    });
  });

  it("maps maintenance conflicts and missing revisions to public codes", async () => {
    const busy = Object.assign(new Error("maintenance in progress"), { code: "dream_memory_busy" });
    const busyApp = mount({
      id: "hana",
      memoryMasterEnabled: true,
      memoryTicker: { startDream: vi.fn(() => { throw busy; }) },
    }).app;
    const busyResponse = await busyApp.request(
      "/api/memories/dream/runs?agentId=hana",
      { method: "POST" },
    );
    expect(busyResponse.status).toBe(409);
    expect(await busyResponse.json()).toEqual({
      code: "dream_memory_busy",
      error: "maintenance in progress",
    });

    const missingApp = mount({
      id: "hana",
      memoryTicker: {
        getDreamRevision: vi.fn(() => { throw new Error("Dream revision not found"); }),
      },
    }).app;
    const missingResponse = await missingApp.request(
      "/api/memories/dream/revisions/missing?agentId=hana",
    );
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({
      code: "dream_revision_not_found",
      error: "Dream revision not found",
    });
  });

  it("uses restore_failed only for unknown restore failures and preserves existing codes", async () => {
    const failedApp = mount({
      id: "hana",
      memoryTicker: {
        restoreDreamRevision: vi.fn(async () => { throw new Error("disk write failed"); }),
      },
    }).app;
    const failedResponse = await failedApp.request(
      "/api/memories/dream/revisions/rev-1/restore?agentId=hana",
      { method: "POST" },
    );
    expect(failedResponse.status).toBe(500);
    expect(await failedResponse.json()).toEqual({
      code: "dream_restore_failed",
      error: "disk write failed",
    });

    const codedError = Object.assign(new Error("model output invalid"), { code: "dream_run_failed" });
    const codedApp = mount({
      id: "hana",
      memoryTicker: {
        restoreDreamRevision: vi.fn(async () => { throw codedError; }),
      },
    }).app;
    const codedResponse = await codedApp.request(
      "/api/memories/dream/revisions/rev-1/restore?agentId=hana",
      { method: "POST" },
    );
    expect(codedResponse.status).toBe(500);
    expect(await codedResponse.json()).toEqual({
      code: "dream_run_failed",
      error: "model output invalid",
    });
  });
});
