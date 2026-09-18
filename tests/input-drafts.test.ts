import { describe, expect, it } from "vitest";
import {
  HOME_DRAFT_KEY,
  INPUT_DRAFT_MAX_ENTRY_CHARS,
  INPUT_DRAFT_MAX_SESSIONS_PER_SURFACE,
  INPUT_DRAFT_SURFACES,
  normalizeInputDraftEntry,
  normalizeInputDraftSurface,
  normalizeInputDraftsFile,
  upsertSurfaceSessionDrafts,
} from "../shared/input-drafts.ts";

describe("input drafts shared normalization", () => {
  it("exposes surface whitelist and home key", () => {
    expect(INPUT_DRAFT_SURFACES).toEqual(["electron", "pwa"]);
    expect(HOME_DRAFT_KEY).toBe("__home__");
  });

  it("normalizes surface and rejects unknown values", () => {
    expect(normalizeInputDraftSurface("electron")).toBe("electron");
    expect(normalizeInputDraftSurface("pwa")).toBe("pwa");
    expect(normalizeInputDraftSurface("bridge")).toBeNull();
    expect(normalizeInputDraftSurface("")).toBeNull();
    expect(normalizeInputDraftSurface(undefined)).toBeNull();
  });

  it("treats empty/blank text as deletion (null entry)", () => {
    expect(normalizeInputDraftEntry({ text: "" })).toBeNull();
    expect(normalizeInputDraftEntry({ text: "   " })).toBeNull();
    expect(normalizeInputDraftEntry(null)).toBeNull();
    expect(normalizeInputDraftEntry({ text: 42 })).toBeNull();
  });

  it("keeps text, plain-object doc and updatedAt", () => {
    const entry = normalizeInputDraftEntry({ text: "hi", doc: { type: "doc" }, updatedAt: 123 });
    expect(entry).toEqual({ text: "hi", doc: { type: "doc" }, updatedAt: 123 });
    const noDoc = normalizeInputDraftEntry({ text: "hi", doc: ["not-a-doc"] });
    expect(noDoc?.doc).toBeUndefined();
    expect(typeof normalizeInputDraftEntry({ text: "hi" })?.updatedAt).toBe("number");
  });

  it("drops doc first when entry exceeds size cap, then truncates text", () => {
    const bigDoc = { type: "doc", blob: "x".repeat(INPUT_DRAFT_MAX_ENTRY_CHARS) };
    const dropped = normalizeInputDraftEntry({ text: "short", doc: bigDoc, updatedAt: 1 });
    expect(dropped).toEqual({ text: "short", updatedAt: 1 });

    const hugeText = "y".repeat(INPUT_DRAFT_MAX_ENTRY_CHARS + 1000);
    const truncated = normalizeInputDraftEntry({ text: hugeText, updatedAt: 1 });
    expect(truncated?.text.length).toBeLessThanOrEqual(INPUT_DRAFT_MAX_ENTRY_CHARS);
    expect(truncated?.text.startsWith("yyy")).toBe(true);
  });

  it("upserts session drafts with LRU eviction by updatedAt", () => {
    let sessions: Record<string, any> = {};
    for (let i = 0; i < INPUT_DRAFT_MAX_SESSIONS_PER_SURFACE; i++) {
      sessions = upsertSurfaceSessionDrafts(sessions, `s${i}`, { text: "t", updatedAt: i + 1 });
    }
    expect(Object.keys(sessions)).toHaveLength(INPUT_DRAFT_MAX_SESSIONS_PER_SURFACE);
    sessions = upsertSurfaceSessionDrafts(sessions, "newest", { text: "t", updatedAt: 10_000 });
    expect(Object.keys(sessions)).toHaveLength(INPUT_DRAFT_MAX_SESSIONS_PER_SURFACE);
    expect(sessions.s0).toBeUndefined();
    expect(sessions.newest).toBeDefined();
  });

  it("deletes entry when upserting null", () => {
    let sessions = upsertSurfaceSessionDrafts({}, "a", { text: "t", updatedAt: 1 });
    sessions = upsertSurfaceSessionDrafts(sessions, "a", null);
    expect(sessions.a).toBeUndefined();
  });

  it("normalizes a whole file shape, dropping junk", () => {
    const file = normalizeInputDraftsFile({
      surfaces: {
        electron: {
          home: { text: "draft" },
          sessions: { good: { text: "x", updatedAt: 1 }, bad: { text: "" }, "": { text: "y" } },
        },
        bogusSurface: { home: { text: "ignored" } },
      },
    });
    expect(file.version).toBe(1);
    expect(Object.keys(file.surfaces).sort()).toEqual(["electron", "pwa"]);
    expect(file.surfaces.electron.home?.text).toBe("draft");
    expect(Object.keys(file.surfaces.electron.sessions)).toEqual(["good"]);
    expect(file.surfaces.pwa).toEqual({ home: null, sessions: {} });
    expect(normalizeInputDraftsFile(null).surfaces.electron).toEqual({ home: null, sessions: {} });
  });
});
