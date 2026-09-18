import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { HanaEngine } from "../core/engine.ts";
import { SettingsManager } from "../lib/pi-sdk/index.ts";

describe("HanaEngine resource loader options", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it("uses explicit Hana-owned Pi SDK cwd, agentDir, and in-memory Pi settings", () => {
    const settings = { kind: "in-memory-settings" };
    const inMemory = vi.spyOn(SettingsManager, "inMemory").mockReturnValue(settings as any);
    const engine = Object.create(HanaEngine.prototype);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-resource-loader-options-"));
    engine.hanakoHome = path.join(tempRoot, "hanako-home");
    engine._agentMgr = {
      activeAgentId: "agent-a",
      agent: {
        agentDir: path.join(engine.hanakoHome, "agents", "agent-a"),
        systemPrompt: "agent prompt",
      },
    };
    engine.getHomeCwd = vi.fn(() => "/workspace-a");

    const skillsDir = path.join(engine.hanakoHome, "skills");
    const options = engine._createResourceLoaderOptions(skillsDir);

    expect(options).toMatchObject({
      cwd: path.join(engine.hanakoHome, "runtime", "pi-sdk", "resource-loader", "project"),
      agentDir: path.join(engine.hanakoHome, "runtime", "pi-sdk", "resource-loader", "agent"),
      settingsManager: settings,
      noContextFiles: true,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [skillsDir],
    });
    expect(fs.existsSync(path.join(engine.hanakoHome, "runtime"))).toBe(false);
    expect(options.agentsFilesOverride()).toEqual({ agentsFiles: [] });
    expect(options.systemPromptOverride()).toBe("agent prompt");
    expect(options.appendSystemPromptOverride(["from-pi"])).toEqual([]);
    expect(engine.getHomeCwd).not.toHaveBeenCalled();
    expect(inMemory).toHaveBeenCalledTimes(1);
  });
});
