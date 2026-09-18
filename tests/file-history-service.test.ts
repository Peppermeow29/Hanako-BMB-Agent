import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FileHistoryService, workspaceHashForRoot } from "../lib/file-history/file-history-service.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type FakeWatcher = {
  ready: Promise<void>;
  close: () => Promise<void>;
  emitChanged: (rel: string) => void;
  emitDeleted: (rel: string) => void;
};

function makeFixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hana-fh-ws-"));
  const historyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-fh-root-"));
  cleanups.push(() => fs.rmSync(workspace, { recursive: true, force: true }));
  cleanups.push(() => fs.rmSync(historyRoot, { recursive: true, force: true }));

  const fakeWatchers = new Map<string, FakeWatcher>();
  const createWatcher = ({ root, onChanged, onDeleted }: any): FakeWatcher => {
    const watcher: FakeWatcher = {
      ready: Promise.resolve(),
      close: async () => {},
      emitChanged: onChanged,
      emitDeleted: onDeleted,
    };
    fakeWatchers.set(path.resolve(root), watcher);
    return watcher;
  };

  const service = new FileHistoryService({
    historyRoot,
    createWatcher: createWatcher as any,
    debounceMs: 0,
    mergeWindowMs: 0,
  });
  cleanups.push(() => service.close());
  return { workspace, historyRoot, service, fakeWatchers };
}

describe("FileHistoryService", () => {
  it("sweeps existing text files into the store on workspace sync", async () => {
    const { workspace, service } = makeFixture();
    fs.mkdirSync(path.join(workspace, "notes"));
    fs.writeFileSync(path.join(workspace, "notes", "a.md"), "hello");
    fs.writeFileSync(path.join(workspace, "photo.png"), "binary-ish");
    fs.mkdirSync(path.join(workspace, "node_modules"));
    fs.writeFileSync(path.join(workspace, "node_modules", "x.js"), "noise");

    await service.syncWorkspaces([workspace]);
    await service.waitForIdle();

    const files = service.listFiles(workspace);
    expect(files.map(f => f.relPath)).toEqual(["notes/a.md"]);
    const versions = service.listVersions(workspace, "notes/a.md");
    expect(versions).toHaveLength(1);
    expect(versions[0].origin).toBe("sweep");
  });

  it("captures watcher-reported changes and deletions", async () => {
    const { workspace, service, fakeWatchers } = makeFixture();
    await service.syncWorkspaces([workspace]);
    await service.waitForIdle();

    fs.writeFileSync(path.join(workspace, "b.md"), "v1");
    const watcher = fakeWatchers.get(path.resolve(workspace))!;
    watcher.emitChanged("b.md");
    await service.waitForIdle();
    expect(service.listVersions(workspace, "b.md")).toHaveLength(1);
    expect(service.listVersions(workspace, "b.md")[0].origin).toBe("watcher");

    watcher.emitDeleted("b.md");
    await service.waitForIdle();
    const entry = service.listFiles(workspace).find(f => f.relPath === "b.md");
    expect(entry?.deletedAt).not.toBeNull();
  });

  it("captures resource events routed to the owning workspace", async () => {
    const { workspace, service } = makeFixture();
    await service.syncWorkspaces([workspace]);
    await service.waitForIdle();

    fs.writeFileSync(path.join(workspace, "c.md"), "from-event");
    service.handleResourceEvent({
      type: "resource.changed",
      changeType: "modified",
      resourceKey: "k",
      resource: { kind: "local-file", path: path.join(workspace, "c.md"), filePath: path.join(workspace, "c.md") },
      source: "agent_tool",
      sequence: 1,
      occurredAt: new Date().toISOString(),
    } as any);
    await service.waitForIdle();

    const versions = service.listVersions(workspace, "c.md");
    expect(versions).toHaveLength(1);
    expect(versions[0].origin).toBe("event");
    expect(versions[0].opContext).toBe("agent_tool");
  });

  it("ignores events for paths outside every workspace", async () => {
    const { workspace, service } = makeFixture();
    await service.syncWorkspaces([workspace]);
    await service.waitForIdle();
    service.handleResourceEvent({
      type: "resource.changed",
      changeType: "modified",
      resourceKey: "k",
      resource: { kind: "local-file", path: "/tmp/outside.md", filePath: "/tmp/outside.md" },
      source: "api",
      sequence: 2,
      occurredAt: new Date().toISOString(),
    } as any);
    await service.waitForIdle();
    expect(service.listFiles(workspace)).toHaveLength(0);
  });

  it("follows rename events", async () => {
    const { workspace, service } = makeFixture();
    fs.writeFileSync(path.join(workspace, "old.md"), "v1");
    await service.syncWorkspaces([workspace]);
    await service.waitForIdle();

    service.handleResourceEvent({
      type: "resource.renamed",
      oldResourceKey: "k1",
      newResourceKey: "k2",
      oldResource: { kind: "local-file", path: path.join(workspace, "old.md"), filePath: path.join(workspace, "old.md") },
      newResource: { kind: "local-file", path: path.join(workspace, "new.md"), filePath: path.join(workspace, "new.md") },
      source: "api",
      sequence: 3,
      occurredAt: new Date().toISOString(),
    } as any);
    await service.waitForIdle();
    expect(service.listVersions(workspace, "new.md")).toHaveLength(1);
    expect(service.listVersions(workspace, "old.md")).toHaveLength(0);
  });

  it("captureNow records a restore-origin snapshot", async () => {
    const { workspace, service } = makeFixture();
    await service.syncWorkspaces([workspace]);
    await service.waitForIdle();
    fs.writeFileSync(path.join(workspace, "d.md"), "restored");
    await service.captureNow(workspace, "d.md", "restore");
    expect(service.listVersions(workspace, "d.md")[0].origin).toBe("restore");
  });

  it("stops watching removed workspaces on re-sync", async () => {
    const { workspace, service, fakeWatchers } = makeFixture();
    await service.syncWorkspaces([workspace]);
    expect(fakeWatchers.has(path.resolve(workspace))).toBe(true);
    await service.syncWorkspaces([]);
    expect(() => service.listFiles(workspace)).toThrow();
  });

  it("workspaceHashForRoot is stable and path-separator-insensitive", () => {
    const a = workspaceHashForRoot("/Users/x/space");
    expect(a).toBe(workspaceHashForRoot("/Users/x/space"));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
