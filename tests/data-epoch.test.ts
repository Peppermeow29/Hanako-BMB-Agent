import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDataEpochJournal,
  createDataEpochRestoreJournal,
  createDataEpochStamp,
  dataEpochJournalPath,
  dataEpochStampPath,
  DATA_EPOCH_RESTORE_JOURNAL_PHASES,
  describeDataEpochBlock,
  readDataEpochJournal,
  readDataEpochRestoreJournal,
  readDataEpochStamp,
  removeDataEpochJournal,
  republishDataEpochStampForRestore,
  writeDataEpochJournal,
  writeDataEpochRestoreJournal,
  writeDataEpochStamp,
} from "../shared/data-epoch.cjs";

const tempDirs: string[] = [];

function makeHomeDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hana-data-epoch-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("data epoch stamp", () => {
  it("maps the legacy high-water shape to one fully committed epoch", () => {
    const homeDir = makeHomeDir();
    fs.writeFileSync(dataEpochStampPath(homeDir), JSON.stringify({ epoch: 3, lastVersion: "1.0.0" }));

    expect(readDataEpochStamp(homeDir)).toMatchObject({
      status: "ok",
      format: "legacy-v1",
      stamp: {
        schemaVersion: 1,
        epoch: 3,
        minimumReaderEpoch: 3,
        committedDataEpoch: 3,
        lastVersion: "1.0.0",
      },
    });
  });

  it("writes and rereads a v2 barrier/commit pair with durable JSON bytes", async () => {
    const homeDir = makeHomeDir();
    const written = await writeDataEpochStamp(homeDir, {
      minimumReaderEpoch: 4,
      committedDataEpoch: 3,
      lastVersion: "2.0.0",
    });

    expect(written).toMatchObject({
      schemaVersion: 2,
      epoch: 4,
      minimumReaderEpoch: 4,
      committedDataEpoch: 3,
      lastVersion: "2.0.0",
    });
    expect(fs.readFileSync(dataEpochStampPath(homeDir), "utf8")).toMatch(/\n$/);
    expect(readDataEpochStamp(homeDir)).toMatchObject({ status: "ok", format: "v2", stamp: written });
  });

  it("fails closed on corrupt JSON and impossible v2 epoch relationships", () => {
    const homeDir = makeHomeDir();
    fs.writeFileSync(dataEpochStampPath(homeDir), "{broken");
    expect(readDataEpochStamp(homeDir)).toMatchObject({ status: "corrupt" });

    fs.writeFileSync(dataEpochStampPath(homeDir), JSON.stringify({
      schemaVersion: 2,
      epoch: 3,
      minimumReaderEpoch: 4,
      committedDataEpoch: 3,
      lastVersion: "1.0.0",
      updatedAt: new Date().toISOString(),
    }));
    expect(readDataEpochStamp(homeDir)).toMatchObject({
      status: "corrupt",
      detail: expect.stringContaining("epoch` to equal `minimumReaderEpoch"),
    });

    expect(() => createDataEpochStamp({
      minimumReaderEpoch: 3,
      committedDataEpoch: 4,
      lastVersion: "1.0.0",
    })).toThrow(/cannot exceed/);
  });
});

