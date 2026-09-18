import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { createExperimentsRoute } from "../server/routes/experiments.ts";
import {
  CACHE_SNAPSHOT_EXPERIMENT_ID,
  COMPACTION_MODE_EXPERIMENT_ID,
  DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID,
  INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID,
} from "../lib/experiments/registry.ts";
import {
  readCacheSnapshotObservation,
  writeCacheSnapshotObservation,
} from "../lib/memory/cache-snapshot-observation.ts";

function makeEngine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-experiments-route-"));
  const agentsDir = path.join(root, "agents");
  const prefsState: any = {};
  return {
    root,
    prefsState,
    engine: {
      agentsDir,
      preferences: {
        getExperimentValue: (id) => prefsState[id],
        setExperimentValue: (id, value) => { prefsState[id] = value; },
      },
      getAgentDir: (agentId) => path.join(agentsDir, agentId),
    },
  };
}

async function routeFetch(route, pathName, init) {
  const res = await route.request(`http://localhost${pathName}`, init);
  const body = await res.json();
  return { status: res.status, body };
}

describe("experiments route", () => {
  it("returns registry definitions with resolved values", async () => {
    const { engine } = makeEngine();
    const route = createExperimentsRoute(engine);

    const { status, body } = await (routeFetch as any)(route, "/experiments");

    expect(status).toBe(200);
    const entry = body.experiments.find((item) => item.id === CACHE_SNAPSHOT_EXPERIMENT_ID);
    expect(entry).toBeUndefined();
    const compactionEntry = body.experiments.find((item) => item.id === COMPACTION_MODE_EXPERIMENT_ID);
    expect(compactionEntry.value).toBe("auto");
    expect(compactionEntry.valueSchema.presentation.type).toBe("select");
    expect(compactionEntry.valueSchema.options.map((option) => option.value)).toEqual([
      "auto",
      "cache_preserving",
      "pi_compatible",
    ]);
    const instantEntry = body.experiments.find((item) => item.id === INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID);
    expect(instantEntry.value).toBe(false);
    expect(instantEntry.valueSchema.presentation.type).toBe("toggle");
    const deepseekEntry = body.experiments.find((item) => item.id === DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID);
    expect(deepseekEntry.value).toBe(false);
    expect(deepseekEntry.valueSchema.presentation.type).toBe("toggle");
  });

  it("updates known active experiment ids, hard-disables retired ids, and rejects unknown ids", async () => {
    const { engine, prefsState } = makeEngine();
    const route = createExperimentsRoute(engine);

    const ok = await routeFetch(route, `/experiments/${encodeURIComponent(CACHE_SNAPSHOT_EXPERIMENT_ID)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "shadow" }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.value).toBe("off");
    expect(prefsState[CACHE_SNAPSHOT_EXPERIMENT_ID]).toBe("off");

    const mode = await routeFetch(route, `/experiments/${encodeURIComponent(COMPACTION_MODE_EXPERIMENT_ID)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "cache_preserving" }),
    });
    expect(mode.status).toBe(200);
    expect(mode.body.value).toBe("cache_preserving");

    const instant = await routeFetch(route, `/experiments/${encodeURIComponent(INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: true }),
    });
    expect(instant.status).toBe(200);
    expect(instant.body.value).toBe(true);

    const deepseek = await routeFetch(route, `/experiments/${encodeURIComponent(DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: true }),
    });
    expect(deepseek.status).toBe(200);
    expect(deepseek.body.value).toBe(true);

    const bad = await routeFetch(route, "/experiments/unknown.flag", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: true }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/unknown experiment id/);
  });

  it("stores observation under agent experiment directory and requires agentId for route reads", async () => {
    const { engine } = makeEngine();
    const agentDir = engine.getAgentDir("hana");
    writeCacheSnapshotObservation(agentDir, {
      version: 1,
      agentId: "hana",
      sessionPath: "/tmp/session.jsonl",
      trigger: "threshold",
      createdAt: "2026-06-03T00:00:00.000Z",
      mode: "shadow",
      status: "success",
      reason: "",
      usage: { model: "test", cachedTokens: 1, missTokens: 2, latencyMs: 3 },
      summaryPreview: "### 重要事实\n- 无",
      memoryMdPreview: "## 重要事实\n（暂无）",
      baseMemoryMdHash: "base",
      cachePrefixHash: "prefix",
    });

    expect(readCacheSnapshotObservation(agentDir).memoryMdPreview).toContain("重要事实");

    const route = createExperimentsRoute(engine);
    const missing = await (routeFetch as any)(route, "/experiments/memory/cache-snapshot-reflection/observation");
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/agentId/);

    const ok = await (routeFetch as any)(route, "/experiments/memory/cache-snapshot-reflection/observation?agentId=hana");
    expect(ok.status).toBe(200);
    expect(ok.body.observation.memoryMdPreview).toContain("重要事实");

    const deleted = await routeFetch(route, "/experiments/memory/cache-snapshot-reflection/observation?agentId=hana", {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
    expect(readCacheSnapshotObservation(agentDir)).toBeNull();
  });
});
