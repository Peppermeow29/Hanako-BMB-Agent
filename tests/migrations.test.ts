/**
 * core/migrations.ts 单元测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { getMigrationStatus, runMigrations } from "../core/migrations.ts";
import { ProviderRegistry } from "../core/provider-registry.ts";
import { getAgentPhoneProjectionPath, safeConversationStem } from "../lib/conversations/agent-phone-projection.ts";
import { SEARCH_CAPABILITY_PROVIDERS } from "../shared/search-providers.ts";
import { validateProviderModels } from "../shared/provider-model-validation.ts";

// ── 测试工具 ────────────────────────────────────────────────────────────────

const LATEST_DATA_VERSION = 53;

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-migrations-"));
}

/** 最小化 PreferencesManager stub */
function makePrefs(userDir) {
  const p = path.join(userDir, "preferences.json");
  fs.mkdirSync(userDir, { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, "{}", "utf-8");
  return {
    getPreferences() { return JSON.parse(fs.readFileSync(p, "utf-8")); },
    savePreferences(data) {
      fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
    },
  };
}

/** 最小化 ProviderRegistry stub — 只需 get() 返回是否存在 */
function makeRegistry(existingProviders) {
  const set = new Set(existingProviders);
  return {
    get(id) { return set.has(id) ? { id } : null; },
    getAllProvidersRaw() { return {}; },
  };
}

function makeRegistryWithModels(providers) {
  const entries = Object.entries(providers || {});
  const set = new Set(entries.map(([id]) => id));
  return {
    get(id) { return set.has(id) ? { id } : null; },
    getAllProvidersRaw() { return providers; },
    getDefaultModels(id) { return providers?.[id]?.defaultModels || []; },
  };
}

function writeAgentConfig(agentsDir, agentId, config) {
  const dir = path.join(agentsDir, agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.yaml"),
    YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }),
    "utf-8",
  );
}

function readAgentConfig(agentsDir, agentId) {
  return YAML.load(fs.readFileSync(path.join(agentsDir, agentId, "config.yaml"), "utf-8"));
}

function writeSessionJsonl(filePath, messages) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = messages.map((message, index) => JSON.stringify({
    type: "message",
    id: `m-${index + 1}`,
    timestamp: "2026-04-15T00:00:00.000Z",
    message,
  }));
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

function readSessionJsonl(filePath) {
  return fs.readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ── runner 行为 ──────────────────────────────────────────────────────────────

describe("runMigrations runner", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  it("migration #40 canonicalizes legacy session permission sidecars without changing explicit session modes", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 39 });
    const sessionMetaPath = path.join(agentsDir, "hana", "sessions", "session-meta.json");
    writeJson(sessionMetaPath, {
      "legacy-readonly.jsonl": { planMode: true },
      "legacy-operate.jsonl": { accessMode: "operate" },
      "explicit-ask.jsonl": { permissionMode: "ask", accessMode: "operate" },
      "unknown.jsonl": { title: "leave me alone" },
    });

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const meta = readJson(sessionMetaPath);
    expect(meta["legacy-readonly.jsonl"]).toMatchObject({
      permissionMode: "read_only",
      accessMode: "read_only",
      planMode: true,
    });
    expect(meta["legacy-operate.jsonl"]).toMatchObject({
      permissionMode: "operate",
      accessMode: "operate",
      planMode: false,
    });
    expect(meta["explicit-ask.jsonl"]).toMatchObject({
      permissionMode: "ask",
      accessMode: "operate",
    });
    expect(meta["unknown.jsonl"]).toEqual({ title: "leave me alone" });
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("首次运行：_dataVersion 从 0 升到最新", () => {
    const prefs = makePrefs(userDir);
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    expect(prefs.getPreferences()._dataVersion).toBeGreaterThan(0);
  });

  it("已迁移过：不重复执行", () => {
    const prefs = makePrefs(userDir);
    // 设置一个很大的 _dataVersion，所有迁移都应跳过
    prefs.savePreferences({ _dataVersion: 9999 });

    writeAgentConfig(agentsDir, "hana", { api: { provider: "ghost-provider" } });

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    // config 不应被修改（ghost-provider 应原样保留）
    const config = readAgentConfig(agentsDir, "hana");
    expect(config.api.provider).toBe("ghost-provider");
  });

  it("兼容只有 _dataVersion 的旧偏好，并且状态查询不写盘", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 47, keep: "unchanged" });
    const before = fs.readFileSync(path.join(userDir, "preferences.json"));

    expect(getMigrationStatus(prefs)).toEqual({
      registryLatestId: LATEST_DATA_VERSION,
      pendingIds: [48, 49, 50, 51, 52, 53],
      lastFailedIds: [],
    });
    expect(fs.readFileSync(path.join(userDir, "preferences.json")).equals(before)).toBe(true);
  });

  it("失败后继续尝试无关迁移，已成功条目不重跑，高水位不跨过缺口", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 17 });
    fs.writeFileSync(path.join(tmpDir, "users.json"), "{ broken json", "utf-8");
    const firstLogs: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      runMigrations({
        hanakoHome: tmpDir,
        agentsDir,
        prefs,
        providerRegistry: makeRegistry([]),
        log: (line) => { firstLogs.push(String(line)); },
      });
    } finally {
      errorSpy.mockRestore();
    }

    const afterFailure = prefs.getPreferences();
    expect(afterFailure._dataVersion).toBe(17);
    expect(afterFailure._migrationState.completedIds).toContain(19);
    expect(afterFailure._migrationState.lastFailedIds).toContain(18);
    expect(firstLogs).toContain("[migrations] #19 完成");
    expect(getMigrationStatus(prefs).pendingIds).toContain(18);

    fs.rmSync(path.join(tmpDir, "users.json"));
    const retryLogs: string[] = [];
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: (line) => { retryLogs.push(String(line)); },
    });

    expect(retryLogs).not.toContain("[migrations] #19 完成");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
    expect(getMigrationStatus(prefs)).toEqual({
      registryLatestId: LATEST_DATA_VERSION,
      pendingIds: [],
      lastFailedIds: [],
    });
  });

  it("前置迁移失败时跳过依赖项，但仍执行后面无关的迁移", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 35 });
    fs.writeFileSync(path.join(tmpDir, "subagent-runs.json"), "{ broken json", "utf-8");
    const logs: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      runMigrations({
        hanakoHome: tmpDir,
        agentsDir,
        prefs,
        providerRegistry: makeRegistry([]),
        log: (line) => { logs.push(String(line)); },
      });
    } finally {
      errorSpy.mockRestore();
    }

    expect(logs).toContain("[migrations] #37 等待前置迁移 #36");
    expect(logs).toContain("[migrations] #38 完成");
    expect(getMigrationStatus(prefs).pendingIds).toEqual(expect.arrayContaining([36, 37]));
    expect(getMigrationStatus(prefs).pendingIds).not.toContain(38);
  });

  it("迁移收据暂时无法落盘时不阻塞启动，并让该迁移保持待重试", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 48 });
    const originalSave = prefs.savePreferences;
    prefs.savePreferences = () => { throw new Error("disk temporarily read-only"); };
    const logs: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => runMigrations({
        hanakoHome: tmpDir,
        agentsDir,
        prefs,
        providerRegistry: makeRegistry([]),
        log: (line) => { logs.push(String(line)); },
      })).not.toThrow();
    } finally {
      prefs.savePreferences = originalSave;
      errorSpy.mockRestore();
    }

    expect(logs).toContain("[migrations] 收据保存失败，应用将继续启动；未落盘的迁移会在下次启动重试");
    expect(getMigrationStatus(prefs).pendingIds).toEqual([49, 50, 51, 52, 53]);
  });
});

describe("migration #11: repairCronJobModelRefs", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeCronJobs(agentId, jobs) {
    const deskDir = path.join(agentsDir, agentId, "desk");
    fs.mkdirSync(deskDir, { recursive: true });
    fs.writeFileSync(
      path.join(deskDir, "cron-jobs.json"),
      JSON.stringify({ jobs, nextNum: jobs.length + 1 }, null, 2) + "\n",
      "utf-8",
    );
  }

  function readCronJobs(agentId) {
    return JSON.parse(fs.readFileSync(path.join(agentsDir, agentId, "desk", "cron-jobs.json"), "utf-8")).jobs;
  }

  it("把 cron-jobs.json 里的裸 id / provider-id 字符串迁移为 {id, provider}", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 10 });
    writeAgentConfig(agentsDir, "hana", { agent: { name: "Hana" } });
    writeCronJobs("hana", [
      { id: "job_22", type: "cron", schedule: "0 3 * * *", prompt: "a", enabled: true, model: "MiniMax-M2.7" },
      { id: "job_23", type: "cron", schedule: "0 3 * * *", prompt: "b", enabled: true, model: { id: "MiniMax-M2.7" } },
      { id: "job_24", type: "cron", schedule: "0 3 * * *", prompt: "c", enabled: true, model: "openai/gpt-4o" },
      { id: "job_25", type: "cron", schedule: "0 3 * * *", prompt: "d", enabled: true, model: "unknown-model" },
    ]);

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistryWithModels({
        minimax: { models: ["MiniMax-M2.7"] },
        openai: { models: ["gpt-4o"] },
      }),
      log: () => {},
    });

    const jobs = readCronJobs("hana");
    expect(jobs[0].model).toEqual({ id: "MiniMax-M2.7", provider: "minimax" });
    expect(jobs[1].model).toEqual({ id: "MiniMax-M2.7", provider: "minimax" });
    expect(jobs[2].model).toEqual({ id: "gpt-4o", provider: "openai" });
    expect(jobs[3].model).toBe("unknown-model");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #30: cron jobs to automation read model", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeStudioCronJobs(studioId, jobs) {
    const deskDir = path.join(tmpDir, "studios", studioId, "desk");
    fs.mkdirSync(deskDir, { recursive: true });
    fs.writeFileSync(
      path.join(deskDir, "cron-jobs.json"),
      JSON.stringify({ jobs, nextNum: jobs.length + 1 }, null, 2) + "\n",
      "utf-8",
    );
  }

  function readStudioCronJobs(studioId) {
    return JSON.parse(fs.readFileSync(
      path.join(tmpDir, "studios", studioId, "desk", "cron-jobs.json"),
      "utf-8",
    )).jobs;
  }

  it("adds automation fields to existing studio cron jobs while preserving legacy fields", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 29 });
    writeStudioCronJobs("default", [{
      schemaVersion: 1,
      id: "studio_job_1",
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "summarize",
      label: "Daily",
      enabled: true,
      model: { id: "gpt-4o", provider: "openai" },
      actorAgentId: "hana",
      executionContext: {
        kind: "legacy_agent_home",
        cwd: null,
        workspaceFolders: [],
        sourceSessionPath: null,
        createdByAgentId: "hana",
      },
    }]);

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistryWithModels({}),
      log: () => {},
    });

    const [job] = readStudioCronJobs("default");
    expect(job.schemaVersion).toBe(4);
    expect(job.type).toBe("cron");
    expect(job.prompt).toBe("summarize");
    expect(job.trigger).toEqual({ kind: "cron", expression: "0 9 * * *" });
    expect(job.executor).toMatchObject({
      kind: "agent_session",
      agentId: "hana",
      prompt: "summarize",
      model: { id: "gpt-4o", provider: "openai" },
      executionContext: {
        kind: "legacy_agent_home",
        cwd: null,
        workspaceFolders: [],
        sourceSessionPath: null,
        createdByAgentId: "hana",
      },
    });
    expect(job.createdBy).toEqual({ kind: "agent", agentId: "hana" });
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #42: provider catalog v2 cutover", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("migrates legacy provider YAML into provider-catalog.json exactly once", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 41 });
    fs.writeFileSync(
      path.join(tmpDir, "added-models.yaml"),
      YAML.dump({
        providers: {
          zhipu: {
            api_key: "sk-zhipu",
            base_url: "https://open.bigmodel.cn/api/paas/v4",
            api: "openai-completions",
            models: [{ id: "glm-test", reasoning: true, defaultThinkingLevel: "max" }],
          },
        },
      }, { indent: 2, lineWidth: -1, sortKeys: false }),
      "utf-8",
    );

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistryWithModels({}),
      log: () => {},
    });

    const catalog = readJson(path.join(tmpDir, "provider-catalog.json"));
    expect(catalog.catalogVersion).toBe(2);
    expect(catalog.providers.zhipu.models[0]).toMatchObject({
      id: "glm-test",
      reasoning: true,
      defaultThinkingLevel: "max",
    });
    expect(catalog.capabilities["web.search"]).toEqual({ providers: SEARCH_CAPABILITY_PROVIDERS });
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);

    const backups = fs.readdirSync(path.join(tmpDir, "migration-backups"))
      .filter((name) => name.startsWith("provider-catalog-v1-"));
    expect(backups).toHaveLength(1);
  });

  it("refreshes an early generated provider catalog from the final legacy YAML at cutover", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 41 });
    fs.writeFileSync(
      path.join(tmpDir, "provider-catalog.json"),
      JSON.stringify({
        catalogVersion: 2,
        providers: {
          zhipu: {
            api_key: "sk-stale",
            api: "openai-completions",
            models: [{ id: "glm-stale" }],
          },
        },
        capabilities: {
          "web.search": { providers: [{ id: "brave", source: "api" }] },
        },
        meta: { migratedAt: "2026-01-01T00:00:00.000Z" },
      }, null, 2) + "\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tmpDir, "added-models.yaml"),
      YAML.dump({
        providers: {
          zhipu: {
            api_key: "sk-final",
            api: "openai-completions",
            models: [{ id: "glm-final", reasoning: true }],
          },
        },
      }, { indent: 2, lineWidth: -1, sortKeys: false }),
      "utf-8",
    );

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistryWithModels({}),
      log: () => {},
    });

    const catalog = readJson(path.join(tmpDir, "provider-catalog.json"));
    expect(catalog.providers.zhipu).toMatchObject({
      api_key: "sk-final",
      models: [{ id: "glm-final", reasoning: true }],
    });
    expect(catalog.capabilities["web.search"].providers).toEqual([{ id: "brave", source: "api" }]);
    expect(catalog.meta.migrationSource).toBe("added-models.yaml");
    expect(catalog.meta.providerCatalogCutoverAt).toEqual(expect.any(String));
  });
});

describe("migration #43: Codex image generation defaults follow mode schema", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("removes stale Codex size defaults while preserving other provider defaults", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      _dataVersion: 42,
      imageGeneration: {
        defaultImageModel: { provider: "openai-codex-oauth", id: "gpt-image-2" },
        providerDefaults: {
          "openai-codex-oauth": {
            size: "4K",
            models: {
              "gpt-image-2": {
                modes: {
                  text2image: { ratio: "3:2" },
                },
              },
            },
          },
          openai: { size: "1024x1024" },
        },
      },
    });
    writeJson(path.join(tmpDir, "plugin-data", "image-gen", "config.json"), {
      global: {
        providerDefaults: {
          "openai-codex-oauth": {
            size: "4K",
            models: {
              "gpt-image-2": {
                modes: {
                  text2image: { ratio: "3:2" },
                },
              },
            },
          },
          openai: { size: "1024x1024" },
        },
      },
    });

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistryWithModels({}),
      log: () => {},
    });

    const nextPrefs = prefs.getPreferences();
    expect(nextPrefs._dataVersion).toBe(LATEST_DATA_VERSION);
    expect(nextPrefs.imageGeneration.providerDefaults["openai-codex-oauth"]).toEqual({
      models: {
        "gpt-image-2": {
          modes: {
            text2image: { ratio: "3:2" },
          },
        },
      },
    });
    expect(nextPrefs.imageGeneration.providerDefaults.openai).toEqual({ size: "1024x1024" });

    const pluginConfigPath = path.join(tmpDir, "plugin-data", "image-gen", "config.json");
    if (process.platform !== "win32") {
      // A migration must leave the file under the same contract the store writes it with.
      expect(fs.statSync(pluginConfigPath).mode & 0o777).toBe(0o600);
    }
    const pluginConfig = readJson(pluginConfigPath);
    expect(pluginConfig.global.providerDefaults["openai-codex-oauth"]).toEqual({
      models: {
        "gpt-image-2": {
          modes: {
            text2image: { ratio: "3:2" },
          },
        },
      },
    });
    expect(pluginConfig.global.providerDefaults.openai).toEqual({ size: "1024x1024" });
  });
});

describe("migration #44: OAuth models converge into Provider Catalog", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("merges the legacy Codex runtime alias into the canonical provider without losing model metadata", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      _dataVersion: 43,
      oauth_custom_models: {
        "openai-codex": ["legacy-custom"],
        "openai-codex-oauth": ["canonical-custom"],
      },
    });
    writeJson(path.join(tmpDir, "provider-catalog.json"), {
      catalogVersion: 2,
      providers: {
        "openai-codex": {
          base_url: "https://legacy.example/backend-api",
          api_key: "stale-oauth-token",
          models: [
            { id: "shared", name: "Legacy", context: 111000 },
            { id: "alias-only", context: 222000 },
          ],
        },
        "openai-codex-oauth": {
          api: "openai-codex-responses",
          models: [
            { id: "shared", name: "Canonical", context: 333000 },
            "canonical-only",
          ],
        },
      },
      capabilities: {},
      meta: {},
    });
    const registry = new ProviderRegistry(tmpDir);

    runMigrations({ hanakoHome: tmpDir, agentsDir, prefs, providerRegistry: registry, log: () => {} });

    const catalog = readJson(path.join(tmpDir, "provider-catalog.json"));
    expect(catalog.providers).not.toHaveProperty("openai-codex");
    expect(catalog.providers["openai-codex-oauth"]).toMatchObject({
      base_url: "https://legacy.example/backend-api",
      api: "openai-codex-responses",
    });
    expect(catalog.providers["openai-codex-oauth"]).not.toHaveProperty("api_key");
    expect(catalog.providers["openai-codex-oauth"].models).toEqual([
      { id: "shared", name: "Canonical", context: 333000 },
      { id: "alias-only", context: 222000 },
      "canonical-only",
      "legacy-custom",
      "canonical-custom",
    ]);
    expect(prefs.getPreferences()).not.toHaveProperty("oauth_custom_models");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("turns legacy empty Codex models into Hana defaults and preserves additive custom models", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      _dataVersion: 43,
      oauth_custom_models: { "openai-codex": ["my-codex-model"] },
    });
    writeJson(path.join(tmpDir, "provider-catalog.json"), {
      catalogVersion: 2,
      providers: { "openai-codex": { models: [] } },
      capabilities: {},
      meta: {},
    });
    const registry = new ProviderRegistry(tmpDir);

    runMigrations({ hanakoHome: tmpDir, agentsDir, prefs, providerRegistry: registry, log: () => {} });

    const catalog = readJson(path.join(tmpDir, "provider-catalog.json"));
    const ids = catalog.providers["openai-codex-oauth"].models.map((model) => typeof model === "object" ? model.id : model);
    expect(ids).toEqual(expect.arrayContaining([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.2",
      "my-codex-model",
    ]));
    expect(prefs.getPreferences()).not.toHaveProperty("oauth_custom_models");
  });

  it("deletes a legacy empty models field when there are no custom additions", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 43 });
    writeJson(path.join(tmpDir, "provider-catalog.json"), {
      catalogVersion: 2,
      providers: { "openai-codex-oauth": { models: [] } },
      capabilities: {},
      meta: {},
    });
    const registry = new ProviderRegistry(tmpDir);

    runMigrations({ hanakoHome: tmpDir, agentsDir, prefs, providerRegistry: registry, log: () => {} });

    const catalog = readJson(path.join(tmpDir, "provider-catalog.json"));
    expect(catalog.providers["openai-codex-oauth"]).not.toHaveProperty("models");
    registry.reload();
    expect(registry.getChatModelIds("openai-codex-oauth")).toContain("gpt-5.6-sol");
  });
});

