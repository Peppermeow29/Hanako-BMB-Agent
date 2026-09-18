import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const originalPlatform = process.platform;
let tempRoot: string | null = null;
const checkAvailability = vi.fn(() => false);
const createBwrapExec = vi.fn((_policy: unknown, _options: {
  getExternalReadPaths?: () => string[];
  getSandboxNetworkEnabled: () => boolean;
}) => (
  vi.fn(async () => ({ exitCode: 0 }))
));
const Type = {
  Object: (properties) => ({ type: "object", properties }),
  String: (options = {}) => ({ type: "string", ...options }),
  Number: (options = {}) => ({ type: "number", ...options }),
  Boolean: (options = {}) => ({ type: "boolean", ...options }),
  Literal: (value) => ({ const: value }),
  Union: (schemas, options = {}) => ({ anyOf: schemas, ...options }),
  Optional: (schema) => schema,
};

beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});

afterAll(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

vi.mock("../lib/sandbox/platform.js", () => ({
  detectPlatform: vi.fn(() => "bwrap"),
  checkAvailability,
}));

vi.mock("../lib/sandbox/bwrap.js", () => ({
  createBwrapExec,
}));

vi.mock("../lib/pi-sdk/index.js", () => {
  const makeTool = (name) => ({
    name,
    parameters: name === "read"
      ? {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
        },
        required: ["path"],
      }
      : undefined,
    execute: vi.fn(async (_toolCallId, params) => ({ content: [], details: { params } })),
  });
  return {
    createReadTool: vi.fn(() => makeTool("read")),
    createWriteTool: vi.fn(() => makeTool("write")),
    createEditTool: vi.fn(() => makeTool("edit")),
    createBashTool: vi.fn((cwd, opts: any = {}) => ({
      name: "bash",
      execute: vi.fn(async (_toolCallId, params) => {
        if (opts.operations?.exec) {
          return opts.operations.exec(params.command, cwd, {});
        }
        return { content: [{ type: "text", text: "direct bash" }] };
      }),
    })),
    createGrepTool: vi.fn(() => makeTool("grep")),
    createFindTool: vi.fn(() => makeTool("find")),
    createLsTool: vi.fn(() => makeTool("ls")),
    Type,
  };
});

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
  vi.resetModules();
  vi.clearAllMocks();
  checkAvailability.mockReturnValue(false);
});

