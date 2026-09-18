/**
 * Task 6: 工具装配与门禁 — session 工具 gating 回归。
 *
 * 三件事：
 *   1. subagent 上下文里 session 工具被 SUBAGENT_BLOCKED_TOOLS 拦截（拦截层，非剥离）。
 *   2. Agent.getToolsSnapshot 按 surface 裁剪：desktop 含 session 工具，bridge 不含。
 *   3. session 已在 shared/tool-categories.ts 登记为 OPTIONAL（默认开启，不进
 *      DEFAULT_DISABLED_TOOL_NAMES）。
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
import { classifySessionPermission } from "../core/session-permission-mode.ts";
import { OPTIONAL_TOOL_NAMES, DEFAULT_DISABLED_TOOL_NAMES } from "../shared/tool-categories.ts";

// 照抄 tests/agent-interactive-card-tools.test.ts 的 bootstrapAgent 构造方式
// （agent-config-tools-disabled.test.ts 用的是 fakeAgent 静态数组，不实际调用
// getToolsSnapshot，不适合验证 surface 裁剪的真实行为，改用这份现成的真实构造范本）。
function bootstrapAgent(rootDir: string) {
  const agentsDir = path.join(rootDir, "agents");
  const agentDir = path.join(agentsDir, "hana");
  const userDir = path.join(rootDir, "user");
  fs.mkdirSync(path.join(agentDir, "memory", "summaries"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "desk"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });

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
  return { agentsDir, productDir, userDir };
}

describe("session tool gating (Task 6)", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length) {
      fs.rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it("blocks the session tool inside a subagent context, independent of mode", () => {
    expect(
      classifySessionPermission({ mode: "operate", toolName: "session", context: { isSubagent: true } }),
    ).toMatchObject({ action: "deny", code: "ACTION_BLOCKED_IN_SUBAGENT" });
    const result = classifySessionPermission({
      mode: "operate",
      toolName: "session",
      context: { isSubagent: true },
    }) as any;
    expect(result.message).toContain("not available inside a subagent");
  });

  it("does not block the session tool outside a subagent context (control group)", () => {
    expect(
      classifySessionPermission({ mode: "operate", toolName: "session" }),
    ).toEqual({ action: "allow" });
    expect(
      classifySessionPermission({ mode: "operate", toolName: "session", context: { isSubagent: false } }),
    ).toEqual({ action: "allow" });
  });

  it("includes session tool in desktop snapshot, excludes it from bridge snapshot", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-gating-"));
    roots.push(root);
    const { agentsDir, productDir, userDir } = bootstrapAgent(root);
    const agent = new Agent({ id: "hana", agentsDir, productDir, userDir } as any);
    agent.setCallbacks({
      getLearnSkills: () => ({}),
      isChannelsEnabled: () => false,
    });

    await agent.init(() => {});

    const desktopDefault = agent.getToolsSnapshot({ forceMemoryEnabled: false }).map((tool) => tool.name);
    expect(desktopDefault).toContain("session");

    const desktopExplicit = agent
      .getToolsSnapshot({ forceMemoryEnabled: false, surface: "desktop" })
      .map((tool) => tool.name);
    expect(desktopExplicit).toContain("session");

    const bridgeSnapshot = agent
      .getToolsSnapshot({ forceMemoryEnabled: false, surface: "bridge" })
      .map((tool) => tool.name);
    expect(bridgeSnapshot).not.toContain("session");

    await agent.dispose();
  });

  it("registers session as OPTIONAL (default-on), not in DEFAULT_DISABLED_TOOL_NAMES", () => {
    expect(OPTIONAL_TOOL_NAMES).toContain("session");
    expect(DEFAULT_DISABLED_TOOL_NAMES).not.toContain("session");
  });

  // 灰测事故回归（session-collab auto 权限分类）：auto 模式下 session 工具此前
  // 不被 classifySessionPermission 认识，兜底走 review → LLM 审查非确定误拒
  // send/create（无语义描述时判定为跨 session 写入）。设计意图（spec 决策 3）：
  // send/create 的 execute 只产草稿卡，确认卡本身就是权限关卡，不该走 LLM 审查
  // 双重把关。这里对读侧/写侧 action 在四档权限模式下逐一断言。
  describe("session tool action classification (灰测修复 A)", () => {
    const readActions = ["?", "list", "read"];
    const writeActions = ["send", "create"];
    const unknownActions = ["nuke"];

    for (const action of readActions) {
      it(`read action "${action}" is always allow regardless of mode`, () => {
        for (const mode of ["auto", "operate", "ask", "read_only"]) {
          expect(
            classifySessionPermission({ mode, toolName: "session", params: { action } }),
          ).toEqual({ action: "allow" });
        }
      });
    }

    for (const action of [...writeActions, ...unknownActions]) {
      it(`write-side action "${action}": allow in auto/operate/ask, blocked in read_only`, () => {
        expect(
          classifySessionPermission({ mode: "auto", toolName: "session", params: { action } }),
        ).toEqual({ action: "allow" });
        expect(
          classifySessionPermission({ mode: "operate", toolName: "session", params: { action } }),
        ).toEqual({ action: "allow" });
        expect(
          classifySessionPermission({ mode: "ask", toolName: "session", params: { action } }),
        ).toEqual({ action: "allow" });
        const readOnlyResult = classifySessionPermission({
          mode: "read_only",
          toolName: "session",
          params: { action },
        }) as any;
        expect(readOnlyResult.action).toBe("deny");
        expect(readOnlyResult.message).toContain("read-only");
      });
    }

    it("auto mode never returns review/prompt for the session tool (root cause of the false-deny)", () => {
      for (const action of [...readActions, ...writeActions, ...unknownActions, undefined]) {
        const result = classifySessionPermission({
          mode: "auto",
          toolName: "session",
          params: { action },
        }) as any;
        expect(result.action).not.toBe("review");
        expect(result.action).not.toBe("prompt");
      }
    });
  });
});
