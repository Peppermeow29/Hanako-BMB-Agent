import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { MiniCPM5RuntimeSupervisor } from "../lib/providers/minicpm5-runtime.ts";

function model(baseUrl = "http://127.0.0.1:18080/v1") {
  return { provider: "minicpm5-local", id: "default_model", baseUrl };
}

function childProcess() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((signal = "SIGTERM") => {
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  });
  return child;
}

describe("MiniCPM5 runtime supervisor", () => {
  const supervisors: MiniCPM5RuntimeSupervisor[] = [];

  afterEach(async () => {
    await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.close()));
  });

  it("reuses a healthy loopback service without spawning or owning it", async () => {
    const spawn = vi.fn();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const supervisor = new MiniCPM5RuntimeSupervisor({ fetchImpl, spawnImpl: spawn });
    supervisors.push(supervisor);

    await expect(supervisor.ensure(model())).resolves.toMatchObject({
      ready: true,
      owned: false,
      skipped: false,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("starts one runtime for concurrent first requests and reuses it", async () => {
    let ready = false;
    const child = childProcess();
    const fetchImpl = vi.fn(async () => ({ ok: ready, status: ready ? 200 : 503 }));
    const spawn = vi.fn(() => {
      setTimeout(() => { ready = true; }, 5);
      return child;
    });
    const supervisor = new MiniCPM5RuntimeSupervisor({
      fetchImpl,
      spawnImpl: spawn,
      readyTimeoutMs: 200,
      probeTimeoutMs: 20,
      pollIntervalMs: 2,
      execPath: "/usr/bin/node",
      scriptPath: "/tmp/minicpm5-mlx-server.mjs",
    });
    supervisors.push(supervisor);

    const results = await Promise.all([
      supervisor.ensure(model()),
      supervisor.ensure(model()),
      supervisor.ensure(model()),
    ]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.owned && result.ready)).toBe(true);
    const spawnOptions = (spawn.mock.calls[0] as any[])[2] as any;
    expect(spawnOptions.env.MINICPM5_PORT).toBe("18080");
  });

  it("retains ownership after readiness so close releases the started model", async () => {
    let ready = false;
    const child = childProcess();
    const fetchImpl = vi.fn(async () => ({ ok: ready, status: ready ? 200 : 503 }));
    const spawn = vi.fn(() => {
      setTimeout(() => { ready = true; }, 5);
      return child;
    });
    const supervisor = new MiniCPM5RuntimeSupervisor({
      fetchImpl,
      spawnImpl: spawn,
      readyTimeoutMs: 200,
      probeTimeoutMs: 20,
      pollIntervalMs: 2,
      execPath: "/usr/bin/node",
      scriptPath: "/tmp/minicpm5-mlx-server.mjs",
    });
    supervisors.push(supervisor);

    await expect(supervisor.ensure(model())).resolves.toMatchObject({ owned: true, ready: true });
    await supervisor.close();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("reports a startup failure with the endpoint and remediation", async () => {
    const child = childProcess();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        child.stderr.emit("data", "mlx-lm: model checkpoint missing");
        child.emit("exit", 1, null);
      });
      return child;
    });
    const supervisor = new MiniCPM5RuntimeSupervisor({
      fetchImpl,
      spawnImpl: spawn,
      readyTimeoutMs: 100,
      probeTimeoutMs: 10,
      pollIntervalMs: 2,
    });
    supervisors.push(supervisor);

    await expect(supervisor.ensure(model())).rejects.toThrow(
      /MiniCPM5 local runtime is unavailable.*18080.*model checkpoint missing.*npm run minicpm:server/s,
    );
  });

  it("refuses to auto-start a non-loopback endpoint", async () => {
    const spawn = vi.fn();
    const supervisor = new MiniCPM5RuntimeSupervisor({ spawnImpl: spawn });
    supervisors.push(supervisor);

    await expect(supervisor.ensure(model("https://example.test/v1"))).rejects.toThrow(/non-loopback/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
