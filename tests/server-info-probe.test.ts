import http from "http";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROBE_PATH,
  describeForeignServerBlock,
  isForeignServerBlocking,
  probeServerInfo,
} from "../shared/server-info-probe.cjs";

const TOKEN = "test-token-0123456789abcdef";

let server: http.Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

function listen(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("no port"));
    });
  });
}

describe("probeServerInfo", () => {
  it("returns dead when info has no usable port/token (nothing to probe)", async () => {
    expect(await probeServerInfo({ info: null })).toEqual({ status: "dead" });
    expect(await probeServerInfo({ info: { port: 0, token: TOKEN } })).toEqual({ status: "dead" });
    expect(await probeServerInfo({ info: { port: 4000, token: "" } })).toEqual({ status: "dead" });
  });

  it("returns dead when the connection is refused (real closed port, no mock)", async () => {
    // Bind and immediately close to get a port that is very likely free,
    // then probe against it without anything listening.
    const probedPort = await listen((_req, res) => res.end());
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    const result = await probeServerInfo({ info: { port: probedPort, token: TOKEN }, timeoutMs: 500 });
    expect(result).toEqual({ status: "dead" });
  });

  it("returns alive-same-home for a real 200 response shaped like the server-identity route, using the token from server-info.json", async () => {
    let receivedAuth: string | undefined;
    const port = await listen((req, res) => {
      receivedAuth = req.headers.authorization;
      if (req.url === DEFAULT_PROBE_PATH) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ serverId: "server_abc", studioId: "studio_abc", version: "1.2.3" }));
        return;
      }
      res.writeHead(404).end();
    });

    const result = await probeServerInfo({ info: { port, token: TOKEN } });
    expect(result).toEqual({ status: "alive-same-home" });
    expect(receivedAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("returns alive-unauthorized for a real 403 shaped like this codebase's auth-rejection body", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden", reason: "auth_failed" }));
    });

    const result = await probeServerInfo({ info: { port, token: "wrong-token" } });
    expect(result).toEqual({ status: "alive-unauthorized" });
  });

  it("returns not-hana for a 200 response that does not carry a serverId (some other service on that port)", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hello: "world" }));
    });

    const result = await probeServerInfo({ info: { port, token: TOKEN } });
    expect(result.status).toBe("not-hana");
    expect((result as any).detail).toContain("did not match the server-identity shape");
  });

  it("returns not-hana for a 403 response that doesn't carry error/reason (foreign auth scheme)", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Forbidden");
    });

    const result = await probeServerInfo({ info: { port, token: TOKEN } });
    expect(result.status).toBe("not-hana");
    expect((result as any).detail).toContain("did not match the auth-rejection shape");
  });

  it("returns not-hana for an unrecognized HTTP status", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(500).end();
    });

    const result = await probeServerInfo({ info: { port, token: TOKEN } });
    expect(result).toEqual({ status: "not-hana", detail: "unexpected HTTP status 500" });
  });

  it("returns dead when the fetch implementation times out (injected fetchImpl)", async () => {
    // AbortSignal.timeout fires regardless of what fetchImpl does with it as
    // long as fetchImpl actually respects the passed signal; simulate that
    // by rejecting once the signal aborts, matching real fetch behavior.
    const fetchImpl = (_url: string, opts: any): Promise<Response> =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });

    const result = await probeServerInfo({ info: { port: 1234, token: TOKEN }, timeoutMs: 30, fetchImpl });
    expect(result).toEqual({ status: "dead" });
  });

  it("swallows JSON parse failure on the response body and falls through to not-hana", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>not json</html>");
    });

    const result = await probeServerInfo({ info: { port, token: TOKEN } });
    expect(result.status).toBe("not-hana");
  });
});

describe("isForeignServerBlocking", () => {
  it("blocks on alive-same-home and alive-unauthorized", () => {
    expect(isForeignServerBlocking("alive-same-home")).toBe(true);
    expect(isForeignServerBlocking("alive-unauthorized")).toBe(true);
  });

  it("does not block on not-hana or dead — those are self-cleaning cases", () => {
    expect(isForeignServerBlocking("not-hana")).toBe(false);
    expect(isForeignServerBlocking("dead")).toBe(false);
  });
});

describe("describeForeignServerBlock", () => {
  it("includes ownerKind, version, and pid for alive-same-home", () => {
    const message = describeForeignServerBlock({
      status: "alive-same-home",
      info: { ownerKind: "standalone", version: "0.393.0", pid: 4242 },
    });
    expect(message).toContain("standalone");
    expect(message).toContain("0.393.0");
    expect(message).toContain("4242");
    expect(message).toContain("要接管请先退出它");
    expect(message).toContain("Quit it first");
  });

  it("includes ownerKind and pid for alive-unauthorized, and mentions token rotation", () => {
    const message = describeForeignServerBlock({
      status: "alive-unauthorized",
      info: { ownerKind: "desktop", pid: 99 },
    });
    expect(message).toContain("desktop");
    expect(message).toContain("99");
    expect(message).toContain("token 可能已轮换");
    expect(message).toContain("the token may have rotated");
  });

  it("returns null for not-hana and dead — no rejection message needed since those don't block", () => {
    expect(describeForeignServerBlock({ status: "not-hana", info: null })).toBeNull();
    expect(describeForeignServerBlock({ status: "dead", info: null })).toBeNull();
  });

  it("falls back to 'unknown' for missing ownerKind/version/pid", () => {
    const message = describeForeignServerBlock({ status: "alive-same-home", info: null });
    expect(message).toContain("unknown");
  });
});
