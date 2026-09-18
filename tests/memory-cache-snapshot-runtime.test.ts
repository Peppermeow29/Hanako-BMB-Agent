import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

vi.mock("../lib/memory/compile.js", () => ({
  compileToday: vi.fn().mockResolvedValue("compiled"),
  compileDaily: vi.fn().mockResolvedValue("compiled"),
  assembleWeekFromDaily: vi.fn(),
  rollDailyWindow: vi.fn().mockResolvedValue({ folded: [], failed: [] }),
  compileLongterm: vi.fn().mockResolvedValue("compiled"),
  compileEditableFacts: vi.fn().mockResolvedValue("compiled"),
  assemble: vi.fn(),
  ensureEditableFactsBaseline: vi.fn(),
  migrateLegacyEditableFacts: vi.fn(() => ({ migrated: false, reason: "no-legacy-file" })),
  migrateLegacyWeekToLongterm: vi.fn().mockResolvedValue({ migrated: false }),
}));

vi.mock("../lib/memory/deep-memory.js", () => ({
  processDirtySessions: vi.fn().mockResolvedValue({ processed: 0, factsAdded: 0 }),
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createMemoryTicker } from "../lib/memory/memory-ticker.ts";
import { readCacheSnapshotObservation } from "../lib/memory/cache-snapshot-observation.ts";

type TickerOverrides = {
  summaryManager?: {
    rollingSummary: ReturnType<typeof vi.fn>;
    saveSummary: ReturnType<typeof vi.fn>;
    getSummary: ReturnType<typeof vi.fn>;
  };
  memoryReflectionRunner?: {
    runMemoryReflection: ReturnType<typeof vi.fn>;
  };
  buildSessionCacheSnapshot?: ReturnType<typeof vi.fn>;
  ensureSessionLoaded?: ReturnType<typeof vi.fn>;
  getSessionStreamFn?: ReturnType<typeof vi.fn>;
};

function writeSession(sessionPath) {
  const lines = [
    {
      type: "message",
      timestamp: "2026-06-03T10:00:00.000Z",
      message: { role: "user", content: "我想把 rolling summary 接上缓存快照。" },
    },
    {
      type: "message",
      timestamp: "2026-06-03T10:01:00.000Z",
      message: { role: "assistant", content: "我们可以先做 shadow，再切 write。" },
    },
  ];
  fs.writeFileSync(sessionPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
}

function makeTicker(tmpDir, injectedMode, overrides: TickerOverrides = {}) {
  const agentDir = path.join(tmpDir, "agents", "hana");
  const sessionDir = path.join(agentDir, "sessions");
  const memoryDir = path.join(agentDir, "memory");
  const sessionPath = path.join(sessionDir, "2026-06-03T10-00-00-000Z_cache.jsonl");
  const summaryManager = overrides.summaryManager || {
    rollingSummary: vi.fn().mockResolvedValue("official summary"),
    saveSummary: vi.fn(),
    getSummary: vi.fn().mockReturnValue(null),
  };
  const memoryReflectionRunner = overrides.memoryReflectionRunner || {
    runMemoryReflection: vi.fn(),
  };
  const buildSessionCacheSnapshot = overrides.buildSessionCacheSnapshot || vi.fn();

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "memory.md"), "# Memory\n\n现有正式记忆。\n", "utf-8");

  const ticker = createMemoryTicker({
    agentId: "hana",
    agentDir,
    summaryManager,
    configPath: path.join(agentDir, "config.yaml"),
    factStore: {},
    getResolvedMemoryModel: () => ({
      model: "memory-model",
      provider: "deepseek",
      api: "openai-completions",
      api_key: "test-key",
      base_url: "http://localhost:1234",
    }),
    getMemoryMasterEnabled: () => true,
    isSessionMemoryEnabled: () => true,
    getCacheSnapshotReflectionMode: () => injectedMode,
    memoryReflectionRunner,
    buildSessionCacheSnapshot,
    ensureSessionLoaded: overrides.ensureSessionLoaded,
    getSessionStreamFn: overrides.getSessionStreamFn || vi.fn(() => vi.fn()),
    sessionDir,
    memoryDir,
    memoryMdPath: path.join(memoryDir, "memory.md"),
    todayMdPath: path.join(memoryDir, "today.md"),
    weekMdPath: path.join(memoryDir, "week.md"),
    longtermMdPath: path.join(memoryDir, "longterm.md"),
    factsMdPath: path.join(memoryDir, "facts.md"),
  });

  return {
    ticker,
    agentDir,
    sessionPath,
    summaryManager,
    memoryReflectionRunner,
    buildSessionCacheSnapshot,
  };
}

describe("cache snapshot reflection runtime hard gate", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cache-snapshot-runtime-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ignores injected shadow mode and keeps the official rolling summary path", async () => {
    const {
      ticker,
      agentDir,
      sessionPath,
      summaryManager,
      memoryReflectionRunner,
      buildSessionCacheSnapshot,
    } = makeTicker(tmpDir, "shadow");
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledWith(
      "2026-06-03T10-00-00-000Z_cache",
      expect.any(Array),
      expect.objectContaining({ model: "memory-model" }),
      expect.objectContaining({ timeZone: expect.any(String) }),
    );
    expect(memoryReflectionRunner.runMemoryReflection).not.toHaveBeenCalled();
    expect(buildSessionCacheSnapshot).not.toHaveBeenCalled();
    expect(summaryManager.saveSummary).not.toHaveBeenCalled();
    expect(readCacheSnapshotObservation(agentDir)).toBeNull();
  });

  it("ignores injected write mode instead of replacing the official summary", async () => {
    const memoryReflectionRunner = {
      runMemoryReflection: vi.fn().mockRejectedValue(new Error("retired reflection should not run")),
    };
    const buildSessionCacheSnapshot = vi.fn(() => {
      throw new Error("retired snapshot should not build");
    });
    const {
      ticker,
      agentDir,
      sessionPath,
      summaryManager,
    } = makeTicker(tmpDir, "write", {
      memoryReflectionRunner,
      buildSessionCacheSnapshot,
    });
    writeSession(sessionPath);

    await ticker.flushSession(sessionPath);

    expect(summaryManager.rollingSummary).toHaveBeenCalledOnce();
    expect(summaryManager.saveSummary).not.toHaveBeenCalled();
    expect(memoryReflectionRunner.runMemoryReflection).not.toHaveBeenCalled();
    expect(buildSessionCacheSnapshot).not.toHaveBeenCalled();
    expect(readCacheSnapshotObservation(agentDir)).toBeNull();
  });

  it("keeps startup recovery on the normal rolling summary path when write is injected", async () => {
    const {
      ticker,
      sessionPath,
      summaryManager,
      memoryReflectionRunner,
      buildSessionCacheSnapshot,
    } = makeTicker(tmpDir, "write");
    writeSession(sessionPath);

    await ticker.tick();

    expect(summaryManager.rollingSummary).toHaveBeenCalledWith(
      "2026-06-03T10-00-00-000Z_cache",
      expect.any(Array),
      expect.anything(),
      expect.objectContaining({ timeZone: expect.any(String) }),
    );
    expect(memoryReflectionRunner.runMemoryReflection).not.toHaveBeenCalled();
    expect(buildSessionCacheSnapshot).not.toHaveBeenCalled();
  });
});
