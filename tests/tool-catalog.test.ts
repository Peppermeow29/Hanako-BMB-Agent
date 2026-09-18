import { describe, expect, it } from "vitest";
import { createToolCatalog } from "../core/tool-catalog.ts";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    name: "github_create_issue",
    description: "Create a new issue in a repository with a title and body.",
    paramsSummary: "owner (string, required), repo (string, required), title (string, required)",
    serverId: "github",
    serverLabel: "GitHub",
    deferrable: true,
    pinned: false,
    schemaRef: () => ({ type: "object", properties: { owner: { type: "string" } }, required: ["owner"] }),
    ...overrides,
  };
}

describe("tool catalog entry model", () => {
  it("registers a source and exposes its entries", () => {
    const catalog = createToolCatalog();
    catalog.registerSource("mcp:github", [entry()]);
    expect(catalog.size()).toBe(1);
    expect(catalog.has("github_create_issue")).toBe(true);
  });

  it("normalizes optional entry fields with safe defaults", () => {
    const catalog = createToolCatalog();
    catalog.registerSource("mcp:github", [
      { name: "t_one", description: "d", serverId: "s", serverLabel: "S", schemaRef: () => ({}) },
    ]);
    const found = catalog.get("t_one");
    expect(found?.deferrable).toBe(true);
    expect(found?.pinned).toBe(false);
    expect(found?.paramsSummary).toBe("");
    expect(found?.origin).toBe("mcp");
  });

  it("rejects an entry without a usable name", () => {
    const catalog = createToolCatalog();
    expect(() => catalog.registerSource("mcp:x", [entry({ name: "" })])).toThrow(/name/i);
  });

  it("replaceSource swaps only that source and leaves others intact", () => {
    const catalog = createToolCatalog();
    catalog.registerSource("mcp:github", [entry()]);
    catalog.registerSource("mcp:notion", [entry({ name: "notion_create_page", serverId: "notion", serverLabel: "Notion" })]);
    catalog.replaceSource("mcp:github", [entry({ name: "github_list_issues" })]);
    expect(catalog.has("github_create_issue")).toBe(false);
    expect(catalog.has("github_list_issues")).toBe(true);
    expect(catalog.has("notion_create_page")).toBe(true);
  });

  it("removeSource drops exactly that source's entries", () => {
    const catalog = createToolCatalog();
    catalog.registerSource("mcp:github", [entry()]);
    catalog.registerSource("mcp:notion", [entry({ name: "notion_create_page", serverId: "notion", serverLabel: "Notion" })]);
    catalog.removeSource("mcp:github");
    expect(catalog.size()).toBe(1);
    expect(catalog.has("notion_create_page")).toBe(true);
  });

  it("keeps the catalog free of the full schema until it is asked for", () => {
    let schemaReads = 0;
    const catalog = createToolCatalog();
    catalog.registerSource("mcp:github", [entry({
      schemaRef: () => {
        schemaReads += 1;
        return { type: "object" };
      },
    })]);
    catalog.manifest(10000);
    catalog.search("issue");
    expect(schemaReads).toBe(0);
    catalog.describe("github_create_issue");
    expect(schemaReads).toBe(1);
  });
});

