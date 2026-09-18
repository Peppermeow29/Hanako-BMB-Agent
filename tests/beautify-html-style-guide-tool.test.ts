import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { fromRoot } from "../shared/hana-root.ts";
import { execute as listCapabilitiesExecute } from "../plugins/beautify/tools/list-capabilities.ts";
import {
  HTML_STYLE_GUIDE_SECTIONS,
  HTML_STYLE_GUIDE_VERSION,
  REQUIRED_SECTIONS,
  markSectionRead,
  missingRequiredSections,
  getReadSections,
  resetHtmlStyleGuideTracking,
  sessionTrackingKey,
} from "../plugins/beautify/lib/html-style-guide.ts";
import {
  description as htmlGuideDescription,
  execute as htmlGuideExecute,
  parameters as htmlGuideParameters,
  isEnabledForAgentConfig as htmlGuideEnabled,
} from "../plugins/beautify/tools/get-html-style-guide.ts";
import { isBeautifyEnabledForAgentConfig } from "../plugins/beautify/lib/availability.ts";

function loadLocaleJson(name: string) {
  return JSON.parse(fs.readFileSync(fromRoot("desktop", "src", "locales", `${name}.json`), "utf-8"));
}

function pick(obj: any, dotted: string) {
  return dotted.split(".").reduce((acc, key) => (acc ? acc[key] : undefined), obj);
}

const GUIDE_PREFIX = "plugin.beautify.htmlStyleGuide";

describe("beautify html style guide i18n", () => {
  const zh = loadLocaleJson("zh");
  const en = loadLocaleJson("en");

  it("ships router text in zh and en with no concrete hex values", () => {
    for (const data of [zh, en]) {
      const router = pick(data, `${GUIDE_PREFIX}.router`);
      expect(router).toBeTruthy();
      for (const sectionName of ["color", "typography", "layout", "components", "imagery", "motion", "anti-patterns"]) {
        expect(router).toContain(sectionName);
      }
      expect(router).toContain("beautify_get-html-style-guide");
      expect(router).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    }
  });

  it("ships all seven sections in zh and en with canonical tokens preserved", () => {
    for (const data of [zh, en]) {
      expect(pick(data, `${GUIDE_PREFIX}.color`)).toContain("#537D96");
      expect(pick(data, `${GUIDE_PREFIX}.color`)).toContain("#F8F4ED");
      expect(pick(data, `${GUIDE_PREFIX}.typography`)).toContain("EB Garamond");
      expect(pick(data, `${GUIDE_PREFIX}.typography`)).toContain("tabular-nums");
      expect(pick(data, `${GUIDE_PREFIX}.layout`)).toContain("44px");
      expect(pick(data, `${GUIDE_PREFIX}.components`)).toContain("focus-visible");
      expect(pick(data, `${GUIDE_PREFIX}.imagery`)).toContain("stroke");
      expect(pick(data, `${GUIDE_PREFIX}.motion`)).toContain("prefers-reduced-motion");
      expect(pick(data, `${GUIDE_PREFIX}.antiPatterns`)).toContain("glassmorphism");
    }
  });

  it("ships hard-gate and invalid-section messages with placeholders", () => {
    for (const data of [zh, en]) {
      const mustRead = pick(data, `${GUIDE_PREFIX}.mustReadFirst`);
      expect(mustRead).toContain("{missing}");
      expect(mustRead).toContain("{section}");
      const invalid = pick(data, `${GUIDE_PREFIX}.invalidSection`);
      expect(invalid).toContain("{section}");
      expect(invalid).toContain("{valid}");
    }
  });

  it("mentions the html capability in list-capabilities text", () => {
    for (const data of [zh, en]) {
      expect(pick(data, "toolDef.listCapabilities.text")).toContain("beautify_get-html-style-guide");
    }
  });
});

describe("html style guide tracking state", () => {
  beforeEach(() => resetHtmlStyleGuideTracking());

  it("declares seven flat sections and two required ones", () => {
    expect(HTML_STYLE_GUIDE_SECTIONS).toEqual([
      "color", "typography", "layout", "components", "imagery", "motion", "anti-patterns",
    ]);
    expect(REQUIRED_SECTIONS).toEqual(["color", "typography"]);
    expect(HTML_STYLE_GUIDE_VERSION).toBe("2026-06-10");
  });

  it("derives tracking key from ctx.sessionId before legacy sessionPath", () => {
    expect(sessionTrackingKey({ sessionId: "sess_html", sessionPath: "/a/b.jsonl" })).toBe("id:sess_html");
    expect(sessionTrackingKey({ sessionPath: "/a/b.jsonl" })).toBe("/a/b.jsonl");
    expect(sessionTrackingKey({})).toBe("__no_session__");
    expect(sessionTrackingKey(undefined)).toBe("__no_session__");
  });

  it("tracks read sections per session key, isolated", () => {
    markSectionRead("s1", "color");
    expect(getReadSections("s1")).toEqual(["color"]);
    expect(getReadSections("s2")).toEqual([]);
    expect(missingRequiredSections("s1")).toEqual(["typography"]);
    markSectionRead("s1", "typography");
    expect(missingRequiredSections("s1")).toEqual([]);
    expect(missingRequiredSections("s2")).toEqual(["color", "typography"]);
  });

  it("caps tracked sessions by evicting the oldest", () => {
    for (let i = 0; i < 201; i++) markSectionRead(`s${i}`, "color");
    expect(getReadSections("s0")).toEqual([]);      // 最旧的被逐出
    expect(getReadSections("s1")).toEqual(["color"]);
    expect(getReadSections("s200")).toEqual(["color"]);
  });
});

