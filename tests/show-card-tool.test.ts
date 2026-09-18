import { describe, expect, it } from "vitest";
import { createShowCardTool } from "../lib/tools/show-card-tool.ts";

describe("show_card tool", () => {
  function makeTool() {
    return createShowCardTool();
  }

  it("has correct name and parameters", () => {
    const tool = makeTool();
    expect(tool.name).toBe("show_card");
    expect(tool.parameters.properties.title).toBeDefined();
    expect(tool.parameters.properties.code).toBeDefined();
    expect(tool.parameters.required).toContain("title");
    expect(tool.parameters.required).toContain("code");
  });

  it("returns cardId and status in details", async () => {
    const tool = makeTool();
    const result = await tool.execute("call_1", {
      title: "revenue_chart_q4",
      code: '<div style="padding: 1rem"><h2>Q4 Revenue</h2></div>',
    });

    expect(result.details).toBeDefined();
    expect(result.details.cardId).toBeDefined();
    expect(typeof result.details.cardId).toBe("string");
    expect(result.details.cardId.length).toBeGreaterThan(0);
    expect(result.details.status).toBe("rendered");
    expect(result.details.title).toBe("revenue_chart_q4");
    expect(result.details.code).toBe('<div style="padding: 1rem"><h2>Q4 Revenue</h2></div>');
  });

  it("generates unique cardIds across calls", async () => {
    const tool = makeTool();
    const r1 = await tool.execute("call_1", {
      title: "chart_a",
      code: "<p>A</p>",
    });
    const r2 = await tool.execute("call_2", {
      title: "chart_b",
      code: "<p>B</p>",
    });
    expect(r1.details.cardId).not.toBe(r2.details.cardId);
  });

  it("returns rendered status text in content", async () => {
    const tool = makeTool();
    const result = await tool.execute("call_1", {
      title: "test_card",
      code: "<p>hello</p>",
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("rendered");
  });

  it("preserves code verbatim in details for block extraction", async () => {
    const tool = makeTool();
    const code = `<style>h1 { color: var(--accent); }</style>
<h1>Hello</h1>
<script>console.log("ready")</script>`;
    const result = await tool.execute("call_1", {
      title: "complex_card",
      code,
    });
    expect(result.details.code).toBe(code);
  });
});