describe("migration #45: recover persisted Codex OAuth model references", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeCatalog(providerConfig = {}) {
    writeJson(path.join(tmpDir, "provider-catalog.json"), {
      catalogVersion: 2,
      providers: { "openai-codex-oauth": providerConfig },
      capabilities: {},
      meta: {},
    });
  }

  function migrationRegistry(defaultModels = [{ id: "gpt-current", name: "Current", context: 400000 }]) {
    return {
      getDefaultModelEntries(providerId) {
        return providerId === "openai-codex-oauth" ? structuredClone(defaultModels) : [];
      },
      _entries: new Map(),
    };
  }

  function runFrom44(prefs, providerRegistry = migrationRegistry(), log: (line: any) => void = () => {}) {
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry,
      log,
    });
  }

  it("adds every official persisted reference while leaving all source files byte-identical", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      _dataVersion: 44,
      utility_model: { provider: "openai-codex", id: "pref-utility" },
    });
    writeCatalog({ api: "openai-codex-responses" });

    writeAgentConfig(agentsDir, "hana", {
      models: {
        chat: { provider: "openai-codex-oauth", id: "agent-chat" },
        utility: "openai-codex/agent-utility",
      },
      workspace_context: { discover_compatible_project_skills: false },
    });

    const sessionPaths = [
      path.join(agentsDir, "hana", "sessions", "main.jsonl"),
      path.join(agentsDir, "hana", "sessions", "archived", "archived.jsonl"),
      path.join(agentsDir, "hana", "bridge", "telegram", "bridge.jsonl"),
      path.join(agentsDir, "hana", "subagents", "run-1", "subagent.jsonl"),
    ];
    fs.mkdirSync(path.dirname(sessionPaths[0]), { recursive: true });
    fs.writeFileSync(sessionPaths[0], [
      "{ damaged line",
      JSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "session-main" }),
      JSON.stringify({ type: "message", message: { role: "assistant", provider: "openai-codex-oauth", model: "session-assistant" } }),
      "",
    ].join("\n"), "utf-8");
    writeSessionJsonl(sessionPaths[1], [{
      role: "assistant",
      provider: "openai-codex-oauth",
      model: "session-archived",
      content: [{ type: "text", text: "archived" }],
    }]);
    writeSessionJsonl(sessionPaths[2], [{
      role: "assistant",
      provider: "openai-codex",
      model: "session-bridge",
      content: [{ type: "text", text: "bridge" }],
    }]);
    writeSessionJsonl(sessionPaths[3], [{
      role: "assistant",
      provider: "openai-codex-oauth",
      model: "session-subagent",
      content: [{ type: "text", text: "subagent" }],
    }]);

    const agentCronPath = path.join(agentsDir, "hana", "desk", "cron-jobs.json");
    writeJson(agentCronPath, {
      jobs: [{ id: "agent-job", model: { provider: "openai-codex", id: "agent-automation" } }],
    });
    const studioCronPath = path.join(tmpDir, "studios", "default", "desk", "cron-jobs.json");
    writeJson(studioCronPath, {
      jobs: [{
        id: "studio-job",
        executor: { model: { provider: "openai-codex-oauth", id: "studio-automation" } },
      }],
    });

    const channelPath = path.join(tmpDir, "channels", "ch_crew.md");
    fs.mkdirSync(path.dirname(channelPath), { recursive: true });
    fs.writeFileSync(channelPath, [
      "---",
      "id: ch_crew",
      "agentPhoneModelOverrideEnabled: true",
      "agentPhoneModelOverrideProvider: openai-codex",
      "agentPhoneModelOverrideId: channel-override",
      "---",
      "# Crew",
      "",
    ].join("\n"), "utf-8");
    const dmPath = path.join(agentsDir, "hana", "dm", "other.md");
    fs.mkdirSync(path.dirname(dmPath), { recursive: true });
    fs.writeFileSync(dmPath, [
      "---",
      "peer: other",
      "modelOverrideEnabled: true",
      "modelOverrideProvider: openai-codex-oauth",
      "modelOverrideId: dm-override",
      "---",
      "",
    ].join("\n"), "utf-8");

    const brokenConfigPath = path.join(agentsDir, "broken", "config.yaml");
    fs.mkdirSync(path.dirname(brokenConfigPath), { recursive: true });
    fs.writeFileSync(brokenConfigPath, "models: [unterminated", "utf-8");

    const sourcePaths = [
      path.join(agentsDir, "hana", "config.yaml"),
      ...sessionPaths,
      agentCronPath,
      studioCronPath,
      channelPath,
      dmPath,
      brokenConfigPath,
    ];
    const originalBytes = new Map(sourcePaths.map((filePath) => [filePath, fs.readFileSync(filePath)]));
    const logs = [];

    runFrom44(prefs, migrationRegistry(), (line) => { logs.push(line); });

    const catalog = readJson(path.join(tmpDir, "provider-catalog.json"));
    const models = catalog.providers["openai-codex-oauth"].models;
    const ids = models.map((model) => typeof model === "object" ? model.id : model);
    expect(ids).toEqual(expect.arrayContaining([
      "gpt-current",
      "pref-utility",
      "agent-chat",
      "agent-utility",
      "session-main",
      "session-assistant",
      "session-archived",
      "session-bridge",
      "session-subagent",
      "agent-automation",
      "studio-automation",
      "channel-override",
      "dm-override",
    ]));
    expect(models[0]).toEqual({ id: "gpt-current", name: "Current", context: 400000 });
    expect(logs).toEqual(expect.arrayContaining([
      expect.stringContaining("skipped invalid session JSONL line"),
      expect.stringContaining("skipped invalid agent config.yaml"),
    ]));
    for (const [filePath, bytes] of originalBytes) {
      expect(fs.readFileSync(filePath).equals(bytes)).toBe(true);
    }
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);

    const firstCatalogBytes = fs.readFileSync(path.join(tmpDir, "provider-catalog.json"));
    const rerunPrefs = prefs.getPreferences();
    rerunPrefs._dataVersion = 44;
    prefs.savePreferences(rerunPrefs);
    runFrom44(prefs, migrationRegistry());
    expect(fs.readFileSync(path.join(tmpDir, "provider-catalog.json")).equals(firstCatalogBytes)).toBe(true);
  });

  it("does not read a model_change or assistant message entry's own event id as a Codex model id, but still reads the legitimate id field on a bare model descriptor (#45 event-id pollution)", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 44 });
    writeCatalog({ api: "openai-codex-responses" });

    const sessionPath = path.join(agentsDir, "hana", "sessions", "main.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, [
      // Real shape produced by the Pi SDK session writer: `id` is the session
      // tree node's own event id (8-hex, from randomUUID().slice(0, 8)), never
      // a model id. Only `modelId` legitimately identifies the Codex model.
      JSON.stringify({
        type: "model_change",
        id: "ff2c7bcc",
        parentId: "e0",
        timestamp: "2026-07-01T00:00:00.000Z",
        provider: "openai-codex",
        modelId: "gpt-5.5",
      }),
      // Hypothetical assistant message entry carrying a stray `id` alongside
      // `provider`/`model` — AssistantMessage today has no such field (it uses
      // `responseId` instead), but the extractor must not trust `id` here
      // either, since the same "provider" key name is shared with event
      // records that do carry a real event id.
      JSON.stringify({
        type: "message",
        id: "e1",
        parentId: "ff2c7bcc",
        timestamp: "2026-07-01T00:00:01.000Z",
        message: {
          role: "assistant",
          id: "deadbeef",
          provider: "openai-codex-oauth",
          model: "gpt-5.5-mini",
        },
      }),
      // Legacy descriptor shape (comment at collectCodexModelsFromLegacyPersistence
      // call site): the restored model stored beside the entry as a plain
      // `{ provider, id }` reference object. This is NOT an event record, so its
      // `id` legitimately identifies the model and must still be collected.
      JSON.stringify({
        type: "restore_snapshot",
        id: "e2",
        parentId: "e1",
        timestamp: "2026-07-01T00:00:02.000Z",
        model: { provider: "openai-codex-oauth", id: "descriptor-legit-id" },
      }),
      "",
    ].join("\n"), "utf-8");

    runFrom44(prefs);

    const catalog = readJson(path.join(tmpDir, "provider-catalog.json"));
    const ids = catalog.providers["openai-codex-oauth"].models.map(
      (model) => (typeof model === "object" ? model.id : model),
    );
    expect(ids).toEqual(expect.arrayContaining(["gpt-5.5", "gpt-5.5-mini", "descriptor-legit-id"]));
    expect(ids).not.toContain("ff2c7bcc");
    expect(ids).not.toContain("deadbeef");
  });

  it("preserves an existing non-empty allowlist and its metadata while appending references", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      _dataVersion: 44,
      utility_model: { provider: "openai-codex-oauth", id: "legacy-selected" },
    });
    writeCatalog({
      display_name: "My Codex",
      models: [{ id: "existing", name: "Existing", context: 123456 }],
    });

    runFrom44(prefs);

    expect(readJson(path.join(tmpDir, "provider-catalog.json")).providers["openai-codex-oauth"]).toEqual({
      display_name: "My Codex",
      models: [
        { id: "existing", name: "Existing", context: 123456 },
        "legacy-selected",
      ],
    });
  });

  it("respects an explicit empty allowlist even when persisted references exist", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      _dataVersion: 44,
      utility_model: { provider: "openai-codex", id: "legacy-selected" },
    });
    writeCatalog({ models: [] });
    const before = fs.readFileSync(path.join(tmpDir, "provider-catalog.json"));

    runFrom44(prefs);

    expect(fs.readFileSync(path.join(tmpDir, "provider-catalog.json")).equals(before)).toBe(true);
    expect(readJson(path.join(tmpDir, "provider-catalog.json")).providers["openai-codex-oauth"].models).toEqual([]);
  });

  it("does not touch Provider Catalog when no persisted Codex reference exists", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      _dataVersion: 44,
      utility_model: { provider: "deepseek", id: "deepseek-v4-pro" },
    });
    writeCatalog({ models: ["existing"] });
    const before = fs.readFileSync(path.join(tmpDir, "provider-catalog.json"));

    runFrom44(prefs);

    expect(fs.readFileSync(path.join(tmpDir, "provider-catalog.json")).equals(before)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("does not follow session symlinks outside HANA_HOME", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 44 });
    writeCatalog({ models: ["existing"] });
    const before = fs.readFileSync(path.join(tmpDir, "provider-catalog.json"));

    const externalDir = makeTmpDir();
    try {
      writeSessionJsonl(path.join(externalDir, "outside.jsonl"), [{
        role: "assistant",
        provider: "openai-codex",
        model: "must-not-cross-boundary",
        content: [{ type: "text", text: "outside" }],
      }]);
      const sessionsDir = path.join(agentsDir, "hana", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.symlinkSync(externalDir, path.join(sessionsDir, "external"), "dir");

      runFrom44(prefs);

      expect(fs.readFileSync(path.join(tmpDir, "provider-catalog.json")).equals(before)).toBe(true);
      expect(fs.readFileSync(path.join(externalDir, "outside.jsonl"), "utf-8")).toContain("must-not-cross-boundary");
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });
});

describe("migration #46: repair legacy Provider Catalog model metadata", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeLegacyCatalog() {
    writeJson(path.join(tmpDir, "provider-catalog.json"), {
      catalogVersion: 2,
      providers: {
        custom: {
          base_url: "https://provider.example/v1",
          api_key: "provider-level-key-is-preserved",
          models: [
            "plain-model",
            {
              id: "legacy-model",
              name: "Legacy Model",
              context: 0,
              maxOutputTokens: Number.NaN,
              api: "",
              API_KEY: "model-secret-must-not-appear-in-report",
              HeAdErS: { Authorization: "another-model-secret" },
              thinkingLevelMap: {
                low: "medium",
                high: " ",
                ultra: "max",
              },
              customMetadata: { keep: true },
            },
            {
              id: "valid-model",
              context: 128000,
              maxOutput: 8192,
              thinkingLevelMap: { off: null, high: "high" },
            },
          ],
        },
      },
      capabilities: { customCapability: { enabled: true } },
      meta: { keep: "catalog-meta" },
    });
  }

  function runFrom45(prefs, log: (line: any) => void = () => {}) {
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: { _entries: new Map() },
      log,
    });
  }

  it("backs up the complete catalog before removing only metadata rejected by current validation", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 45 });
    writeLegacyCatalog();
    const catalogPath = path.join(tmpDir, "provider-catalog.json");
    const originalCatalogBytes = fs.readFileSync(catalogPath);
    const logs = [];

    runFrom45(prefs, (line) => { logs.push(line); });

    const catalog = readJson(catalogPath);
    expect(catalog.providers.custom).toEqual({
      base_url: "https://provider.example/v1",
      api_key: "provider-level-key-is-preserved",
      models: [
        "plain-model",
        {
          id: "legacy-model",
          name: "Legacy Model",
          thinkingLevelMap: { low: "medium" },
          customMetadata: { keep: true },
        },
        {
          id: "valid-model",
          context: 128000,
          maxOutput: 8192,
          thinkingLevelMap: { off: null, high: "high" },
        },
      ],
    });
    expect(catalog.capabilities.customCapability).toEqual({ enabled: true });
    expect(catalog.meta.keep).toBe("catalog-meta");
    validateProviderModels("custom", catalog.providers.custom.models, {
      baseUrl: catalog.providers.custom.base_url,
    });
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);

    const backupRoot = path.join(tmpDir, "migration-backups");
    const backupDirs = fs.readdirSync(backupRoot);
    expect(backupDirs).toHaveLength(1);
    const backupDir = path.join(backupRoot, backupDirs[0]);
    expect(
      fs.readFileSync(path.join(backupDir, "provider-catalog.json")).equals(originalCatalogBytes),
    ).toBe(true);
    const reportText = fs.readFileSync(path.join(backupDir, "migration-report.json"), "utf-8");
    expect(reportText).toContain('"field');
    expect(reportText).toContain("API_KEY");
    expect(reportText).toContain("thinkingLevelMap.ultra");
    expect(reportText).not.toContain("model-secret-must-not-appear-in-report");
    expect(reportText).not.toContain("another-model-secret");
    expect(logs.join("\n")).not.toContain("model-secret-must-not-appear-in-report");
    expect(logs.join("\n")).not.toContain("another-model-secret");

    const firstCatalogBytes = fs.readFileSync(catalogPath);
    const rerunPrefs = prefs.getPreferences();
    rerunPrefs._dataVersion = 45;
    prefs.savePreferences(rerunPrefs);
    runFrom45(prefs);
    expect(fs.readFileSync(catalogPath).equals(firstCatalogBytes)).toBe(true);
    expect(fs.readdirSync(backupRoot)).toEqual(backupDirs);
  });

  it("leaves the catalog and data version untouched when the recovery backup cannot be created", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 45 });
    writeLegacyCatalog();
    const catalogPath = path.join(tmpDir, "provider-catalog.json");
    const originalCatalogBytes = fs.readFileSync(catalogPath);
    fs.writeFileSync(path.join(tmpDir, "migration-backups"), "blocked", "utf-8");

    runFrom45(prefs);

    expect(fs.readFileSync(catalogPath).equals(originalCatalogBytes)).toBe(true);
    expect(prefs.getPreferences()._dataVersion).toBe(45);
  });
});

