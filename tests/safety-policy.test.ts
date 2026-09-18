import { describe, expect, it, vi } from "vitest";
import { evaluateToolSafetyPolicy } from "../lib/permission/safety-policy.ts";

function request(overrides = {}) {
  return {
    id: "approval-1",
    kind: "tool_action",
    sessionPath: "/tmp/hana/session.jsonl",
    agentId: "hana",
    toolName: "bash",
    actionName: "execute",
    params: { command: "git push origin main" },
    target: { type: "command", label: "git push origin main" },
    blastRadius: "external",
    reversibility: "hard",
    ...overrides,
  };
}

describe("SafetyPolicy", () => {
  it("does not block ordinary git push so it can use normal Hana permissions", () => {
    const decision = evaluateToolSafetyPolicy(request());

    expect(decision).toBeNull();
  });

  it("leaves git push variants written with global git options to the permission mode", () => {
    expect(evaluateToolSafetyPolicy(request({
      params: { command: "git -C /repo push origin main" },
      target: { type: "command", label: "git -C /repo push origin main" },
    }))).toBeNull();
    expect(evaluateToolSafetyPolicy(request({
      params: { command: "git --git-dir /repo/.git push origin --tags" },
      target: { type: "command", label: "git --git-dir /repo/.git push origin --tags" },
    }))).toBeNull();
    expect(evaluateToolSafetyPolicy(request({
      params: { command: "git -c user.name=hana push --force-with-lease origin main" },
      target: { type: "command", label: "git -c user.name=hana push --force-with-lease origin main" },
    }))).toBeNull();
    expect(evaluateToolSafetyPolicy(request({
      params: { command: "git push --all origin" },
      target: { type: "command", label: "git push --all origin" },
    }))).toBeNull();
    expect(evaluateToolSafetyPolicy(request({
      params: { command: "git push --mirror origin" },
      target: { type: "command", label: "git push --mirror origin" },
    }))).toBeNull();
  });

  it("leaves git push nested inside shell command arguments to the permission mode", () => {
    expect(evaluateToolSafetyPolicy(request({
      params: { command: "bash -lc \"cd /repo && git push origin main\"" },
      target: { type: "command", label: "bash -lc \"cd /repo && git push origin main\"" },
    }))).toBeNull();
    expect(evaluateToolSafetyPolicy(request({
      params: { command: "pwsh -NoProfile -Command \"git.exe push --tags\"" },
      target: { type: "command", label: "pwsh -NoProfile -Command \"git.exe push --tags\"" },
    }))).toBeNull();
    expect(evaluateToolSafetyPolicy(request({
      params: { command: "cmd.exe /c \"git push --force origin main\"" },
      target: { type: "command", label: "cmd.exe /c \"git push --force origin main\"" },
    }))).toBeNull();
  });

  it("blocks stage_files when no workspace delivery boundary is available", () => {
    const decision = evaluateToolSafetyPolicy({
      toolName: "stage_files",
      params: { filepaths: ["/workspace/report.txt"] },
    });

    expect(decision).toMatchObject({
      action: "block",
      code: "ACTION_BLOCKED_BY_WORKSPACE_BOUNDARY",
    });
  });

  it("does not block unrelated commands that happen to use --force", () => {
    const marker = vi.fn();
    const decision = evaluateToolSafetyPolicy(request({
      params: { command: "npm install left-pad@1.3.0 --force" },
      target: { type: "command", label: "npm install left-pad@1.3.0 --force" },
    }));

    if (!decision) marker();
    expect(decision).toBeNull();
    expect(marker).toHaveBeenCalledOnce();
  });
});
