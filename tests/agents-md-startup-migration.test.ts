import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LEGACY_PERSONA_FILE_RENAMES,
  SUPERSEDED_LEGACY_PERSONA_SUFFIX,
  migrateAgentPersonaFileNames,
} from "../core/agents-md-migration.ts";
import { resolvePersonaSource } from "../core/persona-source.ts";

const tempDirs: string[] = [];

/**
 * Every case builds its own throwaway data directory. The migration renames
 * files inside whatever directory it is handed, so pointing it at a real data
 * directory would rewrite the developer's own agents.
 */
function temporaryAgentsDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-agents-md-migration-"));
  tempDirs.push(root);
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  return agentsDir;
}

function makeAgent(agentsDir: string, agentId: string, files: Record<string, string>) {
  const agentDir = path.join(agentsDir, agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(agentDir, name), content, "utf-8");
  }
  return agentDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AGENTS.md startup migration", () => {
  it("renames a legacy persona file so the persona fallback chain reads it under the new name", () => {
    const agentsDir = temporaryAgentsDir();
    const agentDir = makeAgent(agentsDir, "hana", { "ishiki.md": "customized persona" });

    const result = migrateAgentPersonaFileNames({ agentsDir });

    expect(fs.existsSync(path.join(agentDir, "ishiki.md"))).toBe(false);
    expect(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf-8")).toBe("customized persona");
    expect(result.renamed).toEqual(["hana/AGENTS.md"]);
    expect(result.failed).toEqual([]);

    // The point of the rename is that the one fallback chain now finds it.
    const resolved = resolvePersonaSource({
      agentDir,
      productDir: path.join(agentsDir, "missing-product-dir"),
      yuanType: "hanako",
      locale: "en",
      kind: "agents",
    });
    expect(resolved).toEqual({ content: "customized persona", fromTemplate: false });
  });

  it("renames the public persona variant under the same rule", () => {
    const agentsDir = temporaryAgentsDir();
    const agentDir = makeAgent(agentsDir, "hana", { "public-ishiki.md": "public persona" });

    migrateAgentPersonaFileNames({ agentsDir });

    expect(fs.existsSync(path.join(agentDir, "public-ishiki.md"))).toBe(false);
    expect(fs.readFileSync(path.join(agentDir, "AGENTS.public.md"), "utf-8")).toBe("public persona");
  });

  it("keeps the new file and sets the legacy one aside when both exist, deleting nothing", () => {
    const agentsDir = temporaryAgentsDir();
    const agentDir = makeAgent(agentsDir, "hana", {
      "ishiki.md": "legacy persona",
      "AGENTS.md": "current persona",
      "public-ishiki.md": "legacy public persona",
      "AGENTS.public.md": "current public persona",
    });

    const result = migrateAgentPersonaFileNames({ agentsDir });

    expect(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf-8")).toBe("current persona");
    expect(fs.readFileSync(path.join(agentDir, "AGENTS.public.md"), "utf-8")).toBe("current public persona");
    expect(fs.existsSync(path.join(agentDir, "ishiki.md"))).toBe(false);
    expect(fs.existsSync(path.join(agentDir, "public-ishiki.md"))).toBe(false);
    expect(
      fs.readFileSync(path.join(agentDir, `ishiki.md${SUPERSEDED_LEGACY_PERSONA_SUFFIX}`), "utf-8"),
    ).toBe("legacy persona");
    expect(
      fs.readFileSync(path.join(agentDir, `public-ishiki.md${SUPERSEDED_LEGACY_PERSONA_SUFFIX}`), "utf-8"),
    ).toBe("legacy public persona");
    expect(result.renamed).toEqual([]);
    expect(result.superseded.sort()).toEqual([
      `hana/ishiki.md${SUPERSEDED_LEGACY_PERSONA_SUFFIX}`,
      `hana/public-ishiki.md${SUPERSEDED_LEGACY_PERSONA_SUFFIX}`,
    ]);
  });

  it("does nothing on a second run, and sets aside a legacy file that reappears without clobbering the first one", () => {
    const agentsDir = temporaryAgentsDir();
    const agentDir = makeAgent(agentsDir, "hana", { "ishiki.md": "legacy persona" });

    migrateAgentPersonaFileNames({ agentsDir });
    const secondRun = migrateAgentPersonaFileNames({ agentsDir });
    expect(secondRun.renamed).toEqual([]);
    expect(secondRun.superseded).toEqual([]);
    expect(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf-8")).toBe("legacy persona");

    // A restore from an old backup can drop the legacy name back in beside the
    // new one; the earlier set-aside copy must survive that.
    fs.writeFileSync(path.join(agentDir, "ishiki.md"), "first restored copy", "utf-8");
    migrateAgentPersonaFileNames({ agentsDir });
    fs.writeFileSync(path.join(agentDir, "ishiki.md"), "second restored copy", "utf-8");
    migrateAgentPersonaFileNames({ agentsDir });

    expect(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf-8")).toBe("legacy persona");
    const setAside = fs.readdirSync(agentDir)
      .filter((name) => name.includes(SUPERSEDED_LEGACY_PERSONA_SUFFIX.split(".bak")[0]))
      .map((name) => fs.readFileSync(path.join(agentDir, name), "utf-8"))
      .sort();
    expect(setAside).toEqual(["first restored copy", "second restored copy"]);
  });

  it("reports a failing agent directory and still migrates the others", () => {
    const agentsDir = temporaryAgentsDir();
    const brokenDir = makeAgent(agentsDir, "broken", { "ishiki.md": "broken persona" });
    const healthyDir = makeAgent(agentsDir, "healthy", { "ishiki.md": "healthy persona" });
    // A plain file sitting where an agent directory would be: skipped, not a failure.
    fs.writeFileSync(path.join(agentsDir, "stray-note.txt"), "not an agent", "utf-8");

    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation(((from: any, to: any) => {
      if (String(from).startsWith(brokenDir)) {
        const error: any = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      return realRename(from, to);
    }) as any);

    const logged: string[] = [];
    const result = migrateAgentPersonaFileNames({ agentsDir, log: (line) => logged.push(line) });

    expect(result.renamed).toEqual(["healthy/AGENTS.md"]);
    expect(result.failed).toEqual(["broken/ishiki.md"]);
    expect(fs.readFileSync(path.join(healthyDir, "AGENTS.md"), "utf-8")).toBe("healthy persona");
    expect(fs.readFileSync(path.join(brokenDir, "ishiki.md"), "utf-8")).toBe("broken persona");
    expect(logged.join("\n")).toContain("broken/ishiki.md");
  });

  it("declares both persona file renames", () => {
    expect(LEGACY_PERSONA_FILE_RENAMES).toEqual([
      { legacyFileName: "ishiki.md", currentFileName: "AGENTS.md" },
      { legacyFileName: "public-ishiki.md", currentFileName: "AGENTS.public.md" },
    ]);
  });
});
