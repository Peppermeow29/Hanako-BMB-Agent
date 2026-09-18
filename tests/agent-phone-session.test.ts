import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  filterAgentPhoneTools,
  getAgentPhoneSessionDir,
  isAgentPhoneSessionPath,
  shouldReuseAgentPhoneSession,
} from "../lib/conversations/agent-phone-session.ts";

describe("agent phone session policy", () => {
  it("uses a stable safe session directory per conversation", () => {
    const dir = getAgentPhoneSessionDir("/agents/hana", "dm:yui");
    expect(dir).toContain(["agents", "hana", "phone", "sessions"].join(path.sep) + path.sep);
    expect(dir.split(path.sep).at(-1)).not.toContain(":");
  });

  it("recognizes phone sessions so memory pipelines can exclude them", () => {
    expect(isAgentPhoneSessionPath("/agents/hana/phone/sessions/ch_crew/session.jsonl")).toBe(true);
    expect(isAgentPhoneSessionPath("/agents/hana/sessions/session.jsonl")).toBe(false);
  });

  it("reuses phone sessions only inside the active window", () => {
    const now = new Date("2026-05-25T12:00:00.000Z");
    expect(shouldReuseAgentPhoneSession({
      meta: { lastPhoneSessionUsedAt: "2026-05-25T11:45:00.000Z" },
      sessionExists: true,
      now,
    })).toBe(true);
    expect(shouldReuseAgentPhoneSession({
      meta: { lastPhoneSessionUsedAt: "2026-05-25T11:20:00.000Z" },
      sessionExists: true,
      now,
    })).toBe(false);
  });

  it("does not reopen legacy phone sessions that lack explicit last-used metadata", () => {
    expect(shouldReuseAgentPhoneSession({
      meta: { lastRefreshedDate: "2026-05-25" },
      sessionExists: true,
      now: new Date("2026-05-25T12:00:00.000Z"),
    })).toBe(false);
  });

  it("keeps phone write mode from opening recursive communication or browser tools", () => {
    const built = {
      tools: [
        { name: "read" },
        { name: "write" },
        { name: "browser" },
      ],
      customTools: [
        { name: "search_memory" },
        { name: "channel" },
        { name: "dm" },
        { name: "web_search" },
      ],
    };

    const filtered = (filterAgentPhoneTools as any)(built, { toolMode: "write" });
    expect(filtered.tools.map((tool) => tool.name)).toEqual(["read", "write"]);
    expect(filtered.customTools.map((tool) => tool.name)).toEqual(["search_memory", "web_search"]);
  });

  it("keeps phone read-only mode schema stable while excluding structural phone blockers", () => {
    const built = {
      tools: [
        { name: "read" },
        { name: "write" },
        { name: "grep" },
        { name: "browser" },
      ],
      customTools: [
        { name: "search_memory" },
        { name: "record_experience" },
        { name: "dm" },
        { name: "web_fetch" },
      ],
    };

    const filtered = (filterAgentPhoneTools as any)(built, { toolMode: "read_only" });
    expect(filtered.tools.map((tool) => tool.name)).toEqual(["read", "write", "grep"]);
    expect(filtered.customTools.map((tool) => tool.name)).toEqual([
      "search_memory",
      "record_experience",
      "web_fetch",
    ]);
  });
});
