import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalPlatform = process.platform;
const describeUnlessWindows = process.platform === "win32" ? describe.skip : describe;

async function importToolWrapperAsWin32() {
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.resetModules();
  return import("../lib/sandbox/tool-wrapper.ts");
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("wrapBashTool Windows PathGuard preflight", () => {
  it("lets command reads use the current user's normal Windows permissions", async () => {
    const { wrapBashTool } = await importToolWrapperAsWin32();
    const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
    const guard = {
      check: vi.fn(() => ({ allowed: false, reason: "blocked" })),
    };

    const wrapped = wrapBashTool(tool, guard, "D:\\workspace");
    const result = await wrapped.execute("call-1", {
      command: 'cat "/c/Users/alice/Desktop/reference.md"',
    });

    expect(guard.check).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.content[0].text).toBe("ok");
  });

  it("checks bash redirection targets as writes", async () => {
    const { wrapBashTool } = await importToolWrapperAsWin32();
    const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
    const guard = {
      check: vi.fn(() => ({ allowed: false, reason: "blocked" })),
    };

    const wrapped = wrapBashTool(tool, guard, "D:\\workspace");
    const result = await wrapped.execute("call-2", {
      command: 'printf secret > "/c/Users/alice/.ssh/config"',
    });

    expect(guard.check).toHaveBeenCalledWith("C:\\Users\\alice\\.ssh\\config", "write");
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.content[0].text).toBeTruthy();
  });

  it("checks mutating shell command operands with their operation intent", async () => {
    const { wrapBashTool } = await importToolWrapperAsWin32();
    const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
    const guard = {
      check: vi.fn(() => ({ allowed: false, reason: "blocked" })),
    };

    const wrapped = wrapBashTool(tool, guard, "D:\\workspace");
    await wrapped.execute("call-3", {
      command: "rm -rf /c/Users/alice/.ssh",
    });

    expect(guard.check).toHaveBeenCalledWith("C:\\Users\\alice\\.ssh", "delete");
    expect(tool.execute).not.toHaveBeenCalled();
  });
});

describeUnlessWindows("wrapBashTool POSIX redirection preflight", () => {
  it("allows redirection to the POSIX null device without treating it as a workspace write", async () => {
    const { wrapBashTool } = await import("../lib/sandbox/tool-wrapper.ts");
    const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
    const guard = {
      check: vi.fn((_filePath, operation) => (
        operation === "write"
          ? { allowed: false, reason: "blocked" }
          : { allowed: true }
      )),
    };

    const wrapped = wrapBashTool(tool, guard, "/workspace");
    const result = await wrapped.execute("call-dev-null", {
      command: "true 2>/dev/null",
    });

    expect(guard.check).not.toHaveBeenCalledWith("/dev/null", "write");
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.content[0].text).toBe("ok");
  });

  it("still checks destructive operations targeting the POSIX null device", async () => {
    const { wrapBashTool } = await import("../lib/sandbox/tool-wrapper.ts");
    const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
    const guard = {
      check: vi.fn(() => ({ allowed: false, reason: "blocked" })),
    };

    const wrapped = wrapBashTool(tool, guard, "/workspace");
    const result = await wrapped.execute("call-dev-null-rm", {
      command: "rm /dev/null",
    });

    expect(guard.check).toHaveBeenCalledWith("/dev/null", "delete");
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.content[0].text).toBeTruthy();
  });
});

