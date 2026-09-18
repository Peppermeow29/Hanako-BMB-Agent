/**
 * Guardrail: verify better-sqlite3 native addon loads and can open a database.
 *
 * Catches the silent failure where `npm install --ignore-scripts=true`
 * (or global `ignore-scripts=true` in ~/.npmrc) skips native compilation,
 * leaving a missing or ABI-incompatible `better_sqlite3.node`.
 *
 * If this test fails, run:
 *   npm rebuild better-sqlite3 --ignore-scripts=false --foreground-scripts
 */
import { describe, expect, it } from "vitest";

const REBUILD_COMMAND =
  "npm rebuild better-sqlite3 --ignore-scripts=false --foreground-scripts";

describe("better-sqlite3 native addon guardrail", () => {
  it("loads the native addon and opens an in-memory database", () => {
    let Database: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      Database = require("better-sqlite3");
    } catch (err: any) {
      throw new Error(
        `Failed to load better-sqlite3 native addon.\n` +
        `This usually means install scripts were skipped (--ignore-scripts=true)\n` +
        `or the addon was compiled against a different Node ABI.\n\n` +
        `Rebuild with:\n  ${REBUILD_COMMAND}\n\n` +
        `Original error: ${err.message}`,
      );
    }

    let db: any;
    try {
      db = new Database(":memory:");
      const row = db.prepare("select 1 as ok").get();
      expect(row).toEqual({ ok: 1 });
    } catch (err: any) {
      throw new Error(
        `better-sqlite3 loaded but cannot open an in-memory database.\n` +
        `The native addon may be corrupt or ABI-mismatched.\n\n` +
        `Rebuild with:\n  ${REBUILD_COMMAND}\n\n` +
        `Original error: ${err.message}`,
      );
    } finally {
      try { db?.close(); } catch { /* best-effort cleanup */ }
    }
  });
});
