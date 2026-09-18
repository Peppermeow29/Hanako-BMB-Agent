import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HanaEngine } from "../core/engine.ts";
import { autoProjectIdForCwd, UNCATEGORIZED_PROJECT_ID } from "../shared/session-projects.ts";

// ---------------------------------------------------------------------------
// Removed Computer Use runtime compatibility
// ---------------------------------------------------------------------------

describe("HanaEngine removed Computer Use compatibility", () => {
  let tmpDir = null;
  let engines: HanaEngine[] = [];

  afterEach(async () => {
    for (const engine of engines.splice(0).reverse()) {
      await engine.dispose();
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function trackEngine(engine: HanaEngine) {
    engines.push(engine);
    return engine;
  }

  function untrackEngine(engine: HanaEngine) {
    engines = engines.filter((candidate) => candidate !== engine);
  }

  function createEngine() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-engine-computer-use-"));
    return trackEngine(new HanaEngine({
      hanakoHome: tmpDir,
      productDir: tmpDir,
      agentId: "hana",
    } as any));
  }

  it("does not construct the Computer Use runtime during engine construction", () => {
    const engine = createEngine();

    expect(engine._computerProviders).toBeNull();
    expect(engine._computerHost).toBeNull();
  });

  it("rejects attempts to enable the removed Computer Use runtime", () => {
    const engine = createEngine();

    const disabled = engine.setComputerUseSettings({ enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(engine._computerProviders).toBeNull();
    expect(engine._computerHost).toBeNull();

    expect(() => engine.setComputerUseSettings({ enabled: true })).toThrow(/not supported/);
    expect(() => engine.getComputerHost()).toThrow(/not included/);
    expect(engine._computerHost).toBeNull();
  });

  it("still disposes a legacy injected host during engine shutdown", async () => {
    const engine = createEngine();
    const dispose = vi.fn(async () => {});
    engine._computerHost = { dispose };

    await engine.dispose();
    untrackEngine(engine);

    expect(dispose).toHaveBeenCalledOnce();
    expect(engine._computerHost).toBeNull();
    expect(engine._computerProviders).toBeNull();
  });

  it("stores usage ledger entries under hanakoHome so engine restarts keep them", () => {
    const engine = createEngine();
    engine.usageLedger.record({
      model: { provider: "openai", modelId: "gpt-5", api: "openai-completions" },
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      usageContext: {
        source: { subsystem: "session", operation: "reply", surface: "desktop", trigger: "user" },
        attribution: { kind: "session", agentId: "hana", sessionPath: "/sessions/a.jsonl" },
      },
    });

    const restarted = trackEngine(new HanaEngine({
      hanakoHome: tmpDir,
      productDir: tmpDir,
      agentId: "hana",
    } as any));

    expect(restarted.usageLedger.list({}).entries).toMatchObject([
      {
        attribution: { kind: "session", sessionPath: "/sessions/a.jsonl" },
        usage: { totalTokens: 12 },
      },
    ]);
    expect(fs.existsSync(path.join(tmpDir, "usage-ledger.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Extension factories
// ---------------------------------------------------------------------------

function makeFactory(name) {
  return Object.assign(() => {}, { _testName: name });
}

function names(factories) {
  return factories.map((factory) => factory._testName);
}

function makeEngine({ pluginFactories = [] } = {}) {
  const engine = Object.create(HanaEngine.prototype);
  engine._coreExtensionFactories = [
    makeFactory("core-provider"),
    makeFactory("core-image"),
  ];
  engine._frameworkExtFactories = [];
  engine._extensionFactories = [...engine._coreExtensionFactories];
  engine._pluginManager = {
    getExtensionFactories: vi.fn(() => pluginFactories),
  };
  engine._resourceLoader = {
    reload: vi.fn().mockResolvedValue(undefined),
  };
  engine._sessionCoord = null;
  return engine;
}

describe("HanaEngine extension factories", () => {
  it("reloads ResourceLoader after plugin extension factories are synced", async () => {
    const engine = makeEngine({
      pluginFactories: [makeFactory("plugin-a")],
    });

    await engine.syncPluginExtensions();

    expect(names(engine._extensionFactories)).toEqual([
      "core-provider",
      "core-image",
      "plugin-a",
    ]);
    expect(engine._resourceLoader.reload).toHaveBeenCalledTimes(1);
  });

  it("keeps all core factories when framework factories are registered later", async () => {
    const engine = makeEngine({
      pluginFactories: [makeFactory("plugin-a")],
    });
    const frameworkFactory = makeFactory("framework-deferred");

    await engine.registerExtensionFactory(frameworkFactory);

    expect(names(engine._extensionFactories)).toEqual([
      "core-provider",
      "core-image",
      "framework-deferred",
      "plugin-a",
    ]);
    expect(engine._resourceLoader.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload live sessions after plugin extension factories change", async () => {
    const engine = makeEngine({
      pluginFactories: [makeFactory("plugin-a")],
    });
    engine._sessionCoord = {
      reloadExtensionRunners: vi.fn().mockResolvedValue({ reloaded: 1, skipped: 0, failed: 0 }),
    };

    await engine.syncPluginExtensions();

    expect(engine._sessionCoord.reloadExtensionRunners).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Session API
// ---------------------------------------------------------------------------

describe("HanaEngine session API", () => {
  it("exposes session model switch state without leaking coordinator internals", () => {
    const engine = Object.create(HanaEngine.prototype);
    engine._sessionCoord = {
      isSessionSwitching: vi.fn(() => true),
    };

    expect(engine.isSessionSwitching("/tmp/session.jsonl")).toBe(true);
    expect(engine._sessionCoord.isSessionSwitching).toHaveBeenCalledWith("/tmp/session.jsonl");
  });

  it("deletes a project by moving explicit and cwd-derived sessions to uncategorized", async () => {
    const engine = Object.create(HanaEngine.prototype);
    const cwdProjectId = autoProjectIdForCwd("/tmp/project-hana");
    engine._sessionProjects = {
      deleteProject: vi.fn(() => ({ folders: [], projects: [] })),
    };
    engine._sessionCoord = {
      listSessions: vi.fn(async () => [
        { path: "/tmp/agents/hana/sessions/explicit.jsonl", cwd: "/elsewhere", projectId: cwdProjectId },
        { path: "/tmp/agents/hana/sessions/implicit.jsonl", cwd: "/tmp/project-hana", projectId: null },
        { path: "/tmp/agents/hana/sessions/other.jsonl", cwd: "/tmp/other", projectId: null },
      ]),
      writeSessionMeta: vi.fn(async () => undefined),
    };

    const result = await engine.deleteSessionProject(cwdProjectId);

    expect(engine._sessionProjects.deleteProject).toHaveBeenCalledWith(cwdProjectId);
    expect(engine._sessionCoord.writeSessionMeta).toHaveBeenCalledTimes(2);
    expect(engine._sessionCoord.writeSessionMeta).toHaveBeenCalledWith(
      "/tmp/agents/hana/sessions/explicit.jsonl",
      { projectId: UNCATEGORIZED_PROJECT_ID },
    );
    expect(engine._sessionCoord.writeSessionMeta).toHaveBeenCalledWith(
      "/tmp/agents/hana/sessions/implicit.jsonl",
      { projectId: UNCATEGORIZED_PROJECT_ID },
    );
    expect(result).toEqual({
      catalog: { folders: [], projects: [] },
      assignment: {
        projectId: UNCATEGORIZED_PROJECT_ID,
        sessionPaths: [
          "/tmp/agents/hana/sessions/explicit.jsonl",
          "/tmp/agents/hana/sessions/implicit.jsonl",
        ],
      },
    });
  });
});
