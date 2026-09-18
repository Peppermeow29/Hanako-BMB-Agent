import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import path from "path";
import { createFileHistoryRoute } from "../server/routes/file-history.ts";

function makeApp() {
  const root = path.resolve("/tmp/hana-fh-route-ws");
  const service = {
    hasWorkspace: vi.fn((r: string) => path.resolve(r) === root),
    listFiles: vi.fn(() => [{ relPath: "a.md", deletedAt: null, lastCapturedAt: 1000, snapshotCount: 2 }]),
    listVersions: vi.fn(() => [{ id: 7, capturedAt: 1000, origin: "event", opContext: "agent_tool", rawSize: 5 }]),
    getSnapshotContent: vi.fn(() => ({ relPath: "a.md", content: Buffer.from("hello"), capturedAt: 1000, origin: "event" })),
    captureNow: vi.fn(async () => {}),
  };
  const resourceIO = {
    write: vi.fn(async (_ref: unknown, _content: unknown, _context: unknown) => ({})),
  };
  const engine = {
    getFileHistoryService: () => service,
    getResourceIO: () => resourceIO,
    getExplicitHomeCwd: vi.fn((agentId: string) => (agentId === "hana" ? root : null)),
    getHomeCwd: vi.fn(() => null),
  };
  const app = new Hono();
  app.route("/api", createFileHistoryRoute(engine));
  return { app, service, resourceIO, root };
}

describe("file-history route", () => {
  it("lists files for an agent workspace", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/file-history/files?agentId=hana");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files[0].relPath).toBe("a.md");
  });

  it("rejects a missing or unknown agent", async () => {
    const { app } = makeApp();
    expect((await app.request("/api/file-history/files")).status).toBe(400);
    expect((await app.request("/api/file-history/files?agentId=ghost")).status).toBe(404);
  });

  it("lists versions and rejects path escapes", async () => {
    const { app } = makeApp();
    const ok = await app.request("/api/file-history/versions?agentId=hana&relPath=a.md");
    expect(ok.status).toBe(200);
    expect((await ok.json()).versions[0].id).toBe(7);
    const escape = await app.request("/api/file-history/versions?agentId=hana&relPath=../../etc/passwd");
    expect(escape.status).toBe(400);
    const absolute = await app.request(`/api/file-history/versions?agentId=hana&relPath=${encodeURIComponent("/etc/passwd")}`);
    expect(absolute.status).toBe(400);
  });

  it("returns snapshot content as utf-8 text", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/file-history/snapshot?agentId=hana&id=7");
    expect(res.status).toBe(200);
    expect((await res.json()).content).toBe("hello");
  });

  it("restores through ResourceIO and records a restore snapshot", async () => {
    const { app, service, resourceIO, root } = makeApp();
    const res = await app.request("/api/file-history/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "hana", snapshotId: 7 }),
    });
    expect(res.status).toBe(200);
    expect(resourceIO.write).toHaveBeenCalledTimes(1);
    const [ref, content] = resourceIO.write.mock.calls[0];
    expect(ref).toEqual({ kind: "local-file", path: path.join(root, "a.md") });
    expect(Buffer.isBuffer(content) ? content.toString() : content).toBe("hello");
    expect(service.captureNow).toHaveBeenCalledWith(root, "a.md", "restore");
  });
});
