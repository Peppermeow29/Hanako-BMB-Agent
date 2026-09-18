/**
 * SessionCoordinator.writeSessionMeta 序列化回归测试
 *
 * 验证并发调用 writeSessionMeta 不会因 RMW 竞态丢失字段，
 * 且写入失败不会阻塞队列后续项。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: vi.fn(),
  SessionManager: {
    create: vi.fn(),
    list: vi.fn(),
    open: vi.fn(),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.ts";
import { SessionManager } from "../lib/pi-sdk/index.ts";

function makeCoordinatorDeps( overrides: any = {}) {
  return {
    agentsDir: "/tmp/agents",
    getAgent: () => ({
      sessionDir: overrides._sessionDir || "/tmp/agent-sessions",
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "mock-prompt",
      config: {},
      tools: [],
      agentDir: "/tmp/agents/hana",
    }),
    getActiveAgentId: () => "test",
    getModels: () => ({
      currentModel: { id: "m", name: "m" },
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: () => "medium",
    }),
    getResourceLoader: () => ({
      getSystemPrompt: () => "",
      getAppendSystemPrompt: () => [],
    }),
    getSkills: () => null,
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: vi.fn(),
    getHomeCwd: () => "/tmp/home",
    agentIdFromSessionPath: () => null,
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: () => null,
    listAgents: () => [],
    getDeferredResultStore: () => null,
    ...overrides,
  };
}

describe("SessionCoordinator.writeSessionMeta serialization", () => {
  let tmpDir, sessionDir, sessionCoord, fakeSessionPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-serial-"));
    sessionDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fakeSessionPath = path.join(sessionDir, "test-session.jsonl");
    vi.mocked(SessionManager.list).mockReset();

    const deps = makeCoordinatorDeps({ _sessionDir: sessionDir });
    // override getAgent to return dynamic sessionDir from tmpDir
    deps.getAgent = () => ({
      sessionDir,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "mock-prompt",
      config: {},
      tools: [],
      agentDir: path.join(tmpDir, "agents", "hana"),
    });

    sessionCoord = new SessionCoordinator(deps);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("two concurrent writeSessionMeta calls with different fields preserve both", async () => {
    const p1 = sessionCoord.writeSessionMeta(fakeSessionPath, { memoryEnabled: false });
    const p2 = sessionCoord.writeSessionMeta(fakeSessionPath, { toolNames: ["read", "exec_command"] });
    await Promise.all([p1, p2]);

    const metaPath = path.join(sessionDir, "session-meta.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const entry = meta[path.basename(fakeSessionPath)];
    expect(entry.memoryEnabled).toBe(false);
    expect(entry.toolNames).toEqual(["read", "exec_command"]);
  });

  it("three sequential writes accumulate fields correctly", async () => {
    await sessionCoord.writeSessionMeta(fakeSessionPath, { memoryEnabled: true });
    await sessionCoord.writeSessionMeta(fakeSessionPath, { toolNames: ["a"] });
    await sessionCoord.writeSessionMeta(fakeSessionPath, { memoryEnabled: false });

    const metaPath = path.join(sessionDir, "session-meta.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const entry = meta[path.basename(fakeSessionPath)];
    expect(entry.memoryEnabled).toBe(false);
    expect(entry.toolNames).toEqual(["a"]);
  });

  it("a failed write does not block subsequent writes from the same queue", async () => {
    // Force _doWriteSessionMeta to actually REJECT (not just log internally) by
    // making getAgent() throw on the first call. getAgent() is invoked before the
    // try-catch loop, so an exception there causes the async function to reject,
    // which would poison the queue if the guard were `.then(next)` only.
    let getAgentCalls = 0;
    const realSessionDir = sessionDir;
    sessionCoord._d.getAgent = () => {
      getAgentCalls += 1;
      if (getAgentCalls === 1) {
        throw new Error("injected getAgent failure");
      }
      return { sessionDir: realSessionDir };
    };

    let secondWriteRan = false;
    const p1 = sessionCoord.writeSessionMeta(fakeSessionPath, { memoryEnabled: true });
    const p2 = sessionCoord.writeSessionMeta(fakeSessionPath, { toolNames: ["x"] }).then((v) => {
      secondWriteRan = true;
      return v;
    });
    // Use allSettled: p1 is expected to reject (or resolve after swallowing);
    // what matters is that p2 still ran regardless.
    await Promise.allSettled([p1, p2]);

    // p2 should have landed in the real meta file
    const metaPath = path.join(realSessionDir, "session-meta.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const entry = meta[path.basename(fakeSessionPath)];
    expect(entry.toolNames).toEqual(["x"]);
    // p1's failure did NOT prevent p2 from running
    expect(secondWriteRan).toBe(true);
    expect(getAgentCalls).toBeGreaterThanOrEqual(2);
  });

  it("model and modelId fields are stripped from written meta", async () => {
    await sessionCoord.writeSessionMeta(fakeSessionPath, {
      memoryEnabled: true,
      model: "should-be-deleted",
      modelId: "also-deleted",
    });

    const metaPath = path.join(sessionDir, "session-meta.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const entry = meta[path.basename(fakeSessionPath)];
    expect(entry.model).toBeUndefined();
    expect(entry.modelId).toBeUndefined();
    expect(entry.memoryEnabled).toBe(true);
  });

  it("stores oversized prompt snapshots in a per-session payload sidecar (#1681)", async () => {
    const largePrompt = "memory ".repeat(220_000);

    await sessionCoord.writeSessionMeta(fakeSessionPath, {
      memoryEnabled: true,
      promptSnapshot: {
        version: 1,
        systemPrompt: largePrompt,
        appendSystemPrompt: [],
        skillsResult: { skills: [], diagnostics: [] },
        agentsFilesResult: { agentsFiles: [] },
      },
    });

    const metaPath = path.join(sessionDir, "session-meta.json");
    const rawMeta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const rawEntry = rawMeta[path.basename(fakeSessionPath)];
    expect(rawEntry.memoryEnabled).toBe(true);
    expect(rawEntry.promptSnapshot).toMatchObject({
      kind: "session-meta-payload",
      field: "promptSnapshot",
    });
    expect(JSON.stringify(rawMeta).length).toBeLessThan(20_000);

    const hydrated = await sessionCoord._readMetaCached(metaPath);
    expect(hydrated[path.basename(fakeSessionPath)].promptSnapshot.systemPrompt).toBe(largePrompt);

    const payloadDir = path.join(sessionDir, "session-meta-payloads");
    const payloadFiles = await fsp.readdir(payloadDir);
    expect(payloadFiles.some((name) => name.endsWith(".promptSnapshot.json"))).toBe(true);
  });

  it("always externalizes small promptSnapshot payloads into a sidecar file, even well under the old inline threshold", async () => {
    const smallPrompt = "small prompt ".repeat(60); // ~800 bytes, far below the old 256KB inline limit
    const promptSnapshot = {
      version: 1,
      systemPrompt: smallPrompt,
      appendSystemPrompt: [],
      skillsResult: { skills: [], diagnostics: [] },
      agentsFilesResult: { agentsFiles: [] },
    };

    await sessionCoord.writeSessionMeta(fakeSessionPath, {
      memoryEnabled: true,
      promptSnapshot,
    });

    const metaPath = path.join(sessionDir, "session-meta.json");
    const rawMeta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const rawEntry = rawMeta[path.basename(fakeSessionPath)];
    expect(rawEntry.promptSnapshot).toEqual({
      kind: "session-meta-payload",
      version: 1,
      field: "promptSnapshot",
      path: expect.stringContaining("session-meta-payloads"),
    });

    const sidecarAbsPath = path.join(sessionDir, rawEntry.promptSnapshot.path);
    const sidecarRaw = JSON.parse(await fsp.readFile(sidecarAbsPath, "utf-8"));
    expect(sidecarRaw).toEqual(promptSnapshot);
  });

  it("always externalizes small memoryReflectionSnapshot payloads into a sidecar file", async () => {
    const memoryReflectionSnapshot = {
      version: 1,
      summary: "a few hundred bytes of reflection text ".repeat(10),
    };

    await sessionCoord.writeSessionMeta(fakeSessionPath, {
      memoryEnabled: true,
      memoryReflectionSnapshot,
    });

    const metaPath = path.join(sessionDir, "session-meta.json");
    const rawMeta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const rawEntry = rawMeta[path.basename(fakeSessionPath)];
    expect(rawEntry.memoryReflectionSnapshot).toMatchObject({
      kind: "session-meta-payload",
      field: "memoryReflectionSnapshot",
    });

    const sidecarAbsPath = path.join(sessionDir, rawEntry.memoryReflectionSnapshot.path);
    const sidecarRaw = JSON.parse(await fsp.readFile(sidecarAbsPath, "utf-8"));
    expect(sidecarRaw).toEqual(memoryReflectionSnapshot);
  });

  it("hydrates a small externalized promptSnapshot back to the original value via _readMetaCached", async () => {
    const promptSnapshot = {
      version: 1,
      systemPrompt: "tiny prompt content",
      appendSystemPrompt: ["extra line"],
      skillsResult: { skills: [], diagnostics: [] },
      agentsFilesResult: { agentsFiles: [] },
    };

    await sessionCoord.writeSessionMeta(fakeSessionPath, {
      memoryEnabled: true,
      promptSnapshot,
    });

    const metaPath = path.join(sessionDir, "session-meta.json");
    const hydrated = await sessionCoord._readMetaCached(metaPath);
    const entry = hydrated[path.basename(fakeSessionPath)];
    expect(entry.promptSnapshot).toEqual(promptSnapshot);
  });

  it("removes the promptSnapshot sidecar file when the session meta entry is deleted", async () => {
    const promptSnapshot = {
      version: 1,
      systemPrompt: "prompt to be deleted",
      appendSystemPrompt: [],
      skillsResult: { skills: [], diagnostics: [] },
      agentsFilesResult: { agentsFiles: [] },
    };

    await sessionCoord.writeSessionMeta(fakeSessionPath, {
      memoryEnabled: true,
      promptSnapshot,
    });

    const metaPath = path.join(sessionDir, "session-meta.json");
    const rawMeta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const rawEntry = rawMeta[path.basename(fakeSessionPath)];
    const sidecarAbsPath = path.join(sessionDir, rawEntry.promptSnapshot.path);
    expect(fs.existsSync(sidecarAbsPath)).toBe(true);

    await sessionCoord._doDeleteSessionMetaEntry(fakeSessionPath, { metaPath });

    expect(fs.existsSync(sidecarAbsPath)).toBe(false);
    const metaAfterDelete = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    expect(metaAfterDelete[path.basename(fakeSessionPath)]).toBeUndefined();
  });

  it("still reads a legacy inline (non-externalized) promptSnapshot entry correctly", async () => {
    const metaPath = path.join(sessionDir, "session-meta.json");
    const legacySessionPath = path.join(sessionDir, "legacy-inline.jsonl");
    const inlinePromptSnapshot = {
      version: 1,
      systemPrompt: "hand-authored inline legacy entry",
      appendSystemPrompt: [],
      skillsResult: { skills: [], diagnostics: [] },
      agentsFilesResult: { agentsFiles: [] },
    };
    await fsp.writeFile(metaPath, JSON.stringify({
      [path.basename(legacySessionPath)]: {
        memoryEnabled: true,
        promptSnapshot: inlinePromptSnapshot,
      },
    }, null, 2), "utf-8");

    const hydrated = await sessionCoord._readMetaCached(metaPath);
    const entry = hydrated[path.basename(legacySessionPath)];
    expect(entry.memoryEnabled).toBe(true);
    expect(entry.promptSnapshot).toEqual(inlinePromptSnapshot);
  });

  it("compacts an oversized legacy session-meta file instead of dropping unrelated entries (#1681)", async () => {
    const metaPath = path.join(sessionDir, "session-meta.json");
    const legacySessionPath = path.join(sessionDir, "legacy.jsonl");
    const largePrompt = "legacy ".repeat(220_000);
    await fsp.writeFile(metaPath, JSON.stringify({
      "legacy.jsonl": {
        memoryEnabled: true,
        promptSnapshot: { systemPrompt: largePrompt },
      },
    }), "utf-8");

    await sessionCoord.writeSessionMeta(fakeSessionPath, { memoryEnabled: false });

    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].memoryEnabled).toBe(false);
    expect(meta[path.basename(legacySessionPath)].memoryEnabled).toBe(true);
    expect(meta[path.basename(legacySessionPath)].promptSnapshot).toMatchObject({
      kind: "session-meta-payload",
      field: "promptSnapshot",
    });
    expect(JSON.stringify(meta).length).toBeLessThan(20_000);

    const files = await fsp.readdir(sessionDir);
    expect(files.some((name) => /^session-meta\.oversized\.\d+\.json$/.test(name))).toBe(false);

    const hydrated = await sessionCoord._readMetaCached(metaPath);
    expect(hydrated[path.basename(legacySessionPath)].promptSnapshot.systemPrompt).toBe(largePrompt);
  });

  it("externalizes medium prompt snapshots when the aggregate meta index exceeds its budget", async () => {
    const mediumPrompt = "context ".repeat(20_000);
    const sessionPaths = Array.from({ length: 10 }, (_, index) => path.join(sessionDir, `aggregate-${index}.jsonl`));

    for (const sessionPath of sessionPaths) {
      await sessionCoord.writeSessionMeta(sessionPath, {
        memoryEnabled: true,
        promptSnapshot: {
          version: 1,
          systemPrompt: mediumPrompt,
          appendSystemPrompt: [],
          skillsResult: { skills: [], diagnostics: [] },
          agentsFilesResult: { agentsFiles: [] },
        },
      });
    }

    const metaPath = path.join(sessionDir, "session-meta.json");
    const rawMeta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    expect(Buffer.byteLength(JSON.stringify(rawMeta, null, 2), "utf-8")).toBeLessThan(1024 * 1024);
    expect(Object.values(rawMeta).some((entry: any) => entry.promptSnapshot?.kind === "session-meta-payload"))
      .toBe(true);

    const hydrated = await sessionCoord._readMetaCached(metaPath);
    expect(hydrated[path.basename(sessionPaths[0])].promptSnapshot.systemPrompt).toBe(mediumPrompt);
  });

  it("setSessionPinned writes and clears pinnedAt and pinOrder on the session meta entry", async () => {
    const { pinnedAt, pinOrder } = await sessionCoord.setSessionPinned(fakeSessionPath, true);

    const metaPath = path.join(sessionDir, "session-meta.json");
    let meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    expect(meta[path.basename(fakeSessionPath)].pinnedAt).toBe(pinnedAt);
    expect(meta[path.basename(fakeSessionPath)].pinOrder).toBe(pinOrder);
    expect(pinOrder).toBe(-1024);
    expect(new Date(pinnedAt).toString()).not.toBe("Invalid Date");

    const unpinned = await sessionCoord.setSessionPinned(fakeSessionPath, false);

    meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    expect(unpinned).toEqual({ pinnedAt: null, pinOrder: null });
    expect(meta[path.basename(fakeSessionPath)].pinnedAt).toBeNull();
    expect(meta[path.basename(fakeSessionPath)].pinOrder).toBeNull();
  });

  it("setSessionPinned emits a scoped session metadata update", async () => {
    const { pinnedAt, pinOrder } = await sessionCoord.setSessionPinned(fakeSessionPath, true);

    expect(sessionCoord._d.emitEvent).toHaveBeenCalledWith({
      type: "session_metadata_updated",
      metadata: { pinnedAt, pinOrder },
    }, fakeSessionPath);

    await sessionCoord.setSessionPinned(fakeSessionPath, false);

    expect(sessionCoord._d.emitEvent).toHaveBeenLastCalledWith({
      type: "session_metadata_updated",
      metadata: { pinnedAt: null, pinOrder: null },
    }, fakeSessionPath);
  });

  it("setSessionThinkingLevel writes meta and emits a scoped session metadata update", async () => {
    sessionCoord._hibernatedSessionMeta.set(fakeSessionPath, { thinkingLevel: "medium" });

    const result = await sessionCoord.setSessionThinkingLevel(fakeSessionPath, "high");

    const metaPath = path.join(sessionDir, "session-meta.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    expect(result).toEqual({ ok: true, thinkingLevel: "high" });
    expect(meta[path.basename(fakeSessionPath)].thinkingLevel).toBe("high");
    expect(sessionCoord._d.emitEvent).toHaveBeenCalledWith({
      type: "session_metadata_updated",
      metadata: { thinkingLevel: "high" },
    }, fakeSessionPath);
  });

  it("listSessions exposes pinnedAt from the session directory sidecar", async () => {
    const agentsDir = path.join(tmpDir, "agents");
    const agentSessionDir = path.join(agentsDir, "hana", "sessions");
    const sessionPath = path.join(agentSessionDir, "pinned.jsonl");
    const pinnedAt = "2026-04-29T08:00:00.000Z";
    fs.mkdirSync(agentSessionDir, { recursive: true });
    fs.writeFileSync(sessionPath, [
      JSON.stringify({
        type: "session",
        id: "pinned",
        timestamp: "2026-04-29T07:00:00.000Z",
        cwd: "/tmp/work",
      }),
      JSON.stringify({
        type: "message",
        id: "u1",
        timestamp: "2026-04-29T07:01:00.000Z",
        message: { role: "user", content: "hello" },
      }),
      "",
    ].join("\n"));
    fs.writeFileSync(
      path.join(agentSessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(sessionPath)]: { pinnedAt } }, null, 2),
      "utf-8",
    );

    const coord = new SessionCoordinator(makeCoordinatorDeps({
      agentsDir,
      listAgents: () => [{ id: "hana", name: "Hana" }],
      agentIdFromSessionPath: (p) => {
        const rel = path.relative(agentsDir, p);
        return rel.split(path.sep)[0] || null;
      },
    }));

    const sessions = await coord.listSessions();

    expect(SessionManager.list).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].pinnedAt).toBe(pinnedAt);
    expect(sessions[0].agentId).toBe("hana");
  });
});
