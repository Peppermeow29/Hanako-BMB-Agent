import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SOURCE_DIGEST_METHOD,
  assertCommittedPersistenceSchemaFingerprint,
  executableSourceHash,
  generatePersistenceSchemaFingerprint,
  persistenceSchemaCacheStats,
  resetPersistenceSchemaCaches,
  validateSchemaChangeDeclaration,
  writePersistenceSchemaFingerprint,
} from "../scripts/generate-persistence-schema-fingerprint.mjs";
import {
  PRODUCTION_ROOTS,
  scanPersistentStores,
} from "../scripts/scan-persistent-stores.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FINGERPRINT_PATH = path.join(ROOT, "build", "persistence-schema-fingerprint.json");
const INVENTORY_PATH = path.join(ROOT, "build", "persistence-store-inventory.json");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temporaryRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-schema-tripwire-"));
  tempDirs.push(root);
  for (const productionRoot of PRODUCTION_ROOTS) {
    fs.mkdirSync(path.join(root, productionRoot), { recursive: true });
  }
  return root;
}

// The expensive step here is the cold one: parsing every guarded source in the
// inventory, then building three real SQLite databases to read their schemas
// back. That is under a second on a developer machine and nearly an order of
// magnitude slower on the Windows CI runner, where it once consumed the whole
// default ten-second budget and failed the run. Memoization has taken the
// repeated cost out; this headroom covers the cold start itself and the stores
// still to come. A regression should be caught by the two "once per run"
// contracts above, which name the work directly — not by a timeout, which only
// ever reports that something, somewhere, took too long.
vi.setConfig({ testTimeout: 30_000 });