describe("migration #47: preserve stable DingTalk application authentication", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runFrom46(log: (line: any) => void = () => {}) {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 46 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log,
    });
    return prefs;
  }

  it("marks and canonicalizes a stable config while preserving behavior and secrets", () => {
    writeAgentConfig(agentsDir, "hana", {
      bridge: {
        dingtalk: {
          enabled: true,
          clientId: "stable-client",
          clientSecret: "stable-secret",
          robotCode: "stable-robot",
          restBaseUrl: "https://legacy-gateway.example/dingtalk/v1.0/",
          streamOpenUrl: "https://stream.example/v1.0/gateway/connections/open",
          customSetting: { keep: true },
        },
      },
    });

    const prefs = runFrom46();
    const migrated = readAgentConfig(agentsDir, "hana").bridge.dingtalk;
    expect(migrated).toMatchObject({
      enabled: true,
      authMode: "legacy_app",
      corpId: "",
      clientId: "stable-client",
      clientSecret: "stable-secret",
      robotCode: "stable-robot",
      apiBaseUrl: "https://legacy-gateway.example/dingtalk/v1.0",
      streamOpenUrl: "https://stream.example/v1.0/gateway/connections/open",
      customSetting: { keep: true },
    });
    expect(migrated).not.toHaveProperty("appKey");
    expect(migrated).not.toHaveProperty("appSecret");
    expect(migrated).not.toHaveProperty("restBaseUrl");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);

    const firstBytes = fs.readFileSync(path.join(agentsDir, "hana", "config.yaml"));
    const rerunPrefs = prefs.getPreferences();
    rerunPrefs._dataVersion = 46;
    prefs.savePreferences(rerunPrefs);
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
    expect(fs.readFileSync(path.join(agentsDir, "hana", "config.yaml")).equals(firstBytes)).toBe(true);
  });

  it("does not infer legacy mode for explicit or current-shaped configurations", () => {
    const fixtures = {
      "explicit-mode": {
        authMode: "legacy_app",
        appKey: "leave-alias-intact",
        appSecret: "leave-secret-intact",
        restBaseUrl: "https://api.dingtalk.io/v1.0",
      },
      "has-corp": {
        corpId: "corp-1",
        appKey: "leave-client-intact",
        appSecret: "leave-secret-intact",
        restBaseUrl: "https://api.dingtalk.io/v1.0",
      },
      "canonical-incomplete": {
        clientId: "current-client",
        clientSecret: "current-secret",
        robotCode: "current-robot",
        apiBaseUrl: "https://api.dingtalk.com/v1.0",
      },
    };
    for (const [agentId, dingtalk] of Object.entries(fixtures)) {
      writeAgentConfig(agentsDir, agentId, {
        bridge: { dingtalk },
        workspace_context: { discover_compatible_project_skills: false },
      });
    }
    const before = new Map(Object.keys(fixtures).map((agentId) => [
      agentId,
      fs.readFileSync(path.join(agentsDir, agentId, "config.yaml")),
    ]));

    runFrom46();

    for (const agentId of Object.keys(fixtures)) {
      expect(fs.readFileSync(path.join(agentsDir, agentId, "config.yaml")).equals(before.get(agentId)!)).toBe(true);
    }
  });

  it("isolates malformed configs without logging their secret contents", () => {
    const badDir = path.join(agentsDir, "bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(
      path.join(badDir, "config.yaml"),
      "bridge:\n  dingtalk: [\n  clientSecret: secret-must-not-leak\n",
      "utf-8",
    );
    writeAgentConfig(agentsDir, "good", {
      bridge: {
        dingtalk: {
          appKey: "good-client",
          appSecret: "good-secret",
          robotCode: "good-robot",
          restBaseUrl: "https://api.dingtalk.io/v1.0",
        },
      },
    });
    const logs: string[] = [];

    const prefs = runFrom46((line) => { logs.push(String(line)); });

    expect(readAgentConfig(agentsDir, "good").bridge.dingtalk.authMode).toBe("legacy_app");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
    expect(logs.join("\n")).toContain("skipped invalid config");
    expect(logs.join("\n")).not.toContain("secret-must-not-leak");
  });

  it("isolates an invalid legacy URL and still migrates another Agent", () => {
    writeAgentConfig(agentsDir, "bad-url", {
      bridge: {
        dingtalk: {
          appKey: "bad-client",
          appSecret: "secret-must-not-leak",
          robotCode: "bad-robot",
          restBaseUrl: "not-an-absolute-url",
        },
      },
      workspace_context: { discover_compatible_project_skills: false },
    });
    writeAgentConfig(agentsDir, "good", {
      bridge: {
        dingtalk: {
          appKey: "good-client",
          appSecret: "good-secret",
          robotCode: "good-robot",
          restBaseUrl: "https://api.dingtalk.io/v1.0",
        },
      },
      workspace_context: { discover_compatible_project_skills: false },
    });
    const badBytes = fs.readFileSync(path.join(agentsDir, "bad-url", "config.yaml"));
    const logs: string[] = [];

    const prefs = runFrom46((line) => { logs.push(String(line)); });

    expect(fs.readFileSync(path.join(agentsDir, "bad-url", "config.yaml")).equals(badBytes)).toBe(true);
    expect(readAgentConfig(agentsDir, "good").bridge.dingtalk.authMode).toBe("legacy_app");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
    expect(logs.join("\n")).toContain("stage=canonicalize");
    expect(logs.join("\n")).toContain("code=INVALID_DINGTALK_CONFIG");
    expect(logs.join("\n")).not.toContain("not-an-absolute-url");
    expect(logs.join("\n")).not.toContain("secret-must-not-leak");
  });

  it("keeps the data version retryable when a valid migration cannot be written", () => {
    writeAgentConfig(agentsDir, "readonly", {
      bridge: {
        dingtalk: {
          appKey: "stable-client",
          appSecret: "secret-must-not-leak",
          robotCode: "stable-robot",
          restBaseUrl: "https://api.dingtalk.io/v1.0",
        },
      },
    });
    const configPath = path.join(agentsDir, "readonly", "config.yaml");
    const originalBytes = fs.readFileSync(configPath);
    const originalRenameSync = fs.renameSync;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === configPath) {
        throw Object.assign(new Error("secret-must-not-leak"), { code: "EACCES" });
      }
      return originalRenameSync(source, destination);
    });
    const logs: string[] = [];

    try {
      const prefs = runFrom46((line) => { logs.push(String(line)); });
      expect(prefs.getPreferences()._dataVersion).toBe(46);
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.readFileSync(configPath).equals(originalBytes)).toBe(true);
    expect(logs.join("\n")).toContain("stage=write, code=EACCES");
    expect(logs.join("\n")).not.toContain("secret-must-not-leak");
  });

  it.runIf(process.platform !== "win32")("does not follow linked agent directories or config files", () => {
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-dingtalk-external-"));
    try {
      writeAgentConfig(externalDir, "outside", {
        bridge: {
          dingtalk: {
            appKey: "outside-client",
            appSecret: "outside-secret",
            restBaseUrl: "https://api.dingtalk.io/v1.0",
          },
        },
      });
      const outsidePath = path.join(externalDir, "outside", "config.yaml");
      const outsideBytes = fs.readFileSync(outsidePath);
      fs.symlinkSync(path.join(externalDir, "outside"), path.join(agentsDir, "linked-agent"));
      const linkedConfigDir = path.join(agentsDir, "linked-config");
      fs.mkdirSync(linkedConfigDir, { recursive: true });
      fs.symlinkSync(outsidePath, path.join(linkedConfigDir, "config.yaml"));

      runFrom46();

      expect(fs.readFileSync(outsidePath).equals(outsideBytes)).toBe(true);
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });
});

describe("migration #48: preserve stable compatible workspace skill discovery", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runFrom47(log: (line: any) => void = () => {}) {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 47 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log,
    });
    return prefs;
  }

  it("enables compatible project skills only when the new policy field is missing", () => {
    writeAgentConfig(agentsDir, "stable-no-context", {
      agent: { name: "Stable" },
      skills: { enabled: ["skill-creator"] },
      desk: { heartbeat_enabled: false },
    });
    writeAgentConfig(agentsDir, "stable-partial-context", {
      agent: { name: "Partial" },
      workspace_context: {
        inject_agents_md: true,
        discover_project_skills: false,
      },
    });
    writeAgentConfig(agentsDir, "explicit-false", {
      workspace_context: { discover_compatible_project_skills: false },
    });
    writeAgentConfig(agentsDir, "explicit-true", {
      workspace_context: { discover_compatible_project_skills: true },
    });
    const explicitBytes = new Map(["explicit-false", "explicit-true"].map((agentId) => [
      agentId,
      fs.readFileSync(path.join(agentsDir, agentId, "config.yaml")),
    ]));

    const prefs = runFrom47();

    expect(readAgentConfig(agentsDir, "stable-no-context")).toEqual({
      agent: { name: "Stable" },
      skills: { enabled: ["skill-creator"] },
      desk: { heartbeat_enabled: false },
      workspace_context: { discover_compatible_project_skills: true },
    });
    expect(readAgentConfig(agentsDir, "stable-partial-context").workspace_context).toEqual({
      inject_agents_md: true,
      discover_project_skills: false,
      discover_compatible_project_skills: true,
    });
    expect(readAgentConfig(agentsDir, "explicit-false").workspace_context.discover_compatible_project_skills).toBe(false);
    expect(readAgentConfig(agentsDir, "explicit-true").workspace_context.discover_compatible_project_skills).toBe(true);
    for (const [agentId, bytes] of explicitBytes) {
      expect(fs.readFileSync(path.join(agentsDir, agentId, "config.yaml")).equals(bytes)).toBe(true);
    }
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);

    const migratedBytes = new Map(["stable-no-context", "stable-partial-context"].map((agentId) => [
      agentId,
      fs.readFileSync(path.join(agentsDir, agentId, "config.yaml")),
    ]));
    const rerunPrefs = prefs.getPreferences();
    rerunPrefs._dataVersion = 47;
    prefs.savePreferences(rerunPrefs);
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
    for (const [agentId, bytes] of migratedBytes) {
      expect(fs.readFileSync(path.join(agentsDir, agentId, "config.yaml")).equals(bytes)).toBe(true);
    }
  });

  it("isolates malformed workspace policy data without changing explicit source bytes", () => {
    writeAgentConfig(agentsDir, "malformed", {
      agent: { name: "Malformed" },
      workspace_context: [],
    });
    writeAgentConfig(agentsDir, "good", { agent: { name: "Good" } });
    const malformedPath = path.join(agentsDir, "malformed", "config.yaml");
    const malformedBytes = fs.readFileSync(malformedPath);
    const logs: string[] = [];

    const prefs = runFrom47((line) => { logs.push(String(line)); });

    expect(fs.readFileSync(malformedPath).equals(malformedBytes)).toBe(true);
    expect(readAgentConfig(agentsDir, "good").workspace_context.discover_compatible_project_skills).toBe(true);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
    expect(logs.join("\n")).toContain("stage=workspace_context");
  });

  it("keeps the policy migration retryable when a valid Agent config cannot be written", () => {
    writeAgentConfig(agentsDir, "readonly", { agent: { name: "Readonly" } });
    const configPath = path.join(agentsDir, "readonly", "config.yaml");
    const originalBytes = fs.readFileSync(configPath);
    const originalRenameSync = fs.renameSync;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === configPath) {
        throw Object.assign(new Error("private-content-must-not-leak"), { code: "EACCES" });
      }
      return originalRenameSync(source, destination);
    });
    const logs: string[] = [];

    try {
      const prefs = runFrom47((line) => { logs.push(String(line)); });
      expect(prefs.getPreferences()._dataVersion).toBe(47);
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.readFileSync(configPath).equals(originalBytes)).toBe(true);
    expect(logs.join("\n")).toContain("stage=write, code=EACCES");
    expect(logs.join("\n")).not.toContain("private-content-must-not-leak");
  });

  it.runIf(process.platform !== "win32")("does not follow linked Agent directories or config files", () => {
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-workspace-policy-external-"));
    try {
      writeAgentConfig(externalRoot, "outside", { agent: { name: "Outside" } });
      const outsidePath = path.join(externalRoot, "outside", "config.yaml");
      const outsideBytes = fs.readFileSync(outsidePath);
      fs.symlinkSync(path.join(externalRoot, "outside"), path.join(agentsDir, "linked-agent"));
      const linkedConfigDir = path.join(agentsDir, "linked-config");
      fs.mkdirSync(linkedConfigDir, { recursive: true });
      fs.symlinkSync(outsidePath, path.join(linkedConfigDir, "config.yaml"));

      runFrom47();

      expect(fs.readFileSync(outsidePath).equals(outsideBytes)).toBe(true);
    } finally {
      fs.rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});

describe("migration #49: repair Codex OAuth model ids polluted by session event ids (#45 regression)", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeCatalog(models) {
    writeJson(path.join(tmpDir, "provider-catalog.json"), {
      catalogVersion: 2,
      providers: { "openai-codex-oauth": { api: "openai-codex-responses", models } },
      capabilities: {},
      meta: {},
    });
  }

  function migrationRegistry(defaultModels = []) {
    return {
      getDefaultModelEntries(providerId) {
        return providerId === "openai-codex-oauth" ? structuredClone(defaultModels) : [];
      },
      _entries: new Map(),
    };
  }

  function writeSessionEntries(filePath, entries) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
  }

  // 老用户已经在旧版 buggy #45 上跑过一轮升级，_dataVersion 已停在 48；
  // 本次运行只会触发 #49。
  function runFrom48(providerRegistry = migrationRegistry(), log: (line: any) => void = () => {}) {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 48 });
    runMigrations({ hanakoHome: tmpDir, agentsDir, prefs, providerRegistry, log });
    return prefs;
  }

  it("removes catalog entries only explainable as the #45 event-id bug, keeps every legitimate id", () => {
    // 污染态 fixture：catalog 混了一个无关默认(gpt-current)、两条旧版 #45 bug
    // 误收的事件 id(ff2c7bcc / deadbeef)，以及它们本该收的两个真实模型 id。
    writeCatalog(["gpt-current", "gpt-5.5", "ff2c7bcc", "gpt-5.5-mini", "deadbeef"]);

    const sessionPath = path.join(agentsDir, "hana", "sessions", "main.jsonl");
    writeSessionEntries(sessionPath, [
      {
        type: "model_change",
        id: "ff2c7bcc",
        parentId: "e0",
        timestamp: "2026-07-01T00:00:00.000Z",
        provider: "openai-codex",
        modelId: "gpt-5.5",
      },
      {
        type: "message",
        id: "e1",
        parentId: "ff2c7bcc",
        timestamp: "2026-07-01T00:00:01.000Z",
        message: { role: "assistant", id: "deadbeef", provider: "openai-codex-oauth", model: "gpt-5.5-mini" },
      },
    ]);

    const prefs = runFrom48();

    const catalog = readJson(path.join(tmpDir, "provider-catalog.json"));
    expect(catalog.providers["openai-codex-oauth"].models).toEqual(["gpt-current", "gpt-5.5", "gpt-5.5-mini"]);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);

    const backupRoot = path.join(tmpDir, "migration-backups");
    const backupDirs = fs.readdirSync(backupRoot).filter((name) => name.startsWith("codex-model-id-pollution-v49-"));
    expect(backupDirs).toHaveLength(1);
    const backupDir = path.join(backupRoot, backupDirs[0]);
    const report = readJson(path.join(backupDir, "migration-report.json"));
    expect([...report.removed].sort()).toEqual(["deadbeef", "ff2c7bcc"]);
    const backedUpCatalog = readJson(path.join(backupDir, "provider-catalog.json"));
    expect(backedUpCatalog.providers["openai-codex-oauth"].models).toEqual([
      "gpt-current", "gpt-5.5", "ff2c7bcc", "gpt-5.5-mini", "deadbeef",
    ]);

    // 幂等：重跑一遍不应再产生第二份备份或改动 catalog。
    const firstCatalogBytes = fs.readFileSync(path.join(tmpDir, "provider-catalog.json"));
    const rerunPrefs = prefs.getPreferences();
    rerunPrefs._dataVersion = 48;
    prefs.savePreferences(rerunPrefs);
    runMigrations({ hanakoHome: tmpDir, agentsDir, prefs, providerRegistry: migrationRegistry(), log: () => {} });
    expect(fs.readFileSync(path.join(tmpDir, "provider-catalog.json")).equals(firstCatalogBytes)).toBe(true);
    expect(fs.readdirSync(backupRoot).filter((name) => name.startsWith("codex-model-id-pollution-v49-"))).toHaveLength(1);
  });

  it("is a no-op on a clean catalog: no polluted ids, no backup written", () => {
    writeCatalog(["gpt-current"]);
    const before = fs.readFileSync(path.join(tmpDir, "provider-catalog.json"));

    const prefs = runFrom48();

    expect(fs.readFileSync(path.join(tmpDir, "provider-catalog.json")).equals(before)).toBe(true);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
    expect(fs.existsSync(path.join(tmpDir, "migration-backups"))).toBe(false);
  });

  it("keeps a catalog entry that collides with an event id but is also independently referenced (name collision)", () => {
    // "ff2c7bcc" 同时是一条 model_change 的事件 id(第二条记录的 entry.id)，
    // 也是另一条 model_change 真实引用过的模型 id(第一条记录的 modelId)——
    // 闭环证据法必须因为它 ∈ S_correct 而保留，不能因为它形状像事件 id 就删。
    writeCatalog(["ff2c7bcc"]);
    const sessionPath = path.join(agentsDir, "hana", "sessions", "main.jsonl");
    writeSessionEntries(sessionPath, [
      {
        type: "model_change",
        id: "e1",
        parentId: "e0",
        timestamp: "2026-07-01T00:00:00.000Z",
        provider: "openai-codex",
        modelId: "ff2c7bcc",
      },
      {
        type: "model_change",
        id: "ff2c7bcc",
        parentId: "e1",
        timestamp: "2026-07-01T00:00:01.000Z",
        provider: "openai-codex",
        modelId: "other-model",
      },
    ]);

    const prefs = runFrom48();

    const catalog = readJson(path.join(tmpDir, "provider-catalog.json"));
    expect(catalog.providers["openai-codex-oauth"].models).toEqual(["ff2c7bcc"]);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("never removes a shipped default model even if it collides with a wrongly-collected event id", () => {
    writeCatalog(["ff2c7bcc"]);
    const sessionPath = path.join(agentsDir, "hana", "sessions", "main.jsonl");
    writeSessionEntries(sessionPath, [
      {
        type: "model_change",
        id: "ff2c7bcc",
        parentId: "e0",
        timestamp: "2026-07-01T00:00:00.000Z",
        provider: "openai-codex",
        modelId: "unrelated-model",
      },
    ]);

    const prefs = runFrom48(migrationRegistry([{ id: "ff2c7bcc", name: "Coincidental Default" }]));

    const catalog = readJson(path.join(tmpDir, "provider-catalog.json"));
    expect(catalog.providers["openai-codex-oauth"].models).toEqual(["ff2c7bcc"]);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("leaves the catalog and data version untouched when the repair backup cannot be created", () => {
    writeCatalog(["ff2c7bcc"]);
    const sessionPath = path.join(agentsDir, "hana", "sessions", "main.jsonl");
    writeSessionEntries(sessionPath, [
      {
        type: "model_change",
        id: "ff2c7bcc",
        parentId: "e0",
        timestamp: "2026-07-01T00:00:00.000Z",
        provider: "openai-codex",
        modelId: "gpt-5.5",
      },
    ]);
    const catalogPath = path.join(tmpDir, "provider-catalog.json");
    const originalCatalogBytes = fs.readFileSync(catalogPath);
    fs.writeFileSync(path.join(tmpDir, "migration-backups"), "blocked", "utf-8");

    const prefs = runFrom48();

    expect(fs.readFileSync(catalogPath).equals(originalCatalogBytes)).toBe(true);
    expect(prefs.getPreferences()._dataVersion).toBe(48);
  });
});

describe("migration #50: Gemini image preview IDs converge to stable IDs", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("migrates defaults, provider model keys, catalog entries, and retryable task params", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      _dataVersion: 49,
      imageGeneration: {
        defaultImageModel: { provider: "gemini", id: "gemini-3.1-flash-image-preview" },
        providerDefaults: {
          gemini: {
            models: {
              "gemini-3.1-flash-image-preview": { resolution: "4K", inherited: true },
              "gemini-3.1-flash-image": { resolution: "2K", explicit: true },
              "gemini-3-pro-image-preview": { resolution: "4K" },
            },
          },
          custom: {
            models: {
              "gemini-3.1-flash-image-preview": { untouched: true },
            },
          },
        },
      },
    });

    writeJson(path.join(tmpDir, "plugin-data", "image-gen", "config.json"), {
      schemaVersion: 1,
      global: {
        defaultImageModel: { provider: "gemini", id: "gemini-3-pro-image-preview" },
        providerDefaults: {
          gemini: {
            models: {
              "gemini-3-pro-image-preview": { resolution: "4K" },
            },
          },
        },
      },
      agents: {},
      sessions: {},
    });

    writeJson(path.join(tmpDir, "provider-catalog.json"), {
      catalogVersion: 2,
      providers: {
        gemini: {
          media: {
            image_generation: {
              defaultModelId: "gemini-3.1-flash-image-preview",
              models: [
                { id: "gemini-3.1-flash-image-preview", legacyField: true },
                { id: "gemini-3.1-flash-image", stableField: true },
                "gemini-3-pro-image-preview",
              ],
            },
          },
        },
      },
      capabilities: {},
      meta: {},
    });

    writeJson(path.join(tmpDir, "plugin-data", "image-gen", "tasks.json"), [
      {
        taskId: "gemini-task",
        adapterId: "gemini",
        providerId: "gemini",
        modelId: "gemini-3.1-flash-image-preview",
        params: {
          providerId: "gemini",
          modelId: "gemini-3.1-flash-image-preview",
          model: "gemini-3.1-flash-image-preview",
        },
      },
      {
        taskId: "custom-task",
        adapterId: "custom",
        providerId: "custom",
        modelId: "gemini-3.1-flash-image-preview",
        params: { model: "gemini-3.1-flash-image-preview" },
      },
    ]);

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: new ProviderRegistry(tmpDir),
      log: () => {},
    });

    const nextPrefs = prefs.getPreferences();
    expect(nextPrefs._dataVersion).toBe(LATEST_DATA_VERSION);
    expect(nextPrefs.imageGeneration.defaultImageModel).toEqual({
      provider: "gemini",
      id: "gemini-3.1-flash-image",
    });
    expect(nextPrefs.imageGeneration.providerDefaults.gemini.models).toEqual({
      "gemini-3.1-flash-image": {
        resolution: "2K",
        inherited: true,
        explicit: true,
      },
      "gemini-3-pro-image": { resolution: "4K" },
    });
    expect(nextPrefs.imageGeneration.providerDefaults.custom.models).toHaveProperty(
      "gemini-3.1-flash-image-preview",
    );

    const pluginConfigPath = path.join(tmpDir, "plugin-data", "image-gen", "config.json");
    if (process.platform !== "win32") {
      expect(fs.statSync(pluginConfigPath).mode & 0o777).toBe(0o600);
    }
    const pluginConfig = readJson(pluginConfigPath);
    expect(pluginConfig.global.defaultImageModel.id).toBe("gemini-3-pro-image");
    expect(pluginConfig.global.providerDefaults.gemini.models).toEqual({
      "gemini-3-pro-image": { resolution: "4K" },
    });

    const catalog = readJson(path.join(tmpDir, "provider-catalog.json"));
    const imageCapability = catalog.providers.gemini.media.image_generation;
    expect(imageCapability.defaultModelId).toBe("gemini-3.1-flash-image");
    expect(imageCapability.models).toEqual([
      { id: "gemini-3.1-flash-image", legacyField: true, stableField: true },
      "gemini-3-pro-image",
    ]);

    const tasks = readJson(path.join(tmpDir, "plugin-data", "image-gen", "tasks.json"));
    expect(tasks[0]).toMatchObject({
      modelId: "gemini-3.1-flash-image",
      params: {
        modelId: "gemini-3.1-flash-image",
        model: "gemini-3.1-flash-image",
      },
    });
    expect(tasks[1]).toMatchObject({
      modelId: "gemini-3.1-flash-image-preview",
      params: { model: "gemini-3.1-flash-image-preview" },
    });
  });
});

