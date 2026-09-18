import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  quarantineDestination,
  restoreDataEpochCheckpoint,
  type DataEpochRestoreResult,
} from "../core/data-epoch-restore.ts";
import { createDataEpochCheckpointProvider } from "../core/data-epoch-checkpoint-provider.ts";
import { inspectDataEpochMaintenance } from "../core/data-epoch-coordinator.ts";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import type { StoreDescriptor } from "../shared/persistence/store-registry-types.ts";
import {
  readDataEpochJournal,
  readDataEpochRestoreJournal,
  readDataEpochStamp,
  writeDataEpochJournal,
  writeDataEpochStamp,
} from "../shared/data-epoch.cjs";

const tempDirs: string[] = [];
const fakeServers: http.Server[] = [];
const noopLog = { warn: () => {} };

function makeHomeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-epoch-restore-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (fakeServers.length > 0) {
    const server = fakeServers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// Base descriptor fields (openEntry, schemaSource, phases, etc.) are
// irrelevant to the restore module — it only reads id/format/pathKind/
// pathPatterns. Spreading a real descriptor for the rest mirrors
// tests/data-epoch-checkpoint-provider.test.ts's own testStore helper.
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

function walkAllFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  const result: string[] = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absPath);
      else if (entry.isFile()) result.push(absPath);
    }
  }
  return result;
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

// Mirrors tests/server-home-guards.test.ts's listenFakeSameHomeServer
// precedent (not imported — that helper is not exported, and this module
// must not modify that test file to export it).
function listenFakeSameHomeServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve({ server, port: address.port });
      else reject(new Error("no port"));
    });
  });
}

async function seedLiveSameHomeServerInfo(homeDir: string): Promise<void> {
  const { server, port } = await listenFakeSameHomeServer((req, res) => {
    if (req.url === "/api/server/identity") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ serverId: "server_fake_same_home" }));
      return;
    }
    res.writeHead(404).end();
  });
  fakeServers.push(server);
  fs.writeFileSync(
    path.join(homeDir, "server-info.json"),
    JSON.stringify({ pid: process.pid, port, token: "fake-token", version: "0.1.0", ownerKind: "standalone" }),
    "utf-8",
  );
}

describe("quarantineDestination: never overwrite, keep both copies attributable", () => {
  it("returns the plain destination when nothing is there yet", async () => {
    const homeDir = makeHomeDir();
    const quarantineStoreDir = path.join(homeDir, "data-epoch-restore-quarantine", "restore-1", "json-store");
    const destination = await quarantineDestination(quarantineStoreDir, "user/preferences.json");
    expect(destination).toBe(path.join(quarantineStoreDir, "user", "preferences.json"));
  });

  it("disambiguates with a .dup-N suffix instead of clobbering an existing quarantined file, and keeps disambiguating on repeated collisions", async () => {
    const homeDir = makeHomeDir();
    const quarantineStoreDir = path.join(homeDir, "data-epoch-restore-quarantine", "restore-1", "json-store");
    const original = path.join(quarantineStoreDir, "user", "preferences.json");
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.writeFileSync(original, "first-quarantined-copy");

    const second = await quarantineDestination(quarantineStoreDir, "user/preferences.json");
    expect(second).toBe(path.join(quarantineStoreDir, "user", "preferences.dup-2.json"));
    fs.writeFileSync(second, "second-quarantined-copy");

    const third = await quarantineDestination(quarantineStoreDir, "user/preferences.json");
    expect(third).toBe(path.join(quarantineStoreDir, "user", "preferences.dup-3.json"));

    // Both earlier copies are untouched -- neither call overwrote anything.
    expect(fs.readFileSync(original, "utf8")).toBe("first-quarantined-copy");
    expect(fs.readFileSync(second, "utf8")).toBe("second-quarantined-copy");
  });

  it("exercises the collision path end-to-end through a real restore: a file re-swept on retry lands beside, not over, its first quarantined copy", async () => {
    const transitionId = "t-quarantine-collision";
    const homeDir = makeHomeDir();
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    seedJsonStore(homeDir, "user/preferences.json", { locale: "zh" });
    await buildCheckpoint({ homeDir, store, transitionId, fromEpoch: 1, toEpoch: 2 });
    seedJsonStore(homeDir, "user/preferences.json", { locale: "zh", marker: "stable" });

    // Interrupt right after the first sweep (all pre-restore bytes already
    // moved into quarantine, copy-back not yet run).
    await expect(restoreDataEpochCheckpoint({
      homeDir, transitionId, confirmToken: `restore ${transitionId}`, log: noopLog, stores: [store],
      faultHook: (event) => {
        if (event === "restore:store-quarantined:json-store") throw new Error("injected crash: after first sweep");
      },
    })).rejects.toThrow(/injected crash: after first sweep/);

    const restoreReadAfterFault = readDataEpochRestoreJournal(homeDir);
    if (restoreReadAfterFault.status !== "ok") throw new Error("expected an on-disk restore journal after the injected crash");
    const restoreId = restoreReadAfterFault.journal.restoreId;
    const quarantineStoreDir = path.join(homeDir, "data-epoch-restore-quarantine", restoreId, "json-store");
    expect(walkAllFiles(quarantineStoreDir)).toHaveLength(1);

    // Simulate a second, independent source of pre-restore bytes reappearing
    // at the exact same relPath before the retry runs (e.g. a partially
    // completed copy-back in a real crash) -- this forces the retry's
    // re-sweep to collide with the file the first sweep already quarantined.
    seedJsonStore(homeDir, "user/preferences.json", { locale: "zh", marker: "canary" });

    const result = await restoreDataEpochCheckpoint({
      homeDir, transitionId, confirmToken: `restore ${transitionId}`, log: noopLog, stores: [store],
    });

    expect(result.restoreId).toBe(restoreId);
    // Final restored content is still exactly the checkpointed bytes.
    expect(JSON.parse(fs.readFileSync(path.join(homeDir, "user", "preferences.json"), "utf8"))).toEqual({ locale: "zh" });
    // Both pre-restore copies survive in quarantine, neither clobbered.
    const quarantinedContents = walkAllFiles(quarantineStoreDir).map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
    expect(quarantinedContents).toContainEqual({ locale: "zh", marker: "stable" });
    expect(quarantinedContents).toContainEqual({ locale: "zh", marker: "canary" });
    expect(quarantinedContents).toHaveLength(2);
  });
});

