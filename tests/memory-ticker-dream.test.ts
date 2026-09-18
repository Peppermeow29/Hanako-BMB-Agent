import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dreamInstances: any[] = [];

vi.mock("../lib/memory/dream/runner.ts", () => ({
  createMemoryDreamRunner: vi.fn(() => {
    const instance = {
      start: vi.fn(() => ({ status: "running", runId: "manual" })),
      startAutomaticIfEligible: vi.fn(() => ({ status: "running", runId: "automatic" })),
      getStatus: vi.fn(() => ({ status: "idle", runId: null, startedAt: null, lastRun: null })),
      restoreRevision: vi.fn(),
      stop: vi.fn(),
      isRunning: vi.fn(() => false),
    };
    dreamInstances.push(instance);
    return instance;
  }),
}));

vi.mock("../lib/memory/compile.ts", () => ({
  compileToday: vi.fn().mockResolvedValue("compiled"),
  compileDaily: vi.fn().mockResolvedValue("compiled"),
  assembleWeekFromDaily: vi.fn(),
  rollDailyWindow: vi.fn().mockResolvedValue({ folded: [], failed: [] }),
  compileEditableFacts: vi.fn().mockResolvedValue("compiled"),
  assemble: vi.fn(),
  ensureEditableFactsBaseline: vi.fn(),
  migrateLegacyEditableFacts: vi.fn(),
  migrateLegacyWeekToLongterm: vi.fn().mockResolvedValue({ migrated: false }),
}));

vi.mock("../lib/memory/deep-memory.ts", () => ({
  processDirtySessions: vi.fn().mockResolvedValue({ processed: 0, factsAdded: 0 }),
}));

vi.mock("../lib/debug-log.ts", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createMemoryTicker } from "../lib/memory/memory-ticker.ts";
import { compileDaily } from "../lib/memory/compile.ts";
import { createMemoryDreamRunner } from "../lib/memory/dream/runner.ts";

function makeTicker(tmpDir: string, getDreamAutoEnabled?: () => boolean) {
  fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
  return createMemoryTicker({
    summaryManager: {
      rollingSummary: vi.fn(),
      getSummary: vi.fn(() => null),
      listSummaries: vi.fn(() => []),
    },
    factStore: { getAll: vi.fn(() => []) },
    getResolvedMemoryModel: vi.fn(async () => ({ model: { id: "test" } })),
    getMemoryMasterEnabled: () => true,
    getDreamAutoEnabled,
    sessionDir: path.join(tmpDir, "sessions"),
    memoryDir: tmpDir,
    memoryMdPath: path.join(tmpDir, "memory.md"),
    todayMdPath: path.join(tmpDir, "today.md"),
    weekMdPath: path.join(tmpDir, "week.md"),
    longtermMdPath: path.join(tmpDir, "longterm.md"),
    factsMdPath: path.join(tmpDir, "facts.md"),
  });
}

describe("MemoryTicker Dream opt-in boundary", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dreamInstances.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-ticker-dream-"));
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("does not touch Dream when the per-Agent setting is absent or false", async () => {
    const ticker = makeTicker(tmpDir);
    await ticker.tick();

    expect(vi.mocked(createMemoryDreamRunner).mock.calls[0]?.[0]).not.toHaveProperty("factStore");
    expect(dreamInstances[0].startAutomaticIfEligible).not.toHaveBeenCalled();
    expect(dreamInstances[0].start).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, "dream"))).toBe(false);
    await ticker.stop();
  });

  it("starts automatic Dream only after the normal daily conveyor succeeds", async () => {
    const ticker = makeTicker(tmpDir, () => true);
    await ticker.tick();

    expect(dreamInstances[0].startAutomaticIfEligible).toHaveBeenCalledOnce();
    await ticker.stop();
  });

  it("does not start automatic Dream when a daily step fails", async () => {
    vi.mocked(compileDaily).mockRejectedValueOnce(new Error("daily failed"));
    const ticker = makeTicker(tmpDir, () => true);
    await ticker.tick();

    expect(dreamInstances[0].startAutomaticIfEligible).not.toHaveBeenCalled();
    await ticker.stop();
  });

  it("uses separate Dream runners for separate Agent tickers", async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-ticker-dream-other-"));
    try {
      const first = makeTicker(tmpDir, () => true);
      const second = makeTicker(otherDir, () => false);
      await first.tick();
      await second.tick();

      expect(dreamInstances).toHaveLength(2);
      expect(dreamInstances[0].startAutomaticIfEligible).toHaveBeenCalledOnce();
      expect(dreamInstances[1].startAutomaticIfEligible).not.toHaveBeenCalled();
      await first.stop();
      await second.stop();
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
