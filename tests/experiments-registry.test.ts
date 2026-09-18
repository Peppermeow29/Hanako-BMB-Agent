import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.ts";
import {
  CACHE_SNAPSHOT_EXPERIMENT_ID,
  COMPACTION_MODE_EXPERIMENT_ID,
  DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID,
  INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID,
  getExperimentDefinitions,
  getResolvedExperimentValue,
  listResolvedExperiments,
  setExperimentValue,
} from "../lib/experiments/registry.ts";

function makePrefs(initialPrefs: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-experiments-"));
  const userDir = path.join(root, "user");
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "preferences.json"), JSON.stringify(initialPrefs, null, 2) + "\n");
  return { root, prefs: new PreferencesManager({ userDir, agentsDir }) };
}

describe("experiment registry", () => {
  it("does not expose retired cache snapshot reflection in active experiment lists", () => {
    const { prefs } = makePrefs({
      experiments: {
        [CACHE_SNAPSHOT_EXPERIMENT_ID]: "shadow",
        [DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID]: true,
      },
    });

    expect(getExperimentDefinitions().map((def) => def.id)).not.toContain(CACHE_SNAPSHOT_EXPERIMENT_ID);
    expect(listResolvedExperiments(prefs).map((def) => def.id)).not.toContain(CACHE_SNAPSHOT_EXPERIMENT_ID);
    expect(prefs.getPreferences().experiments).toEqual({
      [DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID]: true,
    });
  });

  it("keeps compaction mode as a three-option select and defines instant compaction as a separate toggle", () => {
    const defs = getExperimentDefinitions();
    const entry = defs.find((def) => def.id === COMPACTION_MODE_EXPERIMENT_ID);
    const instant = defs.find((def) => def.id === INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID);

    expect(entry).toMatchObject({
      id: COMPACTION_MODE_EXPERIMENT_ID,
      owner: "session",
      scope: "global",
      defaultValue: "auto",
      valueSchema: {
        type: "enum",
        presentation: { type: "select" },
      },
    });
    expect(entry.valueSchema.options.map((opt) => opt.value)).toEqual([
      "auto",
      "cache_preserving",
      "pi_compatible",
    ]);
    expect(instant).toMatchObject({
      id: INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID,
      owner: "session",
      scope: "global",
      defaultValue: false,
      valueSchema: {
        type: "boolean",
        presentation: { type: "toggle" },
      },
    });
  });

  it("defines the DeepSeek roleplay reasoning patch as a boolean toggle defaulting to off", () => {
    const defs = getExperimentDefinitions();
    const entry = defs.find((def) => def.id === DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID);

    expect(entry).toMatchObject({
      id: DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID,
      owner: "provider",
      scope: "global",
      defaultValue: false,
      valueSchema: {
        type: "boolean",
        presentation: { type: "toggle" },
      },
    });
  });

  it("does not expose ResourceIO as a runtime experiment because file tools always use ResourceIO", () => {
    const ids = getExperimentDefinitions().map((def) => def.id);

    expect(ids).not.toContain("tools.resource_io");
  });

  it("does not leave stale ResourceIO experiment copy in settings locales", () => {
    for (const locale of ["en", "zh"]) {
      const source = fs.readFileSync(path.join(process.cwd(), "desktop", "src", "locales", `${locale}.json`), "utf-8");

      expect(source).not.toContain("resourceIoTools");
      expect(source).not.toContain("tools.resource_io");
    }
  });

  it("rejects unknown experiment ids without writing preferences", () => {
    const { prefs } = makePrefs();

    expect(() => setExperimentValue(prefs, "unknown.flag", true)).toThrow("unknown experiment id");
    expect(prefs.getPreferences().experiments).toBeUndefined();
  });

  it("hard-disables retired cache snapshot reflection values", () => {
    const { prefs } = makePrefs({
      experiments: {
        [CACHE_SNAPSHOT_EXPERIMENT_ID]: "write",
        [COMPACTION_MODE_EXPERIMENT_ID]: "cache_preserving",
      },
    });

    expect(getResolvedExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID)).toBe("off");
    expect(prefs.getPreferences().experiments).toEqual({
      [COMPACTION_MODE_EXPERIMENT_ID]: "cache_preserving",
    });

    expect(setExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID, "shadow")).toBe("off");
    expect(getResolvedExperimentValue(prefs, CACHE_SNAPSHOT_EXPERIMENT_ID)).toBe("off");
    expect(prefs.getPreferences().experiments).toEqual({
      [COMPACTION_MODE_EXPERIMENT_ID]: "cache_preserving",
    });
  });

  it("persists and resolves valid active global enum values", () => {
    const { prefs } = makePrefs();

    expect(getResolvedExperimentValue(prefs, COMPACTION_MODE_EXPERIMENT_ID)).toBe("auto");
    expect(setExperimentValue(prefs, COMPACTION_MODE_EXPERIMENT_ID, "pi_compatible")).toBe("pi_compatible");
    expect(getResolvedExperimentValue(prefs, COMPACTION_MODE_EXPERIMENT_ID)).toBe("pi_compatible");
    expect(prefs.getPreferences().experiments[COMPACTION_MODE_EXPERIMENT_ID]).toBe("pi_compatible");
  });

  it("persists and resolves valid global boolean values", () => {
    const { prefs } = makePrefs();

    expect(getResolvedExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID)).toBe(false);
    expect(setExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID, true)).toBe(true);
    expect(getResolvedExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID)).toBe(true);
    expect(prefs.getPreferences().experiments[DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID]).toBe(true);
    expect(setExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID, false)).toBe(false);
    expect(getResolvedExperimentValue(prefs, DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID)).toBe(false);
  });

  it("migrates the briefly persisted lossy mode into Auto plus an enabled one-shot entry", () => {
    const { prefs } = makePrefs({
      experiments: {
        [COMPACTION_MODE_EXPERIMENT_ID]: "lossy_local",
      },
    });

    expect(getResolvedExperimentValue(prefs, COMPACTION_MODE_EXPERIMENT_ID)).toBe("auto");
    expect(getResolvedExperimentValue(prefs, INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID)).toBe(true);

    expect(setExperimentValue(prefs, INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID, false)).toBe(false);
    expect(getResolvedExperimentValue(prefs, INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID)).toBe(false);
  });

  it("rejects invalid enum values", () => {
    const { prefs } = makePrefs();

    expect(() => setExperimentValue(prefs, COMPACTION_MODE_EXPERIMENT_ID, "maybe")).toThrow("invalid experiment value");
    expect(getResolvedExperimentValue(prefs, COMPACTION_MODE_EXPERIMENT_ID)).toBe("auto");
  });
});
