import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  DEFAULT_PLUGIN_SURFACE_SESSION_TTL_MS,
  PLUGIN_SURFACE_SESSION_ACTION,
  PluginSurfaceSessionError,
  issuePluginSurfaceSession,
  verifyPluginSurfaceSession,
} from "../core/plugin-surface-session-service.ts";

let tmpHome = "";

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hana-plugin-surface-session-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("plugin surface session service", () => {
  it("issues and verifies a plugin-bound surface session", () => {
    const issued = issuePluginSurfaceSession({
      hanakoHome: tmpHome,
      pluginId: "media-board",
      principalId: "principal_local",
    });

    expect(issued.token).toEqual(expect.any(String));
    expect(issued.action).toBe(PLUGIN_SURFACE_SESSION_ACTION);
    expect(issued.pluginId).toBe("media-board");
    expect(issued.principalId).toBe("principal_local");
    expect(Date.parse(issued.expiresAt) - Date.parse(issued.issuedAt))
      .toBe(DEFAULT_PLUGIN_SURFACE_SESSION_TTL_MS);

    const verified = verifyPluginSurfaceSession({
      hanakoHome: tmpHome,
      pluginId: "media-board",
      token: issued.token,
    });
    expect(verified).toMatchObject({
      sessionId: issued.sessionId,
      pluginId: "media-board",
      principalId: "principal_local",
      action: PLUGIN_SURFACE_SESSION_ACTION,
    });
  });

  it("rejects sessions presented for a different plugin", () => {
    const issued = issuePluginSurfaceSession({
      hanakoHome: tmpHome,
      pluginId: "media-board",
      principalId: "principal_local",
    });

    expect(() => verifyPluginSurfaceSession({
      hanakoHome: tmpHome,
      pluginId: "other-plugin",
      token: issued.token,
    })).toThrowError(PluginSurfaceSessionError);
  });

  it("rejects expired sessions with a dedicated code", () => {
    const issued = issuePluginSurfaceSession({
      hanakoHome: tmpHome,
      pluginId: "media-board",
      principalId: "principal_local",
      now: "2026-06-10T00:00:00.000Z",
      ttlMs: 1000,
    });

    try {
      verifyPluginSurfaceSession({
        hanakoHome: tmpHome,
        pluginId: "media-board",
        token: issued.token,
        now: "2026-06-10T00:00:02.000Z",
      });
      throw new Error("expected expiry rejection");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PluginSurfaceSessionError);
      expect(err.code).toBe("plugin_surface_session_expired");
    }
  });

  it("rejects tampered and malformed tokens", () => {
    const issued = issuePluginSurfaceSession({
      hanakoHome: tmpHome,
      pluginId: "media-board",
      principalId: "principal_local",
    });
    const [body, signature] = issued.token.split(".");
    const tamperedBody = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(body, "base64url").toString("utf-8")),
      pluginId: "other-plugin",
    }), "utf-8").toString("base64url");

    expect(() => verifyPluginSurfaceSession({
      hanakoHome: tmpHome,
      pluginId: "other-plugin",
      token: `${tamperedBody}.${signature}`,
    })).toThrowError(PluginSurfaceSessionError);

    expect(() => verifyPluginSurfaceSession({
      hanakoHome: tmpHome,
      pluginId: "media-board",
      token: "not-a-token",
    })).toThrowError(PluginSurfaceSessionError);

    expect(() => verifyPluginSurfaceSession({
      hanakoHome: tmpHome,
      pluginId: "media-board",
      token: "",
    })).toThrowError(PluginSurfaceSessionError);
  });

  it("clamps requested ttl to the default ceiling", () => {
    const issued = issuePluginSurfaceSession({
      hanakoHome: tmpHome,
      pluginId: "media-board",
      principalId: "principal_local",
      ttlMs: DEFAULT_PLUGIN_SURFACE_SESSION_TTL_MS * 10,
    });
    expect(Date.parse(issued.expiresAt) - Date.parse(issued.issuedAt))
      .toBe(DEFAULT_PLUGIN_SURFACE_SESSION_TTL_MS);
  });

  it("does not accept plugin iframe tickets or asset session tokens", async () => {
    const { issuePluginIframeTicket } = await import("../core/plugin-iframe-ticket-service.ts");
    const { issuePluginAssetSession } = await import("../core/plugin-asset-session-service.ts");

    const ticket = issuePluginIframeTicket({
      hanakoHome: tmpHome,
      pluginId: "media-board",
      surfacePath: "/page",
      principalId: "principal_local",
    });
    expect(() => verifyPluginSurfaceSession({
      hanakoHome: tmpHome,
      pluginId: "media-board",
      token: ticket.ticket,
    })).toThrowError(PluginSurfaceSessionError);

    const assetSession = issuePluginAssetSession({
      hanakoHome: tmpHome,
      pluginId: "media-board",
      principalId: "principal_local",
    });
    expect(() => verifyPluginSurfaceSession({
      hanakoHome: tmpHome,
      pluginId: "media-board",
      token: assetSession.token,
    })).toThrowError(PluginSurfaceSessionError);
  });
});
