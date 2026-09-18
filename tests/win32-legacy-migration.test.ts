import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectWin32LegacySandboxMigrationTargets,
  runWin32LegacySandboxProfileCleanup,
  runWin32LegacySandboxRootCleanup,
  runWin32LegacySandboxMigration,
  Win32LegacySandboxCleanupQueue,
} from "../lib/sandbox/win32-legacy-migration.ts";

function dirent(name, directory = true) {
  return {
    name,
    isDirectory: () => directory,
  };
}

function fakeSpawnFactory({ code = 0, stdout = "", stderr = "" }: any = {}) {
  return vi.fn((_file, _args, _opts) => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
    return child;
  });
}

function fakeSpawnSequence(results) {
  const queue = [...results];
  return vi.fn((_file, _args, _opts) => {
    const next = queue.shift() || { code: 0, stdout: "", stderr: "" };
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (next.stdout) child.stdout.emit("data", Buffer.from(next.stdout));
      if (next.stderr) child.stderr.emit("data", Buffer.from(next.stderr));
      child.emit("close", next.code ?? 0);
    });
    return child;
  });
}

describe("Windows legacy sandbox migration", () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-win32-migration-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("collects old ACL roots and stale Hana AppContainer profile names", () => {
    const existing = new Set([
      "C:\\",
      "D:\\",
      "C:\\Users\\Hana",
      "C:\\Users\\Hana\\.hanako",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
      "C:\\Users\\Hana\\.hanako\\agents",
      "C:\\Users\\Hana\\.hanako\\session-files",
      "C:\\Users\\Hana\\.hanako\\uploads",
      "C:\\Program Files\\Hanako\\resources",
      "C:\\Program Files\\Hanako\\resources\\git",
      "D:\\workspace",
      "C:\\Users\\Hana\\AppData\\Local\\Packages",
    ]);
    const readdirSync = vi.fn((target) => {
      if (target === "C:\\Users\\Hana\\AppData\\Local\\Packages") {
        return [
          dirent("com.hanako.sandbox.1288.475900"),
          dirent("Microsoft.WindowsCalculator_8wekyb3d8bbwe"),
          dirent("com.hanako.sandbox.5104.475988"),
          dirent("com.hanako.sandbox.file", false),
        ];
      }
      return [];
    });

    const targets = collectWin32LegacySandboxMigrationTargets({
      platform: "win32",
      hanakoHome: "C:\\Users\\Hana\\.hanako",
      workspaceRoots: ["D:\\workspace"],
      env: {
        USERPROFILE: "C:\\Users\\Hana",
        LOCALAPPDATA: "C:\\Users\\Hana\\AppData\\Local",
        SystemDrive: "C:",
        HOMEDRIVE: "D:",
      },
      resourcesPath: "C:\\Program Files\\Hanako\\resources",
      existsSync: (target) => existing.has(target),
      readdirSync,
      homedir: () => "C:\\Users\\Hana",
    });

    expect(targets.aclPaths).toEqual([
      "C:\\Users\\Hana\\.hanako",
      "C:\\Users\\Hana\\.hanako\\.ephemeral",
      "C:\\Users\\Hana\\.hanako\\agents",
      "C:\\Users\\Hana\\.hanako\\session-files",
      "C:\\Users\\Hana\\.hanako\\uploads",
      "D:\\workspace",
      "C:\\Program Files\\Hanako\\resources",
      "C:\\Program Files\\Hanako\\resources\\git",
      "C:\\Users\\Hana",
    ]);
    expect(targets.profileNames).toEqual([
      "com.hanako.sandbox.1288.475900",
      "com.hanako.sandbox.5104.475988",
    ]);
  });

  it("runs cleanup through the helper and treats ACL findings as a diagnostic result", async () => {
    const markerPath = path.join(makeTempDir(), "marker.json");
    const spawn = fakeSpawnSequence([
      {
        code: 3,
        stderr: "hana-win-sandbox: legacy-appcontainer-acl path=\"C:\\\\\" sid=\"S-1-15-2-1\"",
      },
      { code: 0 },
    ]);

    const result = await runWin32LegacySandboxMigration({
      platform: "win32",
      cleanup: true,
      helperPath: "C:\\Hanako\\hana-win-sandbox.exe",
      markerPath,
      targets: {
        aclPaths: ["C:\\"],
        profileNames: ["com.hanako.sandbox.1288.475900"],
      },
      spawn,
    });

    expect(result.status).toBe("findings");
    expect(result.cleanup).toBe(true);
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      "C:\\Hanako\\hana-win-sandbox.exe",
      [
        "--cleanup-hana-write-acl",
        "C:\\",
        "--legacy-appcontainer-profile",
        "com.hanako.sandbox.1288.475900",
        "--cleanup-legacy-acl",
        "--diagnose-legacy-acl",
        "C:\\",
      ],
      expect.objectContaining({ windowsHide: true })
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "C:\\Hanako\\hana-win-sandbox.exe",
      [
        "--cleanup-legacy-profile",
        "com.hanako.sandbox.1288.475900",
      ],
      expect.objectContaining({ windowsHide: true })
    );
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it("does not delete legacy profiles when ACL cleanup fails", async () => {
    const spawn = fakeSpawnFactory({
      code: 1,
      stderr: "hana-win-sandbox: cannot clean legacy ACL",
    });

    const result = await runWin32LegacySandboxMigration({
      platform: "win32",
      cleanup: true,
      helperPath: "C:\\Hanako\\hana-win-sandbox.exe",
      markerPath: path.join(makeTempDir(), "marker.json"),
      targets: {
        aclPaths: ["C:\\work"],
        profileNames: ["com.hanako.sandbox.1288.475900"],
      },
      spawn,
    });

    expect(result.status).toBe("failed");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).not.toContain("--cleanup-legacy-profile");
  });

  it("skips once the cleanup marker has been written", async () => {
    const markerPath = path.join(makeTempDir(), "marker.json");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ version: 3, status: "completed", completedAt: "2026-05-22T00:00:00.000Z" }));
    const spawn = vi.fn();

    const result = await runWin32LegacySandboxMigration({
      platform: "win32",
      cleanup: true,
      helperPath: "C:\\Hanako\\hana-win-sandbox.exe",
      markerPath,
      targets: {
        aclPaths: ["C:\\work"],
        profileNames: ["com.hanako.sandbox.1288.475900"],
      },
      spawn,
    });

    expect(result).toMatchObject({ status: "skipped", reason: "already-completed" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reruns cleanup for v2 markers so legacy capability SID ACLs are migrated", async () => {
    const markerPath = path.join(makeTempDir(), "marker.json");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ version: 2, status: "completed", completedAt: "2026-05-21T00:00:00.000Z" }));
    const spawn = fakeSpawnFactory({ code: 0 });

    const result = await runWin32LegacySandboxMigration({
      platform: "win32",
      cleanup: true,
      helperPath: "C:\\Hanako\\hana-win-sandbox.exe",
      markerPath,
      targets: {
        aclPaths: ["C:\\work"],
        profileNames: [],
      },
      spawn,
    });

    expect(result.status).toBe("clean");
    expect(spawn).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(markerPath, "utf8"))).toMatchObject({
      version: 3,
      status: "completed",
    });
  });

  it("maps helper exit codes and startup failures to stable statuses", async () => {
    const base = {
      platform: "win32",
      cleanup: true,
      helperPath: "C:\\Hanako\\hana-win-sandbox.exe",
      targets: { aclPaths: ["C:\\work"], profileNames: [] },
    };

    await expect(runWin32LegacySandboxMigration({
      ...base,
      markerPath: path.join(makeTempDir(), "clean.json"),
      spawn: fakeSpawnFactory({ code: 0 }),
    })).resolves.toMatchObject({ status: "clean", exitCode: 0 });

    await expect(runWin32LegacySandboxMigration({
      ...base,
      markerPath: path.join(makeTempDir(), "failed.json"),
      spawn: fakeSpawnFactory({ code: 1, stderr: "failed" }),
    })).resolves.toMatchObject({ status: "failed", exitCode: 1 });

    await expect(runWin32LegacySandboxMigration({
      ...base,
      markerPath: path.join(makeTempDir(), "empty.json"),
      targets: { aclPaths: [], profileNames: [] },
      spawn: vi.fn(),
    })).resolves.toMatchObject({ status: "clean", exitCode: 0 });
  });

  it("reports timed out and spawn-error helpers as failed", async () => {
    const timeoutSpawn = vi.fn((_file, _args, _opts) => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      return child;
    });

    await expect(runWin32LegacySandboxMigration({
      platform: "win32",
      cleanup: true,
      helperPath: "C:\\Hanako\\hana-win-sandbox.exe",
      markerPath: path.join(makeTempDir(), "timeout.json"),
      timeoutMs: 1,
      targets: { aclPaths: ["C:\\work"], profileNames: [] },
      spawn: timeoutSpawn,
    })).resolves.toMatchObject({ status: "failed", timedOut: true, error: "timeout" });

    await expect(runWin32LegacySandboxMigration({
      platform: "win32",
      cleanup: true,
      helperPath: "C:\\Hanako\\hana-win-sandbox.exe",
      markerPath: path.join(makeTempDir(), "spawn-error.json"),
      targets: { aclPaths: ["C:\\work"], profileNames: [] },
      spawn: vi.fn(() => { throw new Error("spawn boom"); }),
    })).resolves.toMatchObject({ status: "failed", error: "spawn boom" });
  });

  it("skips cleanly on non-Windows and when the packaged helper is absent", async () => {
    await expect(runWin32LegacySandboxMigration({ platform: "darwin" }))
      .resolves.toMatchObject({ status: "skipped", reason: "platform" });

    await expect(runWin32LegacySandboxMigration({
      platform: "win32",
      resolveHelper: () => null,
    })).resolves.toMatchObject({ status: "skipped", reason: "helper-unavailable" });
  });

  it("cleans a used sandbox root without deleting legacy profiles", async () => {
    const markerPath = path.join(makeTempDir(), "cleanup-v4.json");
    const spawn = fakeSpawnFactory({
      code: 3,
      stderr: "hana-win-sandbox: hana-write-acl-cleaned path=\"C:\\\\work\"",
    });

    const result = await runWin32LegacySandboxRootCleanup({
      platform: "win32",
      roots: ["C:\\work"],
      profileNames: ["com.hanako.sandbox.1288.475900"],
      cleanup: true,
      helperPath: "C:\\Hanako\\hana-win-sandbox.exe",
      markerPath,
      spawn,
      now: () => new Date("2026-05-25T06:00:00.000Z"),
    });

    expect(result.status).toBe("findings");
    expect(result.rootResults).toHaveLength(1);
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(
      "C:\\Hanako\\hana-win-sandbox.exe",
      [
        "--cleanup-hana-write-acl",
        "C:\\work",
        "--legacy-appcontainer-profile",
        "com.hanako.sandbox.1288.475900",
        "--cleanup-legacy-acl",
        "--diagnose-legacy-acl",
        "C:\\work",
      ],
      expect.objectContaining({ windowsHide: true })
    );
    expect(spawn.mock.calls[0][1]).not.toContain("--cleanup-legacy-profile");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    expect(Object.values(marker.roots)[0]).toMatchObject({
      pathHash: expect.any(String),
      status: "completed",
      completedAt: "2026-05-25T06:00:00.000Z",
    });
    expect(JSON.stringify(marker)).not.toContain("C:\\work");
  });

  it("skips sandbox roots that already have a v4 cleanup marker", async () => {
    const markerPath = path.join(makeTempDir(), "cleanup-v4.json");
    await runWin32LegacySandboxRootCleanup({
      platform: "win32",
      roots: ["C:\\work"],
      helperPath: "C:\\Hanako\\hana-win-sandbox.exe",
      markerPath,
      spawn: fakeSpawnFactory({ code: 0 }),
      now: () => new Date("2026-05-25T06:00:00.000Z"),
    });
    const spawn = vi.fn();

    const result = await runWin32LegacySandboxRootCleanup({
      platform: "win32",
      roots: ["C:\\work"],
      helperPath: "C:\\Hanako\\hana-win-sandbox.exe",
      markerPath,
      spawn,
    });

    expect(result.status).toBe("skipped");
    expect(result.rootResults).toEqual([
      expect.objectContaining({ status: "skipped", reason: "already-completed" }),
    ]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not mark legacy profiles completed when the helper is unavailable", async () => {
    const markerPath = path.join(makeTempDir(), "cleanup-v4.json");

    const result = await runWin32LegacySandboxProfileCleanup({
      platform: "win32",
      profileNames: ["com.hanako.sandbox.1288.475900"],
      markerPath,
      resolveHelper: () => null,
    });

    expect(result).toMatchObject({ status: "skipped", reason: "helper-unavailable" });
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("defers queued cleanup while a sandbox root lease is active", async () => {
    const markerPath = path.join(makeTempDir(), "cleanup-v4.json");
    const spawn = fakeSpawnFactory({ code: 0 });
    const queue = new Win32LegacySandboxCleanupQueue({
      platform: "win32",
      helperPath: "C:\\Hanako\\hana-win-sandbox.exe",
      markerPath,
      spawn,
      schedule: false,
    });

    const lease = queue.beginRootUse(["C:\\work"]);
    queue.enqueueRoots(["C:\\work"]);
    await queue.drain();
    expect(spawn).not.toHaveBeenCalled();

    queue.endRootUse(lease);
    await queue.drain();

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining([
      "--cleanup-hana-write-acl",
      "C:\\work",
      "--diagnose-legacy-acl",
      "C:\\work",
    ]));
  });
});