describe("restoreDataEpochCheckpoint: confirmToken precondition", () => {
  it("rejects a confirmToken that differs by even one character", async () => {
    const homeDir = makeHomeDir();
    await expect(restoreDataEpochCheckpoint({
      homeDir, transitionId: "t-1", confirmToken: "restore t-1x", log: noopLog,
    })).rejects.toThrow(/exact confirmation phrase/);
  });

  it("rejects an empty confirmToken", async () => {
    const homeDir = makeHomeDir();
    await expect(restoreDataEpochCheckpoint({
      homeDir, transitionId: "t-1", confirmToken: "", log: noopLog,
    })).rejects.toThrow(/exact confirmation phrase/);
  });
});

describe("restoreDataEpochCheckpoint: same-home live-server precondition", () => {
  it("rejects when server-info.json points at a live, token-authenticating same-home server", async () => {
    const homeDir = makeHomeDir();
    await seedLiveSameHomeServerInfo(homeDir);

    await expect(restoreDataEpochCheckpoint({
      homeDir, transitionId: "t-1", confirmToken: "restore t-1", log: noopLog,
    })).rejects.toThrow(/kernel is live for this home/);
  });

  it("proceeds past a dead server-info.json (nothing listening on the recorded port)", async () => {
    const homeDir = makeHomeDir();
    // Bind and release a port synchronously to get one that's very likely
    // free, then record it as "the last known server" with nothing home.
    const { server: probe, port: deadPort } = await listenFakeSameHomeServer((_req, res) => res.end());
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    fs.writeFileSync(path.join(homeDir, "server-info.json"), JSON.stringify({ port: deadPort, token: "stale-token" }));

    // No checkpoint exists yet for "t-1", so this must fail at the *next*
    // precondition (checkpoint verification) rather than the live-server
    // one — proving the live-server check did not block.
    await expect(restoreDataEpochCheckpoint({
      homeDir, transitionId: "t-1", confirmToken: "restore t-1", log: noopLog,
    })).rejects.toThrow(/checkpoint verification failed/);
  });
});

