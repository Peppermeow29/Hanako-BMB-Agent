import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstallSkillTool } from "../lib/tools/install-skill.ts";
import { writeZipFromDirectory } from "../lib/zip-writer.ts";

describe("install_skill global skill-pool installation", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("rejects skill_content so model-facing installs cannot create partial package shells", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-install-skill-tool-"));
    const agentDir = path.join(tmpDir, "agent");
    const userSkillsDir = path.join(tmpDir, "user-skills");
    fs.mkdirSync(agentDir, { recursive: true });
    const sessionPath = "/sessions/install-tool.jsonl";
    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_installed_skill",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: label,
      label,
      ext: "md",
      mime: "text/markdown",
      size: 32,
      kind: "markdown",
      origin,
      storageKind,
      createdAt: 1,
    }));
    const onInstalled = vi.fn();
    const tool = createInstallSkillTool({
      agentDir,
      getUserSkillsDir: () => userSkillsDir,
      getConfig: () => ({
        capabilities: {
          learn_skills: {
            enabled: true,
            safety_review: false,
          },
        },
      }),
      resolveUtilityConfig: () => null,
      onInstalled,
      registerSessionFile,
    });

    const result = await tool.execute("call-1", {
      skill_name: "demo-skill",
      skill_content: "---\nname: demo-skill\n---\n# Demo\n",
      reason: "test",
    }, null, null, {
      sessionManager: { getSessionFile: () => sessionPath },
    });

    const skillFilePath = path.join(userSkillsDir, "demo-skill", "SKILL.md");
    expect(result.content?.[0]?.text).toContain("完整 skill package");
    expect(result.details).toEqual({ rejectedInput: "skill_content" });
    expect(fs.existsSync(skillFilePath)).toBe(false);
    expect(registerSessionFile).not.toHaveBeenCalled();
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing skill when skill_content is provided", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-install-skill-tool-"));
    const agentDir = path.join(tmpDir, "agents", "agent-b");
    const userSkillsDir = path.join(tmpDir, "user-skills");
    fs.mkdirSync(path.join(userSkillsDir, "demo-skill"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const existingContent = "---\nname: demo-skill\n---\n# Existing\n";
    fs.writeFileSync(path.join(userSkillsDir, "demo-skill", "SKILL.md"), existingContent, "utf-8");
    const onInstalled = vi.fn();
    const tool = createInstallSkillTool({
      agentDir,
      getUserSkillsDir: () => userSkillsDir,
      getConfig: () => ({
        capabilities: {
          learn_skills: {
            enabled: true,
            safety_review: false,
          },
        },
      }),
      resolveUtilityConfig: () => null,
      onInstalled,
      registerSessionFile: vi.fn(),
    });

    const result = await tool.execute("call-1", {
      skill_name: "demo-skill",
      skill_content: "---\nname: demo-skill\n---\n# Different\n",
      reason: "test",
    }, null, null, {});

    const originalPath = path.join(userSkillsDir, "demo-skill", "SKILL.md");
    expect(fs.readFileSync(originalPath, "utf-8")).toContain("# Existing");
    expect(result.content?.[0]?.text).toContain("完整 skill package");
    expect((result as any).details).toEqual({ rejectedInput: "skill_content" });
    expect(onInstalled).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(userSkillsDir, "demo-skill-agent-b"))).toBe(false);
  });

  it("installs the full GitHub skill package instead of only SKILL.md", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-install-skill-tool-"));
    const agentDir = path.join(tmpDir, "agents", "agent-c");
    const userSkillsDir = path.join(tmpDir, "user-skills");
    const repoDir = path.join(tmpDir, "repo", "kami-main");
    fs.mkdirSync(path.join(repoDir, "references"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "assets", "templates"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "SKILL.md"), "---\nname: kami\n---\n# Kami\n", "utf-8");
    fs.writeFileSync(path.join(repoDir, "references", "design.md"), "# Design\n", "utf-8");
    fs.writeFileSync(path.join(repoDir, "assets", "templates", "page.html"), "<main></main>\n", "utf-8");

    const zipPath = path.join(tmpDir, "kami.zip");
    await writeZipFromDirectory(path.join(tmpDir, "repo"), zipPath);
    const zipBytes = fs.readFileSync(zipPath);
    const fetchMock = vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("api.github.com/repos/tw93/kami")) {
        return new Response(JSON.stringify({ stargazers_count: 5608 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (href.includes("codeload.github.com/tw93/kami/zip/HEAD")) {
        return new Response(zipBytes, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const onInstalled = vi.fn();
    const tool = createInstallSkillTool({
      agentDir,
      getUserSkillsDir: () => userSkillsDir,
      getConfig: () => ({
        capabilities: {
          learn_skills: {
            enabled: true,
            allow_github_fetch: true,
            safety_review: false,
          },
        },
      }),
      resolveUtilityConfig: () => null,
      onInstalled,
      registerSessionFile: vi.fn(),
    });

    const result = await tool.execute("call-1", {
      github_url: "https://github.com/tw93/kami",
      reason: "test",
    }, null, null, {});

    expect((result as any).details.skillName).toBe("kami");
    expect(fs.existsSync(path.join(userSkillsDir, "kami", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(userSkillsDir, "kami", "references", "design.md"))).toBe(true);
    expect(fs.existsSync(path.join(userSkillsDir, "kami", "assets", "templates", "page.html"))).toBe(true);
    expect((result as any).details).not.toHaveProperty("stars");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("api.github.com"))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("raw.githubusercontent.com"), expect.anything());
    expect(onInstalled).toHaveBeenCalledWith("kami");
  });

  it("installs a complete local skill package from local_path without GitHub fetch enabled", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-install-skill-tool-"));
    const agentDir = path.join(tmpDir, "agents", "agent-local");
    const userSkillsDir = path.join(tmpDir, "user-skills");
    const sourceDir = path.join(tmpDir, "source-skill");
    fs.mkdirSync(path.join(sourceDir, "references"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "---\nname: local-skill\n---\n# Local\n", "utf-8");
    fs.writeFileSync(path.join(sourceDir, "references", "guide.md"), "# Guide\n", "utf-8");

    const onInstalled = vi.fn();
    const registerSessionFile = vi.fn();
    const tool = createInstallSkillTool({
      agentDir,
      getUserSkillsDir: () => userSkillsDir,
      getConfig: () => ({
        capabilities: {
          learn_skills: {
            enabled: true,
            allow_github_fetch: false,
            safety_review: false,
          },
        },
      }),
      resolveUtilityConfig: () => null,
      onInstalled,
      registerSessionFile,
    });

    const result = await tool.execute("call-1", {
      local_path: sourceDir,
      reason: "test local package",
    }, null, null, {});

    expect((result as any).details.skillName).toBe("local-skill");
    expect((result as any).details.source).toBe("local_path");
    expect(fs.existsSync(path.join(userSkillsDir, "local-skill", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(userSkillsDir, "local-skill", "references", "guide.md"))).toBe(true);
    expect(onInstalled).toHaveBeenCalledWith("local-skill");
    expect(registerSessionFile).not.toHaveBeenCalled();
  });

  it("installs a local package through a typed path FileRef source", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-install-skill-tool-"));
    const agentDir = path.join(tmpDir, "agents", "agent-fileref");
    const userSkillsDir = path.join(tmpDir, "user-skills");
    const cwd = path.join(tmpDir, "workspace");
    const sourceDir = path.join(cwd, "skills", "ref-skill");
    fs.mkdirSync(path.join(sourceDir, "assets"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "---\nname: ref-skill\n---\n# Ref\n", "utf-8");
    fs.writeFileSync(path.join(sourceDir, "assets", "template.txt"), "template\n", "utf-8");

    const onInstalled = vi.fn();
    const tool = createInstallSkillTool({
      agentDir,
      getUserSkillsDir: () => userSkillsDir,
      getConfig: () => ({
        capabilities: {
          learn_skills: {
            enabled: true,
            safety_review: false,
          },
        },
      }),
      resolveUtilityConfig: () => null,
      onInstalled,
      registerSessionFile: vi.fn(),
    });

    const result = await tool.execute("call-1", {
      source: { type: "path", path: "skills/ref-skill" },
      reason: "test FileRef package",
    }, null, null, {
      sessionManager: { getCwd: () => cwd },
    });

    expect((result as any).details.skillName).toBe("ref-skill");
    expect((result as any).details.source).toBe("file_ref");
    expect(fs.existsSync(path.join(userSkillsDir, "ref-skill", "assets", "template.txt"))).toBe(true);
    expect(onInstalled).toHaveBeenCalledWith("ref-skill");
  });

  it("installs an uploaded skill package through a SessionFile fileId source", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-install-skill-tool-"));
    const agentDir = path.join(tmpDir, "agents", "agent-session-file");
    const userSkillsDir = path.join(tmpDir, "user-skills");
    const packageDir = path.join(tmpDir, "package");
    const sessionPath = "/sessions/skill-upload.jsonl";
    fs.mkdirSync(path.join(packageDir, "phone-skill", "references"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "phone-skill", "SKILL.md"), "---\nname: phone-skill\n---\n# Phone\n", "utf-8");
    fs.writeFileSync(path.join(packageDir, "phone-skill", "references", "guide.md"), "# Guide\n", "utf-8");
    const zipPath = path.join(tmpDir, "phone-skill.zip");
    await writeZipFromDirectory(packageDir, zipPath);
    const resolveSessionFile = vi.fn((fileId, options) => {
      if (fileId !== "sf_uploaded_skill" || options?.sessionPath !== sessionPath) return null;
      return {
        id: "sf_uploaded_skill",
        fileId: "sf_uploaded_skill",
        sessionPath,
        filePath: zipPath,
        realPath: zipPath,
        filename: "phone-skill.zip",
        label: "phone-skill.zip",
        mime: "application/zip",
        kind: "archive",
        status: "available",
      };
    });

    const onInstalled = vi.fn();
    const tool = createInstallSkillTool({
      agentDir,
      getUserSkillsDir: () => userSkillsDir,
      getConfig: () => ({
        capabilities: {
          learn_skills: {
            enabled: true,
            safety_review: false,
          },
        },
      }),
      resolveUtilityConfig: () => null,
      onInstalled,
      registerSessionFile: vi.fn(),
      resolveSessionFile,
    });

    const result = await tool.execute("call-1", {
      fileId: "sf_uploaded_skill",
      reason: "test uploaded package",
    }, null, null, {
      sessionManager: { getSessionFile: () => sessionPath },
    });

    expect((result as any).details.skillName).toBe("phone-skill");
    expect((result as any).details.source).toBe("file_ref");
    expect(fs.existsSync(path.join(userSkillsDir, "phone-skill", "references", "guide.md"))).toBe(true);
    expect(resolveSessionFile).toHaveBeenCalledWith("sf_uploaded_skill", { sessionPath });
    expect(onInstalled).toHaveBeenCalledWith("phone-skill");
  });

  it("installs an uploaded skill package by sessionId-first fileId source", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-install-skill-tool-"));
    const agentDir = path.join(tmpDir, "agents", "agent-session-id-file");
    const userSkillsDir = path.join(tmpDir, "user-skills");
    const packageDir = path.join(tmpDir, "package");
    const sessionId = "sess_skill_upload";
    const sessionPath = "/sessions/skill-upload-moved.jsonl";
    fs.mkdirSync(path.join(packageDir, "id-skill"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "id-skill", "SKILL.md"), "---\nname: id-skill\n---\n# ID\n", "utf-8");
    const zipPath = path.join(tmpDir, "id-skill.zip");
    await writeZipFromDirectory(packageDir, zipPath);
    const resolveSessionFile = vi.fn((fileId, options) => {
      if (fileId !== "sf_uploaded_skill" || options?.sessionId !== sessionId) return null;
      return {
        id: "sf_uploaded_skill",
        fileId: "sf_uploaded_skill",
        sessionId,
        sessionPath,
        filePath: zipPath,
        realPath: zipPath,
        filename: "id-skill.zip",
        label: "id-skill.zip",
        mime: "application/zip",
        kind: "archive",
        status: "available",
      };
    });

    const onInstalled = vi.fn();
    const tool = createInstallSkillTool({
      agentDir,
      getUserSkillsDir: () => userSkillsDir,
      getConfig: () => ({
        capabilities: {
          learn_skills: {
            enabled: true,
            safety_review: false,
          },
        },
      }),
      resolveUtilityConfig: () => null,
      onInstalled,
      registerSessionFile: vi.fn(),
      resolveSessionFile,
    });

    const result = await tool.execute("call-1", {
      fileId: "sf_uploaded_skill",
      sessionId,
      reason: "test uploaded package",
    }, null, null, {
      sessionManager: { getSessionFile: () => "/sessions/current.jsonl" },
    });

    expect((result as any).details.skillName).toBe("id-skill");
    expect(resolveSessionFile).toHaveBeenCalledWith("sf_uploaded_skill", { sessionId });
    expect(onInstalled).toHaveBeenCalledWith("id-skill");
  });
});
