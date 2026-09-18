/**
 * 迁移 #51：用户名正源从各 agent config 收敛到全局 preferences。
 *
 * 用户名描述的是使用者本人，跨 agent 必须一致。迁移把主 agent 的名字提升成
 * 全局 userName，并清掉各 agent 里与它相同的散落副本。
 *
 * 这些用例跑的是整份迁移表，所以断言的是跑完之后的最终状态：#51 之后紧接着的
 * #52 会把 agent config 里剩下的 user.name 一并删掉（覆盖层已取消）。这里关心
 * 的是 #51 那份载荷——名字被提升到了全局的哪个值上。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { runMigrations } from "../core/migrations.ts";

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

function makeRegistry() {
  return {
    get() { return null; },
    getAllProvidersRaw() { return {}; },
  };
}

describe("migration #51: user name to global preferences", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-migrations-user-name-"));
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgentConfig(agentId, config) {
    const dir = path.join(agentsDir, agentId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.yaml"),
      YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }),
      "utf-8",
    );
  }

  function readAgentConfig(agentId) {
    return YAML.load(fs.readFileSync(path.join(agentsDir, agentId, "config.yaml"), "utf-8"));
  }

  function run(prefs) {
    runMigrations({
      hanakoHome: tmpDir,
      agentsDir,
      prefs,
      providerRegistry: makeRegistry(),
      log: () => {},
    });
  }

  it("promotes the primary agent's name and clears the duplicated copies", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 50, primaryAgent: "hana" });
    writeAgentConfig("mio", { agent: { name: "Mio" }, user: { name: "阿黎" } });
    writeAgentConfig("hana", { agent: { name: "Hana" }, user: { name: "阿黎" } });

    run(prefs);

    expect(prefs.getPreferences().userName).toBe("阿黎");
    // 与全局值相同的散落副本被清掉，空掉的 user 块也一并移除
    expect(readAgentConfig("hana").user).toBeUndefined();
    expect(readAgentConfig("mio").user).toBeUndefined();
    expect(readAgentConfig("hana").agent).toEqual({ name: "Hana" });
  });

  it("promotes the primary agent's name even when another agent had a different one", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 50, primaryAgent: "hana" });
    writeAgentConfig("hana", { user: { name: "阿黎" } });
    writeAgentConfig("mio", { user: { name: "老板" } });

    run(prefs);

    // 主 agent 的名字胜出；另一个 agent 的不同名字由 #52 清掉，不再生效
    expect(prefs.getPreferences().userName).toBe("阿黎");
    expect(readAgentConfig("hana").user).toBeUndefined();
    expect(readAgentConfig("mio").user).toBeUndefined();
  });

  it("takes the first agent that has a name when the primary agent has none", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 50, primaryAgent: "hana" });
    writeAgentConfig("hana", { agent: { name: "Hana" } });
    writeAgentConfig("mio", { user: { name: "阿黎" } });

    run(prefs);

    expect(prefs.getPreferences().userName).toBe("阿黎");
    expect(readAgentConfig("mio").user).toBeUndefined();
  });

  it("writes no global name when no agent has a usable one", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 50, primaryAgent: "hana" });
    writeAgentConfig("hana", { agent: { name: "Hana" }, user: { name: "  " } });

    run(prefs);

    // 空白名字不算名字，不写全局；那个空字段本身由 #52 清掉
    expect(prefs.getPreferences().userName).toBeUndefined();
    expect(readAgentConfig("hana").user).toBeUndefined();
    expect(readAgentConfig("hana").agent).toEqual({ name: "Hana" });
  });

  it("leaves an existing global name alone", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 50, primaryAgent: "hana", userName: "已定名" });
    writeAgentConfig("hana", { user: { name: "阿黎" } });

    run(prefs);

    // 全局已有名字，#51 不覆盖它；agent 里那个不同的名字由 #52 清掉
    expect(prefs.getPreferences().userName).toBe("已定名");
    expect(readAgentConfig("hana").user).toBeUndefined();
  });

  it("is idempotent when the whole registry is replayed", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 50, primaryAgent: "hana" });
    writeAgentConfig("hana", { user: { name: "阿黎" } });
    writeAgentConfig("mio", { user: { name: "老板" } });

    run(prefs);
    // 抹掉迁移收据，强制重放：结果必须与跑一次完全一致
    const replayed = prefs.getPreferences();
    replayed._dataVersion = 50;
    delete replayed._migrationState;
    prefs.savePreferences(replayed);
    run(prefs);

    expect(prefs.getPreferences().userName).toBe("阿黎");
    expect(readAgentConfig("hana").user).toBeUndefined();
    expect(readAgentConfig("mio").user).toBeUndefined();
  });
});
