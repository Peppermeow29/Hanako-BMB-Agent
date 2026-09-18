import { describe, expect, it } from "vitest";

import { createDefaultSettings } from "../core/session-defaults.ts";

describe("default session settings", () => {
  it("batches steering input while preserving follow-up and compaction defaults", () => {
    const settings = createDefaultSettings();

    expect(settings.getSteeringMode()).toBe("all");
    expect(settings.getFollowUpMode()).toBe("one-at-a-time");
    expect(settings.getCompactionSettings()).toEqual({
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20_000,
    });
  });
});
