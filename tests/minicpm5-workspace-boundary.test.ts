import { describe, expect, it, vi } from "vitest";
import { wrapMiniCPM5WorkspaceTools } from "../core/minicpm5-workspace-boundary.ts";

const workspaceRoot = "/tmp/hanako-workspace";

function tool(name: string) {
  return {
    name,
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }], details: {} })),
  };
}

describe("MiniCPM5 CodeLife workspace boundary", () => {
  it("allows paths inside CodeLife and relative paths", async () => {
    const ls = tool("ls");
    const read = tool("read");
    const wrapped = wrapMiniCPM5WorkspaceTools([ls, read], workspaceRoot);

    await wrapped[0].execute("call-ls", { path: "maths" });
    await wrapped[1].execute("call-read", { path: "maths/problem.txt" });

    expect(ls.execute).toHaveBeenCalledOnce();
    expect(read.execute).toHaveBeenCalledOnce();
  });

  it.each([
    ["path tool outside CodeLife", "read", { path: "/tmp/other.txt" }],
    ["find outside CodeLife", "exec_command", { cmd: "find /tmp" }],
    ["parent directory change", "exec_command", { cmd: "cd .. && ls" }],
    ["parent-relative path", "exec_command", { cmd: "ls ../other-project" }],
  ])("rejects %s before invoking the tool", async (_label, name, params) => {
    const original = tool(name);
    const wrapped = wrapMiniCPM5WorkspaceTools([original], workspaceRoot)[0];

    const result = await wrapped.execute("call-boundary", params);

    expect(result).toMatchObject({
      isError: true,
      details: {
        errorCode: "MINICPM5_WORKSPACE_BOUNDARY",
        allowedRoot: workspaceRoot,
      },
    });
    expect(result.content[0].text).toContain("outside CodeLife");
    expect(original.execute).not.toHaveBeenCalled();
  });

  it("leaves unrelated tools unchanged", async () => {
    const notify = tool("notify");
    const wrapped = wrapMiniCPM5WorkspaceTools([notify], workspaceRoot)[0];

    await wrapped.execute("call-notify", { message: "hello" });

    expect(notify.execute).toHaveBeenCalledOnce();
  });
});
