import { describe, expect, it } from "vitest";

import {
  normalizeSessionSearchText,
  tokenizeSessionSearchQuery,
} from "../lib/search/session-search-tokenizer.ts";

describe("session search tokenizer", () => {
  it("uses jieba search mode so Chinese queries expose searchable words", () => {
    const tokens = tokenizeSessionSearchQuery("和其他Agent的聊天记录");

    expect(tokens).toEqual(expect.arrayContaining([
      "和其他agent的聊天记录",
      "其他",
      "agent",
      "聊天",
      "记录",
      "聊天记录",
    ]));
  });

  it("keeps project terms that mix ASCII, underscore, and Chinese as single tokens", () => {
    const tokens = tokenizeSessionSearchQuery("session_search 搜不到 A2A通信");

    expect(tokens).toEqual(expect.arrayContaining([
      "session_search",
      "搜不到",
      "a2a通信",
    ]));
  });

  it("normalizes full-width and case differences before matching", () => {
    expect(normalizeSessionSearchText("Ａｇｅｎｔ  SESSION_SEARCH")).toBe("agent session_search");
  });
});
