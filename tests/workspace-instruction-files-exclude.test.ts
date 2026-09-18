import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { collectWorkspaceInstructionFiles } from "../core/workspace-instruction-files.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temporaryDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-workspace-instructions-"));
  tempDirs.push(root);
  return root;
}

const bothEnabled = { inject_agents_md: true, inject_claude_md: true };

describe("workspace instruction files: excluding the agent's own persona files", () => {
  it("skips an excluded AGENTS.md so a session rooted in the agent directory does not inject the persona twice", () => {
    const agentDir = temporaryDir();
    fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "persona prompt", "utf-8");

    const withoutExclusion = collectWorkspaceInstructionFiles({
      cwd: agentDir,
      workspaceContext: bothEnabled,
    });
    expect(withoutExclusion.map((file) => file.filename)).toEqual(["AGENTS.md"]);

    const withExclusion = collectWorkspaceInstructionFiles({
      cwd: agentDir,
      workspaceContext: bothEnabled,
      excludeFiles: [path.join(agentDir, "AGENTS.md")],
    });
    expect(withExclusion).toEqual([]);
  });

  it("leaves CLAUDE.md in the same directory untouched", () => {
    const agentDir = temporaryDir();
    fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "persona prompt", "utf-8");
    fs.writeFileSync(path.join(agentDir, "CLAUDE.md"), "project rules", "utf-8");

    const files = collectWorkspaceInstructionFiles({
      cwd: agentDir,
      workspaceContext: bothEnabled,
      excludeFiles: [
        path.join(agentDir, "AGENTS.md"),
        path.join(agentDir, "AGENTS.public.md"),
      ],
    });

    expect(files.map((file) => file.filename)).toEqual(["CLAUDE.md"]);
    expect(files[0].content).toBe("project rules");
  });

  it("only excludes the named paths, not same-named files elsewhere in the directory chain", () => {
    const root = temporaryDir();
    // A .git marker makes the root the search root, so the walk covers both levels.
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "workspace rules", "utf-8");
    const agentDir = path.join(root, "nested");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "persona prompt", "utf-8");

    const files = collectWorkspaceInstructionFiles({
      cwd: agentDir,
      workspaceContext: bothEnabled,
      excludeFiles: [path.join(agentDir, "AGENTS.md")],
    });

    expect(files.map((file) => file.content)).toEqual(["workspace rules"]);
  });

  it("ignores empty and malformed exclusion entries rather than dropping every file", () => {
    const agentDir = temporaryDir();
    fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "persona prompt", "utf-8");

    const files = collectWorkspaceInstructionFiles({
      cwd: agentDir,
      workspaceContext: bothEnabled,
      excludeFiles: ["", null as any, undefined as any],
    });

    expect(files.map((file) => file.filename)).toEqual(["AGENTS.md"]);
  });
});
