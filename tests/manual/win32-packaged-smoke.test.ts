/**
 * Windows manual smoke test:
 *   $env:HANA_WIN32_SMOKE="1"; npx vitest run tests/manual/win32-packaged-smoke.test.ts
 *
 * Run from a development tree or unpacked install tree to verify the real Windows
 * process-launch paths. Non-Windows hosts and normal test runs skip this suite.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SMOKE_ENABLED = process.platform === "win32" && process.env.HANA_WIN32_SMOKE === "1";
const smokeDescribe = SMOKE_ENABLED ? describe : describe.skip;

smokeDescribe("win32 packaged smoke", () => {
  let workDir: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-win32-smoke-"));
  });

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  async function loadExec() {
    const mod = await import("../../lib/sandbox/win32-exec.ts");
    return mod.createWin32Exec;
  }

  it("1. cmd route launches without sandbox", async () => {
    const exec = (await loadExec())();
    const chunks: string[] = [];
    const result = await exec("ipconfig", workDir, {
      onData: (b: any) => chunks.push(String(b)),
      signal: undefined,
      timeout: 30,
      env: process.env,
    });
    expect(result.exitCode).toBe(0);
    expect(chunks.join("").length).toBeGreaterThan(0);
  });

  it("2. default cmd route launches", async () => {
    const exec = (await loadExec())();
    const chunks: string[] = [];
    const result = await exec("echo smoke-ok", workDir, {
      onData: (b: any) => chunks.push(String(b)),
      signal: undefined,
      timeout: 30,
      env: process.env,
    });
    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toContain("smoke-ok");
  });

  it("3. POSIX route launches via the resolved bash runtime", async () => {
    const exec = (await loadExec())();
    const chunks: string[] = [];
    const result = await exec("printf '%s\\n' smoke-ok | tr a-z A-Z", workDir, {
      onData: (b: any) => chunks.push(String(b)),
      signal: undefined,
      timeout: 60,
      env: process.env,
    });
    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toContain("SMOKE-OK");
  });

  it("4. restricted-token sandbox helper launches when the helper is present", async () => {
    const { resolveWin32SandboxHelper } = await import("../../lib/sandbox/win32-sandbox-helper.ts");
    const helper = resolveWin32SandboxHelper({ env: process.env });
    if (!helper) {
      console.warn("[smoke] hana-win-sandbox.exe not found; sandbox chain NOT verified in this tree");
      return;
    }
    const hanakoHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-smoke-home-"));
    try {
      const { deriveSandboxPolicy } = await import("../../lib/sandbox/policy.ts");
      const policy = deriveSandboxPolicy({
        agentDir: hanakoHome,
        cwd: workDir,
        workspace: workDir,
        workspaceFolders: [],
        hanakoHome,
        mode: "standard",
      });
      const exec = (await loadExec())({ sandbox: { policy, hanakoHome, helperPath: helper } });
      const result = await exec("ipconfig", workDir, {
        onData: () => {},
        signal: undefined,
        timeout: 60,
        env: process.env,
      });
      expect(result.exitCode).toBe(0);
    } finally {
      fs.rmSync(hanakoHome, { recursive: true, force: true });
    }
  });

  it("5. node-pty terminal launches and exits cleanly", async () => {
    const hanakoHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-smoke-term-"));
    try {
      const { TerminalSessionManager } = await import("../../lib/terminal/terminal-session-manager.ts");
      const manager = new TerminalSessionManager({ hanakoHome });
      const sessionPath = path.join(hanakoHome, "smoke-session.jsonl");
      const started = await manager.start({ sessionPath, agentId: "smoke", cwd: workDir });
      expect(started.status).toBe("running");
      expect(started.terminalId).toBeTruthy();
      manager.close({ sessionPath, terminalId: started.terminalId });
    } finally {
      fs.rmSync(hanakoHome, { recursive: true, force: true });
    }
  });

  it("6. missing cwd is rejected with the actionable error, not a fake ENOENT", async () => {
    const exec = (await loadExec())();
    const gone = path.join(workDir, "gone");
    await expect(
      exec("ipconfig", gone, {
        onData: () => {},
        signal: undefined,
        timeout: 30,
        env: process.env,
      }),
    ).rejects.toMatchObject({ code: "HANA_EXEC_CWD_MISSING" });
  });
});