describe("beautify html style guide tool", () => {
  beforeEach(() => resetHtmlStyleGuideTracking());

  const ctxA = { sessionPath: "/tmp/style-a.jsonl" };
  const ctxB = { sessionPath: "/tmp/style-b.jsonl" };

  it("describes full-page scope and the card boundary, and gates like other beautify tools", () => {
    expect(htmlGuideDescription).toContain("整页 HTML");
    expect(htmlGuideDescription).toContain("路由器");
    expect(htmlGuideEnabled).toBe(isBeautifyEnabledForAgentConfig);
    expect(htmlGuideParameters.properties.section.enum).toEqual(HTML_STYLE_GUIDE_SECTIONS);
  });

  it("returns the router (no hex values) when called without section", async () => {
    const result = await htmlGuideExecute({}, ctxA);
    const text = result.content[0].text;
    expect(text).toContain("typography");
    expect(text).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    expect(result.details).toMatchObject({ kind: "router", version: HTML_STYLE_GUIDE_VERSION });
  });

  it("serves required sections immediately and records progress", async () => {
    const result = await htmlGuideExecute({ section: "color" }, ctxA);
    expect(result.content[0].text).toContain("#537D96");
    expect(result.details).toMatchObject({ kind: "section", section: "color", readSections: ["color"] });
  });

  it("refuses non-required sections until both required ones were read", async () => {
    const refused = await htmlGuideExecute({ section: "components" }, ctxA);
    expect(refused.details.kind).toBe("must-read-first");
    expect(refused.details.missingRequired).toEqual(["color", "typography"]);
    expect(refused.content[0].text).toContain("color");

    await htmlGuideExecute({ section: "color" }, ctxA);
    const stillRefused = await htmlGuideExecute({ section: "components" }, ctxA);
    expect(stillRefused.details.kind).toBe("must-read-first");
    expect(stillRefused.details.missingRequired).toEqual(["typography"]);

    await htmlGuideExecute({ section: "typography" }, ctxA);
    const served = await htmlGuideExecute({ section: "components" }, ctxA);
    expect(served.details.kind).toBe("section");
    expect(served.content[0].text).toContain("focus-visible");
    expect(served.details.readSections).toEqual(["color", "typography", "components"]);
  });

  it("isolates the gate between sessions", async () => {
    await htmlGuideExecute({ section: "color" }, ctxA);
    await htmlGuideExecute({ section: "typography" }, ctxA);
    const refused = await htmlGuideExecute({ section: "motion" }, ctxB);
    expect(refused.details.kind).toBe("must-read-first");
  });

  it("tracks read sections by sessionId before legacy sessionPath", async () => {
    const original = {
      sessionId: "sess_beautify",
      sessionPath: "/tmp/style-old.jsonl",
    };
    const relocated = {
      sessionId: "sess_beautify",
      sessionPath: "/tmp/style-new.jsonl",
    };

    await htmlGuideExecute({ section: "color" }, original);
    await htmlGuideExecute({ section: "typography" }, relocated);
    const served = await htmlGuideExecute({ section: "components" }, relocated);
    const legacyOnly = await htmlGuideExecute({ section: "components" }, {
      sessionPath: "/tmp/style-old.jsonl",
    });

    expect(served.details.kind).toBe("section");
    expect(served.details.readSections).toEqual(["color", "typography", "components"]);
    expect(legacyOnly.details.kind).toBe("must-read-first");
  });

  it("rejects unknown sections listing the valid ones", async () => {
    const result = await htmlGuideExecute({ section: "neon" }, ctxA);
    expect(result.details.kind).toBe("invalid-section");
    expect(result.content[0].text).toContain("anti-patterns");
    expect(result.content[0].text).toContain("neon");
  });
});

describe("beautify list-capabilities html entry", () => {
  it("registers the html style guide capability", async () => {
    const result = await listCapabilitiesExecute();
    const ids = result.details.capabilities.map((c: any) => c.id);
    expect(ids).toContain("html-style-guide");
    const entry = result.details.capabilities.find((c: any) => c.id === "html-style-guide");
    expect(entry.tools).toEqual(["beautify_get-html-style-guide"]);
    expect(result.content[0].text).toContain("beautify_get-html-style-guide");
  });
});
