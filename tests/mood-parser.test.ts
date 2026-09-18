import { describe, expect, it } from "vitest";
import { MoodParser } from "../core/events.ts";

function collect(chunks: string[]) {
  const parser = new MoodParser();
  const events: Array<{ type: string; data?: string }> = [];
  for (const chunk of chunks) parser.feed(chunk, (event) => events.push(event));
  parser.flush((event) => events.push(event));
  return events;
}

function visibleText(events: Array<{ type: string; data?: string }>) {
  return events.filter((event) => event.type === "text").map((event) => event.data || "").join("");
}

describe("MoodParser", () => {
  it.each(["mood", "pulse", "reflect"])(
    "parses a leading <%s> block with the existing stream event contract",
    (tag) => {
      expect(collect([`<${tag}>inside</${tag}>\nafter`])).toEqual([
        { type: "mood_start" },
        { type: "mood_text", data: "inside" },
        { type: "mood_end" },
        { type: "text", data: "after" },
      ]);
    },
  );

  it("recognizes a leading block across chunks after optional BOM and whitespace", () => {
    expect(collect(["\uFEFF \n<pul", "se>inside</pu", "lse>\nafter"])).toEqual([
      { type: "text", data: "\uFEFF \n" },
      { type: "mood_start" },
      { type: "mood_text", data: "inside" },
      { type: "mood_end" },
      { type: "text", data: "after" },
    ]);
  });

  it.each(["mood", "pulse", "reflect"])(
    "keeps an inline-code <%s> tag and all following prose visible",
    (tag) => {
      const input = `\`<${tag}>\` suffix survives`;
      const events = collect([input]);
      expect(events.map((event) => event.type)).toEqual(["text"]);
      expect(visibleText(events)).toBe(input);
    },
  );

  it("permanently treats later tags as text once visible prose begins, including across chunks", () => {
    const input = "prefix `<mood>` suffix";
    const events = collect(["prefix `<mo", "od>` suffix"]);
    expect(events.every((event) => event.type === "text")).toBe(true);
    expect(visibleText(events)).toBe(input);
  });

  it("keeps fenced Markdown tags visible", () => {
    const input = "```xml\n<mood>literal</mood>\n```\nafter";
    const events = collect([input]);
    expect(events.every((event) => event.type === "text")).toBe(true);
    expect(visibleText(events)).toBe(input);
  });

  it("does not reopen mood parsing after a valid leading block", () => {
    expect(collect(["<mood>inside</mood>\nafter <pulse>literal</pulse>"])).toEqual([
      { type: "mood_start" },
      { type: "mood_text", data: "inside" },
      { type: "mood_end" },
      { type: "text", data: "after <pulse>literal</pulse>" },
    ]);
  });

  it("requires the closer to match the leading opener", () => {
    expect(collect(["<mood>inside</pulse>still mood</mood>after"])).toEqual([
      { type: "mood_start" },
      { type: "mood_text", data: "inside</pulse>still mood" },
      { type: "mood_end" },
      { type: "text", data: "after" },
    ]);
  });

  it("preserves flush behavior for an unclosed valid leading block", () => {
    expect(collect(["<mood>unfinished"])).toEqual([
      { type: "mood_start" },
      { type: "mood_text", data: "unfinished" },
      { type: "mood_end" },
    ]);
  });
});
