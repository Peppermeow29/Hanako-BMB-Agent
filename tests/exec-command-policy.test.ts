import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommandDescription } from "../lib/exec-command/guidance.ts";
import { classifyExecCommand } from "../lib/exec-command/policy.ts";
import { renderCommandForExecShell, renderCommandWithWorkdir, resolveExecShell } from "../lib/exec-command/shell.ts";
import { checkCommandExecutionAccess } from "../lib/sandbox/tool-wrapper.ts";

describe("exec_command policy and shell rendering", () => {
  it("describes PowerShell as the Windows default and requires escalation when sandboxing blocks a command", () => {
    const description = execCommandDescription({ platform: "win32" });
    expect(description).toContain("default one-shot shell is PowerShell");
    expect(description).toContain('shell="cmd"');
    expect(description).toContain('sandbox_permissions="require_escalated"');
  });

  it("flags POSIX heredocs on Windows before they hit PowerShell", () => {
    const result = classifyExecCommand("python - <<'PY'\nprint('x')\nPY", { platform: "win32" });

    expect(result).toMatchObject({
      unsupportedSyntax: true,
      errorCode: "EXEC_COMMAND_POSIX_SYNTAX_ON_WINDOWS",
      reason: "posix-heredoc-on-windows",
    });
  });

  it("classifies common Windows probes as safe or probe-level commands", () => {
    expect(classifyExecCommand("Get-Command python", { platform: "win32" })).toMatchObject({
      kind: "safe",
      executable: "get-command",
    });
    expect(classifyExecCommand("python --version", { platform: "win32" })).toMatchObject({
      kind: "probe",
      executable: "python",
    });
  });

  it("keeps Windows auto shell raw and wraps explicit shell overrides", () => {
    const auto = resolveExecShell({ platform: "win32" });
    expect(auto).toMatchObject({ family: "powershell", label: "powershell", explicit: false });
    expect(renderCommandForExecShell("dir", auto, { platform: "win32" })).toBe("dir");

    const cmd = resolveExecShell({ shell: "cmd", platform: "win32" });
    expect(renderCommandForExecShell("dir", cmd, { platform: "win32" })).toBe('cmd.exe /d /s /c "dir"');

    const bash = resolveExecShell({ shell: "bash", platform: "win32" });
    expect(renderCommandForExecShell("ls -la", bash, { platform: "win32" })).toBe("bash -lc 'ls -la'");

    const powershell = resolveExecShell({ shell: "powershell", platform: "win32" });
    expect(renderCommandForExecShell('Write-Output "ok"', powershell, { platform: "win32" }))
      .toBe('powershell.exe -NoProfile -Command "Write-Output \\"ok\\""');
  });

  it("renders workdir inside the selected shell instead of ignoring it", () => {
    const powershell = resolveExecShell({ shell: "powershell", platform: "win32" });
    expect(renderCommandWithWorkdir("Get-ChildItem", powershell, {
      workdir: "C:\\work\\repo",
      defaultCwd: "C:\\work",
      platform: "win32",
    })).toBe("Set-Location -LiteralPath 'C:\\work\\repo'; Get-ChildItem");

    const auto = resolveExecShell({ platform: "win32" });
    expect(renderCommandWithWorkdir("dir", auto, {
      workdir: "C:\\work\\repo",
      defaultCwd: "C:\\work",
      platform: "win32",
    })).toBe("Set-Location -LiteralPath 'C:\\work\\repo'; dir");

    const posix = resolveExecShell({ platform: "linux" });
    expect(renderCommandWithWorkdir("pwd", posix, {
      workdir: "/tmp/repo",
      defaultCwd: "/tmp",
      platform: "linux",
    })).toBe("cd '/tmp/repo' && pwd");
  });
});

describe("Windows preflight escalation tiers", () => {
  const originalPlatform = process.platform;
  const guard = { check: () => ({ allowed: true }), getAccessLevel: () => "read" };
  const cwd = "C:\\work";
  const opts = { getSandboxEnabled: () => true };

  function blockedText(result: any) {
    return result?.blocked?.content?.[0]?.text || "";
  }

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("blocks wmic in sandboxed mode with an escalation hint", () => {
    const result = checkCommandExecutionAccess("wmic path Win32_OperatingSystem get Caption", guard, cwd, opts);
    expect(result.blocked).not.toBeNull();
    expect(blockedText(result)).toContain("require_escalated");
  });

  it("allows wmic through the escalated wrapper", () => {
    const result = checkCommandExecutionAccess("wmic path Win32_OperatingSystem get Caption", guard, cwd, { ...opts, escalated: true });
    expect(result.blocked).toBeNull();
  });

  it("blocks reg delete even when escalated", () => {
    const result = checkCommandExecutionAccess("reg delete HKCU\\X /f", guard, cwd, { ...opts, escalated: true });
    expect(result.blocked).not.toBeNull();
  });
});
