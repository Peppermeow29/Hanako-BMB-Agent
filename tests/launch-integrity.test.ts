import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

const require = createRequire(import.meta.url);
const helperPath = path.join(process.cwd(), "desktop", "src", "shared", "launch-integrity.cjs");
const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-launch-integrity-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("desktop launch diagnostics helper", () => {
  it("writes a structured launch diagnostic", () => {
    const helper = require(helperPath);
    const diagnosticsDir = path.join(makeTempDir(), "diagnostics");
    const filePath = helper.writeLaunchDiagnostic({
      diagnosticsDir,
      fileName: "launch-marker.json",
      event: "bootstrap-started",
      payload: { pid: 123 },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(filePath).toBe(path.join(diagnosticsDir, "launch-marker.json"));
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      event: "bootstrap-started",
      time: "2026-01-01T00:00:00.000Z",
      payload: { pid: 123 },
    });
  });

  it("appends newline-delimited launch events", () => {
    const helper = require(helperPath);
    const diagnosticsDir = path.join(makeTempDir(), "diagnostics");
    const filePath = helper.appendLaunchLog({
      diagnosticsDir,
      event: "main-loaded",
      payload: { packaged: false },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      event: "main-loaded",
      time: "2026-01-01T00:00:00.000Z",
      payload: { packaged: false },
    });
  });

  it("prefers original-fs and falls back to fs", () => {
    const helper = require(helperPath);
    const originalFs = { tag: "original-fs" };
    const nodeFs = { tag: "fs" };
    expect(helper.resolveRealFs((id) => id === "original-fs" ? originalFs : nodeFs)).toBe(originalFs);
    expect(helper.resolveRealFs((id) => {
      if (id === "original-fs") throw new Error("outside Electron");
      return nodeFs;
    })).toBe(nodeFs);
  });
});
