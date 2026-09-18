import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  resolveHanakoHome,
  resolveHanaPiSdkManagedBinDir,
  resolveHanaPiSdkResourceLoaderAgentDir,
  resolveHanaPiSdkResourceLoaderCwd,
  resolveHanaPiSdkRuntimeRoot,
  resolveLegacyPiSdkManagedBinDir,
} from "../shared/hana-runtime-paths.ts";

describe("Hana runtime path contracts", () => {
  it("derives Hana-owned Pi SDK runtime paths from HANA_HOME", () => {
    const hanakoHome = path.join(os.tmpdir(), "hana-runtime-paths", ".hanako-dev");
    const runtimeRoot = path.join(hanakoHome, "runtime", "pi-sdk");

    expect(resolveHanaPiSdkRuntimeRoot(hanakoHome)).toBe(runtimeRoot);
    expect(resolveHanaPiSdkManagedBinDir(hanakoHome)).toBe(path.join(runtimeRoot, "bin"));
    expect(resolveHanaPiSdkResourceLoaderCwd(hanakoHome)).toBe(path.join(runtimeRoot, "resource-loader", "project"));
    expect(resolveHanaPiSdkResourceLoaderAgentDir(hanakoHome)).toBe(path.join(runtimeRoot, "resource-loader", "agent"));
  });

  it("normalizes HANA_HOME before deriving Pi SDK paths", () => {
    const homeDir = path.join(os.tmpdir(), "hana-runtime-home");

    expect(resolveHanakoHome("~/.hanako-dev", homeDir)).toBe(path.join(homeDir, ".hanako-dev"));
  });

  it("keeps legacy Pi binary lookup explicit without creating either tree", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-runtime-dirs-"));
    const hanakoHome = path.join(root, ".hanako");

    expect(resolveLegacyPiSdkManagedBinDir(hanakoHome)).toBe(
      path.join(hanakoHome, ".pi", "agent", "bin"),
    );
    expect(resolveHanaPiSdkManagedBinDir(hanakoHome)).toBe(
      path.join(hanakoHome, "runtime", "pi-sdk", "bin"),
    );

    expect(fs.existsSync(hanakoHome)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