describe("sandbox wrapper dynamic external read grants", () => {
  it("bypasses PathGuard for path tools when sandbox is disabled", async () => {
    const { wrapPathTool } = await import("../lib/sandbox/tool-wrapper.ts");
    const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
    const guard = {
      check: vi.fn(() => ({ allowed: false, reason: "blocked" })),
    };

    const wrapped = wrapPathTool(tool, guard, "write", "D:\\workspace", {
      getSandboxEnabled: () => false,
    });
    const result = await wrapped.execute("call-disabled-path", { path: "C:\\outside\\note.md" });

    expect(guard.check).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result.content[0].text).toBe("ok");
  });

  it("uses the unsandboxed bash fallback and skips PathGuard when sandbox is disabled", async () => {
    const { wrapBashTool } = await import("../lib/sandbox/tool-wrapper.ts");
    const sandboxedTool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "sandboxed" }] })) };
    const fallbackTool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "fallback" }] })) };
    const guard = {
      check: vi.fn(() => ({ allowed: false, reason: "blocked" })),
    };

    const wrapped = wrapBashTool(sandboxedTool, guard, "D:\\workspace", {
      getSandboxEnabled: () => false,
      fallbackTool,
    });
    const result = await wrapped.execute("call-disabled-bash", {
      command: "cat C:\\outside\\note.md",
    });

    expect(guard.check).not.toHaveBeenCalled();
    expect(sandboxedTool.execute).not.toHaveBeenCalled();
    expect(fallbackTool.execute).toHaveBeenCalledOnce();
    expect(result.content[0].text).toBe("fallback");
  });

  it("blocks managed config writes before using the unsandboxed bash fallback", async () => {
    const { wrapBashTool } = await import("../lib/sandbox/tool-wrapper.ts");
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-wrapper-managed-config-"));
    try {
      const configPath = path.join(tempRoot, "home", "agents", "hana", "config.yaml");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, "agent:\n  yuan: hanako\n", "utf-8");

      const sandboxedTool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "sandboxed" }] })) };
      const fallbackTool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "fallback" }] })) };
      const guard = {
        check: vi.fn(() => ({ allowed: true })),
      };

      const wrapped = wrapBashTool(sandboxedTool, guard, tempRoot, {
        getSandboxEnabled: () => false,
        fallbackTool,
        checkManagedConfigWrite: (absolutePath, operation) => (
          absolutePath === configPath && operation === "write"
            ? { allowed: false, reason: "managed config files must be changed through settings APIs" }
            : { allowed: true }
        ),
      });
      const result = await wrapped.execute("call-managed-bash", {
        command: `printf 'agent:\\n  yuan: caikangyong\\n' > "${configPath}"`,
      });

      expect(fallbackTool.execute).not.toHaveBeenCalled();
      expect(sandboxedTool.execute).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("managed config files");
      expect(fs.readFileSync(configPath, "utf-8")).toContain("yuan: hanako");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("lets read tools access explicitly granted external session files", async () => {
    const { wrapPathTool } = await import("../lib/sandbox/tool-wrapper.ts");
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-wrapper-read-grant-"));
    try {
      const externalFile = path.join(tempRoot, "outside.md");
      fs.writeFileSync(externalFile, "outside");
      const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
      const guard = {
        check: vi.fn(() => ({ allowed: false, reason: "blocked" })),
      };

      const wrapped = wrapPathTool(tool, guard, "read", tempRoot, {
        getExternalReadPaths: () => [fs.realpathSync(externalFile)],
      });
      const result = await wrapped.execute("call-1", { path: externalFile });

      expect(guard.check).toHaveBeenCalledWith(externalFile, "read");
      expect(tool.execute).toHaveBeenCalledOnce();
      expect(result.content[0].text).toBe("ok");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("lets bash read explicitly granted external session files", async () => {
    const { wrapBashTool } = await import("../lib/sandbox/tool-wrapper.ts");
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-wrapper-bash-grant-"));
    try {
      const externalFile = path.join(tempRoot, "outside.md");
      fs.writeFileSync(externalFile, "outside");
      const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
      const guard = {
        check: vi.fn(() => ({ allowed: false, reason: "blocked" })),
      };

      const wrapped = wrapBashTool(tool, guard, tempRoot, {
        getExternalReadPaths: () => [fs.realpathSync(externalFile)],
      });
      const result = await wrapped.execute("call-2", {
        command: `cat "${externalFile}"`,
      });

      if (process.platform === "win32") {
        expect(guard.check).not.toHaveBeenCalled();
      } else {
        expect(guard.check).toHaveBeenCalledWith(externalFile, "read");
      }
      expect(tool.execute).toHaveBeenCalledOnce();
      expect(result.content[0].text).toBe("ok");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
