import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const atomizeMock = vi.fn();
const dedupeMock = vi.fn();
const optimizeMock = vi.fn();
const composeMock = vi.fn();
const verifyMock = vi.fn();

vi.mock("../lib/memory/dream/model-runner.ts", () => ({
  atomizeDreamMemory: (...args: any[]) => atomizeMock(...args),
  dedupeDreamMemory: (...args: any[]) => dedupeMock(...args),
  optimizeDreamMemory: (...args: any[]) => optimizeMock(...args),
  composeDreamMemory: (...args: any[]) => composeMock(...args),
  verifyDreamSections: (...args: any[]) => verifyMock(...args),
  dreamModelId: () => "utility-test",
}));

import { createMemoryDreamRunner } from "../lib/memory/dream/runner.ts";

function seedMemory(memoryDir: string) {
  fs.mkdirSync(path.join(memoryDir, "daily"), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "facts.md"), "User prefers concise answers.\n");
  fs.writeFileSync(path.join(memoryDir, "today.md"), "Discussed memory quality.\n");
  fs.writeFileSync(path.join(memoryDir, "daily", "2026-08-07.md"), "## 2026-08-07\n\nReviewed memory design.\n");
  fs.writeFileSync(path.join(memoryDir, "week.md"), "## 2026-08-07\n\nReviewed memory design.\n");
  fs.writeFileSync(path.join(memoryDir, "longterm.md"), "Hana is the user's personal agent.\n");
  fs.writeFileSync(path.join(memoryDir, "memory.md"), "old compiled memory\n");
}

async function waitForCompletion(runner: ReturnType<typeof createMemoryDreamRunner>) {
  await vi.waitFor(() => expect(runner.getStatus().status).not.toBe("running"));
  return runner.getStatus();
}