describe("migration #38: direct notify automations become Agent runs", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeStudioCronJobs(studioId, jobs) {
    const deskDir = path.join(tmpDir, "studios", studioId, "desk");
    fs.mkdirSync(deskDir, { recursive: true });
    fs.writeFileSync(
      path.join(deskDir, "cron-jobs.json"),
      JSON.stringify({ jobs, nextNum: jobs.length + 1 }, null, 2) + "\n",
      "utf-8",
    );
  }

  function readStudioCronJobs(studioId) {
    return JSON.parse(fs.readFileSync(
      path.join(tmpDir, "studios", studioId, "desk", "cron-jobs.json"),
      "utf-8",
    )).jobs;
  }

  it("rewrites legacy notify direct-action jobs to agent_session executors", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 37 });
    writeStudioCronJobs("default", [{
      schemaVersion: 2,
      id: "studio_job_notify",
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "",
      label: "Drink Water",
      enabled: true,
      actorAgentId: "hana",
      executionContext: {
        kind: "session_workspace",
        cwd: "/workspace",
        workspaceFolders: [],
        sourceSessionPath: "/sessions/source.jsonl",
        createdByAgentId: "hana",
      },
      executor: {
        kind: "direct_action",
        action: "notify",
        params: {
          title: "喝水",
          body: "站起来活动一下",
          channels: ["desktop"],
        },
      },
      createdBy: { kind: "agent", agentId: "hana" },
    }]);

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistryWithModels({}),
      log: () => {},
    });

    const [job] = readStudioCronJobs("default");
    expect(job.schemaVersion).toBe(4);
    expect(job.prompt).toContain("站起来活动一下");
    expect(job.executor).toMatchObject({
      kind: "agent_session",
      agentId: "hana",
      prompt: expect.stringContaining("notify"),
      migratedFrom: {
        kind: "direct_action",
        action: "notify",
      },
    });
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #39: repair automation ownership after Agent-run consolidation", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeStudioCronJobs(studioId, jobs) {
    const deskDir = path.join(tmpDir, "studios", studioId, "desk");
    fs.mkdirSync(deskDir, { recursive: true });
    fs.writeFileSync(
      path.join(deskDir, "cron-jobs.json"),
      JSON.stringify({ jobs, nextNum: jobs.length + 1 }, null, 2) + "\n",
      "utf-8",
    );
  }

  function writeAgentCronJobs(agentId, jobs) {
    const deskDir = path.join(agentsDir, agentId, "desk");
    fs.mkdirSync(deskDir, { recursive: true });
    fs.writeFileSync(
      path.join(deskDir, "cron-jobs.json"),
      JSON.stringify({ jobs, nextNum: jobs.length + 1 }, null, 2) + "\n",
      "utf-8",
    );
  }

  function readStudioCronJobs(studioId) {
    return JSON.parse(fs.readFileSync(
      path.join(tmpDir, "studios", studioId, "desk", "cron-jobs.json"),
      "utf-8",
    )).jobs;
  }

  function readAgentCronJobs(agentId) {
    return JSON.parse(fs.readFileSync(
      path.join(agentsDir, agentId, "desk", "cron-jobs.json"),
      "utf-8",
    )).jobs;
  }

  function runMigration39() {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 38 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistryWithModels({}),
      log: () => {},
    });
    return prefs;
  }

  it("disables studio automations whose target Agent cannot be inferred", () => {
    writeStudioCronJobs("default", [{
      schemaVersion: 3,
      id: "studio_job_orphan",
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "orphan prompt",
      label: "Orphan",
      enabled: true,
      executor: {
        kind: "agent_session",
        agentId: null,
        prompt: "orphan prompt",
        model: "",
        executionContext: null,
      },
      createdBy: { kind: "unknown" },
    }]);

    const prefs = runMigration39();

    const [job] = readStudioCronJobs("default");
    expect(job.enabled).toBe(false);
    expect(job.migrationWarning).toEqual({
      code: "missing_automation_owner",
      message: "需要选择执行助手后再启用",
    });
    expect(job.executor).toMatchObject({
      kind: "agent_session",
      agentId: null,
      prompt: "orphan prompt",
    });
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("repairs studio automations when a legacyRef still identifies the source Agent", () => {
    writeStudioCronJobs("default", [{
      schemaVersion: 3,
      id: "studio_job_legacy",
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "legacy prompt",
      label: "Legacy",
      enabled: true,
      legacyRef: { agentId: "hana", jobId: "job_1" },
    }]);

    runMigration39();

    const [job] = readStudioCronJobs("default");
    expect(job.enabled).toBe(true);
    expect(job.actorAgentId).toBe("hana");
    expect(job.executionContext).toEqual({
      kind: "legacy_agent_home",
      cwd: null,
      workspaceFolders: [],
      sourceSessionPath: null,
      createdByAgentId: "hana",
    });
    expect(job.executor).toMatchObject({
      kind: "agent_session",
      agentId: "hana",
      prompt: "legacy prompt",
      executionContext: {
        kind: "legacy_agent_home",
        cwd: null,
        workspaceFolders: [],
        sourceSessionPath: null,
        createdByAgentId: "hana",
      },
    });
    expect(job.migrationWarning).toBeUndefined();
  });

  it("repairs per-agent legacy stores from the owning directory name", () => {
    writeAgentCronJobs("hana", [{
      schemaVersion: 3,
      id: "job_1",
      type: "cron",
      schedule: "0 9 * * *",
      prompt: "agent prompt",
      label: "Agent legacy",
      enabled: true,
    }]);

    runMigration39();

    const [job] = readAgentCronJobs("hana");
    expect(job.enabled).toBe(true);
    expect(job.actorAgentId).toBe("hana");
    expect(job.executionContext).toEqual({
      kind: "legacy_agent_home",
      cwd: null,
      workspaceFolders: [],
      sourceSessionPath: null,
      createdByAgentId: "hana",
    });
    expect(job.executor).toMatchObject({
      kind: "agent_session",
      agentId: "hana",
      prompt: "agent prompt",
    });
  });

  it("rewrites plugin-action jobs into background Agent runs", () => {
    const executionContext = {
      kind: "session_workspace",
      cwd: "/workspace",
      workspaceFolders: [],
      sourceSessionPath: "/sessions/source.jsonl",
      createdByAgentId: "hana",
    };
    writeStudioCronJobs("default", [{
      schemaVersion: 3,
      id: "studio_job_plugin",
      type: "cron",
      schedule: "0 18 * * *",
      prompt: "",
      label: "Daily Note",
      enabled: true,
      actorAgentId: "hana",
      executionContext,
      executor: {
        kind: "plugin_action",
        pluginId: "notes",
        actionId: "create_note",
        params: { title: "Today" },
      },
      createdBy: { kind: "agent", agentId: "hana" },
    }]);

    runMigration39();

    const [job] = readStudioCronJobs("default");
    const downgradedExecutionContext = {
      ...executionContext,
      cwd: null,
      workspaceFolders: [],
      sourceSessionPath: null,
    };
    expect(job.prompt).toContain("notes/create_note");
    expect(job.executionContext).toEqual(downgradedExecutionContext);
    expect(job.executor).toEqual({
      kind: "agent_session",
      agentId: "hana",
      prompt: job.prompt,
      model: "",
      executionContext: downgradedExecutionContext,
      migratedFrom: {
        kind: "plugin_action",
        pluginId: "notes",
        actionId: "create_note",
      },
    });
  });
});

describe("migration #31: learned skills converge into the global skill pool", () => {
  let tmpDir, agentsDir, userDir, skillsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeSkill(dir, content) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf-8");
  }

  it("moves each agent learned skill into the global pool and enables only the source agent", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 30 });
    writeAgentConfig(agentsDir, "agent-a", {
      agent: { name: "Agent A" },
      skills: { enabled: ["existing"] },
    });
    writeAgentConfig(agentsDir, "agent-b", {
      agent: { name: "Agent B" },
      skills: { enabled: [] },
    });

    const sharedContent = "---\nname: shared-skill\n---\n# Shared\n";
    writeSkill(path.join(skillsDir, "shared-skill"), sharedContent);
    writeSkill(path.join(agentsDir, "agent-a", "learned-skills", "shared-skill"), sharedContent);
    writeSkill(
      path.join(agentsDir, "agent-b", "learned-skills", "shared-skill"),
      "---\nname: shared-skill\n---\n# Different\n",
    );
    writeSkill(
      path.join(agentsDir, "agent-b", "learned-skills", "solo-skill"),
      "---\nname: solo-skill\nmetadata:\n  default-enabled: true\n---\n# Solo\n",
    );

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistryWithModels({}),
      log: () => {},
    });

    expect(fs.existsSync(path.join(agentsDir, "agent-a", "learned-skills"))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, "agent-b", "learned-skills"))).toBe(false);
    expect(fs.readFileSync(path.join(skillsDir, "shared-skill", "SKILL.md"), "utf-8")).toBe(sharedContent);

    const renamedPath = path.join(skillsDir, "shared-skill-agent-b", "SKILL.md");
    expect(fs.existsSync(renamedPath)).toBe(true);
    expect(fs.readFileSync(renamedPath, "utf-8")).toContain("name: shared-skill-agent-b");
    expect(fs.readFileSync(renamedPath, "utf-8")).toContain("default-enabled: false");

    const soloPath = path.join(skillsDir, "solo-skill", "SKILL.md");
    expect(fs.existsSync(soloPath)).toBe(true);
    expect(fs.readFileSync(soloPath, "utf-8")).toContain("default-enabled: false");

    expect(readAgentConfig(agentsDir, "agent-a").skills.enabled).toEqual(["existing", "shared-skill"]);
    expect(readAgentConfig(agentsDir, "agent-b").skills.enabled).toEqual([
      "shared-skill-agent-b",
      "solo-skill",
    ]);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #12: backfill legacy session files into sidecars", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration12() {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 11 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistryWithModels({}),
      log: () => {},
    });
    return prefs;
  }

  it("registers legacy stage_files and artifacts without rewriting the session jsonl", () => {
    writeAgentConfig(agentsDir, "hana", { agent: { name: "Hana" } });
    const sessionPath = path.join(agentsDir, "hana", "sessions", "legacy.jsonl");
    const stagePath = path.join(tmpDir, "legacy-image.png");
    const presentPath = path.join(tmpDir, "legacy-present.txt");
    const artifactPath = path.join(tmpDir, "legacy-artifact.md");
    fs.writeFileSync(stagePath, "png-bytes");
    fs.writeFileSync(presentPath, "present");
    fs.writeFileSync(artifactPath, "# Artifact\n");
    writeSessionJsonl(sessionPath, [
      {
        role: "toolResult",
        toolName: "stage_files",
        details: { files: [{ filePath: stagePath, label: "Legacy Image" }] },
      },
      {
        role: "toolResult",
        toolName: "present_files",
        details: { filePath: presentPath, label: "Legacy Present" },
      },
      {
        role: "toolResult",
        toolName: "create_artifact",
        details: {
          artifactId: "art-old",
          type: "markdown",
          title: "Legacy Artifact",
          content: "# Artifact",
          artifactFile: { filePath: artifactPath, label: "Legacy Artifact.md" },
        },
      },
    ]);

    const before = fs.readFileSync(sessionPath, "utf-8");
    const prefs = runMigration12();

    const sidecar = JSON.parse(fs.readFileSync(`${sessionPath}.files.json`, "utf-8"));
    const files = Object.values(sidecar.files);
    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: stagePath, origin: "stage_files", status: "available" }),
      expect.objectContaining({ filePath: presentPath, origin: "stage_files", status: "available" }),
      expect.objectContaining({ filePath: artifactPath, origin: "agent_artifact", status: "available" }),
    ]));
    expect(fs.readFileSync(sessionPath, "utf-8")).toBe(before);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("materializes legacy inline browser screenshots as managed session images", () => {
    writeAgentConfig(agentsDir, "hana", { agent: { name: "Hana" } });
    const sessionPath = path.join(agentsDir, "hana", "sessions", "browser.jsonl");
    const base64 = Buffer.from("SCREENSHOT_BYTES").toString("base64");
    writeSessionJsonl(sessionPath, [
      {
        role: "toolResult",
        toolName: "browser",
        content: [{ type: "image", data: base64, mimeType: "image/png" }],
        details: { action: "screenshot", mimeType: "image/png", thumbnail: base64 },
      },
    ]);

    runMigration12();

    const sidecar = JSON.parse(fs.readFileSync(`${sessionPath}.files.json`, "utf-8"));
    const files = Object.values(sidecar.files);
    expect(files).toEqual([
      expect.objectContaining({
        origin: "browser_screenshot",
        storageKind: "managed_cache",
        kind: "image",
        status: "available",
      }),
    ]);
    expect((files[0] as any).filePath).toContain(path.join(tmpDir, "session-files"));
    expect(fs.existsSync((files[0] as any).filePath)).toBe(true);
  });
});

describe("migration #13: normalize recent legacy compatibility state", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration13() {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 12 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistryWithModels({
        deepseek: {
          models: ["deepseek-v4-pro", "deepseek-v4-flash"],
          defaultModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
        },
      }),
      log: () => {},
    });
    return prefs;
  }

  function writeAddedModelsYaml(providers) {
    fs.writeFileSync(
      path.join(tmpDir, "added-models.yaml"),
      YAML.dump({ providers }, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
      "utf-8",
    );
  }

  function readAddedModelsYaml() {
    return YAML.load(fs.readFileSync(path.join(tmpDir, "added-models.yaml"), "utf-8"));
  }

  it("removes the reserved official DeepSeek provider id from legacy model lists", () => {
    writeAddedModelsYaml({
      deepseek: {
        base_url: "https://api.deepseek.com/v1",
        api_key: "sk-test",
        models: ["deepseek", "deepseek-v4-pro", { id: "deepseek-v4-flash", reasoning: true }],
      },
      openrouter: {
        base_url: "https://openrouter.ai/api/v1",
        api_key: "sk-test",
        models: ["deepseek"],
      },
    });

    const prefs = runMigration13();

    const raw = readAddedModelsYaml();
    expect(raw.providers.deepseek.models).toEqual([
      "deepseek-v4-pro",
      { id: "deepseek-v4-flash", reasoning: true },
    ]);
    expect(raw.providers.openrouter.models).toEqual(["deepseek"]);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("seeds DeepSeek defaults when the reserved model id was the only legacy entry", () => {
    writeAddedModelsYaml({
      "deepseek-official-proxy": {
        base_url: "https://api.deepseek.com/v1",
        api_key: "sk-test",
        models: [{ id: "deepseek" }],
      },
    });

    runMigration13();

    const raw = readAddedModelsYaml();
    expect(raw.providers["deepseek-official-proxy"].models).toEqual([
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]);
  });

  it("makes legacy implicit memory master defaults explicit without overriding user choices", () => {
    writeAgentConfig(agentsDir, "legacy", {
      agent: { name: "Legacy" },
      memory: { token_budget: 2500 },
    });
    writeAgentConfig(agentsDir, "explicit-off", {
      agent: { name: "Explicit Off" },
      memory: { enabled: false, token_budget: 1000 },
    });
    writeAgentConfig(agentsDir, "explicit-on", {
      agent: { name: "Explicit On" },
      memory: { enabled: true },
    });

    runMigration13();

    expect(readAgentConfig(agentsDir, "legacy").memory).toEqual({
      token_budget: 2500,
      enabled: true,
    });
    expect(readAgentConfig(agentsDir, "explicit-off").memory).toEqual({
      enabled: false,
      token_budget: 1000,
    });
    expect(readAgentConfig(agentsDir, "explicit-on").memory).toEqual({ enabled: true });
  });
});

// ── 迁移 #1：清理悬空 provider 引用 ─────────────────────────────────────────

describe("migration #1: cleanDanglingProviderRefs", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("清空指向不存在 provider 的 api.provider", () => {
    writeAgentConfig(agentsDir, "hana", {
      api: { provider: "dead-provider" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.api.provider).toBe("");
  });

  it("保留指向存在 provider 的引用", () => {
    writeAgentConfig(agentsDir, "hana", {
      api: { provider: "openai" },
      models: { chat: "openai/gpt-4o" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.api.provider).toBe("openai");
    expect(config.models.chat).toEqual({ id: "gpt-4o", provider: "openai" });
  });

  it("清空 models.chat 中 provider/model 格式的悬空引用", () => {
    writeAgentConfig(agentsDir, "hana", {
      models: { chat: "minimax-token_plan/minimax-large", utility: "openai/gpt-4o-mini" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.models.chat).toBe("");
    expect(config.models.utility).toEqual({ id: "gpt-4o-mini", provider: "openai" });
  });

  it("清空 models.chat 中 {id, provider} 对象格式的悬空引用", () => {
    writeAgentConfig(agentsDir, "hana", {
      models: { chat: { id: "some-model", provider: "dead-provider" } },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.models.chat).toBe("");
  });

  it("清空 embedding_api.provider 的悬空引用", () => {
    writeAgentConfig(agentsDir, "hana", {
      embedding_api: { provider: "dead" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.embedding_api.provider).toBe("");
  });

  it("清空 preferences 中悬空的共享模型引用", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      utility_large_model: { id: "some-model", provider: "dead" },
      utility_api_provider: "also-dead",
    });
    fs.mkdirSync(agentsDir, { recursive: true });

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const p = prefs.getPreferences();
    expect(p.utility_large_model).toBeNull();
    expect(p.utility_api_provider).toBeNull();
  });

  it("preferences 中字符串格式的悬空共享模型也被清空", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      utility_model: "dead-provider/fast-model",
    });
    fs.mkdirSync(agentsDir, { recursive: true });

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const p = prefs.getPreferences();
    expect(p.utility_model).toBeNull();
  });

  it("多个 agent 同时修复", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "dead" } });
    writeAgentConfig(agentsDir, "butter", { api: { provider: "openai" } });
    writeAgentConfig(agentsDir, "xiaohua", {
      api: { provider: "dead" },
      models: { chat: "dead/model" },
    });
    const prefs = makePrefs(userDir);

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    expect(readAgentConfig(agentsDir, "hana").api.provider).toBe("");
    expect(readAgentConfig(agentsDir, "butter").api.provider).toBe("openai");
    expect(readAgentConfig(agentsDir, "xiaohua").api.provider).toBe("");
    expect(readAgentConfig(agentsDir, "xiaohua").models.chat).toBe("");
  });
});

