import { afterEach, describe, expect, it, vi } from "vitest";

const originalPlatform = process.platform;
const createWin32Exec = vi.fn(() => vi.fn(async () => ({ exitCode: 0 })));
const Type = {
  Object: (properties) => ({ type: "object", properties }),
  String: (options = {}) => ({ type: "string", ...options }),
  Number: (options = {}) => ({ type: "number", ...options }),
  Boolean: (options = {}) => ({ type: "boolean", ...options }),
  Literal: (value) => ({ const: value }),
  Union: (schemas, options = {}) => ({ anyOf: schemas, ...options }),
  Optional: (schema) => schema,
};

vi.mock("../lib/sandbox/win32-exec.js", () => ({
  createWin32Exec,
}));

vi.mock("../lib/pi-sdk/index.js", () => {
  const makeTool = (name) => ({ name, execute: vi.fn(async () => ({ content: [] })) });
  return {
    createReadTool: vi.fn(() => makeTool("read")),
    createWriteTool: vi.fn(() => makeTool("write")),
    createEditTool: vi.fn(() => makeTool("edit")),
    createBashTool: vi.fn((cwd, opts: any = {}) => ({
      name: "bash",
      execute: vi.fn((toolCallId, params: any = {}) => {
        const exec = opts.operations?.exec;
        if (!exec) return { content: [] };
        return exec(params.command, cwd, params);
      }),
    })),
    createGrepTool: vi.fn(() => makeTool("grep")),
    createFindTool: vi.fn(() => makeTool("find")),
    createLsTool: vi.fn(() => makeTool("ls")),
    Type,
  };
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.resetModules();
  vi.clearAllMocks();
});

async function buildWin32Tools(overrides: any = {}) {
  Object.defineProperty(process, "platform", { value: "win32" });
  const { createSandboxedTools } = await import("../lib/sandbox/index.ts");
  const { tools } = createSandboxedTools("C:\\work", [], {
    agentDir: "C:\\hana\\agents\\hana",
    workspace: "C:\\work",
    workspaceFolders: [],
    hanakoHome: "C:\\hana",
    getSandboxEnabled: () => true,
    getSandboxNetworkEnabled: () => true,
    getExternalReadPaths: () => [],
    ...overrides,
  } as any);
  const execCommandTool = tools.find((tool) => tool.name === "exec_command");
  return { tools, execCommandTool };
}

describe("createSandboxedTools on Windows", () => {
  it("constructs a sandboxed restricted-token exec plus an unsandboxed fallback exec", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { createSandboxedTools } = await import("../lib/sandbox/index.ts");

    const getExternalReadPaths = () => ["C:\\outside\\brief.md"];
    const getSandboxNetworkEnabled = () => true;
    const { tools } = createSandboxedTools("C:\\work", [], {
      agentDir: "C:\\hana\\agents\\hana",
      workspace: "C:\\work",
      workspaceFolders: [],
      hanakoHome: "C:\\hana",
      getSandboxEnabled: () => true,
      getSandboxNetworkEnabled,
      getExternalReadPaths,
    } as any);

    expect(createWin32Exec).toHaveBeenCalledWith();
    expect(tools.map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "edit",
      "exec_command",
      "write_stdin",
      "grep",
      "find",
      "ls",
      "materialize",
    ]);
    expect(tools.find((tool) => tool.name === "bash")).toBeUndefined();
    const execCommandTool = tools.find((tool) => tool.name === "exec_command");
    expect(execCommandTool.sessionPermission.resolveInvocation({ cmd: "echo ok" })).toMatchObject({
      kind: "review",
      sideEffect: {
        sandboxed: true,
        sandboxPermissions: "use_default",
        networkAccess: "review_required",
        hostIpcAccess: "review_required",
      },
    });
    expect(execCommandTool.sessionPermission.resolveInvocation({
      cmd: "Invoke-WebRequest https://example.com",
      sandbox_permissions: "require_escalated",
    })).toMatchObject({
      kind: "review",
      sideEffect: { sandboxPermissions: "require_escalated" },
    });
    await execCommandTool.execute("call-1", { cmd: "echo ok" });
    expect(createWin32Exec).toHaveBeenCalledWith(expect.objectContaining({
      sandbox: expect.objectContaining({
        policy: expect.objectContaining({ mode: "standard" }),
        hanakoHome: "C:\\hana",
        getExternalReadPaths,
        getSandboxNetworkEnabled,
      }),
    }));
  });

  it("gives require_escalated a distinct unsandboxed runner on win32", async () => {
    const { execCommandTool } = await buildWin32Tools();

    // directWin32Exec is constructed once at wiring time; every default
    // (non-escalated) execution builds a fresh sandboxed exec via
    // createWin32Exec({ sandbox }). The escalated runner must reuse the
    // single directWin32Exec instance instead of constructing a new
    // sandboxed exec, so createWin32Exec's call count must not grow when
    // an escalated command runs.
    await execCommandTool.execute("call-default", { cmd: "echo ok" }, null, null, {});
    const callsAfterDefault = createWin32Exec.mock.calls.length;
    expect(callsAfterDefault).toBeGreaterThan(0);

    await execCommandTool.execute("call-escalated", {
      cmd: "powershell -NoProfile -NonInteractive -Command \"[Console]::Out.Write('ok')\"",
      sandbox_permissions: "require_escalated",
      justification: "Run a PowerShell probe to confirm the sandbox no longer blocks it?",
    }, null, null, {});

    expect(createWin32Exec.mock.calls.length).toBe(callsAfterDefault);
  });

  it("keeps escalated exec_command invocations in review kind on win32", async () => {
    const { execCommandTool } = await buildWin32Tools();

    const invocation = execCommandTool.sessionPermission.resolveInvocation({
      cmd: "wmic path Win32_VideoController get Name",
      sandbox_permissions: "require_escalated",
      justification: "Read GPU inventory?",
    });

    expect(invocation.kind).toBe("review");
  });
});
