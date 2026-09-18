import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  WorkflowFolderScopeError,
  assertNodeWriteFoldersShape,
  assertNodeWriteScopeDeclared,
  resolveNodeFolderScope,
} from "../lib/workflow/node-folder-scope.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-wfscope-"));
const parentA = path.join(root, "parent-a");
const sub = path.join(parentA, "sub");
const parentB = path.join(root, "parent-b");
const outside = path.join(root, "outside");
for (const d of [parentA, sub, parentB, outside]) fs.mkdirSync(d, { recursive: true });
const parentScope = { sandboxFolders: [parentA, parentB] };

function catchScopeError(fn: () => unknown) {
  try { fn(); } catch (err) { return err as any; }
  return null;
}

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("assertNodeWriteFoldersShape", () => {
  it("null/undefined 直接放行", () => {
    expect(() => assertNodeWriteFoldersShape(null, undefined)).not.toThrow();
    expect(() => assertNodeWriteFoldersShape(undefined, "read")).not.toThrow();
  });

  it('access:"read" 与 writeFolders 冲突', () => {
    const err = catchScopeError(() => assertNodeWriteFoldersShape([parentA], "read"));
    expect(err).toBeInstanceOf(WorkflowFolderScopeError);
    expect(err.code).toBe("WRITE_FOLDERS_CONFLICT_WITH_READ");
  });

  it("拒绝空数组 / 非数组 / 相对路径 / 空白串", () => {
    expect(catchScopeError(() => assertNodeWriteFoldersShape([], undefined))?.code).toBe("WRITE_FOLDERS_INVALID");
    expect(catchScopeError(() => assertNodeWriteFoldersShape("x", undefined))?.code).toBe("WRITE_FOLDERS_INVALID");
    expect(catchScopeError(() => assertNodeWriteFoldersShape(["relative/dir"], undefined))?.code).toBe("WRITE_FOLDERS_INVALID");
    expect(catchScopeError(() => assertNodeWriteFoldersShape(["   "], undefined))?.code).toBe("WRITE_FOLDERS_INVALID");
  });
});

describe("assertNodeWriteScopeDeclared（default-deny）", () => {
  it("已声明 writeFolders → 放行", () => {
    expect(() => assertNodeWriteScopeDeclared({
      writeFolders: [parentA], access: null, parentPermissionMode: "auto", nodeId: "node-1", label: null,
    })).not.toThrow();
  });

  it('access:"read" 节点豁免', () => {
    expect(() => assertNodeWriteScopeDeclared({
      writeFolders: null, access: "read", parentPermissionMode: "auto", nodeId: "node-1", label: null,
    })).not.toThrow();
  });

  it("父会话只读豁免（节点本来写不了）", () => {
    expect(() => assertNodeWriteScopeDeclared({
      writeFolders: null, access: null, parentPermissionMode: "read_only", nodeId: "node-1", label: null,
    })).not.toThrow();
  });

  it("写能力节点未声明 → WRITE_FOLDERS_REQUIRED，消息含节点名、修复方式与 resume 指引", () => {
    const err = catchScopeError(() => assertNodeWriteScopeDeclared({
      writeFolders: null, access: "write", parentPermissionMode: "auto", nodeId: "node-2", label: "builder",
    }));
    expect(err).toBeInstanceOf(WorkflowFolderScopeError);
    expect(err.code).toBe("WRITE_FOLDERS_REQUIRED");
    expect(err.message).toContain("builder");
    expect(err.message).toContain('access:"read"');
    expect(err.message).toContain("writeFolders");
    expect(err.message).toContain("resumeFromRunId");
  });

  it("省略 access 且父档可操作（含未知/null 档，继承默认可操作）→ 同样要求声明", () => {
    expect(catchScopeError(() => assertNodeWriteScopeDeclared({
      writeFolders: null, access: null, parentPermissionMode: "auto", nodeId: "node-3", label: null,
    }))?.code).toBe("WRITE_FOLDERS_REQUIRED");
    expect(catchScopeError(() => assertNodeWriteScopeDeclared({
      writeFolders: null, access: null, parentPermissionMode: null, nodeId: "node-4", label: null,
    }))?.code).toBe("WRITE_FOLDERS_REQUIRED");
  });
});

describe("resolveNodeFolderScope", () => {
  it("父 scope 内的目录 → cwd=第一项，其余进 workspaceFolders，authorizedFolders 恒空", () => {
    const scope = resolveNodeFolderScope({ writeFolders: [sub, parentB], parentFolderScope: parentScope });
    expect(scope.cwd).toBe(fs.realpathSync(sub));
    expect(scope.workspaceFolders).toEqual([fs.realpathSync(parentB)]);
    expect(scope.authorizedFolders).toEqual([]);
  });

  it("越界目录报 WRITE_FOLDER_OUTSIDE_PARENT_SCOPE", () => {
    const err = catchScopeError(() => resolveNodeFolderScope({ writeFolders: [outside], parentFolderScope: parentScope }));
    expect(err).toBeInstanceOf(WorkflowFolderScopeError);
    expect(err.code).toBe("WRITE_FOLDER_OUTSIDE_PARENT_SCOPE");
  });

  it("不存在的目录报 WRITE_FOLDER_NOT_FOUND（fail-closed，不静默裁剪）", () => {
    const err = catchScopeError(() => resolveNodeFolderScope({ writeFolders: [path.join(parentA, "nope")], parentFolderScope: parentScope }));
    expect(err?.code).toBe("WRITE_FOLDER_NOT_FOUND");
  });

  it("指向文件而非目录报 WRITE_FOLDER_NOT_DIRECTORY", () => {
    const file = path.join(parentA, "f.txt");
    fs.writeFileSync(file, "x");
    const err = catchScopeError(() => resolveNodeFolderScope({ writeFolders: [file], parentFolderScope: parentScope }));
    expect(err?.code).toBe("WRITE_FOLDER_NOT_DIRECTORY");
  });

  it("symlink 逃逸：链接文本在父 scope 内但真实指向 scope 外 → 拒绝", () => {
    const link = path.join(parentA, "escape-link");
    try { fs.symlinkSync(outside, link, "dir"); } catch { return; } // 平台不支持 symlink 则跳过
    const err = catchScopeError(() => resolveNodeFolderScope({ writeFolders: [link], parentFolderScope: parentScope }));
    expect(err?.code).toBe("WRITE_FOLDER_OUTSIDE_PARENT_SCOPE");
  });

  it("父 scope 缺失报 PARENT_SCOPE_UNAVAILABLE", () => {
    const err = catchScopeError(() => resolveNodeFolderScope({ writeFolders: [parentA], parentFolderScope: null }));
    expect(err?.code).toBe("PARENT_SCOPE_UNAVAILABLE");
  });

  it("去重且保序", () => {
    const scope = resolveNodeFolderScope({ writeFolders: [parentA, parentA, parentB], parentFolderScope: parentScope });
    expect(scope.cwd).toBe(fs.realpathSync(parentA));
    expect(scope.workspaceFolders).toEqual([fs.realpathSync(parentB)]);
  });
});
