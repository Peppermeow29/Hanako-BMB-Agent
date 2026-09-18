import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../lib/i18n.js", () => ({
  getLocale: () => "zh-CN",
  t: (key: string, values?: Record<string, unknown>) => values?.reply ? `${key}:${values.reply}` : key,
}));

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(),
}));

import { callText } from "../core/llm-client.ts";
import { createInstallSkillTool, safetyReview } from "../lib/tools/install-skill.ts";

describe("install_skill safety review", () => {
  let tmpDir: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("does not cap the utility review output with maxTokens", async () => {
    (callText as any).mockResolvedValueOnce("safe");

    const result = await safetyReview("---\nname: demo\n---\n# Demo\n", async () => ({
      utility: "utility-model",
      api_key: "key",
      base_url: "https://example.test",
      api: "openai",
      headers: { "x-provider-contract": "install-skill" },
    }));

    expect(result).toEqual({ safe: true });
    expect(callText).toHaveBeenCalledOnce();
    expect((callText as any).mock.calls[0][0].headers).toEqual({ "x-provider-contract": "install-skill" });
    expect((callText as any).mock.calls[0][0]).not.toHaveProperty("maxTokens");
  });

  it("allows resolver-approved header-only utility credentials", async () => {
    (callText as any).mockResolvedValueOnce("safe");

    const result = await safetyReview("---\nname: demo\n---\n# Demo\n", async () => ({
      utility: "utility-model",
      api_key: "",
      base_url: "https://example.test",
      api: "openai",
      headers: { Authorization: "Bearer header-owned-token" },
    }));

    expect(result).toEqual({ safe: true });
    expect(callText).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "",
      headers: { Authorization: "Bearer header-owned-token" },
    }));
  });

  it("uses a small-utility-only resolver for install skill safety review", async () => {
    (callText as any).mockResolvedValueOnce("safe");
    const resolveUtilityConfig = vi.fn(async (options) => {
      expect(options).toMatchObject({
        requireUtilityLarge: false,
        purpose: "install_skill_safety",
      });
      return {
        utility: "utility-model",
        api_key: "key",
        base_url: "https://example.test",
        api: "openai",
      };
    });

    const result = await safetyReview("---\nname: demo\n---\n# Demo\n", resolveUtilityConfig);

    expect(result).toEqual({ safe: true });
    expect(resolveUtilityConfig).toHaveBeenCalledOnce();
    expect(callText).toHaveBeenCalledOnce();
  });

  it("keeps Agent and AgentManager resolver wrappers option-aware for install_skill", () => {
    const agentSource = fs.readFileSync(path.join(process.cwd(), "core", "agent.ts"), "utf-8");
    const managerSource = fs.readFileSync(path.join(process.cwd(), "core", "agent-manager.ts"), "utf-8");

    expect(agentSource).toContain(
      "resolveUtilityConfig: (options) => this._cb?.resolveUtilityConfigFresh?.(options)",
    );
    expect(managerSource).toContain(
      "resolveUtilityConfigFresh: (options) => getEngine()?.resolveUtilityConfigFresh?.({ ...(options || {}), agentId: ag.id })",
    );
  });

  it("does not call the review network boundary when fresh utility resolution fails", async () => {
    const result = await safetyReview(
      "---\nname: demo\n---\n# Demo\n",
      async () => { throw new Error("oauth refresh failed"); },
    );

    expect(result).toEqual({ safe: false, reason: "oauth refresh failed" });
    expect(callText).not.toHaveBeenCalled();
  });

  it("returns a soft confirmation gate when safety review fails", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-install-skill-safety-"));
    const sourceDir = path.join(tmpDir, "source");
    const userSkillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "---\nname: risky-skill\n---\n# Risky\n", "utf-8");
    (callText as any).mockResolvedValueOnce("suspicious: asks to ignore previous instructions");
    const onInstalled = vi.fn();
    const tool = createInstallSkillTool({
      getUserSkillsDir: () => userSkillsDir,
      getConfig: () => ({
        capabilities: { learn_skills: { enabled: true, safety_review: true } },
      }),
      resolveUtilityConfig: () => ({
        utility: "utility-model",
        api_key: "key",
        base_url: "https://example.test",
        api: "openai",
      }),
      onInstalled,
      registerSessionFile: vi.fn(),
    });

    const result = await tool.execute("call-1", {
      local_path: sourceDir,
      reason: "test suspicious package",
    }, null, null, {});

    expect((result as any).details).toMatchObject({
      requiresRiskConfirmation: true,
      riskAccepted: false,
      riskReason: "asks to ignore previous instructions",
      safetyReview: false,
      source: "local_path",
      nextAction: "ask_user_then_retry_with_risk_accepted",
    });
    expect((result as any).details.riskConfirmationToken).toMatch(/^risk_/);
    expect(fs.existsSync(path.join(userSkillsDir, "risky-skill", "SKILL.md"))).toBe(false);
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it("does not accept risk_accepted without the returned confirmation token", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-install-skill-safety-"));
    const sourceDir = path.join(tmpDir, "source");
    const userSkillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "---\nname: missing-token-skill\n---\n# Risky\n", "utf-8");
    (callText as any).mockResolvedValueOnce("suspicious: broad trigger");
    const onInstalled = vi.fn();
    const tool = createInstallSkillTool({
      getUserSkillsDir: () => userSkillsDir,
      getConfig: () => ({
        capabilities: { learn_skills: { enabled: true, safety_review: true } },
      }),
      resolveUtilityConfig: () => ({
        utility: "utility-model",
        api_key: "key",
        base_url: "https://example.test",
        api: "openai",
      }),
      onInstalled,
      registerSessionFile: vi.fn(),
    });

    const result = await tool.execute("call-1", {
      local_path: sourceDir,
      reason: "preemptive bypass attempt",
      risk_accepted: true,
    }, null, null, {});

    expect((result as any).details).toMatchObject({
      requiresRiskConfirmation: true,
      riskAcceptanceRejection: "missing_confirmation_token",
      source: "local_path",
    });
    expect(fs.existsSync(path.join(userSkillsDir, "missing-token-skill", "SKILL.md"))).toBe(false);
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it("installs after explicit risk acceptance even when safety review fails", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-install-skill-safety-"));
    const sourceDir = path.join(tmpDir, "source");
    const userSkillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "---\nname: accepted-risk-skill\n---\n# Risky\n", "utf-8");
    (callText as any).mockResolvedValue("suspicious: broad trigger");
    const onInstalled = vi.fn();
    const tool = createInstallSkillTool({
      getUserSkillsDir: () => userSkillsDir,
      getConfig: () => ({
        capabilities: { learn_skills: { enabled: true, safety_review: true } },
      }),
      resolveUtilityConfig: () => ({
        utility: "utility-model",
        api_key: "key",
        base_url: "https://example.test",
        api: "openai",
      }),
      onInstalled,
      registerSessionFile: vi.fn(),
    });

    const first = await tool.execute("call-1", {
      local_path: sourceDir,
      reason: "user should confirm risk",
    }, null, null, {});
    const token = (first as any).details.riskConfirmationToken;

    const result = await tool.execute("call-2", {
      local_path: sourceDir,
      reason: "user confirmed risk",
      risk_accepted: true,
      risk_confirmation_token: token,
    }, null, null, {});

    expect((result as any).details).toMatchObject({
      skillName: "accepted-risk-skill",
      source: "local_path",
      safetyReview: false,
      riskOverride: true,
      riskReason: "broad trigger",
    });
    expect(fs.existsSync(path.join(userSkillsDir, "accepted-risk-skill", "SKILL.md"))).toBe(true);
    expect(onInstalled).toHaveBeenCalledWith("accepted-risk-skill");
    expect(callText).toHaveBeenCalledTimes(2);
  });
});
