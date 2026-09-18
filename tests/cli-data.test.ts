import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs, helpText } from "../cli/args.ts";
import { runDataDiagnose, runDataCheckpoints, runDataRestore } from "../cli/data.ts";
import { createDataEpochCheckpointProvider } from "../core/data-epoch-checkpoint-provider.ts";
import { restoreDataEpochCheckpoint } from "../core/data-epoch-restore.ts";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import type { StoreDescriptor } from "../shared/persistence/store-registry-types.ts";
import { writeDataEpochJournal, writeDataEpochStamp } from "../shared/data-epoch.cjs";

const tempDirs: string[] = [];

function makeHomeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-cli-data-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Mirrors tests/data-epoch-restore.test.ts's own testStore/seedJsonStore/
// buildCheckpoint helpers (not imported — that file does not export them,
// and this suite must not modify it to do so).
function testStore(overrides: Partial<StoreDescriptor> & { id: string; pathPatterns: string[] }): StoreDescriptor {
  return {
    ...PERSISTENT_STORES[0],
    ...overrides,
    pathPattern: overrides.pathPatterns[0],
    siteRules: overrides.siteRules ?? [],
  };
}

function seedJsonStore(homeDir: string, relPath: string, content: unknown) {
  const absPath = path.join(homeDir, ...relPath.split("/"));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(content));
}

async function buildCheckpoint(args: {
  homeDir: string;
  store: StoreDescriptor;
  transitionId: string;
  fromEpoch?: number;
  toEpoch?: number;
}) {
  const { homeDir, store, transitionId, fromEpoch = 1, toEpoch = 2 } = args;
  const provider = createDataEpochCheckpointProvider({ stores: [store] });
  return provider.create({ homeDir, fromEpoch, toEpoch, transitionId, affectedStoreIds: [store.id] });
}

function snapshotTree(homeDir: string): string[] {
  if (!fs.existsSync(homeDir)) return [];
  return (fs.readdirSync(homeDir, { recursive: true }) as string[]).sort();
}

function collectOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call) => call.join(" ")).join("\n");
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

describe("CLI args: data command family", () => {
  it("parses each data subcommand", () => {
    expect(parseCliArgs(["data", "diagnose"])).toMatchObject({ command: "data", subcommand: "diagnose" });
    expect(parseCliArgs(["data", "checkpoints"])).toMatchObject({ command: "data", subcommand: "checkpoints" });
    expect(parseCliArgs(["data", "restore", "transition-1-2"])).toMatchObject({
      command: "data",
      subcommand: "restore",
      target: "transition-1-2",
    });
  });

  it("parses --confirm-token alongside restore", () => {
    expect(parseCliArgs(["data", "restore", "t-1", "--confirm-token", "restore t-1"])).toMatchObject({
      command: "data",
      subcommand: "restore",
      target: "t-1",
      confirmToken: "restore t-1",
    });
  });

  it("rejects a missing data subcommand", () => {
    expect(parseCliArgs(["data"])).toMatchObject({
      command: "help",
      error: expect.stringMatching(/diagnose, checkpoints, or restore/i),
    });
  });

  it("rejects an unknown data subcommand", () => {
    expect(parseCliArgs(["data", "frobnicate"])).toMatchObject({
      command: "help",
      error: expect.stringMatching(/frobnicate/),
    });
  });

  it("rejects data restore without a transitionId", () => {
    expect(parseCliArgs(["data", "restore"])).toMatchObject({
      command: "help",
      error: expect.stringMatching(/requires a transitionId/i),
    });
  });

  it("mentions the data commands in the help text", () => {
    expect(helpText()).toContain("data diagnose");
    expect(helpText()).toContain("data checkpoints");
    expect(helpText()).toContain("data restore");
    expect(helpText()).toContain("--confirm-token");
  });
});

