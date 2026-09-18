/**
 * 迁移 #52：清除 agent 级 user.name 覆盖层。
 *
 * 用户名描述的是使用者本人，一个用户一个名字：改一次称呼，所有 agent 都得跟着
 * 改口。#51 已经把正源收敛到全局 preferences，但留了"值不同就当作刻意覆盖"的
 * 尾巴。覆盖层现在取消了，读取侧不再看这个字段，所以残留的字段必须一并删掉，
 * 免得配置文件里留着一个再也不生效的名字误导人。
 *
 * 全局值为空时，先按 #51 的同款选择逻辑提升一个上去，再清理，避免把用户唯一
 * 配过的名字直接删没。
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

describe("migration #52: clear agent-level user name overrides", () => {
  let tmpDir, agentsDir, userDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-migrations-user-name-override-"));
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

  it("removes a per-agent name that differs from the global one", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 51, primaryAgent: "hana", userName: "阿黎" });
    writeAgentConfig("hana", { agent: { name: "Hana" } });
    writeAgentConfig("mio", { agent: { name: "Mio" }, user: { name: "老板" } });

    run(prefs);

    expect(prefs.getPreferences().userName).toBe("阿黎");
    expect(readAgentConfig("mio").user).toBeUndefined();
    // 只动 user.name，配置里其它内容原样保留
    expect(readAgentConfig("mio").agent).toEqual({ name: "Mio" });
  });

  it("keeps other keys under user before dropping only the name", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 51, primaryAgent: "hana", userName: "阿黎" });
    writeAgentConfig("hana", { user: { name: "老板", timezone: "Asia/Shanghai" } });

    run(prefs);

    expect(readAgentConfig("hana").user).toEqual({ timezone: "Asia/Shanghai" });
  });

  it("promotes a name to the global slot before clearing when none is set globally", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 51, primaryAgent: "hana" });
    writeAgentConfig("hana", { user: { name: "阿黎" } });
    writeAgentConfig("mio", { user: { name: "老板" } });

    run(prefs);

    // 主 agent 的名字最能代表用户本人，被提升为全局值；其余覆盖一并清掉
    expect(prefs.getPreferences().userName).toBe("阿黎");
    expect(readAgentConfig("hana").user).toBeUndefined();
    expect(readAgentConfig("mio").user).toBeUndefined();
  });

  it("leaves configs without a user name untouched", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 51, primaryAgent: "hana", userName: "阿黎" });
    writeAgentConfig("hana", { agent: { name: "Hana" } });

    run(prefs);

    expect(readAgentConfig("hana")).toEqual({ agent: { name: "Hana" } });
  });

  it("is idempotent when the whole registry is replayed", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 51, primaryAgent: "hana", userName: "阿黎" });
    writeAgentConfig("hana", { agent: { name: "Hana" } });
    writeAgentConfig("mio", { agent: { name: "Mio" }, user: { name: "老板" } });

    run(prefs);
    const afterFirst = {
      prefs: prefs.getPreferences(),
      hana: readAgentConfig("hana"),
      mio: readAgentConfig("mio"),
    };

    // 抹掉迁移收据强制重放：结果必须与跑一次完全一致
    const replayed = prefs.getPreferences();
    replayed._dataVersion = 51;
    delete replayed._migrationState;
    prefs.savePreferences(replayed);
    run(prefs);

    expect(prefs.getPreferences()).toEqual(afterFirst.prefs);
    expect(readAgentConfig("hana")).toEqual(afterFirst.hana);
    expect(readAgentConfig("mio")).toEqual(afterFirst.mio);
  });

  it("runs for a user who never got #51, promoting once and clearing the rest", () => {
    const prefs = makePrefs(userDir);
    prefs.savePreferences({ _dataVersion: 50, primaryAgent: "hana" });
    writeAgentConfig("hana", { user: { name: "阿黎" } });
    writeAgentConfig("mio", { user: { name: "老板" } });

    run(prefs);

    expect(prefs.getPreferences().userName).toBe("阿黎");
    expect(readAgentConfig("hana").user).toBeUndefined();
    expect(readAgentConfig("mio").user).toBeUndefined();
  });
});
