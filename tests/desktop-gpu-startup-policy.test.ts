import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

const require = createRequire(import.meta.url);

const {
  applyGpuStartupPolicy,
  buildGpuStartupDiagnostics,
  clearAutoGpuModeForRecovery,
  getGpuRecoveryEvidence,
  markGpuStartupFailed,
  markGpuStartupPending,
  markGpuStartupPhase,
  markGpuStartupReady,
  recordGpuChildProcessGone,
  resolveGpuStartupPolicy,
  restoreDeeperAutoGpuMode,
  settleLegacyGpuPreferenceMigration,
} = require("../desktop/src/shared/gpu-startup-policy.cjs");

let root;

function makeHome() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-gpu-policy-"));
  return root;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writePrefs(hanakoHome, prefs) {
  const prefsPath = path.join(hanakoHome, "user", "preferences.json");
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
}

function writeGpuState(hanakoHome, state) {
  const statePath = path.join(hanakoHome, "user", "gpu-startup.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function readPrefs(hanakoHome) {
  try {
    return readJson(path.join(hanakoHome, "user", "preferences.json"));
  } catch {
    return {};
  }
}

describe("desktop GPU startup policy", () => {
  beforeEach(() => {
    root = null;
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps hardware acceleration enabled by default", () => {
    const hanakoHome = makeHome();

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.shouldDisableHardwareAcceleration).toBe(false);
    expect(policy.reason).toBe("default");
  });

  it("honors the user hardware acceleration preference", () => {
    const hanakoHome = makeHome();
    writePrefs(hanakoHome, { hardware_acceleration: false });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(policy.hardwareAccelerationEnabled).toBe(false);
    expect(policy.shouldDisableHardwareAcceleration).toBe(true);
    expect(policy.reason).toBe("preference");
  });

  it("defers legacy automatic safe-mode preference cleanup until the server gate passes", () => {
    const hanakoHome = makeHome();
    writePrefs(hanakoHome, { locale: "zh-CN", hardware_acceleration: false });
    writeGpuState(hanakoHome, {
      version: 1,
      safeMode: {
        enabled: true,
        reason: "previous-startup-incomplete",
        previousStartup: { status: "pending", phase: "launching-splash" },
        updatedAt: "2026-05-19T01:00:00.000Z",
      },
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-21T01:00:00.000Z",
    });

    expect(policy.mode).toBe("gpu-sandbox-compat");
    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.reason).toBe("legacy-auto-safe-mode-migration");
    expect(policy.legacyPreferenceCleanup).toMatchObject({
      sourceReason: "previous-startup-incomplete",
      sourceUpdatedAt: "2026-05-19T01:00:00.000Z",
    });
    expect(readPrefs(hanakoHome)).toEqual({ locale: "zh-CN", hardware_acceleration: false });
    expect(readJson(path.join(hanakoHome, "user", "gpu-startup.json"))).toMatchObject({
      safeMode: { reason: "previous-startup-incomplete" },
      legacySafeModeMigration: { status: "prepared" },
    });

    writePrefs(hanakoHome, { locale: "zh-CN" });
    settleLegacyGpuPreferenceMigration({
      hanakoHome,
      intent: policy.legacyPreferenceCleanup,
      preferenceStatus: "deleted",
      now: "2026-05-21T01:00:01.000Z",
    });

    expect(readJson(path.join(hanakoHome, "user", "gpu-startup.json")).autoGpuMode).toMatchObject({
      mode: "gpu-sandbox-compat",
      reason: "legacy-auto-safe-mode-migration",
      previousMode: "software-safe",
    });
  });

  it("settles an exact legacy GPU child crash marker after preference cleanup", () => {
    const hanakoHome = makeHome();
    const crashAt = "2026-05-19T01:02:00.000Z";
    writePrefs(hanakoHome, { locale: "zh-CN", hardware_acceleration: false });
    writeGpuState(hanakoHome, {
      version: 1,
      safeMode: {
        enabled: true,
        reason: "gpu-child-process-gone",
        updatedAt: crashAt,
      },
      lastGpuCrash: {
        type: "GPU",
        reason: "crashed",
        exitCode: -2147483645,
        platform: "win32",
        at: crashAt,
      },
    });

    const firstPolicy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-21T01:00:00.000Z",
    });

    expect(firstPolicy).toMatchObject({
      mode: "gpu-sandbox-compat",
      hardwareAccelerationEnabled: true,
      reason: "legacy-auto-safe-mode-migration",
    });
    expect(readPrefs(hanakoHome)).toEqual({ locale: "zh-CN", hardware_acceleration: false });
    expect(readJson(path.join(hanakoHome, "user", "gpu-startup.json"))).toMatchObject({
      safeMode: { reason: "gpu-child-process-gone" },
      legacySafeModeMigration: { status: "prepared" },
    });

    writePrefs(hanakoHome, { locale: "zh-CN" });
    settleLegacyGpuPreferenceMigration({
      hanakoHome,
      intent: firstPolicy.legacyPreferenceCleanup,
      preferenceStatus: "deleted",
      now: "2026-05-21T01:00:01.000Z",
    });

    const migratedState = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(migratedState.safeMode).toBeUndefined();
    expect(migratedState.lastGpuCrash).toMatchObject({ at: crashAt, exitCode: -2147483645 });
    expect(migratedState.autoGpuMode).toMatchObject({
      mode: "gpu-sandbox-compat",
      reason: "legacy-auto-safe-mode-migration",
      previousMode: "software-safe",
    });
    expect(migratedState.legacySafeModeMigration).toMatchObject({
      sourceReason: "gpu-child-process-gone",
      sourceUpdatedAt: crashAt,
      status: "completed",
    });

    const secondPolicy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-22T01:00:00.000Z",
    });

    expect(secondPolicy.mode).toBe("gpu-sandbox-compat");
    expect(readJson(path.join(hanakoHome, "user", "gpu-startup.json"))).toEqual(migratedState);
  });

  it("migrates an exact legacy GPU child marker while preserving an enabled preference", () => {
    const hanakoHome = makeHome();
    const crashAt = "2026-05-19T01:02:00.000Z";
    writePrefs(hanakoHome, { locale: "zh-CN", hardware_acceleration: true });
    const lastGpuCrash = {
      type: "GPU",
      reason: "crashed",
      exitCode: -2147483645,
      platform: "win32",
      at: crashAt,
    };
    writeGpuState(hanakoHome, {
      version: 1,
      safeMode: {
        enabled: true,
        reason: "gpu-child-process-gone",
        previousStartup: { status: "pending", phase: "main-window-starting" },
        updatedAt: crashAt,
      },
      lastGpuCrash,
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-21T01:00:00.000Z",
    });

    expect(policy).toMatchObject({
      mode: "gpu-sandbox-compat",
      hardwareAccelerationEnabled: true,
      reason: "legacy-auto-safe-mode-migration",
    });
    expect(policy.legacyPreferenceCleanup).toBeUndefined();
    expect(readPrefs(hanakoHome)).toEqual({ locale: "zh-CN", hardware_acceleration: true });
    const migratedState = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(migratedState.safeMode).toBeUndefined();
    expect(migratedState.lastGpuCrash).toEqual(lastGpuCrash);
    expect(migratedState.autoGpuMode).toMatchObject({
      mode: "gpu-sandbox-compat",
      reason: "legacy-auto-safe-mode-migration",
      previousMode: "software-safe",
      previousStartup: { status: "pending", phase: "main-window-starting" },
    });
    expect(migratedState.legacySafeModeMigration).toMatchObject({
      version: 1,
      sourceReason: "gpu-child-process-gone",
      sourceUpdatedAt: crashAt,
      sourceCrashReason: "crashed",
      preferenceStatus: "preserved-enabled",
      status: "completed",
      completedAt: "2026-05-21T01:00:00.000Z",
    });
  });

  it.each([
    {
      name: "the hardware preference is absent",
      prefs: {},
      mutateState: (state) => state,
    },
    {
      name: "the hardware preference is disabled",
      prefs: { hardware_acceleration: false },
      mutateState: (state) => state,
    },
    {
      name: "the hardware preference is not a literal boolean",
      prefs: { hardware_acceleration: "true" },
      mutateState: (state) => state,
    },
    {
      name: "an automatic GPU mode already exists",
      prefs: { hardware_acceleration: true },
      mutateState: (state) => ({
        ...state,
        autoGpuMode: {
          mode: "software-safe",
          reason: "gpu-child-process-gone",
          updatedAt: state.safeMode.updatedAt,
        },
      }),
    },
    {
      name: "the safe-mode reason differs",
      prefs: { hardware_acceleration: true },
      mutateState: (state) => ({
        ...state,
        safeMode: { ...state.safeMode, reason: "previous-startup-incomplete" },
      }),
    },
    {
      name: "the crash type is not GPU",
      prefs: { hardware_acceleration: true },
      mutateState: (state) => ({
        ...state,
        lastGpuCrash: { ...state.lastGpuCrash, type: "Utility" },
      }),
    },
    {
      name: "the crash reason is not a recognized failure",
      prefs: { hardware_acceleration: true },
      mutateState: (state) => ({
        ...state,
        lastGpuCrash: { ...state.lastGpuCrash, reason: "clean-exit" },
      }),
    },
    {
      name: "the crash record is from another platform",
      prefs: { hardware_acceleration: true },
      mutateState: (state) => ({
        ...state,
        lastGpuCrash: { ...state.lastGpuCrash, platform: "darwin" },
      }),
    },
    {
      name: "the crash timestamp differs",
      prefs: { hardware_acceleration: true },
      mutateState: (state) => ({
        ...state,
        lastGpuCrash: { ...state.lastGpuCrash, at: "2026-05-19T01:02:01.000Z" },
      }),
    },
    {
      name: "the matching crash timestamp is invalid",
      prefs: { hardware_acceleration: true },
      mutateState: (state) => ({
        ...state,
        safeMode: { ...state.safeMode, updatedAt: "not-a-timestamp" },
        lastGpuCrash: { ...state.lastGpuCrash, at: "not-a-timestamp" },
      }),
    },
  ])("does not apply the enabled-preference migration when $name", ({ prefs, mutateState }) => {
    const hanakoHome = makeHome();
    const crashAt = "2026-05-19T01:02:00.000Z";
    writePrefs(hanakoHome, prefs);
    const sourceState = {
      version: 1,
      safeMode: { enabled: true, reason: "gpu-child-process-gone", updatedAt: crashAt },
      lastGpuCrash: { type: "GPU", reason: "crashed", platform: "win32", at: crashAt },
    };
    writeGpuState(hanakoHome, mutateState(sourceState));

    resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-21T01:00:00.000Z",
    });

    expect(readPrefs(hanakoHome)).toEqual(prefs);
    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(state.legacySafeModeMigration?.preferenceStatus).not.toBe("preserved-enabled");
  });

  it("does not apply the enabled-preference migration outside Windows", () => {
    const hanakoHome = makeHome();
    const crashAt = "2026-05-19T01:02:00.000Z";
    writePrefs(hanakoHome, { hardware_acceleration: true });
    writeGpuState(hanakoHome, {
      version: 1,
      safeMode: { enabled: true, reason: "gpu-child-process-gone", updatedAt: crashAt },
      lastGpuCrash: { type: "GPU", reason: "crashed", platform: "win32", at: crashAt },
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "darwin",
      argv: ["Hanako"],
      env: {},
      now: "2026-05-21T01:00:00.000Z",
    });

    expect(policy).toMatchObject({ mode: "hardware", reason: "default" });
    expect(readPrefs(hanakoHome).hardware_acceleration).toBe(true);
    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(state.safeMode).toBeDefined();
    expect(state.autoGpuMode).toBeUndefined();
    expect(state.legacySafeModeMigration).toBeUndefined();
  });

  it("does not migrate a user hardware preference without an exact legacy GPU crash marker", () => {
    const hanakoHome = makeHome();
    writePrefs(hanakoHome, { hardware_acceleration: false });
    writeGpuState(hanakoHome, {
      version: 1,
      safeMode: {
        enabled: true,
        reason: "gpu-child-process-gone",
        updatedAt: "2026-05-19T01:02:00.000Z",
      },
      lastGpuCrash: {
        type: "GPU",
        reason: "crashed",
        exitCode: -2147483645,
        platform: "win32",
        at: "2026-05-19T01:02:01.000Z",
      },
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(policy).toMatchObject({ mode: "software-safe", reason: "preference" });
    expect(readPrefs(hanakoHome).hardware_acceleration).toBe(false);
    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(state.safeMode.reason).toBe("gpu-child-process-gone");
    expect(state.autoGpuMode).toBeUndefined();
    expect(state.legacySafeModeMigration).toBeUndefined();
  });

  it("does not migrate legacy GPU child crash state outside Windows", () => {
    const hanakoHome = makeHome();
    const crashAt = "2026-05-19T01:02:00.000Z";
    writePrefs(hanakoHome, { hardware_acceleration: false });
    writeGpuState(hanakoHome, {
      version: 1,
      safeMode: { enabled: true, reason: "gpu-child-process-gone", updatedAt: crashAt },
      lastGpuCrash: { type: "GPU", reason: "crashed", platform: "win32", at: crashAt },
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "darwin",
      argv: ["Hanako"],
      env: {},
    });

    expect(policy).toMatchObject({ mode: "software-safe", reason: "preference" });
    expect(readPrefs(hanakoHome).hardware_acceleration).toBe(false);
  });

  it("keeps an explicit hardware preference authoritative when current auto GPU state exists", () => {
    const hanakoHome = makeHome();
    const crashAt = "2026-05-19T01:02:00.000Z";
    writePrefs(hanakoHome, { hardware_acceleration: false });
    writeGpuState(hanakoHome, {
      version: 2,
      safeMode: { enabled: true, reason: "gpu-child-process-gone", updatedAt: crashAt },
      autoGpuMode: {
        mode: "gpu-sandbox-compat",
        reason: "gpu-child-process-gone",
        previousMode: "hardware",
        updatedAt: crashAt,
      },
      lastGpuCrash: { type: "GPU", reason: "crashed", platform: "win32", at: crashAt },
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(policy).toMatchObject({ mode: "software-safe", reason: "preference" });
    expect(readPrefs(hanakoHome).hardware_acceleration).toBe(false);
    expect(readJson(path.join(hanakoHome, "user", "gpu-startup.json")).legacySafeModeMigration).toBeUndefined();
  });

  it("resumes settlement after the preference was removed but the GPU state write failed", () => {
    const hanakoHome = makeHome();
    const crashAt = "2026-05-19T01:02:00.000Z";
    const statePath = path.join(hanakoHome, "user", "gpu-startup.json");
    const blockedTmpPath = `${statePath}.${process.pid}.tmp`;
    writePrefs(hanakoHome, { hardware_acceleration: false });
    writeGpuState(hanakoHome, {
      version: 1,
      safeMode: { enabled: true, reason: "gpu-child-process-gone", updatedAt: crashAt },
      lastGpuCrash: { type: "GPU", reason: "crashed", platform: "win32", at: crashAt },
    });
    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-21T01:00:00.000Z",
    });

    const preparedState = readJson(statePath);
    expect(preparedState.safeMode).toMatchObject({
      enabled: true,
      reason: "gpu-child-process-gone",
    });
    expect(preparedState.autoGpuMode).toBeUndefined();
    expect(preparedState.legacySafeModeMigration).toMatchObject({
      sourceUpdatedAt: crashAt,
      status: "prepared",
    });
    expect(readPrefs(hanakoHome).hardware_acceleration).toBe(false);

    writePrefs(hanakoHome, {});
    fs.mkdirSync(blockedTmpPath);
    expect(() => settleLegacyGpuPreferenceMigration({
      hanakoHome,
      intent: policy.legacyPreferenceCleanup,
      preferenceStatus: "deleted",
      now: "2026-05-21T01:01:00.000Z",
    })).toThrow(/legacy GPU safe-mode migration.*completed GPU state/i);
    expect(readJson(statePath).legacySafeModeMigration.status).toBe("prepared");

    fs.rmSync(blockedTmpPath, { recursive: true, force: true });
    const result = settleLegacyGpuPreferenceMigration({
      hanakoHome,
      intent: policy.legacyPreferenceCleanup,
      preferenceStatus: "already-absent",
      now: "2026-05-21T01:01:00.000Z",
    });

    expect(result.status).toBe("completed");
    expect(readPrefs(hanakoHome).hardware_acceleration).toBeUndefined();
    const completedState = readJson(statePath);
    expect(completedState.safeMode).toBeUndefined();
    expect(completedState.legacySafeModeMigration.status).toBe("completed");
  });

  it("finishes a prepared legacy GPU migration after the preference was already cleared", () => {
    const hanakoHome = makeHome();
    const crashAt = "2026-05-19T01:02:00.000Z";
    writePrefs(hanakoHome, { locale: "zh-CN" });
    writeGpuState(hanakoHome, {
      version: 2,
      safeMode: { enabled: true, reason: "gpu-child-process-gone", updatedAt: crashAt },
      lastGpuCrash: { type: "GPU", reason: "crashed", platform: "win32", at: crashAt },
      legacySafeModeMigration: {
        version: 1,
        sourceReason: "gpu-child-process-gone",
        sourceUpdatedAt: crashAt,
        status: "prepared",
        preparedAt: "2026-05-21T01:00:00.000Z",
      },
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-21T01:01:00.000Z",
    });

    expect(policy.mode).toBe("gpu-sandbox-compat");
    expect(readPrefs(hanakoHome)).toEqual({ locale: "zh-CN" });
    expect(readJson(path.join(hanakoHome, "user", "gpu-startup.json")).legacySafeModeMigration.status)
      .toBe("prepared");

    settleLegacyGpuPreferenceMigration({
      hanakoHome,
      intent: policy.legacyPreferenceCleanup,
      preferenceStatus: "already-absent",
      now: "2026-05-21T01:01:00.000Z",
    });

    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(state.safeMode).toBeUndefined();
    expect(state.legacySafeModeMigration).toMatchObject({
      status: "completed",
      preparedAt: "2026-05-21T01:00:00.000Z",
      completedAt: "2026-05-21T01:01:00.000Z",
    });
  });

  it("cancels legacy cleanup when the preference changed after preparation", () => {
    const hanakoHome = makeHome();
    const crashAt = "2026-05-19T01:02:00.000Z";
    writePrefs(hanakoHome, { hardware_acceleration: false });
    writeGpuState(hanakoHome, {
      version: 1,
      safeMode: { enabled: true, reason: "gpu-child-process-gone", updatedAt: crashAt },
      lastGpuCrash: { type: "GPU", reason: "crashed", platform: "win32", at: crashAt },
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-21T01:00:00.000Z",
    });
    writePrefs(hanakoHome, { hardware_acceleration: true });

    const result = settleLegacyGpuPreferenceMigration({
      hanakoHome,
      intent: policy.legacyPreferenceCleanup,
      preferenceStatus: "value-changed",
      now: "2026-05-21T01:01:00.000Z",
    });

    expect(result.status).toBe("cancelled");
    expect(readPrefs(hanakoHome).hardware_acceleration).toBe(true);
    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(state.safeMode).toBeUndefined();
    expect(state.autoGpuMode).toBeUndefined();
    expect(state.legacySafeModeMigration).toMatchObject({
      status: "cancelled",
      preferenceStatus: "value-changed",
    });
  });

  it("fails explicitly when Windows GPU startup state is malformed", () => {
    const hanakoHome = makeHome();
    const statePath = path.join(hanakoHome, "user", "gpu-startup.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{ invalid json\n", "utf-8");

    expect(() => resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    })).toThrow(/failed to read GPU startup state.*gpu-startup\.json/i);
  });

  it("lets explicit safe mode bypass malformed Windows GPU persistence", () => {
    const hanakoHome = makeHome();
    const userDir = path.join(hanakoHome, "user");
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "gpu-startup.json"), "{ invalid state\n", "utf-8");
    fs.writeFileSync(path.join(userDir, "preferences.json"), "{ invalid prefs\n", "utf-8");

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe", "--hana-gpu-safe-mode"],
      env: {},
    });

    expect(policy).toMatchObject({
      mode: "software-safe",
      hardwareAccelerationEnabled: false,
      reason: "explicit",
    });
  });

  it("keeps the legacy preference fallback when no GPU migration evidence exists", () => {
    const hanakoHome = makeHome();
    const prefsPath = path.join(hanakoHome, "user", "preferences.json");
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    fs.writeFileSync(prefsPath, "{ invalid prefs\n", "utf-8");

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(policy).toMatchObject({ mode: "hardware", reason: "default" });
  });

  it("fails explicitly on malformed preferences for an exact legacy GPU migration", () => {
    const hanakoHome = makeHome();
    const crashAt = "2026-05-19T01:02:00.000Z";
    const prefsPath = path.join(hanakoHome, "user", "preferences.json");
    writeGpuState(hanakoHome, {
      version: 1,
      safeMode: { enabled: true, reason: "gpu-child-process-gone", updatedAt: crashAt },
      lastGpuCrash: { type: "GPU", reason: "crashed", platform: "win32", at: crashAt },
    });
    fs.writeFileSync(prefsPath, "{ invalid prefs\n", "utf-8");

    expect(() => resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    })).toThrow(/failed to read GPU startup preferences.*preferences\.json/i);
  });

  it("turns on GPU sandbox compatibility on Windows after an incomplete early startup", () => {
    const hanakoHome = makeHome();
    markGpuStartupPending({
      hanakoHome,
      platform: "win32",
      phase: "launching-splash",
      startupId: "previous-launch",
      now: "2026-05-19T01:00:00.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-19T01:01:00.000Z",
    });

    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.shouldDisableHardwareAcceleration).toBe(false);
    expect(policy.shouldApplyGpuSandboxCompatSwitches).toBe(true);
    expect(policy.mode).toBe("gpu-sandbox-compat");
    expect(policy.reason).toBe("previous-startup-incomplete");
    expect(readPrefs(hanakoHome).hardware_acceleration).toBeUndefined();
    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(state.autoGpuMode).toMatchObject({
      mode: "gpu-sandbox-compat",
      reason: "previous-startup-incomplete",
    });
  });

  it("does not turn a stale server startup marker into GPU recovery", () => {
    const hanakoHome = makeHome();
    markGpuStartupPending({
      hanakoHome,
      platform: "win32",
      phase: "electron-starting",
      startupId: "previous-launch",
      now: "2026-05-19T01:00:00.000Z",
    });
    const statePath = path.join(hanakoHome, "user", "gpu-startup.json");
    const state = readJson(statePath);
    state.startup.phase = "server-starting";
    delete state.startup.gpuRecovery;
    writeGpuState(hanakoHome, state);

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-19T01:01:00.000Z",
    });

    expect(policy.mode).toBe("hardware");
    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.reason).toBe("default");
    expect(readJson(statePath).autoGpuMode).toBeUndefined();
  });

  it("clears pre-UI GPU recovery eligibility when startup reaches server without visible UI", () => {
    const hanakoHome = makeHome();
    markGpuStartupPending({
      hanakoHome,
      platform: "win32",
      phase: "electron-starting",
      startupId: "previous-launch",
      now: "2026-05-19T01:00:00.000Z",
    });
    markGpuStartupPhase({
      hanakoHome,
      platform: "win32",
      phase: "server-starting",
      startupId: "previous-launch",
      now: "2026-05-19T01:00:01.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-19T01:01:00.000Z",
    });

    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(policy.mode).toBe("hardware");
    expect(policy.reason).toBe("default");
    expect(state.startup.gpuRecovery).toMatchObject({
      eligible: false,
      phase: null,
    });
    expect(state.autoGpuMode).toBeUndefined();
  });

  it("preserves GPU recovery eligibility when server startup follows a visible splash", () => {
    const hanakoHome = makeHome();
    markGpuStartupPending({
      hanakoHome,
      platform: "win32",
      phase: "electron-starting",
      startupId: "previous-launch",
      now: "2026-05-19T01:00:00.000Z",
    });
    markGpuStartupPhase({
      hanakoHome,
      platform: "win32",
      phase: "launching-splash",
      startupId: "previous-launch",
      now: "2026-05-19T01:00:01.000Z",
    });
    markGpuStartupPhase({
      hanakoHome,
      platform: "win32",
      phase: "splash-ready",
      startupId: "previous-launch",
      now: "2026-05-19T01:00:02.000Z",
    });
    markGpuStartupPhase({
      hanakoHome,
      platform: "win32",
      phase: "server-starting",
      startupId: "previous-launch",
      now: "2026-05-19T01:00:03.000Z",
    });
    markGpuStartupPhase({
      hanakoHome,
      platform: "win32",
      phase: "server-ready",
      startupId: "previous-launch",
      now: "2026-05-19T01:00:04.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-19T01:01:00.000Z",
    });

    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(policy.mode).toBe("gpu-sandbox-compat");
    expect(policy.reason).toBe("previous-startup-incomplete");
    expect(state.autoGpuMode).toMatchObject({
      mode: "gpu-sandbox-compat",
      reason: "previous-startup-incomplete",
      previousStartup: expect.objectContaining({
        phase: "server-ready",
        gpuRecovery: expect.objectContaining({
          eligible: true,
          phase: "splash-ready",
        }),
      }),
    });
  });

  it("re-enables GPU recovery eligibility when hidden startup creates the main window after server boot", () => {
    const hanakoHome = makeHome();
    markGpuStartupPending({
      hanakoHome,
      platform: "win32",
      phase: "electron-starting",
      startupId: "hidden-launch",
      now: "2026-05-19T01:00:00.000Z",
    });
    markGpuStartupPhase({
      hanakoHome,
      platform: "win32",
      phase: "server-starting",
      startupId: "hidden-launch",
      now: "2026-05-19T01:00:01.000Z",
    });
    markGpuStartupPhase({
      hanakoHome,
      platform: "win32",
      phase: "server-ready",
      startupId: "hidden-launch",
      now: "2026-05-19T01:00:02.000Z",
    });
    markGpuStartupPhase({
      hanakoHome,
      platform: "win32",
      phase: "main-window-created",
      startupId: "hidden-launch",
      now: "2026-05-19T01:00:03.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-19T01:01:00.000Z",
    });

    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(policy.mode).toBe("gpu-sandbox-compat");
    expect(policy.reason).toBe("previous-startup-incomplete");
    expect(state.autoGpuMode).toMatchObject({
      mode: "gpu-sandbox-compat",
      reason: "previous-startup-incomplete",
      previousStartup: expect.objectContaining({
        phase: "main-window-created",
        gpuRecovery: expect.objectContaining({
          eligible: true,
          phase: "main-window-created",
        }),
      }),
    });
  });

  it("re-enables GPU recovery eligibility when hidden startup begins the main window after server boot", () => {
    const hanakoHome = makeHome();
    markGpuStartupPending({
      hanakoHome,
      platform: "win32",
      phase: "electron-starting",
      startupId: "hidden-launch",
      now: "2026-05-19T01:00:00.000Z",
    });
    markGpuStartupPhase({
      hanakoHome,
      platform: "win32",
      phase: "server-starting",
      startupId: "hidden-launch",
      now: "2026-05-19T01:00:01.000Z",
    });
    markGpuStartupPhase({
      hanakoHome,
      platform: "win32",
      phase: "server-ready",
      startupId: "hidden-launch",
      now: "2026-05-19T01:00:02.000Z",
    });
    markGpuStartupPhase({
      hanakoHome,
      platform: "win32",
      phase: "main-window-starting",
      startupId: "hidden-launch",
      now: "2026-05-19T01:00:03.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-19T01:01:00.000Z",
    });

    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(policy.mode).toBe("gpu-sandbox-compat");
    expect(policy.reason).toBe("previous-startup-incomplete");
    expect(state.autoGpuMode).toMatchObject({
      mode: "gpu-sandbox-compat",
      reason: "previous-startup-incomplete",
      previousStartup: expect.objectContaining({
        phase: "main-window-starting",
        gpuRecovery: expect.objectContaining({
          eligible: true,
          phase: "main-window-starting",
        }),
      }),
    });
  });

  it.each([
    ["gpu-sandbox-compat", true, false],
    ["gpu-backend-compat", true, true],
    ["software-safe", false, false],
    ["deep-compat", false, false],
    ["diagnostic-failed", false, false],
  ])("still applies existing auto GPU mode %s when a server marker is stale", (mode, hardwareAccelerationEnabled, backendCompat) => {
    const hanakoHome = makeHome();
    writeGpuState(hanakoHome, {
      version: 2,
      autoGpuMode: {
        mode,
        reason: "gpu-child-process-gone",
        previousMode: "hardware",
        updatedAt: "2026-05-19T01:00:00.000Z",
      },
      startup: {
        status: "pending",
        startupId: "server-launch",
        phase: "server-ready",
        platform: "win32",
        startedAt: "2026-05-19T01:00:00.000Z",
        updatedAt: "2026-05-19T01:00:00.000Z",
      },
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-19T01:01:00.000Z",
    });

    expect(policy.mode).toBe(mode);
    expect(policy.reason).toBe("gpu-child-process-gone");
    expect(policy.hardwareAccelerationEnabled).toBe(hardwareAccelerationEnabled);
    expect(policy.shouldApplyGpuBackendCompatSwitches).toBe(backendCompat);
    expect(readJson(path.join(hanakoHome, "user", "gpu-startup.json")).autoGpuMode).toMatchObject({
      mode,
      reason: "gpu-child-process-gone",
    });
  });

  it("escalates a stale pending GPU sandbox launch into backend compatibility", () => {
    const hanakoHome = makeHome();
    const compatPolicy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe", "--hana-gpu-sandbox-compat"],
      env: {},
    });

    markGpuStartupPending({
      hanakoHome,
      platform: "win32",
      phase: "electron-starting",
      startupId: "compat-launch",
      policy: compatPolicy,
      now: "2026-05-19T01:00:00.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-19T01:01:00.000Z",
    });

    expect(policy.mode).toBe("gpu-backend-compat");
    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.shouldApplyGpuBackendCompatSwitches).toBe(true);
    expect(policy.reason).toBe("previous-startup-incomplete");
    expect(readJson(path.join(hanakoHome, "user", "gpu-startup.json")).autoGpuMode).toMatchObject({
      mode: "gpu-backend-compat",
      reason: "previous-startup-incomplete",
      previousMode: "gpu-sandbox-compat",
      previousStartup: expect.objectContaining({
        policy: expect.objectContaining({
          mode: "gpu-sandbox-compat",
        }),
      }),
    });
  });

  it("escalates a stale pending GPU backend compatibility launch into software safe mode", () => {
    const hanakoHome = makeHome();
    const backendPolicy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe", "--hana-gpu-backend-compat"],
      env: {},
    });

    markGpuStartupPending({
      hanakoHome,
      platform: "win32",
      phase: "electron-starting",
      startupId: "backend-launch",
      policy: backendPolicy,
      now: "2026-05-19T01:00:00.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-19T01:01:00.000Z",
    });

    expect(policy.mode).toBe("software-safe");
    expect(policy.hardwareAccelerationEnabled).toBe(false);
    expect(policy.shouldDisableHardwareAcceleration).toBe(true);
    expect(policy.reason).toBe("previous-startup-incomplete");
    expect(readJson(path.join(hanakoHome, "user", "gpu-startup.json")).autoGpuMode).toMatchObject({
      mode: "software-safe",
      reason: "previous-startup-incomplete",
      previousMode: "gpu-backend-compat",
      previousStartup: expect.objectContaining({
        policy: expect.objectContaining({
          mode: "gpu-backend-compat",
        }),
      }),
    });
  });

  it("escalates a stale deep compatibility startup into diagnostic failed mode", () => {
    const hanakoHome = makeHome();
    writeGpuState(hanakoHome, {
      version: 2,
      autoGpuMode: {
        mode: "deep-compat",
        reason: "gpu-child-process-gone",
        previousMode: "software-safe",
        updatedAt: "2026-05-19T01:00:00.000Z",
      },
      startup: {
        status: "pending",
        startupId: "deep-launch",
        phase: "electron-starting",
        platform: "win32",
        startedAt: "2026-05-19T01:00:00.000Z",
        updatedAt: "2026-05-19T01:00:00.000Z",
        policy: {
          mode: "deep-compat",
          reason: "gpu-child-process-gone",
          hardwareAccelerationEnabled: false,
          shouldDisableHardwareAcceleration: true,
          shouldApplyGpuSandboxCompatSwitches: false,
          shouldApplyDeepCompatSwitches: true,
          shouldApplyUnsafeNoSandboxSwitch: false,
        },
      },
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
      now: "2026-05-19T01:01:00.000Z",
    });

    expect(policy.mode).toBe("diagnostic-failed");
    expect(policy.hardwareAccelerationEnabled).toBe(false);
    expect(policy.shouldApplyDeepCompatSwitches).toBe(true);
    expect(readJson(path.join(hanakoHome, "user", "gpu-startup.json")).autoGpuMode).toMatchObject({
      mode: "diagnostic-failed",
      reason: "previous-startup-incomplete",
      previousMode: "deep-compat",
    });
  });

  it("does not auto-disable hardware acceleration for non-Windows stale startup markers", () => {
    const hanakoHome = makeHome();
    markGpuStartupPending({
      hanakoHome,
      platform: "darwin",
      phase: "launching-splash",
      startupId: "previous-launch",
      now: "2026-05-19T01:00:00.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "darwin",
      argv: ["Hanako"],
      env: {},
    });

    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.shouldDisableHardwareAcceleration).toBe(false);
  });

  it("records GPU child process crashes as next-launch GPU sandbox compatibility", () => {
    const hanakoHome = makeHome();

    recordGpuChildProcessGone({
      hanakoHome,
      platform: "win32",
      details: { type: "GPU", reason: "crashed", exitCode: -2147483645 },
      now: "2026-05-19T01:02:00.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.shouldDisableHardwareAcceleration).toBe(false);
    expect(policy.shouldApplyGpuSandboxCompatSwitches).toBe(true);
    expect(policy.reason).toBe("gpu-child-process-gone");
    expect(policy.mode).toBe("gpu-sandbox-compat");
    expect(readPrefs(hanakoHome).hardware_acceleration).toBeUndefined();
  });

  it("escalates a GPU crash from sandbox compatibility into backend compatibility", () => {
    const hanakoHome = makeHome();
    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe", "--hana-gpu-sandbox-compat"],
      env: {},
    });

    recordGpuChildProcessGone({
      hanakoHome,
      platform: "win32",
      policy,
      details: { type: "GPU", reason: "crashed", exitCode: -2147483645 },
      now: "2026-05-19T01:02:00.000Z",
    });

    const nextPolicy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(nextPolicy.hardwareAccelerationEnabled).toBe(true);
    expect(nextPolicy.mode).toBe("gpu-backend-compat");
    expect(nextPolicy.shouldApplyGpuBackendCompatSwitches).toBe(true);
    expect(readJson(path.join(hanakoHome, "user", "gpu-startup.json")).autoGpuMode).toMatchObject({
      mode: "gpu-backend-compat",
      reason: "gpu-child-process-gone",
      previousMode: "gpu-sandbox-compat",
    });
  });

  it("escalates a GPU crash from backend compatibility into software safe mode", () => {
    const hanakoHome = makeHome();
    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe", "--hana-gpu-backend-compat"],
      env: {},
    });

    recordGpuChildProcessGone({
      hanakoHome,
      platform: "win32",
      policy,
      details: { type: "GPU", reason: "crashed", exitCode: -2147483645 },
      now: "2026-05-19T01:02:00.000Z",
    });

    const nextPolicy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(nextPolicy.hardwareAccelerationEnabled).toBe(false);
    expect(nextPolicy.mode).toBe("software-safe");
    expect(nextPolicy.shouldDisableHardwareAcceleration).toBe(true);
    expect(readJson(path.join(hanakoHome, "user", "gpu-startup.json")).autoGpuMode).toMatchObject({
      mode: "software-safe",
      reason: "gpu-child-process-gone",
      previousMode: "gpu-backend-compat",
    });
  });

  it("escalates a software-safe GPU crash to deep compatibility without changing the user preference", () => {
    const hanakoHome = makeHome();
    writePrefs(hanakoHome, { hardware_acceleration: false });
    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    recordGpuChildProcessGone({
      hanakoHome,
      platform: "win32",
      policy,
      details: { type: "GPU", reason: "crashed", exitCode: -2147483645 },
      now: "2026-05-19T01:02:00.000Z",
    });

    const nextPolicy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(nextPolicy.hardwareAccelerationEnabled).toBe(false);
    expect(nextPolicy.mode).toBe("deep-compat");
    expect(nextPolicy.shouldApplyDeepCompatSwitches).toBe(true);
    expect(readPrefs(hanakoHome).hardware_acceleration).toBe(false);
    expect(readJson(path.join(hanakoHome, "user", "gpu-startup.json")).autoGpuMode).toMatchObject({
      mode: "deep-compat",
      reason: "gpu-child-process-gone",
      previousMode: "software-safe",
    });
  });

  it("clears the pending marker when startup reaches app-ready", () => {
    const hanakoHome = makeHome();
    markGpuStartupPending({
      hanakoHome,
      platform: "win32",
      phase: "launching-splash",
      startupId: "launch-1",
    });

    markGpuStartupReady({
      hanakoHome,
      platform: "win32",
      startupId: "launch-1",
      phase: "app-ready",
    });

    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(state.startup.status).toBe("ready");
    expect(state.startup.phase).toBe("app-ready");
  });

  it("marks startup failures without converting them into GPU safe mode", () => {
    const hanakoHome = makeHome();
    markGpuStartupPending({
      hanakoHome,
      platform: "win32",
      phase: "server-starting",
      startupId: "launch-1",
    });
    markGpuStartupFailed({
      hanakoHome,
      platform: "win32",
      startupId: "launch-1",
      reason: "server-start-failed",
    });

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.reason).toBe("default");
  });

  it("uses Electron's hardware acceleration API without unsafe GPU fallback switches", () => {
    const app = {
      disableHardwareAcceleration: vi.fn(),
      commandLine: { appendSwitch: vi.fn() },
    };

    applyGpuStartupPolicy(app, {
      shouldDisableHardwareAcceleration: true,
      reason: "preference",
    });

    expect(app.disableHardwareAcceleration).toHaveBeenCalledTimes(1);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("disable-software-rasterizer", expect.anything());
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("disable-gpu-sandbox");
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("disable-gpu-sandbox", expect.anything());
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("no-sandbox");
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("no-sandbox", expect.anything());
  });

  it("applies GPU sandbox compatibility switches without disabling hardware acceleration or global sandbox", () => {
    const app = {
      disableHardwareAcceleration: vi.fn(),
      commandLine: {
        appendSwitch: vi.fn(),
        hasSwitch: vi.fn((name) => name === "disable-features"),
        getSwitchValue: vi.fn((name) => name === "disable-features" ? "Vulkan" : ""),
      },
    };

    applyGpuStartupPolicy(app, {
      mode: "gpu-sandbox-compat",
      shouldApplyGpuSandboxCompatSwitches: true,
      shouldDisableHardwareAcceleration: false,
      reason: "gpu-child-process-gone",
    });

    expect(app.disableHardwareAcceleration).not.toHaveBeenCalled();
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu-sandbox");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-features", "Vulkan,GpuSandbox");
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("no-sandbox");
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("no-sandbox", expect.anything());
  });

  it("applies backend compatibility switches without disabling hardware acceleration", () => {
    const app = {
      disableHardwareAcceleration: vi.fn(),
      commandLine: {
        appendSwitch: vi.fn(),
        hasSwitch: vi.fn((name) => name === "disable-features"),
        getSwitchValue: vi.fn((name) => name === "disable-features" ? "GpuSandbox" : ""),
      },
    };

    applyGpuStartupPolicy(app, {
      mode: "gpu-backend-compat",
      shouldApplyGpuBackendCompatSwitches: true,
      shouldDisableHardwareAcceleration: false,
      reason: "gpu-child-process-gone",
    });

    expect(app.disableHardwareAcceleration).not.toHaveBeenCalled();
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu-sandbox");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-features", "GpuSandbox,Vulkan,SkiaGraphite");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("use-angle", "d3d11");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-direct-composition");
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("no-sandbox");
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("no-sandbox", expect.anything());
  });

  it("allows explicit GPU backend compatibility without global no-sandbox", () => {
    const hanakoHome = makeHome();
    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe", "--hana-gpu-backend-compat"],
      env: {},
    });

    expect(policy.mode).toBe("gpu-backend-compat");
    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.shouldApplyGpuBackendCompatSwitches).toBe(true);
    expect(policy.shouldApplyUnsafeNoSandboxSwitch).toBe(false);
  });

  it("allows explicit GPU sandbox compatibility without global no-sandbox", () => {
    const hanakoHome = makeHome();
    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe", "--hana-gpu-sandbox-compat"],
      env: {},
    });

    expect(policy.mode).toBe("gpu-sandbox-compat");
    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.shouldApplyGpuSandboxCompatSwitches).toBe(true);
    expect(policy.shouldApplyUnsafeNoSandboxSwitch).toBe(false);
  });

  it("applies global no-sandbox only for explicit unsafe GPU diagnostics", () => {
    const hanakoHome = makeHome();
    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe", "--hana-gpu-unsafe-no-sandbox"],
      env: {},
    });
    const app = {
      disableHardwareAcceleration: vi.fn(),
      commandLine: { appendSwitch: vi.fn() },
    };

    applyGpuStartupPolicy(app, policy);

    expect(policy.mode).toBe("gpu-sandbox-compat");
    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.shouldApplyGpuSandboxCompatSwitches).toBe(true);
    expect(policy.shouldApplyUnsafeNoSandboxSwitch).toBe(true);
    expect(app.disableHardwareAcceleration).not.toHaveBeenCalled();
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu-sandbox");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-features", "GpuSandbox");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("no-sandbox");
  });

  it("does not persist explicit unsafe no-sandbox after a GPU crash", () => {
    const hanakoHome = makeHome();
    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe", "--hana-gpu-unsafe-no-sandbox"],
      env: {},
    });

    recordGpuChildProcessGone({
      hanakoHome,
      platform: "win32",
      policy,
      details: { type: "GPU", reason: "crashed", exitCode: -2147483645 },
      now: "2026-05-19T01:02:00.000Z",
    });

    const nextPolicy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });

    expect(nextPolicy.mode).toBe("gpu-backend-compat");
    expect(nextPolicy.shouldApplyUnsafeNoSandboxSwitch).toBe(false);
    expect(readJson(path.join(hanakoHome, "user", "gpu-startup.json")).autoGpuMode).toMatchObject({
      mode: "gpu-backend-compat",
      reason: "gpu-child-process-gone",
      previousMode: "gpu-sandbox-compat",
    });
  });

  it("applies deep compatibility switches without disabling software rasterizer or sandbox", () => {
    const app = {
      disableHardwareAcceleration: vi.fn(),
      commandLine: { appendSwitch: vi.fn() },
    };

    applyGpuStartupPolicy(app, {
      shouldDisableHardwareAcceleration: true,
      shouldApplyDeepCompatSwitches: true,
      mode: "deep-compat",
      reason: "gpu-child-process-gone",
    });

    expect(app.disableHardwareAcceleration).toHaveBeenCalledTimes(1);
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu-compositing");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu-rasterization");
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("disable-software-rasterizer", expect.anything());
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("disable-gpu-sandbox");
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("disable-gpu-sandbox", expect.anything());
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("no-sandbox");
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("no-sandbox", expect.anything());
  });

  it("records backend policy and recovery classification in diagnostics", () => {
    const hanakoHome = makeHome();
    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe", "--hana-gpu-backend-compat"],
      env: {},
    });

    markGpuStartupPending({
      hanakoHome,
      platform: "win32",
      phase: "launching-splash",
      startupId: "backend-launch",
      policy,
      now: "2026-05-19T01:00:00.000Z",
    });

    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(state.startup.policy).toMatchObject({
      mode: "gpu-backend-compat",
      shouldApplyGpuBackendCompatSwitches: true,
      shouldApplyUnsafeNoSandboxSwitch: false,
    });

    const diagnostics = buildGpuStartupDiagnostics({ hanakoHome, policy });
    expect(diagnostics).toContain("GPU backend compatibility switches enabled: true");
    expect(diagnostics).toContain("GPU sandbox disabled by policy: true");
    expect(diagnostics).toContain("Incomplete startup classification: gpu-recovery");
  });

  it("classifies suspected sandbox init failure without persisting unsafe no-sandbox", () => {
    const hanakoHome = makeHome();
    const statePath = path.join(hanakoHome, "user", "gpu-startup.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      autoGpuMode: {
        mode: "diagnostic-failed",
        reason: "gpu-child-process-gone",
        previousMode: "deep-compat",
        updatedAt: "2026-05-19T01:02:00.000Z",
      },
    }, null, 2));

    const policy = resolveGpuStartupPolicy({
      hanakoHome,
      platform: "win32",
      argv: ["Hanako.exe"],
      env: {},
    });
    const diagnostics = buildGpuStartupDiagnostics({ hanakoHome, policy });

    expect(policy.mode).toBe("diagnostic-failed");
    expect(policy.shouldApplyUnsafeNoSandboxSwitch).toBe(false);
    expect(diagnostics).toContain("GPU sandbox diagnostic classification: sandbox-init-failure-suspected");
    expect(diagnostics).toContain("Unsafe no-sandbox note: only enabled by --hana-gpu-unsafe-no-sandbox for one diagnostic launch");
  });
});

