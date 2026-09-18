// 用户档案 / AGENTS.md / 样貌三段属于事件驱动的稳定段（只在用户改档案或换人格时变），
// 因此排在静态前缀里；记忆与时间会被后台 compile 和时钟自动推动，留在 cache 分界线之后。
// 这个测试锁住那条分界线，防止有人把稳定段又挪回尾部、或把动态段提到前缀里。
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../core/agent.ts";
import {
  readAgentAvatarResource,
  writeAgentAppearanceProfileResource,
} from "../lib/agent-appearance-summary.ts";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-prompt-section-order-"));
  tempDirs.push(dir);
  return dir;
}

function makeAgent(locale: string) {
  const root = makeTempDir();
  const agentsDir = path.join(root, "agents");
  const productDir = path.join(root, "product");
  const userDir = path.join(root, "user");
  const agentDir = path.join(agentsDir, "hana");
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true });
  fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, "yuan", "hanako.md"), "AGENTSMD-TEMPLATE-MARKER", "utf-8");
  fs.writeFileSync(path.join(userDir, "user.md"), "PROFILE-MARKER\n", "utf-8");
  fs.writeFileSync(path.join(agentDir, "pinned.md"), "PINNED-MARKER\n", "utf-8");
  fs.writeFileSync(path.join(agentDir, "memory", "memory.md"), "MEMORY-MARKER\n", "utf-8");

  fs.writeFileSync(path.join(agentDir, "avatars", "agent.png"), Buffer.from("fake-avatar-bytes"));
  const avatar = readAgentAvatarResource(agentDir);
  writeAgentAppearanceProfileResource(agentDir, {
    avatarHash: avatar!.hash,
    summary: "APPEARANCE-MARKER",
    model: null,
  });

  const agent = new Agent({ id: "hana", agentsDir, productDir, userDir } as any);
  agent._config = {
    locale,
    agent: { yuan: "hanako" },
    memory: { enabled: true },
    experience: { enabled: false },
    user: { name: locale.startsWith("zh") ? "黎" : "Li" },
  };
  agent.userName = locale.startsWith("zh") ? "黎" : "Li";
  agent.agentName = "Hanako";
  // 样貌注入依赖 engine 的 vision 能力；这里只关心段位置，直接放行。
  agent._canInjectAppearancePrompt = () => true;
  agent._cb = { getTimezone: () => "Asia/Shanghai" };
  return agent;
}

function orderedIndexes(prompt: string, anchors: string[]) {
  return anchors.map((anchor) => {
    const at = prompt.indexOf(anchor);
    expect(at, `missing prompt anchor: ${anchor}`).toBeGreaterThanOrEqual(0);
    return at;
  });
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("system prompt section order", () => {
  it("keeps profile and persona in the static prefix, memory and clock in the dynamic tail (zh)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T07:53:00.000Z"));

    const prompt = makeAgent("zh-CN").buildSystemPrompt({ forceMemoryEnabled: true });
    const indexes = orderedIndexes(prompt, [
      "# 执行环境",
      "# 用户档案",
      "AGENTSMD-TEMPLATE-MARKER",
      "## 你的样子",
      "## 工具使用纪律",
      "## 记忆使用规则",
      "# 置顶记忆",
      "MEMORY-MARKER",
      "Session started at:",
    ]);

    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("keeps profile and persona in the static prefix, memory and clock in the dynamic tail (en)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T07:53:00.000Z"));

    const prompt = makeAgent("en").buildSystemPrompt({ forceMemoryEnabled: true });
    const indexes = orderedIndexes(prompt, [
      "# Environment",
      "# User Profile",
      "AGENTSMD-TEMPLATE-MARKER",
      "## Your Appearance",
      "## Tool Usage Discipline",
      "## Memory Rules",
      "# Pinned Memories",
      "MEMORY-MARKER",
      "Session started at:",
    ]);

    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });
});