// ── 迁移 #2：bridge 配置从全局 prefs 迁移到 per-agent config.yaml ──────────

describe("migration #2: migrateBridgeToPerAgent", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /** 跳过 migration #1 直接测 #2：把 _dataVersion 设为 1 */
  function runMigration2(prefs) {
    const p = prefs.getPreferences();
    p._dataVersion = 1;
    prefs.savePreferences(p);

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
  }

  it("基本迁移：单 agent，telegram + owner → config.yaml bridge 区块", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      bridge: {
        telegram: { token: "tok123", webhook: true },
        owner: { telegram: "user-001" },
        readOnly: false,
      },
    });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.bridge.telegram.token).toBe("tok123");
    expect(config.bridge.telegram.webhook).toBe(true);
    expect(config.bridge.telegram.owner).toBe("user-001");

    // prefs.bridge should be deleted
    const p = prefs.getPreferences();
    expect(p.bridge).toBeUndefined();
  });

  it("多 agent 分组：telegram→agent-a，feishu→agent-b", () => {
    writeAgentConfig(agentsDir, "agent-a", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "agent-b", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "agent-a",
      bridge: {
        telegram: { token: "tg-tok", agentId: "agent-a" },
        feishu: { appId: "fs-app", agentId: "agent-b" },
        owner: {},
        readOnly: false,
      },
    });

    runMigration2(prefs);

    const cfgA = readAgentConfig(agentsDir, "agent-a");
    const cfgB = readAgentConfig(agentsDir, "agent-b");

    expect(cfgA.bridge.telegram.token).toBe("tg-tok");
    expect(cfgA.bridge.telegram.agentId).toBeUndefined(); // agentId stripped
    expect(cfgA.bridge.feishu).toBeUndefined();

    expect(cfgB.bridge.feishu.appId).toBe("fs-app");
    expect(cfgB.bridge.feishu.agentId).toBeUndefined();
    expect(cfgB.bridge.telegram).toBeUndefined();
  });

  it("preserves explicit global bridge permission mode while moving platform config to agents", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      bridge: {
        permissionMode: "operate",
        receiptEnabled: false,
        richStreamingEnabled: false,
        telegram: { token: "tok123" },
      },
    });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.bridge.telegram.token).toBe("tok123");
    expect(prefs.getPreferences().bridge).toEqual({
      permissionMode: "operate",
      receiptEnabled: false,
      richStreamingEnabled: false,
    });
  });

  it("legacy owner key：owner.telegram（无 composite）→ 归入 primary agent", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      bridge: {
        telegram: { token: "tok" },
        owner: { telegram: "legacy-owner" },
      },
    });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.bridge.telegram.owner).toBe("legacy-owner");
  });

  it("composite owner key：owner['telegram:agent-a'] → 归入 agent-a", () => {
    writeAgentConfig(agentsDir, "agent-a", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "agent-a",
      bridge: {
        telegram: { token: "tok", agentId: "agent-a" },
        owner: {
          telegram: "legacy-owner",
          "telegram:agent-a": "composite-owner",
        },
      },
    });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "agent-a");
    // composite key takes priority over legacy key
    expect(config.bridge.telegram.owner).toBe("composite-owner");
  });

  it("无 bridge 配置 → no-op", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ primaryAgent: "hana" });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.bridge).toBeUndefined();

    const p = prefs.getPreferences();
    expect(p.bridge).toBeUndefined();
  });

  it("agentId 指向已删除 agent → 回退到 primaryAgent", () => {
    // agent-a does NOT exist, only hana exists
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      bridge: {
        telegram: { token: "tok", agentId: "deleted-agent" },
        owner: {},
      },
    });

    runMigration2(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.bridge.telegram.token).toBe("tok");
    expect(config.bridge.telegram.agentId).toBeUndefined();
  });

  it("保留 bridge.readOnly 为全局偏好，不再写入 agent config", () => {
    writeAgentConfig(agentsDir, "primary", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "secondary", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "primary",
      bridge: {
        telegram: { token: "tg", agentId: "primary" },
        feishu: { appId: "fs", agentId: "secondary" },
        owner: {},
        readOnly: true,
      },
    });

    runMigration2(prefs);

    const cfgPrimary = readAgentConfig(agentsDir, "primary");
    const cfgSecondary = readAgentConfig(agentsDir, "secondary");

    expect(cfgPrimary.bridge.readOnly).toBeUndefined();
    expect(cfgSecondary.bridge.readOnly).toBeUndefined();
    expect(prefs.getPreferences().bridge?.readOnly).toBe(true);
  });
});

// ── 迁移 #3：workspace (home_folder) 从全局 prefs 迁移到 per-agent config ───

describe("migration #3 — migrateWorkspaceToPerAgent", () => {
  let tmpDir, userDir, agentsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration3(prefs) {
    const p = prefs.getPreferences();
    p._dataVersion = 2;
    prefs.savePreferences(p);
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
  }

  it("migrates home_folder to primary agent config.yaml", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/Users/test/Desktop",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.desk.home_folder).toBe("/Users/test/Desktop");

    const p = prefs.getPreferences();
    expect(p.home_folder).toBeUndefined();
    expect(p._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("skips when home_folder is empty", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ primaryAgent: "hana", _dataVersion: 2 });

    runMigration3(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.desk.heartbeat_enabled).toBe(false);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("falls back to first agent when primaryAgent not found", () => {
    writeAgentConfig(agentsDir, "alpha", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "deleted-agent",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    const config = readAgentConfig(agentsDir, "alpha");
    expect(config.desk.home_folder).toBe("/workspace");
    expect(prefs.getPreferences().home_folder).toBeUndefined();
  });

  it("does not write home_folder to non-primary agents, but disables their heartbeat", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "assistant", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    const hanaConfig = readAgentConfig(agentsDir, "hana");
    const assistantConfig = readAgentConfig(agentsDir, "assistant");
    expect(hanaConfig.desk.home_folder).toBe("/workspace");
    expect(assistantConfig.desk.home_folder).toBeUndefined();
    expect(assistantConfig.desk.heartbeat_enabled).toBe(false);
  });

  it("preserves data when no agent config.yaml exists (version stays at 2)", () => {
    fs.mkdirSync(path.join(agentsDir, "hana"), { recursive: true });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    // migration #3 throws internally; runner catches it and breaks without bumping version
    runMigration3(prefs);

    const p = prefs.getPreferences();
    expect(p.home_folder).toBe("/workspace");
    expect(p._dataVersion).toBe(2);
  });

  it("is idempotent — rerun after success is a no-op", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);

    // Manually reset _dataVersion to 2 to simulate forced rerun
    const p2 = prefs.getPreferences();
    p2._dataVersion = 2;
    prefs.savePreferences(p2);
    runMigration3(prefs);

    // home_folder is gone from prefs, so migration skips cleanly
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
    const config = readAgentConfig(agentsDir, "hana");
    expect(config.desk.home_folder).toBe("/workspace");
  });

  it("preserves existing desk fields when merging home_folder", () => {
    writeAgentConfig(agentsDir, "hana", {
      api: { provider: "" },
      desk: { heartbeat_enabled: false, heartbeat_interval: 30 },
    });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    const config = readAgentConfig(agentsDir, "hana");
    expect(config.desk.home_folder).toBe("/workspace");
    expect(config.desk.heartbeat_enabled).toBe(false);
    expect(config.desk.heartbeat_interval).toBe(30);
  });

  it("disables heartbeat for non-primary agents", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "assistant", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "research", { api: { provider: "" } });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    // Primary agent also gets the product default made explicit by migration #29
    const hanaConfig = readAgentConfig(agentsDir, "hana");
    expect(hanaConfig.desk.heartbeat_enabled).toBe(false);

    // Non-primary agents get heartbeat disabled
    const assistantConfig = readAgentConfig(agentsDir, "assistant");
    expect(assistantConfig.desk.heartbeat_enabled).toBe(false);

    const researchConfig = readAgentConfig(agentsDir, "research");
    expect(researchConfig.desk.heartbeat_enabled).toBe(false);
  });

  it("respects existing heartbeat_enabled on non-primary agents", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    writeAgentConfig(agentsDir, "assistant", {
      api: { provider: "" },
      desk: { heartbeat_enabled: true },
    });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      primaryAgent: "hana",
      home_folder: "/workspace",
      _dataVersion: 2,
    });

    runMigration3(prefs);

    // User explicitly set heartbeat_enabled=true → migration respects it
    const assistantConfig = readAgentConfig(agentsDir, "assistant");
    expect(assistantConfig.desk.heartbeat_enabled).toBe(true);
  });
});

// ── 迁移 #9：bridge.readOnly 从 per-agent 收敛到全局 prefs ──────────────────

describe("migration #9 — migrateBridgeReadOnlyToGlobal", () => {
  let tmpDir, userDir, agentsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration9(prefs) {
    const p = prefs.getPreferences();
    p._dataVersion = 8;
    prefs.savePreferences(p);

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
  }

  it("lifts any agent-level bridge.readOnly into preferences and removes stale agent fields", () => {
    writeAgentConfig(agentsDir, "agent-a", {
      api: { provider: "" },
      bridge: {
        readOnly: true,
        telegram: { token: "tg-a" },
      },
    });
    writeAgentConfig(agentsDir, "agent-b", {
      api: { provider: "" },
      bridge: {
        readOnly: false,
        feishu: { appId: "fs-b" },
      },
    });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({});

    runMigration9(prefs);

    expect(prefs.getPreferences().bridge?.readOnly).toBe(true);

    const cfgA = readAgentConfig(agentsDir, "agent-a");
    const cfgB = readAgentConfig(agentsDir, "agent-b");
    expect(cfgA.bridge.readOnly).toBeUndefined();
    expect(cfgB.bridge.readOnly).toBeUndefined();
    expect(cfgA.bridge.telegram).toEqual({ token: "tg-a" });
    expect(cfgB.bridge.feishu).toEqual({ appId: "fs-b" });
  });
});

describe("migration #4 — migrateSubagentExecutorMetadata", () => {
  let tmpDir, userDir, agentsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration4(prefs) {
    const p = prefs.getPreferences();
    p._dataVersion = 3;
    prefs.savePreferences(p);
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
  }

  it("migrates explicit delegated executor metadata into parent session history and child sidecar", () => {
    writeAgentConfig(agentsDir, "hanako", { agent: { name: "Hanako" }, api: { provider: "" } });
    writeAgentConfig(agentsDir, "butter", { agent: { name: "butter" }, api: { provider: "" } });
    const prefs = makePrefs(userDir);
    const parentSessionPath = path.join(agentsDir, "hanako", "sessions", "parent.jsonl");
    const childSessionPath = path.join(agentsDir, "hanako", "subagent-sessions", "child.jsonl");

    writeSessionJsonl(parentSessionPath, [
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "delegate to butter",
          agentId: "butter",
          agentName: "butter",
          sessionPath: childSessionPath,
          streamStatus: "done",
        },
      },
    ]);
    fs.mkdirSync(path.dirname(childSessionPath), { recursive: true });
    fs.writeFileSync(childSessionPath, "", "utf-8");

    runMigration4(prefs);

    const entries = readSessionJsonl(parentSessionPath);
    const details = entries[1].message.details;
    expect(details.executorAgentId).toBe("butter");
    expect(details.executorAgentNameSnapshot).toBe("butter");
    expect(details.executorMetaVersion).toBe(1);

    const sidecar = JSON.parse(fs.readFileSync(path.join(path.dirname(childSessionPath), "session-meta.json"), "utf-8"));
    expect(sidecar["child.jsonl"]).toMatchObject({
      executorAgentId: "butter",
      executorAgentNameSnapshot: "butter",
      executorMetaVersion: 1,
    });
  });

  it("backfills legacy self-dispatch records from the owning agent directory when executor metadata is missing", () => {
    writeAgentConfig(agentsDir, "hanako", { agent: { name: "Hanako" }, api: { provider: "" } });
    const prefs = makePrefs(userDir);
    const parentSessionPath = path.join(agentsDir, "hanako", "sessions", "parent.jsonl");
    const childSessionPath = path.join(agentsDir, "hanako", "subagent-sessions", "child.jsonl");

    writeSessionJsonl(parentSessionPath, [
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "self-dispatch legacy task",
          sessionPath: childSessionPath,
          streamStatus: "done",
        },
      },
    ]);
    fs.mkdirSync(path.dirname(childSessionPath), { recursive: true });
    fs.writeFileSync(childSessionPath, "", "utf-8");

    runMigration4(prefs);

    const entries = readSessionJsonl(parentSessionPath);
    const details = entries[1].message.details;
    expect(details.executorAgentId).toBe("hanako");
    expect(details.executorAgentNameSnapshot).toBe("Hanako");
    expect(details.agentId).toBe("hanako");
    expect(details.agentName).toBe("Hanako");

    const sidecar = JSON.parse(fs.readFileSync(path.join(path.dirname(childSessionPath), "session-meta.json"), "utf-8"));
    expect(sidecar["child.jsonl"]).toMatchObject({
      executorAgentId: "hanako",
      executorAgentNameSnapshot: "Hanako",
      executorMetaVersion: 1,
    });
  });
});

// ── 迁移 #7：模型能力字段 vision → image 重命名 ─────────────────────────────

