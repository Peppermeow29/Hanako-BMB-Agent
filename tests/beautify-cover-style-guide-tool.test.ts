import { describe, expect, it } from "vitest";
import { description, execute } from "../plugins/beautify/tools/get-cover-style-guide.ts";

describe("beautify cover style guide tool", () => {
  it("actively directs agents to read style guidance before creating markdown covers", async () => {
    expect(description).toContain("先调用本工具");
    expect(description).toContain("Markdown");

    const result = await execute({ themeTone: "dark", userGuidance: "更安静" });
    expect(result.content[0].text).toContain("现代 Anime");
    expect(result.content[0].text).toContain("强纸张质感");
    expect(result.content[0].text).toContain("深色主题");
    expect(result.content[0].text).toContain("更安静");
    expect(result.details.workflow).toContain("调用 beautify_get-cover-style-guide");
  });
});
