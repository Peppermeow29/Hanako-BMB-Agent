import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const MAIN_PATH = path.join(process.cwd(), "desktop", "main.cjs");

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const bodyStart = source.indexOf(") {", start) + 2;
  expect(bodyStart).toBeGreaterThan(1);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(bodyStart + 1, i);
  }
  throw new Error(`unterminated function ${name}`);
}

function caseBody(source, name) {
  const marker = `case "${name}": {`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const bodyStart = start + marker.length - 1;
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(bodyStart + 1, i);
  }
  throw new Error(`unterminated case ${name}`);
}

function ipcHandlerBody(source, channel) {
  const marker = `wrapIpcBestEffortHandler("${channel}"`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const bodyStart = source.indexOf("=> {", start) + 3;
  expect(bodyStart).toBeGreaterThan(start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(bodyStart + 1, i);
  }
  throw new Error(`unterminated ipc handler ${channel}`);
}

describe("desktop browser viewer window state", () => {
  it("does not wake secondary windows when showing the primary window", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "showPrimaryWindow");

    expect(body).toContain("focusExistingWindow(win)");
    expect(body).not.toContain("browserViewerWindow.show()");
    expect(body).not.toContain("settingsWindow.show()");
    expect(body).not.toContain("_viewerWindows");
  });

  it("hides the browser viewer when the active browser view is detached", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "_detachActiveBrowserView");

    expect(body).toContain("contentView.removeChildView(view)");
    expect(body).toContain("_browserWebView = null");
    expect(body).toContain("_currentBrowserSession = null");
    expect(body).toContain('webContents.send("browser-update"');
    expect(body).toContain("browserViewerWindow.hide()");
  });

  it("opens the browser viewer at the wider default size", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "createBrowserViewerWindow");

    expect(body).toContain("width: 1440");
    expect(body).toContain("height: 1080");
  });

  it("models browser views as session tab workspaces", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).toContain("sessionPath -> BrowserWorkspace");
    expect(source).toContain("tabId -> WebContentsView");
    expect(source).toContain("function _ensureBrowserWorkspace");
    expect(source).toContain("function _switchActiveBrowserTab");
  });

  it("keeps an empty workspace alive when the last tab closes", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const closeTab = caseBody(source, "closeTab");

    expect(closeTab).not.toContain("_browserViews.delete");
    expect(closeTab).not.toContain("running: false");
    expect(closeTab).toContain("_serializeBrowserWorkspace(workspace)");

    const removeRecord = functionBody(source, "_removeBrowserTabRecord");
    expect(removeRecord).not.toContain("_browserViews.delete");
  });

  it("shows an empty tab group instead of auto-creating a tab when the viewer opens", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    // 打开 viewer 不再替用户建标签页：有 tab 就切过去，没有就渲染空态
    expect(source).not.toContain("_ensureBrowserTabForSession");
  });

  it("syncs the tab workspace back to the server after viewer-driven tab edits", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).toContain("let _browserCmdWs = null");
    expect(source).toContain("function _syncWorkspaceToServer");
    expect(source).toContain('type: "browser-workspace-sync"');

    expect(ipcHandlerBody(source, "browser-new-tab")).toContain("_syncWorkspaceToServer(");
    expect(ipcHandlerBody(source, "browser-close-tab")).toContain("_syncWorkspaceToServer(");
  });

  it("isolates browser storage with a per-session Electron partition", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "_createBrowserWebContentsView");

    expect(source).toContain("function _browserPartitionName");
    expect(source).toContain('crypto.createHash("sha256")');
    expect(source).toContain('const _browserCookiePolicyInstalledPartitions = new Set()');
    expect(body).toContain("_installBrowserCookiePolicy(sessionPath)");
    expect(body).toContain("const ses = _browserSession(sessionPath)");
    expect(body).not.toContain('session.fromPartition("persist:hana-browser")');
  });

  it("routes browser viewer toolbar IPC through explicit session paths", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).toContain("function _resolveBrowserIpcSessionPath");
    expect(source).toContain('wrapIpcBestEffortHandler("browser-go-back", (_event, sessionPath)');
    expect(source).toContain('wrapIpcBestEffortHandler("browser-switch-tab", (_event, tabId, sessionPath)');
    expect(source).toContain('wrapIpcBestEffortHandler("browser-close-tab", async (_event, tabId, sessionPath)');
    expect(source).toContain('wrapIpcBestEffortHandler("browser-emergency-stop", (_event, sessionPath)');
  });

  it("exposes tab and Cookie browser IPC commands", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).toContain('wrapIpcBestEffortHandler("browser-new-tab"');
    expect(source).toContain('wrapIpcBestEffortHandler("browser-switch-tab"');
    expect(source).toContain('wrapIpcBestEffortHandler("browser-close-tab"');
    expect(source).toContain('case "setAcceptCookies"');
    expect(source).toContain('case "clearBrowserCookiesAndSiteData"');
  });

  it("reports viewer visibility and reports user activity for idle reclaim", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const visibility = caseBody(source, "viewerVisibility");

    expect(visibility).toContain("browserViewerWindow.isVisible()");
    expect(visibility).toContain("sessionPath: _currentBrowserSession");

    expect(source).toContain("function _sendBrowserUserActivity");
    expect(source).toContain('type: "browser-user-activity"');
    expect(ipcHandlerBody(source, "open-browser-viewer")).toContain("_sendBrowserUserActivity(");
    expect(ipcHandlerBody(source, "browser-go-back")).toContain("_sendBrowserUserActivity(");
    expect(ipcHandlerBody(source, "browser-go-forward")).toContain("_sendBrowserUserActivity(");
    expect(ipcHandlerBody(source, "browser-reload")).toContain("_sendBrowserUserActivity(");
    expect(ipcHandlerBody(source, "browser-new-tab")).toContain("_sendBrowserUserActivity(");
    expect(ipcHandlerBody(source, "browser-switch-tab")).toContain("_sendBrowserUserActivity(");
    expect(ipcHandlerBody(source, "browser-close-tab")).toContain("_sendBrowserUserActivity(");
  });

  it("routes new-window requests into a new in-app browser tab", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "_createBrowserWebContentsView");

    expect(body).toContain("_openUrlInNewBrowserTab");
    expect(body).toContain("{ show: view === _browserWebView }");
    expect(body).not.toContain("view.webContents.loadURL(url);");
    expect(body).toContain('return { action: "deny" }');
  });

  it("cleans up tab workspaces and keeps emergency stop on the detach helper", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).toContain('case "close"');
    expect(source).toContain('for (const tab of workspace.tabs.values())');
    expect(source).toContain('_detachActiveBrowserView({ view: active.view');
    expect(source).toContain('case "destroyView"');
    expect(source).toContain('_detachActiveBrowserView({ view, sessionPath: null, destroy: true, hideIfVisible: true, reason: "emergency-stop" })');
  });

  it("lets a session switch suspend without hiding the viewer window", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const suspend = caseBody(source, "suspend");

    // 切换会话时 viewer 保持可见，随后的 viewerShowSession 重绘目标 session
    expect(suspend).toContain("keepViewerVisible");
    expect(suspend).toContain("hideIfVisible: params.keepViewerVisible !== true");
  });

  it("repaints the viewer for the target session without changing window visibility", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const showSession = caseBody(source, "viewerShowSession");

    expect(source).toContain("const _browserSessionTitles = new Map()");
    expect(showSession).toContain("_browserSessionTitles.set(");
    expect(showSession).toContain("_switchActiveBrowserTab(sp, activeTab.tabId)");
    expect(showSession).toContain('webContents.send("browser-update"');
    expect(showSession).toContain("sessionTitle");
    // 永不自动弹窗：只重绘，不改变可见性
    expect(showSession).not.toContain("browserViewerWindow.show()");
    expect(showSession).not.toContain("browserViewerWindow.hide()");
  });

  it("labels every viewer update with the session title", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");
    const body = functionBody(source, "_notifyViewerUrl");

    expect(body).toContain("sessionTitle");
    expect(body).toContain("_browserSessionTitles.get(");
  });
});
