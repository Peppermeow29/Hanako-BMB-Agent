/**
 * CI 防线：内置工具漏权限声明 / 漏分类的回归测试。
 *
 * 此前 recall_experience 缺少 sessionPermission.resolveInvocation 声明，
 * 逃过了全部测试直达用户 —— 因为 assertAllBuiltInToolsPermissionCovered
 * 这条启动断言只会对运行时实际组装出来的工具集执行，而条件开启的工具
 * （比如经验能力）在 CI 里默认关闭，从未被组装出来过，断言自然从未被
 * 真正跑到过 recall_experience 身上。
 *
 * 这份测试把"全部开关都打开"的真实 Agent 工具快照送进两条启动断言，
 * 确保任何一个内置工具漏声明权限、或漏归类，都会在这里先报红，
 * 而不是等到某个用户打开某个开关才第一次触发。
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/memory/memory-ticker.js", () => ({
  createMemoryTicker: () => ({
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    tick: vi.fn().mockResolvedValue(undefined),
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
  assertAllBuiltInToolsPermissionCovered,
  assertAllToolsCategorized,
  CORE_TOOL_NAMES,
  STANDARD_TOOL_NAMES,
  GLOBAL_TOOL_NAMES,
  OPTIONAL_TOOL_NAMES,
} from "../shared/tool-categories.ts";

// 照抄 tests/session-tool-gating.test.ts 的 bootstrapAgent 构造方式。
function bootstrapAgent(rootDir: string) {
  const agentsDir = path.join(rootDir, "agents");
  const agentDir = path.join(agentsDir, "hana");
  const userDir = path.join(rootDir, "user");
  const channelsDir = path.join(rootDir, "channels");
  fs.mkdirSync(path.join(agentDir, "memory", "summaries"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "desk"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(channelsDir, { recursive: true });

  fs.writeFileSync(
    path.join(agentDir, "config.yaml"),
    [
      "agent:",
      "  name: Hana",
      "  yuan: hanako",
      "user:",
      "  name: Tester",
      "locale: en",
      "memory:",
      "  enabled: false",
      "models:",
      "  chat:",
      "    id: gpt-4",
      "    provider: openai",
    ].join("\n"),
    "utf-8",
  );
  fs.writeFileSync(path.join(agentDir, "identity.md"), "identity\n", "utf-8");
  fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "persona\n", "utf-8");
  fs.writeFileSync(path.join(userDir, "user.md"), "user profile\n", "utf-8");

  const productDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");
  return { agentsDir, productDir, userDir, channelsDir };
}

// 排除表：不能/不需要通过这份 Agent 快照真实构造出来的内置工具，
// 每一项都必须写明理由，禁止为了让测试变绿而静默添加。
const SNAPSHOT_EXEMPT_TOOL_NAMES = [
  // PI 核心文件系统 / 终端工具由 engine.buildTools 内部组装，不经过
  // Agent.getToolsSnapshot；它们已经由 tests/engine-build-tools.test.ts
  // 对真实 buildTools 调用覆盖，不需要在这里重复构造。
  "read", "write", "edit", "exec_command", "write_stdin", "grep", "find", "ls",
  // materialize 与上面这批一样，由 createSandboxedTools 在 engine.buildTools 里
  // 组装（见 lib/sandbox/index.ts 的两个 return 数组），同样不经过
  // Agent.getToolsSnapshot；它自带的 sessionPermission 描述符由
  // tests/resource-io-materialize-tool.test.ts 直接断言覆盖。
  "materialize",
  // 插件承载的合成 OPTIONAL 分类，没有对应的内置工具对象
  // （见 shared/tool-categories.ts 的 PLUGIN_BACKED_OPTIONAL_TOOL_IDS）。
  "beautify", "office",
  // Removed optional surfaces: the source-only build no longer exposes
  // channel collaboration or Computer Use tools.
  "channel", "computer",
];

describe("built-in tool permission/category coverage (full snapshot)", () => {
  const roots: string[] = [];

  afterEach(async () => {
    while (roots.length) {
      fs.rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  async function buildFullSnapshot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-builtin-coverage-"));
    roots.push(root);
    const { agentsDir, productDir, userDir, channelsDir } = bootstrapAgent(root);
    const agent = new Agent({ id: "hana", agentsDir, productDir, userDir, channelsDir } as any);
    agent.setCallbacks({
      getLearnSkills: () => ({ enabled: true }),
      isChannelsEnabled: () => true,
    });

    await agent.init(() => {});

    const snapshot = agent.getToolsSnapshot({
      forceMemoryEnabled: true,
      forceExperienceEnabled: true,
      surface: "desktop",
    });

    return { agent, snapshot };
  }

  it("covers invocation permission for every built-in tool in the fully-enabled snapshot", async () => {
    const { agent, snapshot } = await buildFullSnapshot();
    try {
      expect(() => assertAllBuiltInToolsPermissionCovered(snapshot)).not.toThrow();
    } finally {
      await agent.dispose();
    }
  });

  it("categorizes every tool in the fully-enabled snapshot", async () => {
    const { agent, snapshot } = await buildFullSnapshot();
    try {
      expect(() => assertAllToolsCategorized(snapshot.map((t) => t.name))).not.toThrow();
    } finally {
      await agent.dispose();
    }
  });

  it("assembles every non-exempt catalogued built-in into the snapshot", async () => {
    const { agent, snapshot } = await buildFullSnapshot();
    try {
      const universe = new Set([
        ...CORE_TOOL_NAMES,
        ...STANDARD_TOOL_NAMES,
        ...GLOBAL_TOOL_NAMES,
        ...OPTIONAL_TOOL_NAMES,
      ]);
      const exempt = new Set(SNAPSHOT_EXEMPT_TOOL_NAMES);
      const expected = [...universe].filter((name) => !exempt.has(name));

      const actualNames = new Set(snapshot.map((t) => t.name));
      const missing = expected.filter((name) => !actualNames.has(name));

      expect(missing).toEqual([]);
    } finally {
      await agent.dispose();
    }
  });
});
