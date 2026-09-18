/**
 * Session titles are generated from the first user message, which by then
 * carries model-only envelopes (reminder broadcasts, reference listings,
 * attachment and session-file markers). The title must be built from what the
 * user actually typed, both for the summarizer prompt and for the fallback
 * used when no summarizer model is configured.
 */
import { describe, expect, it, vi } from "vitest";

import { generateSessionTitle } from "../server/routes/chat.ts";
import { visiblePromptText } from "../core/session-reminders.ts";

const REFERENCE_BLOCK = [
  "[hana_reference]",
  "yuque (4 tools)",
  "- yuque_search: search the knowledge base",
  "[/hana_reference]",
].join("\n");

const REMINDER_BLOCK = [
  "[hana_reminder]",
  "- New memory facts recorded: the user prefers dark mode",
  "[/hana_reminder]",
].join("\n");

const SESSION_FILE_MARKER =
  '[SessionFile] {"fileId":"sf-1","sessionPath":"/tmp/main.jsonl","label":"note.txt","kind":"attachment"}';

function envelopedPrompt(body: string) {
  return [
    REFERENCE_BLOCK,
    "",
    REMINDER_BLOCK,
    "",
    "[attached_image: /tmp/a.png]",
    SESSION_FILE_MARKER,
    body,
  ].join("\n");
}

function makeEngine({
  userText,
  assistantText = "here is the answer",
  summarized = "a title",
}: {
  userText: string;
  assistantText?: string;
  summarized?: string | null;
}) {
  return {
    listSessions: vi.fn(async () => []),
    getSessionByPath: vi.fn(() => ({
      messages: [
        { role: "user", content: [{ type: "text", text: userText }] },
        { role: "assistant", content: [{ type: "text", text: assistantText }] },
      ],
    })),
    summarizeTitle: vi.fn(async (_userText: string, _assistantText: string) => summarized),
    saveSessionTitle: vi.fn(async (_sessionPath: string, _title: string) => {}),
  };
}

describe("visiblePromptText", () => {
  it("removes reminder, reference, attachment and session-file envelopes", () => {
    expect(visiblePromptText(envelopedPrompt("帮我看看这张图"))).toBe("帮我看看这张图");
  });

  it("keeps ordinary text untouched", () => {
    expect(visiblePromptText("hello\nworld")).toBe("hello\nworld");
  });

  it("drops an unterminated reference block through end of text", () => {
    expect(visiblePromptText("[hana_reference]\nyuque (4 tools)\nnever closed")).toBe("");
  });

  it("still recognizes the historical timestamped reminder header", () => {
    expect(visiblePromptText([
      "[hana_reminder at 2026-07-01 09:30]",
      "- context was compacted",
      "[/hana_reminder]",
      "",
      "写个周报",
    ].join("\n"))).toBe("写个周报");
  });

  it("returns an empty string for whitespace-only and non-string input", () => {
    expect(visiblePromptText("   \n\n  ")).toBe("");
    expect(visiblePromptText(null as any)).toBe("");
  });

  it("returns an empty string when only envelopes are present", () => {
    expect(visiblePromptText(envelopedPrompt(""))).toBe("");
  });
});

describe("generateSessionTitle input hygiene", () => {
  it("summarizes the typed text rather than the injected envelopes", async () => {
    const engine = makeEngine({ userText: envelopedPrompt("帮我看看这张图") });
    const notify = vi.fn();

    const ok = await generateSessionTitle(engine, notify, { sessionPath: "/tmp/main.jsonl" });

    expect(ok).toBe(true);
    expect(engine.summarizeTitle).toHaveBeenCalledTimes(1);
    expect(engine.summarizeTitle.mock.calls[0]?.[0]).toBe("帮我看看这张图");
    expect(engine.saveSessionTitle).toHaveBeenCalledWith("/tmp/main.jsonl", "a title");
  });

  it("falls back to the typed text, not the envelope literal, when no title comes back", async () => {
    const engine = makeEngine({
      userText: envelopedPrompt("帮我把这份周报整理成三段，重点放在下周计划"),
      summarized: null,
    });

    const ok = await generateSessionTitle(engine, vi.fn(), { sessionPath: "/tmp/main.jsonl" });

    expect(ok).toBe(true);
    const savedTitle = String(engine.saveSessionTitle.mock.calls[0]?.[1]);
    expect(savedTitle).toBe("帮我把这份周报整理成三段，重点放在下周计划".slice(0, 30));
    expect(savedTitle.startsWith("[")).toBe(false);
  });

  it("skips title generation when the message is envelopes and attachments only", async () => {
    const engine = makeEngine({ userText: envelopedPrompt("") });
    const notify = vi.fn();

    const ok = await generateSessionTitle(engine, notify, { sessionPath: "/tmp/main.jsonl" });

    expect(ok).toBe(false);
    expect(engine.summarizeTitle).not.toHaveBeenCalled();
    expect(engine.saveSessionTitle).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
