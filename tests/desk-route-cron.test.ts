import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioCronService } from "../core/studio-cron-service.ts";
import { createAutomationTool } from "../lib/tools/automation-tool.ts";
import { AutomationSuggestionStore } from "../lib/tools/automation-suggestion-store.ts";

const TEST_STUDIO_ID = "studio-main";
const TEST_SESSION_ID = "session-a";
const TEST_SESSION_PATH = "/sessions/a.jsonl";

function writeLegacyJobs(root, agentId, jobs) {
  const deskDir = path.join(root, "agents", agentId, "desk");
  fs.mkdirSync(deskDir, { recursive: true });
  fs.writeFileSync(
    path.join(deskDir, "cron-jobs.json"),
    JSON.stringify({ jobs, nextNum: jobs.length + 1 }, null, 2) + "\n",
    "utf-8",
  );
}

function createBoundStoreService(store, studioId = TEST_STUDIO_ID) {
  return {
    forStudio: (requestedStudioId) => requestedStudioId === studioId ? store : null,
  };
}

function createApp(engine, {
  runtimeStudioId = TEST_STUDIO_ID,
  authPrincipal = null,
} = {}) {
  return import("../server/routes/desk.ts").then(({ createDeskRoute }) => {
    const routeEngine = {
      getRuntimeContext: () => ({
        studioId: runtimeStudioId,
        serverId: "server-test",
        userId: "owner-test",
        connectionKind: "local",
        credentialKind: "loopback_token",
      }),
      getSessionIdForPath: (sessionPath) => sessionPath === TEST_SESSION_PATH ? TEST_SESSION_ID : null,
      getSessionManifest: (sessionId) => sessionId === TEST_SESSION_ID
        ? {
          sessionId: TEST_SESSION_ID,
          ownerAgentId: "agent-a",
          lifecycle: "active",
          health: "ok",
          currentLocator: { path: TEST_SESSION_PATH },
        }
        : null,
      getSessionFolderScope: (sessionPath) => sessionPath === TEST_SESSION_PATH
        ? {
          cwd: "/workspace/a",
          workspaceFolders: ["/workspace/ref"],
          authorizedFolders: [],
        }
        : null,
      getHomeCwd: (agentId) => `/workspace/${agentId.replace(/^agent-/, "")}`,
      ...engine,
    };
    const app = new Hono();
    if (authPrincipal) {
      app.use("*", async (c, next) => {
        (c as any).set("authPrincipal", authPrincipal);
        await next();
      });
    }
    app.route("/api", createDeskRoute(routeEngine, { scheduler: { getHeartbeat: vi.fn() } }));
    return app;
  });
}