describe("data epoch transition journal", () => {
  const base = {
    transitionId: "transition-1-2",
    fromEpoch: 1,
    toEpoch: 2,
    migrationIds: ["preferences-1-to-2"],
    affectedStoreIds: ["user-preferences"],
    recoveryModes: { "preferences-1-to-2": "restore-only" as const },
    lastVersion: "2.0.0",
  };

  it("requires a checkpoint receipt after the prepared phase", () => {
    expect(createDataEpochJournal({ ...base, phase: "prepared" })).toMatchObject({
      schemaVersion: 1,
      phase: "prepared",
      checkpointId: null,
      checkpointReceipt: null,
    });
    expect(() => createDataEpochJournal({ ...base, phase: "checkpoint_complete" })).toThrow(/requires a checkpoint/);
  });

  it("writes, validates, and durably removes a journal", async () => {
    const homeDir = makeHomeDir();
    const written = await writeDataEpochJournal(homeDir, {
      ...base,
      phase: "checkpoint_complete",
      checkpointId: "checkpoint-1",
      checkpointReceipt: { id: "checkpoint-1", digest: "sha256:test" },
    });

    expect(readDataEpochJournal(homeDir)).toMatchObject({ status: "ok", journal: written });
    expect(await removeDataEpochJournal(homeDir)).toBe(true);
    expect(await removeDataEpochJournal(homeDir)).toBe(false);
    expect(readDataEpochJournal(homeDir)).toMatchObject({ status: "missing" });
  });

  it("rejects malformed or unknown journal phases instead of guessing", () => {
    const homeDir = makeHomeDir();
    fs.writeFileSync(dataEpochJournalPath(homeDir), JSON.stringify({
      ...base,
      schemaVersion: 1,
      phase: "mystery",
      checkpointId: null,
      checkpointReceipt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    expect(readDataEpochJournal(homeDir)).toMatchObject({
      status: "corrupt",
      detail: expect.stringContaining("invalid phase"),
    });
  });
});

describe("describeDataEpochBlock", () => {
  it("includes both epochs, the last version, and the explicit override in both languages", () => {
    const message = describeDataEpochBlock({ stampEpoch: 5, ownEpoch: 3, stampLastVersion: "2.0.0" });
    expect(message).toContain("epoch=5");
    expect(message).toContain("epoch=3");
    expect(message).toContain("2.0.0");
    expect(message).toContain("HANA_ALLOW_DATA_DOWNGRADE=1");
    expect(message).toContain("继续使用旧内核");
  });
});

describe("data epoch restore journal", () => {
  const restoreBase = {
    restoreId: "restore-1",
    transitionId: "transition-1-2",
    fromEpoch: 1,
    phase: "restore:starting" as const,
  };

  it("writes and rereads a restore-phase journal, and a forward reader treats it as corrupt", async () => {
    const homeDir = makeHomeDir();
    const written = await writeDataEpochRestoreJournal(homeDir, restoreBase);

    expect(written).toMatchObject({
      kind: "restore",
      restoreSchemaVersion: 1,
      restoreId: "restore-1",
      transitionId: "transition-1-2",
      fromEpoch: 1,
      phase: "restore:starting",
    });
    expect(readDataEpochRestoreJournal(homeDir)).toMatchObject({ status: "ok", journal: written });

    // Same on-disk file, same path — the *forward* reader must fail closed
    // on it exactly the way it fails closed on any other unrecognized
    // journal shape, never guessing that a restore journal is a (possibly
    // stale) forward transition.
    expect(readDataEpochJournal(homeDir)).toMatchObject({ status: "corrupt" });
  });

  it("a forward transition journal is, symmetrically, unreadable as a restore journal", async () => {
    const homeDir = makeHomeDir();
    await writeDataEpochJournal(homeDir, {
      transitionId: "transition-1-2",
      fromEpoch: 1,
      toEpoch: 2,
      migrationIds: ["preferences-1-to-2"],
      affectedStoreIds: ["user-preferences"],
      recoveryModes: { "preferences-1-to-2": "restore-only" },
      phase: "prepared",
      lastVersion: "2.0.0",
    });

    expect(readDataEpochRestoreJournal(homeDir)).toMatchObject({ status: "corrupt" });
  });

  it("covers every restore journal phase and rejects an unknown one", () => {
    for (const phase of DATA_EPOCH_RESTORE_JOURNAL_PHASES) {
      expect(createDataEpochRestoreJournal({ ...restoreBase, phase })).toMatchObject({ phase });
    }
    expect(() => createDataEpochRestoreJournal({ ...restoreBase, phase: "restore:mystery" as never })).toThrow(/invalid restore journal phase/);
  });

  it("rejects a restore journal missing required fields", () => {
    expect(() => createDataEpochRestoreJournal({ ...restoreBase, restoreId: "" })).toThrow(/non-empty restoreId/);
    expect(() => createDataEpochRestoreJournal({ ...restoreBase, transitionId: "" })).toThrow(/non-empty transitionId/);
    expect(() => createDataEpochRestoreJournal({ ...restoreBase, fromEpoch: 0 })).toThrow(/positive integer fromEpoch/);
  });
});

describe("republishDataEpochStampForRestore (guarded downgrade channel)", () => {
  it("throws and writes nothing when no restore journal is on disk", async () => {
    const homeDir = makeHomeDir();
    await writeDataEpochStamp(homeDir, { minimumReaderEpoch: 2, committedDataEpoch: 2, lastVersion: "2.0.0" });

    await expect(republishDataEpochStampForRestore({ homeDir, fromEpoch: 1, lastVersion: "1.0.0" }))
      .rejects.toThrow(/requires an on-disk restore journal/);
    // Zero writes on precondition failure: the epoch=2 stamp is untouched.
    expect(readDataEpochStamp(homeDir)).toMatchObject({ status: "ok", stamp: { minimumReaderEpoch: 2, committedDataEpoch: 2 } });
  });

  it("throws while the restore journal is still at restore:starting (stores not yet confirmed restored)", async () => {
    const homeDir = makeHomeDir();
    await writeDataEpochStamp(homeDir, { minimumReaderEpoch: 2, committedDataEpoch: 2, lastVersion: "2.0.0" });
    await writeDataEpochRestoreJournal(homeDir, {
      restoreId: "restore-1", transitionId: "t-1", fromEpoch: 1, phase: "restore:starting",
    });

    await expect(republishDataEpochStampForRestore({ homeDir, fromEpoch: 1, lastVersion: "1.0.0" }))
      .rejects.toThrow(/requires an on-disk restore journal/);
  });

  it("throws when the restore journal targets a different fromEpoch than requested", async () => {
    const homeDir = makeHomeDir();
    await writeDataEpochRestoreJournal(homeDir, {
      restoreId: "restore-1", transitionId: "t-1", fromEpoch: 1, phase: "restore:stores_restored",
    });

    await expect(republishDataEpochStampForRestore({ homeDir, fromEpoch: 2, lastVersion: "1.0.0" }))
      .rejects.toThrow(/targets fromEpoch=1/);
  });

  it("republishes all three stamp fields back to fromEpoch once a restore journal proves stores are restored", async () => {
    const homeDir = makeHomeDir();
    await writeDataEpochStamp(homeDir, { minimumReaderEpoch: 2, committedDataEpoch: 2, lastVersion: "2.0.0" });
    await writeDataEpochRestoreJournal(homeDir, {
      restoreId: "restore-1", transitionId: "t-1", fromEpoch: 1, phase: "restore:stores_restored",
    });

    const stamp = await republishDataEpochStampForRestore({ homeDir, fromEpoch: 1, lastVersion: "1.0.0" });

    expect(stamp).toMatchObject({ schemaVersion: 2, epoch: 1, minimumReaderEpoch: 1, committedDataEpoch: 1, lastVersion: "1.0.0" });
    expect(readDataEpochStamp(homeDir)).toMatchObject({ status: "ok", format: "v2", stamp });
  });

  it("also republishes from the later restore:metadata_republished phase (idempotent retry)", async () => {
    const homeDir = makeHomeDir();
    await writeDataEpochRestoreJournal(homeDir, {
      restoreId: "restore-1", transitionId: "t-1", fromEpoch: 1, phase: "restore:metadata_republished",
    });

    const stamp = await republishDataEpochStampForRestore({ homeDir, fromEpoch: 1, lastVersion: "1.0.0" });
    expect(stamp).toMatchObject({ minimumReaderEpoch: 1, committedDataEpoch: 1 });
  });

  it("never affects the ordinary writeDataEpochStamp downgrade-blocking semantics (regression guard)", async () => {
    // writeDataEpochStamp has no downgrade guard of its own — the guard
    // lives in core/data-epoch-coordinator.ts's epoch-downgrade-blocked
    // check, already covered by tests/data-epoch-coordinator.test.ts. This
    // guard only re-confirms writeDataEpochStamp itself is untouched: it
    // still happily writes whatever epoch it is given, restore journal or
    // not, proving republishDataEpochStampForRestore's gate is additive
    // rather than a modification of the shared primitive.
    const homeDir = makeHomeDir();
    const stamp = await writeDataEpochStamp(homeDir, { minimumReaderEpoch: 1, committedDataEpoch: 1, lastVersion: "1.0.0" });
    expect(stamp).toMatchObject({ minimumReaderEpoch: 1, committedDataEpoch: 1 });
  });
});