describe("tool catalog search", () => {
  function seeded() {
    const catalog = createToolCatalog();
    catalog.registerSource("mcp:github", [
      entry(),
      entry({
        name: "github_list_issues",
        description: "List issues in a repository filtered by state and label.",
        paramsSummary: "owner (string, required), state (string)",
      }),
      entry({
        name: "github_create_pull_request",
        description: "Open a pull request from a head branch into a base branch.",
        paramsSummary: "head (string, required), base (string, required)",
      }),
    ]);
    catalog.registerSource("mcp:notion", [
      entry({
        name: "notion_create_page",
        description: "Create a page in a database with typed properties.",
        paramsSummary: "parent_id (string, required), title (string, required)",
        serverId: "notion",
        serverLabel: "Notion",
      }),
    ]);
    return catalog;
  }

  it("ranks by relevance across servers", () => {
    const names = seeded().search("issue").map((hit) => hit.name);
    expect(names).toContain("github_create_issue");
    expect(names).toContain("github_list_issues");
    expect(names).not.toContain("github_create_pull_request");
  });

  it("matches on parameter names", () => {
    const names = seeded().search("parent_id").map((hit) => hit.name);
    expect(names[0]).toBe("notion_create_page");
  });

  it("defaults to 5 results and clamps to max", () => {
    const catalog = createToolCatalog();
    catalog.registerSource("mcp:big", Array.from({ length: 40 }, (_, index) => entry({
      name: `tool_issue_${index}`,
      description: "An issue related tool.",
    })));
    expect(catalog.search("issue")).toHaveLength(5);
    expect(catalog.search("issue", { limit: 12 })).toHaveLength(12);
    expect(catalog.search("issue", { limit: 999 })).toHaveLength(20);
    expect(catalog.search("issue", { limit: 999, max: 7 })).toHaveLength(7);
  });

  it("treats equally matching tools from different servers identically", () => {
    const catalog = createToolCatalog();
    catalog.registerSource("mcp:alpha", [entry({
      name: "alpha_widget_build",
      description: "Build a widget from a spec.",
      paramsSummary: "spec (string, required)",
      serverId: "alpha",
      serverLabel: "Alpha Server With A Very Long Label",
    })]);
    catalog.registerSource("mcp:beta", [entry({
      name: "beta_widget_build",
      description: "Build a widget from a spec.",
      paramsSummary: "spec (string, required)",
      serverId: "beta",
      serverLabel: "B",
    })]);
    const hits = catalog.search("widget build");
    expect(hits).toHaveLength(2);
    expect(hits[0].score).toBeCloseTo(hits[1].score, 10);
  });

  it("indexes Chinese descriptions so a Chinese query finds the tool", () => {
    const catalog = createToolCatalog();
    catalog.registerSource("mcp:doc", [entry({
      name: "doc_translate",
      description: "\u5c06\u6587\u6863\u7ffb\u8bd1\u6210\u53e6\u4e00\u79cd\u8bed\u8a00",
      paramsSummary: "",
    })]);
    expect(catalog.search("\u7ffb\u8bd1").map((hit) => hit.name)).toEqual(["doc_translate"]);
  });

  it("falls back to a tool-name substring match when scoring finds nothing", () => {
    const catalog = createToolCatalog();
    catalog.registerSource("mcp:github", [entry({ name: "github_zzqq_special", description: "Nothing relevant here." })]);
    const hits = catalog.search("zzqq");
    expect(hits.map((hit) => hit.name)).toEqual(["github_zzqq_special"]);
  });

  it("returns nothing for a query that matches nothing at all", () => {
    expect(seeded().search("qqqqzzzz")).toEqual([]);
  });

  it("ignores server label text when scoring so provenance cannot boost a hit", () => {
    const catalog = createToolCatalog();
    catalog.registerSource("mcp:one", [entry({
      name: "one_alpha",
      description: "Generic helper.",
      paramsSummary: "",
      serverId: "one",
      serverLabel: "Issue Tracker Issues Issue",
    })]);
    catalog.registerSource("mcp:two", [entry({
      name: "two_alpha",
      description: "Generic helper.",
      paramsSummary: "",
      serverId: "two",
      serverLabel: "Plain",
    })]);
    expect(catalog.search("issue")).toEqual([]);
  });
});

describe("tool catalog manifest", () => {
  function manifestCatalog(toolCount: number) {
    const catalog = createToolCatalog();
    catalog.registerSource("mcp:github", Array.from({ length: toolCount }, (_, index) => entry({
      name: `github_tool_${index}`,
      description: `Tool number ${index} that performs a repository operation.`,
    })));
    catalog.registerSource("mcp:notion", [entry({
      name: "notion_create_page",
      description: "Create a page in a database.",
      serverId: "notion",
      serverLabel: "Notion",
    })]);
    return catalog;
  }

  it("renders tier 1 grouped by server with one line per tool", () => {
    const result = manifestCatalog(2).manifest(100000);
    expect(result.tier).toBe(1);
    expect(result.text).toContain("GitHub");
    expect(result.text).toContain("Notion");
    expect(result.text).toContain("github_tool_0");
    expect(result.text).toContain("notion_create_page");
  });

  it("degrades to tier 2 when tier 1 does not fit the budget", () => {
    const result = manifestCatalog(60).manifest(80);
    expect(result.tier).toBe(2);
    expect(result.text).toContain("GitHub");
    expect(result.text).toContain("60");
    expect(result.text).not.toContain("github_tool_0");
  });

  it("marks pinned tools as already loaded", () => {
    const catalog = createToolCatalog();
    catalog.registerSource("mcp:github", [entry({ pinned: true })]);
    expect(catalog.manifest(100000).text).toMatch(/github_create_issue.*已加载/);
  });

  it("returns empty text for an empty catalog", () => {
    expect(createToolCatalog().manifest(1000)).toEqual({ tier: 1, text: "" });
  });
});

describe("tool catalog describe", () => {
  it("returns the resolved schema for a known tool", () => {
    const catalog = createToolCatalog();
    catalog.registerSource("mcp:github", [entry()]);
    const described = catalog.describe("github_create_issue");
    expect(described?.serverId).toBe("github");
    expect(described?.paramsSummary).toContain("owner");
    expect(described?.schema).toEqual({
      type: "object",
      properties: { owner: { type: "string" } },
      required: ["owner"],
    });
  });

  it("returns null for an unknown tool", () => {
    expect(createToolCatalog().describe("nope")).toBeNull();
  });

  it("survives a schemaRef that throws", () => {
    const catalog = createToolCatalog();
    catalog.registerSource("mcp:github", [entry({
      schemaRef: () => {
        throw new Error("gone");
      },
    })]);
    expect(catalog.describe("github_create_issue")?.schema).toBeNull();
  });
});
