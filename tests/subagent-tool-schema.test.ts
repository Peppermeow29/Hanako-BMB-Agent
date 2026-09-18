import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/i18n.ts", () => ({ t: (k: string) => k, getLocale: () => "en" }));

const baseDeps = {
  currentAgentId: "test",
  getParentCwd: () => "/tmp",
  executeIsolated: async () => {},
};

async function loadSubagentToolDef(extraDeps = {}) {
  const mod = await import("../lib/tools/subagent-tool.ts");
  const tool = (mod as any).createSubagentTool({ ...baseDeps, ...extraDeps });
  return tool;
}

describe("subagent tool schema", () => {
  it("does not duplicate generic background task polling rules", async () => {
    const tool = await loadSubagentToolDef();
    expect(tool.description).not.toContain("check_pending_tasks");
    expect(tool.description).not.toContain("Check at most");
    expect(tool.description).not.toContain("<hana-background-result>");
  });

  it("excludes delegation guidance by default (experiment off)", async () => {
    const tool = await loadSubagentToolDef();
    expect(tool.description).not.toContain("direct tool");
    expect(tool.description).not.toContain("protecting the main context window");
    expect(tool.description).toContain("continuable subagent instance");
  });

  it("keeps description concise even when proactiveDelegation is on", async () => {
    const tool = await loadSubagentToolDef({ proactiveDelegation: true });
    expect(tool.description).toContain("continuable subagent instance");
    expect(tool.description.length).toBeLessThan(300);
  });

  it("has correct parameter descriptions", async () => {
    const schema = await loadSubagentToolDef();
    const props = schema.parameters?.properties;
    expect(props?.agent?.description).toMatch(/backticks/);
    expect(props?.agent?.description).toMatch(/persona/);
    expect(props?.agent?.description).toMatch(/model/);
    expect(props?.label?.description).toMatch(/display/i);
    expect(props?.label?.description).toMatch(/threadId|subagent_reply/);
    expect(props?.instance?.description).toMatch(/[Ll]egacy/);
    expect(props?.model?.description).toMatch(/chat model/);
  });

  it("access 描述写清两档语义与父档约束（#1614：模型据此主动选档）", async () => {
    const schema = await loadSubagentToolDef();
    const desc = schema.parameters?.properties?.access?.description || "";
    // read = 探索/调研/审查只读
    expect(desc).toMatch(/read-only/i);
    expect(desc).toMatch(/research|exploration|review/i);
    // write = 执行/修改，且父会话必须可操作（不能超过父档）
    expect(desc).toMatch(/execution|edits|commands/i);
    expect(desc).toMatch(/parent session/i);
    expect(desc).toMatch(/read-only.*(reject|error|denied)|((reject|error|denied)).*read-only/i);
  });
});
