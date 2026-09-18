import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../core/agent.ts";

// config.yaml 里没有任何代码会写 locale 字段——缺失是常态。Agent.resolveLocale()
// 的语义链是 config.locale（显式覆盖）→ 全局 prefs 的 locale → "en"。
// 用 prompt 里恒定出现的用户档案标题（"# 用户档案" / "# User Profile"）当
// 语言探针，不依赖任何可选内容文件。

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-agent-locale-resolution-"));
  tempDirs.push(dir);
  return dir;
}

function makeAgent(locale?: string) {
  const root = makeTempDir();
  const agentsDir = path.join(root, "agents");
  const productDir = path.join(root, "product");
  const userDir = path.join(root, "user");
  fs.mkdirSync(path.join(agentsDir, "hana"), { recursive: true });
  fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, "yuan", "hanako.md"), "Yuan prompt", "utf-8");

  const agent = new Agent({ id: "hana", agentsDir, productDir, userDir } as any);
  agent._config = {
    // 真实 config.yaml 里没有任何代码会写 locale 字段；不传 locale 时省略这个
    // key（而不是写 locale: undefined），如实还原生产环境里"字段缺失"的现状。
    ...(locale !== undefined ? { locale } : {}),
    agent: { yuan: "hanako" },
    memory: { enabled: false },
    experience: { enabled: false },
  };
  agent.userName = (locale ?? "en").startsWith("zh") ? "用户" : "User";
  agent.agentName = "Hanako";
  return agent;
}

const FROZEN_TIME = new Date("2026-06-04T07:53:00.000Z");

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Agent locale resolution", () => {
  it("falls back to the global preferences locale when config.locale is absent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_TIME);
    const agent = makeAgent(); // config 里完全没有 locale 字段
    agent._cb = { getTimezone: () => "Asia/Shanghai", getLocale: () => "zh-CN" };

    const prompt = agent.buildSystemPrompt({
      forceMemoryEnabled: false,
      forceExperienceEnabled: false,
    });

    expect(prompt).toContain("# 用户档案");
    expect(prompt).not.toContain("# User Profile");
  });

  it("prefers an explicit config.locale over the global preferences locale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_TIME);
    const agent = makeAgent("en"); // 显式手工覆盖为 en
    agent._cb = { getTimezone: () => "Asia/Shanghai", getLocale: () => "zh-CN" };

    const prompt = agent.buildSystemPrompt({
      forceMemoryEnabled: false,
      forceExperienceEnabled: false,
    });

    expect(prompt).toContain("# User Profile");
    expect(prompt).not.toContain("# 用户档案");
  });

  it("falls back to en when neither config.locale nor the global preferences locale is set", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_TIME);
    const agent = makeAgent(); // config 无 locale
    agent._cb = { getTimezone: () => "Asia/Shanghai" }; // 无 getLocale 回调

    const prompt = agent.buildSystemPrompt({
      forceMemoryEnabled: false,
      forceExperienceEnabled: false,
    });

    expect(prompt).toContain("# User Profile");
    expect(prompt).not.toContain("# 用户档案");
  });
});

describe("Agent persona lazy materialization (identity.md/AGENTS.md not seeded)", () => {
  // identity.md / AGENTS.md 不再在创建 agent 时落盘：agentDir 里没有这两个
  // 文件时，personality getter 必须按 agent.resolveLocale() 现选 lib 模板，
  // 且用户改语言后（同一个 agent、同一份未落盘文件）人格模板要跟着换语言，
  // 而不是被锁死在创建时刻的语言。

  function writeIdentityAgentsMdTemplates(productDir: string) {
    fs.mkdirSync(path.join(productDir, "identity-templates", "en"), { recursive: true });
    fs.writeFileSync(path.join(productDir, "identity-templates", "hanako.md"), "中文身份模板\n", "utf-8");
    fs.writeFileSync(path.join(productDir, "identity-templates", "en", "hanako.md"), "English identity template\n", "utf-8");
    fs.mkdirSync(path.join(productDir, "agents-templates", "en"), { recursive: true });
    fs.writeFileSync(path.join(productDir, "agents-templates", "hanako.md"), "中文意识模板\n", "utf-8");
    fs.writeFileSync(path.join(productDir, "agents-templates", "en", "hanako.md"), "English AGENTS.md template\n", "utf-8");
  }

  it("resolves the locale-appropriate template with no identity.md/AGENTS.md on disk, and follows a live locale switch", () => {
    const agent = makeAgent(); // 不显式设置 config.locale，走全局 prefs
    writeIdentityAgentsMdTemplates(agent.productDir);
    agent._cb = { getTimezone: () => "Asia/Shanghai", getLocale: () => "zh-CN" };

    expect(fs.existsSync(path.join(agent.agentDir, "identity.md"))).toBe(false);
    expect(fs.existsSync(path.join(agent.agentDir, "AGENTS.md"))).toBe(false);

    expect(agent.readIdentitySource()).toEqual({ content: "中文身份模板\n", fromTemplate: true });
    expect(agent.readAgentsMdSource()).toEqual({ content: "中文意识模板\n", fromTemplate: true });
    expect(agent.personality).toContain("中文身份模板");
    expect(agent.personality).toContain("中文意识模板");

    // 用户在设置里把全局语言切到英文；agentDir 里仍然没有落盘的
    // identity.md/AGENTS.md（未定制），惰性回落必须立刻跟着换语言。
    agent._cb = { getTimezone: () => "Asia/Shanghai", getLocale: () => "en" };

    expect(agent.readIdentitySource()).toEqual({ content: "English identity template\n", fromTemplate: true });
    expect(agent.readAgentsMdSource()).toEqual({ content: "English AGENTS.md template\n", fromTemplate: true });
    expect(agent.personality).toContain("English identity template");
    expect(agent.personality).toContain("English AGENTS.md template");
    expect(agent.personality).not.toContain("中文身份模板");
    expect(agent.personality).not.toContain("中文意识模板");
  });
});
