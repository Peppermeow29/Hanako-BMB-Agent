import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createPreferencesRoute } from "../server/routes/preferences.ts";
import { mergeSidebarUiPrefs } from "../shared/sidebar-ui-state.ts";

function makeApp(engine) {
  const app = new Hono();
  app.route("/api", createPreferencesRoute(engine));
  return app;
}

describe("workspace UI preference routes", () => {
  it("persists and returns normalized workspace UI state by workspace root", async () => {
    const states = {};
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({})),
      getUtilityApi: vi.fn(() => ({})),
      getWorkspaceUiState: vi.fn((workspace, surface = "electron") => states[`${surface}:${workspace}`] || null),
      setWorkspaceUiState: vi.fn((workspace, surface, state) => {
        states[`${surface}:${workspace}`] = state;
        return state;
      }),
    };
    const app = makeApp(engine);

    const putRes = await app.request("/api/preferences/workspace-ui-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: "/repo/",
        state: {
          deskExpandedPaths: ["src", "", "../escape", "src"],
          deskSelectedPath: "src/App.tsx",
          rightWorkspaceTab: "workspace",
          jianView: "notes",
          jianDrawerOpen: true,
          previewOpen: true,
          openTabs: ["file-src/App.tsx", "missing-tab"],
          activeTabId: "missing-tab",
          previewTabs: [
            {
              id: "file-src/App.tsx",
              filePath: "/repo/src/App.tsx",
              relativePath: "src/App.tsx",
              title: "App.tsx",
              type: "code",
              ext: "tsx",
              language: "tsx",
              content: "must not persist",
            },
          ],
        },
      }),
    });

    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(engine.setWorkspaceUiState).toHaveBeenCalledWith("/repo", "electron", expect.objectContaining({
      deskExpandedPaths: ["src"],
      rightWorkspaceTab: "workspace",
      jianView: "notes",
      jianDrawerOpen: true,
      previewOpen: true,
      openTabs: ["file-src/App.tsx"],
      activeTabId: "file-src/App.tsx",
    }));
    expect(putBody.state.previewTabs[0]).toEqual({
      id: "file-src/App.tsx",
      filePath: "/repo/src/App.tsx",
      relativePath: "src/App.tsx",
      title: "App.tsx",
      type: "code",
      ext: "tsx",
      language: "tsx",
    });

    const getRes = await app.request("/api/preferences/workspace-ui-state?workspace=%2Frepo%2F");
    expect(getRes.status).toBe(200);
    expect(engine.getWorkspaceUiState).toHaveBeenCalledWith("/repo", "electron");
    await expect(getRes.json()).resolves.toEqual({ state: putBody.state });
  });

  it("persists sidebar UI state as a separate typed preference", async () => {
    let sidebarUi = null;
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({})),
      getUtilityApi: vi.fn(() => ({})),
      getSidebarUiPrefs: vi.fn(() => sidebarUi),
      setSidebarUiPrefs: vi.fn((patch) => {
        sidebarUi = mergeSidebarUiPrefs(sidebarUi || {}, patch);
        return sidebarUi;
      }),
    };
    const app = makeApp(engine);

    const putRes = await app.request("/api/preferences/sidebar-ui", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectView: {
          collapsedProjectIds: ["project-a", "", "project-a"],
          collapsedFolderIds: ["folder-a"],
          showAllProjectIds: ["project-b"],
        },
      }),
    });
    const putBody = await putRes.json();

    expect(putRes.status).toBe(200);
    expect(engine.setSidebarUiPrefs).toHaveBeenCalledWith({
      projectView: {
        collapsedProjectIds: ["project-a"],
        collapsedFolderIds: ["folder-a"],
        showAllProjectIds: ["project-b"],
      },
    });
    expect(putBody.sidebarUi.projectView).toEqual({
      collapsedProjectIds: ["project-a"],
      collapsedFolderIds: ["folder-a"],
      showAllProjectIds: ["project-b"],
    });
    expect(putBody.sidebarUi.sessionList).toEqual({ rowMode: "two-line" });

    const getRes = await app.request("/api/preferences/sidebar-ui");
    expect(getRes.status).toBe(200);
    expect(engine.getSidebarUiPrefs).toHaveBeenCalledTimes(1);
    await expect(getRes.json()).resolves.toEqual({ sidebarUi: putBody.sidebarUi });
  });

  it("persists sidebar session list density without resetting project view state", async () => {
    let sidebarUi = mergeSidebarUiPrefs({}, {
      projectView: {
        collapsedProjectIds: ["project-a"],
        collapsedFolderIds: ["folder-a"],
        showAllProjectIds: ["project-b"],
      },
    });
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({})),
      getUtilityApi: vi.fn(() => ({})),
      getSidebarUiPrefs: vi.fn(() => sidebarUi),
      setSidebarUiPrefs: vi.fn((patch) => {
        sidebarUi = mergeSidebarUiPrefs(sidebarUi || {}, patch);
        return sidebarUi;
      }),
    };
    const app = makeApp(engine);

    const putRes = await app.request("/api/preferences/sidebar-ui", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionList: { rowMode: "single-line" },
      }),
    });
    const putBody = await putRes.json();

    expect(putRes.status).toBe(200);
    expect(engine.setSidebarUiPrefs).toHaveBeenCalledWith({
      sessionList: { rowMode: "single-line" },
    });
    expect(putBody.sidebarUi).toEqual({
      projectView: {
        collapsedProjectIds: ["project-a"],
        collapsedFolderIds: ["folder-a"],
        showAllProjectIds: ["project-b"],
      },
      sessionList: { rowMode: "single-line" },
    });
  });

  it("separates workspace UI state by requested surface", async () => {
    const states = {};
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({})),
      getUtilityApi: vi.fn(() => ({})),
      getWorkspaceUiState: vi.fn((workspace, surface) => states[`${surface}:${workspace}`] || null),
      setWorkspaceUiState: vi.fn((workspace, surface, state) => {
        states[`${surface}:${workspace}`] = state;
        return state;
      }),
    };
    const app = makeApp(engine);

    const putRes = await app.request("/api/preferences/workspace-ui-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: "/repo",
        surface: "pwa",
        state: { deskExpandedPaths: ["mobile"] },
      }),
    });
    expect(putRes.status).toBe(200);
    expect(engine.setWorkspaceUiState).toHaveBeenCalledWith("/repo", "pwa", expect.objectContaining({
      deskExpandedPaths: ["mobile"],
    }));

    const getRes = await app.request("/api/preferences/workspace-ui-state?workspace=%2Frepo&surface=pwa");
    expect(getRes.status).toBe(200);
    expect(engine.getWorkspaceUiState).toHaveBeenCalledWith("/repo", "pwa");
    await expect(getRes.json()).resolves.toMatchObject({
      state: { deskExpandedPaths: ["mobile"] },
    });
  });

  it("rejects unknown workspace UI surfaces instead of merging unrelated clients", async () => {
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({})),
      getUtilityApi: vi.fn(() => ({})),
      getWorkspaceUiState: vi.fn(),
      setWorkspaceUiState: vi.fn(),
    };
    const app = makeApp(engine);

    const getRes = await app.request("/api/preferences/workspace-ui-state?workspace=%2Frepo&surface=watch");
    expect(getRes.status).toBe(400);
    await expect(getRes.json()).resolves.toEqual({ error: "workspace UI surface is invalid" });

    const putRes = await app.request("/api/preferences/workspace-ui-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "/repo", surface: "watch", state: {} }),
    });
    expect(putRes.status).toBe(400);
    await expect(putRes.json()).resolves.toEqual({ error: "workspace UI surface is invalid" });
    expect(engine.getWorkspaceUiState).not.toHaveBeenCalled();
    expect(engine.setWorkspaceUiState).not.toHaveBeenCalled();
  });
});
