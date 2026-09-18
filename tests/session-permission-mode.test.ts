import { describe, expect, it } from "vitest";
import {
  classifySessionPermission,
  normalizeSessionPermissionMode,
} from "../core/session-permission-mode.ts";

describe("session permission modes", () => {
  it("normalizes missing and legacy fields", () => {
    expect(normalizeSessionPermissionMode({})).toBe("auto");
    expect(normalizeSessionPermissionMode({ permissionMode: "auto" })).toBe("auto");
    expect(normalizeSessionPermissionMode({ accessMode: "operate" })).toBe("operate");
    expect(normalizeSessionPermissionMode({ accessMode: "read_only" })).toBe("read_only");
    expect(normalizeSessionPermissionMode({ planMode: true })).toBe("read_only");
  });

  it("classifies information and side-effect tools by mode", () => {
    expect(classifySessionPermission({ mode: "read_only", toolName: "web_search" })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "read_only", toolName: "write" })).toMatchObject({
      action: "deny",
      code: "ACTION_BLOCKED_BY_READ_ONLY",
    });
    expect(classifySessionPermission({ mode: "ask", toolName: "write" })).toMatchObject({
      action: "prompt",
      kind: "tool_action_approval",
    });
    expect(classifySessionPermission({ mode: "auto", toolName: "write" })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "auto", toolName: "bash" })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "auto", toolName: "exec_command", params: { cmd: "npm test" } })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "operate", toolName: "write" })).toEqual({ action: "allow" });
  });

  it("keeps host interactive terminal actions on the review boundary", () => {
    expect(classifySessionPermission({ mode: "read_only", toolName: "exec_command", params: { cmd: "npm test" } })).toMatchObject({
      action: "deny",
      code: "ACTION_BLOCKED_BY_READ_ONLY",
    });
    expect(classifySessionPermission({ mode: "ask", toolName: "exec_command", params: { cmd: "npm test" } })).toMatchObject({
      action: "prompt",
      kind: "tool_action_approval",
    });
    const ttyReview = {
      toolInvocation: {
        action: "run",
        kind: "review",
        capability: "exec_command.run",
      },
    };
    expect(classifySessionPermission({ mode: "auto", toolName: "exec_command", context: ttyReview }))
      .toMatchObject({ action: "review" });
    expect(classifySessionPermission({ mode: "ask", toolName: "exec_command", context: ttyReview }))
      .toMatchObject({ action: "prompt", kind: "tool_action_approval" });
    expect(classifySessionPermission({ mode: "read_only", toolName: "exec_command", context: ttyReview }))
      .toMatchObject({ action: "deny", code: "ACTION_BLOCKED_BY_READ_ONLY" });
  });

  it("classifies tool-owned read and review invocations without a host action table", () => {
    const browserRead = {
      toolInvocation: { action: "screenshot", kind: "read", capability: "browser.screenshot" },
    };
    const browserClick = {
      toolInvocation: { action: "click", kind: "review", capability: "browser.click" },
    };
    expect(classifySessionPermission({ mode: "read_only", toolName: "browser", context: browserRead })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "read_only", toolName: "browser", context: browserClick })).toMatchObject({
      action: "deny",
    });
    expect(classifySessionPermission({ mode: "ask", toolName: "browser", context: browserClick })).toMatchObject({
      action: "prompt",
    });
    expect(classifySessionPermission({ mode: "auto", toolName: "browser", context: browserClick })).toMatchObject({
      action: "review",
    });
    expect(classifySessionPermission({ mode: "operate", toolName: "browser", context: browserClick })).toEqual({ action: "allow" });
  });

  it("classifies terminal inspection, close, and host PTY actions by their real boundary", () => {
    const terminalRead = {
      toolInvocation: { action: "read", kind: "read", capability: "terminal.read" },
    };
    const terminalStart = {
      toolInvocation: { action: "start", kind: "review", capability: "terminal.start" },
    };
    const terminalClose = {
      toolInvocation: { action: "close", kind: "routine", capability: "terminal.close" },
    };
    expect(classifySessionPermission({ mode: "read_only", toolName: "terminal", context: terminalRead })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "read_only", toolName: "terminal", context: terminalStart })).toMatchObject({
      action: "deny",
      code: "ACTION_BLOCKED_BY_READ_ONLY",
    });
    expect(classifySessionPermission({ mode: "ask", toolName: "terminal", context: terminalStart })).toMatchObject({
      action: "prompt",
      kind: "tool_action_approval",
    });
    expect(classifySessionPermission({ mode: "auto", toolName: "terminal", context: terminalStart })).toMatchObject({ action: "review" });
    expect(classifySessionPermission({ mode: "auto", toolName: "terminal", context: terminalClose })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "operate", toolName: "terminal", context: terminalStart })).toEqual({ action: "allow" });
  });

  it("uses the same action class for unattended automation without durable tool grants", () => {
    const routineInvocation = {
      action: "close",
      kind: "routine",
      capability: "terminal.close",
      target: { type: "terminal_process", id: "term_1" },
    };
    const reviewInvocation = {
      action: "post",
      kind: "review",
      capability: "channel.post",
      target: { type: "channel", id: "ch_team" },
    };
    expect(classifySessionPermission({
      mode: "auto",
      toolName: "terminal",
      context: { surface: "automation", toolInvocation: routineInvocation },
    })).toEqual({ action: "allow" });
    expect(classifySessionPermission({
      mode: "auto",
      toolName: "channel",
      context: { surface: "automation", toolInvocation: reviewInvocation },
    })).toMatchObject({ action: "review" });
    expect(classifySessionPermission({
      mode: "read_only",
      toolName: "terminal",
      context: { surface: "automation", toolInvocation: routineInvocation },
    })).toMatchObject({ action: "deny", code: "ACTION_BLOCKED_BY_READ_ONLY" });
    expect(classifySessionPermission({
      mode: "operate",
      toolName: "channel",
      context: { isSubagent: true, surface: "automation", toolInvocation: reviewInvocation },
    })).toMatchObject({ action: "deny", code: "ACTION_BLOCKED_IN_SUBAGENT" });
  });

  it("allows session folder inspection while protecting folder authorization changes", () => {
    expect(classifySessionPermission({ mode: "read_only", toolName: "session_folders", params: { action: "list" } })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "read_only", toolName: "session_folders", params: { action: "add" } })).toMatchObject({
      action: "deny",
      code: "ACTION_BLOCKED_BY_READ_ONLY",
    });
    expect(classifySessionPermission({ mode: "ask", toolName: "session_folders", params: { action: "add" } })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "auto", toolName: "session_folders", params: { action: "add" } })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "operate", toolName: "session_folders", params: { action: "remove" } })).toEqual({ action: "allow" });
  });

  it("auto mode reviews only unsandboxed or long-lived boundary changes", () => {
    for (const toolName of ["write", "edit", "bash", "exec_command", "file", "todo_write", "subagent", "workflow"]) {
      expect(classifySessionPermission({ mode: "auto", toolName, params: { action: "copy" } }), toolName)
        .toEqual({ action: "allow" });
    }
    for (const toolName of ["browser", "update_settings", "dm", "channel", "notify", "stage_files", "pin_memory", "unpin_memory", "record_experience", "automation"]) {
      expect(classifySessionPermission({ mode: "auto", toolName, params: { action: toolName === "browser" ? "click" : "start" } }), toolName)
        .toMatchObject({ action: "review", kind: "tool_action_approval" });
    }
    expect(classifySessionPermission({
      mode: "auto",
      toolName: "terminal",
      context: { toolInvocation: { action: "close", kind: "routine", capability: "terminal.close" } },
    })).toEqual({ action: "allow" });
    for (const [toolName, capability] of [
      ["terminal", "terminal.start"],
      ["write_stdin", "write_stdin.write"],
      ["install_skill", "install_skill.install"],
    ]) {
      expect(classifySessionPermission({
        mode: "auto",
        toolName,
        context: { toolInvocation: { action: "execute", kind: "review", capability } },
      }), toolName).toMatchObject({ action: "review" });
    }
    expect(classifySessionPermission({ mode: "auto", toolName: "computer", params: { action: "start" } }))
      .toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "read_only", toolName: "install_skill", params: { source: "github:user/skill" } }))
      .toMatchObject({ action: "deny", code: "ACTION_BLOCKED_BY_READ_ONLY" });
  });

  it("allows only host-preauthorized phone routine capabilities through read-only mode", () => {
    const invocation = {
      action: "post",
      kind: "routine",
      capability: "channel_reply.post",
    };
    expect(classifySessionPermission({
      mode: "read_only",
      toolName: "channel_reply",
      context: {
        toolInvocation: invocation,
        preAuthorizedRoutineCapabilities: ["channel_reply.post"],
      },
    })).toEqual({ action: "allow" });
    expect(classifySessionPermission({
      mode: "read_only",
      toolName: "channel_reply",
      context: {
        toolInvocation: invocation,
        preAuthorizedRoutineCapabilities: ["channel_pass.decide"],
      },
    })).toMatchObject({ action: "deny", code: "ACTION_BLOCKED_BY_READ_ONLY" });
  });

  it("upgrades externally targeted routine declarations unless the host preauthorizes the exact capability", () => {
    const invocation = {
      action: "post",
      kind: "routine",
      capability: "channel_reply.post",
      target: { type: "channel", id: "ch_team" },
    };
    expect(classifySessionPermission({
      mode: "auto",
      toolName: "channel_reply",
      context: { toolInvocation: invocation },
    })).toMatchObject({ action: "review" });
    expect(classifySessionPermission({
      mode: "auto",
      toolName: "channel_reply",
      context: {
        toolInvocation: invocation,
        preAuthorizedRoutineCapabilities: ["channel_reply.post"],
      },
    })).toEqual({ action: "allow" });
  });

  it("keeps plugin-declared routine actions on automatic review unless host-preauthorized", () => {
    const invocation = {
      action: "render",
      kind: "routine",
      capability: "plugin_render.render",
    };
    expect(classifySessionPermission({
      mode: "auto",
      toolName: "plugin_render",
      context: { isPluginTool: true, toolInvocation: invocation },
    })).toMatchObject({ action: "review" });
    expect(classifySessionPermission({
      mode: "auto",
      toolName: "plugin_render",
      context: {
        isPluginTool: true,
        toolInvocation: invocation,
        preAuthorizedRoutineCapabilities: ["plugin_render.render"],
      },
    })).toEqual({ action: "allow" });
  });

  it("blocks subagent tool inside a subagent (anti-recursion), independent of mode", () => {
    // subagent 上下文：subagent 工具被拦，无论什么 mode（防自递归，拦截层而非剥离）
    expect(classifySessionPermission({ mode: "operate", toolName: "subagent", context: { isSubagent: true } }))
      .toMatchObject({ action: "deny", code: "ACTION_BLOCKED_IN_SUBAGENT" });
    expect(classifySessionPermission({ mode: "read_only", toolName: "subagent", context: { isSubagent: true } }))
      .toMatchObject({ action: "deny", code: "ACTION_BLOCKED_IN_SUBAGENT" });
    // 非 subagent 上下文：subagent 工具按常规（operate 放行）
    expect(classifySessionPermission({ mode: "operate", toolName: "subagent" })).toEqual({ action: "allow" });
    // subagent 上下文里其它工具不受这条影响：read 放行、write 仍按 mode
    expect(classifySessionPermission({ mode: "operate", toolName: "read", context: { isSubagent: true } })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "operate", toolName: "write", context: { isSubagent: true } })).toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "read_only", toolName: "write", context: { isSubagent: true } }))
      .toMatchObject({ action: "deny", code: "ACTION_BLOCKED_BY_READ_ONLY" });
  });

  it("blocks the full subagent越权 tool set inside a subagent (memory/lifecycle/fan-out), independent of mode", () => {
    // subagent 不该碰：污染长期记忆 / 管 agent 一生 / 再扇出。即便最宽松的 operate 也拦。
    const BLOCKED = [
      "subagent",         // 防自递归
      "pin_memory", "unpin_memory", "record_experience", // 长期记忆（subagent 不碰）
      "automation", "cron", "channel", "dm", "notify", "install_skill", "update_settings", "session_folders", // agent 生命周期/对外
      "workflow",         // 间接扇出
    ];
    for (const name of BLOCKED) {
      expect(
        classifySessionPermission({ mode: "operate", toolName: name, context: { isSubagent: true } }),
        `${name} 应在 subagent 上下文被拦`,
      ).toMatchObject({ action: "deny", code: "ACTION_BLOCKED_IN_SUBAGENT" });
      // 非 subagent 上下文：operate 正常放行（限制仅在 subagent 上下文）
      expect(
        classifySessionPermission({ mode: "operate", toolName: name }),
        `${name} 在普通上下文 operate 应放行`,
      ).toEqual({ action: "allow" });
    }
    // computer 不在禁用集（有全局开关兜底）：subagent 上下文 operate 仍放行
    expect(classifySessionPermission({ mode: "operate", toolName: "computer", context: { isSubagent: true } }))
      .toEqual({ action: "allow" });
  });

  it("拦截错误分层（#1614）：deny 结果标明是哪一层拦的，并给出解锁出路", () => {
    // 层 1：conversation tool mode（phone/DM 会话面板可切换）
    const conversation = classifySessionPermission({
      mode: "read_only", toolName: "bash", context: { surface: "conversation" },
    }) as any;
    expect(conversation).toMatchObject({
      action: "deny",
      code: "ACTION_BLOCKED_BY_READ_ONLY",
      details: { toolName: "bash", layer: "conversation" },
    });
    expect(conversation.message).toMatch(/conversation/i);
    expect(conversation.message).toMatch(/settings/i);

    // 层 2：subagent 权限档（read 档；出路 = access:"write" 重派 + 父会话可操作）
    const subagentAccess = classifySessionPermission({
      mode: "read_only", toolName: "bash", context: { isSubagent: true },
    }) as any;
    expect(subagentAccess).toMatchObject({
      action: "deny",
      code: "ACTION_BLOCKED_BY_READ_ONLY",
      details: { toolName: "bash", layer: "subagent_access" },
    });
    expect(subagentAccess.message).toMatch(/access:"write"/);
    expect(subagentAccess.message).toMatch(/parent session/i);

    // 层 3：subagent hard-block（任何档位都不可用）
    const subagentBlocklist = classifySessionPermission({
      mode: "operate", toolName: "dm", context: { isSubagent: true },
    }) as any;
    expect(subagentBlocklist).toMatchObject({
      action: "deny",
      code: "ACTION_BLOCKED_IN_SUBAGENT",
      details: { toolName: "dm", layer: "subagent_blocklist" },
    });
    expect(subagentBlocklist.message).toMatch(/always|regardless/i);
    expect(subagentBlocklist.message).toMatch(/parent session/i);

    // 层 0（普通会话只读，如 plan 模式）：提示切换会话权限档
    const session = classifySessionPermission({ mode: "read_only", toolName: "bash" }) as any;
    expect(session).toMatchObject({
      action: "deny",
      code: "ACTION_BLOCKED_BY_READ_ONLY",
      details: { toolName: "bash", layer: "session" },
    });
    expect(session.message).toMatch(/read-only/i);

    // 动作级分类器（browser/terminal/file/session_folders）同样带分层
    const browserDeny = classifySessionPermission({
      mode: "read_only", toolName: "browser", params: { action: "click" }, context: { surface: "conversation" },
    }) as any;
    expect(browserDeny.details).toMatchObject({ layer: "conversation" });
    const terminalDeny = classifySessionPermission({
      mode: "read_only", toolName: "terminal", params: { action: "start" }, context: { isSubagent: true },
    }) as any;
    expect(terminalDeny.details).toMatchObject({ layer: "subagent_access" });
  });

  it("subagent 继承 ask/auto 权限档，不再坍缩为 operate", () => {
    // subagent 上下文 + ask：分类仍返回 prompt；执行层用 deny_on_prompt 转为结构化 unavailable，避免挂起。
    expect(classifySessionPermission({ mode: "ask", toolName: "write", context: { isSubagent: true } }))
      .toMatchObject({ action: "prompt", kind: "tool_action_approval" });
    expect(classifySessionPermission({ mode: "ask", toolName: "bash", context: { isSubagent: true } }))
      .toMatchObject({ action: "prompt", kind: "tool_action_approval" });
    // browser/terminal 的写动作同理：继承 ask/auto 语义，不悄悄放大权限。
    expect(classifySessionPermission({ mode: "ask", toolName: "browser", params: { action: "click" }, context: { isSubagent: true } }))
      .toMatchObject({ action: "prompt", kind: "tool_action_approval" });
    expect(classifySessionPermission({ mode: "ask", toolName: "terminal", params: { action: "start" }, context: { isSubagent: true } }))
      .toMatchObject({ action: "prompt", kind: "tool_action_approval" });
    expect(classifySessionPermission({ mode: "auto", toolName: "write", context: { isSubagent: true } }))
      .toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "auto", toolName: "bash", context: { isSubagent: true } }))
      .toEqual({ action: "allow" });
    expect(classifySessionPermission({ mode: "auto", toolName: "browser", params: { action: "click" }, context: { isSubagent: true } }))
      .toMatchObject({ action: "review", kind: "tool_action_approval" });
    // 非 subagent 上下文：ask 照常 prompt（不受影响）
    expect(classifySessionPermission({ mode: "ask", toolName: "write" }))
      .toMatchObject({ action: "prompt" });
    // subagent + ask 仍挡越权工具（坍缩只影响 ask→operate，不放开禁用集）
    expect(classifySessionPermission({ mode: "ask", toolName: "pin_memory", context: { isSubagent: true } }))
      .toMatchObject({ action: "deny", code: "ACTION_BLOCKED_IN_SUBAGENT" });
  });

  describe("session-scoped invocation pre-authorization", () => {
    const reviewInvocation = {
      action: "invoke",
      kind: "review",
      capability: "mcp_acme_search.invoke",
    };

    it("allows a pre-authorized capability whatever the declared kind", () => {
      // The whole point of the session grant is that it outranks the kind:
      // a "review" descriptor is exactly what the user was asked about.
      for (const mode of ["auto", "ask"]) {
        expect(classifySessionPermission({
          mode,
          toolName: "mcp_acme_search",
          context: {
            toolInvocation: reviewInvocation,
            preAuthorizedInvocationCapabilities: ["mcp_acme_search.invoke"],
          },
        })).toEqual({ action: "allow" });
      }

      const routineInvocation = {
        action: "post",
        kind: "routine",
        capability: "channel_reply.post",
        target: { type: "channel", id: "ch_team" },
      };
      expect(classifySessionPermission({
        mode: "auto",
        toolName: "channel_reply",
        context: {
          toolInvocation: routineInvocation,
          preAuthorizedInvocationCapabilities: ["channel_reply.post"],
        },
      })).toEqual({ action: "allow" });
    });

    it("leaves every existing branch untouched when the capability does not match", () => {
      for (const preAuthorizedInvocationCapabilities of [
        undefined,
        [],
        ["mcp_other_tool.invoke"],
        // A non-array must be ignored rather than throwing or coercing.
        "mcp_acme_search.invoke" as any,
      ]) {
        expect(classifySessionPermission({
          mode: "auto",
          toolName: "mcp_acme_search",
          context: { toolInvocation: reviewInvocation, preAuthorizedInvocationCapabilities },
        })).toMatchObject({ action: "review" });
        expect(classifySessionPermission({
          mode: "ask",
          toolName: "mcp_acme_search",
          context: { toolInvocation: reviewInvocation, preAuthorizedInvocationCapabilities },
        })).toMatchObject({ action: "prompt" });
        expect(classifySessionPermission({
          mode: "read_only",
          toolName: "mcp_acme_search",
          context: { toolInvocation: reviewInvocation, preAuthorizedInvocationCapabilities },
        })).toMatchObject({ action: "deny", code: "ACTION_BLOCKED_BY_READ_ONLY" });
        expect(classifySessionPermission({
          mode: "operate",
          toolName: "mcp_acme_search",
          context: { toolInvocation: reviewInvocation, preAuthorizedInvocationCapabilities },
        })).toEqual({ action: "allow" });
      }
    });

    it("keeps the routine pre-authorization list independent", () => {
      const routineInvocation = {
        action: "post",
        kind: "routine",
        capability: "channel_reply.post",
        target: { type: "channel", id: "ch_team" },
      };
      // The existing routine list still works on its own,
      expect(classifySessionPermission({
        mode: "auto",
        toolName: "channel_reply",
        context: {
          toolInvocation: routineInvocation,
          preAuthorizedRoutineCapabilities: ["channel_reply.post"],
        },
      })).toEqual({ action: "allow" });
      // and it still does not grant anything to a review-kind invocation.
      expect(classifySessionPermission({
        mode: "auto",
        toolName: "mcp_acme_search",
        context: {
          toolInvocation: reviewInvocation,
          preAuthorizedRoutineCapabilities: ["mcp_acme_search.invoke"],
        },
      })).toMatchObject({ action: "review" });
    });
  });
});