describe("restoreDataEpochCheckpoint: checkpoint verification precondition", () => {
  it("rejects when the checkpoint's captured bytes have been tampered with", async () => {
    const homeDir = makeHomeDir();
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    seedJsonStore(homeDir, "user/preferences.json", { locale: "zh" });
    const receipt = await buildCheckpoint({ homeDir, store, transitionId: "t-tamper" });

    const capturedPath = path.join(receipt.dir, "stores", "json-store", "user", "preferences.json");
    const bytes = fs.readFileSync(capturedPath);
    bytes[0] = bytes[0] ^ 0xff;
    fs.writeFileSync(capturedPath, bytes);

    await expect(restoreDataEpochCheckpoint({
      homeDir, transitionId: "t-tamper", confirmToken: "restore t-tamper", log: noopLog, stores: [store],
    })).rejects.toThrow(/checkpoint verification failed/);
  });

  it("rejects when no checkpoint directory exists at all for the transitionId", async () => {
    const homeDir = makeHomeDir();
    await expect(restoreDataEpochCheckpoint({
      homeDir, transitionId: "t-missing", confirmToken: "restore t-missing", log: noopLog,
    })).rejects.toThrow(/checkpoint verification failed/);
  });
});

describe("restoreDataEpochCheckpoint: journal-consistency precondition", () => {
  it("rejects when an in-progress forward journal exists for a different transitionId", async () => {
    const homeDir = makeHomeDir();
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    seedJsonStore(homeDir, "user/preferences.json", { locale: "zh" });
    await buildCheckpoint({ homeDir, store, transitionId: "t-target" });

    await writeDataEpochJournal(homeDir, {
      transitionId: "t-other-inflight",
      fromEpoch: 1,
      toEpoch: 2,
      migrationIds: ["m-1"],
      affectedStoreIds: ["json-store"],
      recoveryModes: { "m-1": "restore-only" },
      phase: "checkpoint_complete",
      checkpointId: "some-id",
      checkpointReceipt: { id: "some-id" },
      lastVersion: "2.0.0",
    });

    await expect(restoreDataEpochCheckpoint({
      homeDir, transitionId: "t-target", confirmToken: "restore t-target", log: noopLog, stores: [store],
    })).rejects.toThrow(/different transitionId/);
  });

  it("proceeds when the on-disk forward journal's transitionId matches the requested restore (its legitimate exit ramp)", async () => {
    const homeDir = makeHomeDir();
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    seedJsonStore(homeDir, "user/preferences.json", { locale: "zh" });
    const receipt = await buildCheckpoint({ homeDir, store, transitionId: "t-legit" });

    await writeDataEpochJournal(homeDir, {
      transitionId: "t-legit",
      fromEpoch: 1,
      toEpoch: 2,
      migrationIds: ["m-1"],
      affectedStoreIds: ["json-store"],
      recoveryModes: { "m-1": "restore-only" },
      phase: "checkpoint_complete",
      checkpointId: receipt.id,
      checkpointReceipt: receipt,
      lastVersion: "2.0.0",
    });
    seedJsonStore(homeDir, "user/preferences.json", { locale: "zh", marker: "changed" });

    const result = await restoreDataEpochCheckpoint({
      homeDir, transitionId: "t-legit", confirmToken: "restore t-legit", log: noopLog, stores: [store],
    });

    expect(result.fromEpoch).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(homeDir, "user", "preferences.json"), "utf8"))).toEqual({ locale: "zh" });
    expect(readDataEpochJournal(homeDir)).toMatchObject({ status: "missing" });
  });
});

