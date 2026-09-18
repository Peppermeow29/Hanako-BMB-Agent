import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const CI_YAML_PATH = path.join(ROOT, ".github", "workflows", "ci.yml");

function loadCi() {
  return yaml.load(fs.readFileSync(CI_YAML_PATH, "utf8")) as any;
}

function stepRun(step: any): string {
  return typeof step?.run === "string" ? step.run : "";
}

describe("source-only CI workflow", () => {
  it("keeps typecheck, lint, package-source build, renderer build, and tests in the test job", () => {
    const steps = loadCi().jobs.test.steps;
    const runs = steps.map(stepRun);
    expect(runs).toEqual(expect.arrayContaining([
      "npm run typecheck",
      "npm run lint",
      "npm run build:packages",
      "npm run build:renderer",
      "npm test",
    ]));
  });

  it("contains no installer, release, OTA, or electron-builder commands", () => {
    const workflow = fs.readFileSync(CI_YAML_PATH, "utf8");
    expect(workflow).not.toMatch(/electron-builder|electron-updater|publish-train|release asset|appimage|\.dmg|nsis/i);
  });

  it("keeps the open server boundary lint and smoke jobs", () => {
    const jobs = loadCi().jobs;
    expect(jobs).toHaveProperty("lint-open-boundary");
    expect(jobs).toHaveProperty("open-build-smoke");
    expect(jobs["lint-open-boundary"].steps.map(stepRun).join("\n")).toContain("scripts/lint-open-boundary.mjs");
    const smokeRuns = jobs["open-build-smoke"].steps.map(stepRun).join("\n");
    expect(smokeRuns).toContain("build:server:open");
    expect(smokeRuns).toContain("smoke:server:open");
  });

  it("does not reference the removed release workflow", () => {
    expect(fs.existsSync(path.join(ROOT, ".github", "workflows", "build.yml"))).toBe(false);
  });
});
