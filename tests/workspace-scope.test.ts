import { describe, expect, it } from "vitest";
import path from "path";
import {
  formatWorkspaceScopePrompt,
  normalizeWorkspaceScope,
} from "../shared/workspace-scope.ts";

describe("workspace scope", () => {
  it("dedupes extra folders and excludes the primary cwd", () => {
    const primaryCwd = path.resolve("/workspace/project");
    const reference = path.resolve("/workspace/reference");
    const scope = normalizeWorkspaceScope({
      primaryCwd,
      workspaceFolders: [
        reference,
        primaryCwd,
        "",
        null,
        reference,
      ],
    });

    expect(scope).toEqual({
      primaryCwd,
      workspaceFolders: [reference],
    });
  });

  it("formats the primary workbench and external folders without duplicating cwd semantics", () => {
    const primaryCwd = path.resolve("/workspace/project");
    const reference = path.resolve("/workspace/reference");
    const prompt = formatWorkspaceScopePrompt({
      primaryCwd,
      workspaceFolders: [reference],
      locale: "zh-CN",
    });

    expect(prompt).toContain("主工作台");
    expect(prompt).toContain(primaryCwd);
    expect(prompt).toContain("外部工作区文件夹");
    expect(prompt).toContain(reference);
    expect(prompt).not.toContain("当前工作目录");
    expect(prompt).not.toContain("相对路径");
    expect(prompt).not.toContain("授权");
  });

  it("uses the same role distinction in English", () => {
    const primaryCwd = path.resolve("/workspace/project");
    const reference = path.resolve("/workspace/reference");
    const prompt = formatWorkspaceScopePrompt({
      primaryCwd,
      workspaceFolders: [reference],
      locale: "en-US",
    });

    expect(prompt).toContain("Primary workbench");
    expect(prompt).toContain("External workspace folders");
    expect(prompt).not.toContain("Current working directory");
    expect(prompt).not.toContain("Relative paths");
    expect(prompt).not.toContain("authorized");
  });
});