describe("restoreDataEpochCheckpoint: full round-trip restore", () => {
  it("restores a tree-kind store to the checkpointed state, quarantines tampered and post-checkpoint bytes, republishes the stamp, and writes both receipts", async () => {
    const homeDir = makeHomeDir();
    const store = testStore({ id: "tree-store", format: "mixed-directory", pathKind: "tree", pathPatterns: ["blobs/{bucketId}"] });

    fs.mkdirSync(path.join(homeDir, "blobs", "bucket-1", "nested"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, "blobs", "bucket-1", "a.bin"), "aaa");
    fs.writeFileSync(path.join(homeDir, "blobs", "bucket-1", "nested", "b.bin"), "bbbb");

    await writeDataEpochStamp(homeDir, { minimumReaderEpoch: 2, committedDataEpoch: 2, lastVersion: "2.0.0" });
    const receipt = await buildCheckpoint({ homeDir, store, transitionId: "t-full", fromEpoch: 1, toEpoch: 2 });
    expect(receipt.itemCount).toBe(2);

    // Simulate "upgraded and wrote more": tamper an existing captured file
    // and add a brand-new post-checkpoint file under the same tree.
    fs.writeFileSync(path.join(homeDir, "blobs", "bucket-1", "a.bin"), "AAA-changed-after-checkpoint");
    fs.writeFileSync(path.join(homeDir, "blobs", "bucket-1", "c.bin"), "post-checkpoint-new-file");

    const result: DataEpochRestoreResult = await restoreDataEpochCheckpoint({
      homeDir, transitionId: "t-full", confirmToken: "restore t-full", log: noopLog, stores: [store],
    });

    expect(result).toMatchObject({ transitionId: "t-full", fromEpoch: 1, toEpoch: 2, affectedStoreIds: ["tree-store"] });
    expect(typeof result.restoreId).toBe("string");
    expect(result.restoreId.length).toBeGreaterThan(0);

    // Old-kernel-visible file set equals the captured manifest exactly.
    expect(fs.readFileSync(path.join(homeDir, "blobs", "bucket-1", "a.bin"), "utf8")).toBe("aaa");
    expect(fs.readFileSync(path.join(homeDir, "blobs", "bucket-1", "nested", "b.bin"), "utf8")).toBe("bbbb");
    expect(fs.existsSync(path.join(homeDir, "blobs", "bucket-1", "c.bin"))).toBe(false);

    // Post-checkpoint bytes (tampered a.bin content + the brand-new c.bin,
    // plus the untouched b.bin swept as part of the whole-store sweep) are
    // preserved, not deleted, under quarantine.
    const quarantineStoreDir = path.join(homeDir, "data-epoch-restore-quarantine", result.restoreId, "tree-store");
    const quarantinedContents = walkAllFiles(quarantineStoreDir).map((file) => fs.readFileSync(file, "utf8"));
    expect(quarantinedContents).toContain("AAA-changed-after-checkpoint");
    expect(quarantinedContents).toContain("post-checkpoint-new-file");
    expect(quarantinedContents).toContain("bbbb");

    // Stamp republished to fromEpoch on all three fields.
    expect(readDataEpochStamp(homeDir)).toMatchObject({
      status: "ok",
      format: "v2",
      stamp: { epoch: 1, minimumReaderEpoch: 1, committedDataEpoch: 1 },
    });

    // Both audit receipts exist and agree.
    expect(fs.existsSync(result.receiptPath)).toBe(true);
    const receiptContent = JSON.parse(fs.readFileSync(result.receiptPath, "utf8"));
    expect(receiptContent).toMatchObject({ restoreId: result.restoreId, transitionId: "t-full", fromEpoch: 1, toEpoch: 2 });
    const logPath = path.join(homeDir, "data-epoch-restores.log");
    expect(fs.existsSync(logPath)).toBe(true);
    const logLines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(logLines).toHaveLength(1);
    expect(JSON.parse(logLines[0])).toMatchObject({ restoreId: result.restoreId, transitionId: "t-full" });

    // Journal fully cleared — both readers see nothing left behind.
    expect(readDataEpochJournal(homeDir)).toMatchObject({ status: "missing" });
    expect(readDataEpochRestoreJournal(homeDir)).toMatchObject({ status: "missing" });
  });
});