describe("#7 migrateVisionToImage", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = tmpDir; // hanakoHome 根目录，模拟 added-models.yaml 所在位置
    fs.mkdirSync(agentsDir, { recursive: true });
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration7(prefs) {
    prefs.savePreferences({ _dataVersion: 6 });  // 跳过 #1-#6，直接测 #7
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
  }

  function writeAddedModelsYaml(providers) {
    const data = { providers };
    fs.writeFileSync(
      path.join(tmpDir, "added-models.yaml"),
      YAML.dump(data, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
      "utf-8",
    );
  }
  function readAddedModelsYaml() {
    return YAML.load(fs.readFileSync(path.join(tmpDir, "added-models.yaml"), "utf-8"));
  }

  it("重命名 added-models.yaml 里 model 对象的 vision 字段为 image", () => {
    const prefs = makePrefs(userDir);
    writeAddedModelsYaml({
      dashscope: {
        base_url: "https://x.y/v1",
        api_key: "sk-x",
        models: [
          { id: "qwen3-max", vision: true, reasoning: true },
          { id: "qwen-plus", vision: false },
          "qwen-turbo",  // 裸字符串条目，不应报错
        ],
      },
    });

    runMigration7(prefs);

    const raw = readAddedModelsYaml();
    const models = raw.providers.dashscope.models;
    expect(models[0]).toEqual({ id: "qwen3-max", image: true, reasoning: true });
    expect(models[0].vision).toBeUndefined();
    expect(models[1]).toEqual({ id: "qwen-plus", image: false });
    expect(models[2]).toBe("qwen-turbo");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("幂等：已迁移过的 added-models.yaml 重跑不改写", () => {
    const prefs = makePrefs(userDir);
    writeAddedModelsYaml({
      dashscope: {
        base_url: "https://x.y/v1",
        api_key: "sk-x",
        models: [{ id: "qwen3-max", image: true }],
      },
    });

    runMigration7(prefs);

    const raw = readAddedModelsYaml();
    expect(raw.providers.dashscope.models[0]).toEqual({ id: "qwen3-max", image: true });
  });

  it("image 已存在时不覆盖，但仍删除残留 vision", () => {
    const prefs = makePrefs(userDir);
    writeAddedModelsYaml({
      dashscope: {
        base_url: "https://x.y/v1",
        api_key: "sk-x",
        models: [{ id: "qwen3-max", image: true, vision: false }],
      },
    });

    runMigration7(prefs);

    const raw = readAddedModelsYaml();
    expect(raw.providers.dashscope.models[0]).toEqual({ id: "qwen3-max", image: true });
  });

  it("兜底处理 agent config.yaml 的 models.overrides 残留", () => {
    const prefs = makePrefs(userDir);
    writeAgentConfig(agentsDir, "hana", {
      models: {
        overrides: {
          "qwen3-max": { vision: true, reasoning: false, displayName: "Qwen" },
          "deepseek-chat": { vision: false },
        },
      },
    });

    runMigration7(prefs);

    const cfg = readAgentConfig(agentsDir, "hana");
    expect(cfg.models.overrides["qwen3-max"]).toEqual({ image: true, reasoning: false, displayName: "Qwen" });
    expect(cfg.models.overrides["deepseek-chat"]).toEqual({ image: false });
  });

  it("added-models.yaml 不存在时不报错，_dataVersion 推进", () => {
    const prefs = makePrefs(userDir);
    // 不写 added-models.yaml 也不写任何 agent config

    runMigration7(prefs);

    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #14: migrate Gemini OpenAI compatibility configs to native Google API", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = tmpDir;
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration14(prefs) {
    prefs.savePreferences({ _dataVersion: 13 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
  }

  function writeAddedModelsYaml(providers) {
    fs.writeFileSync(
      path.join(tmpDir, "added-models.yaml"),
      YAML.dump({ providers }, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
      "utf-8",
    );
  }

  function readAddedModelsYaml() {
    return YAML.load(fs.readFileSync(path.join(tmpDir, "added-models.yaml"), "utf-8"));
  }

  it("rewrites official Gemini OpenAI endpoint configs to the native Google API", () => {
    const prefs = makePrefs(userDir);
    writeAddedModelsYaml({
      gemini: {
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai/",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["gemini-3.1-pro-preview"],
      },
    });

    runMigration14(prefs);

    const raw = readAddedModelsYaml();
    expect(raw.providers.gemini.base_url).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(raw.providers.gemini.api).toBe("google-generative-ai");
    expect(raw.providers.gemini.models).toEqual(["gemini-3.1-pro-preview"]);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("also repairs custom aliases that point directly at the official Gemini OpenAI endpoint", () => {
    const prefs = makePrefs(userDir);
    writeAddedModelsYaml({
      "my-gemini": {
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        api_key: "sk-test",
        models: ["gemini-3-flash-preview"],
      },
      "proxy-gemini": {
        base_url: "https://proxy.example.com/v1/openai",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["gemini-3-flash-preview"],
      },
    });

    runMigration14(prefs);

    const raw = readAddedModelsYaml();
    expect(raw.providers["my-gemini"].base_url).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(raw.providers["my-gemini"].api).toBe("google-generative-ai");
    expect(raw.providers["proxy-gemini"].base_url).toBe("https://proxy.example.com/v1/openai");
    expect(raw.providers["proxy-gemini"].api).toBe("openai-completions");
  });
});

describe("migration #15: repair legacy session sidecar thinking levels", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = tmpDir;
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration15(prefs) {
    prefs.savePreferences({ _dataVersion: 14 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
  }

  function writeSessionMeta(agentId, meta) {
    const sessionDir = path.join(agentsDir, agentId, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify(meta, null, 2) + "\n",
      "utf-8",
    );
  }

  function readSessionMeta(agentId) {
    return JSON.parse(fs.readFileSync(path.join(agentsDir, agentId, "sessions", "session-meta.json"), "utf-8"));
  }

  it("downgrades prompt-snapshotted xhigh entries when xhigh support cannot be proven", () => {
    const prefs = makePrefs(userDir);
    const originalMeta = {
      "legacy-xhigh.jsonl": {
        thinkingLevel: "xhigh",
        memoryEnabled: true,
        workspaceFolders: ["/tmp/project"],
        promptSnapshot: {
          version: 1,
          systemPrompt: "frozen prompt",
          appendSystemPrompt: [],
          skillsResult: { skills: [], diagnostics: [] },
          agentsFilesResult: { agentsFiles: [] },
        },
      },
      "known-xhigh-model.jsonl": {
        thinkingLevel: "xhigh",
        model: { id: "gpt-5.4-thinking", provider: "openai" },
        promptSnapshot: {
          version: 1,
          systemPrompt: "frozen prompt",
          appendSystemPrompt: [],
          skillsResult: { skills: [], diagnostics: [] },
          agentsFilesResult: { agentsFiles: [] },
        },
      },
      "live-session.jsonl": {
        thinkingLevel: "xhigh",
      },
      "already-high.jsonl": {
        thinkingLevel: "high",
        promptSnapshot: {
          version: 1,
          systemPrompt: "frozen prompt",
          appendSystemPrompt: [],
          skillsResult: { skills: [], diagnostics: [] },
          agentsFilesResult: { agentsFiles: [] },
        },
      },
    };
    writeSessionMeta("hana", originalMeta);

    runMigration15(prefs);

    const meta = readSessionMeta("hana");
    expect(meta["legacy-xhigh.jsonl"]).toMatchObject({
      thinkingLevel: "high",
      memoryEnabled: true,
      workspaceFolders: ["/tmp/project"],
    });
    expect(meta["legacy-xhigh.jsonl"].promptSnapshot.systemPrompt).toBe("frozen prompt");
    expect(meta["known-xhigh-model.jsonl"].thinkingLevel).toBe("xhigh");
    expect(meta["live-session.jsonl"].thinkingLevel).toBe("xhigh");
    expect(meta["already-high.jsonl"].thinkingLevel).toBe("high");

    const backupPath = path.join(agentsDir, "hana", "sessions", "session-meta.json.pre-v15.bak");
    expect(JSON.parse(fs.readFileSync(backupPath, "utf-8"))).toEqual(originalMeta);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #16: video capability projection", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = tmpDir;
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration16(prefs) {
    prefs.savePreferences({ _dataVersion: 15 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistryWithModels({
        dashscope: { models: [{ id: "qwen3-vl-plus" }] },
      }),
      log: () => {},
    });
  }

  it("repairs stale models.json input arrays for known video-capable models", () => {
    const prefs = makePrefs(userDir);
    const modelsJsonPath = path.join(tmpDir, "models.json");
    fs.writeFileSync(modelsJsonPath, JSON.stringify({
      providers: {
        dashscope: {
          models: [
            { id: "qwen3-vl-plus", input: ["text", "image"] },
            { id: "qwen-plus", input: ["text"] },
          ],
        },
      },
    }, null, 2) + "\n", "utf-8");

    runMigration16(prefs);

    const raw = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(raw.providers.dashscope.models[0].input).toEqual(["text", "image"]);
    expect(raw.providers.dashscope.models[0].compat.hanaVideoInput).toBe(true);
    expect(raw.providers.dashscope.models[0]).not.toHaveProperty("video");
    expect(raw.providers.dashscope.models[1].input).toEqual(["text"]);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("promotes legacy agent model override video flags into added-models.yaml", () => {
    const prefs = makePrefs(userDir);
    fs.writeFileSync(
      path.join(tmpDir, "added-models.yaml"),
      YAML.dump({
        providers: {
          dashscope: {
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            api_key: "sk-x",
            models: ["qwen3-vl-plus"],
          },
        },
      }, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
      "utf-8",
    );
    writeAgentConfig(agentsDir, "hana", {
      models: {
        overrides: {
          "qwen3-vl-plus": { video: true, displayName: "Qwen VL" },
        },
      },
    });

    runMigration16(prefs);

    const raw = YAML.load(fs.readFileSync(path.join(tmpDir, "added-models.yaml"), "utf-8"));
    expect(raw.providers.dashscope.models[0]).toEqual({ id: "qwen3-vl-plus", video: true });
    const cfg = readAgentConfig(agentsDir, "hana");
    expect(cfg.models.overrides["qwen3-vl-plus"]).toEqual({ displayName: "Qwen VL" });
  });
});

describe("migration #20: Pi model input schema compatibility", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = tmpDir;
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration20(prefs) {
    prefs.savePreferences({ _dataVersion: 19 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistryWithModels({}),
      log: () => {},
    });
  }

  it("removes invalid Pi input modalities and preserves Hana video capability in compat", async () => {
    const prefs = makePrefs(userDir);
    const modelsJsonPath = path.join(tmpDir, "models.json");
    fs.writeFileSync(modelsJsonPath, JSON.stringify({
      providers: {
        dashscope: {
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          api: "openai-completions",
          apiKey: "sk-test",
          models: [
            { id: "qwen3-vl-plus", name: "Qwen VL", input: ["text", "image", "video"] },
            { id: "qwen-plus", name: "Qwen Plus", input: ["text", "audio"] },
            { id: "custom-video", name: "Custom Video", input: ["video"], video: true },
          ],
          modelOverrides: {
            "qwen3-vl-plus": { input: ["text", "image", "video"] },
            "qwen-plus": { input: ["text", "audio"] },
          },
        },
      },
    }, null, 2) + "\n", "utf-8");

    runMigration20(prefs);

    const raw = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(raw.providers.dashscope.models[0]).toMatchObject({
      id: "qwen3-vl-plus",
      input: ["text", "image"],
      compat: { hanaVideoInput: true },
    });
    expect(raw.providers.dashscope.models[1]).toMatchObject({
      id: "qwen-plus",
      input: ["text"],
    });
    expect(raw.providers.dashscope.models[1].compat?.hanaVideoInput).toBeUndefined();
    expect(raw.providers.dashscope.models[2]).toMatchObject({
      id: "custom-video",
      input: ["text"],
      compat: { hanaVideoInput: true },
    });
    expect(raw.providers.dashscope.models[2]).not.toHaveProperty("video");
    expect(raw.providers.dashscope.modelOverrides["qwen3-vl-plus"]).toMatchObject({
      input: ["text", "image"],
      compat: { hanaVideoInput: true },
    });
    expect(raw.providers.dashscope.modelOverrides["qwen-plus"]).toEqual({
      input: ["text"],
    });

    const { AuthStorage, createModelRegistry } = await import("../lib/pi-sdk/index.ts");
    const registry = createModelRegistry(new (AuthStorage as any)(tmpDir), modelsJsonPath);
    const available = await registry.getAvailable();
    expect(available.map((model) => model.id)).toEqual(["qwen3-vl-plus", "qwen-plus", "custom-video"]);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #21: video transport capability refresh", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = tmpDir;
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runMigration21(prefs) {
    prefs.savePreferences({ _dataVersion: 20 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistryWithModels({}),
      log: () => {},
    });
  }

  it("repairs existing models.json entries for newly declared Kimi video models", () => {
    const prefs = makePrefs(userDir);
    const modelsJsonPath = path.join(tmpDir, "models.json");
    fs.writeFileSync(modelsJsonPath, JSON.stringify({
      providers: {
        moonshot: {
          baseUrl: "https://api.moonshot.cn/v1",
          api: "openai-completions",
          apiKey: "sk-test",
          models: [
            { id: "kimi-k2.6", name: "Kimi K2.6", input: ["text", "image"] },
          ],
        },
      },
    }, null, 2) + "\n", "utf-8");

    runMigration21(prefs);

    const raw = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(raw.providers.moonshot.models[0]).toMatchObject({
      id: "kimi-k2.6",
      input: ["text", "image"],
      compat: { hanaVideoInput: true },
    });
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #8 — repairPostMigrationModelRefs", () => {
  let tmpDir, userDir, agentsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("修复 migration #5 之后又被旧入口写回的裸字符串 chat model", () => {
    writeAgentConfig(agentsDir, "hana", {
      models: { chat: "qwen3.6-flash" },
    });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 7 });

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistryWithModels({
        dashscope: {
          models: [{ id: "qwen3.6-flash" }],
        },
      }),
      log: () => {},
    });

    const cfg = readAgentConfig(agentsDir, "hana");
    expect(cfg.models.chat).toEqual({ id: "qwen3.6-flash", provider: "dashscope" });
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #10 — cleanupSummarizerCompilerRemnants", () => {
  let tmpDir, userDir, agentsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("删除 preferences 里的 summarizer_model / compiler_model 字段（key 整体消失）", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({
      _dataVersion: 9,
      utility_model: "openai/gpt-4o-mini",
      summarizer_model: "openai/gpt-4o-mini",
      compiler_model: { id: "gpt-4o", provider: "openai" },
    });

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["openai"]),
      log: () => {},
    });

    const p = prefs.getPreferences();
    expect("summarizer_model" in p).toBe(false);
    expect("compiler_model" in p).toBe(false);
    expect(p.utility_model).toBe("openai/gpt-4o-mini");
  });

  it("删除每个 agent config.yaml 的 models.summarizer / models.compiler", () => {
    writeAgentConfig(agentsDir, "hana", {
      models: {
        chat: { id: "claude-opus-4-7", provider: "anthropic" },
        utility: { id: "claude-haiku-4-5", provider: "anthropic" },
        summarizer: "openai/gpt-4o-mini",
        compiler: { id: "gpt-4o", provider: "openai" },
      },
    });
    writeAgentConfig(agentsDir, "butter", {
      models: { chat: { id: "claude-haiku-4-5", provider: "anthropic" } },
    });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 9 });

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["anthropic", "openai"]),
      log: () => {},
    });

    const hana = readAgentConfig(agentsDir, "hana");
    expect("summarizer" in hana.models).toBe(false);
    expect("compiler" in hana.models).toBe(false);
    expect(hana.models.chat).toEqual({ id: "claude-opus-4-7", provider: "anthropic" });
    expect(hana.models.utility).toEqual({ id: "claude-haiku-4-5", provider: "anthropic" });

    // 没有残留的 agent 不被影响
    const butter = readAgentConfig(agentsDir, "butter");
    expect(butter.models.chat).toEqual({ id: "claude-haiku-4-5", provider: "anthropic" });
  });

  it("幂等：没有残留字段时不抛错，version 仍推进", () => {
    writeAgentConfig(agentsDir, "hana", {
      models: { chat: { id: "claude-opus-4-7", provider: "anthropic" } },
    });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 9 });

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry(["anthropic"]),
      log: () => {},
    });

    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #17 — migrateBridgeSessionKeysToAgentScoped", () => {
  let tmpDir, userDir, agentsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeBridgeIndex(agentId, index) {
    const bridgeDir = path.join(agentsDir, agentId, "sessions", "bridge");
    fs.mkdirSync(bridgeDir, { recursive: true });
    fs.writeFileSync(
      path.join(bridgeDir, "bridge-sessions.json"),
      JSON.stringify(index, null, 2) + "\n",
      "utf-8",
    );
  }

  function readBridgeIndex(agentId) {
    return JSON.parse(fs.readFileSync(
      path.join(agentsDir, agentId, "sessions", "bridge", "bridge-sessions.json"),
      "utf-8",
    ));
  }

  it("adds the owning agent suffix to legacy bridge session keys", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    writeBridgeIndex("hana", {
      "wx_dm_wx-user": { file: "owner/wx.jsonl", userId: "wx-user", name: "Alice" },
      "tg_dm_12345": "owner/tg.jsonl",
      "wx_dm_someone@openim": { file: "owner/openim.jsonl", userId: "someone@openim" },
      "wx_dm_existing@hana": { file: "owner/current.jsonl", userId: "existing" },
    });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 16 });

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const index = readBridgeIndex("hana");
    expect(index["wx_dm_wx-user"]).toBeUndefined();
    expect(index["tg_dm_12345"]).toBeUndefined();
    expect(index["wx_dm_someone@openim"]).toBeUndefined();
    expect(index["wx_dm_wx-user@hana"]).toEqual({ file: "owner/wx.jsonl", userId: "wx-user", name: "Alice" });
    expect(index["tg_dm_12345@hana"]).toBe("owner/tg.jsonl");
    expect(index["wx_dm_someone@openim@hana"]).toEqual({ file: "owner/openim.jsonl", userId: "someone@openim" });
    expect(index["wx_dm_existing@hana"]).toEqual({ file: "owner/current.jsonl", userId: "existing" });
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("fills an existing scoped metadata entry from legacy history", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    writeBridgeIndex("hana", {
      "wx_dm_user": { file: "owner/legacy.jsonl", userId: "user", name: "Old" },
      "wx_dm_user@hana": { name: "Current", chatId: "user" },
    });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 16 });

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const index = readBridgeIndex("hana");
    expect(index["wx_dm_user"]).toBeUndefined();
    expect(index["wx_dm_user@hana"]).toEqual({
      file: "owner/legacy.jsonl",
      userId: "user",
      name: "Current",
      chatId: "user",
    });
  });

  it("keeps legacy history when the scoped key already has history", () => {
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });
    writeBridgeIndex("hana", {
      "wx_dm_user": { file: "owner/legacy.jsonl", userId: "user", name: "Old" },
      "wx_dm_user@hana": { file: "owner/current.jsonl", userId: "user", name: "Current" },
    });
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 16 });

    runMigrations({
      hanakoHome: tmpDir, agentsDir, prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const index = readBridgeIndex("hana");
    expect(index["wx_dm_user"]).toEqual({ file: "owner/legacy.jsonl", userId: "user", name: "Old" });
    expect(index["wx_dm_user@hana"]).toEqual({ file: "owner/current.jsonl", userId: "user", name: "Current" });
  });
});

describe("migration #22 — migrateChannelPhoneSettingsDefaults", () => {
  let tmpDir, userDir, agentsDir, channelsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    channelsDir = path.join(tmpDir, "channels");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("adds explicit default reminder and disabled model override fields to legacy channel files", () => {
    fs.writeFileSync(
      path.join(channelsDir, "ch_legacy.md"),
      [
        "---",
        "id: ch_legacy",
        "members: [hana, butter]",
        "name: Legacy",
        "---",
        "",
        "### user | 2026-05-12 12:00:00",
        "",
        "hello",
        "",
        "---",
        "",
      ].join("\n"),
      "utf-8",
    );
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 21 });

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const raw = fs.readFileSync(path.join(channelsDir, "ch_legacy.md"), "utf-8");
    expect(raw).toContain("agentPhoneReminderIntervalMinutes: 31");
    expect(raw).toContain("agentPhoneProactiveEnabled: true");
    expect(raw).toContain("agentPhoneModelOverrideEnabled: false");
    expect(raw).toContain("### user | 2026-05-12 12:00:00");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #23 — removeAgentPhoneReplyInstructions", () => {
  let tmpDir, userDir, agentsDir, channelsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    channelsDir = path.join(tmpDir, "channels");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("removes the deprecated free-text reply-scope settings from channel and phone projection files", () => {
    fs.writeFileSync(
      path.join(channelsDir, "ch_legacy.md"),
      [
        "---",
        "id: ch_legacy",
        "members: [hana, butter]",
        "name: Legacy",
        `agentPhoneReplyInstructions: ${encodeURIComponent("只在能推进话题时回复")}`,
        "agentPhoneReplyMinChars: 20",
        "---",
        "",
        "### user | 2026-05-12 12:00:00",
        "",
        "hello",
        "",
        "---",
        "",
      ].join("\n"),
      "utf-8",
    );

    const agentDir = path.join(agentsDir, "hana");
    const projectionPath = getAgentPhoneProjectionPath(agentDir, "ch_legacy");
    fs.mkdirSync(path.dirname(projectionPath), { recursive: true });
    fs.writeFileSync(
      projectionPath,
      [
        "---",
        "agentId: hana",
        "conversationId: ch_legacy",
        `replyInstructions: ${encodeURIComponent("只在能推进话题时回复")}`,
        "replyMinChars: 20",
        "---",
        "",
        "# Agent Phone",
        "",
      ].join("\n"),
      "utf-8",
    );

    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 22 });

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const channelRaw = fs.readFileSync(path.join(channelsDir, "ch_legacy.md"), "utf-8");
    expect(channelRaw).not.toContain("agentPhoneReplyInstructions");
    expect(channelRaw).toContain("agentPhoneReplyMinChars: 20");
    expect(channelRaw).toContain("### user | 2026-05-12 12:00:00");

    const projectionRaw = fs.readFileSync(projectionPath, "utf-8");
    expect(projectionRaw).not.toContain("replyInstructions");
    expect(projectionRaw).toContain("replyMinChars: 20");
    expect(projectionRaw).toContain("# Agent Phone");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #24 — migrateChannelPhoneGuardLimitDefaults", () => {
  let tmpDir, userDir, agentsDir, channelsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    channelsDir = path.join(tmpDir, "channels");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("adds a per-channel guard limit based on channel member count", () => {
    fs.writeFileSync(
      path.join(channelsDir, "ch_crew.md"),
      [
        "---",
        "id: ch_crew",
        "members: [hana, butter, ming]",
        "name: Crew",
        "---",
        "",
        "### user | 2026-05-12 12:00:00",
        "",
        "hello",
        "",
      ].join("\n"),
      "utf-8",
    );
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 23 });

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const raw = fs.readFileSync(path.join(channelsDir, "ch_crew.md"), "utf-8");
    expect(raw).toContain("agentPhoneGuardLimit: 36");
    expect(raw).toContain("### user | 2026-05-12 12:00:00");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #25 — migrateChannelPhoneProactiveDefaults", () => {
  let tmpDir, userDir, agentsDir, channelsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    channelsDir = path.join(tmpDir, "channels");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(channelsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("adds an enabled proactive initiation flag to existing channel metadata", () => {
    fs.writeFileSync(
      path.join(channelsDir, "ch_crew.md"),
      [
        "---",
        "id: ch_crew",
        "members: [hana, butter, ming]",
        "agentPhoneReminderIntervalMinutes: 31",
        "agentPhoneGuardLimit: 36",
        "---",
        "",
        "### user | 2026-05-12 12:00:00",
        "",
        "hello",
        "",
      ].join("\n"),
      "utf-8",
    );
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 24 });

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const raw = fs.readFileSync(path.join(channelsDir, "ch_crew.md"), "utf-8");
    expect(raw).toContain("agentPhoneProactiveEnabled: true");
    expect(raw).toContain("### user | 2026-05-12 12:00:00");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("preserves channels where proactive initiation was explicitly disabled", () => {
    fs.writeFileSync(
      path.join(channelsDir, "ch_quiet.md"),
      [
        "---",
        "id: ch_quiet",
        "members: [hana, butter, ming]",
        "agentPhoneProactiveEnabled: false",
        "---",
        "",
      ].join("\n"),
      "utf-8",
    );
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 24 });

    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const raw = fs.readFileSync(path.join(channelsDir, "ch_quiet.md"), "utf-8");
    expect(raw).toContain("agentPhoneProactiveEnabled: false");
    expect(raw.match(/agentPhoneProactiveEnabled/g)).toHaveLength(1);
  });
});

