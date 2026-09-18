import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCoordinator } from "../core/session-coordinator.ts";
import { EnvChangeLedger } from "../core/env-change-ledger.ts";
import { REFERENCE_BLOCK_PREFIX } from "../core/session-reminders.ts";

const MANIFEST_TEXT = "GitHub（2）\n- github_create_issue — Create an issue.\n- github_list_issues — List issues.";

function makeCoordinator({ liveCatalogNames = null }: { liveCatalogNames?: string[] | null } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-manifest-delivery-"));
  const coordinator = new SessionCoordinator({
    agentsDir: path.join(tempDir, "agents"),
    getAgent: () => ({ id: "hana", agentDir: path.join(tempDir, "agents", "hana"), config: {}, tools: [] }),
    getActiveAgentId: () => "hana",
    getModels: () => ({
      currentModel: { name: "test-model" },
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: () => "medium",
    }),
    getResourceLoader: () => ({}),
    getSkills: () => null,
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: () => {},
    getHomeCwd: () => tempDir,
    agentIdFromSessionPath: () => "hana",
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: () => null,
    listAgents: () => [],
    getLiveToolCatalogNames: () => liveCatalogNames,
  } as any);
  coordinator._envChangeLedger = new EnvChangeLedger();
  return { coordinator, tempDir };
}

function seedEntry(coordinator: any, sessionPath: string, overrides: Record<string, unknown> = {}) {
  const entry: Record<string, any> = {
    session: {},
    agentId: "hana",
    toolNames: [],
    reminderEnvCursor: 0,
    reminderEnvStartSeq: 0,
    reminderCompactionRevision: 0,
    reminderConsumedCompactionRevision: 0,
    reminderAcceptedUnavailableToolNames: [],
    reminderUnavailableRevision: 0,
    ...overrides,
  };
  coordinator._sessions.set(sessionPath, entry);
  return entry;
}

function catalogSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    text: MANIFEST_TEXT,
    tier: 1,
    fingerprint: "sha256:catalog-v1",
    names: ["github_create_issue", "github_list_issues"],
    ...overrides,
  };
}

describe("catalog manifest delivery", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(entryOverrides: Record<string, unknown> = {}, coordinatorOptions: any = {}) {
    const { coordinator, tempDir } = makeCoordinator(coordinatorOptions);
    dirs.push(tempDir);
    const sessionPath = path.join(tempDir, "agents", "hana", "sessions", "main.jsonl");
    const entry = seedEntry(coordinator, sessionPath, entryOverrides);
    return { coordinator, sessionPath, entry };
  }

  it("delivers the listing in the first reminder of a catalog mode session", () => {
    const { coordinator, sessionPath } = setup({ toolCatalogManifest: catalogSnapshot() });
    const rendered = coordinator.renderSessionReminderBlock(sessionPath);
    expect(rendered?.block).toContain(REFERENCE_BLOCK_PREFIX);
    expect(rendered?.block).toContain("github_create_issue");
  });

  it("delivers the listing exactly once", () => {
    const { coordinator, sessionPath } = setup({ toolCatalogManifest: catalogSnapshot() });
    const first = coordinator.renderSessionReminderBlock(sessionPath);
    coordinator.consumeRenderedSessionReminderBlock(sessionPath, first.receipt);
    expect(coordinator.renderSessionReminderBlock(sessionPath)).toBeNull();
  });

  it("injects nothing for a session that is not in catalog mode", () => {
    const { coordinator, sessionPath } = setup({ toolCatalogManifest: null });
    expect(coordinator.renderSessionReminderBlock(sessionPath)).toBeNull();
  });

  it("leaves the receipt shape unchanged for a session that is not in catalog mode", () => {
    // A pending compaction gives a deterministic reminder without depending on
    // live tool availability.
    const { coordinator, sessionPath } = setup({
      toolCatalogManifest: null,
      reminderCompactionRevision: 1,
      reminderConsumedCompactionRevision: 0,
    });
    const rendered = coordinator.renderSessionReminderBlock(sessionPath);
    expect(rendered).toBeTruthy();
    expect(Object.keys(rendered!.receipt).sort()).toEqual([
      "baseUnavailableRevision",
      "compactionRevision",
      "consumeBlockState",
      "throughSeq",
      "unavailableToolNames",
    ]);
  });

  it("records the delivery on the entry so it can be carried across a sleep", () => {
    const { coordinator, sessionPath, entry } = setup({ toolCatalogManifest: catalogSnapshot() });
    const first = coordinator.renderSessionReminderBlock(sessionPath);
    coordinator.consumeRenderedSessionReminderBlock(sessionPath, first.receipt);
    expect(entry.reminderReferenceDelivered).toBe(true);
  });

  it("does not re-deliver to a session restored as already delivered", () => {
    // This is the state a woken or forked session carries in.
    const { coordinator, sessionPath } = setup({
      toolCatalogManifest: catalogSnapshot(),
      reminderReferenceDelivered: true,
    });
    expect(coordinator.renderSessionReminderBlock(sessionPath)).toBeNull();
  });
});

