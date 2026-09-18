import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { PreferencesManager } from "../core/preferences-manager.ts";
import { createPreferencesRoute } from "../server/routes/preferences.ts";

function makePrefs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-prefs-hardware-accel-"));
  return new PreferencesManager({
    userDir: path.join(root, "user"),
    agentsDir: path.join(root, "agents"),
  });
}

describe("PreferencesManager hardware acceleration preference", () => {
  it("defaults hardware acceleration to enabled", () => {
    const prefs = makePrefs();

    expect(prefs.getHardwareAcceleration()).toBe(true);
  });

  it("stores hardware acceleration as an explicit boolean", () => {
    const prefs = makePrefs();

    prefs.setHardwareAcceleration("false");
    expect(prefs.getHardwareAcceleration()).toBe(false);
    expect(prefs.getPreferences().hardware_acceleration).toBe(false);

    prefs.setHardwareAcceleration(true);
    expect(prefs.getHardwareAcceleration()).toBe(true);
    expect(prefs.getPreferences().hardware_acceleration).toBe(true);
  });

  it("compare-and-deletes only the exact legacy false value", () => {
    const prefs = makePrefs();

    prefs.setHardwareAcceleration(false);
    expect(prefs.compareAndDeleteLegacyHardwareAccelerationPreference())
      .toEqual({ status: "deleted" });
    expect(prefs.getPreferences().hardware_acceleration).toBeUndefined();
    expect(prefs.compareAndDeleteLegacyHardwareAccelerationPreference())
      .toEqual({ status: "already-absent" });

    prefs.setHardwareAcceleration(true);
    expect(prefs.compareAndDeleteLegacyHardwareAccelerationPreference())
      .toEqual({ status: "value-changed" });
    expect(prefs.getPreferences().hardware_acceleration).toBe(true);
  });

  it("exposes the narrow cleanup through the preferences route", async () => {
    const prefs = makePrefs();
    prefs.setHardwareAcceleration(false);
    const app = new Hono();
    app.route("/api", createPreferencesRoute({
      compareAndDeleteLegacyHardwareAccelerationPreference: () =>
        prefs.compareAndDeleteLegacyHardwareAccelerationPreference(),
    }));

    const response = await app.request(
      "/api/preferences/legacy-gpu-safe-mode/hardware-acceleration",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "deleted" });
    expect(prefs.getPreferences().hardware_acceleration).toBeUndefined();
  });
});
