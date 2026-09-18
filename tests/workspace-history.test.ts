import { describe, expect, it } from "vitest";
import {
  buildWorkspacePickerItems,
  clearWorkspaceHistory,
  mergeWorkspaceHistory,
  removeWorkspaceHistoryEntries,
  workspaceDisplayName,
} from "../shared/workspace-history.ts";

describe("workspace history", () => {
  it("keeps persisted workspaces newest-first without duplicates", () => {
    expect(mergeWorkspaceHistory(["/old", "/workspace"], ["/workspace", "/new"]))
      .toEqual(["/new", "/workspace", "/old"]);
  });

  it("builds picker items from current workspace, home folder, and persisted history", () => {
    expect(buildWorkspacePickerItems({
      selectedFolder: "/workspace/Desktop",
      homeFolder: "/workspace/Hana",
      cwdHistory: ["/workspace/Desktop", "/workspace/Novel"],
    })).toEqual([
      "/workspace/Desktop",
      "/workspace/Hana",
      "/workspace/Novel",
    ]);
  });

  it("derives a stable folder display name from the workspace root", () => {
    expect(workspaceDisplayName("/workspace/Desktop/")).toBe("Desktop");
    expect(workspaceDisplayName("/")).toBe("/");
  });

  it("removes normalized workspace history entries without touching other roots", () => {
    expect(removeWorkspaceHistoryEntries([
      "/workspace/Desktop",
      "/workspace/Novel",
      "C:/Users/Hana/Project",
    ], [
      "/workspace/Desktop/",
      "C:\\Users\\Hana\\Project",
    ])).toEqual(["/workspace/Novel"]);
  });

  it("clears workspace history explicitly", () => {
    expect(clearWorkspaceHistory()).toEqual([]);
  });
});
