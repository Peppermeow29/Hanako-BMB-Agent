import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveSandboxPolicy } from "../lib/sandbox/policy.ts";
import { AccessLevel, PathGuard } from "../lib/sandbox/path-guard.ts";

describe("sandbox workspace roots", () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-sandbox-roots-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("grants full access to explicit extra workspace folders and read-only access to ordinary external paths", () => {
    const agentDir = path.join(tempRoot, "agents", "hana");
    const hanakoHome = path.join(tempRoot, "home");
    const primary = path.join(tempRoot, "project");
    const extra = path.join(tempRoot, "reference");
    const sibling = path.join(tempRoot, "private");
    for (const dir of [agentDir, hanakoHome, primary, extra, sibling]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const policy = deriveSandboxPolicy({
      agentDir,
      hanakoHome,
      workspace: primary,
      workspaceFolders: [extra],
      mode: "standard",
    });
    const guard = new PathGuard(policy);

    expect(policy.writablePaths).toContain(primary);
    expect(policy.writablePaths).toContain(extra);
    expect(policy.protectedPaths).toContain(path.join(primary, ".git"));
    expect(policy.protectedPaths).toContain(path.join(extra, ".git"));
    expect(guard.getAccessLevel(path.join(extra, "note.md"))).toBe(AccessLevel.FULL);
    expect(guard.getAccessLevel(path.join(sibling, "secret.md"))).toBe(AccessLevel.READ_ONLY);
    expect(guard.check(path.join(sibling, "secret.md"), "read").allowed).toBe(true);
    expect(guard.check(path.join(sibling, "secret.md"), "write").allowed).toBe(false);
    expect(guard.check(path.join(sibling, "secret.md"), "delete").allowed).toBe(false);
    expect(guard.check(path.join(extra, "deliver.md"), "stage").allowed).toBe(true);
    expect(guard.check(path.join(sibling, "secret.md"), "stage").allowed).toBe(false);
  });

  it("lets agents read session files but blocks writing runtime copies", () => {
    const agentDir = path.join(tempRoot, "agents", "hana");
    const hanakoHome = path.join(tempRoot, "home");
    const workspace = path.join(tempRoot, "project");
    const sessionFile = path.join(hanakoHome, "session-files", "abc123", "SKILL.md");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "---\nname: demo\n---\n", "utf-8");
    fs.mkdirSync(workspace, { recursive: true });

    const policy = deriveSandboxPolicy({
      agentDir,
      hanakoHome,
      workspace,
      workspaceFolders: [],
      mode: "standard",
    });
    const guard = new PathGuard(policy);

    expect(policy.writablePaths).not.toContain(path.join(hanakoHome, "session-files"));
    expect(guard.getAccessLevel(sessionFile)).toBe(AccessLevel.READ_ONLY);
    expect(guard.check(sessionFile, "read").allowed).toBe(true);
    expect(guard.check(sessionFile, "write").allowed).toBe(false);
    expect(guard.check(sessionFile, "stage").allowed).toBe(false);
  });

  it("honors read-all semantics for non-secret HANA_HOME paths while keeping writes scoped", () => {
    const agentDir = path.join(tempRoot, "home", "agents", "hana");
    const hanakoHome = path.join(tempRoot, "home");
    const workspace = path.join(tempRoot, "project");
    const pluginSkill = path.join(hanakoHome, "plugins", "demo", "skills", "reader", "SKILL.md");
    const pluginSource = path.join(hanakoHome, "plugins", "demo", "index.js");
    const blockedAuth = path.join(hanakoHome, "auth.json");
    fs.mkdirSync(path.dirname(pluginSkill), { recursive: true });
    fs.writeFileSync(pluginSkill, "---\nname: reader\n---\n", "utf-8");
    fs.writeFileSync(pluginSource, "export default {};\n", "utf-8");
    fs.writeFileSync(blockedAuth, "{}\n", "utf-8");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });

    const policy = deriveSandboxPolicy({
      agentDir,
      hanakoHome,
      workspace,
      workspaceFolders: [],
      mode: "standard",
    });
    const guard = new PathGuard(policy);

    expect(policy.access.read).toBe("all");
    expect(guard.getAccessLevel(pluginSkill)).toBe(AccessLevel.READ_ONLY);
    expect(guard.check(pluginSkill, "read").allowed).toBe(true);
    expect(guard.check(pluginSkill, "write").allowed).toBe(false);
    expect(guard.getAccessLevel(pluginSource)).toBe(AccessLevel.READ_ONLY);
    expect(guard.check(pluginSource, "read").allowed).toBe(true);
    expect(guard.check(blockedAuth, "read").allowed).toBe(false);
  });

  it("treats cwd and explicit runtime roots as scoped write roots", () => {
    const agentDir = path.join(tempRoot, "agents", "hana");
    const hanakoHome = path.join(tempRoot, "home");
    const workspace = path.join(tempRoot, "project");
    const cwd = path.join(tempRoot, "scratch");
    const runtimeRoot = path.join(tempRoot, "runtime-cache");
    for (const dir of [agentDir, hanakoHome, workspace, cwd, runtimeRoot]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const policy = deriveSandboxPolicy({
      agentDir,
      hanakoHome,
      workspace,
      workspaceFolders: [],
      cwd,
      runtimeWritablePaths: [runtimeRoot],
      mode: "standard",
    });
    const guard = new PathGuard(policy);

    expect(policy.access).toEqual({
      read: "all",
      write: "scoped",
      network: "on",
    });
    expect(policy.workspaceRoots).toContain(path.resolve(cwd));
    expect(policy.writablePaths).toContain(path.resolve(cwd));
    expect(policy.writablePaths).toContain(runtimeRoot);
    expect(guard.check(path.join(cwd, "generated.py"), "write").allowed).toBe(true);
    expect(guard.check(path.join(runtimeRoot, "tool-cache.tmp"), "write").allowed).toBe(true);
    expect(guard.check(path.join(runtimeRoot, "tool-cache.tmp"), "stage").allowed).toBe(false);
  });

  it("resolves symlinks before allowing a workspace file to be staged", () => {
    const agentDir = path.join(tempRoot, "agents", "hana");
    const hanakoHome = path.join(tempRoot, "home");
    const workspace = path.join(tempRoot, "project");
    const external = path.join(tempRoot, "private");
    for (const dir of [agentDir, hanakoHome, workspace, external]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const externalFile = path.join(external, "secret.txt");
    const workspaceLink = path.join(workspace, "linked.txt");
    fs.writeFileSync(externalFile, "secret", "utf-8");
    fs.symlinkSync(externalFile, workspaceLink);

    const guard = new PathGuard(deriveSandboxPolicy({
      agentDir,
      hanakoHome,
      workspace,
      workspaceFolders: [],
      mode: "standard",
    }));

    expect(guard.check(workspaceLink, "read").allowed).toBe(true);
    expect(guard.check(workspaceLink, "stage").allowed).toBe(false);
  });

  it("returns the canonical workspace target for an allowed staged symlink", () => {
    const agentDir = path.join(tempRoot, "agents", "hana");
    const hanakoHome = path.join(tempRoot, "home");
    const workspace = path.join(tempRoot, "project");
    for (const dir of [agentDir, hanakoHome, workspace]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const target = path.join(workspace, "report.txt");
    const link = path.join(workspace, "latest.txt");
    fs.writeFileSync(target, "report", "utf-8");
    fs.symlinkSync(target, link);

    const guard = new PathGuard(deriveSandboxPolicy({
      agentDir,
      hanakoHome,
      workspace,
      workspaceFolders: [],
      mode: "standard",
    }));

    expect(guard.check(link, "stage")).toEqual({
      allowed: true,
      canonicalPath: fs.realpathSync(target),
    });
  });
});