describe("GPU recovery primitives", () => {
  it("getGpuRecoveryEvidence returns a normalized snapshot of crash evidence", () => {
    const hanakoHome = makeHome();
    writeGpuState(hanakoHome, {
      version: 2,
      autoGpuMode: { mode: "software-safe", reason: "gpu-child-process-gone", updatedAt: "2026-08-01T00:00:00.000Z" },
      lastGpuCrash: { type: "GPU", reason: "crashed", at: "2026-08-01T00:00:00.000Z", platform: "win32" },
      startup: {
        status: "pending",
        startupId: "1-1",
        phase: "main-window-starting",
        platform: "win32",
        startedAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        policy: { mode: "hardware" },
      },
    });

    const evidence = getGpuRecoveryEvidence(hanakoHome);
    expect(evidence.autoGpuMode.mode).toBe("software-safe");
    expect(evidence.latestCrashAt).toBe("2026-08-01T00:00:00.000Z");
    expect(evidence.startup).toMatchObject({
      status: "pending",
      startedAt: "2026-08-02T00:00:00.000Z",
      readyAt: null,
      policyMode: "hardware",
    });
    expect(evidence.incompleteClassification).toBe("gpu-recovery");
  });

  it("getGpuRecoveryEvidence handles an empty state file", () => {
    const hanakoHome = makeHome();
    const evidence = getGpuRecoveryEvidence(hanakoHome);
    expect(evidence).toEqual({
      autoGpuMode: null,
      latestCrashAt: null,
      startup: null,
      incompleteClassification: "none",
    });
  });

  it("clearAutoGpuModeForRecovery clears auto mode plus stale gpu pending marker and records an audit", () => {
    const hanakoHome = makeHome();
    writeGpuState(hanakoHome, {
      version: 2,
      autoGpuMode: { mode: "deep-compat", reason: "gpu-child-process-gone", updatedAt: "2026-08-01T00:00:00.000Z" },
      lastGpuCrash: { type: "GPU", reason: "crashed", at: "2026-08-01T00:00:00.000Z", platform: "win32" },
      startup: { status: "pending", startupId: "1-1", phase: "splash-ready", platform: "win32", startedAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z" },
    });

    const result = clearAutoGpuModeForRecovery({
      hanakoHome,
      reason: "win32-install-acl-heal",
      now: "2026-08-03T00:00:00.000Z",
    });
    expect(result).toEqual({ cleared: true, clearedMode: "deep-compat" });

    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(state.autoGpuMode).toBeUndefined();
    expect(state.startup).toBeUndefined();
    expect(state.lastGpuCrash).toBeDefined();
    expect(state.lastGpuRecovery).toMatchObject({
      reason: "win32-install-acl-heal",
      clearedMode: "deep-compat",
      clearedPendingPhase: "splash-ready",
      at: "2026-08-03T00:00:00.000Z",
    });
  });

  it("clearAutoGpuModeForRecovery keeps a non-gpu pending marker and reports cleared=false when nothing applies", () => {
    const hanakoHome = makeHome();
    writeGpuState(hanakoHome, {
      version: 2,
      startup: { status: "pending", startupId: "1-1", phase: "server-starting", platform: "win32", startedAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z" },
    });

    const result = clearAutoGpuModeForRecovery({ hanakoHome, reason: "win32-install-acl-heal" });
    expect(result).toEqual({ cleared: false, clearedMode: null });
    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(state.startup).toBeDefined();
    expect(state.lastGpuRecovery).toBeUndefined();
  });

  it("restoreDeeperAutoGpuMode restores only when the requested mode is deeper than the current one", () => {
    const hanakoHome = makeHome();
    writeGpuState(hanakoHome, {
      version: 2,
      autoGpuMode: { mode: "gpu-sandbox-compat", reason: "previous-startup-incomplete", updatedAt: "2026-08-03T01:00:00.000Z" },
      startup: { status: "pending", startupId: "2-2", phase: "splash-ready", platform: "win32", startedAt: "2026-08-03T01:00:00.000Z", updatedAt: "2026-08-03T01:00:00.000Z" },
    });

    const restored = restoreDeeperAutoGpuMode({
      hanakoHome,
      mode: "deep-compat",
      reason: "acl-heal-ineffective",
      now: "2026-08-03T02:00:00.000Z",
    });
    expect(restored).toEqual({ restored: true, currentMode: "deep-compat" });

    const state = readJson(path.join(hanakoHome, "user", "gpu-startup.json"));
    expect(state.autoGpuMode).toMatchObject({ mode: "deep-compat", reason: "acl-heal-ineffective", updatedAt: "2026-08-03T02:00:00.000Z" });
    expect(state.startup).toBeUndefined();

    const noop = restoreDeeperAutoGpuMode({ hanakoHome, mode: "gpu-sandbox-compat", reason: "acl-heal-ineffective" });
    expect(noop).toEqual({ restored: false, currentMode: "deep-compat" });
  });

  it("restoreDeeperAutoGpuMode rejects unknown modes", () => {
    const hanakoHome = makeHome();
    expect(() => restoreDeeperAutoGpuMode({ hanakoHome, mode: "warp-speed", reason: "x" })).toThrow(/unknown GPU mode/i);
  });
});
