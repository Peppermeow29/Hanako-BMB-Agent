import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  AUTO_ROUTED_POWERSHELL_COMMAND,
  EXPLICIT_PWSH_COMMAND,
  NODE_MULTILINE_COMMAND,
  PYTHON_MULTILINE_COMMAND,
  QUOTED_REGISTRY_QUERY_COMMAND,
  smokeMultilineCommand,
  smokeQuotedRegistryQuery,
  smokeSandboxedPowerShell,
  smokeWindowsSandboxHelper,
  windowsSandboxHelperPath,
} from "../scripts/smoke-windows-sandbox-helper.mjs";
import {
  restrictedTokenSmokeSpawnOptions,
  restrictedTokenSmokeSpec,
} from "../scripts/windows-sandbox-smoke-lib.mjs";

describe("Windows sandbox helper CI smoke", () => {
  it("resolves the helper produced by the native helper build", () => {
    expect(windowsSandboxHelperPath({ rootDir: "C:\\repo", arch: "x64" }))
      .toBe(path.join("C:\\repo", "dist-sandbox", "win-x64", "hana-win-sandbox.exe"));
  });

  it("fails explicitly outside a Windows runner", () => {
    expect(() => smokeWindowsSandboxHelper({ platform: "darwin" }))
      .toThrow(/requires a Windows runner/);
  });

  it("fails explicitly when the built helper is absent", () => {
    expect(() => smokeWindowsSandboxHelper({
      rootDir: path.join(path.sep, "definitely-missing-hana-helper"),
      platform: "win32",
    })).toThrow(/helper is missing/);
  });

  it("runs cmd directly with the restricted helper on the private desktop", () => {
    const spec = restrictedTokenSmokeSpec({
      layoutRoot: "C:\\HanaCore",
      workDir: "C:\\smoke\\work",
      hanaHome: "C:\\smoke\\home",
      helperPath: "C:\\HanaCore\\sandbox\\windows\\hana-win-sandbox.exe",
      env: { SystemRoot: "C:\\Windows" },
    });

    expect(spec.env.HANA_WIN32_SANDBOX_DEBUG).toBe("1");
    expect(spec.args).not.toContain("--current-desktop");
    expect(spec.args).not.toContain("--verbatim-last-arg");
    expect(spec.args).toContain("C:\\Windows\\System32\\cmd.exe");
    expect(spec.args.at(-1)).toContain("HANA_RESTRICTED_TOKEN_OK");
  });

  it("keeps restricted helper smoke stdin closed like production one-shot execution", () => {
    expect(restrictedTokenSmokeSpawnOptions({
      cwd: "C:\\smoke\\work",
      env: { SystemRoot: "C:\\Windows" },
      timeout: 25_000,
    })).toMatchObject({
      cwd: "C:\\smoke\\work",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 25_000,
    });
  });

  it("fails explicitly outside a Windows runner for the quoted registry query case", async () => {
    await expect(smokeQuotedRegistryQuery({ platform: "darwin" }))
      .rejects.toThrow(/requires a Windows runner/);
  });

  it("fails explicitly outside a Windows runner for the multiline command case", async () => {
    await expect(smokeMultilineCommand({ platform: "darwin" }))
      .rejects.toThrow(/requires a Windows runner/);
  });

  it("fails explicitly outside a Windows runner for the sandboxed PowerShell case", async () => {
    await expect(smokeSandboxedPowerShell({ platform: "darwin" }))
      .rejects.toThrow(/requires a Windows runner/);
  });

  it("carries an embedded double-quoted registry path in the quoted-quote case", () => {
    expect(QUOTED_REGISTRY_QUERY_COMMAND).toContain('"HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"');
    expect(QUOTED_REGISTRY_QUERY_COMMAND.startsWith("reg query ")).toBe(true);
  });

  it("carries a real embedded newline in both multiline command shapes", () => {
    expect(PYTHON_MULTILINE_COMMAND).toContain("\n");
    expect(PYTHON_MULTILINE_COMMAND.startsWith("python -c ")).toBe(true);
    expect(NODE_MULTILINE_COMMAND).toContain("\n");
    expect(NODE_MULTILINE_COMMAND.startsWith("node -e ")).toBe(true);
  });

  it("names PS-OK as the sandboxed PowerShell success marker for both routes", () => {
    expect(AUTO_ROUTED_POWERSHELL_COMMAND).toBe("Write-Output PS-OK");
    expect(EXPLICIT_PWSH_COMMAND.startsWith("pwsh ")).toBe(true);
    expect(EXPLICIT_PWSH_COMMAND).toContain("PS-OK");
  });
});
