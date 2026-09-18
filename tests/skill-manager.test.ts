import { describe, expect, it, beforeEach } from "vitest";
import path from "path";
import { SkillManager, __test } from "../core/skill-manager.ts";

function makeAgent(id, enabled = [], workspaceContext = undefined) {
  return { id, config: { skills: { enabled }, workspace_context: workspaceContext } };
}

function makeSkill(name, overrides = {}) {
  return { name, source: "user", description: `${name} skill`, filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}`, _hidden: false, _readonly: false, ...overrides };
}

describe("SkillManager._skillsVisibleToAgent", () => {
  let sm;

  beforeEach(() => {
    sm = new SkillManager({ skillsDir: "/tmp/hana-test-skills" });
  });

  it("returns global skills for any agent", () => {
    sm._allSkills = [makeSkill("pdf"), makeSkill("docx")];
    const agentA = makeAgent("agent-a");
    expect(sm._skillsVisibleToAgent(agentA).map(s => s.name)).toEqual(["pdf", "docx"]);
  });

  it("does not use legacy _agentId fields as a skill source boundary", () => {
    sm._allSkills = [
      makeSkill("global-skill"),
      makeSkill("migrated-a", { _agentId: "agent-a" }),
      makeSkill("migrated-b", { _agentId: "agent-b" }),
    ];
    const agentA = makeAgent("agent-a");
    const agentB = makeAgent("agent-b");

    const visibleA = sm._skillsVisibleToAgent(agentA).map(s => s.name);
    const visibleB = sm._skillsVisibleToAgent(agentB).map(s => s.name);

    expect(visibleA).toEqual(["global-skill", "migrated-a", "migrated-b"]);
    expect(visibleB).toEqual(["global-skill", "migrated-a", "migrated-b"]);
  });

  it("excludes plugin skills by default", () => {
    sm._allSkills = [makeSkill("pdf"), makeSkill("plugin-x", { _pluginSkill: true })];
    expect(sm._skillsVisibleToAgent(makeAgent("a")).map(s => s.name)).toEqual(["pdf"]);
  });

  it("includes plugin skills when requested", () => {
    sm._allSkills = [makeSkill("pdf"), makeSkill("plugin-x", { _pluginSkill: true })];
    expect(sm._skillsVisibleToAgent(makeAgent("a"), { includePlugin: true }).map(s => s.name)).toEqual(["pdf", "plugin-x"]);
  });

  it("excludes workspace skills by default", () => {
    sm._allSkills = [makeSkill("pdf"), makeSkill("ws-skill", { _workspaceSkill: true })];
    expect(sm._skillsVisibleToAgent(makeAgent("a")).map(s => s.name)).toEqual(["pdf"]);
  });

  it("includes workspace skills when requested", () => {
    sm._allSkills = [makeSkill("pdf"), makeSkill("ws-skill", { _workspaceSkill: true })];
    expect(sm._skillsVisibleToAgent(makeAgent("a"), { includeWorkspace: true }).map(s => s.name)).toEqual(["pdf", "ws-skill"]);
  });
});

describe("SkillManager.getAllSkills", () => {
  let sm;

  beforeEach(() => {
    sm = new SkillManager({ skillsDir: "/tmp/hana-test-skills" });
    sm._allSkills = [
      makeSkill("global-skill"),
      makeSkill("migrated-skill", { _agentId: "agent-b" }),
      makeSkill("plugin-x", { _pluginSkill: true }),
      makeSkill("ws-skill", { _workspaceSkill: true }),
    ];
  });

  it("returns global skill-pool entries regardless of source agent", () => {
    const result = sm.getAllSkills(makeAgent("agent-a", ["global-skill"]));
    const names = result.map(s => s.name);
    expect(names).toContain("global-skill");
    expect(names).toContain("migrated-skill");
  });

  it("excludes plugin and workspace skills", () => {
    const result = sm.getAllSkills(makeAgent("agent-a"));
    const names = result.map(s => s.name);
    expect(names).not.toContain("plugin-x");
    expect(names).not.toContain("ws-skill");
  });
});

describe("SkillManager.getRuntimeSkillInfos", () => {
  let sm;

  beforeEach(() => {
    sm = new SkillManager({ skillsDir: "/tmp/hana-test-skills" });
    sm._allSkills = [
      makeSkill("global-skill"),
      makeSkill("ws-skill", { _workspaceSkill: true }),
    ];
  });

  it("marks global skills enabled from the agent config", () => {
    const result = sm.getRuntimeSkillInfos(makeAgent("agent-a", ["global-skill"]));
    const globalSkill = result.find(s => s.name === "global-skill");
    expect(globalSkill?.enabled).toBe(true);
  });

  it("includes workspace skills", () => {
    const result = sm.getRuntimeSkillInfos(makeAgent("agent-a"));
    expect(result.map(s => s.name)).toContain("ws-skill");
  });

  it("applies the two workspace source switches independently", () => {
    sm._allSkills = [
      makeSkill("standard", { _workspaceSkill: true, _workspaceSkillCategory: "standard", _externalLabel: "Agents" }),
      makeSkill("compatible", { _workspaceSkill: true, _workspaceSkillCategory: "compatible", _externalLabel: "Codex" }),
    ];

    const defaultInfos = sm.getRuntimeSkillInfos(makeAgent("default"));
    expect(defaultInfos.find(s => s.name === "standard")).toMatchObject({ active: true, enabled: true });
    expect(defaultInfos.find(s => s.name === "compatible")).toMatchObject({ active: false, enabled: false, inactiveReason: "policy-disabled" });

    const compatibleOnly = sm.getRuntimeSkillInfos(makeAgent("compatible", [], {
      discover_project_skills: false,
      discover_compatible_project_skills: true,
    }));
    expect(compatibleOnly.find(s => s.name === "standard")).toMatchObject({ active: false, inactiveReason: "policy-disabled" });
    expect(compatibleOnly.find(s => s.name === "compatible")).toMatchObject({ active: true, enabled: true });
  });

  it("keeps .agents authoritative while reporting compatible same-name candidates as shadowed", () => {
    sm._allSkills = [
      makeSkill("shared", {
        _workspaceSkill: true,
        _workspaceSkillCategory: "standard",
        _externalLabel: "Agents",
        sourceIdentity: { owner: "workspace", filePath: "/repo/.agents/skills/shared/SKILL.md" },
      }),
      makeSkill("shared", {
        _workspaceSkill: true,
        _workspaceSkillCategory: "compatible",
        _externalLabel: "Codex",
        sourceIdentity: { owner: "workspace", filePath: "/repo/.codex/skills/shared/SKILL.md" },
      }),
    ];
    const agent = makeAgent("agent-a", [], {
      discover_project_skills: true,
      discover_compatible_project_skills: true,
    });

    const infos = sm.getRuntimeSkillInfos(agent).filter(s => s.name === "shared");
    expect(infos).toHaveLength(2);
    expect(infos[0]).toMatchObject({ externalLabel: "Agents", active: true, shadowed: false });
    expect(infos[1]).toMatchObject({ externalLabel: "Codex", active: false, shadowed: true });
    expect(infos[1].shadowedBy).toMatchObject({ filePath: "/repo/.agents/skills/shared/SKILL.md" });
    expect(sm.getSkillsForAgent(agent).skills.map(s => s.filePath)).toEqual(["/skills/shared/SKILL.md"]);
  });

  it("allows a compatible same-name source when standard project skills are disabled", () => {
    sm._allSkills = [
      makeSkill("shared", { filePath: "/repo/.agents/skills/shared/SKILL.md", _workspaceSkill: true, _workspaceSkillCategory: "standard", _externalLabel: "Agents" }),
      makeSkill("shared", { filePath: "/repo/.codex/skills/shared/SKILL.md", _workspaceSkill: true, _workspaceSkillCategory: "compatible", _externalLabel: "Codex" }),
    ];
    const agent = makeAgent("agent-a", [], {
      discover_project_skills: false,
      discover_compatible_project_skills: true,
    });

    expect(sm.getSkillsForAgent(agent).skills.map(s => s.filePath)).toEqual([
      "/repo/.codex/skills/shared/SKILL.md",
    ]);
  });
});

describe("SkillManager.syncAgentSkills", () => {
  let sm;

  beforeEach(() => {
    sm = new SkillManager({ skillsDir: "/tmp/hana-test-skills" });
    sm._allSkills = [
      makeSkill("shared-name", { source: "user" }),
      makeSkill("plugin-x", { _pluginSkill: true }),
      makeSkill("ws-skill", { _workspaceSkill: true }),
    ];
  });

  it("injects enabled global skills and runtime-only plugin/workspace skills", () => {
    let injected = [];
    const fakeAgent = {
      id: "agent-a",
      config: { skills: { enabled: ["shared-name"] } },
      setEnabledSkills(skills) { injected = skills; },
    };
    sm.syncAgentSkills(fakeAgent);

    expect(injected.map(s => s.name)).toEqual(["shared-name", "plugin-x", "ws-skill"]);
  });

  it("does not build prompts for config-only agents during global skill sync", () => {
    const fakeAgent = {
      id: "agent-a",
      runtimeInitialized: false,
      config: { skills: { enabled: ["shared-name"] } },
      setEnabledSkills() {
        throw new Error("config-only agent should not be synced");
      },
    };

    expect(() => sm.syncAgentSkills(fakeAgent)).not.toThrow();
  });

  it("does not build prompts for agents that need config repair", () => {
    const fakeAgent = {
      id: "agent-a",
      runtimeInitialized: true,
      needsRepair: true,
      config: { skills: { enabled: ["shared-name"] } },
      setEnabledSkills() {
        throw new Error("repair agent should not be synced");
      },
    };

    expect(() => sm.syncAgentSkills(fakeAgent)).not.toThrow();
  });
});

describe("SkillManager.getSkillsForAgent", () => {
  let sm;

  beforeEach(() => {
    sm = new SkillManager({ skillsDir: "/tmp/hana-test-skills" });
    sm._allSkills = [
      makeSkill("global-skill"),
      makeSkill("plugin-x", { _pluginSkill: true }),
    ];
  });

  it("includes enabled global skills and plugins", () => {
    const agentA = makeAgent("agent-a", ["global-skill", "plugin-x"]);
    const result = sm.getSkillsForAgent(agentA);
    const names = result.skills.map(s => s.name);
    expect(names).toContain("global-skill");
    expect(names).toContain("plugin-x");
  });
});

describe("SkillManager.computeDefaultEnabledForNewAgent", () => {
  let sm;

  beforeEach(() => {
    sm = new SkillManager({ skillsDir: "/tmp/hana-test-skills" });
  });

  it("includes user source skills", () => {
    sm._allSkills = [
      { name: "pdf", source: "user" },
      { name: "docx", source: "user" },
    ];
    expect(sm.computeDefaultEnabledForNewAgent()).toEqual(["pdf", "docx"]);
  });

  it("includes migrated user skills when they do not opt out", () => {
    sm._allSkills = [
      { name: "pdf", source: "user" },
      { name: "migrated-skill", source: "user" },
    ];
    expect(sm.computeDefaultEnabledForNewAgent()).toEqual(["pdf", "migrated-skill"]);
  });

  it("excludes external source skills (covers plugin and workspace sub-categories)", () => {
    sm._allSkills = [
      { name: "pdf", source: "user" },
      { name: "ext-plain", source: "external" },
      { name: "plugin-skill", source: "external", _pluginSkill: true },
      { name: "workspace-skill", source: "external", _workspaceSkill: true },
    ];
    expect(sm.computeDefaultEnabledForNewAgent()).toEqual(["pdf"]);
  });

  it("excludes skills that opt out of default enablement", () => {
    sm._allSkills = [
      { name: "pdf", source: "user" },
      { name: "hana-plugin-creator", source: "user", defaultEnabled: false },
    ];
    expect(sm.computeDefaultEnabledForNewAgent()).toEqual(["pdf"]);
  });

  it("returns empty array when _allSkills is empty", () => {
    sm._allSkills = [];
    expect(sm.computeDefaultEnabledForNewAgent()).toEqual([]);
  });

  it("preserves skill order from _allSkills", () => {
    sm._allSkills = [
      { name: "a", source: "user" },
      { name: "b", source: "user", defaultEnabled: false },
      { name: "c", source: "user" },
    ];
    expect(sm.computeDefaultEnabledForNewAgent()).toEqual(["a", "c"]);
  });
});

describe("createSkillWatchIgnore", () => {
  const root = path.resolve("/tmp/skills-root");
  const ignore = __test.createSkillWatchIgnore(root);

  it("does not ignore the root itself", () => {
    expect(ignore(root)).toBe(false);
  });

  it("does not ignore normal skill files", () => {
    expect(ignore(path.join(root, "my-skill", "SKILL.md"))).toBe(false);
    expect(ignore(path.join(root, "my-skill", "references", "guide.md"))).toBe(false);
  });

  it("ignores dot-prefixed files and directories below the root", () => {
    expect(ignore(path.join(root, ".DS_Store"))).toBe(true);
    expect(ignore(path.join(root, "my-skill", ".git", "HEAD"))).toBe(true);
    expect(ignore(path.join(root, "my-skill", ".cache", "x"))).toBe(true);
  });

  it("ignores editor temp files", () => {
    expect(ignore(path.join(root, "skill.md~"))).toBe(true);
    expect(ignore(path.join(root, "#skill.md#"))).toBe(true);
  });

  it("ignores heavy directory names inside a skill (root cause of #765 / #787)", () => {
    for (const heavy of ["node_modules", "target", "build", "dist", "out", "__pycache__", "coverage", "venv", ".venv"]) {
      expect(ignore(path.join(root, "skill", heavy, "anything"))).toBe(true);
      expect(ignore(path.join(root, "skill", "nested", heavy, "deep", "x"))).toBe(true);
    }
  });

  it("does not ignore skill files that merely mention heavy names", () => {
    expect(ignore(path.join(root, "node_modules-loader-skill", "SKILL.md"))).toBe(false);
    expect(ignore(path.join(root, "skill", "build-config.md"))).toBe(false);
  });

  it("does NOT ignore a skill whose name happens to equal a heavy dir name", () => {
    // First-level segment is the skill name itself — never treat it as heavy,
    // otherwise a legit skill literally named "build" / "dist" / "target" gets
    // dropped from the watcher and edits never trigger reload.
    for (const heavy of ["build", "dist", "target", "out", "coverage"]) {
      expect(ignore(path.join(root, heavy, "SKILL.md"))).toBe(false);
      expect(ignore(path.join(root, heavy, "references", "guide.md"))).toBe(false);
    }
  });

  it("still skips heavy dirs nested inside a heavy-named skill", () => {
    // <root>/build/ is a legit skill, but <root>/build/node_modules/ inside it
    // is still a dependency tree that must be skipped.
    expect(ignore(path.join(root, "build", "node_modules", "react", "index.js"))).toBe(true);
    expect(ignore(path.join(root, "dist", "target", "release", "x"))).toBe(true);
  });
});

describe("SKILL_WATCH_DEPTH", () => {
  it("limits chokidar recursion to a sane skill tree depth", () => {
    expect(__test.SKILL_WATCH_DEPTH).toBeGreaterThanOrEqual(2);
    expect(__test.SKILL_WATCH_DEPTH).toBeLessThanOrEqual(5);
  });
});