describe("createSandboxedTools on Linux", () => {
  it("fails closed for exec_command when bwrap is unavailable while sandbox remains enabled", async () => {
    const { createSandboxedTools } = await import("../lib/sandbox/index.ts");
    const result = createSandboxedTools("/work", [], {
      agentDir: "/hana/agents/hana",
      workspace: "/work",
      workspaceFolders: [],
      hanakoHome: "/hana",
      getSandboxEnabled: () => true,
    } as any);

    expect(result.tools.find((tool) => tool.name === "bash")).toBeUndefined();
    const execCommand = result.tools.find((tool) => tool.name === "exec_command");
    expect(execCommand.sessionPermission.resolveInvocation({ cmd: "pwd" })).toMatchObject({
      kind: "routine",
      sideEffect: { sandboxed: true, hostIpcAccess: "available" },
    });
    const output = await execCommand.execute("call-1", { cmd: "pwd" });

    expect(output.content[0].text).not.toBe("direct bash");
    expect(output.content[0].text).toMatch(/bwrap|sandbox|沙盒|系统/);
  });

  it("uses the direct bash transport fallback when the user explicitly disables sandbox", async () => {
    const { createSandboxedTools } = await import("../lib/sandbox/index.ts");
    const result = createSandboxedTools("/work", [], {
      agentDir: "/hana/agents/hana",
      workspace: "/work",
      workspaceFolders: [],
      hanakoHome: "/hana",
      getSandboxEnabled: () => false,
    } as any);

    expect(result.tools.find((tool) => tool.name === "bash")).toBeUndefined();
    const execCommand = result.tools.find((tool) => tool.name === "exec_command");
    expect(execCommand.sessionPermission.resolveInvocation({ cmd: "pwd" })).toMatchObject({
      kind: "review",
      sideEffect: { sandboxed: false },
    });
    expect(execCommand.sessionPermission.resolveInvocation({ cmd: "pwd", tty: true })).toMatchObject({
      kind: "review",
      sideEffect: { kind: "interactive_command", sandboxed: false },
    });
    const output = await execCommand.execute("call-2", { cmd: "pwd" });

    expect(output.content[0].text).toBe("direct bash");
  });

  it("uses a network-off runner by default and the persisted network runner only after escalation", async () => {
    checkAvailability.mockReturnValue(true);
    let sandboxNetworkEnabled = true;
    const getSandboxNetworkEnabled = vi.fn(() => sandboxNetworkEnabled);
    const { createSandboxedTools } = await import("../lib/sandbox/index.ts");
    const result = createSandboxedTools("/work", [], {
      agentDir: "/hana/agents/hana",
      workspace: "/work",
      workspaceFolders: [],
      hanakoHome: "/hana",
      getSandboxEnabled: () => true,
      getSandboxNetworkEnabled,
    } as any);
    const execCommand = result.tools.find((tool) => tool.name === "exec_command");

    expect(execCommand.sessionPermission.resolveInvocation({ cmd: "pwd" })).toMatchObject({
      kind: "routine",
      sideEffect: {
        sandboxPermissions: "use_default",
        networkAccess: "blocked",
        hostIpcAccess: "available",
      },
    });
    expect(execCommand.sessionPermission.resolveInvocation({
      cmd: "npm view vitest version",
      sandbox_permissions: "require_escalated",
    })).toMatchObject({
      kind: "review",
      sideEffect: {
        sandboxPermissions: "require_escalated",
        networkAccess: "review_required",
      },
    });

    await execCommand.execute("call-default", { cmd: "pwd" });
    expect(createBwrapExec).toHaveBeenCalledTimes(1);
    const defaultOptions = createBwrapExec.mock.calls[0][1];
    expect(defaultOptions.getSandboxNetworkEnabled()).toBe(false);
    expect(getSandboxNetworkEnabled).not.toHaveBeenCalled();

    await execCommand.execute("call-escalated", {
      cmd: "npm view vitest version",
      sandbox_permissions: "require_escalated",
      justification: "Check the latest published vitest version?",
    });
    expect(createBwrapExec).toHaveBeenCalledTimes(2);
    const escalatedOptions = createBwrapExec.mock.calls[1][1];
    expect(escalatedOptions.getSandboxNetworkEnabled()).toBe(true);
    sandboxNetworkEnabled = false;
    expect(escalatedOptions.getSandboxNetworkEnabled()).toBe(false);
    expect(getSandboxNetworkEnabled).toHaveBeenCalledTimes(2);
  });

  it("resolves read fileId through ResourceIO before path guard and SDK execution", async () => {
    const { createSandboxedTools } = await import("../lib/sandbox/index.ts");
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-linux-session-file-"));
    const agentDir = path.join(tempRoot, "hana", "agents", "hana");
    const workspace = path.join(tempRoot, "work");
    const sessionFilePath = path.join(workspace, "测试123", "报告2026.txt");
    fs.mkdirSync(path.dirname(sessionFilePath), { recursive: true });
    fs.writeFileSync(sessionFilePath, "hello", "utf-8");

    const resolveSessionFileMock = vi.fn((fileId: any, options: any) => {
      expect(fileId).toBe("sf_cjk_digits");
      expect(options).toEqual({ sessionPath: path.join(agentDir, "sessions", "main.jsonl") });
      return {
        fileId,
        filePath: sessionFilePath,
        realPath: sessionFilePath,
        status: "available",
      };
    });

    const result = createSandboxedTools(workspace, [], {
      agentDir,
      workspace,
      workspaceFolders: [],
      hanakoHome: path.join(tempRoot, "hana"),
      getSandboxEnabled: () => true,
      getSessionPath: () => path.join(agentDir, "sessions", "main.jsonl"),
      resolveSessionFile: resolveSessionFileMock,
    } as any);

    const read = result.tools.find((tool) => tool.name === "read");
    expect(read.parameters.required).not.toContain("path");
    expect(read.parameters.properties.fileId).toBeTruthy();
    const output = await read.execute("call-fileid", {
      fileId: "sf_cjk_digits",
    });

    expect(resolveSessionFileMock).toHaveBeenCalledTimes(1);
    expect(output.details.params.path).toBe(fs.realpathSync(sessionFilePath));
    expect(output.details.params.fileId).toBeUndefined();
  });
});
