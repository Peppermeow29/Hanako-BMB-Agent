import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { collectBridgeMediaAllowedRoots, isInsideBridgeMediaRoot } from "../lib/bridge/media-roots.ts";
// 期望值必须与生产代码同一条规范化路径（native realpath 会展开 Windows 8.3
// 短名，JS 版 fs.realpathSync 不会；CI runner 的 TEMP 恰好是短名形式）。
import { canonicalFilesystemPathSync } from "../shared/link-aware-fs.ts";

const FILESYSTEM_IGNORES_CASE = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-roots-case-probe-"));
  try {
    fs.writeFileSync(path.join(probeDir, "probe.txt"), "probe");
    return fs.existsSync(path.join(probeDir, "PROBE.TXT"));
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

describe("Bridge media allowed roots", () => {
  let tmpDir = null;
  let extraTmpDirs = [];

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const dir of extraTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    tmpDir = null;
    extraTmpDirs = [];
  });

  function makeDir(name) {
    if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-roots-"));
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("includes the target agent workspace from getHomeCwd instead of deskManager.homePath", () => {
    const hanakoHome = makeDir("hana-home");
    const ownerHome = makeDir("owner-workspace");
    const otherHome = makeDir("other-workspace");
    const engine = {
      hanakoHome,
      getHomeCwd: vi.fn((agentId) => {
        if (agentId === "owner") return ownerHome;
        if (agentId === "other") return otherHome;
        return null;
      }),
      getAgents: vi.fn(() => new Map([
        ["owner", { id: "owner", deskManager: {} }],
        ["other", { id: "other", deskManager: {} }],
      ])),
    };

    const roots = collectBridgeMediaAllowedRoots(engine, { agentId: "owner" });

    expect(roots).toContain(canonicalFilesystemPathSync(hanakoHome));
    expect(roots).toContain(canonicalFilesystemPathSync(ownerHome));
    expect(roots).toContain(canonicalFilesystemPathSync(otherHome));
    expect(engine.getHomeCwd).toHaveBeenCalledWith("owner");
    expect(engine.getHomeCwd).toHaveBeenCalledWith("other");
  });

  it.skipIf(!FILESYSTEM_IGNORES_CASE)(
    "treats a differently spelled root as the same root where the filesystem ignores case",
    () => {
      const mediaDir = makeDir("Media/Sub");
      const filePath = path.join(mediaDir, "shot.png");
      fs.writeFileSync(filePath, "png");
      const rootVariant = path.join(tmpDir, "MEDIA");

      expect(isInsideBridgeMediaRoot(filePath, [rootVariant])).toBe(true);
    },
  );

  it("includes the real POSIX /tmp root when it exists", () => {
    if (process.platform === "win32" || !fs.existsSync("/tmp")) return;

    const hanakoHome = makeDir("hana-home");
    const posixTmpDir = fs.mkdtempSync(path.join("/tmp", "hana-bridge-roots-posix-"));
    extraTmpDirs.push(posixTmpDir);
    const filePath = path.join(posixTmpDir, "out.txt");
    fs.writeFileSync(filePath, "ok");

    const roots = collectBridgeMediaAllowedRoots({ hanakoHome });
    const realTmp = canonicalFilesystemPathSync("/tmp");

    expect(roots).toContain(realTmp);
    expect(isInsideBridgeMediaRoot(filePath, roots)).toBe(true);
  });
});
