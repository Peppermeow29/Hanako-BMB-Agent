const fs = require("fs");
const path = require("path");

const STATE_VERSION = 2;
const STATE_FILE = path.join("user", "gpu-startup.json");
const PREFERENCES_FILE = path.join("user", "preferences.json");
const GPU_MODE_HARDWARE = "hardware";
const GPU_MODE_GPU_SANDBOX_COMPAT = "gpu-sandbox-compat";
const GPU_MODE_GPU_BACKEND_COMPAT = "gpu-backend-compat";
const GPU_MODE_SOFTWARE_SAFE = "software-safe";
const GPU_MODE_DEEP_COMPAT = "deep-compat";
const GPU_MODE_DIAGNOSTIC_FAILED = "diagnostic-failed";
const GPU_SANDBOX_COMPAT_DISABLE_FEATURES = ["GpuSandbox"];
const GPU_BACKEND_COMPAT_DISABLE_FEATURES = ["GpuSandbox", "Vulkan", "SkiaGraphite"];
const GPU_RECOVERY_STARTUP_PHASES = new Set([
  "electron-starting",
  "launching-splash",
  "splash-ready",
  "main-window-starting",
  "main-window-created",
  "onboarding-window-starting",
  "onboarding-window-created",
]);
const NON_GPU_STARTUP_PHASES = new Set([
  "server-starting",
  "server-ready",
]);
const LEGACY_AUTO_SAFE_MODE_REASONS = new Set([
  "previous-startup-incomplete",
]);
const LEGACY_GPU_CHILD_SAFE_MODE_REASON = "gpu-child-process-gone";
const LEGACY_SAFE_MODE_MIGRATION_VERSION = 1;
const GPU_FAILURE_REASONS = new Set([
  "abnormal-exit",
  "crashed",
  "integrity-failure",
  "launch-failed",
  "oom",
]);

function nowIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now) return now;
  return new Date().toISOString();
}

