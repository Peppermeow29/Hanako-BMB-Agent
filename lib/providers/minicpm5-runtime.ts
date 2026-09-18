import { spawn as defaultSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MINICPM5_PROVIDER = "minicpm5-local";
const DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";
const DEFAULT_READY_TIMEOUT_MS = 45_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_POLL_INTERVAL_MS = 250;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = [
  path.resolve(moduleDir, "..", ".."),
  path.resolve(moduleDir, ".."),
].find((candidate) => existsSync(path.join(candidate, "scripts", "minicpm5-mlx-server.mjs")))
  || path.resolve(moduleDir, "..", "..");
const defaultScriptPath = path.join(runtimeRoot, "scripts", "minicpm5-mlx-server.mjs");

function isLoopbackHost(hostname: string) {
  const host = String(hostname || "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

function resolveBaseUrl(model: any) {
  const raw = model?.baseUrl || DEFAULT_BASE_URL;
  try {
    return new URL(raw);
  } catch {
    throw new Error(`MiniCPM5 local runtime has an invalid base URL: ${String(raw)}`);
  }
}

function healthUrl(base: URL) {
  const url = new URL(base.toString());
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix || ""}/models`;
  url.search = "";
  url.hash = "";
  return url;
}

function endpointKey(base: URL) {
  return `${base.protocol}//${base.host}${base.pathname.replace(/\/+$/, "")}`;
}

function isSuccessfulResponse(response: any) {
  if (!response) return false;
  if (typeof response.ok === "boolean") return response.ok;
  return Number(response.status) >= 200 && Number(response.status) < 300;
}

function errorText(error: any) {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError() {
  const error = new Error("MiniCPM5 local runtime startup was aborted.");
  error.name = "AbortError";
  return error;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function addProcessListener(child: any, event: string, listener: (...args: any[]) => void) {
  if (typeof child?.once === "function") child.once(event, listener);
  else if (typeof child?.on === "function") child.on(event, listener);
}

export class MiniCPM5RuntimeSupervisor {
  private fetchImpl: typeof fetch;
  private spawnImpl: typeof defaultSpawn;
  private execPath: string;
  private scriptPath: string;
  private env: Record<string, string | undefined>;
  private log: (message: string) => void;
  private readyTimeoutMs: number;
  private probeTimeoutMs: number;
  private pollIntervalMs: number;
  private children = new Map<string, any>();
  private pending = new Map<string, Promise<MiniCPM5RuntimeStatus>>();
  private readyUntil = new Map<string, number>();

  constructor(options: any = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.spawnImpl = options.spawnImpl || defaultSpawn;
    this.execPath = options.execPath || process.execPath;
    this.scriptPath = options.scriptPath || defaultScriptPath;
    this.env = options.env || process.env;
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.readyTimeoutMs = Number.isFinite(options.readyTimeoutMs)
      ? Math.max(1, options.readyTimeoutMs)
      : DEFAULT_READY_TIMEOUT_MS;
    this.probeTimeoutMs = Number.isFinite(options.probeTimeoutMs)
      ? Math.max(1, options.probeTimeoutMs)
      : DEFAULT_PROBE_TIMEOUT_MS;
    this.pollIntervalMs = Number.isFinite(options.pollIntervalMs)
      ? Math.max(1, options.pollIntervalMs)
      : DEFAULT_POLL_INTERVAL_MS;
  }

  async ensure(model: any, { signal }: { signal?: AbortSignal } = {}): Promise<MiniCPM5RuntimeStatus> {
    if (model?.provider !== MINICPM5_PROVIDER) {
      return { ready: true, owned: false, skipped: true, baseUrl: null };
    }
    if (signal?.aborted) throw abortError();
    const base = resolveBaseUrl(model);
    if (!isLoopbackHost(base.hostname)) {
      throw new Error(
        `MiniCPM5 local runtime refuses to auto-start a non-loopback endpoint: ${base.origin}`,
      );
    }

    const key = endpointKey(base);
    const now = Date.now();
    if (this.readyUntil.get(key) > now && await this.probe(base, signal)) {
      return { ready: true, owned: this.children.has(key), skipped: false, baseUrl: base.toString() };
    }
    this.readyUntil.delete(key);

    const existing = await this.probe(base, signal);
    if (existing) {
      this.readyUntil.set(key, Date.now() + this.probeTimeoutMs);
      return { ready: true, owned: this.children.has(key), skipped: false, baseUrl: base.toString() };
    }

    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.startAndWait(base, key);
      this.pending.set(key, pending);
      pending.finally(() => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      }).catch(() => {});
    }
    const status = await this.awaitWithSignal(pending, signal);
    return { ...status, baseUrl: base.toString() };
  }

  async probe(baseUrl: URL | string, signal?: AbortSignal) {
    const base = typeof baseUrl === "string" ? new URL(baseUrl) : baseUrl;
    const timeout = withTimeout(signal, this.probeTimeoutMs);
    try {
      const response = await this.fetchImpl(healthUrl(base), {
        method: "GET",
        signal: timeout.signal,
      } as any);
      return isSuccessfulResponse(response);
    } catch {
      return false;
    } finally {
      timeout.dispose();
    }
  }

  private async startAndWait(base: URL, key: string): Promise<MiniCPM5RuntimeStatus> {
    // Another caller or an external process may have won the race while the
    // first health probe was in flight.
    if (await this.probe(base)) {
      this.readyUntil.set(key, Date.now() + this.probeTimeoutMs);
      return { ready: true, owned: this.children.has(key), skipped: false, baseUrl: base.toString() };
    }

    const port = base.port || (base.protocol === "https:" ? "443" : "80");
    let child: any;
    try {
      child = this.spawnImpl(this.execPath, [this.scriptPath], {
        cwd: runtimeRoot,
        env: {
          ...this.env,
          MINICPM5_PORT: port,
        },
        stdio: ["ignore", "pipe", "pipe"],
      } as any);
    } catch (error) {
      throw this.startError(base, `could not spawn ${this.scriptPath}: ${errorText(error)}`);
    }

    this.children.set(key, child);
    const diagnostics: string[] = [];
    for (const stream of [child?.stdout, child?.stderr]) {
      if (typeof stream?.on === "function") {
        stream.on("data", (chunk: any) => {
          const text = String(chunk || "").trim();
          if (text) diagnostics.push(text.slice(-800));
        });
      }
    }

    let exited: { code: any; signal: any; error?: any } | null = null;
    addProcessListener(child, "exit", () => {
      if (this.children.get(key) === child) {
        this.children.delete(key);
        this.readyUntil.delete(key);
      }
    });
    const exitPromise = new Promise<void>((resolve) => {
      addProcessListener(child, "error", (error) => {
        exited = { code: null, signal: null, error };
        resolve();
      });
      addProcessListener(child, "exit", (code, signal) => {
        exited = { code, signal };
        resolve();
      });
    });

    try {
      const deadline = Date.now() + this.readyTimeoutMs;
      while (Date.now() < deadline) {
        if (await this.probe(base)) {
          this.readyUntil.set(key, Date.now() + this.probeTimeoutMs);
          return { ready: true, owned: true, skipped: false, baseUrl: base.toString() };
        }
        if (exited) {
          const detail = exited.error ? errorText(exited.error) : `exit=${exited.code ?? "null"} signal=${exited.signal ?? "none"}`;
          throw this.startError(base, `${detail}${diagnostics.length ? `; ${diagnostics.join(" | ")}` : ""}`);
        }
        await Promise.race([wait(this.pollIntervalMs), exitPromise]);
      }
      throw this.startError(base, diagnostics.length ? diagnostics.join(" | ") : "startup timed out");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("MiniCPM5 local runtime")) throw error;
      throw this.startError(base, errorText(error));
    } finally {
      if (this.children.get(key) === child) {
        // Keep a successfully started child registered so close() can release
        // the model. Startup failures and exits are removed immediately.
        const keepOwnedChild = this.readyUntil.has(key) && !exited;
        if (!keepOwnedChild && !exited) {
          try { child.kill?.("SIGTERM"); } catch {}
        }
        if (!keepOwnedChild) this.children.delete(key);
      }
    }
  }

  private startError(base: URL, detail: string) {
    return new Error(
      `MiniCPM5 local runtime is unavailable at ${healthUrl(base)}. ${detail}. `
      + "Start it with `npm run minicpm:server` or verify MINICPM5_MODEL_PATH and mlx-lm.",
    );
  }

  private async awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw abortError();
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      }),
    ]);
  }

  async close() {
    const children = [...this.children.values()];
    this.children.clear();
    this.readyUntil.clear();
    for (const child of children) {
      try { child.kill?.("SIGTERM"); } catch {}
    }
    await Promise.all(children.map((child) => new Promise<void>((resolve) => {
      if (!child || typeof child.once !== "function") return resolve();
      const timer = setTimeout(resolve, 2_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    })));
    this.log(`MiniCPM5 local runtime stopped (${children.length} process${children.length === 1 ? "" : "es"}).`);
  }
}

export function createMiniCPM5RuntimeSupervisor(options?: any) {
  return new MiniCPM5RuntimeSupervisor(options);
}

export type MiniCPM5RuntimeStatus = {
  ready: boolean;
  owned: boolean;
  skipped: boolean;
  baseUrl: string | null;
};