describe("hana data diagnose — read-only across three home states", () => {
  it("reports a clean, unstamped home", async () => {
    const home = makeHomeDir();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runDataDiagnose({ hanaHome: home });

    expect(code).toBe(0);
    const output = collectOutput(logSpy);
    expect(output).toMatch(/none \(unstamped home\)/);
    expect(output).toMatch(/steady, no transition in progress/);
    expect(output).toMatch(/none available/);
  });

  it("reports an in-progress transition journal with its continuation suggestion", async () => {
    const home = makeHomeDir();
    // A journal at phase "migrating" is only internally consistent with a
    // stamp that has already raised the reader barrier to toEpoch while
    // still holding committedDataEpoch at fromEpoch (see
    // core/data-epoch-coordinator.ts's transitionConsistency: phase
    // "migrating" requires the "barrier_raised" stamp shape). A same-epoch
    // stamp here would read back as corrupt-transition instead.
    await writeDataEpochStamp(home, { minimumReaderEpoch: 2, committedDataEpoch: 1, lastVersion: "1.0.0" });
    await writeDataEpochJournal(home, {
      transitionId: "transition-1-2",
      fromEpoch: 1,
      toEpoch: 2,
      migrationIds: ["m1"],
      recoveryModes: { m1: "restore-only" },
      phase: "migrating",
      lastVersion: "2.0.0",
      affectedStoreIds: ["some-store"],
      checkpointId: "checkpoint-1-2",
      checkpointReceipt: { id: "checkpoint-1-2" },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runDataDiagnose({ hanaHome: home });

    expect(code).toBe(0);
    const output = stripAnsi(collectOutput(logSpy));
    expect(output).toContain("transition-1-2");
    expect(output).toContain("migrating");
    expect(output).toMatch(/Continuation\s+restore-only/);
  });

  it("reports an available checkpoint", async () => {
    const home = makeHomeDir();
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    seedJsonStore(home, "user/preferences.json", { locale: "zh" });
    await buildCheckpoint({ homeDir: home, store, transitionId: "t-diag" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runDataDiagnose({ hanaHome: home });

    expect(code).toBe(0);
    const output = collectOutput(logSpy);
    expect(output).toMatch(/1 available/);
  });

  it("never writes to the home directory across all three states", async () => {
    const home = makeHomeDir();
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    seedJsonStore(home, "user/preferences.json", { locale: "zh" });
    await buildCheckpoint({ homeDir: home, store, transitionId: "t-diag-zero-write" });
    await writeDataEpochStamp(home, { minimumReaderEpoch: 1, committedDataEpoch: 1, lastVersion: "1.0.0" });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const before = snapshotTree(home);
    await runDataDiagnose({ hanaHome: home });
    const after = snapshotTree(home);

    expect(after).toEqual(before);
  });
});

describe("hana data checkpoints", () => {
  it("prints a friendly message when nothing is available", async () => {
    const home = makeHomeDir();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runDataCheckpoints({ hanaHome: home });

    expect(code).toBe(0);
    expect(collectOutput(logSpy)).toMatch(/no data-epoch checkpoints/i);
  });

  it("lists complete checkpoints with transitionId, epoch range, createdAt, store count, and size", async () => {
    const home = makeHomeDir();
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    seedJsonStore(home, "user/preferences.json", { locale: "zh" });
    await buildCheckpoint({ homeDir: home, store, transitionId: "t-list", fromEpoch: 1, toEpoch: 2 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runDataCheckpoints({ hanaHome: home });

    expect(code).toBe(0);
    const output = stripAnsi(collectOutput(logSpy));
    expect(output).toContain("t-list");
    expect(output).toContain("1 → 2");
    expect(output).toMatch(/Stores\s+1/);
    expect(output).toMatch(/Size\s+\d/);
  });

  it("skips .tmp-* and .invalid-* directories and reports them as a count instead of listing them", async () => {
    const home = makeHomeDir();
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    seedJsonStore(home, "user/preferences.json", { locale: "zh" });
    await buildCheckpoint({ homeDir: home, store, transitionId: "t-real" });
    fs.mkdirSync(path.join(home, "data-epoch-checkpoints", "t-real.invalid-123"), { recursive: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runDataCheckpoints({ hanaHome: home });

    expect(code).toBe(0);
    const output = collectOutput(logSpy);
    expect(output).toContain("t-real");
    expect(output).not.toContain("t-real.invalid-123");
    expect(output).toMatch(/1 incomplete\/invalid checkpoint directory found and skipped/);
  });
});

describe("hana data restore — confirmation is never skippable", () => {
  it("aborts on a TTY when the retyped confirmation does not match, without calling restore", async () => {
    const home = makeHomeDir();
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    seedJsonStore(home, "user/preferences.json", { locale: "zh" });
    await buildCheckpoint({ homeDir: home, store, transitionId: "t-mismatch" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const restore = vi.fn();

    const code = await runDataRestore({
      transitionId: "t-mismatch",
      hanaHome: home,
      restore,
      isTTY: true,
      promptConfirmation: async () => "restore wrong-id",
    });

    expect(code).toBe(1);
    expect(restore).not.toHaveBeenCalled();
    expect(collectOutput(errorSpy)).toMatch(/did not match/i);
  });

  it("refuses on a non-TTY without --confirm-token, without calling restore", async () => {
    const home = makeHomeDir();
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    seedJsonStore(home, "user/preferences.json", { locale: "zh" });
    await buildCheckpoint({ homeDir: home, store, transitionId: "t-no-tty" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const restore = vi.fn();

    const code = await runDataRestore({ transitionId: "t-no-tty", hanaHome: home, restore, isTTY: false });

    expect(code).toBe(1);
    expect(restore).not.toHaveBeenCalled();
    expect(collectOutput(errorSpy)).toMatch(/stdin is not a tty/i);
    expect(collectOutput(errorSpy)).toContain("--confirm-token");
  });

  it("refuses on a non-TTY when --confirm-token does not exactly match, without calling restore", async () => {
    const home = makeHomeDir();
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    seedJsonStore(home, "user/preferences.json", { locale: "zh" });
    await buildCheckpoint({ homeDir: home, store, transitionId: "t-bad-token" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const restore = vi.fn();

    const code = await runDataRestore({
      transitionId: "t-bad-token",
      hanaHome: home,
      restore,
      isTTY: false,
      confirmToken: "restore t-bad-token-typo",
    });

    expect(code).toBe(1);
    expect(restore).not.toHaveBeenCalled();
    expect(collectOutput(errorSpy)).toMatch(/did not match/i);
  });

  it("errors clearly when the transitionId has no checkpoint on disk", async () => {
    const home = makeHomeDir();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const restore = vi.fn();

    const code = await runDataRestore({ transitionId: "does-not-exist", hanaHome: home, restore, isTTY: false });

    expect(code).toBe(1);
    expect(restore).not.toHaveBeenCalled();
    expect(collectOutput(errorSpy)).toMatch(/no checkpoint found/i);
  });

  it("restores end-to-end with the exact confirm token on a non-TTY, using the real provider and restore transaction", async () => {
    const home = makeHomeDir();
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    seedJsonStore(home, "user/preferences.json", { locale: "zh" });
    await buildCheckpoint({ homeDir: home, store, transitionId: "t-e2e", fromEpoch: 1, toEpoch: 2 });
    // Simulate the post-checkpoint upgrade having changed the live file —
    // restore must move this aside into quarantine, not delete it, and put
    // the checkpointed content back.
    seedJsonStore(home, "user/preferences.json", { locale: "zh" });

    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runDataRestore({
      transitionId: "t-e2e",
      hanaHome: home,
      isTTY: false,
      confirmToken: "restore t-e2e",
      restore: (args) => restoreDataEpochCheckpoint({ ...args, stores: [store] }),
    });

    expect(code).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    const restored = JSON.parse(fs.readFileSync(path.join(home, "user", "preferences.json"), "utf-8"));
    expect(restored).toEqual({ locale: "zh" });
    expect(fs.existsSync(path.join(home, "data-epoch-restores.log"))).toBe(true);
  });

  it("prompts for confirmation on a TTY and restores when the retyped phrase matches exactly", async () => {
    const home = makeHomeDir();
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    seedJsonStore(home, "user/preferences.json", { locale: "zh" });
    await buildCheckpoint({ homeDir: home, store, transitionId: "t-tty-ok", fromEpoch: 1, toEpoch: 2 });
    // Byte length must differ from the checkpointed content (the restore
    // fast-path uses size as a cheap first check before reconciliation).
    seedJsonStore(home, "user/preferences.json", { locale: "en-US" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const prompt = vi.fn().mockResolvedValue("restore t-tty-ok");

    const code = await runDataRestore({
      transitionId: "t-tty-ok",
      hanaHome: home,
      isTTY: true,
      promptConfirmation: prompt,
      restore: (args) => restoreDataEpochCheckpoint({ ...args, stores: [store] }),
    });

    expect(code).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][0]).toContain("restore t-tty-ok");
    const restored = JSON.parse(fs.readFileSync(path.join(home, "user", "preferences.json"), "utf-8"));
    expect(restored).toEqual({ locale: "zh" });
  });
});
