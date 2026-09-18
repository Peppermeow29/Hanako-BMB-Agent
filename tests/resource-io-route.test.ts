import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createResourceIoRoute } from "../server/routes/resource-io.ts";

describe("resource-io route", () => {
  it("returns retained resource events for catch-up by cursor", async () => {
    const resourceEventsSince = vi.fn(() => ({
      stale: false,
      latestSequence: 7,
      events: [{
        type: "resource.changed",
        changeType: "modified",
        resourceKey: "local_fs:/tmp/a.md",
        resource: { kind: "local-file", path: "/tmp/a.md" },
        source: "provider_watch",
        sequence: 7,
        occurredAt: "2026-06-22T00:00:00.000Z",
      }],
    }));
    const app = new Hono();
    app.route("/api", createResourceIoRoute({ resourceEventsSince }));

    const res = await app.request("/api/resource-io/events?since=3");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      stale: false,
      latestSequence: 7,
      events: [{
        type: "resource.changed",
        changeType: "modified",
        resourceKey: "local_fs:/tmp/a.md",
        resource: { kind: "local-file", path: "/tmp/a.md" },
        source: "provider_watch",
        sequence: 7,
        occurredAt: "2026-06-22T00:00:00.000Z",
      }],
    });
    expect(resourceEventsSince).toHaveBeenCalledWith(3);
  });

  it("returns a resync hint when the event cursor is stale", async () => {
    const app = new Hono();
    app.route("/api", createResourceIoRoute({
      resourceEventsSince: vi.fn(() => ({
        stale: true,
        latestSequence: 12,
        events: [],
      })),
    }));

    const res = await app.request("/api/resource-io/events?since=1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      stale: true,
      latestSequence: 12,
      events: [],
      resync: "resource-stat-required",
    });
  });

  it("subscribes and unsubscribes backend resource watches", async () => {
    const subscribeResourceWatch = vi.fn(() => ({
      subscriptionId: "sub-1",
      resourceKeys: ["local_fs:/tmp/a.md"],
    }));
    const unsubscribeResourceWatch = vi.fn(() => true);
    const app = new Hono();
    app.route("/api", createResourceIoRoute({
      subscribeResourceWatch,
      unsubscribeResourceWatch,
    }));

    const subRes = await app.request("/api/resource-io/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        purpose: "preview",
        sessionPath: "/sessions/a.jsonl",
        resources: [{ kind: "local-file", path: "/tmp/a.md" }],
      }),
    });

    expect(await subRes.json()).toEqual({
      ok: true,
      subscriptionId: "sub-1",
      resourceKeys: ["local_fs:/tmp/a.md"],
    });
    expect(subscribeResourceWatch).toHaveBeenCalledWith({
      purpose: "preview",
      sessionPath: "/sessions/a.jsonl",
      resources: [{ kind: "local-file", path: "/tmp/a.md" }],
    });

    const releaseRes = await app.request("/api/resource-io/subscriptions/sub-1", {
      method: "DELETE",
    });
    expect(await releaseRes.json()).toEqual({ ok: true, released: true });
    expect(unsubscribeResourceWatch).toHaveBeenCalledWith("sub-1");
  });

  it("retains and releases backend resource watches", async () => {
    const release = vi.fn();
    const retainResourceWatch = vi.fn(() => release);
    const app = new Hono();
    app.route("/api", createResourceIoRoute({
      retainResourceWatch,
    }));

    const watchRes = await app.request("/api/resource-io/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "/tmp/a.md" } }),
    });
    const watchData = await watchRes.json();

    expect(watchRes.status).toBe(200);
    expect(retainResourceWatch).toHaveBeenCalledWith({ kind: "local-file", path: "/tmp/a.md" });
    expect(typeof watchData.watchId).toBe("string");

    const releaseRes = await app.request(`/api/resource-io/watch/${watchData.watchId}`, {
      method: "DELETE",
    });
    const releaseData = await releaseRes.json();

    expect(releaseRes.status).toBe(200);
    expect(releaseData).toEqual({ ok: true, released: true });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("routes stat, read, list, and search through engine ResourceIO", async () => {
    const resourceIO = {
      stat: vi.fn(async () => ({ exists: true, resourceKey: "local_fs:/tmp/a.md" })),
      read: vi.fn(async () => ({ content: Buffer.from("hello"), version: { size: 5 } })),
      list: vi.fn(async () => ({ items: [{ name: "a.md", isDirectory: false }] })),
      search: vi.fn(async () => ({ matches: [{ filePath: "/tmp/a.md", line: 1, text: "hello" }] })),
    };
    const app = new Hono();
    app.route("/api", createResourceIoRoute({ resourceIO }));

    const statRes = await app.request("/api/resource-io/stat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "/tmp/a.md" } }),
    });
    expect(await statRes.json()).toEqual({ exists: true, resourceKey: "local_fs:/tmp/a.md" });
    expect(resourceIO.stat).toHaveBeenCalledWith({ kind: "local-file", path: "/tmp/a.md" });

    const readRes = await app.request("/api/resource-io/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "/tmp/a.md" } }),
    });
    expect(await readRes.json()).toEqual({ content: "hello", encoding: "utf-8", version: { size: 5 } });

    await app.request("/api/resource-io/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "/tmp" } }),
    });
    expect(resourceIO.list).toHaveBeenCalledWith({ kind: "local-file", path: "/tmp" });

    await app.request("/api/resource-io/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "/tmp" }, query: "hello" }),
    });
    expect(resourceIO.search).toHaveBeenCalledWith({ kind: "local-file", path: "/tmp" }, { query: "hello" });
  });

  it("returns binary resource reads as base64 when requested", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0xfd]);
    const resourceIO = {
      read: vi.fn(async () => ({
        content: binary,
        version: { size: binary.byteLength },
        resourceKey: "local_fs:/tmp/pixel.bin",
      })),
    };
    const app = new Hono();
    app.route("/api", createResourceIoRoute({ resourceIO }));

    const readRes = await app.request("/api/resource-io/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: { kind: "local-file", path: "/tmp/pixel.bin" },
        encoding: "base64",
      }),
    });

    expect(readRes.status).toBe(200);
    expect(await readRes.json()).toEqual({
      content: binary.toString("base64"),
      encoding: "base64",
      version: { size: binary.byteLength },
      resourceKey: "local_fs:/tmp/pixel.bin",
    });
  });

  it("rejects invalid UTF-8 reads instead of returning replacement-corrupted content", async () => {
    const resourceIO = {
      read: vi.fn(async () => ({ content: Buffer.from([0xff, 0xfe, 0xfd]) })),
    };
    const app = new Hono();
    app.route("/api", createResourceIoRoute({ resourceIO }));

    const readRes = await app.request("/api/resource-io/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: { kind: "local-file", path: "/tmp/pixel.bin" } }),
    });

    expect(readRes.status).toBe(400);
    expect(await readRes.json()).toEqual({
      error: "Resource content is not valid UTF-8; request encoding \"base64\" for binary content",
      code: "invalid_resource_encoding",
      safeMessage: "Resource content is not valid UTF-8; request encoding \"base64\" for binary content",
    });
  });

  it("decodes base64 writes into Buffer before calling ResourceIO", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0xfd]);
    const write = vi.fn(async (_resource: unknown, _content: unknown, _context?: unknown) => ({
      changeType: "modified",
      resourceKey: "a",
    }));
    const writeExpectedVersion = vi.fn(async (
      _resource: unknown,
      _content: unknown,
      _expectedVersion: unknown,
      _context?: unknown,
    ) => ({ ok: false, conflict: true, version: { size: 5 } }));
    const resourceIO = {
      write,
      writeExpectedVersion,
    };
    const app = new Hono();
    app.route("/api", createResourceIoRoute({ resourceIO }));

    await app.request("/api/resource-io/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: { kind: "local-file", path: "/tmp/pixel.bin" },
        content: binary.toString("base64"),
        encoding: "base64",
      }),
    });

    const writeContent = resourceIO.write.mock.calls[0][1];
    expect(Buffer.isBuffer(writeContent)).toBe(true);
    if (!Buffer.isBuffer(writeContent)) throw new Error("expected Buffer write content");
    expect(writeContent.equals(binary)).toBe(true);

    const writeRes = await app.request("/api/resource-io/write-expected-version", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: { kind: "local-file", path: "/tmp/pixel.bin" },
        content: binary.toString("base64"),
        encoding: "base64",
        expectedVersion: { mtimeMs: 1, size: 5 },
      }),
    });

    expect(writeRes.status).toBe(409);
    const expectedVersionContent = resourceIO.writeExpectedVersion.mock.calls[0][1];
    expect(Buffer.isBuffer(expectedVersionContent)).toBe(true);
    if (!Buffer.isBuffer(expectedVersionContent)) throw new Error("expected Buffer writeExpectedVersion content");
    expect(expectedVersionContent.equals(binary)).toBe(true);
  });

  it("rejects malformed base64 writes without calling ResourceIO", async () => {
    const resourceIO = {
      write: vi.fn(async () => ({ changeType: "modified", resourceKey: "a" })),
    };
    const app = new Hono();
    app.route("/api", createResourceIoRoute({ resourceIO }));

    const res = await app.request("/api/resource-io/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: { kind: "local-file", path: "/tmp/pixel.bin" },
        content: "%%%not-base64%%%",
        encoding: "base64",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Resource content is not valid base64",
      code: "invalid_resource_encoding",
      safeMessage: "Resource content is not valid base64",
    });
    expect(resourceIO.write).not.toHaveBeenCalled();
  });

  it("routes route-grade mutations through engine ResourceIO with API principal context", async () => {
    const resourceIO = {
      write: vi.fn(async () => ({ changeType: "modified", resourceKey: "a" })),
      writeExpectedVersion: vi.fn(async () => ({ ok: false, conflict: true, version: { size: 5 } })),
      rename: vi.fn(async () => ({ oldResourceKey: "a", newResourceKey: "b" })),
      move: vi.fn(async () => ({ oldResourceKey: "b", newResourceKey: "c" })),
      trash: vi.fn(async () => ({ resourceKey: "c", trashId: "trash_1" })),
    };
    const app = new Hono();
    app.route("/api", createResourceIoRoute({ resourceIO }));

    await app.request("/api/resource-io/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: { kind: "local-file", path: "/tmp/a.md" },
        content: "next",
        reason: "route_write",
        sessionId: "sess_1",
        sessionPath: "/sessions/a.jsonl",
        requestId: "req_1",
        connectionKind: "workbench",
        credentialKind: "session",
      }),
    });
    expect(resourceIO.write).toHaveBeenCalledWith(
      { kind: "local-file", path: "/tmp/a.md" },
      "next",
      expect.objectContaining({
        source: "api",
        reason: "route_write",
        sessionId: "sess_1",
        sessionPath: "/sessions/a.jsonl",
        requestId: "req_1",
        principal: expect.objectContaining({
          kind: "api",
          sessionId: "sess_1",
          sessionPath: "/sessions/a.jsonl",
          requestId: "req_1",
          connectionKind: "workbench",
          credentialKind: "session",
        }),
      }),
    );

    const writeRes = await app.request("/api/resource-io/write-expected-version", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: { kind: "local-file", path: "/tmp/a.md" },
        content: "next",
        expectedVersion: { mtimeMs: 1, size: 5 },
        reason: "route_test",
        sessionId: "sess_1",
        sessionPath: "/sessions/a.jsonl",
        requestId: "req_2",
      }),
    });
    expect(writeRes.status).toBe(409);
    expect(await writeRes.json()).toEqual({
      ok: false,
      conflict: true,
      version: { size: 5 },
      safeMessage: "Resource write conflict",
    });
    expect(resourceIO.writeExpectedVersion).toHaveBeenCalledWith(
      { kind: "local-file", path: "/tmp/a.md" },
      "next",
      { mtimeMs: 1, size: 5 },
      expect.objectContaining({
        source: "api",
        reason: "route_test",
        sessionId: "sess_1",
        sessionPath: "/sessions/a.jsonl",
        requestId: "req_2",
        principal: expect.objectContaining({ kind: "api", sessionId: "sess_1" }),
      }),
    );

    await app.request("/api/resource-io/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: { kind: "local-file", path: "/tmp/a.md" },
        to: { kind: "local-file", path: "/tmp/b.md" },
      }),
    });
    expect(resourceIO.rename).toHaveBeenCalledWith(
      { kind: "local-file", path: "/tmp/a.md" },
      { kind: "local-file", path: "/tmp/b.md" },
      expect.objectContaining({
        source: "api",
        reason: "resource_io_route",
        sessionPath: null,
        principal: expect.objectContaining({ kind: "api" }),
      }),
    );

    await app.request("/api/resource-io/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: { kind: "local-file", path: "/tmp/b.md" },
        to: { kind: "local-file", path: "/tmp/archive/b.md" },
      }),
    });
    expect(resourceIO.move).toHaveBeenCalledWith(
      { kind: "local-file", path: "/tmp/b.md" },
      { kind: "local-file", path: "/tmp/archive/b.md" },
      expect.objectContaining({
        source: "api",
        reason: "resource_io_route",
        sessionPath: null,
        principal: expect.objectContaining({ kind: "api" }),
      }),
    );

    await app.request("/api/resource-io/trash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: { kind: "local-file", path: "/tmp/archive/b.md" },
        trash: { namespace: "workbench" },
      }),
    });
    expect(resourceIO.trash).toHaveBeenCalledWith(
      { kind: "local-file", path: "/tmp/archive/b.md" },
      { namespace: "workbench" },
      expect.objectContaining({
        source: "api",
        reason: "resource_io_route",
        sessionPath: null,
        principal: expect.objectContaining({ kind: "api" }),
      }),
    );
  });

  it("returns sanitized ResourceIO denial errors", async () => {
    const resourceIO = {
      write: vi.fn(async () => {
        const err: any = new Error("Denied /tmp/hana-fixture/private/repo/.git/config");
        err.code = "resource_access_denied";
        err.status = 403;
        err.safeMessage = "Resource access denied by authority policy";
        throw err;
      }),
    };
    const app = new Hono();
    app.route("/api", createResourceIoRoute({ resourceIO }));

    const res = await app.request("/api/resource-io/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: { kind: "local-file", path: "/tmp/hana-fixture/private/repo/.git/config" },
        content: "bad",
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({
      error: "Resource access denied by authority policy",
      code: "resource_access_denied",
      safeMessage: "Resource access denied by authority policy",
    });
    expect(JSON.stringify(body)).not.toContain("/tmp/hana-fixture");
  });
});
