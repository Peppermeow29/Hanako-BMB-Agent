import { describe, expect, it, vi } from "vitest";
import { createApprovalGateway, createModelApprovalReviewer } from "../lib/approval-gateway.ts";

const reviewerLogMocks = vi.hoisted(() => ({
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../lib/debug-log.ts", () => ({
  createModuleLogger: () => reviewerLogMocks,
}));

function request(overrides = {}) {
  return {
    id: "approval-1",
    kind: "tool_action",
    sessionPath: "/tmp/hana/session.jsonl",
    agentId: "hana",
    toolName: "write",
    actionName: "execute",
    params: { path: "notes.md" },
    target: { type: "file", label: "notes.md" },
    blastRadius: "workspace",
    reversibility: "easy",
    ...overrides,
  };
}

describe("ApprovalGateway", () => {
  it("falls back when asked to review ordinary git push without a reviewer", async () => {
    const gateway = createApprovalGateway();

    const decision = await gateway.review(request({
      toolName: "bash",
      params: { command: "git push origin main" },
      target: { type: "command", label: "git push origin main" },
      blastRadius: "external",
      reversibility: "hard",
    }));

    expect(decision).toMatchObject({
      action: "ask_user",
      reviewer: "policy",
      risk: "medium",
    });
    expect(decision.reason).toContain("reviewer unavailable");
  });

  it("lets reviewer policy evaluate ordinary git push when the caller asks for review", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({ action: "allow", reason: "caller safety already checked", risk: "low" }));
    const gateway = createApprovalGateway({ smallToolModelReviewer });

    await expect(gateway.review(request({
      toolName: "bash",
      params: { command: "git -C /repo push origin main" },
      target: { type: "command", label: "git -C /repo push origin main" },
    }))).resolves.toMatchObject({
      action: "allow",
      reviewer: "small_tool_model",
      reason: "caller safety already checked",
    });

    expect(smallToolModelReviewer).toHaveBeenCalledOnce();
  });

  it("does not hard-deny unrelated commands that happen to use --force", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({ action: "allow", reason: "not a git push", risk: "low" }));
    const gateway = createApprovalGateway({ smallToolModelReviewer });

    const decision = await gateway.review(request({
      toolName: "bash",
      params: { command: "npm install left-pad@1.3.0 --force" },
      target: { type: "command", label: "npm install left-pad@1.3.0 --force" },
    }));

    expect(decision).toMatchObject({
      action: "allow",
      reviewer: "small_tool_model",
      reason: "not a git push",
    });
    expect(smallToolModelReviewer).toHaveBeenCalledOnce();
  });

  it("uses the small tool-model reviewer for ordinary gray-area approvals", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({
      action: "allow",
      reason: "workspace edit is in scope",
      risk: "low",
    }));
    const gateway = createApprovalGateway({ smallToolModelReviewer });

    const decision = await gateway.review(request());

    expect(smallToolModelReviewer).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ id: "approval-1" }) }),
    );
    expect(decision).toMatchObject({
      action: "allow",
      reviewer: "small_tool_model",
      reason: "workspace edit is in scope",
      risk: "low",
    });
  });

  it("lets the large tool-model reviewer approve when the small reviewer would ask the user", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({
      action: "ask_user",
      reason: "small reviewer is unsure about the target",
      risk: "medium",
    }));
    const largeToolModelReviewer = vi.fn(async () => ({
      action: "allow",
      reason: "target and intent are specific enough",
      risk: "medium",
    }));
    const gateway = createApprovalGateway({ smallToolModelReviewer, largeToolModelReviewer });

    const decision = await gateway.review(request());

    expect(smallToolModelReviewer).toHaveBeenCalledOnce();
    expect(largeToolModelReviewer).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({
      action: "allow",
      reviewer: "large_tool_model",
      reason: "target and intent are specific enough",
      risk: "medium",
    });
  });

  it("lets the large tool-model reviewer approve when the small reviewer would deny and continue", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({
      action: "deny_and_continue",
      reason: "small reviewer prefers a safer path",
      risk: "medium",
    }));
    const largeToolModelReviewer = vi.fn(async () => ({
      action: "allow",
      reason: "bounded workspace edit is acceptable",
      risk: "medium",
    }));
    const gateway = createApprovalGateway({ smallToolModelReviewer, largeToolModelReviewer });

    const decision = await gateway.review(request());

    expect(smallToolModelReviewer).toHaveBeenCalledOnce();
    expect(largeToolModelReviewer).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({
      action: "allow",
      reviewer: "large_tool_model",
      reason: "bounded workspace edit is acceptable",
      risk: "medium",
    });
  });

  it("escalates from the small tool-model reviewer to the large tool-model reviewer", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({
      action: "escalate",
      reason: "needs blast-radius review",
    }));
    const largeToolModelReviewer = vi.fn(async () => ({
      action: "ask_user",
      reason: "folder access is too broad",
      risk: "high",
    }));
    const gateway = createApprovalGateway({ smallToolModelReviewer, largeToolModelReviewer });

    const decision = await gateway.review(request({
      kind: "session_folder",
      params: { action: "add", folder: "/Users/test/Desktop" },
      target: { type: "directory", label: "/Users/test/Desktop", path: "/Users/test/Desktop" },
      blastRadius: "device",
      reversibility: "moderate",
    }));

    expect(smallToolModelReviewer).toHaveBeenCalledOnce();
    expect(largeToolModelReviewer).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({
      action: "ask_user",
      reviewer: "large_tool_model",
      reason: "folder access is too broad",
      risk: "high",
    });
  });

  it("allows automation create and update draft generation by policy", async () => {
    const smallToolModelReviewer = vi.fn(async () => ({ action: "ask_user", reason: "should not be called" }));
    const gateway = createApprovalGateway({ smallToolModelReviewer });

    await expect(gateway.review(request({
      toolName: "automation",
      actionName: "create",
      params: {
        action: "create",
        scheduleType: "cron",
        schedule: "0 9 * * *",
        label: "Morning Review",
        prompt: "Review my notes.",
      },
      target: { type: "tool", label: "Morning Review" },
      sideEffect: {
        kind: "deferred_mutation_draft",
        commit: "requires_user_confirmation",
        summary: "Automation draft writes only after the card is confirmed.",
      },
    }))).resolves.toMatchObject({
      action: "allow",
      reviewer: "policy",
      risk: "low",
      ruleIds: ["automation-draft-no-write"],
    });

    await expect(gateway.review(request({
      toolName: "automation",
      actionName: "update",
      params: {
        action: "update",
        id: "studio_job_1",
        scheduleType: "cron",
        schedule: "0 10 * * *",
      },
      target: { type: "tool", label: "automation" },
      sideEffect: {
        kind: "deferred_mutation_draft",
        commit: "requires_user_confirmation",
        summary: "Automation draft writes only after the card is confirmed.",
      },
    }))).resolves.toMatchObject({
      action: "allow",
      reviewer: "policy",
      risk: "low",
      ruleIds: ["automation-draft-no-write"],
    });

    expect(smallToolModelReviewer).not.toHaveBeenCalled();
  });

  it("fails closed to ask_user when no reviewer can decide", async () => {
    const gateway = createApprovalGateway();

    const decision = await gateway.review(request());

    expect(decision).toMatchObject({
      action: "ask_user",
      reviewer: "policy",
      risk: "medium",
    });
    expect(decision.reason).toContain("reviewer unavailable");
  });

  it.each([
    ["empty response", ""],
    ["invalid JSON", "SECRET_INVALID_JSON"],
    ["invalid action", JSON.stringify({ action: "approve", reason: "SECRET_INVALID_ACTION" })],
  ])("retries one recoverable %s once without echoing the raw output", async (_label, firstResponse) => {
    const resolveUtilityConfig = vi.fn(async () => ({
      utility: { id: "small-reviewer", provider: "test" },
      api: "openai-completions",
      api_key: "test-key",
      base_url: "https://example.test",
    }));
    const callText = vi.fn()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(JSON.stringify({
        action: "allow",
        reason: "workspace edit matches the request",
        risk: "low",
      }));
    const reviewer = createModelApprovalReviewer({ resolveUtilityConfig, callText });

    const result = await reviewer({ request: request() });

    expect(result).toMatchObject({
      kind: "decision",
      attempts: 2,
      decision: {
        action: "allow",
        reason: "workspace edit matches the request",
        risk: "low",
      },
    });
    expect(callText).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(callText.mock.calls[1]?.[0])).not.toContain("SECRET_");
  });

  it("returns a static config failure without calling the reviewer network boundary", async () => {
    const callText = vi.fn();
    const reviewer = createModelApprovalReviewer({
      resolveUtilityConfig: vi.fn(async () => ({
        utility: null,
        api: "",
        base_url: "",
      })),
      callText,
    });

    await expect(reviewer({ request: request() })).resolves.toEqual({
      kind: "failure",
      reasonCode: "reviewer_config_missing",
      attempts: 0,
    });
    expect(callText).not.toHaveBeenCalled();
  });

  it("retries the structured LLM_EMPTY_RESPONSE failure once without exposing its message", async () => {
    const emptyResponse = Object.assign(new Error("SECRET empty response details"), {
      code: "LLM_EMPTY_RESPONSE",
    });
    const callText = vi.fn()
      .mockRejectedValueOnce(emptyResponse)
      .mockResolvedValueOnce(JSON.stringify({
        action: "allow",
        reason: "retry produced a valid decision",
        risk: "low",
      }));
    const reviewer = createModelApprovalReviewer({
      resolveUtilityConfig: vi.fn(async () => ({
        utility: { id: "small-reviewer", provider: "test" },
        api: "openai-completions",
        api_key: "test-key",
        base_url: "https://example.test",
      })),
      callText,
    });

    const result = await reviewer({ request: request() });

    expect(result).toMatchObject({
      kind: "decision",
      attempts: 2,
      decision: { action: "allow", risk: "low" },
    });
    expect(callText).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(callText.mock.calls[1]?.[0])).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("does not retry timeout failures or expose their raw error message", async () => {
    const timeout = Object.assign(new Error("SECRET provider timeout at https://private.example"), {
      code: "LLM_TIMEOUT",
    });
    const callText = vi.fn(async () => { throw timeout; });
    const reviewer = createModelApprovalReviewer({
      resolveUtilityConfig: vi.fn(async () => ({
        utility: { id: "small-reviewer", provider: "test" },
        api: "openai-completions",
        api_key: "test-key",
        base_url: "https://example.test",
      })),
      callText,
    });

    const result = await reviewer({ request: request() });

    expect(result).toEqual({
      kind: "failure",
      reasonCode: "reviewer_timeout",
      errorCode: "LLM_TIMEOUT",
      attempts: 1,
    });
    expect(callText).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("private.example");
  });

  it("keeps both reviewer failures when neither reviewer produces a decision", async () => {
    reviewerLogMocks.warn.mockClear();
    const smallToolModelReviewer = vi.fn(async () => "SECRET_SMALL_INVALID_JSON");
    const largeToolModelReviewer = vi.fn(async () => ({ action: "approve", reason: "SECRET_LARGE_INVALID_ACTION" }));
    const gateway = createApprovalGateway({ smallToolModelReviewer, largeToolModelReviewer });

    const decision = await gateway.review(request());

    expect(decision).toMatchObject({
      action: "ask_user",
      reviewer: "policy",
      reasonCode: "approval_review_failed",
      reviewerFailures: [
        { reviewer: "small_tool_model", reasonCode: "reviewer_invalid_json", attempts: 2 },
        { reviewer: "large_tool_model", reasonCode: "reviewer_invalid_action", attempts: 2 },
      ],
    });
    expect(smallToolModelReviewer).toHaveBeenCalledTimes(2);
    expect(largeToolModelReviewer).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(decision)).not.toContain("SECRET");
    expect(reviewerLogMocks.warn).toHaveBeenCalledWith(expect.stringContaining("reasonCode=reviewer_invalid_json"));
    expect(reviewerLogMocks.warn).toHaveBeenCalledWith(expect.stringContaining("reasonCode=reviewer_invalid_action"));
    expect(JSON.stringify(reviewerLogMocks.warn.mock.calls)).not.toContain("SECRET");
  });

  it("keeps small config and large timeout failures without exposing raw errors", async () => {
    reviewerLogMocks.warn.mockClear();
    const smallToolModelReviewer = vi.fn(async () => ({
      kind: "failure",
      reasonCode: "reviewer_config_missing",
      attempts: 0,
    }));
    const timeout = Object.assign(
      new Error("SECRET_TIMEOUT at https://private.example/reviewer"),
      { code: "LLM_TIMEOUT" },
    );
    const largeToolModelReviewer = vi.fn(async () => { throw timeout; });
    const gateway = createApprovalGateway({ smallToolModelReviewer, largeToolModelReviewer });

    const decision = await gateway.review(request());

    expect(decision).toMatchObject({
      action: "ask_user",
      reviewer: "policy",
      reasonCode: "approval_review_failed",
      reviewerFailures: [
        {
          reviewer: "small_tool_model",
          reasonCode: "reviewer_config_missing",
          attempts: 0,
        },
        {
          reviewer: "large_tool_model",
          reasonCode: "reviewer_timeout",
          errorCode: "LLM_TIMEOUT",
          attempts: 1,
        },
      ],
    });
    expect(largeToolModelReviewer).toHaveBeenCalledOnce();
    expect(JSON.stringify(decision)).not.toContain("SECRET_TIMEOUT");
    expect(JSON.stringify(decision)).not.toContain("private.example");
    expect(reviewerLogMocks.warn).toHaveBeenCalledWith(expect.stringContaining("reasonCode=reviewer_config_missing"));
    expect(reviewerLogMocks.warn).toHaveBeenCalledWith(expect.stringContaining("reasonCode=reviewer_timeout"));
    expect(JSON.stringify(reviewerLogMocks.warn.mock.calls)).not.toContain("SECRET_TIMEOUT");
    expect(JSON.stringify(reviewerLogMocks.warn.mock.calls)).not.toContain("private.example");
  });

  it("normalizes and bounds a valid reviewer reason before returning it", async () => {
    const longReason = `line one\nline two\t${"x".repeat(400)}`;
    const smallToolModelReviewer = vi.fn(async () => ({
      action: "allow",
      reason: longReason,
      risk: "low",
    }));
    const gateway = createApprovalGateway({ smallToolModelReviewer });

    const decision = await gateway.review(request());

    expect(decision.reason).toContain("line one line two ");
    expect(decision.reason).not.toMatch(/[\r\n\t]/);
    expect(decision.reason).toHaveLength(240);
  });

  it("keeps a small reviewer failure when the large reviewer makes the final decision", async () => {
    reviewerLogMocks.warn.mockClear();
    const smallToolModelReviewer = vi.fn(async () => "not-json");
    const largeToolModelReviewer = vi.fn(async () => ({
      action: "allow",
      reason: "large reviewer verified the bounded action",
      risk: "medium",
    }));
    const gateway = createApprovalGateway({ smallToolModelReviewer, largeToolModelReviewer });

    const decision = await gateway.review(request());

    expect(decision).toMatchObject({
      action: "allow",
      reviewer: "large_tool_model",
      reasonCode: "reviewer_allowed",
      reviewerFailures: [
        { reviewer: "small_tool_model", reasonCode: "reviewer_invalid_json", attempts: 2 },
      ],
    });
    expect(largeToolModelReviewer).toHaveBeenCalledOnce();
  });

  it("does not fall back to a non-low small allow when the large reviewer fails", async () => {
    reviewerLogMocks.warn.mockClear();
    const smallToolModelReviewer = vi.fn(async () => ({
      action: "allow",
      reason: "small reviewer sees bounded risk",
      risk: "medium",
    }));
    const largeToolModelReviewer = vi.fn(async () => ({ action: "escalate" }));
    const gateway = createApprovalGateway({ smallToolModelReviewer, largeToolModelReviewer });

    const decision = await gateway.review(request());

    expect(decision).toMatchObject({
      action: "ask_user",
      reviewer: "policy",
      reasonCode: "approval_review_failed",
      reviewerFailures: [
        { reviewer: "large_tool_model", reasonCode: "reviewer_invalid_action", attempts: 2 },
      ],
    });
    expect(largeToolModelReviewer).toHaveBeenCalledTimes(2);
  });

  it("can fall back to a conservative small decision when the large reviewer fails", async () => {
    reviewerLogMocks.warn.mockClear();
    const smallToolModelReviewer = vi.fn(async () => ({
      action: "deny_and_continue",
      reason: "use a safer local path",
      risk: "medium",
    }));
    const timeout = Object.assign(new Error("SECRET large timeout"), { code: "LLM_TIMEOUT" });
    const largeToolModelReviewer = vi.fn(async () => { throw timeout; });
    const gateway = createApprovalGateway({ smallToolModelReviewer, largeToolModelReviewer });

    const decision = await gateway.review(request());

    expect(decision).toMatchObject({
      action: "deny_and_continue",
      reviewer: "small_tool_model",
      reasonCode: "reviewer_denied",
      reviewerFailures: [
        {
          reviewer: "large_tool_model",
          reasonCode: "reviewer_timeout",
          errorCode: "LLM_TIMEOUT",
          attempts: 1,
        },
      ],
    });
    expect(largeToolModelReviewer).toHaveBeenCalledOnce();
    expect(JSON.stringify(decision)).not.toContain("SECRET");
  });

  it("builds a utility-model reviewer that returns a normalized JSON decision", async () => {
    const resolveUtilityConfig = vi.fn(async () => ({
      utility: { id: "small-reviewer", provider: "test" },
      api: "openai-completions",
      api_key: "test-key",
      base_url: "https://example.test",
      headers: { "x-provider-contract": "approval" },
    }));
    const callText = vi.fn(async () => JSON.stringify({
      action: "allow",
      reason: "workspace edit matches the user request",
      risk: "low",
    }));
    const reviewer = createModelApprovalReviewer({
      role: "utility",
      resolveUtilityConfig,
      callText,
    });

    const decision = await reviewer({
      request: request(),
      userIntentSummary: "Edit notes.md",
      explicitUserAuthorization: "",
      sessionPermissionMode: "auto",
      trustEnvironment: { cwd: "/tmp/hana", workspaceFolders: ["/tmp/hana"] },
      recentApprovalHistory: [],
    });

    expect(resolveUtilityConfig).toHaveBeenCalledOnce();
    expect(callText).toHaveBeenCalledWith(expect.objectContaining({
      api: "openai-completions",
      apiKey: "test-key",
      baseUrl: "https://example.test",
      model: { id: "small-reviewer", provider: "test" },
      headers: { "x-provider-contract": "approval" },
      maxTokens: 220,
      temperature: 0,
    }));
    expect(decision).toMatchObject({
      kind: "decision",
      attempts: 1,
      decision: {
        action: "allow",
        reason: "workspace edit matches the user request",
        risk: "low",
      },
    });
  });

  it("does not call the reviewer network boundary when fresh utility resolution fails", async () => {
    const callText = vi.fn();
    const reviewer = createModelApprovalReviewer({
      resolveUtilityConfig: vi.fn(async () => { throw new Error("oauth refresh failed"); }),
      callText,
    });

    await expect(reviewer({ request: request() })).resolves.toEqual({
      kind: "failure",
      reasonCode: "reviewer_config_unavailable",
      attempts: 0,
    });
    expect(callText).not.toHaveBeenCalled();
  });
});
