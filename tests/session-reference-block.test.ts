import { describe, expect, it } from "vitest";
import { EnvChangeLedger } from "../core/env-change-ledger.ts";
import {
  applyReminderConsumption,
  collectReminderBlock,
  REFERENCE_BLOCK_END,
  REFERENCE_BLOCK_PREFIX,
  renderReferenceBlock,
  resolveReferenceBudgetTokens,
  stripSessionReminderBlocks,
} from "../core/session-reminders.ts";
import { createToolCatalog } from "../core/tool-catalog.ts";
import { diffCatalogNames, formatCatalogChangeLines } from "../core/tool-catalog.ts";

describe("reference block budget", () => {
  it("uses five percent of the context window", () => {
    expect(resolveReferenceBudgetTokens(200_000)).toBe(10_000);
    expect(resolveReferenceBudgetTokens(100_000)).toBe(5_000);
  });

  it("caps at twenty thousand tokens however large the window", () => {
    expect(resolveReferenceBudgetTokens(2_000_000)).toBe(20_000);
  });

  it("falls back to a small budget for an unknown window", () => {
    expect(resolveReferenceBudgetTokens(undefined as any)).toBeGreaterThan(0);
    expect(resolveReferenceBudgetTokens(0)).toBeGreaterThan(0);
  });
});

describe("reference block rendering", () => {
  it("carries text far longer than the broadcast character limit", () => {
    const body = Array.from({ length: 120 }, (_, index) => `- tool_${index} — does something useful`).join("\n");
    expect(body.length).toBeGreaterThan(2000);
    const rendered = renderReferenceBlock({ text: body, budgetTokens: 20_000 });
    expect(rendered).toContain("tool_0");
    expect(rendered).toContain("tool_119");
    expect(rendered).not.toContain("…");
  });

  it("wraps the body in a reference envelope", () => {
    const rendered = renderReferenceBlock({ text: "hello", budgetTokens: 100 });
    expect(rendered.startsWith(REFERENCE_BLOCK_PREFIX)).toBe(true);
    expect(rendered.trimEnd().endsWith(REFERENCE_BLOCK_END)).toBe(true);
  });

  it("returns an empty string for empty text", () => {
    expect(renderReferenceBlock({ text: "", budgetTokens: 100 })).toBe("");
    expect(renderReferenceBlock({ text: "   ", budgetTokens: 100 })).toBe("");
  });

  it("truncates only when the body exceeds its own budget", () => {
    const body = "x".repeat(8000);
    const rendered = renderReferenceBlock({ text: body, budgetTokens: 100 });
    expect(rendered.length).toBeLessThan(body.length);
    expect(rendered).toContain("…");
  });

  it("is removed from user visible text", () => {
    const rendered = renderReferenceBlock({ text: "internal catalog listing", budgetTokens: 500 });
    const message = `${rendered}\n\nWhat can you do?`;
    expect(stripSessionReminderBlocks(message)).toBe("What can you do?");
  });

  it("removes a truncated reference block through end of text", () => {
    const message = `${REFERENCE_BLOCK_PREFIX}\nhalf a listing`;
    expect(stripSessionReminderBlocks(message)).toBe("");
  });
});

describe("catalog change broadcasts", () => {
  function catalogWith(names: string[]) {
    const catalog = createToolCatalog();
    catalog.registerSource("mcp", names.map((name) => ({
      name,
      serverId: "github",
      serverLabel: "GitHub",
      description: "d",
      schemaRef: () => ({}),
    })));
    return catalog;
  }

  it("reports added and removed tools against a previous snapshot", () => {
    const before = catalogWith(["a_one", "a_two"]).names();
    const after = catalogWith(["a_two", "a_three"]).names();
    const diff = diffCatalogNames(before, after);
    expect(diff.added).toEqual(["a_three"]);
    expect(diff.removed).toEqual(["a_one"]);
  });

  it("produces no lines when nothing changed", () => {
    const names = catalogWith(["a_one"]).names();
    const diff = diffCatalogNames(names, names);
    expect(formatCatalogChangeLines(diff, true)).toEqual([]);
  });

  it("formats a readable broadcast line", () => {
    const diff = diffCatalogNames(["a_one"], ["a_two"]);
    const lines = formatCatalogChangeLines(diff, true);
    expect(lines.join("\n")).toContain("a_two");
    expect(lines.join("\n")).toContain("a_one");
  });
});

describe("manifest delivery through the reminder channel", () => {
  function entry(overrides: Record<string, unknown> = {}) {
    return {
      reminderEnvCursor: 0,
      reminderEnvStartSeq: 0,
      reminderCompactionRevision: 0,
      reminderConsumedCompactionRevision: 0,
      reminderAcceptedUnavailableToolNames: [],
      reminderUnavailableRevision: 0,
      ...overrides,
    };
  }

  function collect(sessionEntry: any, referenceText: string) {
    return collectReminderBlock({
      sessionEntry,
      ledger: new EnvChangeLedger(),
      recipientAgentId: "focus",
      isZh: true,
      referenceText,
      referenceBudgetTokens: 20000,
    });
  }

  it("delivers the listing once and never again", () => {
    const sessionEntry = entry();
    const first = collect(sessionEntry, "github_create_issue — create an issue");
    expect(first?.block).toContain("github_create_issue");
    applyReminderConsumption({ sessionEntry, receipt: first!.receipt });

    expect(collect(sessionEntry, "github_create_issue — create an issue")).toBeNull();
  });

  it("does not inject anything when there is no listing", () => {
    expect(collect(entry(), "")).toBeNull();
  });

  it("carries a listing far beyond the broadcast character limit intact", () => {
    const listing = Array.from({ length: 100 }, (_, i) => `- tool_${i} — description ${i}`).join("\n");
    const rendered = collect(entry(), listing);
    expect(rendered?.block).toContain("tool_0");
    expect(rendered?.block).toContain("tool_99");
  });

  it("appends a later broadcast without restating the listing", () => {
    const sessionEntry = entry();
    const first = collect(sessionEntry, "the listing");
    applyReminderConsumption({ sessionEntry, receipt: first!.receipt });

    const later = collectReminderBlock({
      sessionEntry,
      ledger: new EnvChangeLedger(),
      recipientAgentId: "focus",
      isZh: true,
      referenceText: "the listing",
      referenceBudgetTokens: 20000,
      unavailableToolNames: ["mcp_github_gone"],
    });
    expect(later?.block).toContain("mcp_github_gone");
    expect(later?.block).not.toContain("the listing");
  });
});
