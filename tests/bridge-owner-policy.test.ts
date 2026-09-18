import { describe, expect, it } from "vitest";
import {
  isBridgeOwner,
  resolveBridgeOwnerDeliveryTarget,
} from "../lib/bridge/owner-policy.ts";

describe("bridge owner policy", () => {
  it("preserves exact string owner matching for non-QQ platforms", () => {
    const agent = { config: { bridge: { telegram: { owner: "tg-owner" } } } };

    expect(isBridgeOwner({ platform: "telegram", userId: "tg-owner", agent } as any)).toBe(true);
    expect(isBridgeOwner({
      platform: "telegram",
      userId: "tg-alias",
      aliases: ["tg-owner"],
      agent,
    })).toBe(false);
  });

  it("matches QQ owners by normalized principal or alias metadata", () => {
    const agent = { config: { bridge: { qq: { owner: "c2c-openid" } } } };

    expect(isBridgeOwner({
      platform: "qq",
      userId: "principal-1",
      aliases: ["principal-1", "c2c-openid", "member-openid"],
      agent,
    })).toBe(true);
  });

  it("resolves QQ proactive delivery through principal aliases without merging unknown users", () => {
    const agent = { config: { bridge: { qq: { owner: "member-openid" } } } };
    const index = {
      "qq_dm_c2c-openid@hana": {
        file: "owner/c2c.jsonl",
        userId: "principal-1",
        chatId: "c2c-openid",
        qqPrincipal: {
          principalId: "principal-1",
          aliases: ["c2c-openid", "member-openid"],
        },
      },
      "qq_dm_other-openid@hana": {
        file: "owner/other.jsonl",
        userId: "other-principal",
        chatId: "other-openid",
        qqPrincipal: {
          principalId: "other-principal",
          aliases: ["other-openid"],
        },
      },
    };

    expect(resolveBridgeOwnerDeliveryTarget({ platform: "qq", agent, index })).toEqual({
      userId: "principal-1",
      chatId: "c2c-openid",
      sessionKey: "qq_dm_c2c-openid@hana",
    });
  });
});
