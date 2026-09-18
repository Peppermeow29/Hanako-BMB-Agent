import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateToProvidersYaml } from "../core/migrate-providers.ts";
import { ProviderRegistry } from "../core/provider-registry.ts";

const tempDirs: string[] = [];

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hana-provider-migration-"));
  tempDirs.push(home);
  return home;
}

function writeAgentConfig(home: string, config: any) {
  const configPath = path.join(home, "agents", "hana", "config.yaml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, YAML.dump(config), "utf-8");
  return configPath;
}

function writeCatalog(home: string, providers: any) {
  fs.writeFileSync(path.join(home, "provider-catalog.json"), JSON.stringify({
    catalogVersion: 2,
    providers,
    capabilities: {},
    meta: {},
  }, null, 2) + "\n", "utf-8");
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("legacy provider migration resilience", () => {
  it("does not replace an unreadable added-models source with an empty migration marker", () => {
    const home = makeHome();
    const sourcePath = path.join(home, "added-models.yaml");
    const corrupt = "providers: [unterminated\n";
    fs.writeFileSync(sourcePath, corrupt, "utf-8");

    expect(() => migrateToProvidersYaml(home, path.join(home, "agents")))
      .toThrow(/unreadable added-models/i);
    expect(fs.readFileSync(sourcePath, "utf-8")).toBe(corrupt);
  });

  it("does not mark provider migration complete while preferences are unreadable", () => {
    const home = makeHome();
    const prefsPath = path.join(home, "user", "preferences.json");
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    const corrupt = "{ broken preferences\n";
    fs.writeFileSync(prefsPath, corrupt, "utf-8");

    expect(() => migrateToProvidersYaml(home, path.join(home, "agents")))
      .toThrow(/unreadable provider migration source/i);
    expect(fs.readFileSync(prefsPath, "utf-8")).toBe(corrupt);
    expect(fs.existsSync(path.join(home, "added-models.yaml"))).toBe(false);
  });

  it("preserves unmatched model overrides instead of deleting their only copy", () => {
    const home = makeHome();
    writeCatalog(home, {});
    const configPath = writeAgentConfig(home, {
      models: { overrides: { "unknown-model": { context: 32000, reasoning: true } } },
    });

    new ProviderRegistry(home).migrateOverridesToAddedModels(path.join(home, "agents"));

    expect(YAML.load(fs.readFileSync(configPath, "utf-8"))).toMatchObject({
      models: { overrides: { "unknown-model": { context: 32000, reasoning: true } } },
    });
  });

  it("writes the provider destination before cleaning matched agent overrides", () => {
    const home = makeHome();
    writeCatalog(home, { custom: { models: ["model-a"] } });
    const configPath = writeAgentConfig(home, {
      models: { overrides: { "model-a": { context: 64000, image: true } } },
    });
    const registry = new ProviderRegistry(home);
    vi.spyOn(registry as any, "_saveAddedModels").mockImplementation(() => {
      throw new Error("catalog write failed");
    });

    expect(() => registry.migrateOverridesToAddedModels(path.join(home, "agents")))
      .toThrow("catalog write failed");
    expect(YAML.load(fs.readFileSync(configPath, "utf-8"))).toMatchObject({
      models: { overrides: { "model-a": { context: 64000, image: true } } },
    });
  });
});
