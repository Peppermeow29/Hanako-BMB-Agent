import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const root = process.cwd();

/**
 * Static source-contract coverage for desktop/main.cjs's foreign-server
 * pre-spawn probe (Commit 1, 同宅互斥闸 desktop-side execution point).
 *
 * desktop/main.cjs is an Electron main-process entry (imports `electron`,
 * touches module-level state, calls `app.*`) and cannot be `require()`d
 * directly in a plain vitest/Node environment — this repo's established
 * pattern (see tests/server-startup-diagnostics-contract.test.ts and
 * tests/artifact-boot-channel-consistency.test.ts) is to assert on its
 * exact source text for wiring that can't be exercised any other way.
 * The pure decision logic itself (probeServerInfo /
 * isForeignServerBlocking / describeForeignServerBlock) has full
 * behavioral coverage in tests/server-info-probe.test.ts — this file only
 * proves desktop/main.cjs actually calls into it at the right spot.
 */
describe("desktop foreign-server guard (same-HANA_HOME mutual exclusion, desktop pre-spawn)", () => {
  const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

  it("requires the shared token-authenticated probe module", () => {
    expect(mainSource).toContain('require("../shared/server-info-probe.cjs")');
    expect(mainSource).toContain("probeServerInfo");
    expect(mainSource).toContain("isForeignServerBlocking");
    expect(mainSource).toContain("describeForeignServerBlock");
  });

  it("probes the residual server before falling through to the port-not-conflicting spawn branch, and throws FOREIGN_SERVER_RUNNING when it blocks", () => {
    // Locate the disposition branch this guard was inserted into: the
    // "!disposition.removeInfoFile" block, after the STALE_SERVER_UNCLEANED
    // failFast throw, before the "继续 spawn 新 server" comment.
    const dispositionBlockStart = mainSource.indexOf("if (!disposition.removeInfoFile) {");
    expect(dispositionBlockStart).toBeGreaterThan(-1);

    const staleThrowIndex = mainSource.indexOf('err.code = "STALE_SERVER_UNCLEANED";', dispositionBlockStart);
    const probeCallIndex = mainSource.indexOf("await probeServerInfo({ info: existingInfo })", dispositionBlockStart);
    const foreignThrowIndex = mainSource.indexOf('err.code = "FOREIGN_SERVER_RUNNING";', dispositionBlockStart);
    const continueSpawnCommentIndex = mainSource.indexOf("继续 spawn 新 server", dispositionBlockStart);

    expect(staleThrowIndex).toBeGreaterThan(-1);
    expect(probeCallIndex).toBeGreaterThan(-1);
    expect(foreignThrowIndex).toBeGreaterThan(-1);
    expect(continueSpawnCommentIndex).toBeGreaterThan(-1);

    // Ordering: STALE_SERVER_UNCLEANED throw (existing, untouched) -> probe
    // call (new) -> FOREIGN_SERVER_RUNNING throw (new) -> comment marking
    // the original fallthrough spawn path (now only reached when the probe
    // did NOT block).
    expect(staleThrowIndex).toBeLessThan(probeCallIndex);
    expect(probeCallIndex).toBeLessThan(foreignThrowIndex);
    expect(foreignThrowIndex).toBeLessThan(continueSpawnCommentIndex);

    expect(mainSource).toContain("isForeignServerBlocking(foreignProbe.status)");
  });

  it("surfaces FOREIGN_SERVER_RUNNING in the launch-failure dialog detail, same as the existing STALE_SERVER_UNCLEANED precedent", () => {
    expect(mainSource).toContain('err?.code === "FOREIGN_SERVER_RUNNING" ? err.message : null');
    const foreignServerErrorIndex = mainSource.indexOf("const foreignServerError =");
    const rootServerErrorIndex = mainSource.indexOf("const rootServerError =");
    expect(foreignServerErrorIndex).toBeGreaterThan(-1);
    expect(rootServerErrorIndex).toBeGreaterThan(foreignServerErrorIndex);
    expect(mainSource).toContain("structuredPortConflict || staleServerError || foreignServerError || extractRootServerStartupError");
  });
});
