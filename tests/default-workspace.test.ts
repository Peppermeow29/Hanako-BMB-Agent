import os from "os";
import path from "path";
import fs from "fs";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
  DEFAULT_WORKSPACE_DIRNAME,
  isDefaultWorkspacePath,
  resolveDefaultWorkspacePath,
} from "../shared/default-workspace.ts";

describe("default workspace contract", () => {
  it("places the default workspace under the user's Desktop", () => {
    const homeDir = path.join(os.tmpdir(), "hana-default-workspace-home");

    expect(DEFAULT_WORKSPACE_DIRNAME).toBe("OH-WorkSpace");
    expect(resolveDefaultWorkspacePath(homeDir)).toBe(
      path.join(homeDir, "Desktop", "OH-WorkSpace"),
    );
  });

  it("uses 31 minutes as the patrol interval default", () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_MINUTES).toBe(31);
  });

  it("identifies the default workspace path without creating it", () => {
    const homeDir = path.join(os.tmpdir(), "hana-default-workspace-identify");
    const defaultPath = path.join(homeDir, "Desktop", "OH-WorkSpace");

    expect(isDefaultWorkspacePath(defaultPath, homeDir)).toBe(true);
    expect(isDefaultWorkspacePath(path.join(homeDir, "custom-work"), homeDir)).toBe(false);
    expect(fs.existsSync(defaultPath)).toBe(false);
  });

  it("resolves the default workspace path without creating it during query access", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-default-workspace-query-"));
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    try {
      const { ConfigCoordinator } = await import("../core/config-coordinator.ts");
      const coordinator = new ConfigCoordinator({
        getAgentById: () => ({ config: { desk: {} } }),
      });
      const expected = path.join(tmpHome, "Desktop", "OH-WorkSpace");

      expect(coordinator.getHomeFolder("hana")).toBe(expected);
      expect(fs.existsSync(expected)).toBe(false);
    } finally {
      homedirSpy.mockRestore();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe("restoreDefaultWorkspaceIfMissing", () => {
  it("recreates the default workspace when it is the cwd and missing", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-restore-ws-"));
    try {
      const { restoreDefaultWorkspaceIfMissing, resolveDefaultWorkspacePath } =
        await import("../shared/default-workspace.ts");
      const defaultPath = resolveDefaultWorkspacePath(tmpHome);

      expect(fs.existsSync(defaultPath)).toBe(false);
      expect(restoreDefaultWorkspaceIfMissing(defaultPath, tmpHome)).toBe(true);
      expect(fs.existsSync(defaultPath)).toBe(true);
      expect(restoreDefaultWorkspaceIfMissing(defaultPath, tmpHome)).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("never creates anything for a non-default cwd", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-restore-ws-user-"));
    try {
      const { restoreDefaultWorkspaceIfMissing } = await import("../shared/default-workspace.ts");
      const userDir = path.join(tmpHome, "my-projects", "gone");

      expect(restoreDefaultWorkspaceIfMissing(userDir, tmpHome)).toBe(false);
      expect(fs.existsSync(userDir)).toBe(false);
      expect(restoreDefaultWorkspaceIfMissing("", tmpHome)).toBe(false);
      expect(restoreDefaultWorkspaceIfMissing(undefined, tmpHome)).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
