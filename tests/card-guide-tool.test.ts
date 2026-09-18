import { describe, expect, it } from "vitest";
import { createCardGuideTool } from "../lib/tools/card-guide-tool.ts";

describe("hana_card_guide tool", () => {
  function makeTool() {
    return createCardGuideTool();
  }

  it("has correct name and label", () => {
    const tool = makeTool();
    expect(tool.name).toBe("hana_card_guide");
    expect(tool.label).toBeDefined();
  });

  it("accepts optional modules parameter", () => {
    const tool = makeTool();
    const props = tool.parameters.properties;
    expect(props.modules).toBeDefined();
  });

  it("returns design handbook content in text result", async () => {
    const tool = makeTool();
    const result = await tool.execute("call_1", {});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const text = result.content[0].text;
    // Must contain core design system sections
    expect(text).toContain("--accent");
    expect(text).toContain("--bg-card");
    expect(text).toContain("--text");
    expect(text).toContain("--border");
    expect(text).toContain("--font-serif");
    expect(text).toContain("EB Garamond");
  });

  it("handbook contains typography rules", async () => {
    const tool = makeTool();
    const result = await tool.execute("call_1", {});
    const text = result.content[0].text;

    // Font size specs
    expect(text).toContain("1.35rem"); // h1
    expect(text).toContain("1.1rem");  // h2
    expect(text).toContain("0.95rem"); // h3
    expect(text).toContain("0.9rem");  // body
    expect(text).toContain("0.75rem"); // caption
  });

  it("handbook contains color palette with KAMI colors", async () => {
    const tool = makeTool();
    const result = await tool.execute("call_1", {});
    const text = result.content[0].text;

    // Hana accent
    expect(text).toContain("#537D96");
    // KAMI ink blue
    expect(text).toContain("#1B365D");
    // KAMI stamp
    expect(text).toContain("#9D5F4D");
    // Paper gradation
    expect(text).toContain("#FFFDF7");
  });

  it("handbook contains forbidden patterns", async () => {
    const tool = makeTool();
    const result = await tool.execute("call_1", {});
    const text = result.content[0].text;

    expect(text).toContain("gradient");
    expect(text).toContain("shadow");
    expect(text).toContain("emoji");
    expect(text).toContain("position: fixed");
    expect(text).toContain("DOCTYPE");
  });

  it("handbook contains component specs", async () => {
    const tool = makeTool();
    const result = await tool.execute("call_1", {});
    const text = result.content[0].text;

    // Cards, tables, metrics, buttons, blockquote, code
    expect(text).toContain("border-collapse");
    expect(text).toContain("tabular-nums");
    expect(text).toContain("blockquote");
  });

  it("handbook contains streaming rules", async () => {
    const tool = makeTool();
    const result = await tool.execute("call_1", {});
    const text = result.content[0].text;

    expect(text).toContain("<style>");
    expect(text).toContain("<script>");
    expect(text).toContain("inline style");
  });

  it("handbook contains accessibility guidance", async () => {
    const tool = makeTool();
    const result = await tool.execute("call_1", {});
    const text = result.content[0].text;

    expect(text).toContain("sr-only");
    expect(text).toContain("aria");
  });

  it("handbook contains use case templates", async () => {
    const tool = makeTool();
    const result = await tool.execute("call_1", {});
    const text = result.content[0].text;

    // Should have concrete guidance for common card types
    expect(text).toContain("metric");
    expect(text).toContain("chart");
    expect(text).toContain("diagram");
  });
});
