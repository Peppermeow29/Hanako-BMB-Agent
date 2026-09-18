import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const AUDIT_SCRIPT = path.join(process.cwd(), "scripts", "merge-audit.mjs");

const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-audit-fixture-"));
  tempDirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "fixture@test.local");
  git(dir, "config", "user.name", "fixture");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function write(cwd: string, file: string, content: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
}

function commitAll(cwd: string, message: string): void {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
}

function runAudit(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [AUDIT_SCRIPT, "--json", ...args], {
    cwd,
    encoding: "utf-8",
  });
  if (result.error) throw result.error;
  let parsed: any = null;
  try {
    parsed = JSON.parse(result.stdout || "null");
  } catch {
    // leave parsed null; assertions will surface stdout/stderr
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: parsed };
}

const PADDING = Array.from({ length: 10 }, (_, i) => `padding ${i}`).join("\n");

/**
 * 真实事故形态（2eff6f453 同款）：双侧改动不相交、git 本可干净自动合并，
 * 但合并者把文件整体 checkout 回单侧版本再提交，另一侧改动被无声丢弃。
 */
function makeClobberedRepo(): string {
  const dir = makeRepo();
  write(dir, "shared.txt", `alpha base\n${PADDING}\nomega base\n`);
  write(dir, "other.txt", "untouched\n");
  commitAll(dir, "base");

  git(dir, "checkout", "-q", "-b", "feature");
  write(dir, "shared.txt", `alpha base\n${PADDING}\nomega base\nfeature work\n`);
  commitAll(dir, "feature: extend shared tail");

  git(dir, "checkout", "-q", "main");
  write(dir, "shared.txt", `alpha mainline\n${PADDING}\nomega base\n`);
  commitAll(dir, "main: rework shared head");

  // 自动合并本应干净融合双侧，但把文件整体还原成 main 侧版本后提交
  const merge = spawnSync("git", ["merge", "--no-commit", "feature"], { cwd: dir, encoding: "utf-8" });
  expect(merge.status).toBe(0);
  git(dir, "checkout", "HEAD", "--", "shared.txt");
  git(dir, "add", "shared.txt");
  git(dir, "commit", "-q", "--no-edit");
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("merge-audit", () => {
  it("flags a merge that resolved a both-sides-changed file wholesale to one parent", () => {
    const dir = makeClobberedRepo();
    const { status, json, stderr } = runAudit(dir);

    expect(json, stderr).not.toBeNull();
    const findings = json.merges.flatMap((m: any) => m.findings);
    const hit = findings.find((f: any) => f.path === "shared.txt");
    expect(hit).toBeDefined();
    expect(hit.lostSide).toBe("second-parent");
    expect(hit.status).toBe("missing-at-head");
    expect(json.realCount).toBeGreaterThan(0);
    expect(status).toBe(1);
  });

  it("reports repaired losses as integrated and exits 0", () => {
    const dir = makeClobberedRepo();
    // 修复：把丢失的 feature 行补回（保留 main 行），等价于事后正确的三方结果
    write(dir, "shared.txt", `alpha mainline\n${PADDING}\nomega base\nfeature work\n`);
    commitAll(dir, "repair: restore feature work");

    const { status, json, stderr } = runAudit(dir);
    expect(json, stderr).not.toBeNull();
    const hit = json.merges.flatMap((m: any) => m.findings).find((f: any) => f.path === "shared.txt");
    expect(hit).toBeDefined();
    expect(hit.status).toBe("integrated");
    expect(json.realCount).toBe(0);
    expect(status).toBe(0);
  });

  it("stays silent on a clean merge of disjoint changes", () => {
    const dir = makeRepo();
    write(dir, "a.txt", "a\n");
    write(dir, "b.txt", "b\n");
    commitAll(dir, "base");

    git(dir, "checkout", "-q", "-b", "feature");
    write(dir, "a.txt", "a\nfrom feature\n");
    commitAll(dir, "feature: touch a");

    git(dir, "checkout", "-q", "main");
    write(dir, "b.txt", "b\nfrom main\n");
    commitAll(dir, "main: touch b");
    git(dir, "merge", "-q", "--no-edit", "feature");

    const { status, json, stderr } = runAudit(dir);
    expect(json, stderr).not.toBeNull();
    expect(json.merges.flatMap((m: any) => m.findings)).toEqual([]);
    expect(json.realCount).toBe(0);
    expect(status).toBe(0);
  });

  it("audits only the requested merge with --merge", () => {
    const dir = makeClobberedRepo();
    const mergeSha = git(dir, "rev-list", "--merges", "-1", "HEAD").trim();
    const { json, stderr } = runAudit(dir, "--merge", mergeSha);
    expect(json, stderr).not.toBeNull();
    expect(json.merges).toHaveLength(1);
    expect(json.merges[0].sha.startsWith(mergeSha.slice(0, 9))).toBe(true);
  });

  it("treats version-line files as expected noise that does not fail the audit", () => {
    const dir = makeRepo();
    write(dir, "package.json", '{ "version": "1.0.0" }\n');
    commitAll(dir, "base");

    git(dir, "checkout", "-q", "-b", "feature");
    write(dir, "package.json", '{ "version": "2.0.0" }\n');
    commitAll(dir, "feature: bump");

    git(dir, "checkout", "-q", "main");
    write(dir, "package.json", '{ "version": "1.0.1" }\n');
    commitAll(dir, "main: bump");

    const merge = spawnSync("git", ["merge", "--no-commit", "feature"], { cwd: dir, encoding: "utf-8" });
    expect(merge.status).not.toBe(0);
    git(dir, "checkout", "--ours", "--", "package.json");
    git(dir, "add", "package.json");
    git(dir, "commit", "-q", "--no-edit");

    const { status, json, stderr } = runAudit(dir);
    expect(json, stderr).not.toBeNull();
    const hit = json.merges.flatMap((m: any) => m.findings).find((f: any) => f.path === "package.json");
    expect(hit).toBeDefined();
    expect(hit.expected).toBe(true);
    expect(json.realCount).toBe(0);
    expect(status).toBe(0);
  });
});
