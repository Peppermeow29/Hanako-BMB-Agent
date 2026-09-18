/**
 * viewer-window-load-contract.test.ts
 *
 * 回归保护：viewer 窗口的载荷传递必须是显式拉取契约（`viewer-request-load`
 * invoke/handle），不能退回到 `did-finish-load` 时机推送（`viewer-load` send）。
 *
 * 根因：推送是一次性的；渲染侧在 React useEffect（晚于 commit+paint）里才注册
 * 监听，推送先于注册 -> payload 永久丢失 -> 窗口卡在 Loading。冷启动下 V8 首编译
 * + splash 抢 CPU 时这个竞态几乎必现。
 *
 * 注：main.cjs 里 spawn-viewer 的窗口创建体是内联写在 wrapIpcBestEffortHandler
 * 回调里的、没有抽成具名函数，所以这里直接定位 `wrapIpcBestEffortHandler("spawn-viewer"`
 * 回调体，而不是按函数名查找。
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const MAIN_PATH = path.join(process.cwd(), "desktop", "main.cjs");
const PRELOAD_PATH = path.join(process.cwd(), "desktop", "preload.cjs");

function readSource(filePath: string): string {
  // Windows CI checks out with CRLF; contract tests match LF-shaped snippets.
  return fs.readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
}

function sliceFrom(source: string, marker: string, length: number): string {
  const idx = source.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  return source.slice(idx, idx + length);
}

describe("viewer window load contract (main process)", () => {
  it("never sends viewer-load on did-finish-load (push contract is banned)", () => {
    const source = readSource(MAIN_PATH);
    // 唯一允许出现的地方是注释里解释历史根因，不能出现在真正的 send 调用里
    expect(source).not.toContain('webContents.send("viewer-load"');
    expect(source).not.toContain("webContents.send('viewer-load'");
  });

  it("exposes viewer-request-load as a strict (error-propagating) handler", () => {
    const source = readSource(MAIN_PATH);
    expect(source).toContain('wrapIpcHandler("viewer-request-load"');
  });

  it("stores payloads in a windowId-keyed map alongside _viewerWindows", () => {
    const source = readSource(MAIN_PATH);
    expect(source).toContain("const _viewerPayloads = new Map()");

    const spawnBody = sliceFrom(source, 'wrapIpcBestEffortHandler("spawn-viewer"', 2000);
    expect(spawnBody).toContain("_viewerPayloads.set(windowId, data)");
    // 关闭时必须清理，否则 payload 会在 renderer 侧滞留成内存泄漏
    expect(spawnBody).toContain("_viewerPayloads.delete(windowId)");
  });

  it("clears all viewer payloads when the main window is destroyed", () => {
    const source = readSource(MAIN_PATH);
    expect(source).toContain("_viewerWindows.clear();\n    _viewerPayloads.clear();");
  });

  it("viewer-request-load resolves the payload for the requesting window's own id", () => {
    const source = readSource(MAIN_PATH);
    const handlerSlice = sliceFrom(source, 'wrapIpcHandler("viewer-request-load"', 500);
    expect(handlerSlice).toContain("BrowserWindow.fromWebContents(event.sender)");
    expect(handlerSlice).toContain("_viewerPayloads.get(win.id)");
    expect(handlerSlice).toContain("return { ...data, windowId: win.id }");
  });

  it("preload no longer exposes onViewerLoad and instead exposes viewerRequestLoad", () => {
    const source = readSource(PRELOAD_PATH);
    expect(source).not.toContain("onViewerLoad");
    expect(source).not.toContain('ipcRenderer.on("viewer-load"');
    expect(source).toContain('viewerRequestLoad: () => ipcRenderer.invoke("viewer-request-load")');
  });
});
