/**
 * Regression test for issue #402: keep browser tool schema small.
 * Current en description + actionDesc ≈ 631 chars, threshold 700 leaves ~69 char buffer.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/i18n.ts", () => ({ t: (k: string) => k, getLocale: () => "en" }));

async function loadBrowserToolDef() {
  const mod = await import("../lib/tools/browser-tool.ts");
  const tool = (mod as any).createBrowserTool({});
  return tool;
}

describe("browser tool schema size (#402)", () => {
  it("keeps description + actionDesc under 700 chars", async () => {
    const tool = await loadBrowserToolDef();
    const actionDesc = tool.parameters?.properties?.action?.description ?? "";
    const total = tool.description.length + actionDesc.length;
    expect(total).toBeLessThan(700);
  });

  it("encodes the action→param contract in actionDesc", async () => {
    const tool = await loadBrowserToolDef();
    const actionDesc = tool.parameters?.properties?.action?.description ?? "";
    for (const action of ["navigate", "click", "type", "scroll", "select", "key", "evaluate"]) {
      expect(actionDesc).toContain(action);
    }
  });

  it("keeps the stale-ref warning in description", async () => {
    const tool = await loadBrowserToolDef();
    expect(tool.description).toContain("[ref]");
  });
});
