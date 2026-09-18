import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  ensureSecretDirModeSync,
  ensureSecretFileModeSync,
  writeSecretFileSync,
} from "../shared/secret-fs.ts";

const POSIX = process.platform !== "win32";

let tmpDir: string | null = null;

function makeTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-secret-fs-"));
  return tmpDir;
}

function modeOf(target: string) {
  return fs.statSync(target).mode & 0o777;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe("writeSecretFileSync", () => {
  it("writes the exact content it was given", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");

    writeSecretFileSync(target, '{"api_key":"value"}\n');

    expect(fs.readFileSync(target, "utf-8")).toBe('{"api_key":"value"}\n');
  });

  it.skipIf(!POSIX)("creates new credential files owner-only", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");

    writeSecretFileSync(target, "{}\n");

    expect(modeOf(target)).toBe(0o600);
  });

  it.skipIf(!POSIX)("tightens an existing world-readable file instead of inheriting its mode", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    fs.writeFileSync(target, "{}\n", { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    expect(modeOf(target)).toBe(0o644);

    writeSecretFileSync(target, '{"rotated":true}\n');

    expect(modeOf(target)).toBe(0o600);
  });

  it("leaves no temporary file behind on success", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");

    writeSecretFileSync(target, "{}\n");

    expect(fs.readdirSync(root)).toEqual(["credential.json"]);
  });

  it.skipIf(!POSIX)("never exposes the secret through a world-readable temporary file", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    const observed: number[] = [];
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from: any, to: any) => {
      observed.push(fs.statSync(from).mode & 0o777);
      return realRename(from, to);
    });

    writeSecretFileSync(target, "{}\n");

    expect(observed).toEqual([0o600]);
  });

  it.skipIf(!POSIX)("clears a leftover temporary file so the new one is owner-only from creation", () => {
    // A crash during an older write can leave a temporary file behind. Creating
    // a file with a mode has no effect when the file already exists, so the
    // secret would land in whatever mode that leftover carried.
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, "stale\n");
    fs.chmodSync(tmp, 0o644);
    let leftoverPresentAtWrite = true;
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((p: any, data: any, opts?: any) => {
      if (String(p) === tmp) leftoverPresentAtWrite = fs.existsSync(tmp);
      return realWrite(p, data, opts);
    });

    writeSecretFileSync(target, "{}\n");

    expect(leftoverPresentAtWrite).toBe(false);
    expect(modeOf(target)).toBe(0o600);
  });

  it.skipIf(!POSIX)("still saves the file when the filesystem refuses the mode change", () => {
    // Removable media and some network mounts reject chmod outright. Saving the
    // user's data must not depend on protection that filesystem cannot provide.
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      const err: any = new Error("EPERM: operation not permitted");
      err.code = "EPERM";
      throw err;
    });

    expect(() => writeSecretFileSync(target, '{"kept":true}\n')).not.toThrow();
    expect(fs.readFileSync(target, "utf-8")).toBe('{"kept":true}\n');
    expect(fs.readdirSync(root)).toEqual(["credential.json"]);
  });

  it.skipIf(!POSIX)("still saves the file when the filesystem accepts the mode but ignores it", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation((p: any, opts?: any) => {
      const stat = realStat(p, opts);
      return { ...stat, mode: (stat.mode & ~0o777) | 0o644 } as any;
    });

    expect(() => writeSecretFileSync(target, '{"kept":true}\n')).not.toThrow();
    expect(fs.readFileSync(target, "utf-8")).toBe('{"kept":true}\n');
  });

  it("propagates a genuine write failure instead of reporting success", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      const err: any = new Error("ENOSPC: no space left on device");
      err.code = "ENOSPC";
      throw err;
    });

    expect(() => writeSecretFileSync(target, "{}\n")).toThrowError(/ENOSPC/);
  });

  it("does not destroy the previous content when the write fails", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    fs.writeFileSync(target, "original\n");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      const err: any = new Error("EIO: i/o error");
      err.code = "EIO";
      throw err;
    });

    expect(() => writeSecretFileSync(target, "replacement\n")).toThrow();
    expect(fs.readFileSync(target, "utf-8")).toBe("original\n");
  });
});

describe("ensureSecretFileModeSync", () => {
  it.skipIf(!POSIX)("tightens a world-readable credential file", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    fs.writeFileSync(target, "{}\n");
    fs.chmodSync(target, 0o644);

    const healed = ensureSecretFileModeSync(target);

    expect(healed).toBe(true);
    expect(modeOf(target)).toBe(0o600);
  });

  it.skipIf(!POSIX)("reports no correction when the filesystem ignores the mode change", () => {
    // Claiming a correction that did not happen would repeat on every launch.
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    fs.writeFileSync(target, "{}\n");
    fs.chmodSync(target, 0o644);
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation((p: any, opts?: any) => {
      const stat = realStat(p, opts);
      return { ...stat, mode: (stat.mode & ~0o777) | 0o644 } as any;
    });
    vi.spyOn(fs, "chmodSync").mockImplementation(() => undefined as any);

    expect(ensureSecretFileModeSync(target)).toBe(false);
  });

  it.skipIf(!POSIX)("reports no change when the file is already owner-only", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    fs.writeFileSync(target, "{}\n");
    fs.chmodSync(target, 0o600);

    expect(ensureSecretFileModeSync(target)).toBe(false);
    expect(modeOf(target)).toBe(0o600);
  });

  it("treats a missing file as nothing to do", () => {
    const root = makeTmpDir();

    expect(ensureSecretFileModeSync(path.join(root, "absent.json"))).toBe(false);
  });

  it.skipIf(!POSIX)("propagates permission failures instead of swallowing them", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    fs.writeFileSync(target, "{}\n");
    fs.chmodSync(target, 0o644);
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      const err: any = new Error("EACCES: permission denied");
      err.code = "EACCES";
      throw err;
    });

    expect(() => ensureSecretFileModeSync(target)).toThrowError(/FS_PERMISSION|EACCES/);
  });
});

describe("ensureSecretDirModeSync", () => {
  it.skipIf(!POSIX)("tightens a world-traversable credential directory", () => {
    const root = makeTmpDir();
    const dir = path.join(root, "credentials");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);

    const healed = ensureSecretDirModeSync(dir);

    expect(healed).toBe(true);
    expect(modeOf(dir)).toBe(0o700);
  });

  it("treats a missing directory as nothing to do", () => {
    const root = makeTmpDir();

    expect(ensureSecretDirModeSync(path.join(root, "absent"))).toBe(false);
  });
});

describe("windows contract", () => {
  it.skipIf(POSIX)("writes content without attempting POSIX mode work", () => {
    const root = makeTmpDir();
    const target = path.join(root, "credential.json");
    const chmod = vi.spyOn(fs, "chmodSync");

    writeSecretFileSync(target, "{}\n");

    expect(fs.readFileSync(target, "utf-8")).toBe("{}\n");
    expect(chmod).not.toHaveBeenCalled();
    expect(ensureSecretFileModeSync(target)).toBe(false);
  });
});
