import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  resolveWorkspaceSkillCatalogPaths,
  resolveWorkspaceSkillPaths,
  workspaceSkillPolicyFromConfig,
  WORKSPACE_SKILL_DIRS,
} from "../shared/workspace-skill-paths.ts";

describe("workspace skill path discovery", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the all-known catalog separate from the default active roots", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hana-workspace-skills-"));
    roots.push(workspace);
    fs.mkdirSync(path.join(workspace, ".pi", "skills"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".agents", "skills"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".claude", "skills"), { recursive: true });

    fs.mkdirSync(path.join(workspace, ".codex", "skills"), { recursive: true });

    const catalog = resolveWorkspaceSkillCatalogPaths(workspace).map((entry) => path.relative(workspace, entry.dirPath));
    const active = resolveWorkspaceSkillPaths(workspace).map((entry) => path.relative(workspace, entry.dirPath));

    expect(catalog).toEqual([
      path.join(".agents", "skills"),
      path.join(".claude", "skills"),
      path.join(".codex", "skills"),
    ]);
    expect(active).toEqual([path.join(".agents", "skills")]);
    expect(catalog).not.toContain(path.join(".pi", "skills"));
  });

  it.each([
    [{ discover_project_skills: false, discover_compatible_project_skills: false }, []],
    [{ discover_project_skills: true, discover_compatible_project_skills: false }, [".agents/skills"]],
    [{ discover_project_skills: false, discover_compatible_project_skills: true }, [".claude/skills", ".codex/skills", ".openclaw/skills"]],
    [{ discover_project_skills: true, discover_compatible_project_skills: true }, [".agents/skills", ".claude/skills", ".codex/skills", ".openclaw/skills"]],
  ])("resolves the two switches independently for %j", (workspaceContext, expected) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hana-workspace-skills-"));
    roots.push(workspace);
    for (const entry of WORKSPACE_SKILL_DIRS) {
      fs.mkdirSync(path.join(workspace, entry.sub), { recursive: true });
    }

    const policy = workspaceSkillPolicyFromConfig(workspaceContext);
    const paths = resolveWorkspaceSkillPaths(workspace, policy)
      .map((entry) => path.relative(workspace, entry.dirPath).split(path.sep).join("/"));

    expect(paths).toEqual(expected);
  });

  it("uses true/false read defaults for legacy Agent configs", () => {
    expect(workspaceSkillPolicyFromConfig(undefined)).toEqual({
      discoverProjectSkills: true,
      discoverCompatibleProjectSkills: false,
    });
  });

  it("keeps workspace skill source list free of .pi project paths", () => {
    expect(WORKSPACE_SKILL_DIRS.map((entry) => entry.sub)).not.toContain(".pi/skills");
    expect(WORKSPACE_SKILL_DIRS[0]).toMatchObject({ sub: ".agents/skills", category: "standard" });
  });
});