describe("persistence schema tripwire", () => {
  it("uses real SQLite stores and matches the deterministic committed fingerprint", async () => {
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    const first = await generatePersistenceSchemaFingerprint({
      rootDir: ROOT,
      inventory,
      review: committed.review,
    });
    const second = await generatePersistenceSchemaFingerprint({
      rootDir: ROOT,
      inventory,
      review: committed.review,
    });

    expect(second).toEqual(first);
    expect(committed).toEqual(first);
    expect(first.dataEpoch).toBe(1);
    expect(first.registry.length).toBeGreaterThan(20);
    expect(first.siteMappings.length).toBeGreaterThan(500);
    expect(first.exemptions.length).toBeGreaterThan(0);
    expect(first.inventoryReceipt.sourceRoots).toEqual(expect.arrayContaining(["desktop", "cli"]));
    expect(first.inventoryReceipt.sourceExclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "desktop-generated-bundles" }),
      expect.objectContaining({ id: "desktop-renderer-react" }),
      expect.objectContaining({ id: "source-tests" }),
    ]));

    const manifest = first.schemas.find((entry) => entry.storeId === "session-manifest-sqlite");
    expect(manifest).toMatchObject({
      kind: "sqlite-runtime",
      module: "core/session-manifest/store.ts",
      runtimeSchema: { userVersion: 5 },
    });
    expect(manifest.runtimeSchema.objects.some((entry) => entry.name === "session_manifests")).toBe(true);
    expect(manifest.runtimeSchema.objects.every((entry) => !entry.name.startsWith("sqlite_"))).toBe(true);

    const facts = first.schemas.find((entry) => entry.storeId === "agent-facts-sqlite");
    expect(facts).toMatchObject({
      kind: "sqlite-runtime",
      module: "lib/memory/fact-store.ts",
      runtimeSchema: { userVersion: 2 },
    });
    expect(facts.runtimeSchema.objects.some((entry) => entry.name === "facts_fts")).toBe(true);
    expect(facts.runtimeSchema.objects.every((entry) => !entry.name.startsWith("facts_fts_"))).toBe(true);

    const sessions = first.schemas.find((entry) => entry.storeId === "session-jsonl");
    expect(sessions).toMatchObject({
      kind: "external-versioned",
      packageName: "@earendil-works/pi-coding-agent",
      packageVersion: "0.80.3",
      requestedVersion: "0.80.3",
      versionSource: {
        currentSessionVersion: 3,
        declaration: "export const CURRENT_SESSION_VERSION = 3;",
      },
    });
    expect(sessions.packageIntegrity).toMatch(/^sha512-/);
    expect(sessions.extensions.map((entry) => entry.module)).toEqual([
      "core/session-coordinator.ts",
      "core/session-jsonl-file.ts",
    ]);
    expect(sessions.extensions.every((entry) => entry.sourceHash.startsWith("sha256:"))).toBe(true);

    const epochJournal = first.schemas.find((entry) => entry.storeId === "data-epoch-transition-journal");
    expect(epochJournal.protocolModules).toEqual([
      expect.objectContaining({ module: "core/data-epoch-coordinator.ts", sourceHash: expect.stringMatching(/^sha256:/) }),
      expect.objectContaining({ module: "core/data-epoch-migrations.ts", sourceHash: expect.stringMatching(/^sha256:/) }),
    ]);

    const serialized = JSON.stringify(first);
    expect(serialized).not.toMatch(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)/);
    expect(first.siteMappings.every((site) => !site.sourceFile.includes("\\"))).toBe(true);
  });

  it("fails with both review paths when a runtime contract source drifts", async () => {
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    const module = "shared/data-epoch.cjs";
    const mutatedSource = `${fs.readFileSync(path.join(ROOT, module), "utf-8")}\nexport const schemaDriftProbe = 1;\n`;

    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: committed,
      inventory,
      sourceOverrides: new Map([[module, mutatedSource]]),
    })).rejects.toThrow(/persistence schema fingerprint mismatch[\s\S]*compatible addition[\s\S]*breaking change/);

    const coordinatorModule = "core/data-epoch-coordinator.ts";
    const mutatedCoordinator = `${fs.readFileSync(path.join(ROOT, coordinatorModule), "utf-8")}\nexport const protocolDriftProbe = 1;\n`;
    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: committed,
      inventory,
      sourceOverrides: new Map([[coordinatorModule, mutatedCoordinator]]),
    })).rejects.toThrow(/persistence schema fingerprint mismatch/);
  });

  it("ignores comment-only drift in the sources it hashes", async () => {
    // The tripwire exists to catch changes to what lands on disk, and a comment
    // cannot change a persisted byte. Hashing whole files meant it fired on
    // every comment edit anyway, which is most of what it ever fired on — so
    // the reviews it demanded became a copied sentence, and a guard answered by
    // reflex stops being a guard. Hash the parse tree instead: comments and
    // whitespace between tokens drop out, everything executable stays.
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));

    for (const module of ["shared/data-epoch.cjs", "core/data-epoch-coordinator.ts", "server/index.ts"]) {
      const original = fs.readFileSync(path.join(ROOT, module), "utf-8");
      const commented = `// leading comment mutation\n${original}\n/* trailing block mutation */\n`;
      await expect(assertCommittedPersistenceSchemaFingerprint({
        rootDir: ROOT,
        committedFingerprint: committed,
        inventory,
        sourceOverrides: new Map([[module, commented]]),
      })).resolves.not.toThrow();
    }
  });

  it("ignores JSDoc drift, including the file headers this guard once taxed", async () => {
    // `/** … */` blocks are parsed as JSDoc nodes, which getChildren() serves
    // alongside real syntax. A digest that walks children naively therefore
    // hashes doc comments — and file headers in this repository are JSDoc, so
    // the edits this guard was loudest about would still demand review. A
    // JSDoc node is still a comment: it must stay out of the digest.
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));

    const markers: Array<[string, string]> = [
      ["server/index.ts", "HanaAgent Server — HTTP + WebSocket API"],
      ["shared/data-epoch.cjs", "Reads both the legacy v1 high-water stamp"],
    ];
    for (const [module, marker] of markers) {
      const original = fs.readFileSync(path.join(ROOT, module), "utf-8");
      expect(original).toContain(marker);
      const mutated = `/** inserted JSDoc header probe */\n${original.replace(marker, `${marker} (doc drift probe)`)}`;
      await expect(assertCommittedPersistenceSchemaFingerprint({
        rootDir: ROOT,
        committedFingerprint: committed,
        inventory,
        sourceOverrides: new Map([[module, mutated]]),
      })).resolves.not.toThrow();
    }
  });

  it("opens each SQLite store once per repository root, however many payloads one run computes", async () => {
    // Every payload this generator computes introspects the real SQLite stores
    // by creating a throwaway database and reading its schema back. That result
    // depends only on the repository root — `sourceOverrides` cannot reach it,
    // and the store classes themselves come from an ESM import the runtime has
    // already cached — so recomputing it per payload buys nothing and costs a
    // temp directory, a database build and a teardown each time.
    //
    // The cost lands unevenly: on this machine the repetition is invisible, on
    // the Windows CI runner filesystem work is nearly an order of magnitude
    // slower and the tests above spend most of their budget here. They timed
    // out on CI once a third SQLite store was registered. Pin the contract that
    // makes those tests affordable rather than the symptom of the timeout.
    resetPersistenceSchemaCaches();
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    const sqliteStores = inventory.stores.filter(
      (store: { schemaSource: { kind: string } }) => store.schemaSource.kind === "sqlite-runtime",
    );
    expect(sqliteStores.length).toBeGreaterThan(0);

    const mkdtempSync = vi.spyOn(fs, "mkdtempSync");
    try {
      for (const module of ["shared/data-epoch.cjs", "core/data-epoch-coordinator.ts", "server/index.ts"]) {
        const original = fs.readFileSync(path.join(ROOT, module), "utf-8");
        await assertCommittedPersistenceSchemaFingerprint({
          rootDir: ROOT,
          committedFingerprint: committed,
          inventory,
          sourceOverrides: new Map([[module, `// introspection budget probe\n${original}`]]),
        });
      }
      const introspections = mkdtempSync.mock.calls
        .map(([prefix]) => String(prefix))
        .filter((prefix) => /hana-(?:session-manifest|facts|file-history)-schema-/.test(prefix));
      expect(introspections).toHaveLength(sqliteStores.length);
    } finally {
      mkdtempSync.mockRestore();
    }
  });

  it("parses each distinct source once, however many payloads reuse it", async () => {
    // Hashing a guarded module means parsing it, and parsing is where this
    // tripwire actually spends its time: roughly seven tenths of one payload.
    // Each probe below re-verifies the whole inventory while overriding a
    // single module, so all but one source is byte-identical to the round
    // before — re-parsing them buys nothing.
    //
    // Assert the contract rather than a call count: no (path, content) pair is
    // ever parsed twice. That stays true as stores are added, and it is exactly
    // the property that makes the memoization safe — a changed byte is a
    // different key, so a cached digest can never describe source that moved.
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));

    resetPersistenceSchemaCaches();
    const parsesPerRound: number[] = [];
    let before = persistenceSchemaCacheStats().sourceParses;
    for (const module of ["shared/data-epoch.cjs", "core/data-epoch-coordinator.ts", "server/index.ts"]) {
      const original = fs.readFileSync(path.join(ROOT, module), "utf-8");
      await assertCommittedPersistenceSchemaFingerprint({
        rootDir: ROOT,
        committedFingerprint: committed,
        inventory,
        sourceOverrides: new Map([[module, `// parse budget probe\n${original}`]]),
      });
      const after = persistenceSchemaCacheStats().sourceParses;
      parsesPerRound.push(after - before);
      before = after;
    }

    // The first round has to read the whole inventory. Every later round differs
    // from it by at most two sources: the module this round overrides, and the
    // one the round before overrode, now back to its committed bytes.
    const [firstRound, ...laterRounds] = parsesPerRound;
    expect(firstRound).toBeGreaterThan(20);
    for (const round of laterRounds) expect(round).toBeLessThanOrEqual(2);
  });

  it("re-introspects after the cache is dropped, so a fresh run never reuses a stale schema", async () => {
    // Memoizing runtime schemas is only safe because the cache cannot outlive
    // the process that filled it. Prove the reset actually clears it: without
    // this, a cache that silently ignored resets would let every later test in
    // this file assert against whatever the first one happened to observe.
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    const sqliteStores = inventory.stores.filter(
      (store: { schemaSource: { kind: string } }) => store.schemaSource.kind === "sqlite-runtime",
    );

    const countIntrospections = async () => {
      const mkdtempSync = vi.spyOn(fs, "mkdtempSync");
      try {
        await assertCommittedPersistenceSchemaFingerprint({
          rootDir: ROOT,
          committedFingerprint: committed,
          inventory,
        });
        return mkdtempSync.mock.calls
          .map(([prefix]) => String(prefix))
          .filter((prefix) => /hana-(?:session-manifest|facts|file-history)-schema-/.test(prefix)).length;
      } finally {
        mkdtempSync.mockRestore();
      }
    };

    resetPersistenceSchemaCaches();
    expect(await countIntrospections()).toBe(sqliteStores.length);
    expect(await countIntrospections()).toBe(0);
    resetPersistenceSchemaCaches();
    expect(await countIntrospections()).toBe(sqliteStores.length);
  });

  it("catches a statement-boundary rewrite that keeps the flat token stream intact", async () => {
    // `return { … };` and `return\n{ … };` flatten to identical token
    // sequences, but automatic semicolon insertion terminates the second
    // `return` at the line break: the function starts returning undefined and
    // the object literal decays into a dead labeled block. Whitespace between
    // tokens is semantic at JavaScript's restricted productions, so the digest
    // must encode the parse tree, not just its leaves.
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    const module = "shared/data-epoch.cjs";
    const original = fs.readFileSync(path.join(ROOT, module), "utf-8");
    const target = 'return { status: "corrupt", filePath, detail };';
    expect(original).toContain(target);
    const mutated = original.replace(target, 'return\n  { status: "corrupt", filePath, detail };');

    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: committed,
      inventory,
      sourceOverrides: new Map([[module, mutated]]),
    })).rejects.toThrow(/persistence schema fingerprint mismatch/);
  });

  it("keeps string and template literal content inside the hash", async () => {
    // Whitespace is only ignorable *between* tokens. Inside a template literal
    // it is content that can reach disk, so it has to stay hashed.
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    const module = "core/data-epoch-coordinator.ts";
    const original = fs.readFileSync(path.join(ROOT, module), "utf-8");

    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: committed,
      inventory,
      sourceOverrides: new Map([[module, `${original}\nexport const probe = \`a  b\`;\n`]]),
    })).rejects.toThrow(/persistence schema fingerprint mismatch/);
  });

  it("records the digest method and the compiler in the payload it pins", async () => {
    // Source hashes are whatever the pinned TypeScript parser says they are.
    // Without naming that parser in the payload, a toolchain upgrade surfaces
    // as a bare "schema fingerprint mismatch" — an alarm that points at
    // persisted shape when nothing persisted changed. The payload carries its
    // own provenance so both the committed diff and the error can say why.
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    const generated = await generatePersistenceSchemaFingerprint({
      rootDir: ROOT,
      inventory,
      review: committed.review,
    });
    expect(generated.sourceDigest).toEqual({
      compiler: `typescript@${ts.version}`,
      method: SOURCE_DIGEST_METHOD,
    });
    expect(committed.sourceDigest).toEqual(generated.sourceDigest);
  });

  it("names the toolchain change instead of a bare mismatch when digest provenance differs", async () => {
    // A fingerprint pinned by another compiler (or digest method) makes every
    // module hash incomparable for reasons that have nothing to do with
    // persisted shape. The guard must say that, not cry schema drift.
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));

    // Re-seal a committed fingerprint whose provenance names a different
    // compiler, the way an older toolchain would have sealed it. The local
    // canonicalization mirrors the generator's stable JSON form; if the two
    // ever drift apart, this test fails loudly on the staleness check instead
    // of silently passing.
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.keys(value as Record<string, unknown>)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
    };
    const seal = (body: Record<string, unknown>) => (
      `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalize(body))).digest("hex")}`
    );
    const { review } = committed;
    const foreignBody: Record<string, unknown> = {
      ...committed,
      sourceDigest: { compiler: "typescript@0.0.0-foreign", method: SOURCE_DIGEST_METHOD },
    };
    delete foreignBody.review;
    delete foreignBody.payloadFingerprint;
    const foreignFingerprint = {
      ...foreignBody,
      payloadFingerprint: seal(foreignBody),
      review: { ...review, payloadFingerprint: seal(foreignBody) },
    };

    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: foreignFingerprint,
      inventory,
    })).rejects.toThrow(/digest provenance[\s\S]*typescript@0\.0\.0-foreign[\s\S]*typescript@/);
  });

  it("holds digest invariants that no toolchain upgrade may break silently", () => {
    // Equal-token pairs that must stay separated (whitespace is semantic at
    // JavaScript's restricted productions) and comment variants that must stay
    // identical. These are properties, not snapshots: they never need updating,
    // and a compiler upgrade that breaks one is a real regression of the guard.
    const digestOf = (module: string, code: string) => (
      executableSourceHash(ROOT, module, new Map([[module, code]]))
    );
    const M = "core/digest-invariant-probe.ts";

    // Restricted productions: same token stream, different program.
    expect(digestOf(M, "function f(){ return { ok: true }; }"))
      .not.toBe(digestOf(M, "function f(){ return\n{ ok: true }; }"));
    expect(digestOf(M, "function f(){ a++\nb; }"))
      .not.toBe(digestOf(M, "function f(){ a\n++b; }"));
    expect(digestOf(M, "async function g(){}"))
      .not.toBe(digestOf(M, "async\nfunction g(){}"));

    // Comments in every shape are invisible.
    expect(digestOf(M, "/** doc */ export function g(){}"))
      .toBe(digestOf(M, "export function g(){}"));
    expect(digestOf(M, "// note\nexport const x = 1; /* trailing */"))
      .toBe(digestOf(M, "export const x = 1;"));

    // Formatting between tokens is invisible; content inside tokens is not.
    expect(digestOf(M, "export  const x =\n  1;")).toBe(digestOf(M, "export const x = 1;"));
    expect(digestOf(M, "export const t = `a  b`;")).not.toBe(digestOf(M, "export const t = `a b`;"));
    expect(digestOf("core/probe.cjs", "#!/usr/bin/env node\nconsole.log(1);"))
      .not.toBe(digestOf("core/probe.cjs", "#!/usr/bin/env other\nconsole.log(1);"));
  });

  it("pins parse-behavior snapshots so toolchain drift is separable from module drift", () => {
    // Fixed snippets with fixed digests. Nothing in day-to-day work moves
    // these: they change only when the digest method or the pinned TypeScript
    // parser changes, which is exactly the event they exist to make visible.
    // On mismatch, the committed module hashes changed for toolchain reasons,
    // not because any guarded module was edited.
    const snapshots: Array<{ name: string; module: string; code: string; digest: string }> = [
      { name: "return-object", module: "core/digest-snap.ts", code: "function f(){ return { ok: true }; }", digest: "sha256:6dbf8d2bcadf21826429d2a8ff4c9c4fe4ed1f6a2899d1134ff3fcbc92504a75" },
      { name: "return-split-asi", module: "core/digest-snap.ts", code: "function f(){ return\n{ ok: true }; }", digest: "sha256:259416511ba3964de4766bd855385c4d4d52975bfd016cfe4fc269280a992ae9" },
      { name: "jsdoc-invisible", module: "core/digest-snap.ts", code: "/** doc */ export function g(){}", digest: "sha256:fa76a67ae833821e5d21c2b0cfefd2dd56119a092ea895157fd7ba45b2f8a682" },
      { name: "template-content", module: "core/digest-snap.ts", code: "export const t = `a  b ${1} c`;", digest: "sha256:3d0506278b4e662266b09a9e07453e582435851dbf877dc84354d2478444c0da" },
      { name: "optional-chain", module: "core/digest-snap.ts", code: "export const v = globalThis?.process?.[\"argv\"];", digest: "sha256:08fce65a4301dcb051938b4b07e195f01a648a97fe28f8ee07c067057cde27b6" },
      { name: "decorator-class", module: "core/digest-snap.ts", code: "declare const dec: ClassDecorator;\n@dec class C { #p = 1; static { void 0; } }", digest: "sha256:b6427d533ec54746dc5646d17b3cfdb6e1b3538258b9a8573e3c0ff83c923083" },
      { name: "jsx-element", module: "core/digest-snap.tsx", code: "export const el = <div a={1}>t x</div>;", digest: "sha256:26e03cb6af00d200b24c49dd338c3be1cdaa877921b0c9a0d6435b3643be7840" },
      { name: "cjs-script", module: "core/digest-snap.cjs", code: "\"use strict\";\nmodule.exports = { n: 1 };", digest: "sha256:6e8af28a51bd5fcb4b9aa85334bac8a8da09623d576da8a2d2fb979469cef803" },
      { name: "shebang", module: "core/digest-snap.cjs", code: "#!/usr/bin/env node\nconsole.log(1);", digest: "sha256:ea6740a08ee7145dc59e84cef6118e5029b944899163e60f81fab54c57966eb4" },
    ];
    const drifted = snapshots
      .map((snapshot) => ({
        name: snapshot.name,
        expected: snapshot.digest,
        actual: executableSourceHash(ROOT, snapshot.module, new Map([[snapshot.module, snapshot.code]])),
      }))
      .filter((entry) => entry.actual !== entry.expected);
    expect(
      drifted,
      "parse-behavior snapshots drifted — expected only on a digest method change or a TypeScript upgrade, "
      + "never from editing guarded modules. Update the pinned digests in the same change that moves the toolchain:\n"
      + drifted.map((entry) => `  ${entry.name}: ${entry.actual}`).join("\n"),
    ).toEqual([]);
  });

  it("rejects a repinned payload until the committed review pins that exact payload", async () => {
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    const module = "shared/data-epoch.cjs";
    const mutatedSource = `${fs.readFileSync(path.join(ROOT, module), "utf-8")}\nexports.reviewedSchemaProbe = 1;\n`;
    const sourceOverrides = new Map([[module, mutatedSource]]);
    const reviewedMutation = await generatePersistenceSchemaFingerprint({
      rootDir: ROOT,
      inventory,
      sourceOverrides,
      review: {
        classification: "compatible",
        compatibilityReason: "The mutation represents a reviewed source-only compatibility change.",
      },
    });
    const repinnedWithoutReview = {
      ...reviewedMutation,
      review: committed.review,
    };

    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: repinnedWithoutReview,
      inventory,
      sourceOverrides,
    })).rejects.toThrow(/schema review does not pin the committed payloadFingerprint/);

    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: reviewedMutation,
      inventory,
      sourceOverrides,
    })).resolves.toEqual(reviewedMutation);
  });

  it("treats a runtime DATA_EPOCH change as payload drift that needs a new review", async () => {
    const committed = JSON.parse(fs.readFileSync(FINGERPRINT_PATH, "utf-8"));
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));

    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: committed,
      currentDataEpoch: 2,
      inventory,
    })).rejects.toThrow(/persistence schema fingerprint mismatch[\s\S]*compatible addition[\s\S]*breaking change/);

    await expect(generatePersistenceSchemaFingerprint({
      rootDir: ROOT,
      currentDataEpoch: 2,
      inventory,
      review: committed.review,
    })).rejects.toThrow(/schema review pins[\s\S]*generated payload/);
  });

  it("requires an epoch-changing write to carry the exact breaking transition review", async () => {
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-schema-write-review-"));
    tempDirs.push(tempDir);
    const outputPath = path.join(tempDir, "persistence-schema-fingerprint.json");

    await writePersistenceSchemaFingerprint({
      rootDir: ROOT,
      outputPath,
      currentDataEpoch: 1,
      inventory,
      review: {
        classification: "compatible",
        compatibilityReason: "Record the current runtime schemas without changing persisted behavior.",
      },
    });

    await expect(writePersistenceSchemaFingerprint({
      rootDir: ROOT,
      outputPath,
      currentDataEpoch: 2,
      inventory,
      review: {
        classification: "compatible",
        compatibilityReason: "This must not be allowed to disguise an epoch transition.",
      },
    })).rejects.toThrow(/DATA_EPOCH changed from 1 to 2[\s\S]*breaking[\s\S]*sourceDataEpoch=1[\s\S]*targetDataEpoch=2/);

    const written = await writePersistenceSchemaFingerprint({
      rootDir: ROOT,
      outputPath,
      currentDataEpoch: 2,
      inventory,
      review: {
        classification: "breaking",
        sourceDataEpoch: 1,
        targetDataEpoch: 2,
        affectedStores: ["session-manifest-sqlite"],
        checkpointPolicy: "Checkpoint the affected store before migration.",
        restorePolicy: "Restore through the owning store after compatibility validation.",
      },
    });
    expect(written.fingerprint).toMatchObject({
      dataEpoch: 2,
      review: {
        classification: "breaking",
        sourceDataEpoch: 1,
        targetDataEpoch: 2,
      },
    });
    expect(JSON.parse(fs.readFileSync(outputPath, "utf-8"))).toEqual(written.fingerprint);
  });

  it("keeps the unregistered-write mutation as the first tripwire", () => {
    const root = temporaryRepository();
    fs.writeFileSync(path.join(root, "core", "unregistered-schema-write.ts"), `
      import fs from "node:fs";
      fs.writeFileSync("unregistered-state.json", "{}");
    `, "utf-8");

    expect(() => scanPersistentStores({
      rootDir: root,
      stores: [],
      exemptions: [],
      today: "2026-07-13",
    })).toThrow(/unregistered persistence site/);
  });

  it("requires a complete breaking declaration and binds it to the landed DATA_EPOCH", async () => {
    expect(() => validateSchemaChangeDeclaration({ classification: "breaking" }, { currentDataEpoch: 2 }))
      .toThrow(
        /source DATA_EPOCH[\s\S]*target DATA_EPOCH[\s\S]*affected stores[\s\S]*checkpoint policy[\s\S]*restore policy[\s\S]*compatible addition[\s\S]*breaking change/,
      );

    expect(validateSchemaChangeDeclaration({
      classification: "breaking",
      sourceDataEpoch: 1,
      targetDataEpoch: 2,
      affectedStores: ["session-manifest-sqlite"],
      checkpointPolicy: "Checkpoint the store before migration.",
      restorePolicy: "Restore through the owning store after compatibility validation.",
    }, { currentDataEpoch: 2 })).toMatchObject({
      classification: "breaking",
      sourceDataEpoch: 1,
      targetDataEpoch: 2,
    });

    const completeBreakingReview = {
      classification: "breaking",
      sourceDataEpoch: 1,
      targetDataEpoch: 2,
      affectedStores: ["session-manifest-sqlite"],
      checkpointPolicy: "Checkpoint the store before migration.",
      restorePolicy: "Restore through the owning store after compatibility validation.",
    };
    expect(() => validateSchemaChangeDeclaration(completeBreakingReview, { currentDataEpoch: 1 }))
      .toThrow(/current DATA_EPOCH equal to target DATA_EPOCH/);
    expect(() => validateSchemaChangeDeclaration(completeBreakingReview, { currentDataEpoch: 3 }))
      .toThrow(/current DATA_EPOCH equal to target DATA_EPOCH/);

    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
    const landedBreakingFingerprint = await generatePersistenceSchemaFingerprint({
      rootDir: ROOT,
      currentDataEpoch: 2,
      inventory,
      review: completeBreakingReview,
    });
    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: landedBreakingFingerprint,
      currentDataEpoch: 2,
      inventory,
    })).resolves.toEqual(landedBreakingFingerprint);
    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: landedBreakingFingerprint,
      currentDataEpoch: 1,
      inventory,
    })).rejects.toThrow(/current DATA_EPOCH equal to target DATA_EPOCH/);
    await expect(assertCommittedPersistenceSchemaFingerprint({
      rootDir: ROOT,
      committedFingerprint: landedBreakingFingerprint,
      currentDataEpoch: 3,
      inventory,
    })).rejects.toThrow(/current DATA_EPOCH equal to target DATA_EPOCH/);

    expect(() => validateSchemaChangeDeclaration({ classification: "compatible" }))
      .toThrow(/compatibility reasoning[\s\S]*compatible addition[\s\S]*breaking change/);
  });
});
