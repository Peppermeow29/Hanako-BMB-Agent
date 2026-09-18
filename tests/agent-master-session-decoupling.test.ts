/**
 * 验证 master 与 per-session 开关在 agent.systemPrompt 缓存上的解耦契约。
 *
 * 设计原则（用户口径）：
 *  - master 开关（设置页中的「记忆」总闸）才控制非 session 路径
 *    （巡检/cron/频道/DM/bridge owner 新建快照）是否带记忆
 *  - per-session 开关只管"该 session 自己的对话窗口"，不应该污染所有
 *    非 session 路径共享的全局 prompt cache
 *
 * 这条契约破了的话，用户在某个对话里关掉记忆开关会让巡检也跟着不带记忆。
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { memoryTickerTickMock, memoryTickerStartMock } = vi.hoisted(() => ({
  memoryTickerTickMock: vi.fn().mockResolvedValue(undefined),
  memoryTickerStartMock: vi.fn(),
}));

const AGENT_INIT_TEST_TIMEOUT_MS = 30_000;

vi.mock("../lib/memory/memory-ticker.js", () => ({
  createMemoryTicker: () => ({
    start: memoryTickerStartMock,
    stop: vi.fn().mockResolvedValue(undefined),
    tick: memoryTickerTickMock,
    triggerNow: vi.fn(),
    notifyTurn: vi.fn(),
    notifySessionEnd: vi.fn().mockResolvedValue(undefined),
    notifyPromoted: vi.fn().mockResolvedValue(undefined),
    flushSession: vi.fn().mockResolvedValue(undefined),
    getHealthStatus: vi.fn().mockReturnValue({}),
  }),
}));

import { Agent } from "../core/agent.ts";
import {
  readAgentAvatarResource,
  writeCachedAgentAppearanceSummary,
} from "../lib/agent-appearance-summary.ts";

function bootstrapAgentDir(rootDir) {
  const agentsDir = path.join(rootDir, "agents");
  const agentDir = path.join(agentsDir, "test-agent");
  fs.mkdirSync(path.join(agentDir, "memory", "summaries"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "desk"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "user"), { recursive: true });

  fs.writeFileSync(
    path.join(agentDir, "config.yaml"),
    [
      "agent:",
      "  name: TestAgent",
      "  yuan: hanako",
      "user:",
      "  name: Tester",
      "locale: en",
      "memory:",
      "  enabled: true",
      "models:",
      "  chat:",
      "    id: gpt-4",
      "    provider: openai",
    ].join("\n"),
    "utf-8",
  );
  fs.writeFileSync(path.join(agentDir, "identity.md"), "I am the test agent.\n", "utf-8");
  fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "persona body\n", "utf-8");
  fs.writeFileSync(path.join(agentDir, "pinned.md"), "PINNED_MEMORY_BEACON\n", "utf-8");
  fs.writeFileSync(path.join(agentDir, "memory", "memory.md"), "MEMORY_MD_BEACON\n", "utf-8");
  fs.writeFileSync(path.join(rootDir, "user", "user.md"), "user profile\n", "utf-8");
  return { agentDir, agentsDir };
}

function makeAgent(agentsDir, rootDir) {
  return new Agent({
    id: "test-agent",
    agentsDir,
    userDir: path.join(rootDir, "user"),
    productDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "lib"),
  } as any);
}

function writeAgentAvatar(agentDir) {
  fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "avatars", "agent.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw6N6wAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const resource = readAgentAvatarResource(agentDir);
  if (!resource) throw new Error("expected test avatar resource");
  return resource;
}

describe("agent.systemPrompt: master / per-session 解耦", { timeout: AGENT_INIT_TEST_TIMEOUT_MS }, () => {
  let tmpDir;
  let agentsDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-master-decouple-"));
    ({ agentsDir } = bootstrapAgentDir(tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("setMemoryEnabled(false) 不修改 agent.systemPrompt 缓存（per-session 不污染全局）", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});
    const before = agent.systemPrompt;
    expect(before).toContain("MEMORY_MD_BEACON");
    expect(before).toContain("PINNED_MEMORY_BEACON");

    agent.setMemoryEnabled(false);
    expect(agent.sessionMemoryEnabled).toBe(false);
    // 关键：setMemoryEnabled 不应该重建 _systemPrompt
    expect(agent.systemPrompt).toBe(before);
    expect(agent.systemPrompt).toContain("MEMORY_MD_BEACON");

    await agent.dispose();
  });

  it("setMemoryMasterEnabled(false) 让 systemPrompt 反映「不带记忆」", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});
    expect(agent.systemPrompt).toContain("MEMORY_MD_BEACON");

    agent.setMemoryMasterEnabled(false);
    expect(agent.memoryMasterEnabled).toBe(false);
    expect(agent.systemPrompt).not.toContain("MEMORY_MD_BEACON");
    expect(agent.systemPrompt).not.toContain("PINNED_MEMORY_BEACON");

    agent.setMemoryMasterEnabled(true);
    expect(agent.systemPrompt).toContain("MEMORY_MD_BEACON");

    await agent.dispose();
  });

  it("master 开着、session 关着时，agent.systemPrompt 仍按 master 带记忆（巡检/cron 不被 session 污染）", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});

    agent.setMemoryEnabled(false); // session 关
    expect(agent.memoryMasterEnabled).toBe(true);
    expect(agent.sessionMemoryEnabled).toBe(false);

    // 这是核心：非 session 路径拿的就是 systemPrompt cache
    expect(agent.systemPrompt).toContain("MEMORY_MD_BEACON");
    expect(agent.systemPrompt).toContain("PINNED_MEMORY_BEACON");

    await agent.dispose();
  });

  it("session 路径仍能用 buildSystemPrompt({ forceMemoryEnabled }) 自己构建带/不带记忆的快照", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});

    const onSnapshot = agent.buildSystemPrompt({ forceMemoryEnabled: true });
    const offSnapshot = agent.buildSystemPrompt({ forceMemoryEnabled: false });

    expect(onSnapshot).toContain("MEMORY_MD_BEACON");
    expect(offSnapshot).not.toContain("MEMORY_MD_BEACON");

    await agent.dispose();
  });

  it("agent base prompt 不缓存具体 cwd，也不重复 Scope / CWD 语义", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});
    agent._config.locale = "zh-CN";

    const prompt = agent.buildSystemPrompt({ forceMemoryEnabled: false });

    expect(prompt).not.toContain("## 工作台");
    expect(prompt).not.toContain("## 工作区范围");
    expect(prompt).not.toContain("当前工作目录");
    expect(prompt).not.toContain("/workspace/Desktop/project-hana");

    agent._config.locale = "en-US";
    const enPrompt = agent.buildSystemPrompt({ forceMemoryEnabled: false });
    expect(enPrompt).not.toContain("## Workspace");
    expect(enPrompt).not.toContain("## Workspace Scope");
    expect(enPrompt).not.toContain("Current working directory");
    expect(enPrompt).not.toContain("Relative paths");

    await agent.dispose();
  });

  it("system prompt guides structured file edits separately from shell commands", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});

    const prompt = agent.buildSystemPrompt({ forceMemoryEnabled: false });

    expect(prompt).toContain("## Tool Usage Discipline");
    expect(prompt).toContain("Use read/grep/find/ls to inspect files and directories");
    expect(prompt).toContain("use edit for source-code changes and write for new or fully replaced files");
    expect(prompt).toContain("do not use shell redirection to modify source files.");

    await agent.dispose();
  });

  it("system prompt tells the agent to query UI context for visible/current references", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});

    const prompt = agent.buildSystemPrompt({ forceMemoryEnabled: false });

    expect(prompt).toContain("## Visible UI Context");
    expect(prompt).toContain("current_status");
    expect(prompt).toContain("ui_context");
    expect(prompt).toContain("current, open, visible, selected, pinned");

    agent._config.locale = "zh-CN";
    const zhPrompt = agent.buildSystemPrompt({ forceMemoryEnabled: false });
    expect(zhPrompt).toContain("## 可见 UI 上下文");
    expect(zhPrompt).toContain("current_status");
    expect(zhPrompt).toContain("ui_context");
    expect(zhPrompt).toContain("这个、当前、打开的、可见的、选中的、置顶的");

    await agent.dispose();
  });

  it("中文 system prompt 同样区分文件工具和 shell 命令", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});
    agent._config.locale = "zh-CN";

    const prompt = agent.buildSystemPrompt({ forceMemoryEnabled: false });

    expect(prompt).toContain("## 工具使用纪律");
    expect(prompt).toContain("查看文件和目录用 read/grep/find/ls");
    expect(prompt).toContain("改已有源码用 edit、新建或全量替换用 write，不要用 shell 重定向改源码。");

    await agent.dispose();
  });

  it("system prompt 注入缓存后的 Agent 自我外观，而不是图片说明", async () => {
    const { agentDir } = bootstrapAgentDir(tmpDir);
    const avatar = writeAgentAvatar(agentDir);
    writeCachedAgentAppearanceSummary(agentDir, {
      avatarHash: avatar.hash,
      summary: "你的形象是银白色短发，神情安静，穿着深色外套。",
      model: "vision-a",
    });

    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});
    agent._config.locale = "zh-CN";

    const targetModel = { id: "chat-vision", provider: "openai", input: ["text", "image"] };
    const prompt = agent.buildSystemPrompt({ forceMemoryEnabled: false, targetModel });

    expect(prompt).toContain("## 你的样子");
    expect(prompt).toContain("你的形象是银白色短发，神情安静，穿着深色外套。");
    expect(prompt).not.toContain("来自图片分析");
    expect(prompt).not.toContain("这张头像");
    expect(prompt.indexOf("persona body")).toBeLessThan(prompt.indexOf("## 你的样子"));

    const subagentPrompt = agent.buildSystemPrompt({ forceMemoryEnabled: false, forSubagent: true, targetModel });
    expect(subagentPrompt).not.toContain("## 你的样子");

    await agent.dispose();
  });

  it("没有看图能力时，即使有旧外观缓存也不注入 system prompt", async () => {
    const { agentDir } = bootstrapAgentDir(tmpDir);
    const avatar = writeAgentAvatar(agentDir);
    writeCachedAgentAppearanceSummary(agentDir, {
      avatarHash: avatar.hash,
      summary: "你的形象是银白色短发，神情安静。",
      model: "vision-a",
    });

    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});
    agent._config.locale = "zh-CN";

    const prompt = agent.buildSystemPrompt({
      forceMemoryEnabled: false,
      targetModel: { id: "text-only", provider: "openai", input: ["text"] },
    });

    expect(prompt).not.toContain("## 你的样子");
    expect(prompt).not.toContain("银白色短发");

    await agent.dispose();
  });

  it("system prompt 不注入过期头像对应的外观缓存", async () => {
    const { agentDir } = bootstrapAgentDir(tmpDir);
    const avatar = writeAgentAvatar(agentDir);
    writeCachedAgentAppearanceSummary(agentDir, {
      avatarHash: avatar.hash,
      summary: "你的形象是银白色短发，神情安静。",
      model: "vision-a",
    });
    fs.writeFileSync(path.join(agentDir, "avatars", "agent.png"), Buffer.from("changed-avatar"));

    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});
    agent._config.locale = "zh-CN";

    const prompt = agent.buildSystemPrompt({
      forceMemoryEnabled: false,
      targetModel: { id: "chat-vision", provider: "openai", input: ["text", "image"] },
    });

    expect(prompt).not.toContain("## 你的样子");
    expect(prompt).not.toContain("银白色短发");

    await agent.dispose();
  });

  it("workspace instruction files are opt-in and disabled by default", async () => {
    const cwd = path.join(tmpDir, "workspace");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "DEFAULT_DISABLED_AGENTS_BEACON\n", "utf-8");
    fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "DEFAULT_DISABLED_CLAUDE_BEACON\n", "utf-8");

    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});

    agent.setCallbacks({ getCwd: () => cwd });
    const prompt = agent.buildSystemPrompt({ forceMemoryEnabled: false });

    expect(prompt).not.toContain("DEFAULT_DISABLED_AGENTS_BEACON");
    expect(prompt).not.toContain("DEFAULT_DISABLED_CLAUDE_BEACON");

    await agent.dispose();
  });

  it("keeps enabled workspace instruction files out of the agent base prompt", async () => {
    const repoRoot = path.join(tmpDir, "workspace");
    const nestedCwd = path.join(repoRoot, "packages", "app");
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    fs.mkdirSync(nestedCwd, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "OUTSIDE_WORKSPACE_BEACON\n", "utf-8");
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "ROOT_AGENTS_BEACON\n", "utf-8");
    fs.writeFileSync(path.join(nestedCwd, "CLAUDE.md"), "NESTED_CLAUDE_BEACON\n", "utf-8");

    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});
    agent._config.workspace_context = {
      inject_agents_md: true,
      inject_claude_md: true,
    };

    agent.setCallbacks({ getCwd: () => nestedCwd });
    const prompt = agent.buildSystemPrompt({ forceMemoryEnabled: true });

    expect(prompt).not.toContain("## Workspace Instructions");
    expect(prompt).not.toContain("ROOT_AGENTS_BEACON");
    expect(prompt).not.toContain("NESTED_CLAUDE_BEACON");
    expect(prompt).not.toContain("OUTSIDE_WORKSPACE_BEACON");

    await agent.dispose();
  });

  it("main system prompt guides Codex-like subagent instance reuse without injecting runtime state", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    await agent.init(() => {});

    const prompt = agent.buildSystemPrompt({ forceMemoryEnabled: false });

    expect(prompt).toContain("## Subagent Collaboration");
    expect(prompt).toContain("current_status");
    expect(prompt).toContain("subagents");
    expect(prompt).toContain("subagent_reply");
    expect(prompt).toContain("subagent_close");
    expect(prompt).not.toContain("thread-a");

    const subagentPrompt = agent.buildSystemPrompt({ forceMemoryEnabled: false, forSubagent: true });
    expect(subagentPrompt).not.toContain("## Subagent Collaboration");

    await agent.dispose();
  });

  it("Computer Use 在不支持的平台上不进入工具快照和 system prompt", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    agent.setCallbacks({
      getEngine: () => ({
        getComputerUseSettings: () => ({ enabled: true }),
        getPrimaryAgentId: () => "test-agent",
        isComputerUseSupported: () => false,
      }),
      getLearnSkills: () => ({}),
      isChannelsEnabled: () => false,
    });
    await agent.init(() => {});

    const toolNames = agent.getToolsSnapshot({ forceMemoryEnabled: false }).map((tool) => tool.name);
    const prompt = agent.buildSystemPrompt({ forceMemoryEnabled: false });

    expect(toolNames).not.toContain("computer");
    expect(prompt).not.toContain("Desktop App Control");

    await agent.dispose();
  });

  it("init 把首次记忆维护交给 manager 调度，不在启动路径直接 tick", async () => {
    const agent = makeAgent(agentsDir, tmpDir);
    const scheduleMemoryMaintenance = vi.fn();
    agent.setCallbacks({
      scheduleMemoryMaintenance,
      getLearnSkills: () => ({}),
      isChannelsEnabled: () => false,
    });

    await agent.init(() => {}, {}, () => ({ id: "gpt-4", provider: "openai" }));

    expect(memoryTickerTickMock).not.toHaveBeenCalled();
    expect(scheduleMemoryMaintenance).toHaveBeenCalledWith("test-agent", "runtime-init");
    expect(memoryTickerStartMock).toHaveBeenCalledOnce();

    await agent.dispose();
  });
});
