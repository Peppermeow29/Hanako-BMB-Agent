import { describe, expect, it } from "vitest";

import { isCurrentCliAgent, pickCliAgent } from "../server/cli.ts";

describe("CLI agent selection", () => {
  it("names the agent this terminal session is attached to", () => {
    const agents = [
      { id: "mio", isPrimary: true, isCurrent: false },
      { id: "hana", isPrimary: false, isCurrent: true },
    ];
    expect(pickCliAgent(agents)?.id).toBe("hana");
  });

  it("falls back to the primary agent, then to the first one", () => {
    expect(pickCliAgent([
      { id: "mio", isPrimary: true, isCurrent: false },
      { id: "hana", isPrimary: false, isCurrent: false },
    ])?.id).toBe("mio");
    expect(pickCliAgent([
      { id: "hana", isPrimary: false, isCurrent: false },
    ])?.id).toBe("hana");
  });

  it("returns null rather than guessing when there is nothing to pick from", () => {
    expect(pickCliAgent([])).toBeNull();
    expect(pickCliAgent(undefined)).toBeNull();
    expect(pickCliAgent(null)).toBeNull();
  });
});

describe("CLI agent list marker", () => {
  it("marks the agent the server reports as current", () => {
    // GET /api/agents answers with a per-entry flag. There is no top-level
    // currentAgentId field on that response, so reading one marks nothing.
    const agents = [
      { id: "mio", name: "Mio", isPrimary: true, isCurrent: false },
      { id: "hana", name: "Hana", isPrimary: false, isCurrent: true },
    ];
    expect(agents.filter(isCurrentCliAgent).map((a) => a.id)).toEqual(["hana"]);
  });

  it("marks nothing when the server reports no current agent", () => {
    expect([{ id: "hana", name: "Hana", isCurrent: false }].some(isCurrentCliAgent)).toBe(false);
    expect([{ id: "hana", name: "Hana" }].some(isCurrentCliAgent)).toBe(false);
  });
});
