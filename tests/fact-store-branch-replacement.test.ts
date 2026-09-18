import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactStore } from "../lib/memory/fact-store.ts";

describe("FactStore.replaceBySession", () => {
  let tmpDir: string;
  let store: FactStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-fact-replace-"));
    store = new FactStore(path.join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("atomically replaces one session while preserving other sessions and FTS", () => {
    store.add({ fact: "旧分支喜欢茉莉花茶", tags: ["旧分支"], session_id: "s1" });
    store.add({ fact: "另一个会话喜欢乌龙茶", tags: ["其他"], session_id: "s2" });

    expect(store.replaceBySession("s1", [
      { fact: "新分支喜欢红茶", tags: ["新分支"], time: "2026-07-16T16:00" },
    ])).toBe(1);

    expect(store.getBySession("s1").map((item) => item.fact)).toEqual(["新分支喜欢红茶"]);
    expect(store.getBySession("s2").map((item) => item.fact)).toEqual(["另一个会话喜欢乌龙茶"]);
    expect(store.searchFullText("茉莉花茶", 10)).toEqual([]);
    expect(store.searchFullText("红茶", 10).map((item) => item.fact)).toEqual(["新分支喜欢红茶"]);
  });

  it("supports an empty replacement tombstone", () => {
    store.add({ fact: "即将被清理的旧事实", tags: [], session_id: "s1" });
    store.add({ fact: "必须保留的其他事实", tags: [], session_id: "s2" });

    expect(store.replaceBySession("s1", [])).toBe(0);

    expect(store.getBySession("s1")).toEqual([]);
    expect(store.getBySession("s2")).toHaveLength(1);
  });

  it("rolls the delete back if a replacement insert fails", () => {
    store.add({ fact: "旧事实必须保留", tags: [], session_id: "s1" });

    expect(() => store.replaceBySession("s1", [
      { fact: null as any, tags: [] },
    ])).toThrow();

    expect(store.getBySession("s1").map((item) => item.fact)).toEqual(["旧事实必须保留"]);
  });
});
