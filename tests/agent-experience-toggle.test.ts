import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../core/agent.ts";

function makeTool(name) {
  return { name };
}

function makeAgent({ experienceEnabled }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-agent-experience-"));
  const agentsDir = path.join(root, "agents");
  const productDir = path.join(root, "product");
  const userDir = path.join(root, "user");
  const agentDir = path.join(agentsDir, "hana");
  fs.mkdirSync(path.join(productDir, "yuan"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, "yuan", "hanako.md"), "yuan", "utf-8");
  fs.writeFileSync(path.join(agentDir, "identity.md"), "identity", "utf-8");
  fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "persona", "utf-8");

  const agent = new Agent({
    id: "hana",
    agentsDir,
    productDir,
    userDir,
  } as any);
  agent._config = {
    locale: "en",
    agent: { name: "Hana", yuan: "hanako" },
    experience: { enabled: experienceEnabled },
  };
  agent.agentName = "Hana";
  agent.userName = "User";
  agent._memoryMasterEnabled = true;
  agent._memorySessionEnabled = true;
  agent._experienceEnabled = experienceEnabled === true;
  agent._memorySearchTool = makeTool("search_memory");
  agent._pinnedMemoryTools = [makeTool("pin_memory"), makeTool("unpin_memory")];
  agent._experienceTools = [makeTool("record_experience"), makeTool("recall_experience")];
  agent._webSearchTool = makeTool("web_search");
  agent._webFetchTool = makeTool("web_fetch");
  agent._todoTool = makeTool("todo_write");
  agent._stageFilesTool = makeTool("stage_files");
  agent._fileTool = makeTool("file");
  agent._notifyTool = makeTool("notify");
  agent._stopTaskTool = makeTool("stop_task");
  agent._checkDeferredTool = makeTool("check_pending_tasks");

  return { agent, root };
}

describe("agent experience toggle", () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) {
      fs.rmSync(roots.pop(), { recursive: true, force: true });
    }
  });

  it("defaults missing experience config to disabled", () => {
    const { agent, root } = makeAgent({ experienceEnabled: undefined });
    roots.push(root);

    expect(agent.experienceEnabled).toBe(false);
    expect(agent.getToolsSnapshot().map((tool) => tool.name)).not.toContain("recall_experience");
  });

  it("excludes experience tools while disabled", () => {
    const { agent, root } = makeAgent({ experienceEnabled: false });
    roots.push(root);

    // 经验引导已收口进 recall/record 工具的 description，随工具进出。
    // 工具关闭即不进工具集（description 也随之消失），不再单独在 system prompt 注入。
    const toolNames = agent.getToolsSnapshot().map((tool) => tool.name);
    expect(toolNames).not.toContain("record_experience");
    expect(toolNames).not.toContain("recall_experience");
  });

  it("includes experience tools while enabled", () => {
    const { agent, root } = makeAgent({ experienceEnabled: true });
    roots.push(root);

    const toolNames = agent.getToolsSnapshot().map((tool) => tool.name);
    expect(toolNames).toContain("record_experience");
    expect(toolNames).toContain("recall_experience");
  });

  it("does not expose a top-level wait tool", () => {
    const { agent, root } = makeAgent({ experienceEnabled: false });
    roots.push(root);

    expect(agent.getToolsSnapshot().map((tool) => tool.name)).not.toContain("wait");
  });

  it("does not expose the legacy terminal command tool", () => {
    const { agent, root } = makeAgent({ experienceEnabled: false });
    roots.push(root);

    expect(agent.getToolsSnapshot().map((tool) => tool.name)).not.toContain("terminal");
  });

  it("guides fresh sessions to record session files and deliver them through stage_files", () => {
    const { agent, root } = makeAgent({ experienceEnabled: false });
    roots.push(root);

    const prompt = agent.buildSystemPrompt();
    expect(prompt).toContain("SessionFile is the unified record of local files related to the current session");
    expect(prompt).toContain("fileId is the machine contract; label is display-only.");
    expect(prompt).toContain("After write/edit creates or modifies a file, call stage_files to deliver that change");
    expect(prompt).toContain("Do not re-stage an unchanged file");
    expect(prompt).not.toContain("create_artifact");
  });

  it("exposes transitional file tool beside legacy stage_files for SessionFile materialization v0", () => {
    const { agent, root } = makeAgent({ experienceEnabled: false });
    roots.push(root);

    const toolNames = agent.getToolsSnapshot().map((tool) => tool.name);
    expect(toolNames).toContain("stage_files");
    expect(toolNames).toContain("file");
    expect(toolNames).not.toContain("copy_file");
  });

  it("lets session creation force the frozen experience tool state", () => {
    const { agent, root } = makeAgent({ experienceEnabled: true });
    roots.push(root);

    const forcedOff = agent.getToolsSnapshot({ forceExperienceEnabled: false }).map((tool) => tool.name);
    expect(forcedOff).not.toContain("record_experience");
    expect(forcedOff).not.toContain("recall_experience");

    const forcedOn = agent.getToolsSnapshot({ forceExperienceEnabled: true }).map((tool) => tool.name);
    expect(forcedOn).toContain("record_experience");
    expect(forcedOn).toContain("recall_experience");
  });
});
