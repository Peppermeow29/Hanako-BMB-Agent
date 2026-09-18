import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createWorkspaceWatcher } from "../lib/file-history/workspace-watcher.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// macOS 的 fsevents 在并行文件系统活动下会静默丢弃事件（已用裸 chokidar 对照记录仪
// 取证：事件在 fsevents 层丢失且不补发，与本封装无关）。因此这里不断言"单次写入必达"，
// 而是断言真实契约"持续变更最终会被上报"：等待期间周期性重做触发动作（poke），
// 丢弃窗口过去后新事件自然到达。poke 间隔要大于 awaitWriteFinish 的 400ms 稳定阈值。
async function waitForWithPoke(
  predicate: () => boolean,
  poke: () => void,
  { timeoutMs = 20_000, pokeEveryMs = 1000 }: { timeoutMs?: number; pokeEveryMs?: number } = {},
): Promise<void> {
  const started = Date.now();
  let lastPoke = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitForWithPoke timeout");
    if (Date.now() - lastPoke >= pokeEveryMs) {
      lastPoke = Date.now();
      poke();
    }
    await new Promise(r => setTimeout(r, 50));
  }
}

describe("workspace watcher", () => {
  it("reports changes with workspace-relative posix paths and skips ignored dirs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-fh-watch-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "sub"));
    fs.mkdirSync(path.join(root, "node_modules"));

    const changed: string[] = [];
    const deleted: string[] = [];
    const watcher = createWorkspaceWatcher({
      root,
      onChanged: (relPath) => changed.push(relPath),
      onDeleted: (relPath) => deleted.push(relPath),
      onError: () => {},
    });
    cleanups.push(() => watcher.close());
    await watcher.ready;

    let revision = 0;
    const writeBoth = () => {
      revision += 1;
      fs.writeFileSync(path.join(root, "sub", "a.md"), `hello-${revision}`);
      fs.writeFileSync(path.join(root, "node_modules", "noise.js"), `ignored-${revision}`);
    };
    writeBoth();
    await waitForWithPoke(() => changed.includes("sub/a.md"), writeBoth);
    expect(changed).not.toContain("node_modules/noise.js");

    const removeTracked = () => {
      // 事件丢弃时重造一对 add+unlink，让 unlink 有新的送达机会
      if (!fs.existsSync(path.join(root, "sub", "a.md"))) {
        fs.writeFileSync(path.join(root, "sub", "a.md"), "respawn");
      }
      fs.rmSync(path.join(root, "sub", "a.md"));
    };
    removeTracked();
    await waitForWithPoke(() => deleted.includes("sub/a.md"), removeTracked);
  }, 45_000);

  it("does not hold a file descriptor per watched file", async () => {
    // 每文件一个 OS 级 watch 会把进程的文件描述符表撑爆，大工作区因此连 spawn 都做不了。
    // /dev/fd 是本进程描述符表的快照，Windows 没有等价物，故只在类 Unix 平台上断言。
    if (process.platform === "win32") return;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-fh-watch-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    for (let dir = 0; dir < 3; dir++) {
      const dirPath = path.join(root, `pack-${dir}`);
      fs.mkdirSync(dirPath);
      for (let i = 0; i < 100; i++) {
        fs.writeFileSync(path.join(dirPath, `note-${i}.md`), `content-${dir}-${i}`);
      }
    }

    const fdBefore = fs.readdirSync("/dev/fd").length;
    const watcher = createWorkspaceWatcher({
      root,
      onChanged: () => {},
      onDeleted: () => {},
      onError: () => {},
    });
    cleanups.push(() => watcher.close());
    await watcher.ready;
    const fdAfter = fs.readdirSync("/dev/fd").length;

    expect(fdAfter - fdBefore).toBeLessThan(30);
  }, 45_000);

  it("does not ignore dot-files while still pruning dot-directories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-fh-watch-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, ".obsidian"));

    const changed: string[] = [];
    const watcher = createWorkspaceWatcher({
      root,
      onChanged: (relPath) => changed.push(relPath),
      onDeleted: () => {},
      onError: () => {},
    });
    cleanups.push(() => watcher.close());
    await watcher.ready;

    let revision = 0;
    const writeBoth = () => {
      revision += 1;
      fs.writeFileSync(path.join(root, ".gitignore"), `node_modules-${revision}\n`);
      fs.writeFileSync(path.join(root, ".obsidian", "app.json"), `{"rev":${revision}}`);
    };
    writeBoth();
    await waitForWithPoke(() => changed.includes(".gitignore"), writeBoth);
    expect(changed).not.toContain(".obsidian/app.json");
  }, 45_000);
});
