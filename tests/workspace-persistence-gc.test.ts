import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.ts";
import { upsertWorkspaceUiState } from "../shared/workspace-ui-state.ts";

/** Match runtime normalizeWorkspacePath: backslash → forward slash for cross-platform persistence */
const n = (p: string) => p.replace(/\\/g, "/");

describe("workspace persistence GC", () => {
  const tempRoots = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-workspace-gc-"));
    tempRoots.push(root);
    return root;
  }

  function writePrefs(userDir, workspaceUiState) {
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "preferences.json"), JSON.stringify({
      _defaultsRelaxedMigrated: true,
      workspace_ui_state: workspaceUiState,
    }, null, 2), "utf-8");
  }

  it("removes workspace_ui_state records for roots that are definitely gone", () => {
    const root = makeRoot();
    const userDir = path.join(root, "user");
    const existingWorkspace = path.join(root, "existing");
    const missingWorkspace = path.join(root, "missing");
    fs.mkdirSync(existingWorkspace);
    let state = upsertWorkspaceUiState({}, missingWorkspace, {
      deskExpandedPaths: ["old"],
    }, { surface: "electron", now: () => 1 });
    state = upsertWorkspaceUiState(state, existingWorkspace, {
      deskExpandedPaths: ["keep"],
    }, { surface: "electron", now: () => 2 });
    writePrefs(userDir, state);

    const manager = new PreferencesManager({ userDir, agentsDir: path.join(root, "agents") });

    expect(manager.getWorkspaceUiState(missingWorkspace, "electron")).toBeNull();
    expect(manager.getWorkspaceUiState(existingWorkspace, "electron")).toMatchObject({
      deskExpandedPaths: ["keep"],
    });
    const stored = JSON.parse(fs.readFileSync(path.join(userDir, "preferences.json"), "utf-8"));
    expect(stored.workspace_ui_state.workspaces[n(missingWorkspace)]).toBeUndefined();
    expect(stored.workspace_ui_state.workspaces[n(existingWorkspace)]).toBeDefined();
  });

  it("keeps workspace_ui_state when the root is temporarily inaccessible", () => {
    const root = makeRoot();
    const userDir = path.join(root, "user");
    const blockedWorkspace = path.join(root, "blocked");
    const originalStatSync = fs.statSync;
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((target, ...args) => {
      if (typeof target === "string" && n(path.normalize(target)) === n(path.normalize(blockedWorkspace))) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return originalStatSync.call(fs, target, ...args);
    });
    const state = upsertWorkspaceUiState({}, blockedWorkspace, {
      deskExpandedPaths: ["blocked"],
    }, { surface: "electron", now: () => 1 });
    writePrefs(userDir, state);

    const manager = new PreferencesManager({ userDir, agentsDir: path.join(root, "agents") });

    expect(manager.getWorkspaceUiState(blockedWorkspace, "electron")).toMatchObject({
      deskExpandedPaths: ["blocked"],
    });
    expect(statSpy).toHaveBeenCalledWith(n(blockedWorkspace));
    const stored = JSON.parse(fs.readFileSync(path.join(userDir, "preferences.json"), "utf-8"));
    expect(stored.workspace_ui_state.workspaces[n(blockedWorkspace)]).toBeDefined();
  });
});