describe("catalog change broadcasts", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(liveCatalogNames: string[] | null, entryOverrides: Record<string, unknown> = {}) {
    const { coordinator, tempDir } = makeCoordinator({ liveCatalogNames });
    dirs.push(tempDir);
    const sessionPath = path.join(tempDir, "agents", "hana", "sessions", "main.jsonl");
    const entry = seedEntry(coordinator, sessionPath, {
      toolCatalogManifest: catalogSnapshot(),
      // The listing was already handed over, so only a change should surface.
      reminderReferenceDelivered: true,
      ...entryOverrides,
    });
    return { coordinator, sessionPath, entry };
  }

  it("tells the session when the live catalog gained and lost tools", () => {
    const { coordinator, sessionPath } = setup(["github_create_issue", "github_search_code"]);
    const rendered = coordinator.renderSessionReminderBlock(sessionPath);
    expect(rendered?.block).toContain("github_search_code");
    expect(rendered?.block).toContain("github_list_issues");
  });

  it("does not restate the listing when broadcasting a change", () => {
    const { coordinator, sessionPath } = setup(["github_create_issue", "github_search_code"]);
    const rendered = coordinator.renderSessionReminderBlock(sessionPath);
    expect(rendered?.block).not.toContain(REFERENCE_BLOCK_PREFIX);
    expect(rendered?.block).not.toContain("Create an issue.");
  });

  it("broadcasts the same change only once", () => {
    const { coordinator, sessionPath } = setup(["github_create_issue", "github_search_code"]);
    const first = coordinator.renderSessionReminderBlock(sessionPath);
    expect(first?.block).toContain("github_search_code");
    coordinator.consumeRenderedSessionReminderBlock(sessionPath, first!.receipt);
    expect(coordinator.renderSessionReminderBlock(sessionPath)).toBeNull();
  });

  it("says nothing while the live catalog still matches the session's listing", () => {
    const { coordinator, sessionPath } = setup(["github_create_issue", "github_list_issues"]);
    expect(coordinator.renderSessionReminderBlock(sessionPath)).toBeNull();
  });

  it("says nothing when the live catalog is unavailable", () => {
    const { coordinator, sessionPath } = setup(null);
    expect(coordinator.renderSessionReminderBlock(sessionPath)).toBeNull();
  });

  it("broadcasts a further change after the first was accepted", () => {
    const { coordinator, sessionPath, entry } = setup(["github_create_issue", "github_search_code"]);
    const first = coordinator.renderSessionReminderBlock(sessionPath);
    coordinator.consumeRenderedSessionReminderBlock(sessionPath, first!.receipt);

    (coordinator as any)._d.getLiveToolCatalogNames = () => ["github_create_issue", "github_new_tool"];
    const second = coordinator.renderSessionReminderBlock(sessionPath);
    expect(second?.block).toContain("github_new_tool");
    expect(entry.toolCatalogManifest).toBeTruthy();
  });
});