function readJson(filePath, fallback = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readJsonStrict(filePath, fallback, label) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`Failed to read ${label} at ${filePath}: ${error.message}`, { cause: error });
  }

  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Failed to read ${label} at ${filePath}: ${error.message}`, { cause: error });
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function getGpuStartupStatePath(hanakoHome) {
  return path.join(hanakoHome, STATE_FILE);
}

function getPreferencesPath(hanakoHome) {
  return path.join(hanakoHome, PREFERENCES_FILE);
}

function readState(hanakoHome) {
  return readJson(getGpuStartupStatePath(hanakoHome), { version: STATE_VERSION });
}

function readStateStrict(hanakoHome) {
  return readJsonStrict(
    getGpuStartupStatePath(hanakoHome),
    { version: STATE_VERSION },
    "GPU startup state",
  );
}

function writeState(hanakoHome, state) {
  writeJson(getGpuStartupStatePath(hanakoHome), {
    ...state,
    version: STATE_VERSION,
  });
}

function readPreferences(hanakoHome) {
  return readJson(getPreferencesPath(hanakoHome), {});
}

function readPreferencesStrict(hanakoHome) {
  return readJsonStrict(getPreferencesPath(hanakoHome), {}, "GPU startup preferences");
}

function boolFromSetting(value, defaultValue) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "off", "no", "disabled"].includes(normalized)) return false;
    if (["true", "1", "on", "yes", "enabled"].includes(normalized)) return true;
  }
  return defaultValue;
}

function hasArg(argv, name) {
  const prefix = `--${name}`;
  return (argv || []).some((arg) => arg === prefix || String(arg).startsWith(`${prefix}=`));
}

function isExplicitSafeMode(argv, env) {
  if (boolFromSetting(env?.HANA_GPU_SAFE_MODE, false)) return true;
  if (boolFromSetting(env?.HANA_DISABLE_HARDWARE_ACCELERATION, false)) return true;
  return hasArg(argv, "hana-gpu-safe-mode") || hasArg(argv, "hana-disable-hardware-acceleration");
}

function isExplicitGpuSandboxCompatibility(argv, env) {
  if (boolFromSetting(env?.HANA_GPU_SANDBOX_COMPAT, false)) return true;
  return hasArg(argv, "hana-gpu-sandbox-compat");
}

function isExplicitGpuBackendCompatibility(argv, env) {
  if (boolFromSetting(env?.HANA_GPU_BACKEND_COMPAT, false)) return true;
  return hasArg(argv, "hana-gpu-backend-compat");
}

function isExplicitUnsafeNoSandbox(argv, env) {
  if (boolFromSetting(env?.HANA_GPU_UNSAFE_NO_SANDBOX, false)) return true;
  return hasArg(argv, "hana-gpu-unsafe-no-sandbox");
}

function policyForMode(mode, reason, extra = {}) {
  const normalizedMode = mode || GPU_MODE_HARDWARE;
  const shouldDisableHardwareAcceleration =
    normalizedMode === GPU_MODE_SOFTWARE_SAFE ||
    normalizedMode === GPU_MODE_DEEP_COMPAT ||
    normalizedMode === GPU_MODE_DIAGNOSTIC_FAILED;
  return {
    mode: normalizedMode,
    hardwareAccelerationEnabled: !shouldDisableHardwareAcceleration,
    shouldDisableHardwareAcceleration,
    shouldApplyGpuSandboxCompatSwitches: normalizedMode === GPU_MODE_GPU_SANDBOX_COMPAT,
    shouldApplyGpuBackendCompatSwitches: normalizedMode === GPU_MODE_GPU_BACKEND_COMPAT,
    shouldApplyDeepCompatSwitches: normalizedMode === GPU_MODE_DEEP_COMPAT || normalizedMode === GPU_MODE_DIAGNOSTIC_FAILED,
    shouldApplyUnsafeNoSandboxSwitch: false,
    reason: reason || "default",
    ...extra,
  };
}

function writeAutoGpuMode(hanakoHome, mode, {
  reason,
  previousMode,
  previousStartup,
  now,
} = {}) {
  const timestamp = nowIso(now);
  const state = readState(hanakoHome);
  writeState(hanakoHome, {
    ...state,
    autoGpuMode: {
      mode,
      reason: reason || "unknown",
      previousMode: previousMode || null,
      previousStartup: previousStartup || null,
      updatedAt: timestamp,
    },
  });
}

function legacyAutoSafeModeMigrationEvidence(state) {
  if (state?.autoGpuMode) return null;
  const safeMode = state?.safeMode;
  if (!safeMode?.enabled) return null;
  if (!LEGACY_AUTO_SAFE_MODE_REASONS.has(safeMode.reason || "")) return null;
  const sourceUpdatedAt = safeMode.updatedAt;
  if (typeof sourceUpdatedAt !== "string" || !sourceUpdatedAt) return null;

  const migration = state?.legacySafeModeMigration;
  const prepared =
    migration?.version === LEGACY_SAFE_MODE_MIGRATION_VERSION &&
    migration.status === "prepared" &&
    migration.sourceReason === safeMode.reason &&
    migration.sourceUpdatedAt === sourceUpdatedAt;

  return { safeMode, sourceReason: safeMode.reason, sourceUpdatedAt, prepared };
}

function legacyAutoSafeModeMigrationCandidate(prefs, state) {
  const evidence = legacyAutoSafeModeMigrationEvidence(state);
  if (!evidence) return null;
  if (!evidence.prepared && prefs?.hardware_acceleration !== false) return null;
  return evidence;
}

function prepareLegacySafeModeMigration(hanakoHome, state, candidate, now) {
  const timestamp = nowIso(now);
  const statePath = getGpuStartupStatePath(hanakoHome);
  let preparedState = state;
  if (!candidate.prepared) {
    preparedState = {
      ...state,
      legacySafeModeMigration: {
        version: LEGACY_SAFE_MODE_MIGRATION_VERSION,
        sourceReason: candidate.sourceReason,
        sourceUpdatedAt: candidate.sourceUpdatedAt,
        status: "prepared",
        preparedAt: timestamp,
      },
    };
    runLegacyGpuMigrationWrite("prepared GPU state", statePath, () => {
      writeState(hanakoHome, preparedState);
    });
  }

  const autoGpuMode = {
    mode: GPU_MODE_GPU_SANDBOX_COMPAT,
    reason: "legacy-auto-safe-mode-migration",
    previousMode: GPU_MODE_SOFTWARE_SAFE,
    previousStartup: candidate.safeMode.previousStartup || null,
    updatedAt: timestamp,
  };
  return policyForMode(GPU_MODE_GPU_SANDBOX_COMPAT, "legacy-auto-safe-mode-migration", {
    autoGpuMode,
    legacyPreferenceCleanup: {
      version: LEGACY_SAFE_MODE_MIGRATION_VERSION,
      sourceReason: candidate.sourceReason,
      sourceUpdatedAt: candidate.sourceUpdatedAt,
    },
  });
}

function migrateLegacyAutoSafeModePreference(hanakoHome, prefs, state, now) {
  const candidate = legacyAutoSafeModeMigrationCandidate(prefs, state);
  if (!candidate) return null;

  return prepareLegacySafeModeMigration(hanakoHome, state, candidate, now);
}

function legacyGpuChildMigrationEvidence(state) {
  if (state?.autoGpuMode) return null;
  const safeMode = state?.safeMode;
  const crash = state?.lastGpuCrash;
  const sourceUpdatedAt = safeMode?.updatedAt;
  if (!safeMode?.enabled || safeMode.reason !== LEGACY_GPU_CHILD_SAFE_MODE_REASON) return null;
  if (typeof sourceUpdatedAt !== "string" || !sourceUpdatedAt) return null;
  if (crash?.type !== "GPU" || !GPU_FAILURE_REASONS.has(crash.reason || "unknown")) return null;
  if (crash.at !== sourceUpdatedAt) return null;

  const migration = state?.legacySafeModeMigration;
  const prepared =
    migration?.version === LEGACY_SAFE_MODE_MIGRATION_VERSION &&
    migration.status === "prepared" &&
    migration.sourceReason === LEGACY_GPU_CHILD_SAFE_MODE_REASON &&
    migration.sourceUpdatedAt === sourceUpdatedAt;

  return {
    safeMode,
    sourceReason: LEGACY_GPU_CHILD_SAFE_MODE_REASON,
    sourceUpdatedAt,
    prepared,
  };
}

function legacyGpuChildMigrationCandidate(prefs, state) {
  const evidence = legacyGpuChildMigrationEvidence(state);
  if (!evidence) return null;
  const { prepared } = evidence;
  if (!prepared && prefs?.hardware_acceleration !== false) return null;

  return evidence;
}

function legacyEnabledGpuChildMigrationCandidate(prefs, state) {
  if (prefs?.hardware_acceleration !== true) return null;
  if (state?.legacySafeModeMigration) return null;
  const evidence = legacyGpuChildMigrationEvidence(state);
  if (!evidence) return null;
  const crash = state.lastGpuCrash;
  if (crash.platform !== "win32") return null;
  const sourceDate = new Date(evidence.sourceUpdatedAt);
  if (Number.isNaN(sourceDate.getTime()) || sourceDate.toISOString() !== evidence.sourceUpdatedAt) return null;

  return { ...evidence, sourceCrashReason: crash.reason };
}

function runLegacyGpuMigrationWrite(stage, filePath, write) {
  try {
    write();
  } catch (error) {
    throw new Error(
      `Legacy GPU safe-mode migration failed while writing ${stage} at ${filePath}: ${error.message}`,
      { cause: error },
    );
  }
}

function migrateLegacyGpuChildSafeMode(hanakoHome, prefs, state, now) {
  const enabledCandidate = legacyEnabledGpuChildMigrationCandidate(prefs, state);
  if (enabledCandidate) {
    const timestamp = nowIso(now);
    const nextState = {
      ...state,
      autoGpuMode: {
        mode: GPU_MODE_GPU_SANDBOX_COMPAT,
        reason: "legacy-auto-safe-mode-migration",
        previousMode: GPU_MODE_SOFTWARE_SAFE,
        previousStartup: enabledCandidate.safeMode.previousStartup || null,
        updatedAt: timestamp,
      },
      legacySafeModeMigration: {
        version: LEGACY_SAFE_MODE_MIGRATION_VERSION,
        sourceReason: enabledCandidate.sourceReason,
        sourceUpdatedAt: enabledCandidate.sourceUpdatedAt,
        sourceCrashReason: enabledCandidate.sourceCrashReason,
        preferenceStatus: "preserved-enabled",
        status: "completed",
        completedAt: timestamp,
      },
    };
    delete nextState.safeMode;
    runLegacyGpuMigrationWrite("completed GPU state", getGpuStartupStatePath(hanakoHome), () => {
      writeState(hanakoHome, nextState);
    });
    return policyForMode(GPU_MODE_GPU_SANDBOX_COMPAT, "legacy-auto-safe-mode-migration", {
      autoGpuMode: nextState.autoGpuMode,
    });
  }

  const candidate = legacyGpuChildMigrationCandidate(prefs, state);
  if (!candidate) return null;

  return prepareLegacySafeModeMigration(hanakoHome, state, candidate, now);
}

function settleLegacyGpuPreferenceMigration({
  hanakoHome,
  intent,
  preferenceStatus,
  now,
} = {}) {
  if (!hanakoHome) throw new Error("settleLegacyGpuPreferenceMigration requires hanakoHome");
  if (
    intent?.version !== LEGACY_SAFE_MODE_MIGRATION_VERSION ||
    typeof intent.sourceReason !== "string" ||
    typeof intent.sourceUpdatedAt !== "string"
  ) {
    throw new Error("Legacy GPU safe-mode migration has an invalid cleanup intent");
  }
  if (!["deleted", "already-absent", "value-changed"].includes(preferenceStatus)) {
    throw new Error(`Legacy GPU safe-mode migration received unknown preference status: ${preferenceStatus}`);
  }

  const state = readStateStrict(hanakoHome);
  const migration = state.legacySafeModeMigration;
  if (
    migration?.version !== intent.version ||
    migration.status !== "prepared" ||
    migration.sourceReason !== intent.sourceReason ||
    migration.sourceUpdatedAt !== intent.sourceUpdatedAt
  ) {
    throw new Error("Legacy GPU safe-mode migration prepared state no longer matches its cleanup intent");
  }

  const timestamp = nowIso(now);
  const nextState = {
    ...state,
    legacySafeModeMigration: {
      ...migration,
      preferenceStatus,
    },
  };

  if (preferenceStatus === "value-changed") {
    nextState.legacySafeModeMigration.status = "cancelled";
    nextState.legacySafeModeMigration.cancelledAt = timestamp;
    delete nextState.safeMode;
    runLegacyGpuMigrationWrite("cancelled GPU state", getGpuStartupStatePath(hanakoHome), () => {
      writeState(hanakoHome, nextState);
    });
    return { status: "cancelled" };
  }

  if (!nextState.autoGpuMode) {
    nextState.autoGpuMode = {
      mode: GPU_MODE_GPU_SANDBOX_COMPAT,
      reason: "legacy-auto-safe-mode-migration",
      previousMode: GPU_MODE_SOFTWARE_SAFE,
      previousStartup: state.safeMode?.previousStartup || null,
      updatedAt: timestamp,
    };
  }
  nextState.legacySafeModeMigration.status = "completed";
  nextState.legacySafeModeMigration.completedAt = timestamp;
  delete nextState.safeMode;
  runLegacyGpuMigrationWrite("completed GPU state", getGpuStartupStatePath(hanakoHome), () => {
    writeState(hanakoHome, nextState);
  });
  return { status: "completed" };
}

function resolveStoredAutoGpuMode(state) {
  const mode = state?.autoGpuMode?.mode;
  if (
    mode === GPU_MODE_GPU_SANDBOX_COMPAT ||
    mode === GPU_MODE_GPU_BACKEND_COMPAT ||
    mode === GPU_MODE_SOFTWARE_SAFE ||
    mode === GPU_MODE_DEEP_COMPAT ||
    mode === GPU_MODE_DIAGNOSTIC_FAILED
  ) {
    return state.autoGpuMode;
  }
  if (state?.safeMode?.enabled) {
    return {
      mode: GPU_MODE_SOFTWARE_SAFE,
      reason: state.safeMode.reason || "legacy-safe-mode",
      previousMode: null,
      previousStartup: state.safeMode.previousStartup || null,
      updatedAt: state.safeMode.updatedAt || null,
    };
  }
  return null;
}

function currentPolicyMode(policy, prefs) {
  if (policy?.mode) return policy.mode;
  if (policy?.shouldApplyGpuBackendCompatSwitches) return GPU_MODE_GPU_BACKEND_COMPAT;
  if (policy?.shouldApplyGpuSandboxCompatSwitches) return GPU_MODE_GPU_SANDBOX_COMPAT;
  if (policy?.shouldApplyDeepCompatSwitches) return GPU_MODE_DEEP_COMPAT;
  if (policy?.shouldDisableHardwareAcceleration) return GPU_MODE_SOFTWARE_SAFE;
  if (!boolFromSetting(prefs?.hardware_acceleration, true)) return GPU_MODE_SOFTWARE_SAFE;
  return GPU_MODE_HARDWARE;
}

function nextModeAfterGpuFailure(mode) {
  if (mode === GPU_MODE_DEEP_COMPAT || mode === GPU_MODE_DIAGNOSTIC_FAILED) {
    return GPU_MODE_DIAGNOSTIC_FAILED;
  }
  if (mode === GPU_MODE_GPU_BACKEND_COMPAT) return GPU_MODE_SOFTWARE_SAFE;
  if (mode === GPU_MODE_GPU_SANDBOX_COMPAT) return GPU_MODE_GPU_BACKEND_COMPAT;
  if (mode === GPU_MODE_SOFTWARE_SAFE) return GPU_MODE_DEEP_COMPAT;
  return GPU_MODE_GPU_SANDBOX_COMPAT;
}

function sanitizeStartupPolicy(policy) {
  if (!policy || typeof policy !== "object") return null;
  return {
    mode: currentPolicyMode(policy, {}),
    reason: policy.reason || "unknown",
    hardwareAccelerationEnabled: policy.hardwareAccelerationEnabled !== false,
    shouldDisableHardwareAcceleration: policy.shouldDisableHardwareAcceleration === true,
    shouldApplyGpuSandboxCompatSwitches: policy.shouldApplyGpuSandboxCompatSwitches === true,
    shouldApplyGpuBackendCompatSwitches: policy.shouldApplyGpuBackendCompatSwitches === true,
    shouldApplyDeepCompatSwitches: policy.shouldApplyDeepCompatSwitches === true,
    shouldApplyUnsafeNoSandboxSwitch: policy.shouldApplyUnsafeNoSandboxSwitch === true,
  };
}

function startupPolicyMode(startup, autoMode, fallbackMode = GPU_MODE_HARDWARE) {
  const mode = startup?.policy?.mode;
  if (
    mode === GPU_MODE_HARDWARE ||
    mode === GPU_MODE_GPU_SANDBOX_COMPAT ||
    mode === GPU_MODE_GPU_BACKEND_COMPAT ||
    mode === GPU_MODE_SOFTWARE_SAFE ||
    mode === GPU_MODE_DEEP_COMPAT ||
    mode === GPU_MODE_DIAGNOSTIC_FAILED
  ) {
    return mode;
  }
  if (autoMode?.mode) return autoMode.mode;
  return fallbackMode;
}

function normalizeGpuRecoveryState(value) {
  if (!value || typeof value !== "object" || typeof value.eligible !== "boolean") return null;
  return {
    eligible: value.eligible === true,
    phase: typeof value.phase === "string" ? value.phase : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function buildGpuRecoveryState(phase, previousGpuRecovery, timestamp) {
  const previous = normalizeGpuRecoveryState(previousGpuRecovery);
  if (GPU_RECOVERY_STARTUP_PHASES.has(phase)) {
    return {
      eligible: true,
      phase,
      updatedAt: timestamp,
    };
  }
  if (NON_GPU_STARTUP_PHASES.has(phase)) {
    if (previous?.eligible && previous.phase && previous.phase !== "electron-starting") {
      return previous;
    }
    return {
      eligible: false,
      phase: null,
      updatedAt: timestamp,
    };
  }
  if (previous?.eligible) return previous;
  return null;
}

function classifyIncompleteStartup(state) {
  const startup = state?.startup;
  if (!startup || startup.status !== "pending") return "none";
  const recovery = normalizeGpuRecoveryState(startup.gpuRecovery);
  if (recovery?.eligible) return "gpu-recovery";
  if (recovery && recovery.eligible === false) return "non-gpu";
  const phase = startup.phase || "electron-starting";
  if (NON_GPU_STARTUP_PHASES.has(phase)) return "non-gpu";
  if (GPU_RECOVERY_STARTUP_PHASES.has(phase)) return "gpu-recovery";
  return "unknown";
}

function isGpuRecoveryIncompleteStartup(state) {
  return classifyIncompleteStartup(state) === "gpu-recovery";
}

function classifyGpuSandboxDiagnostic(state, policy) {
  if (policy?.shouldApplyUnsafeNoSandboxSwitch === true) return "explicit-unsafe-no-sandbox";
  const mode = policy?.mode || state?.autoGpuMode?.mode || null;
  if (mode === GPU_MODE_DIAGNOSTIC_FAILED || state?.autoGpuMode?.mode === GPU_MODE_DIAGNOSTIC_FAILED) {
    return "sandbox-init-failure-suspected";
  }
  return "none";
}

function resolveGpuStartupPolicy({
  hanakoHome,
  platform = process.platform,
  argv = process.argv,
  env = process.env,
  now,
} = {}) {
  if (!hanakoHome) throw new Error("resolveGpuStartupPolicy requires hanakoHome");

  const explicitSafeMode = isExplicitSafeMode(argv, env);
  if (explicitSafeMode) {
    return policyForMode(GPU_MODE_SOFTWARE_SAFE, "explicit");
  }
  const explicitUnsafeNoSandbox = isExplicitUnsafeNoSandbox(argv, env);
  if (explicitUnsafeNoSandbox) {
    return policyForMode(GPU_MODE_GPU_SANDBOX_COMPAT, "explicit-unsafe-no-sandbox", {
      shouldApplyUnsafeNoSandboxSwitch: true,
    });
  }
  const explicitGpuBackendCompatibility = isExplicitGpuBackendCompatibility(argv, env);
  if (explicitGpuBackendCompatibility) {
    return policyForMode(GPU_MODE_GPU_BACKEND_COMPAT, "explicit");
  }
  const explicitGpuSandboxCompatibility = isExplicitGpuSandboxCompatibility(argv, env);
  if (explicitGpuSandboxCompatibility) {
    return policyForMode(GPU_MODE_GPU_SANDBOX_COMPAT, "explicit");
  }

  const state = platform === "win32"
    ? readStateStrict(hanakoHome)
    : readState(hanakoHome);
  const legacyGpuMigrationEvidence = platform === "win32"
    ? legacyGpuChildMigrationEvidence(state) || legacyAutoSafeModeMigrationEvidence(state)
    : null;
  const prefs = legacyGpuMigrationEvidence
    ? readPreferencesStrict(hanakoHome)
    : readPreferences(hanakoHome);
  const preferenceEnabled = boolFromSetting(prefs.hardware_acceleration, true);
  const migratedLegacyGpuChildPolicy = platform === "win32"
    ? migrateLegacyGpuChildSafeMode(hanakoHome, prefs, state, now)
    : null;
  if (migratedLegacyGpuChildPolicy) return migratedLegacyGpuChildPolicy;

  const migratedLegacyPolicy = platform === "win32"
    ? migrateLegacyAutoSafeModePreference(hanakoHome, prefs, state, now)
    : null;
  if (migratedLegacyPolicy) return migratedLegacyPolicy;

  const autoMode = platform === "win32" ? resolveStoredAutoGpuMode(state) : null;
  if (platform === "win32" && isGpuRecoveryIncompleteStartup(state)) {
    const fallbackMode = preferenceEnabled ? GPU_MODE_HARDWARE : GPU_MODE_SOFTWARE_SAFE;
    const previousMode = startupPolicyMode(state.startup, autoMode, fallbackMode);
    const nextMode = nextModeAfterGpuFailure(previousMode);
    writeAutoGpuMode(hanakoHome, nextMode, {
      reason: "previous-startup-incomplete",
      previousMode,
      previousStartup: state.startup,
      now,
    });
    return policyForMode(nextMode, "previous-startup-incomplete");
  }

  if (autoMode?.mode === GPU_MODE_DEEP_COMPAT || autoMode?.mode === GPU_MODE_DIAGNOSTIC_FAILED) {
    return policyForMode(autoMode.mode, autoMode.reason || "gpu-child-process-gone", {
      autoGpuMode: autoMode,
    });
  }

  if (!preferenceEnabled) {
    return policyForMode(GPU_MODE_SOFTWARE_SAFE, "preference");
  }

  if (
    autoMode?.mode === GPU_MODE_GPU_SANDBOX_COMPAT ||
    autoMode?.mode === GPU_MODE_GPU_BACKEND_COMPAT ||
    autoMode?.mode === GPU_MODE_SOFTWARE_SAFE
  ) {
    return policyForMode(autoMode.mode, autoMode.reason || "gpu-child-process-gone", {
      autoGpuMode: autoMode,
    });
  }

  return policyForMode(GPU_MODE_HARDWARE, "default");
}

function featureList(value) {
  return String(value || "")
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
}

function appendMergedFeatureSwitch(app, switchName, features) {
  const commandLine = app?.commandLine;
  if (!commandLine?.appendSwitch) return false;
  let existing = "";
  try {
    if (typeof commandLine.hasSwitch === "function" && commandLine.hasSwitch(switchName)) {
      existing = typeof commandLine.getSwitchValue === "function" ? commandLine.getSwitchValue(switchName) : "";
    }
  } catch {}
  const merged = [];
  const seen = new Set();
  for (const feature of [...featureList(existing), ...features]) {
    if (seen.has(feature)) continue;
    seen.add(feature);
    merged.push(feature);
  }
  commandLine.appendSwitch(switchName, merged.join(","));
  return true;
}

function applyGpuSandboxCompatibilitySwitches(app, policy) {
  const commandLine = app?.commandLine;
  if (!commandLine?.appendSwitch) return { applied: false, unsafeNoSandbox: false };
  commandLine.appendSwitch("disable-gpu-sandbox");
  appendMergedFeatureSwitch(app, "disable-features", GPU_SANDBOX_COMPAT_DISABLE_FEATURES);
  if (policy?.shouldApplyUnsafeNoSandboxSwitch) {
    commandLine.appendSwitch("no-sandbox");
    return { applied: true, unsafeNoSandbox: true };
  }
  return { applied: true, unsafeNoSandbox: false };
}

function applyGpuBackendCompatibilitySwitches(app) {
  const commandLine = app?.commandLine;
  if (!commandLine?.appendSwitch) return { applied: false };
  commandLine.appendSwitch("disable-gpu-sandbox");
  appendMergedFeatureSwitch(app, "disable-features", GPU_BACKEND_COMPAT_DISABLE_FEATURES);
  commandLine.appendSwitch("use-angle", "d3d11");
  commandLine.appendSwitch("disable-direct-composition");
  return { applied: true };
}

function applyGpuStartupPolicy(app, policy) {
  const gpuBackendCompat = policy?.shouldApplyGpuBackendCompatSwitches
    ? applyGpuBackendCompatibilitySwitches(app)
    : { applied: false };
  const gpuSandboxCompat = !gpuBackendCompat.applied && policy?.shouldApplyGpuSandboxCompatSwitches
    ? applyGpuSandboxCompatibilitySwitches(app, policy)
    : { applied: false, unsafeNoSandbox: false };
  if (policy?.shouldDisableHardwareAcceleration && typeof app?.disableHardwareAcceleration === "function") {
    app.disableHardwareAcceleration();
    if (policy?.shouldApplyDeepCompatSwitches && app?.commandLine?.appendSwitch) {
      app.commandLine.appendSwitch("disable-gpu");
      app.commandLine.appendSwitch("disable-gpu-compositing");
      app.commandLine.appendSwitch("disable-gpu-rasterization");
      return {
        applied: true,
        deepCompat: true,
        gpuBackendCompat: gpuBackendCompat.applied,
        gpuSandboxCompat: gpuSandboxCompat.applied,
        unsafeNoSandbox: gpuSandboxCompat.unsafeNoSandbox,
      };
    }
    return {
      applied: true,
      deepCompat: false,
      gpuBackendCompat: gpuBackendCompat.applied,
      gpuSandboxCompat: gpuSandboxCompat.applied,
      unsafeNoSandbox: gpuSandboxCompat.unsafeNoSandbox,
    };
  }
  return {
    applied: gpuBackendCompat.applied || gpuSandboxCompat.applied,
    gpuBackendCompat: gpuBackendCompat.applied,
    gpuSandboxCompat: gpuSandboxCompat.applied,
    unsafeNoSandbox: gpuSandboxCompat.unsafeNoSandbox,
  };
}

function markGpuStartupPending({
  hanakoHome,
  platform = process.platform,
  phase = "electron-starting",
  startupId = `${Date.now()}-${process.pid}`,
  policy = null,
  now,
} = {}) {
  if (!hanakoHome) throw new Error("markGpuStartupPending requires hanakoHome");
  const timestamp = nowIso(now);
  const state = readState(hanakoHome);
  const startupPolicy = sanitizeStartupPolicy(policy);
  const gpuRecovery = buildGpuRecoveryState(phase, null, timestamp);
  const next = {
    ...state,
    startup: {
      status: "pending",
      startupId,
      phase,
      platform,
      startedAt: timestamp,
      updatedAt: timestamp,
      ...(startupPolicy ? { policy: startupPolicy } : {}),
      ...(gpuRecovery ? { gpuRecovery } : {}),
    },
  };
  writeState(hanakoHome, next);
  return next.startup;
}

function markGpuStartupPhase({
  hanakoHome,
  platform = process.platform,
  phase,
  startupId,
  now,
} = {}) {
  if (!hanakoHome || !phase) return null;
  const state = readState(hanakoHome);
  if (!state.startup || state.startup.status !== "pending") return null;
  if (startupId && state.startup.startupId && state.startup.startupId !== startupId) return null;
  const timestamp = nowIso(now);
  const gpuRecovery = buildGpuRecoveryState(phase, state.startup.gpuRecovery, timestamp);
  state.startup = {
    ...state.startup,
    startupId: startupId || state.startup.startupId,
    platform,
    phase,
    updatedAt: timestamp,
  };
  if (gpuRecovery) {
    state.startup.gpuRecovery = gpuRecovery;
  } else {
    delete state.startup.gpuRecovery;
  }
  writeState(hanakoHome, state);
  return state.startup;
}

function markGpuStartupReady({
  hanakoHome,
  platform = process.platform,
  phase = "app-ready",
  startupId,
  now,
} = {}) {
  if (!hanakoHome) throw new Error("markGpuStartupReady requires hanakoHome");
  const state = readState(hanakoHome);
  const timestamp = nowIso(now);
  state.startup = {
    ...(state.startup || {}),
    status: "ready",
    startupId: startupId || state.startup?.startupId,
    phase,
    platform,
    readyAt: timestamp,
    updatedAt: timestamp,
  };
  writeState(hanakoHome, state);
  return state.startup;
}

function markGpuStartupFailed({
  hanakoHome,
  platform = process.platform,
  reason,
  startupId,
  now,
} = {}) {
  if (!hanakoHome) throw new Error("markGpuStartupFailed requires hanakoHome");
  const state = readState(hanakoHome);
  const timestamp = nowIso(now);
  state.startup = {
    ...(state.startup || {}),
    status: "failed",
    startupId: startupId || state.startup?.startupId,
    platform,
    reason: reason || "startup-failed",
    failedAt: timestamp,
    updatedAt: timestamp,
  };
  writeState(hanakoHome, state);
  return state.startup;
}

function sanitizeGpuDetails(details = {}) {
  return {
    type: details.type || "Unknown",
    reason: details.reason || "unknown",
    exitCode: typeof details.exitCode === "number" ? details.exitCode : null,
    serviceName: details.serviceName || "",
    name: details.name || "",
  };
}

function isGpuChildProcessFailure(details = {}) {
  return details.type === "GPU" && GPU_FAILURE_REASONS.has(details.reason || "unknown");
}

function recordGpuChildProcessGone({
  hanakoHome,
  platform = process.platform,
  policy = null,
  details,
  now,
} = {}) {
  if (!hanakoHome || !isGpuChildProcessFailure(details)) return false;
  const timestamp = nowIso(now);
  const crash = {
    ...sanitizeGpuDetails(details),
    platform,
    at: timestamp,
  };
  const state = readState(hanakoHome);
  const prefs = readPreferences(hanakoHome);
  const previousMode = currentPolicyMode(policy, prefs);
  const nextMode = nextModeAfterGpuFailure(previousMode);
  writeState(hanakoHome, {
    ...state,
    autoGpuMode: {
      mode: nextMode,
      reason: "gpu-child-process-gone",
      previousMode,
      updatedAt: timestamp,
    },
    lastGpuCrash: crash,
  });
  return true;
}

function recordGpuInfoUpdate({
  hanakoHome,
  platform = process.platform,
  featureStatus,
  now,
} = {}) {
  if (!hanakoHome || !featureStatus || typeof featureStatus !== "object") return false;
  const state = readState(hanakoHome);
  writeState(hanakoHome, {
    ...state,
    lastGpuFeatureStatus: {
      platform,
      at: nowIso(now),
      featureStatus,
    },
  });
  return true;
}

const GPU_MODE_DEPTH = {
  [GPU_MODE_HARDWARE]: 0,
  [GPU_MODE_GPU_SANDBOX_COMPAT]: 1,
  [GPU_MODE_GPU_BACKEND_COMPAT]: 2,
  [GPU_MODE_SOFTWARE_SAFE]: 3,
  [GPU_MODE_DEEP_COMPAT]: 4,
  [GPU_MODE_DIAGNOSTIC_FAILED]: 5,
};

function getGpuRecoveryEvidence(hanakoHome) {
  if (!hanakoHome) throw new Error("getGpuRecoveryEvidence requires hanakoHome");
  const state = readState(hanakoHome);
  return {
    autoGpuMode: state.autoGpuMode || null,
    latestCrashAt: state.lastGpuCrash?.at || null,
    startup: state.startup
      ? {
          status: state.startup.status || null,
          startedAt: state.startup.startedAt || null,
          readyAt: state.startup.readyAt || null,
          policyMode: state.startup.policy?.mode || null,
        }
      : null,
    incompleteClassification: classifyIncompleteStartup(state),
  };
}

function clearAutoGpuModeForRecovery({ hanakoHome, reason, now } = {}) {
  if (!hanakoHome) throw new Error("clearAutoGpuModeForRecovery requires hanakoHome");
  const state = readState(hanakoHome);
  const clearedMode = state.autoGpuMode?.mode || null;
  const stalePendingIsGpuEvidence =
    state.startup?.status === "pending" && classifyIncompleteStartup(state) === "gpu-recovery";
  if (!clearedMode && !stalePendingIsGpuEvidence) {
    return { cleared: false, clearedMode: null };
  }
  const next = { ...state };
  delete next.autoGpuMode;
  let clearedPendingPhase = null;
  if (stalePendingIsGpuEvidence) {
    clearedPendingPhase = state.startup.phase || null;
    delete next.startup;
  }
  next.lastGpuRecovery = {
    reason: reason || "unknown",
    clearedMode,
    clearedPendingPhase,
    at: nowIso(now),
  };
  writeState(hanakoHome, next);
  return { cleared: true, clearedMode };
}

function restoreDeeperAutoGpuMode({ hanakoHome, mode, reason, now } = {}) {
  if (!hanakoHome) throw new Error("restoreDeeperAutoGpuMode requires hanakoHome");
  if (!(mode in GPU_MODE_DEPTH)) throw new Error(`restoreDeeperAutoGpuMode received unknown GPU mode: ${mode}`);
  const state = readState(hanakoHome);
  const currentMode = state.autoGpuMode?.mode && state.autoGpuMode.mode in GPU_MODE_DEPTH
    ? state.autoGpuMode.mode
    : GPU_MODE_HARDWARE;
  if (GPU_MODE_DEPTH[mode] <= GPU_MODE_DEPTH[currentMode]) {
    return { restored: false, currentMode };
  }
  const next = { ...state };
  if (next.startup?.status === "pending" && classifyIncompleteStartup(state) === "gpu-recovery") {
    delete next.startup;
  }
  next.autoGpuMode = {
    mode,
    reason: reason || "acl-heal-ineffective",
    previousMode: currentMode,
    updatedAt: nowIso(now),
  };
  writeState(hanakoHome, next);
  return { restored: true, currentMode: mode };
}

function buildGpuStartupDiagnostics({ hanakoHome, policy, app } = {}) {
  const items = [
    ``,
    `--- GPU Startup ---`,
    `Hardware acceleration preference: ${readPreferences(hanakoHome).hardware_acceleration ?? "default"}`,
    `Startup policy: ${policy?.reason || "unknown"}`,
    `Startup policy mode: ${policy?.mode || "unknown"}`,
    `GPU sandbox compatibility switches enabled: ${policy?.shouldApplyGpuSandboxCompatSwitches === true}`,
    `GPU backend compatibility switches enabled: ${policy?.shouldApplyGpuBackendCompatSwitches === true}`,
    `GPU sandbox disabled by policy: ${policy?.shouldApplyGpuSandboxCompatSwitches === true || policy?.shouldApplyGpuBackendCompatSwitches === true}`,
    `Deep compatibility switches enabled: ${policy?.shouldApplyDeepCompatSwitches === true}`,
    `Unsafe no-sandbox diagnostic enabled: ${policy?.shouldApplyUnsafeNoSandboxSwitch === true}`,
    `Hardware acceleration enabled by policy: ${policy?.hardwareAccelerationEnabled !== false}`,
  ];
  try {
    if (app && typeof app.isHardwareAccelerationEnabled === "function") {
      items.push(`Electron hardware acceleration enabled: ${app.isHardwareAccelerationEnabled()}`);
    }
  } catch {}
  try {
    if (app && typeof app.getGPUFeatureStatus === "function") {
      items.push(`GPU feature status: ${JSON.stringify(app.getGPUFeatureStatus())}`);
    }
  } catch {}
  const state = readState(hanakoHome);
  items.push(`Incomplete startup classification: ${classifyIncompleteStartup(state)}`);
  items.push(`GPU sandbox diagnostic classification: ${classifyGpuSandboxDiagnostic(state, policy)}`);
  items.push(`Unsafe no-sandbox note: only enabled by --hana-gpu-unsafe-no-sandbox for one diagnostic launch`);
  if (state.startup) items.push(`GPU startup marker: ${JSON.stringify(state.startup)}`);
  if (state.autoGpuMode) items.push(`GPU auto mode: ${JSON.stringify(state.autoGpuMode)}`);
  if (state.safeMode) items.push(`GPU safe mode: ${JSON.stringify(state.safeMode)}`);
  if (state.lastGpuCrash) items.push(`Last GPU crash: ${JSON.stringify(state.lastGpuCrash)}`);
  if (state.lastGpuFeatureStatus) {
    items.push(`Last GPU feature status: ${JSON.stringify(state.lastGpuFeatureStatus)}`);
  }
  return items.join("\n");
}

module.exports = {
  applyGpuStartupPolicy,
  buildGpuStartupDiagnostics,
  clearAutoGpuModeForRecovery,
  getGpuRecoveryEvidence,
  getGpuStartupStatePath,
  getPreferencesPath,
  markGpuStartupFailed,
  markGpuStartupPending,
  markGpuStartupPhase,
  markGpuStartupReady,
  recordGpuChildProcessGone,
  recordGpuInfoUpdate,
  resolveGpuStartupPolicy,
  restoreDeeperAutoGpuMode,
  settleLegacyGpuPreferenceMigration,
};
