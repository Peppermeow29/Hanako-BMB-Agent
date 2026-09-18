import path from "path";
import { describe, expect, it, vi } from "vitest";
import { createMaterializeTool } from "../lib/resource-io/materialize-tool.ts";

// 相对 resource 会被解析成 cwd 下的绝对路径，而绝对路径的形态是平台相关的
// （Windows 上 "/workspace" 会补上当前盘符）。用 path.resolve 构造 cwd 和期望值，
// 让断言跟着平台走，而不是钉死 POSIX 写法。
const CWD = path.resolve("/workspace");
const RESOLVED_NOTE = path.resolve(CWD, "notes/a.md");

function makeTool(overrides: any = {}) {
  const resourceIO = {
    materialize: vi.fn(async () => ({
      resourceKey: "session_file:sf_1",
      resource: { kind: "session-file", fileId: "sf_1", provider: "session_file", filePath: "/data/report.pdf", displayName: "report.pdf" },
      filePath: "/data/report.pdf",
      isDirectory: false,
    })),
    ...overrides.resourceIO,
  };
  const tool = createMaterializeTool({
    resourceIO,
    getSessionPath: () => "/sessions/a.jsonl",
    getSessionIdForPath: (p: string) => (p === "/sessions/a.jsonl" ? "sess_1" : null),
    cwd: CWD,
    ...overrides.options,
  });
  return { tool, resourceIO };
}

describe("materialize tool", () => {
  it("resolves a fileId through ResourceIO materialize with agent audit context", async () => {
    const { tool, resourceIO } = makeTool();

    const result = await tool.execute("m-1", { fileId: "sf_1" });

    expect(resourceIO.materialize).toHaveBeenCalledTimes(1);
    const [ref, context] = resourceIO.materialize.mock.calls[0];
    expect(ref).toEqual({ kind: "session-file", fileId: "sf_1", sessionPath: "/sessions/a.jsonl" });
    expect(context).toMatchObject({
      source: "agent_tool",
      reason: "materialize",
      sessionPath: "/sessions/a.jsonl",
      sessionId: "sess_1",
      auditRead: true,
      principal: expect.objectContaining({ kind: "agent", sessionId: "sess_1", sessionPath: "/sessions/a.jsonl" }),
    });
    expect(result.content[0].text).toContain("/data/report.pdf");
    expect(result.details).toMatchObject({ filePath: "/data/report.pdf", isDirectory: false });
  });

  it("accepts a resource object target and marks directories", async () => {
    const { tool, resourceIO } = makeTool({
      resourceIO: {
        materialize: vi.fn(async () => ({
          resourceKey: "session_file:sf_dir",
          resource: { kind: "session-file", fileId: "sf_dir", provider: "session_file", filePath: "/data/ref-dir", displayName: "ref-dir" },
          filePath: "/data/ref-dir",
          isDirectory: true,
        })),
      },
    });

    const result = await tool.execute("m-2", {
      resource: { kind: "session-file", fileId: "sf_dir", sessionPath: "/sessions/owner.jsonl" },
    });

    expect(resourceIO.materialize.mock.calls[0][0]).toEqual({
      kind: "session-file",
      fileId: "sf_dir",
      sessionPath: "/sessions/owner.jsonl",
    });
    expect(result.content[0].text).toContain("(directory)");
    expect((result.details as { isDirectory?: boolean }).isDirectory).toBe(true);
  });

  it("routes raw local paths through ResourceIO as local-file refs", async () => {
    const { tool, resourceIO } = makeTool({
      resourceIO: {
        materialize: vi.fn(async () => ({
          resourceKey: `local_fs:${RESOLVED_NOTE}`,
          resource: { kind: "local-file", path: RESOLVED_NOTE, provider: "local_fs" },
          filePath: RESOLVED_NOTE,
          isDirectory: false,
        })),
      },
    });

    await tool.execute("m-3", { resource: "notes/a.md" });

    expect(resourceIO.materialize.mock.calls[0][0]).toEqual({
      kind: "local-file",
      path: RESOLVED_NOTE,
    });
  });

  it("reports provider failures honestly as tool errors", async () => {
    const { tool } = makeTool({
      resourceIO: {
        materialize: vi.fn(async () => {
          throw new Error("session file not found: sf_gone");
        }),
      },
    });

    const result = await tool.execute("m-4", { fileId: "sf_gone" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("sf_gone");
  });

  it("rejects calls with no resolvable target", async () => {
    const { tool, resourceIO } = makeTool();

    const result = await tool.execute("m-5", {});

    expect(resourceIO.materialize).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it("declares a read-kind session permission", () => {
    const { tool } = makeTool();
    const invocation = tool.sessionPermission.resolveInvocation({ fileId: "sf_1" });
    expect(invocation).toMatchObject({ kind: "read" });
  });
});