describe("Memory Dream runner", () => {
  let tmpDir: string;
  let memoryDir: string;

  beforeEach(() => {
    atomizeMock.mockReset();
    dedupeMock.mockReset();
    optimizeMock.mockReset();
    composeMock.mockReset();
    verifyMock.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-dream-runner-"));
    memoryDir = path.join(tmpDir, "memory");
    seedMemory(memoryDir);

    atomizeMock.mockResolvedValue({
      sourceBlocks: [{ id: "source:facts:0", section: "facts", text: "User prefers concise answers.", order: 0 }],
      units: [{ id: "atom:0", sourceBlockIds: ["source:facts:0"], section: "facts", text: "User prefers concise answers.", order: 0 }],
    });
    dedupeMock.mockResolvedValue({
      inputUnits: [],
      units: [],
      groups: [],
      exactDuplicateOperations: [],
    });
    verifyMock.mockResolvedValue({ ok: true, insufficientCompression: false, compressionFeedback: [] });
    composeMock.mockImplementation(async ({ current, optimization }: any) => ({
      ...optimization,
      paragraphs: [],
      sections: current,
    }));
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  function makeRunner() {
    return createMemoryDreamRunner({
      memoryDir,
      memoryMdPath: path.join(memoryDir, "memory.md"),
      getResolvedMemoryModel: async () => ({ model: { id: "utility-test" } }),
      getLogicalDate: () => "2026-08-08",
      onCompiled: vi.fn(),
    });
  }

  it("does not create Dream state until explicitly started", () => {
    makeRunner();
    expect(fs.existsSync(path.join(memoryDir, "dream"))).toBe(false);
  });

  it("does not run models when only Today or Week has content", async () => {
    fs.writeFileSync(path.join(memoryDir, "facts.md"), "");
    fs.writeFileSync(path.join(memoryDir, "longterm.md"), "");
    const runner = makeRunner();

    runner.start({ trigger: "manual" });
    const status = await waitForCompletion(runner);

    expect(status.status).toBe("failed");
    expect(status.lastRun?.error).toContain("no memory to organize");
    expect(status.lastRun?.errorCode).toBe("dream_no_memory");
    expect(atomizeMock).not.toHaveBeenCalled();
    expect(dedupeMock).not.toHaveBeenCalled();
    expect(optimizeMock).not.toHaveBeenCalled();
    expect(composeMock).not.toHaveBeenCalled();
  });

  it("runs atomize, dedupe, optimize, compose, and verify in order using resident memory only", async () => {
    const order: string[] = [];
    atomizeMock.mockImplementation(async ({ current }: any) => {
      order.push("atomize");
      expect(current.facts).toBe("User prefers concise answers.");
      expect(current.longterm).toBe("Hana is the user's personal agent.");
      expect(current).not.toHaveProperty("factStore");
      return {
        sourceBlocks: [{ id: "source:facts:0", section: "facts", text: current.facts, order: 0 }],
        units: [{ id: "atom:0", sourceBlockIds: ["source:facts:0"], section: "facts", text: current.facts, order: 0 }],
      };
    });
    dedupeMock.mockImplementation(async ({ units }: any) => {
      order.push("dedupe");
      return {
        inputUnits: units,
        units,
        groups: [{ id: "group:0", sourceUnitIds: ["atom:0"], sourceBlockIds: ["source:facts:0"], section: "facts", relation: "distinct", order: 0 }],
        exactDuplicateOperations: [],
      };
    });
    optimizeMock.mockImplementation(async ({ current, dedupePlan }: any) => {
      order.push("optimize");
      return {
        sourceBlocks: [], atomicUnits: [], dedupePlan, optimizedUnits: [], removedGroups: [],
        sections: current,
        operations: [{ kind: "rewrite", sourceUnitIds: ["atom:0"], resultUnitIds: ["result:0"] }],
        mergedCount: 0, forgottenCount: 0,
      };
    });
    composeMock.mockImplementation(async ({ current, optimization }: any) => {
      order.push("compose");
      return {
        ...optimization,
        paragraphs: [
          { id: "paragraph:0", section: "facts", topic: "Preference", sourceUnitIds: ["result:0"], text: "User prefers concise replies.", order: 0 },
        ],
        sections: { ...current, facts: "User prefers concise replies.", longterm: "Hana is user's personal agent." },
        operations: [...optimization.operations, { kind: "compose", sourceUnitIds: ["result:0"], resultUnitIds: ["paragraph:0"] }],
      };
    });
    verifyMock.mockImplementation(async () => { order.push("verify"); return { ok: true }; });

    const runner = makeRunner();
    runner.start({ trigger: "manual" });
    const status = await waitForCompletion(runner);

    expect(status.status).toBe("succeeded");
    expect(order).toEqual(["atomize", "dedupe", "optimize", "compose", "verify"]);
    expect(status.lastRun).toEqual(expect.objectContaining({
      changed: true,
      changedSections: ["facts", "longterm"],
      mergedCount: 0,
      forgottenCount: 0,
      appliedOperationCount: 2,
    }));
    expect(fs.readFileSync(path.join(memoryDir, "facts.md"), "utf-8"))
      .toBe("User prefers concise replies.\n");
  });

  it("treats an exact no-op as successful without creating a revision", async () => {
    optimizeMock.mockImplementation(async ({ current, dedupePlan }: any) => ({
      sourceBlocks: [], atomicUnits: [], dedupePlan, optimizedUnits: [], removedGroups: [],
      sections: current, operations: [], mergedCount: 99, forgottenCount: 99,
    }));
    composeMock.mockImplementation(async ({ current, optimization }: any) => ({
      ...optimization,
      paragraphs: [],
      sections: current,
      operations: [{ kind: "compose", sourceUnitIds: ["invented"], resultUnitIds: ["invented"] }],
    }));
    const runner = makeRunner();

    runner.start({ trigger: "manual" });
    const status = await waitForCompletion(runner);

    expect(status.status).toBe("succeeded");
    expect(status.lastRun).toEqual(expect.objectContaining({
      changed: false,
      revisionId: null,
      mergedCount: 0,
      forgottenCount: 0,
      appliedOperationCount: 0,
    }));
    expect(fs.existsSync(path.join(memoryDir, "dream", "revisions"))).toBe(false);
  });

  it("runs one targeted Compose repair for advisory compression feedback and accepts a second advisory", async () => {
    optimizeMock.mockImplementation(async ({ current, dedupePlan }: any) => ({
      sourceBlocks: [], atomicUnits: [], dedupePlan,
      optimizedUnits: [{ id: "result:0", section: "facts", text: "User prefers concise answers.", order: 0 }],
      removedGroups: [], sections: current, operations: [], mergedCount: 0, forgottenCount: 0,
    }));
    composeMock
      .mockImplementationOnce(async ({ current, optimization }: any) => ({
        ...optimization,
        paragraphs: [{
          id: "paragraph:0", section: "facts", topic: "Preference", sourceUnitIds: ["result:0"],
          text: "User has a preference for answers that are concise.", order: 0,
        }],
        sections: { ...current, facts: "User has a preference for answers that are concise." },
        operations: [{ kind: "compose", sourceUnitIds: ["result:0"], resultUnitIds: ["paragraph:0"] }],
      }))
      .mockImplementationOnce(async ({ current, optimization, compressionRepair }: any) => {
        expect(compressionRepair).toEqual({
          previousParagraphs: [expect.objectContaining({ id: "paragraph:0" })],
          feedback: ["Use a shorter predicate."],
        });
        return {
          ...optimization,
          paragraphs: [{
            id: "paragraph:0", section: "facts", topic: "Preference", sourceUnitIds: ["result:0"],
            text: "User prefers concise replies.", order: 0,
          }],
          sections: { ...current, facts: "User prefers concise replies." },
          operations: [{ kind: "compose", sourceUnitIds: ["result:0"], resultUnitIds: ["paragraph:0"] }],
        };
      });
    const advisory = {
      ok: true,
      insufficientCompression: true,
      compressionFeedback: ["Use a shorter predicate."],
    };
    verifyMock.mockResolvedValueOnce(advisory).mockResolvedValueOnce(advisory);
    const runner = makeRunner();

    runner.start({ trigger: "manual" });
    const status = await waitForCompletion(runner);

    expect(status.status).toBe("succeeded");
    expect(composeMock).toHaveBeenCalledTimes(2);
    expect(verifyMock).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(memoryDir, "facts.md"), "utf-8"))
      .toBe("User prefers concise replies.\n");
  });

  it("leaves every memory section unchanged when any stage fails", async () => {
    dedupeMock.mockRejectedValue(new Error("deduper invalid"));
    const before = fs.readFileSync(path.join(memoryDir, "facts.md"), "utf-8");
    const runner = makeRunner();

    runner.start({ trigger: "manual" });
    const status = await waitForCompletion(runner);

    expect(status.status).toBe("failed");
    expect(status.lastRun?.error).toContain("deduper invalid");
    expect(status.lastRun?.errorCode).toBe("dream_run_failed");
    expect(optimizeMock).not.toHaveBeenCalled();
    expect(composeMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(memoryDir, "facts.md"), "utf-8")).toBe(before);
    expect(fs.existsSync(path.join(memoryDir, "dream", "revisions"))).toBe(false);
  });

  it("preserves an existing public code on a failed run", async () => {
    atomizeMock.mockRejectedValue(Object.assign(new Error("Dream service is offline"), {
      code: "dream_unavailable",
    }));
    const runner = makeRunner();

    runner.start({ trigger: "manual" });
    const status = await waitForCompletion(runner);

    expect(status.lastRun).toEqual(expect.objectContaining({
      status: "failed",
      error: "Dream service is offline",
      errorCode: "dream_unavailable",
    }));
  });

  it("records a precise code when resident memory changes during Dream", async () => {
    optimizeMock.mockImplementation(async ({ current, dedupePlan }: any) => ({
      sourceBlocks: [], atomicUnits: [], dedupePlan, optimizedUnits: [], removedGroups: [],
      sections: current, operations: [], mergedCount: 0, forgottenCount: 0,
    }));
    verifyMock.mockImplementationOnce(async () => {
      fs.writeFileSync(path.join(memoryDir, "facts.md"), "User changed memory while Dream ran.\n");
      return { ok: true, insufficientCompression: false, compressionFeedback: [] };
    });
    const runner = makeRunner();

    runner.start({ trigger: "manual" });
    const status = await waitForCompletion(runner);

    expect(status.status).toBe("failed");
    expect(status.lastRun).toEqual(expect.objectContaining({
      errorCode: "dream_memory_changed",
      revisionId: null,
      changed: false,
    }));
    expect(status.lastRun?.error).toContain("Memory changed while Dream was running");
    expect(fs.existsSync(path.join(memoryDir, "dream", "revisions"))).toBe(false);
  });

  it("reads historical Dream state that predates errorCode", () => {
    const dreamDir = path.join(memoryDir, "dream");
    fs.mkdirSync(dreamDir, { recursive: true });
    fs.writeFileSync(path.join(dreamDir, "state.json"), `${JSON.stringify({
      schemaVersion: 1,
      lastAutomaticAttemptDate: null,
      lastSuccessfulManualDate: null,
      lastRun: {
        runId: "old-run",
        trigger: "manual",
        status: "failed",
        startedAt: "2026-08-07T10:00:00.000Z",
        finishedAt: "2026-08-07T10:00:01.000Z",
        logicalDate: "2026-08-07",
        error: "historical failure",
      },
      updatedAt: "2026-08-07T10:00:01.000Z",
    }, null, 2)}\n`);

    const status = makeRunner().getStatus();

    expect(status.status).toBe("failed");
    expect(status.lastRun).toEqual(expect.objectContaining({
      runId: "old-run",
      error: "historical failure",
    }));
    expect(status.lastRun).not.toHaveProperty("errorCode");
  });

  it("codes a missing restore target without hiding the English detail", async () => {
    const runner = makeRunner();

    await expect(runner.restoreRevision("missing")).rejects.toMatchObject({
      code: "dream_revision_not_found",
      message: "Dream revision not found",
    });
  });

  it("records one automatic attempt per logical day before running models", async () => {
    atomizeMock.mockRejectedValue(new Error("stop after eligibility check"));
    const runner = makeRunner();

    expect(runner.startAutomaticIfEligible("2026-08-08")?.status).toBe("running");
    expect(runner.startAutomaticIfEligible("2026-08-08")).toBeNull();
    const state = JSON.parse(fs.readFileSync(path.join(memoryDir, "dream", "state.json"), "utf-8"));
    expect(state.lastAutomaticAttemptDate).toBe("2026-08-08");
    await waitForCompletion(runner);
  });
});
