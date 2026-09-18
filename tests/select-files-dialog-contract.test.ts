import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const root = process.cwd();
const mainPath = path.join(root, "desktop", "main.cjs");
const preloadPath = path.join(root, "desktop", "preload.cjs");

function selectFilesHandler(source) {
  const match = source.match(/wrapIpcBestEffortHandler\("select-files"[\s\S]*?\n\}\);/);
  if (!match) throw new Error("select-files handler not found");
  return match[0];
}

describe("select-files dialog contract", () => {
  it("forwards selection options across the preload IPC bridge", () => {
    const preloadSource = fs.readFileSync(preloadPath, "utf-8");

    expect(preloadSource).toContain(
      'selectFiles: (options) => ipcRenderer.invoke("select-files", options)',
    );
  });

  it("keeps omitted options multi-select while explicit false opens a native single-file picker", () => {
    const mainSource = fs.readFileSync(mainPath, "utf-8");
    const handler = selectFilesHandler(mainSource);

    expect(handler).toContain("const allowMultiple = options?.multiple !== false;");
    expect(handler).toContain(
      'properties: allowMultiple ? ["openFile", "multiSelections"] : ["openFile"]',
    );
    expect(handler).not.toContain('"openDirectory"');
  });
});
