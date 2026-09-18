/**
 * /api/health 的 sessionStore 附块——真实进程级验证（Task C）。
 *
 * 单元测试（api-health-session-store.test.ts、session-manifest-engine.test.ts）
 * 已经锁死了聚合逻辑与兜底路径的纯函数契约；这里只补一层"真的拉起服务器、真的
 * 发 HTTP 请求"的行为锁，证明附块确实端到端接到了 /api/health 的响应上，而不是
 * 只在单测里孤立成立。用 main-open.ts（开放组合，不含闭集产品路由）而非
 * main-full.ts——这个字段只依赖 open 组合就能验证，没必要背上闭集产品的启动开销。
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";

const root = process.cwd();
const TEMP_HOME_RM_OPTIONS = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 } as const;

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function waitForServerInfo(serverInfoPath: string, child: ReturnType<typeof spawn>, timeoutMs = 60000): Promise<any> {
  return new Promise((resolve, reject) => {
    let exited = false;
    let exitInfo: any = null;
    child.once("exit", (code, signal) => { exited = true; exitInfo = { code, signal }; });
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (exited) {
        reject(new Error(`server exited before writing server-info.json: ${JSON.stringify(exitInfo)}`));
        return;
      }
      try {
        const raw = fs.readFileSync(serverInfoPath, "utf-8");
        resolve(JSON.parse(raw));
        return;
      } catch {
        // not written yet
      }
      if (Date.now() > deadline) {
        reject(new Error("timed out waiting for server-info.json"));
        return;
      }
      setTimeout(poll, 200);
    };
    poll();
  });
}

async function spawnOpenServer(hanaHome: string) {
  const serverInfoPath = path.join(hanaHome, "server-info.json");
  const child = spawn(process.execPath, ["server/bootstrap.ts"], {
    cwd: root,
    env: {
      ...process.env,
      HANA_HOME: hanaHome,
      HANA_PORT: "0",
      HANA_ROOT: root,
      HANA_SERVER_ENTRY: path.join(root, "server", "main-open.ts"),
      HANA_CREATE_STARTUP_SESSION: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const info = await waitForServerInfo(serverInfoPath, child);
  return { child, info, getStderr: () => stderr };
}

describe("/api/health sessionStore block (real spawned server)", () => {
  it("fresh HANA_HOME → sessionStore reports not degraded", async () => {
    const hanaHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-health-sessionstore-fresh-"));
    let child: ReturnType<typeof spawn> | null = null;
    try {
      const spawned = await spawnOpenServer(hanaHome);
      child = spawned.child;
      const base = `http://127.0.0.1:${spawned.info.port}`;
      const res = await fetch(`${base}/api/health`, {
        headers: { Authorization: `Bearer ${spawned.info.token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessionStore).toEqual({ degraded: false, reasons: [] });
    } finally {
      if (child) {
        child.kill("SIGKILL");
        await waitForExit(child);
      }
      fs.rmSync(hanaHome, TEMP_HOME_RM_OPTIONS);
    }
  }, 60000);

  it("corrupt session-manifest.db present at boot → sessionStore reports degraded with store_quarantined, and detail never leaks the HANA_HOME absolute path", async () => {
    const hanaHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-health-sessionstore-corrupt-"));
    // 复现 session-manifest-engine.test.ts 的"损坏 db → 隔离重建"路径：预置一个
    // 非 sqlite 内容的 session-manifest.db，engine 构造时会隔离它、重新建库，
    // 并把 _sessionManifestStoreRecovery.status 设成 "quarantined"。
    fs.writeFileSync(path.join(hanaHome, "session-manifest.db"), "not sqlite");
    let child: ReturnType<typeof spawn> | null = null;
    try {
      const spawned = await spawnOpenServer(hanaHome);
      child = spawned.child;
      const base = `http://127.0.0.1:${spawned.info.port}`;
      const res = await fetch(`${base}/api/health`, {
        headers: { Authorization: `Bearer ${spawned.info.token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessionStore.degraded).toBe(true);
      expect(body.sessionStore.reasons.some((r: any) => r.kind === "store_quarantined")).toBe(true);
      const serialized = JSON.stringify(body.sessionStore);
      expect(serialized).not.toContain(hanaHome);
    } finally {
      if (child) {
        child.kill("SIGKILL");
        await waitForExit(child);
      }
      fs.rmSync(hanaHome, TEMP_HOME_RM_OPTIONS);
    }
  }, 60000);
});