describe("restoreDataEpochCheckpoint: restore fault matrix (crash-then-resume idempotency)", () => {
  async function setupFaultScenario(transitionId: string) {
    const homeDir = makeHomeDir();
    const store = testStore({ id: "json-store", format: "json", pathKind: "file", pathPatterns: ["user/preferences.json"] });
    seedJsonStore(homeDir, "user/preferences.json", { locale: "zh" });
    await writeDataEpochStamp(homeDir, { minimumReaderEpoch: 2, committedDataEpoch: 2, lastVersion: "2.0.0" });
    await buildCheckpoint({ homeDir, store, transitionId, fromEpoch: 1, toEpoch: 2 });
    // Simulate "upgraded and wrote more" after the checkpoint.
    seedJsonStore(homeDir, "user/preferences.json", { locale: "zh", marker: "changed" });
    return { homeDir, store };
  }

  it("cell 1 — quarantine interrupted (crash after sweep, before copy-back): diagnosable at restore:starting, plain startup fails closed, rerun finishes idempotently", async () => {
    const transitionId = "t-fault-quarantine";
    const { homeDir, store } = await setupFaultScenario(transitionId);

    await expect(restoreDataEpochCheckpoint({
      homeDir, transitionId, confirmToken: `restore ${transitionId}`, log: noopLog, stores: [store],
      faultHook: (event) => {
        if (event === "restore:store-quarantined:json-store") throw new Error("injected crash: after quarantine, before copy-back");
      },
    })).rejects.toThrow(/injected crash: after quarantine/);

    const midJournal = readDataEpochRestoreJournal(homeDir);
    expect(midJournal).toMatchObject({ status: "ok", journal: { transitionId, phase: "restore:starting" } });
    const interruptedRestoreId = midJournal.status === "ok" ? midJournal.journal.restoreId : null;

    // Plain startup (any kernel, old or new) fails closed on the mid-flight
    // restore journal — same as any other corrupt/unrecognized journal.
    expect(inspectDataEpochMaintenance(homeDir)).toMatchObject({ status: "corrupt", reason: "corrupt-journal" });
    // The quarantine sweep itself is durable: the tampered file has already
    // been moved out of its original location (copy-back has not run yet).
    expect(fs.existsSync(path.join(homeDir, "user", "preferences.json"))).toBe(false);
    const quarantinedBeforeResume = walkAllFiles(path.join(homeDir, "data-epoch-restore-quarantine", interruptedRestoreId!, "json-store"))
      .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
    expect(quarantinedBeforeResume).toContainEqual({ locale: "zh", marker: "changed" });

    const result = await restoreDataEpochCheckpoint({
      homeDir, transitionId, confirmToken: `restore ${transitionId}`, log: noopLog, stores: [store],
    });

    expect(result.restoreId).toBe(interruptedRestoreId); // resumed, not a fresh restore
    expect(JSON.parse(fs.readFileSync(path.join(homeDir, "user", "preferences.json"), "utf8"))).toEqual({ locale: "zh" });
    expect(readDataEpochStamp(homeDir)).toMatchObject({ stamp: { minimumReaderEpoch: 1, committedDataEpoch: 1 } });
    expect(readDataEpochJournal(homeDir)).toMatchObject({ status: "missing" });
    expect(readDataEpochRestoreJournal(homeDir)).toMatchObject({ status: "missing" });
  });

  it("cell 2 — copy-back interrupted (crash after copy-back, before reconciliation/next phase): diagnosable at restore:starting, plain startup fails closed, rerun finishes idempotently", async () => {
    const transitionId = "t-fault-copyback";
    const { homeDir, store } = await setupFaultScenario(transitionId);

    await expect(restoreDataEpochCheckpoint({
      homeDir, transitionId, confirmToken: `restore ${transitionId}`, log: noopLog, stores: [store],
      faultHook: (event) => {
        if (event === "restore:store-copied-back:json-store") throw new Error("injected crash: after copy-back, before reconciliation");
      },
    })).rejects.toThrow(/injected crash: after copy-back/);

    const midJournal = readDataEpochRestoreJournal(homeDir);
    expect(midJournal).toMatchObject({ status: "ok", journal: { transitionId, phase: "restore:starting" } });
    const interruptedRestoreId = midJournal.status === "ok" ? midJournal.journal.restoreId : null;
    // Copy-back already landed the checkpointed bytes even though the
    // journal has not advanced past restore:starting yet.
    expect(JSON.parse(fs.readFileSync(path.join(homeDir, "user", "preferences.json"), "utf8"))).toEqual({ locale: "zh" });

    expect(inspectDataEpochMaintenance(homeDir)).toMatchObject({ status: "corrupt", reason: "corrupt-journal" });

    const result = await restoreDataEpochCheckpoint({
      homeDir, transitionId, confirmToken: `restore ${transitionId}`, log: noopLog, stores: [store],
    });

    expect(result.restoreId).toBe(interruptedRestoreId);
    expect(JSON.parse(fs.readFileSync(path.join(homeDir, "user", "preferences.json"), "utf8"))).toEqual({ locale: "zh" });
    expect(readDataEpochStamp(homeDir)).toMatchObject({ stamp: { minimumReaderEpoch: 1, committedDataEpoch: 1 } });
    expect(readDataEpochJournal(homeDir)).toMatchObject({ status: "missing" });
    expect(readDataEpochRestoreJournal(homeDir)).toMatchObject({ status: "missing" });
  });

  it("cell 3 — republish interrupted (crash after stores restored, before stamp republish): diagnosable at restore:stores_restored, stamp untouched, plain startup fails closed, rerun finishes idempotently", async () => {
    const transitionId = "t-fault-republish";
    const { homeDir, store } = await setupFaultScenario(transitionId);

    await expect(restoreDataEpochCheckpoint({
      homeDir, transitionId, confirmToken: `restore ${transitionId}`, log: noopLog, stores: [store],
      faultHook: (event) => {
        if (event === "restore:stores-restored") throw new Error("injected crash: stores restored, before republish");
      },
    })).rejects.toThrow(/injected crash: stores restored/);

    const midJournal = readDataEpochRestoreJournal(homeDir);
    expect(midJournal).toMatchObject({ status: "ok", journal: { transitionId, phase: "restore:stores_restored" } });
    const interruptedRestoreId = midJournal.status === "ok" ? midJournal.journal.restoreId : null;
    // Republish has not happened yet — the pre-restore epoch=2 stamp stands.
    expect(readDataEpochStamp(homeDir)).toMatchObject({ stamp: { minimumReaderEpoch: 2, committedDataEpoch: 2 } });

    expect(inspectDataEpochMaintenance(homeDir)).toMatchObject({ status: "corrupt", reason: "corrupt-journal" });

    const result = await restoreDataEpochCheckpoint({
      homeDir, transitionId, confirmToken: `restore ${transitionId}`, log: noopLog, stores: [store],
    });

    expect(result.restoreId).toBe(interruptedRestoreId);
    expect(readDataEpochStamp(homeDir)).toMatchObject({ stamp: { minimumReaderEpoch: 1, committedDataEpoch: 1 } });
    expect(readDataEpochJournal(homeDir)).toMatchObject({ status: "missing" });
    expect(readDataEpochRestoreJournal(homeDir)).toMatchObject({ status: "missing" });
  });

  it("cell 4 — journal-cleanup interrupted (crash after republish, before receipt + journal clear): diagnosable at restore:metadata_republished, stamp already lowered, plain startup fails closed, rerun finishes idempotently", async () => {
    const transitionId = "t-fault-journal-clear";
    const { homeDir, store } = await setupFaultScenario(transitionId);

    await expect(restoreDataEpochCheckpoint({
      homeDir, transitionId, confirmToken: `restore ${transitionId}`, log: noopLog, stores: [store],
      faultHook: (event) => {
        if (event === "restore:metadata-republished") throw new Error("injected crash: republished, before receipt + journal clear");
      },
    })).rejects.toThrow(/injected crash: republished/);

    const midJournal = readDataEpochRestoreJournal(homeDir);
    expect(midJournal).toMatchObject({ status: "ok", journal: { transitionId, phase: "restore:metadata_republished" } });
    const interruptedRestoreId = midJournal.status === "ok" ? midJournal.journal.restoreId : null;
    // The stamp is already durably republished even though the journal has
    // not been cleared yet — republish and journal-clear are separate steps.
    expect(readDataEpochStamp(homeDir)).toMatchObject({ stamp: { minimumReaderEpoch: 1, committedDataEpoch: 1 } });
    // No receipt yet.
    expect(walkAllFiles(path.join(homeDir, "data-epoch-restore-quarantine", interruptedRestoreId!))
      .some((file) => file.endsWith("restore-receipt.json"))).toBe(false);

    expect(inspectDataEpochMaintenance(homeDir)).toMatchObject({ status: "corrupt", reason: "corrupt-journal" });

    const result = await restoreDataEpochCheckpoint({
      homeDir, transitionId, confirmToken: `restore ${transitionId}`, log: noopLog, stores: [store],
    });

    expect(result.restoreId).toBe(interruptedRestoreId);
    expect(fs.existsSync(result.receiptPath)).toBe(true);
    const logLines = fs.readFileSync(path.join(homeDir, "data-epoch-restores.log"), "utf8").trim().split("\n");
    expect(logLines).toHaveLength(1); // no duplicate log line from the interrupted attempt
    expect(readDataEpochJournal(homeDir)).toMatchObject({ status: "missing" });
    expect(readDataEpochRestoreJournal(homeDir)).toMatchObject({ status: "missing" });
  });
});

describe("server/index.ts data-epoch startup wiring (checkpoint provider injection)", () => {
  const serverIndexSource = fs.readFileSync(path.join(process.cwd(), "server", "index.ts"), "utf-8");

  it("imports the production checkpoint provider factory", () => {
    expect(serverIndexSource).toContain(
      'import { createDataEpochCheckpointProvider } from "../core/data-epoch-checkpoint-provider.ts";',
    );
  });

  it("injects checkpointProvider into the coordinateDataEpochStartup call", () => {
    const callStart = serverIndexSource.indexOf("const epochResult = await coordinateDataEpochStartup({");
    expect(callStart).toBeGreaterThan(-1);
    const callEnd = serverIndexSource.indexOf("\n}", callStart);
    expect(callEnd).toBeGreaterThan(callStart);
    const callBlock = serverIndexSource.slice(callStart, callEnd);
    expect(callBlock).toContain("checkpointProvider: createDataEpochCheckpointProvider(");
  });
});