describe("migration #18 — create local identity registries", () => {
  let tmpDir, userDir, agentsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runFrom17() {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 17 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
    return prefs;
  }

  function runFrom25() {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 25 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
    return prefs;
  }

  function runFrom26() {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 26 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
    return prefs;
  }

  it("creates stable server, legacy owner user, and default personal studio for old data roots", () => {
    fs.mkdirSync(path.join(tmpDir, "user", "avatars"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "user", "user.md"), "old profile\n", "utf-8");
    writeAgentConfig(agentsDir, "hana", { api: { provider: "" } });

    const prefs = runFrom17();

    const serverNode = readJson(path.join(tmpDir, "server-node.json"));
    const users = readJson(path.join(tmpDir, "users.json"));
    const studios = readJson(path.join(tmpDir, "studios.json"));

    expect(serverNode).toEqual(expect.objectContaining({
      schemaVersion: 1,
      label: "Local Hana",
    }));
    expect(serverNode.serverId).toMatch(/^server_[0-9a-f-]{36}$/);

    expect(users.schemaVersion).toBe(1);
    expect(users.defaultUserId).toMatch(/^user_[0-9a-f-]{36}$/);
    expect(users.users).toEqual([
      expect.objectContaining({
        userId: users.defaultUserId,
        kind: "legacy_owner",
        displayName: "Local User",
        profileSource: "legacy_user_profile",
      }),
    ]);

    expect(studios.schemaVersion).toBe(1);
    expect(studios.defaultStudioId).toMatch(/^studio_[0-9a-f-]{36}$/);
    expect(studios.studios).toEqual([
      expect.objectContaining({
        studioId: studios.defaultStudioId,
        ownerUserId: users.defaultUserId,
        label: "Personal Studio",
        kind: "personal",
        membershipModel: "single_user_implicit",
        storage: {
          provider: "legacy_hana_home",
          legacyRoot: true,
        },
      }),
    ]);
    expect(fs.existsSync(path.join(tmpDir, "user", "user.md"))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, "hana", "config.yaml"))).toBe(true);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("preserves existing valid identity registries exactly", () => {
    const serverNodePath = path.join(tmpDir, "server-node.json");
    const usersPath = path.join(tmpDir, "users.json");
    const studiosPath = path.join(tmpDir, "studios.json");
    const serverNode = {
      schemaVersion: 1,
      serverId: "server_existing",
      label: "Existing Server",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };
    const users = {
      schemaVersion: 1,
      defaultUserId: "user_existing",
      users: [{
        userId: "user_existing",
        kind: "legacy_owner",
        displayName: "Existing User",
        profileSource: "legacy_user_profile",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }],
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };
    const studios = {
      schemaVersion: 1,
      defaultStudioId: "studio_existing",
      studios: [{
        studioId: "studio_existing",
        ownerUserId: "user_existing",
        label: "Existing Studio",
        kind: "personal",
        storage: { provider: "legacy_hana_home", legacyRoot: true },
        membershipModel: "single_user_implicit",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }],
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };
    writeJson(serverNodePath, serverNode);
    writeJson(usersPath, users);
    writeJson(studiosPath, studios);

    const prefs = runFrom17();

    expect(readJson(serverNodePath)).toEqual(serverNode);
    expect(readJson(usersPath)).toEqual(users);
    expect(readJson(studiosPath)).toEqual(studios);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("completes partial identity registries with consistent owner and studio references", () => {
    writeJson(path.join(tmpDir, "server-node.json"), {
      schemaVersion: 1,
      serverId: "server_partial",
      label: "Partial Server",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    writeJson(path.join(tmpDir, "users.json"), {
      schemaVersion: 1,
      defaultUserId: "user_partial",
      users: [{
        userId: "user_partial",
        kind: "legacy_owner",
        displayName: "Partial User",
        profileSource: "legacy_user_profile",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }],
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });

    const prefs = runFrom17();
    const studios = readJson(path.join(tmpDir, "studios.json"));

    expect(studios.defaultStudioId).toMatch(/^studio_[0-9a-f-]{36}$/);
    expect(studios.studios[0]).toEqual(expect.objectContaining({
      studioId: studios.defaultStudioId,
      ownerUserId: "user_partial",
      kind: "personal",
      membershipModel: "single_user_implicit",
    }));
    expect(readJson(path.join(tmpDir, "server-node.json")).serverId).toBe("server_partial");
    expect(readJson(path.join(tmpDir, "users.json")).defaultUserId).toBe("user_partial");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("migrates an already-created legacy spaces.json registry to studios.json", () => {
    writeJson(path.join(tmpDir, "server-node.json"), {
      schemaVersion: 1,
      serverId: "server_legacy_space",
      label: "Legacy Space Server",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    writeJson(path.join(tmpDir, "users.json"), {
      schemaVersion: 1,
      defaultUserId: "user_legacy_space",
      users: [{
        userId: "user_legacy_space",
        kind: "legacy_owner",
        displayName: "Legacy Space User",
        profileSource: "legacy_user_profile",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }],
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    writeJson(path.join(tmpDir, "spaces.json"), {
      schemaVersion: 1,
      defaultSpaceId: "space_existing",
      spaces: [{
        spaceId: "space_existing",
        ownerUserId: "user_legacy_space",
        label: "Personal Space",
        kind: "personal",
        storage: { provider: "legacy_hana_home", legacyRoot: true },
        membershipModel: "single_user_implicit",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }],
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });

    const prefs = runFrom25();
    const studios = readJson(path.join(tmpDir, "studios.json"));

    expect(studios).toEqual(expect.objectContaining({
      schemaVersion: 1,
      defaultStudioId: "space_existing",
      studios: [
        expect.objectContaining({
          studioId: "space_existing",
          ownerUserId: "user_legacy_space",
          label: "Personal Studio",
          kind: "personal",
        }),
      ],
    }));
    expect(fs.existsSync(path.join(tmpDir, "spaces.json"))).toBe(true);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("creates remote access foundation registries for users already migrated to Studio", () => {
    const serverNode = {
      schemaVersion: 1,
      serverId: "server_existing",
      serverNodeId: "node_existing",
      nodeKind: "local",
      transport: "loopback",
      execution: { kind: "local_process" },
      label: "Existing Server",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };
    const users = {
      schemaVersion: 1,
      defaultUserId: "user_existing",
      users: [{
        userId: "user_existing",
        kind: "legacy_owner",
        displayName: "Existing User",
        profileSource: "legacy_user_profile",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }],
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };
    const studios = {
      schemaVersion: 1,
      defaultStudioId: "studio_existing",
      studios: [{
        studioId: "studio_existing",
        ownerUserId: "user_existing",
        label: "Existing Studio",
        kind: "personal",
        storage: { provider: "legacy_hana_home", legacyRoot: true },
        membershipModel: "single_user_implicit",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }],
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };
    writeJson(path.join(tmpDir, "server-node.json"), serverNode);
    writeJson(path.join(tmpDir, "users.json"), users);
    writeJson(path.join(tmpDir, "studios.json"), studios);

    const prefs = runFrom26();

    expect(readJson(path.join(tmpDir, "server-node.json"))).toEqual(serverNode);
    expect(readJson(path.join(tmpDir, "users.json"))).toEqual(users);
    expect(readJson(path.join(tmpDir, "studios.json"))).toEqual(studios);
    expect(readJson(path.join(tmpDir, "devices.json"))).toMatchObject({ schemaVersion: 1, devices: [] });
    expect(readJson(path.join(tmpDir, "device-credentials.json"))).toMatchObject({ schemaVersion: 1, credentials: [] });
    expect(readJson(path.join(tmpDir, "pairing-sessions.json"))).toMatchObject({ schemaVersion: 1, pairingSessions: [] });
    expect(readJson(path.join(tmpDir, "server-network.json"))).toMatchObject({
      schemaVersion: 1,
      mode: "loopback",
      listenHost: "127.0.0.1",
    });
    expect(readJson(path.join(tmpDir, "studio-mounts.json"))).toMatchObject({ schemaVersion: 1, mounts: [] });
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("fails explicitly and keeps migration version unchanged when identity registries are invalid", () => {
    fs.writeFileSync(path.join(tmpDir, "users.json"), "{ broken json", "utf-8");
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 17 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      runMigrations({
        hanakoHome: tmpDir,
        agentsDir,
        prefs,
        providerRegistry: makeRegistry([]),
        log: () => {},
      });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[migrations] #18 失败:"));
    } finally {
      errorSpy.mockRestore();
    }

    expect(prefs.getPreferences()._dataVersion).toBe(17);
    expect(fs.existsSync(path.join(tmpDir, "server-node.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "studios.json"))).toBe(false);
  });
});

describe("migration #19 — migrate legacy API-key auth to provider config", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeAuth(data) {
    writeJson(path.join(tmpDir, "auth.json"), data);
  }

  function writeAddedModels(data) {
    fs.writeFileSync(
      path.join(tmpDir, "added-models.yaml"),
      YAML.dump(data, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }),
      "utf-8",
    );
  }

  function readAddedModels() {
    return YAML.load(fs.readFileSync(path.join(tmpDir, "added-models.yaml"), "utf-8"));
  }

  function readPersistedProviders() {
    const catalogPath = path.join(tmpDir, "provider-catalog.json");
    if (fs.existsSync(catalogPath)) return readJson(catalogPath).providers;
    return readAddedModels().providers;
  }

  function makeProviderRegistry() {
    return {
      reload: vi.fn(),
      get(id) {
        if (id === "deepseek") {
          return {
            id: "deepseek",
            authType: "api-key",
            baseUrl: "https://api.deepseek.com",
            api: "openai-completions",
            authJsonKey: "deepseek",
          };
        }
        if (id === "openai-codex-oauth") {
          return {
            id: "openai-codex-oauth",
            authType: "oauth",
            baseUrl: "",
            api: "openai-codex-responses",
            authJsonKey: "openai-codex",
          };
        }
        if (id === "openai-codex") {
          return {
            id: "openai-codex-oauth",
            authType: "oauth",
            baseUrl: "",
            api: "openai-codex-responses",
            authJsonKey: "openai-codex",
          };
        }
        if (id === "ollama") {
          return {
            id: "ollama",
            authType: "none",
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            authJsonKey: "ollama",
          };
        }
        return null;
      },
      getDefaultModels(id) {
        return id === "deepseek" ? ["deepseek-v4-pro", "deepseek-v4-flash"] : [];
      },
    };
  }

  function runFrom18(providerRegistry = makeProviderRegistry()) {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 18 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry,
      log: () => {},
    });
    return prefs;
  }

  it("moves legacy DeepSeek API key into existing added-models provider before auth cleanup", () => {
    writeAuth({
      deepseek: { type: "api_key", key: "sk-legacy-4d2a" },
      "openai-codex": { type: "oauth", access: "oauth-access-token" },
    });
    writeAddedModels({
      providers: {
        deepseek: {
          models: ["deepseek-v4-flash"],
        },
      },
    });

    const prefs = runFrom18();

    const providers = readPersistedProviders();
    expect(providers.deepseek).toEqual({
      api_key: "sk-legacy-4d2a",
      base_url: "https://api.deepseek.com",
      api: "openai-completions",
      models: ["deepseek-v4-flash"],
    });
    expect(providers["openai-codex-oauth"]).toBeUndefined();
    expect(readJson(path.join(tmpDir, "auth.json"))["openai-codex"].access).toBe("oauth-access-token");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("recreates a missing known provider from legacy auth and models.json", () => {
    writeAuth({
      deepseek: { type: "api_key", key: "sk-legacy-4d2a" },
    });
    writeAddedModels({ providers: {} });
    writeJson(path.join(tmpDir, "models.json"), {
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.com",
          api: "openai-completions",
          models: [
            { id: "deepseek-v4-pro" },
            { id: "deepseek-v4-flash" },
          ],
        },
      },
    });

    runFrom18();

    expect(readPersistedProviders().deepseek).toEqual({
      api_key: "sk-legacy-4d2a",
      base_url: "https://api.deepseek.com",
      api: "openai-completions",
      models: ["deepseek-v4-pro", "deepseek-v4-flash"],
    });
  });

  it("recovers a legacy key from models.json after auth.json has already been cleaned", () => {
    writeAuth({});
    writeAddedModels({
      providers: {
        deepseek: {
          models: ["deepseek-v4-flash"],
        },
      },
    });
    writeJson(path.join(tmpDir, "models.json"), {
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.com",
          api: "openai-completions",
          apiKey: "sk-projected-6ad1",
          models: [
            { id: "deepseek-v4-flash" },
          ],
        },
      },
    });

    runFrom18();

    expect(readPersistedProviders().deepseek).toEqual({
      api_key: "sk-projected-6ad1",
      base_url: "https://api.deepseek.com",
      api: "openai-completions",
      models: ["deepseek-v4-flash"],
    });
  });

  it("rescues a secret-only custom provider when its local plugin definition is missing", () => {
    writeAuth({});
    writeAddedModels({
      providers: {
        "my-provider": {
          api_key: "sk-secret-only",
        },
      },
    });
    writeJson(path.join(tmpDir, "models.json"), {
      providers: {
        "my-provider": {
          baseUrl: "https://api.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-secret-only",
          models: [
            { id: "custom-chat" },
          ],
        },
      },
    });

    runFrom18();

    expect(readPersistedProviders()["my-provider"]).toEqual({
      api_key: "sk-secret-only",
      base_url: "https://api.example.com/v1",
      api: "openai-completions",
      models: ["custom-chat"],
    });
  });

  it("does not persist the synthetic local API key from no-auth provider projections", () => {
    writeAuth({});
    writeAddedModels({
      providers: {
        ollama: {
          base_url: "http://localhost:11434/v1",
          api: "openai-completions",
          models: ["llama3.2"],
        },
      },
    });
    writeJson(path.join(tmpDir, "models.json"), {
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          apiKey: "local",
          models: [
            { id: "llama3.2" },
          ],
        },
      },
    });

    runFrom18();

    expect(readPersistedProviders().ollama).toEqual({
      base_url: "http://localhost:11434/v1",
      api: "openai-completions",
      models: ["llama3.2"],
    });
  });

  it("does not overwrite an explicit added-models API key, including an intentional clear", () => {
    writeAuth({
      deepseek: { type: "api_key", key: "sk-old-3ffa" },
    });
    writeAddedModels({
      providers: {
        deepseek: {
          api_key: "",
          base_url: "https://api.deepseek.com",
          api: "openai-completions",
          models: ["deepseek-v4-pro"],
        },
      },
    });

    runFrom18();

    expect(readPersistedProviders().deepseek.api_key).toBe("");
  });
});

describe("migration #28 — durable subagent run registry", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runFrom27() {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 27 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
    return prefs;
  }

  it("backfills durable subagent run mappings from existing deferred metadata", () => {
    const parentSessionPath = path.join(agentsDir, "hanako", "sessions", "parent.jsonl");
    const childSessionPath = path.join(agentsDir, "hanako", "subagent-sessions", "child.jsonl");
    fs.mkdirSync(path.dirname(parentSessionPath), { recursive: true });
    fs.mkdirSync(path.dirname(childSessionPath), { recursive: true });
    fs.writeFileSync(parentSessionPath, "", "utf-8");
    fs.writeFileSync(childSessionPath, "", "utf-8");

    writeJson(path.join(tmpDir, ".ephemeral", "deferred-tasks.json"), {
      "subagent-legacy": {
        status: "resolved",
        sessionPath: parentSessionPath,
        result: "完成摘要",
        deferredAt: 1710000000000,
        delivered: true,
        meta: {
          type: "subagent",
          summary: "旧任务标题",
          sessionPath: childSessionPath,
          requestedAgentId: "hanako",
          requestedAgentNameSnapshot: "Hanako",
          executorAgentId: "hanako",
          executorAgentNameSnapshot: "Hanako",
          executorMetaVersion: 1,
        },
      },
    });

    const prefs = runFrom27();

    const registry = readJson(path.join(tmpDir, "subagent-runs.json"));
    expect(registry.runs["subagent-legacy"]).toMatchObject({
      taskId: "subagent-legacy",
      parentSessionPath,
      childSessionPath,
      status: "resolved",
      summary: "完成摘要",
      requestedAgentId: "hanako",
      requestedAgentNameSnapshot: "Hanako",
      executorAgentId: "hanako",
      executorAgentNameSnapshot: "Hanako",
      executorMetaVersion: 1,
    });
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("backfills historical parent records only when they already carry a child session path", () => {
    const parentSessionPath = path.join(agentsDir, "hanako", "sessions", "parent.jsonl");
    const childSessionPath = path.join(agentsDir, "hanako", "subagent-sessions", "child.jsonl");
    writeSessionJsonl(parentSessionPath, [
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-with-child",
          taskTitle: "已有子会话",
          sessionPath: childSessionPath,
          streamStatus: "done",
          summary: "已完成",
          requestedAgentId: "hanako",
          requestedAgentNameSnapshot: "Hanako",
          executorAgentId: "hanako",
          executorAgentNameSnapshot: "Hanako",
          executorMetaVersion: 1,
        },
      },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-without-child",
          taskTitle: "没有子会话映射",
          sessionPath: null,
          streamStatus: "running",
        },
      },
    ]);

    runFrom27();

    const registry = readJson(path.join(tmpDir, "subagent-runs.json"));
    expect(registry.runs["subagent-with-child"]).toMatchObject({
      taskId: "subagent-with-child",
      parentSessionPath,
      childSessionPath,
      status: "resolved",
      summary: "已完成",
    });
    expect(registry.runs["subagent-without-child"]).toBeUndefined();
  });
});

describe("migration #29 — heartbeat default is explicit opt-in", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runFrom28() {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 28 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
    return prefs;
  }

  it("sets missing heartbeat_enabled to false while preserving explicit true and false", () => {
    writeAgentConfig(agentsDir, "missing", {
      agent: { name: "Missing" },
      desk: { heartbeat_interval: 31 },
    });
    writeAgentConfig(agentsDir, "enabled", {
      agent: { name: "Enabled" },
      desk: { heartbeat_enabled: true, heartbeat_interval: 31 },
    });
    writeAgentConfig(agentsDir, "disabled", {
      agent: { name: "Disabled" },
      desk: { heartbeat_enabled: false, heartbeat_interval: 31 },
    });

    const prefs = runFrom28();

    expect(readAgentConfig(agentsDir, "missing").desk.heartbeat_enabled).toBe(false);
    expect(readAgentConfig(agentsDir, "enabled").desk.heartbeat_enabled).toBe(true);
    expect(readAgentConfig(agentsDir, "disabled").desk.heartbeat_enabled).toBe(false);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #32 — move Agent Phone runtime out of projection", () => {
  let tmpDir, userDir, agentsDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    userDir = path.join(tmpDir, "user");
    agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("moves session runtime fields to a sidecar and removes stale toolNames from projection", () => {
    const agentDir = path.join(agentsDir, "hana");
    const projectionPath = getAgentPhoneProjectionPath(agentDir, "ch_legacy");
    fs.mkdirSync(path.dirname(projectionPath), { recursive: true });
    fs.writeFileSync(
      projectionPath,
      [
        "---",
        "agentId: hana",
        "conversationId: ch_legacy",
        "conversationType: channel",
        "state: idle",
        "summary: Replied",
        "lastViewedTimestamp: 2026-05-25 12:00:00",
        "phoneSessionFile: phone/sessions/ch_legacy/old.jsonl",
        "lastPhoneSessionUsedAt: 2026-05-25T12:10:00.000Z",
        "phoneSessionStartedAt: 2026-05-25T12:00:00.000Z",
        `promptSnapshot: ${encodeURIComponent(JSON.stringify({ version: 1, systemPrompt: "old prompt" }))}`,
        `toolNames: ${encodeURIComponent(JSON.stringify(["search_memory"]))}`,
        "---",
        "",
        "# Agent Phone",
        "",
        "## Activity",
        "- 2026-05-25T12:11:00.000Z [idle] Replied",
        "",
      ].join("\n"),
      "utf-8",
    );

    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 31 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const projectionRaw = fs.readFileSync(projectionPath, "utf-8");
    expect(projectionRaw).toContain("state: idle");
    expect(projectionRaw).toContain("lastViewedTimestamp: 2026-05-25 12:00:00");
    expect(projectionRaw).toContain("[idle] Replied");
    expect(projectionRaw).not.toContain("phoneSessionFile");
    expect(projectionRaw).not.toContain("lastPhoneSessionUsedAt");
    expect(projectionRaw).not.toContain("phoneSessionStartedAt");
    expect(projectionRaw).not.toContain("promptSnapshot");
    expect(projectionRaw).not.toContain("toolNames");

    const runtimePath = path.join(
      agentDir,
      "phone",
      "session-runtime",
      `${safeConversationStem("ch_legacy")}.json`,
    );
    const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf-8"));
    expect(runtime).toMatchObject({
      agentId: "hana",
      conversationId: "ch_legacy",
      conversationType: "channel",
      phoneSessionFile: "phone/sessions/ch_legacy/old.jsonl",
      lastPhoneSessionUsedAt: "2026-05-25T12:10:00.000Z",
      phoneSessionStartedAt: "2026-05-25T12:00:00.000Z",
      promptSnapshot: { version: 1, systemPrompt: "old prompt" },
    });
    expect(runtime.toolNames).toBeUndefined();
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #33 — beautify default is explicit opt-in", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runFrom32() {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 32 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
    return prefs;
  }

  it("adds beautify to existing disabled lists without changing explicit choices", () => {
    writeAgentConfig(agentsDir, "empty-disabled", {
      agent: { name: "Empty" },
      tools: { disabled: [] },
    });
    writeAgentConfig(agentsDir, "dm-disabled", {
      agent: { name: "DM" },
      tools: { disabled: ["dm"] },
    });
    writeAgentConfig(agentsDir, "already", {
      agent: { name: "Already" },
      tools: { disabled: ["dm", "beautify"] },
    });

    const prefs = runFrom32();

    // 从 v32 升级会连跑 #33(beautify)+ #34(workflow)，两者都默认关。
    // tools.disabled 是无序去重集合，用 Set 比较。
    expect(new Set(readAgentConfig(agentsDir, "empty-disabled").tools.disabled))
      .toEqual(new Set(["beautify", "workflow"]));
    expect(new Set(readAgentConfig(agentsDir, "dm-disabled").tools.disabled))
      .toEqual(new Set(["dm", "beautify", "workflow"]));
    expect(new Set(readAgentConfig(agentsDir, "already").tools.disabled))
      .toEqual(new Set(["dm", "beautify", "workflow"]));
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("materializes the full current default when tools.disabled is missing", () => {
    writeAgentConfig(agentsDir, "missing", {
      agent: { name: "Missing" },
    });

    runFrom32();

    // 升级到最新版后物化为当前仍可配置的默认禁用集合。
    expect(new Set(readAgentConfig(agentsDir, "missing").tools.disabled))
      .toEqual(new Set(["beautify", "workflow"]));
  });
});

describe("migration #34 — workflow default is explicit opt-in", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runFrom33() {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 33 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
    return prefs;
  }

  it("adds workflow to existing disabled lists without changing explicit choices", () => {
    writeAgentConfig(agentsDir, "beautify-off", {
      agent: { name: "B" },
      tools: { disabled: ["dm", "beautify"] },
    });
    // 用户手动开了 beautify（把它移出 disabled）：#34 不应破坏这个显式选择
    writeAgentConfig(agentsDir, "beautify-on", {
      agent: { name: "On" },
      tools: { disabled: ["dm"] },
    });

    const prefs = runFrom33();

    expect(readAgentConfig(agentsDir, "beautify-off").tools.disabled).toEqual(["dm", "beautify", "workflow"]);
    expect(readAgentConfig(agentsDir, "beautify-on").tools.disabled).toEqual(["dm", "workflow"]);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("is idempotent — already-disabled workflow is not duplicated", () => {
    writeAgentConfig(agentsDir, "already", {
      agent: { name: "Already" },
      tools: { disabled: ["workflow"] },
    });

    runFrom33();

    expect(readAgentConfig(agentsDir, "already").tools.disabled).toEqual(["workflow"]);
  });

  it("materializes the default when tools.disabled is missing", () => {
    writeAgentConfig(agentsDir, "missing", {
      agent: { name: "Missing" },
    });

    runFrom33();

    expect(readAgentConfig(agentsDir, "missing").tools.disabled).toContain("workflow");
  });
});

describe("migration #35 — MiniMax Token Plan endpoint follows current official Anthropic API", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = tmpDir;
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeAddedModelsYaml(providers) {
    fs.writeFileSync(
      path.join(tmpDir, "added-models.yaml"),
      YAML.dump({ providers }, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
      "utf-8",
    );
  }

  function readAddedModelsYaml() {
    return YAML.load(fs.readFileSync(path.join(tmpDir, "added-models.yaml"), "utf-8"));
  }

  function runFrom34() {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 34 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
    return prefs;
  }

  it("rewrites only the legacy MiniMax Token Plan default endpoint and keeps credentials/models scoped to the provider id", () => {
    writeAddedModelsYaml({
      minimax: {
        base_url: "https://api.minimaxi.com/anthropic",
        api: "anthropic-messages",
        api_key: "sk-pay-as-you-go",
        models: ["MiniMax-M3"],
      },
      "minimax-token-plan": {
        base_url: "https://api.minimax.io/v1",
        api: "openai-completions",
        api_key: "sk-token-plan",
        models: ["MiniMax-M2.7"],
      },
    });

    const prefs = runFrom34();

    const raw = readAddedModelsYaml();
    expect(raw.providers.minimax).toMatchObject({
      base_url: "https://api.minimaxi.com/anthropic",
      api: "anthropic-messages",
      api_key: "sk-pay-as-you-go",
      models: ["MiniMax-M3"],
    });
    expect(raw.providers["minimax-token-plan"]).toMatchObject({
      base_url: "https://api.minimaxi.com/anthropic",
      api: "anthropic-messages",
      api_key: "sk-token-plan",
      models: ["MiniMax-M2.7"],
    });
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("does not rewrite custom MiniMax Token Plan proxies", () => {
    writeAddedModelsYaml({
      "minimax-token-plan": {
        base_url: "https://proxy.example.com/minimax/v1",
        api: "openai-completions",
        api_key: "sk-token-plan",
        models: ["MiniMax-M2.7"],
      },
    });

    runFrom34();

    const raw = readAddedModelsYaml();
    expect(raw.providers["minimax-token-plan"]).toMatchObject({
      base_url: "https://proxy.example.com/minimax/v1",
      api: "openai-completions",
      api_key: "sk-token-plan",
      models: ["MiniMax-M2.7"],
    });
  });
});

describe("migration #36 — subagent thread registry backfills old run and reusable records", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = tmpDir;
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runFrom35() {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 35 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
    return prefs;
  }

  it("creates closed direct threads from historical subagent runs with child sessions", () => {
    writeJson(path.join(tmpDir, "subagent-runs.json"), {
      schemaVersion: 1,
      runs: {
        "subagent-old": {
          taskId: "subagent-old",
          status: "resolved",
          parentSessionPath: "/parent.jsonl",
          childSessionPath: "/child.jsonl",
          summary: "旧摘要",
          executorAgentId: "butter",
          executorAgentNameSnapshot: "Butter",
          completedAt: "2026-06-01T00:02:00.000Z",
        },
        "workflow-old": {
          taskId: "workflow-old",
          status: "resolved",
          parentSessionPath: "/parent.jsonl",
          summary: "旧 workflow",
        },
      },
    });

    const prefs = runFrom35();

    const threads = readJson(path.join(tmpDir, "subagent-threads.json"));
    expect(threads.threads["subagent-old"]).toMatchObject({
      threadId: "subagent-old",
      kind: "direct",
      status: "closed",
      lastRunStatus: "resolved",
      parentSessionPath: "/parent.jsonl",
      childSessionPath: "/child.jsonl",
      agentId: "butter",
      agentName: "Butter",
      summary: "旧摘要",
      runCount: 1,
    });
    const runs = readJson(path.join(tmpDir, "subagent-runs.json"));
    expect(runs.runs["subagent-old"].threadKind).toBe("direct");
    expect(threads.threads["workflow-old"]).toBeUndefined();
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("creates open direct threads from historical reusable instance records", () => {
    writeJson(path.join(tmpDir, "reusable-subagents.json"), {
      schemaVersion: 2,
      instances: {
        "/parent.jsonl::butter::探索": {
          reuseKey: "/parent.jsonl::butter::探索",
          childSessionPath: "/child.jsonl",
          parentSessionPath: "/parent.jsonl",
          agentId: "butter",
          taskSuffix: "探索",
          summary: "最近一次",
          lastStatus: "resolved",
          runCount: 3,
        },
      },
    });

    runFrom35();

    const threads = readJson(path.join(tmpDir, "subagent-threads.json"));
    expect(threads.threads["reusable::/parent.jsonl::butter::探索"]).toMatchObject({
      kind: "direct",
      status: "open",
      lastRunStatus: "resolved",
      parentSessionPath: "/parent.jsonl",
      childSessionPath: "/child.jsonl",
      agentId: "butter",
      label: "探索",
      summary: "最近一次",
      runCount: 3,
    });
  });

  it("normalizes already-migrated v36 thread files to direct semantics", () => {
    writeJson(path.join(tmpDir, "subagent-threads.json"), {
      schemaVersion: 1,
      threads: {
        "subagent-old": {
          threadId: "subagent-old",
          kind: "ephemeral",
          status: "closed",
          parentSessionPath: "/parent.jsonl",
          childSessionPath: "/child.jsonl",
        },
        "reusable::/parent.jsonl::butter::探索": {
          threadId: "reusable::/parent.jsonl::butter::探索",
          kind: "reusable",
          status: "open",
          parentSessionPath: "/parent.jsonl",
          childSessionPath: "/child.jsonl",
          agentId: "butter",
          instance: "探索",
          reuseKey: "/parent.jsonl::butter::探索",
        },
        "workflow-1::node-1": {
          threadId: "workflow-1::node-1",
          kind: "workflow_node",
          status: "closed",
        },
      },
    });
    writeJson(path.join(tmpDir, "subagent-runs.json"), {
      schemaVersion: 1,
      runs: {
        "subagent-old": {
          taskId: "subagent-old",
          threadId: "subagent-old",
          threadKind: "ephemeral",
        },
      },
    });

    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 36 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    const threads = readJson(path.join(tmpDir, "subagent-threads.json")).threads;
    expect(threads["subagent-old"]).toMatchObject({ kind: "direct", status: "closed" });
    expect(threads["reusable::/parent.jsonl::butter::探索"]).toMatchObject({
      kind: "direct",
      status: "open",
      label: "探索",
    });
    expect(threads["reusable::/parent.jsonl::butter::探索"].instance).toBeUndefined();
    expect(threads["reusable::/parent.jsonl::butter::探索"].reuseKey).toBeUndefined();
    expect(threads["workflow-1::node-1"].kind).toBe("workflow_node");
    const runs = readJson(path.join(tmpDir, "subagent-runs.json")).runs;
    expect(runs["subagent-old"].threadKind).toBe("direct");
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});

describe("migration #41 — restore dynamic user name placeholders in identity seeds", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runFrom40() {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 40 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
    return prefs;
  }

  it("repairs first-run identities that lost the userName placeholder", () => {
    const agentDir = path.join(agentsDir, "hanako");
    fs.mkdirSync(agentDir, { recursive: true });
    const identityPath = path.join(agentDir, "identity.md");
    const legacy = [
      "# Hanako",
      "",
      "的个人助手。感性与理性兼备，既有温度也有判断力。",
      "",
    ].join("\n");
    fs.writeFileSync(identityPath, legacy, "utf-8");

    const prefs = runFrom40();

    const repaired = fs.readFileSync(identityPath, "utf-8");
    expect(repaired).toContain("{{userName}}的个人助手。感性与理性兼备");
    expect(repaired).not.toContain("\n的个人助手");
    expect(fs.readFileSync(`${identityPath}.pre-v41.bak`, "utf-8")).toBe(legacy);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("repairs English identities and leaves concrete user names untouched", () => {
    const brokenDir = path.join(agentsDir, "english");
    const concreteDir = path.join(agentsDir, "concrete");
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.mkdirSync(concreteDir, { recursive: true });
    const brokenPath = path.join(brokenDir, "identity.md");
    const concretePath = path.join(concreteDir, "identity.md");
    fs.writeFileSync(
      brokenPath,
      "# Hanako\n\n's personal assistant. Balancing feeling and reasoning.\n",
      "utf-8",
    );
    fs.writeFileSync(
      concretePath,
      "# Hanako\n\n黎的个人助手。感性与理性兼备。\n",
      "utf-8",
    );

    runFrom40();

    expect(fs.readFileSync(brokenPath, "utf-8")).toContain("{{userName}}'s personal assistant");
    expect(fs.readFileSync(concretePath, "utf-8")).toContain("黎的个人助手。感性与理性兼备。");
    expect(fs.existsSync(`${concretePath}.pre-v41.bak`)).toBe(false);
  });
});

describe("migration #53 — drop session titles made of injected prompt envelopes", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runFrom52() {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 52 });
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });
    return prefs;
  }

  it("removes envelope titles across agents and keeps real ones", () => {
    const hanaTitles = path.join(agentsDir, "hana", "sessions", "session-titles.json");
    const workTitles = path.join(agentsDir, "work", "sessions", "session-titles.json");
    writeJson(hanaTitles, {
      "a.jsonl": "[hana_reference] yuque（4…",
      "b.jsonl": "[hana_reminder at 2026-07…",
      "c.jsonl": "周报整理",
    });
    writeJson(workTitles, {
      "d.jsonl": "[attached_image: /tmp/a.png]",
      "e.jsonl": '[SessionFile] {"fileId":"sf-1"}',
      "f.jsonl": "重构缓存层",
    });

    const prefs = runFrom52();

    expect(readJson(hanaTitles)).toEqual({ "c.jsonl": "周报整理" });
    expect(readJson(workTitles)).toEqual({ "f.jsonl": "重构缓存层" });
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });

  it("is idempotent and leaves clean files byte-identical", () => {
    const titlePath = path.join(agentsDir, "hana", "sessions", "session-titles.json");
    writeJson(titlePath, { "a.jsonl": "[hana_reference] yuque（4…", "b.jsonl": "周报整理" });

    runFrom52();
    const afterFirst = fs.readFileSync(titlePath, "utf-8");

    const prefs = makePrefs(userDir);
    const replayed = prefs.getPreferences();
    replayed._dataVersion = 52;
    prefs.savePreferences(replayed);
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry([]),
      log: () => {},
    });

    expect(fs.readFileSync(titlePath, "utf-8")).toBe(afterFirst);
    expect(readJson(titlePath)).toEqual({ "b.jsonl": "周报整理" });
  });

  it("skips agents without a titles file", () => {
    fs.mkdirSync(path.join(agentsDir, "empty", "sessions"), { recursive: true });

    const prefs = runFrom52();

    expect(fs.existsSync(path.join(agentsDir, "empty", "sessions", "session-titles.json"))).toBe(false);
    expect(prefs.getPreferences()._dataVersion).toBe(LATEST_DATA_VERSION);
  });
});
