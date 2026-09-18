import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildStartupReceipt, scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import {
  FUTURE_EPOCH_COORDINATOR_PHASE,
  STARTUP_PHASES,
  startupPhaseIndex,
} from "../shared/persistence/startup-phases.ts";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STARTUP_RECEIPT_PATH = path.join(ROOT, "build", "persistence-startup-receipt.json");

describe("persistence startup receipt", () => {
  it("uses the canonical phase order and records every registered store", () => {
    expect(STARTUP_PHASES).toEqual([
      "desktop_bootstrap",
      "home_guard",
      "epoch_read_preflight",
      "epoch_transition",
      "post_epoch_pre_bind",
      "transport_bind",
      "first_run_seed",
      "identity_seed",
      "engine_construct",
      "engine_init_legacy_migrations",
      "runtime_ready",
    ]);
    expect(FUTURE_EPOCH_COORDINATOR_PHASE).toBe("epoch_transition");

    const receipt = buildStartupReceipt(PERSISTENT_STORES);
    expect(receipt.stores).toHaveLength(PERSISTENT_STORES.length);
    expect(receipt.stores.map((store) => store.id).sort()).toEqual(PERSISTENT_STORES.map((store) => store.id).sort());
  });

  it("derives pre-coordinator risk and required access moves from the declared phases", () => {
    const receipt = buildStartupReceipt(PERSISTENT_STORES);
    const coordinatorIndex = startupPhaseIndex(FUTURE_EPOCH_COORDINATOR_PHASE);

    for (const entry of receipt.stores) {
      const descriptor = PERSISTENT_STORES.find((store) => store.id === entry.id)!;
      expect(entry.opensBeforeFutureCoordinator)
        .toBe(startupPhaseIndex(descriptor.firstPossibleOpenPhase) < coordinatorIndex);
      expect(entry.writesBeforeFutureCoordinator)
        .toBe(startupPhaseIndex(descriptor.firstPossibleWritePhase) < coordinatorIndex);
      expect(entry.breakingMigrationRequiresAccessMove).toBe(
        descriptor.affectedByEpochMigration
          && (startupPhaseIndex(descriptor.firstPossibleOpenPhase) <= coordinatorIndex
            || startupPhaseIndex(descriptor.firstPossibleWritePhase) <= coordinatorIndex),
      );
    }

    const epochStamp = receipt.stores.find((store) => store.id === "data-epoch-stamp")!;
    expect(epochStamp.firstPossibleOpenPhase).toBe("epoch_read_preflight");
    expect(epochStamp.firstPossibleWritePhase).toBe("epoch_transition");
    expect(epochStamp.breakingMigrationRequiresAccessMove).toBe(false);
    const epochJournal = receipt.stores.find((store) => store.id === "data-epoch-transition-journal")!;
    expect(epochJournal.firstPossibleOpenPhase).toBe("epoch_read_preflight");
    expect(epochJournal.firstPossibleWritePhase).toBe("epoch_transition");

    const preferences = receipt.stores.find((store) => store.id === "user-preferences")!;
    expect(preferences.firstPossibleOpenPhase).toBe("desktop_bootstrap");
    expect(preferences.preCoordinatorReadProjection).toMatchObject({
      compatibility: "additive-only",
      fields: expect.arrayContaining(["hardware_acceleration", "network_proxy", "keep_awake"]),
    });

    const network = receipt.stores.find((store) => store.id === "server-network-config")!;
    expect(network.firstPossibleOpenPhase).toBe("post_epoch_pre_bind");
    expect(network.firstPossibleWritePhase).toBe("post_epoch_pre_bind");

    for (const id of ["server-node-identity", "user-studio-registries"]) {
      const identity = receipt.stores.find((store) => store.id === id)!;
      expect(identity.firstPossibleOpenPhase).toBe("identity_seed");
      expect(identity.firstPossibleWritePhase).toBe("identity_seed");
    }
  });

  it("matches the committed deterministic startup receipt", () => {
    const generated = scanPersistentStores({ rootDir: ROOT, today: "2026-07-13" }).startupReceipt;
    const committed = JSON.parse(fs.readFileSync(STARTUP_RECEIPT_PATH, "utf-8"));

    expect(committed).toEqual(generated);
    expect(JSON.stringify(committed)).not.toMatch(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)/);
  });
});