describe("desk cron route", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists the studio cron store independent of the focused agent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const agentsDir = path.join(root, "agents");
    writeLegacyJobs(root, "agent-a", [
      { id: "job_1", type: "cron", schedule: "0 9 * * *", prompt: "a", label: "A", enabled: true, nextRunAt: "2026-05-21T01:00:00.000Z" },
    ]);
    writeLegacyJobs(root, "agent-b", [
      { id: "job_1", type: "cron", schedule: "0 10 * * *", prompt: "b", label: "B", enabled: true, nextRunAt: "2026-05-21T02:00:00.000Z" },
    ]);
    const service = new StudioCronService({ hanakoHome: root, agentsDir, getStudioId: () => "studio-main" });
    const engine = {
      currentAgentId: "agent-a",
      getAgent: (id) => ({ id, agentName: id }),
      getStudioCronStore: () => service,
      listAgents: () => [],
    };
    const app = await createApp(engine);

    const first = await app.request("/api/desk/cron");
    engine.currentAgentId = "agent-b";
    const second = await app.request("/api/desk/cron");

    const firstJobs = (await first.json()).jobs;
    const secondJobs = (await second.json()).jobs;
    expect(firstJobs.map((job) => job.actorAgentId).sort()).toEqual(["agent-a", "agent-b"]);
    expect(secondJobs.map((job) => job.actorAgentId).sort()).toEqual(["agent-a", "agent-b"]);
    expect(secondJobs.map((job) => job.id).sort()).toEqual(firstJobs.map((job) => job.id).sort());
  });

  it("returns a route error when the cron store is unavailable", async () => {
    const app = await createApp({
      getStudioCronStore: () => null,
      listAgents: () => [],
    });

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle", id: "job_missing" }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: "cron_store_unavailable",
        message: "Desk not initialized",
      },
    });
  });

  it("preserves structured cron store failures for GET", async () => {
    const store = {
      studioId: TEST_STUDIO_ID,
      listJobs: () => {
        throw Object.assign(new Error("automation task storage is corrupt"), {
          code: "cron_store_corrupt",
          status: 500,
        });
      },
    };
    const app = await createApp({
      getStudioCronStore: () => createBoundStoreService(store),
      listAgents: () => [],
    });

    const res = await app.request("/api/desk/cron");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: {
        code: "cron_store_corrupt",
        message: "automation task storage is corrupt",
      },
    });
  });

  it("preserves structured cron store failures for POST", async () => {
    const store = {
      studioId: TEST_STUDIO_ID,
      addJob: () => {
        throw Object.assign(new Error("automation task storage is unavailable"), {
          code: "cron_store_unavailable",
          status: 500,
        });
      },
    };
    const app = await createApp({
      getAgent: (id) => ({ id }),
      getStudioCronStore: () => createBoundStoreService(store),
      listAgents: () => [],
    });

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        prompt: "run task",
        actorAgentId: "agent-a",
        executionContext: {
          kind: "ui_manual",
          cwd: "/workspace/a",
          workspaceFolders: [],
          sourceSessionPath: TEST_SESSION_PATH,
          createdByAgentId: "agent-a",
        },
      }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: {
        code: "cron_store_unavailable",
        message: "automation task storage is unavailable",
      },
    });
  });

  it("does not leak unknown storage paths through route errors", async () => {
    const store = {
      studioId: TEST_STUDIO_ID,
      listJobs: () => {
        throw new Error("EACCES: permission denied, open '/private/user/cron-jobs.json'");
      },
    };
    const app = await createApp({
      getStudioCronStore: () => createBoundStoreService(store),
      listAgents: () => [],
    });

    const res = await app.request("/api/desk/cron");
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "cron_store_operation_failed",
        message: "Unable to access automation tasks",
      },
    });
    expect(JSON.stringify(body)).not.toContain("/private/user");
  });

  it("does not trust an unrecognized cron_store code as a safe error", async () => {
    const store = {
      studioId: TEST_STUDIO_ID,
      listJobs: () => {
        throw Object.assign(new Error("failed at /private/user/cron-jobs.json"), {
          code: "cron_store_future_failure",
          status: 500,
        });
      },
    };
    const app = await createApp({
      getStudioCronStore: () => createBoundStoreService(store),
      listAgents: () => [],
    });

    const res = await app.request("/api/desk/cron");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: {
        code: "cron_store_operation_failed",
        message: "Unable to access automation tasks",
      },
    });
  });

  it("returns a route error for unknown cron actions", async () => {
    const store = { studioId: TEST_STUDIO_ID, listJobs: () => [] };
    const app = await createApp({
      getStudioCronStore: () => createBoundStoreService(store),
      listAgents: () => [],
    });

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "snooze" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "unknown_cron_action",
        message: "unknown action: snooze",
      },
    });
  });

  it("rejects GET and POST when the authenticated Studio differs without touching the store", async () => {
    const listJobs = vi.fn(() => []);
    const toggleJob = vi.fn();
    const forStudio = vi.fn(() => ({
      studioId: TEST_STUDIO_ID,
      listJobs,
      toggleJob,
    }));
    const app = await createApp({
      getStudioCronStore: () => ({ forStudio }),
      listAgents: () => [],
    }, {
      authPrincipal: {
        kind: "local_user",
        userId: "owner-test",
        studioId: "studio-other",
        serverId: "server-test",
        connectionKind: "local",
        credentialKind: "loopback_token",
      },
    });

    const getResponse = await app.request("/api/desk/cron");
    const postResponse = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle", id: "job_1" }),
    });

    for (const response of [getResponse, postResponse]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: {
          code: "studio_scope_mismatch",
          message: "Authenticated Studio does not match this server Studio",
        },
      });
    }
    expect(forStudio).not.toHaveBeenCalled();
    expect(listJobs).not.toHaveBeenCalled();
    expect(toggleJob).not.toHaveBeenCalled();
  });

  it("mutates jobs by studio job id without resolving the focused agent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const agentsDir = path.join(root, "agents");
    const service = new StudioCronService({ hanakoHome: root, agentsDir, getStudioId: () => "studio-main" });
    const job = service.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "studio job",
      label: "Studio Job",
      actorAgentId: "agent-a",
      executionContext: {
        kind: "session_workspace",
        cwd: "/workspace/a",
        workspaceFolders: ["/workspace/ref"],
        sourceSessionPath: "/sessions/a.jsonl",
        createdByAgentId: "agent-a",
      },
    });
    const getAgent = vi.fn((id) => ({ id, agentName: id }));
    const engine = {
      currentAgentId: "agent-b",
      getAgent,
      getStudioCronStore: () => service,
      listAgents: () => [],
    };
    const app = await createApp(engine);

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle", id: job.id }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).job.enabled).toBe(false);
    expect(service.getJob(job.id).enabled).toBe(false);
    expect(getAgent).not.toHaveBeenCalledWith("agent-b");
  });

  it("updates schedule type and normalizes interval minutes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({ hanakoHome: root, agentsDir: path.join(root, "agents"), getStudioId: () => "studio-main" });
    const job = service.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "studio job",
      actorAgentId: "agent-a",
      executionContext: {
        kind: "session_workspace",
        cwd: "/workspace/a",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/a.jsonl",
        createdByAgentId: "agent-a",
      },
    });
    const app = await createApp({
      getAgent: (id) => ({ id, agentName: id }),
      getStudioCronStore: () => service,
      listAgents: () => [],
    });

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", id: job.id, type: "every", schedule: "120" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.type).toBe("every");
    expect(data.job.schedule).toBe(7_200_000);
  });

  it("adds every schedules with numeric milliseconds without double-normalizing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });
    const app = await createApp({
      getAgent: (id) => (id === "agent-a" ? { id, agentName: "Agent A" } : null),
      getStudioCronStore: () => service,
      listAgents: () => [],
    });

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scheduleType: "every",
        schedule: 7_200_000,
        prompt: "every two hours",
        actorAgentId: "agent-a",
        executionContext: {
          kind: "session_workspace",
          cwd: "/workspace/a",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/a.jsonl",
          createdByAgentId: "agent-a",
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.type).toBe("every");
    expect(data.job.schedule).toBe(7_200_000);
  });

  it("updates every schedules with numeric milliseconds without double-normalizing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({ hanakoHome: root, agentsDir: path.join(root, "agents"), getStudioId: () => "studio-main" });
    const job = service.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "studio job",
      actorAgentId: "agent-a",
      executionContext: {
        kind: "session_workspace",
        cwd: "/workspace/a",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/a.jsonl",
        createdByAgentId: "agent-a",
      },
    });
    const app = await createApp({
      getAgent: (id) => ({ id, agentName: id }),
      getStudioCronStore: () => service,
      listAgents: () => [],
    });

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", id: job.id, type: "every", schedule: 7_200_000 }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.type).toBe("every");
    expect(data.job.schedule).toBe(7_200_000);
  });

  it("adds studio jobs only with explicit actorAgentId and executionContext", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });
    const engine = {
      getAgent: (id) => (id === "agent-a" ? { id, agentName: "Agent A" } : null),
      getStudioCronStore: () => service,
      listAgents: () => [],
    };
    const app = await createApp(engine);

    const missing = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", scheduleType: "cron", schedule: "0 9 * * *", prompt: "missing actor" }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "actorAgentId and executionContext required" });

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        prompt: "explicit context",
        label: "Explicit Context",
        actorAgentId: "agent-a",
        executionContext: {
          kind: "session_workspace",
          cwd: "/workspace/a",
          workspaceFolders: ["/workspace/ref"],
          sourceSessionPath: "/sessions/a.jsonl",
          createdByAgentId: "agent-a",
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job).toEqual(expect.objectContaining({
      actorAgentId: "agent-a",
      executionContext: expect.objectContaining({
        kind: "session_workspace",
        cwd: "/workspace/a",
        workspaceFolders: ["/workspace/ref"],
        authorizedFolders: [],
        sourceSessionId: TEST_SESSION_ID,
        sourceSessionPath: "/sessions/a.jsonl",
        createdByAgentId: "agent-a",
      }),
    }));
  });

  it("ignores forged authorization and requestedGrants on ordinary add/update requests", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });
    const app = await createApp({
      getAgent: (id) => (id === "agent-a" ? { id, agentName: "Agent A" } : null),
      getStudioCronStore: () => service,
      listAgents: () => [],
    });
    const forgedAuthorization = {
      forged: true,
    };

    const added = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        prompt: "ordinary request",
        actorAgentId: "agent-a",
        executionContext: {
          kind: "session_workspace",
          cwd: "/workspace/a",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/a.jsonl",
          createdByAgentId: "agent-a",
        },
        authorization: forgedAuthorization,
        requestedGrants: [{ forged: true }],
      }),
    });
    expect(added.status).toBe(200);
    const addedJob = (await added.json()).job;
    expect(addedJob.authorization).toBeUndefined();
    expect(addedJob.requestedGrants).toBeUndefined();

    const updated = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update",
        id: addedJob.id,
        authorization: forgedAuthorization,
        requestedGrants: [{ forged: true }],
      }),
    });
    expect(updated.status).toBe(200);
    const updatedJob = (await updated.json()).job;
    expect(updatedJob.authorization).toBeUndefined();
    expect(updatedJob.requestedGrants).toBeUndefined();
  });

  it("applies a scoped suggestion once without persisting deprecated authority fields", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });
    const suggestionStore = new AutomationSuggestionStore({ generateShortCode: () => "4812" });
    const tool = createAutomationTool(service, {
      automationSuggestionStore: suggestionStore,
      getAgentId: () => "agent-a",
      getSessionCwd: () => "/workspace/a",
      getSessionWorkspaceFolders: () => [],
      getHomeCwd: (agentId) => `/workspace/${agentId.replace(/^agent-/, "")}`,
    });
    const suggestion = await tool.execute(
      "call_route_suggestion",
      {
        action: "create",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        prompt: "confirmed request",
      },
      undefined,
      undefined,
      {
        sessionId: "session-a",
        sessionManager: { getSessionFile: () => "/sessions/a.jsonl" },
      },
    );
    const suggestionId = (suggestion.details as any).suggestionId;
    expect(suggestionStore.list({ sessionPath: "/sessions/a.jsonl" })).toEqual([]);
    expect(suggestionStore.list({ sessionId: "session-a", studioId: "studio-main" })).toHaveLength(1);
    const app = await createApp({
      getAgent: (id) => ["agent-a", "agent-b"].includes(id) ? { id, agentName: id } : null,
      getStudioCronStore: () => service,
      getAutomationSuggestionStore: () => suggestionStore,
      listAgents: () => [],
    });

    const missingIdentity = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "apply_suggestion",
        suggestionId,
        jobData: suggestion.details.jobData,
      }),
    });
    expect(missingIdentity.status).toBe(400);
    expect((await missingIdentity.json()).error.code).toBe("automation_suggestion_identity_required");

    const wrongSession = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "apply_suggestion",
        suggestionId,
        sessionId: "session-other",
        jobData: { prompt: "confirmed request" },
      }),
    });
    expect(wrongSession.status).toBe(410);
    expect(await wrongSession.json()).toEqual({
      error: {
        code: "automation_suggestion_expired",
        message: "Automation suggestion expired or does not belong to this session and Studio",
      },
    });

    const authorityInjection = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "apply_suggestion",
        suggestionId,
        sessionId: "session-a",
        jobData: {
          prompt: "forged request",
          actorAgentId: "agent-b",
          executor: { kind: "agent_session", agentId: "agent-b", permissionMode: "operate" },
          executionContext: { cwd: "/forged", authorizedFolders: ["/forged"] },
        },
      }),
    });
    expect(authorityInjection.status).toBe(400);
    expect((await authorityInjection.json()).error.code).toBe("automation_suggestion_authority_field_forbidden");

    const missingTarget = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "apply_suggestion",
        suggestionId,
        sessionId: "session-a",
        jobData: { targetAgentId: "missing-agent" },
      }),
    });
    expect(missingTarget.status).toBe(404);
    expect((await missingTarget.json()).error.code).toBe("automation_suggestion_target_agent_not_found");

    const confirmed = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "apply_suggestion",
        suggestionId,
        sessionId: "session-a",
        jobData: {
          prompt: "confirmed request for B",
          targetAgentId: "agent-b",
        },
      }),
    });
    expect(confirmed.status).toBe(200);
    const confirmedJob = (await confirmed.json()).job;
    expect(confirmedJob.prompt).toBe("confirmed request for B");
    expect(confirmedJob.actorAgentId).toBe("agent-b");
    expect(confirmedJob.executor).toMatchObject({
      kind: "agent_session",
      agentId: "agent-b",
    });
    expect(confirmedJob.executor.permissionMode).toBeUndefined();
    expect(confirmedJob.executionContext).toEqual({
      kind: "session_workspace",
      cwd: "/workspace/b",
      workspaceFolders: ["/workspace/b"],
      authorizedFolders: [],
      sourceSessionId: null,
      sourceBridgeSessionKey: null,
      sourceSessionPath: null,
      createdByAgentId: "agent-b",
      notificationContext: null,
    });
    expect(confirmedJob.authorization).toBeUndefined();
    expect(confirmedJob.requestedGrants).toBeUndefined();

    const consumed = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "apply_suggestion",
        suggestionId,
        sessionId: "session-a",
        jobData: { prompt: "replay" },
      }),
    });
    expect(consumed.status).toBe(410);
    expect((await consumed.json()).error.code).toBe("automation_suggestion_expired");
    expect(service.listJobs()).toHaveLength(1);
  });

  it("allows creating a disabled Agent automation draft without a prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });
    const engine = {
      getAgent: (id) => (id === "agent-a" ? { id, agentName: "Agent A" } : null),
      getStudioCronStore: () => service,
      listAgents: () => [],
    };
    const app = await createApp(engine);

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        prompt: "",
        label: "Draft",
        enabled: false,
        actorAgentId: "agent-a",
        executionContext: {
          kind: "ui_manual",
          cwd: "/workspace/a",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/a.jsonl",
          createdByAgentId: "agent-a",
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job).toEqual(expect.objectContaining({
      prompt: "",
      label: "Draft",
      enabled: false,
      actorAgentId: "agent-a",
    }));
  });

  it("rejects enabling an Agent automation draft while prompt is empty", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });
    const engine = {
      getAgent: (id) => (id === "agent-a" ? { id, agentName: "Agent A" } : null),
      getStudioCronStore: () => service,
      listAgents: () => [],
    };
    const app = await createApp(engine);
    const job = service.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "",
      label: "Draft",
      enabled: false,
      actorAgentId: "agent-a",
      executionContext: {
        kind: "ui_manual",
        cwd: "/workspace/a",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/a.jsonl",
        createdByAgentId: "agent-a",
      },
    });

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", id: job.id, enabled: true }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "prompt required to enable agent automation" });
    expect(service.getJob(job.id).enabled).toBe(false);
  });

  it("rejects toggling an empty Agent automation draft on", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });
    const engine = {
      getAgent: (id) => (id === "agent-a" ? { id, agentName: "Agent A" } : null),
      getStudioCronStore: () => service,
      listAgents: () => [],
    };
    const app = await createApp(engine);
    const job = service.addJob({
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "",
      label: "Draft",
      enabled: false,
      actorAgentId: "agent-a",
      executionContext: {
        kind: "ui_manual",
        cwd: "/workspace/a",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/a.jsonl",
        createdByAgentId: "agent-a",
      },
    });

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle", id: job.id }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "prompt required to enable agent automation" });
    expect(service.getJob(job.id).enabled).toBe(false);
  });

  it.each([
    {
      label: "executor permissionMode",
      executor: {
        kind: "agent_session",
        agentId: "agent-a",
        prompt: "run task",
        permissionMode: "operate",
      },
      executionContext: null,
      expected: /executor field is host-managed: permissionMode/,
    },
    {
      label: "Bridge source identity",
      executor: null,
      executionContext: { sourceBridgeSessionKey: "wechat_dm_owner@agent-a" },
      expected: /Bridge identity and notification context are host-managed/,
    },
    {
      label: "notification target",
      executor: null,
      executionContext: { notificationContext: { bridgeDeliveryTarget: { platform: "wechat" } } },
      expected: /Bridge identity and notification context are host-managed/,
    },
  ])("rejects host-managed authority from the ordinary route: $label", async ({
    executor,
    executionContext,
    expected,
  }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });
    const app = await createApp({
      getAgent: (id) => (id === "agent-a" ? { id, agentName: "Agent A" } : null),
      getStudioCronStore: () => service,
      listAgents: () => [],
    });
    const baseContext = {
      kind: "session_workspace",
      cwd: "/workspace/a",
      workspaceFolders: [],
      sourceSessionId: "session-a",
      sourceSessionPath: "/sessions/a.jsonl",
      createdByAgentId: "agent-a",
      ...(executionContext || {}),
    };

    const response = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        prompt: "run task",
        actorAgentId: "agent-a",
        executionContext: baseContext,
        ...(executor ? { executor } : {}),
      }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(expected);
    expect(service.listJobs()).toEqual([]);
  });

  it("rejects direct notify executors through the cron compatibility route", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });
    const engine = {
      getAgent: (id) => (id === "agent-a" ? { id, agentName: "Agent A" } : null),
      getStudioCronStore: () => service,
      listAgents: () => [],
    };
    const app = await createApp(engine);

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        label: "Drink Water",
        actorAgentId: "agent-a",
        executionContext: {
          kind: "session_workspace",
          cwd: "/workspace/a",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/a.jsonl",
          createdByAgentId: "agent-a",
        },
        executor: {
          kind: "direct_action",
          action: "notify",
          params: {
            title: "喝水",
            body: "站起来活动一下",
            channels: ["desktop"],
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported automation executor: direct_action" });
    expect(service.listJobs()).toEqual([]);
  });

  it("rejects plugin-action executors through the cron compatibility route", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });
    const engine = {
      getAgent: (id) => (id === "agent-a" ? { id, agentName: "Agent A" } : null),
      getStudioCronStore: () => service,
      listAgents: () => [],
    };
    const app = await createApp(engine);

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scheduleType: "cron",
        schedule: "0 18 * * *",
        label: "Daily Note",
        actorAgentId: "agent-a",
        executionContext: {
          kind: "session_workspace",
          cwd: "/workspace/a",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/a.jsonl",
          createdByAgentId: "agent-a",
        },
        executor: {
          kind: "plugin_action",
          pluginId: "notes",
          actionId: "create_note",
          params: { title: "Today" },
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported automation executor: plugin_action" });
    expect(service.listJobs()).toEqual([]);
  });

  it("rejects removed file.create direct-action jobs through the cron route", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desk-cron-"));
    roots.push(root);
    const service = new StudioCronService({
      hanakoHome: root,
      agentsDir: path.join(root, "agents"),
      getStudioId: () => "studio-main",
    });
    const engine = {
      getAgent: (id) => (id === "agent-a" ? { id, agentName: "Agent A" } : null),
      getStudioCronStore: () => service,
      listAgents: () => [],
    };
    const app = await createApp(engine);

    const res = await app.request("/api/desk/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        scheduleType: "cron",
        schedule: "0 18 * * *",
        actorAgentId: "agent-a",
        executionContext: {
          kind: "session_workspace",
          cwd: "/workspace/a",
          workspaceFolders: [],
          sourceSessionPath: "/sessions/a.jsonl",
          createdByAgentId: "agent-a",
        },
        executor: {
          kind: "direct_action",
          action: "file.create",
          params: { relativePath: "notes/today.md", content: "# Today\n" },
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported automation executor: direct_action" });
    expect(service.listJobs()).toEqual([]);
  });
});
