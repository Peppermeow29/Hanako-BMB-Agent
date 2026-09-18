import { describe, expect, it } from "vitest";

const localPrincipal = Object.freeze({
  kind: "local_user",
  credentialKind: "loopback_token",
  connectionKind: "local",
  scopes: ["chat", "resources", "tools"],
});

function devicePrincipal(scopes = []) {
  return Object.freeze({
    kind: "device",
    credentialKind: "device_credential",
    connectionKind: "lan",
    scopes,
  });
}

const mobileScopes = Object.freeze(["chat", "resources.read", "files.read", "files.write"]);
const legacyDesktopOwnerScopes = Object.freeze([
  "chat",
  "resources.read",
  "files.read",
  "files.write",
  "settings.read",
  "settings.write",
  "providers.manage",
  "secrets.write",
  "bridge.manage",
]);
const desktopOwnerScopes = Object.freeze([
  ...legacyDesktopOwnerScopes,
  "studio.owner",
]);

function mobilePrincipal() {
  return devicePrincipal([...mobileScopes]);
}

function desktopOwnerPrincipal(extraScopes = []) {
  return devicePrincipal([...desktopOwnerScopes, ...extraScopes]);
}

describe("HTTP route security policy", () => {
  it("keeps local owner access unrestricted", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.ts");

    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/providers/summary",
      principal: localPrincipal,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/shutdown",
      principal: localPrincipal,
    })).toMatchObject({ allowed: true });
  });

  it("allows scoped trusted devices to read masked settings without opening local-only admin routes", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.ts");
    const principal = devicePrincipal(["chat", "resources.read", "settings.read"]);

    for (const [method, path] of [
      ["GET", "/api/config"],
      ["GET", "/api/providers/summary"],
      ["GET", "/api/preferences/models"],
      ["GET", "/api/preferences/session-permission-default"],
      ["GET", "/api/bridge/status"],
      ["GET", "/api/agents/hana/config"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal })).toMatchObject({
        allowed: true,
      });
    }

    for (const [method, path] of [
      ["POST", "/api/shutdown"],
      ["GET", "/internal/browser"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal })).toMatchObject({
        allowed: false,
        status: 403,
        error: "local_only_route",
      });
    }
    expect(authorizeHttpRoute({ method: "GET", path: "/api/usage/llm", principal }))
      .toMatchObject({
        allowed: false,
        status: 403,
        error: "studio_owner_required",
      });
  });

  it("keeps access and device management routes local-owner only", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.ts");
    const principal = devicePrincipal(["chat", "resources.read", "files.read", "files.write", "settings.read"]);

    for (const [method, path] of [
      ["GET", "/api/access/summary"],
      ["PUT", "/api/access/network"],
      ["POST", "/api/access/mobile-credentials"],
      ["POST", "/api/access/desktop-credentials"],
      ["PUT", "/api/access/account/profile"],
      ["PUT", "/api/access/account/password"],
      ["DELETE", "/api/access/account/password"],
      ["POST", "/api/devices/device_1/revoke"],
      ["POST", "/api/devices/credentials/cred_1/revoke"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal })).toMatchObject({
        allowed: false,
        status: 403,
        error: "local_only_route",
      });
    }
  });

  it("keeps legacy GPU preference cleanup local-owner only", async () => {
    const { authorizeHttpRoute, classifyHttpRoute } = await import("../server/http/route-security.ts");
    const path = "/api/preferences/legacy-gpu-safe-mode/hardware-acceleration";

    expect(classifyHttpRoute({ method: "POST", path })).toMatchObject({ kind: "local_only" });
    expect(authorizeHttpRoute({ method: "POST", path, principal: desktopOwnerPrincipal() }))
      .toMatchObject({ allowed: false, error: "local_only_route" });
    expect(authorizeHttpRoute({ method: "POST", path, principal: localPrincipal }))
      .toMatchObject({ allowed: true });
  });

  it("separates remote settings writes, provider management, bridge management, and secret mutation scopes", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.ts");
    const settingsWriter = devicePrincipal(["settings.write"]);
    const providerManager = devicePrincipal(["providers.manage"]);
    const bridgeManager = devicePrincipal(["bridge.manage"]);

    expect(authorizeHttpRoute({ method: "PUT", path: "/api/config", principal: settingsWriter }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/agents/hana/config", principal: settingsWriter }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/preferences/models", principal: settingsWriter }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/preferences/setup-complete", principal: settingsWriter }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/user-profile", principal: settingsWriter }))
      .toMatchObject({ allowed: true });
    for (const [method, path] of [
      ["POST", "/api/avatar/user"],
      ["DELETE", "/api/avatar/user"],
      ["POST", "/api/avatar/agent"],
      ["DELETE", "/api/avatar/agent"],
      ["POST", "/api/agents/hana/avatar"],
      ["DELETE", "/api/agents/hana/avatar"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal: settingsWriter }), `${method} ${path}`)
        .toMatchObject({ allowed: true });
    }
    expect(authorizeHttpRoute({ method: "POST", path: "/api/providers/test", principal: providerManager }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/providers/fetch-models", principal: providerManager }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "GET", path: "/api/providers/deepseek/api-key", principal: providerManager }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/providers/deepseek/models/deepseek-chat", principal: providerManager }))
      .toMatchObject({ allowed: true });

    expect(authorizeHttpRoute({ method: "POST", path: "/api/bridge/config", principal: bridgeManager }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/bridge/test", principal: bridgeManager }))
      .toMatchObject({ allowed: true });

    expect(authorizeHttpRoute({ method: "POST", path: "/api/bridge/config", principal: settingsWriter }))
      .toMatchObject({ allowed: false, error: "insufficient_scope" });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/config", principal: providerManager }))
      .toMatchObject({ allowed: false, error: "insufficient_scope" });
    expect(authorizeHttpRoute({ method: "GET", path: "/api/providers/deepseek/api-key", principal: settingsWriter }))
      .toMatchObject({ allowed: false, error: "insufficient_scope", requiredScope: "providers.manage" });
  });

  it("includes required scope diagnostics when a scoped route denies access", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.ts");
    const principal = devicePrincipal(["chat"]);

    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/preferences/models",
      principal,
    })).toMatchObject({
      allowed: false,
      error: "insufficient_scope",
      reason: "missing_required_scope",
      requiredScope: "settings.read",
      policy: { kind: "scope", scope: "settings.read" },
    });
  });

  it("gates memory settings routes by settings scopes instead of studio-owner fallback", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.ts");
    const reader = devicePrincipal(["settings.read"]);
    const writer = devicePrincipal(["settings.write"]);
    const chatOnly = devicePrincipal(["chat"]);

    for (const [method, path] of [
      ["GET", "/api/memories"],
      ["GET", "/api/memories/health"],
      ["GET", "/api/memories/compiled"],
      ["GET", "/api/memories/export"],
      ["GET", "/api/memories/compiled/week/days"],
      ["GET", "/api/memories/dream/status"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal: reader }), `${method} ${path}`)
        .toMatchObject({ allowed: true });
      expect(authorizeHttpRoute({ method, path, principal: chatOnly }), `${method} ${path}`)
        .toMatchObject({ allowed: false, error: "insufficient_scope", requiredScope: "settings.read" });
    }

    for (const [method, path] of [
      ["DELETE", "/api/memories"],
      ["DELETE", "/api/memories/compiled"],
      ["POST", "/api/memories/import"],
      ["PUT", "/api/memories/compiled/facts"],
      ["PUT", "/api/memories/compiled/today"],
      ["PUT", "/api/memories/compiled/longterm"],
      ["PUT", "/api/memories/compiled/week/days/2026-07-05"],
      ["POST", "/api/memories/dream/runs"],
      ["POST", "/api/memories/dream/revisions/rev-1/restore"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal: writer }), `${method} ${path}`)
        .toMatchObject({ allowed: true });
      expect(authorizeHttpRoute({ method, path, principal: reader }), `${method} ${path}`)
        .toMatchObject({ allowed: false, error: "insufficient_scope", requiredScope: "settings.write" });
    }
  });

  it("allows scoped device access to chat identity and resources without opening admin APIs", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.ts");
    const principal = devicePrincipal(["chat", "resources.read"]);

    expect(authorizeHttpRoute({ method: "GET", path: "/api/server/identity", principal }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "GET", path: "/api/sessions", principal }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "GET", path: "/api/session-projects", principal }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/session-projects/session-assignment", principal }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "DELETE", path: "/api/session-projects/projects/project-hana", principal }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "GET", path: "/api/preferences/sidebar-ui", principal }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/preferences/sidebar-ui", principal }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "GET", path: "/api/resources/res_1", principal }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "HEAD", path: "/api/resources/res_1/content", principal }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/resources/res_1/ticket", principal }))
      .toMatchObject({ allowed: true });

    expect(authorizeHttpRoute({ method: "POST", path: "/api/resources/res_1/content", principal }))
      .toMatchObject({
        allowed: false,
        status: 403,
        error: "insufficient_scope",
      });
  });

  it("gates Studio workspace APIs by file scopes instead of local-only filtering them", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.ts");
    const reader = devicePrincipal(["files.read"]);
    const writer = devicePrincipal(["files.read", "files.write"]);
    const chatOnly = devicePrincipal(["chat"]);

    expect(authorizeHttpRoute({ method: "GET", path: "/api/studio/workspaces", principal: reader }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "GET", path: "/api/studio/workspaces/mount_docs/files", principal: reader }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/studio/workspaces", principal: writer }))
      .toMatchObject({ allowed: true });

    expect(authorizeHttpRoute({ method: "GET", path: "/api/studio/workspaces", principal: chatOnly }))
      .toMatchObject({ allowed: false, error: "insufficient_scope", requiredScope: "files.read" });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/studio/workspaces", principal: reader }))
      .toMatchObject({ allowed: false, error: "insufficient_scope", requiredScope: "files.write" });
  });

  it("allows remote plugin UI metadata, settings tabs, and iframe ticket issuance while keeping plugin route apps owner-gated", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.ts");
    const principal = devicePrincipal(["chat", "settings.read"]);
    const owner = desktopOwnerPrincipal();

    for (const [method, path] of [
      ["GET", "/api/plugins/pages"],
      ["GET", "/api/plugins/widgets"],
      ["GET", "/api/plugins/ui-host-capabilities"],
      ["GET", "/api/plugins/settings"],
      ["GET", "/api/plugins/settings-tabs"],
      ["GET", "/api/plugins/theme.css"],
      ["GET", "/api/plugins/demo/assets/dist/app.js"],
      ["HEAD", "/api/plugins/demo/assets/dist/app.js"],
      ["POST", "/api/plugins/iframe-ticket"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal }))
        .toMatchObject({ allowed: true });
    }

    expect(authorizeHttpRoute({ method: "GET", path: "/api/plugins/demo/page", principal }))
      .toMatchObject({
        allowed: false,
        status: 403,
        error: "plugin_route_forbidden",
      });
    expect(authorizeHttpRoute({ method: "GET", path: "/api/plugins/demo/page", principal: owner }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "POST", path: "/api/plugins/demo/assets/dist/app.js", principal: owner }))
      .toMatchObject({
        allowed: false,
        status: 403,
        error: "local_only_route",
      });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/plugins/demo/config", principal }))
      .toMatchObject({
        allowed: false,
        status: 403,
        error: "insufficient_scope",
      });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/plugins/demo/config", principal: owner }))
      .toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({ method: "PUT", path: "/api/plugins/settings", principal }))
      .toMatchObject({
        allowed: false,
        status: 403,
        error: "insufficient_scope",
      });
  });

  it("gates built-in MCP connector settings by settings scopes", async () => {
    const { authorizeHttpRoute, classifyHttpRoute } = await import("../server/http/route-security.ts");
    const reader = devicePrincipal(["settings.read"]);
    const writer = devicePrincipal(["settings.read", "settings.write"]);
    const chatOnly = devicePrincipal(["chat"]);

    // MCP is served at /api/mcp and at the legacy /api/plugins/mcp alias by the
    // very same handlers, so both must be classified identically — an alias that
    // classified more loosely would be an authentication bypass.
    for (const prefix of ["/api/mcp", "/api/plugins/mcp"]) {
      expect(classifyHttpRoute({ method: "GET", path: `${prefix}/oauth/callback` }))
        .toMatchObject({ kind: "public" });
      expect(authorizeHttpRoute({
        method: "GET",
        path: `${prefix}/oauth/callback`,
        principal: null,
      })).toMatchObject({ allowed: true });

      // Granting a session-scoped tool invocation changes session permission
      // state, not connector settings, so it travels with the session scope
      // rather than settings.write, exactly like /api/sessions. The handler
      // still runs the finer sessions.write capability check once it has
      // resolved the session.
      expect(classifyHttpRoute({ method: "POST", path: `${prefix}/session-permissions` }))
        .toMatchObject({ kind: "scope", scope: "chat" });
      expect(authorizeHttpRoute({
        method: "POST",
        path: `${prefix}/session-permissions`,
        principal: chatOnly,
      })).toMatchObject({ allowed: true });
      // A settings writer with no session access must not be able to widen a
      // session's permissions.
      expect(authorizeHttpRoute({
        method: "POST",
        path: `${prefix}/session-permissions`,
        principal: devicePrincipal(["settings.read", "settings.write"]),
      })).toMatchObject({ allowed: false, error: "insufficient_scope" });

      // Invoking a connector tool for an app surface is a real third-party side
      // effect, so it is owner-only rather than a settings scope.
      expect(classifyHttpRoute({
        method: "POST",
        path: `${prefix}/connectors/acme/app-tools/board/call`,
      })).toMatchObject({ kind: "studio_owner" });
      expect(authorizeHttpRoute({
        method: "POST",
        path: `${prefix}/connectors/acme/app-tools/board/call`,
        principal: writer,
      })).toMatchObject({ allowed: false });

      for (const [method, path] of [
        ["GET", `${prefix}/state`],
        ["GET", `${prefix}/apps`],
        ["GET", `${prefix}/connectors/acme/resources`],
        ["GET", `${prefix}/oauth/poll/session_1`],
      ]) {
        expect(authorizeHttpRoute({ method, path, principal: reader }))
          .toMatchObject({ allowed: true });
        expect(authorizeHttpRoute({ method, path, principal: chatOnly }))
          .toMatchObject({ allowed: false, error: "insufficient_scope" });
      }

      for (const [method, path] of [
        ["PUT", `${prefix}/settings/enabled`],
        ["PUT", `${prefix}/enabled`],
        ["POST", `${prefix}/connectors`],
        ["POST", `${prefix}/servers`],
        ["PUT", `${prefix}/connectors/github`],
        ["DELETE", `${prefix}/connectors/github`],
        ["POST", `${prefix}/connectors/github/start`],
        ["POST", `${prefix}/connectors/github/stop`],
        ["POST", `${prefix}/connectors/github/refresh-tools`],
        ["PUT", `${prefix}/agents/hana/connectors/github`],
        ["POST", `${prefix}/connectors/github/oauth/start`],
        ["POST", `${prefix}/connectors/github/oauth/logout`],
        ["POST", `${prefix}/connectors/acme/apps/board/launch`],
      ]) {
        expect(authorizeHttpRoute({ method, path, principal: writer }))
          .toMatchObject({ allowed: true });
        expect(authorizeHttpRoute({ method, path, principal: reader }))
          .toMatchObject({ allowed: false, error: "insufficient_scope" });
      }
    }
  });

  it("allows desktop owner clients to consume Studio server settings, plugins, skills, speech recognition, and connector routes", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.ts");
    const owner = desktopOwnerPrincipal();

    for (const [method, path] of [
      ["GET", "/api/agents"],
      ["GET", "/api/agents/hana/identity"],
      ["GET", "/api/agents/hana/ishiki"],
      ["GET", "/api/agents/hana/public-ishiki"],
      ["GET", "/api/agents/hana/pinned"],
      ["GET", "/api/agents/hana/experience"],
      ["GET", "/api/user-profile"],
      ["GET", "/api/preferences/notifications"],
      ["GET", "/api/preferences/computer-use"],
      ["GET", "/api/skills?agentId=hana"],
      ["GET", "/api/skills/bundles?agentId=hana"],
      ["PATCH", "/api/agents/hana/skills/imagegen"],
      ["PATCH", "/api/agents/hana/skill-bundles/story-pack"],
      ["PUT", "/api/agents/hana/skills"],
      ["POST", "/api/skills/bundles"],
      ["PUT", "/api/skills/bundles/order"],
      ["PUT", "/api/skills/bundles/story-pack"],
      ["DELETE", "/api/skills/bundles/story-pack"],
      ["POST", "/api/skills/bundles/story-pack/export"],
      ["GET", "/api/plugins?source=community"],
      ["GET", "/api/plugins/marketplace"],
      ["GET", "/api/plugins/marketplace/media-board/readme"],
      ["GET", "/api/plugins/diagnostics"],
      ["POST", "/api/media/asr/transcribe"],
      ["GET", "/api/plugins/config-schemas"],
      ["GET", "/api/plugins/media-board/config-schema"],
      ["GET", "/api/plugins/media-board/config"],
      ["PUT", "/api/plugins/media-board/config"],
      ["PUT", "/api/plugins/media-board/enabled"],
      ["DELETE", "/api/plugins/media-board"],
      ["POST", "/api/plugins/marketplace/media-board/install"],
      ["GET", "/api/plugins/mcp/state?agentId=hana"],
      ["PUT", "/api/plugins/mcp/enabled"],
      ["POST", "/api/plugins/mcp/servers"],
      ["PUT", "/api/plugins/mcp/servers/github"],
      ["DELETE", "/api/plugins/mcp/servers/github"],
      ["POST", "/api/plugins/mcp/servers/github/start"],
      ["POST", "/api/plugins/mcp/servers/github/stop"],
      ["POST", "/api/plugins/mcp/servers/github/refresh-tools"],
      ["PUT", "/api/plugins/mcp/agents/hana/servers/github"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal: owner }), `${method} ${path}`)
        .toMatchObject({ allowed: true });
    }
  });

  it("keeps mobile clients scoped away from Studio-owner settings and plugin management", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.ts");
    const principal = mobilePrincipal();

    for (const [method, path] of [
      ["GET", "/api/agents"],
      ["GET", "/api/skills?agentId=hana"],
      ["PATCH", "/api/agents/hana/skills/imagegen"],
      ["GET", "/api/plugins?source=community"],
      ["GET", "/api/plugins/marketplace"],
      ["GET", "/api/plugins/diagnostics"],
      ["PUT", "/api/plugins/media-board/config"],
      ["GET", "/api/plugins/mcp/state?agentId=hana"],
      ["PUT", "/api/plugins/mcp/enabled"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal }), `${method} ${path}`)
        .toMatchObject({ allowed: false, status: 403 });
    }
  });

  it("treats speech recognition submit as a chat action for plugin and client surfaces", async () => {
    const { authorizeHttpRoute, classifyHttpRoute } = await import("../server/http/route-security.ts");

    for (const path of ["/api/media/asr/transcribe"]) {
      expect(classifyHttpRoute({ method: "POST", path }), path)
        .toMatchObject({ kind: "scope", scope: "chat" });
      expect(authorizeHttpRoute({ method: "POST", path, principal: mobilePrincipal() }), path)
        .toMatchObject({ allowed: true });
      expect(authorizeHttpRoute({ method: "POST", path, principal: devicePrincipal(["settings.read"]) }), path)
        .toMatchObject({ allowed: false, status: 403, error: "insufficient_scope" });
    }
  });

  it("keeps explicitly client-local server actions unavailable to remote desktop owners", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.ts");
    const owner = desktopOwnerPrincipal();

    for (const [method, path] of [
      ["GET", "/api/access/summary"],
      ["PUT", "/api/access/network"],
      ["POST", "/api/access/mobile-credentials"],
      ["POST", "/api/access/desktop-credentials"],
      ["PUT", "/api/access/account/profile"],
      ["PUT", "/api/access/account/password"],
      ["DELETE", "/api/access/account/password"],
      ["POST", "/api/devices/device_1/revoke"],
      ["POST", "/api/devices/credentials/cred_1/revoke"],
      ["POST", "/api/preferences/computer-use/request-permissions"],
      ["GET", "/api/skills/external-paths"],
      ["PUT", "/api/skills/external-paths"],
      ["POST", "/api/plugins/dev/install"],
      ["POST", "/api/plugins/dev/demo/reload"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal: owner }), `${method} ${path}`)
        .toMatchObject({
          allowed: false,
          status: 403,
          error: "local_only_route",
        });
    }
  });

  it("treats browser PWA assets and web-auth login as public bootstrap routes", async () => {
    const { authorizeHttpRoute, classifyHttpRoute } = await import("../server/http/route-security.ts");

    for (const [method, path] of [
      ["GET", "/mobile/"],
      ["GET", "/mobile/assets/mobile.js"],
      ["GET", "/mobile/manifest.webmanifest"],
      ["GET", "/mobile/sw.js"],
      ["GET", "/mobile/icon.png"],
      ["GET", "/mobile/lib/i18n.js"],
      ["GET", "/mobile/themes/warm-paper.css"],
      ["GET", "/mobile/locales/zh.json"],
      ["GET", "/desktop/"],
      ["GET", "/desktop/assets/mobile.js"],
      ["GET", "/desktop/manifest.webmanifest"],
      ["GET", "/desktop/sw.js"],
      ["GET", "/desktop/icon.png"],
      ["GET", "/desktop/lib/i18n.js"],
      ["GET", "/desktop/themes/warm-paper.css"],
      ["GET", "/desktop/locales/zh.json"],
      ["POST", "/api/web-auth/login"],
      ["GET", "/api/web-auth/session"],
    ]) {
      expect(classifyHttpRoute({ method, path })).toMatchObject({ kind: "public" });
      expect(authorizeHttpRoute({ method, path, principal: null })).toMatchObject({ allowed: true });
    }
  });

  it("gates workbench routes behind explicit file scopes", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.ts");
    const reader = devicePrincipal(["chat", "files.read"]);
    const writer = devicePrincipal(["chat", "files.read", "files.write"]);

    for (const [method, path] of [
      ["GET", "/api/mobile/bootstrap"],
      ["GET", "/api/avatar/agent"],
      ["GET", "/api/agents/hana/avatar"],
      ["GET", "/api/models"],
      ["GET", "/api/models/auxiliary-vision"],
      ["POST", "/api/models/set"],
      ["POST", "/api/models/switch"],
      ["GET", "/api/session-permission-mode"],
      ["POST", "/api/session-permission-mode"],
      ["GET", "/api/preferences/session-permission-default"],
      ["PUT", "/api/preferences/session-permission-default"],
      ["GET", "/api/session-thinking-level"],
      ["POST", "/api/session-thinking-level"],
      ["POST", "/api/confirm/confirm_1"],
      ["GET", "/api/browser/session-states"],
      ["GET", "/api/mobile/workbench/files"],
      ["GET", "/api/mobile/workbench/search"],
      ["GET", "/api/mobile/workbench/content"],
      ["HEAD", "/api/mobile/workbench/content"],
      ["GET", "/api/workbench/files"],
      ["GET", "/api/workbench/search"],
      ["GET", "/api/workbench/content"],
      ["HEAD", "/api/workbench/content"],
      ["GET", "/api/desk/path"],
      ["GET", "/api/desk/files"],
      ["GET", "/api/desk/search-files"],
      ["GET", "/api/desk/jian"],
      ["GET", "/api/preferences/workspace-ui-state"],
    ]) {
      expect(authorizeHttpRoute({ method, path, principal: reader }))
        .toMatchObject({ allowed: true });
    }

    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/mobile/workbench/actions",
      principal: reader,
    })).toMatchObject({ allowed: false, error: "insufficient_scope" });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/workbench/actions",
      principal: reader,
    })).toMatchObject({ allowed: false, error: "insufficient_scope" });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/desk/beautify/cover/apply",
      principal: reader,
    })).toMatchObject({ allowed: false, error: "insufficient_scope" });
    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/preferences/models",
      principal: reader,
    })).toMatchObject({ allowed: false, error: "insufficient_scope" });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/mobile/workbench/actions",
      principal: writer,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/workbench/actions",
      principal: writer,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/workbench/upload",
      principal: writer,
    })).toMatchObject({ allowed: true });
    for (const path of [
      "/api/desk/beautify/cover/apply",
      "/api/desk/beautify/cover/preset/apply",
    ]) {
      expect(authorizeHttpRoute({ method: "POST", path, principal: writer }))
        .toMatchObject({ allowed: true });
    }
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/desk/files",
      principal: reader,
    })).toMatchObject({ allowed: false, error: "insufficient_scope" });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/desk/files",
      principal: writer,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/desk/jian",
      principal: writer,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/upload-blob",
      principal: writer,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/upload-blob",
      principal: reader,
    })).toMatchObject({ allowed: false, error: "insufficient_scope" });
    expect(authorizeHttpRoute({
      method: "PUT",
      path: "/api/preferences/workspace-ui-state",
      principal: reader,
    })).toMatchObject({ allowed: false, error: "insufficient_scope" });
    expect(authorizeHttpRoute({
      method: "PUT",
      path: "/api/preferences/workspace-ui-state",
      principal: writer,
    })).toMatchObject({ allowed: true });
  });

  it("allows scoped clients to register isolated HTML previews without exposing the rendered document API", async () => {
    const { authorizeHttpRoute, classifyHttpRoute } = await import("../server/http/route-security.ts");
    const reader = devicePrincipal(["files.read"]);
    const chatOnly = devicePrincipal(["chat"]);

    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/preview/html",
      principal: reader,
    })).toMatchObject({ allowed: true });
    expect(authorizeHttpRoute({
      method: "POST",
      path: "/api/preview/html",
      principal: chatOnly,
    })).toMatchObject({ allowed: false, error: "insufficient_scope" });

    expect(classifyHttpRoute({ method: "GET", path: "/preview/html/pv_123" }))
      .toMatchObject({ kind: "public" });
    expect(classifyHttpRoute({ method: "GET", path: "/preview/html/pv_123/assets/preview_only/images/pic.png" }))
      .toMatchObject({ kind: "public" });
    expect(authorizeHttpRoute({
      method: "GET",
      path: "/preview/html/pv_123?previewToken=preview_only",
      principal: null,
    })).toMatchObject({ allowed: true });
  });

  it("defaults unknown server API routes to Studio owner instead of hiding them from remote desktop clients", async () => {
    const { authorizeHttpRoute } = await import("../server/http/route-security.ts");

    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/new-surface",
      principal: desktopOwnerPrincipal(),
    })).toMatchObject({
      allowed: true,
    });
    expect(authorizeHttpRoute({
      method: "GET",
      path: "/api/new-surface",
      principal: mobilePrincipal(),
    })).toMatchObject({
      allowed: false,
      status: 403,
      error: "studio_owner_required",
    });
  });

  describe("plugin route proxy policy", () => {
    function pluginSurfacePrincipal(pluginId, overrides: any = {}) {
      return Object.freeze({
        kind: "plugin",
        pluginId,
        credentialKind: "plugin_surface_session",
        connectionKind: "local",
        scopes: [],
        ...overrides,
      });
    }

    it("classifies plugin proxy sub-paths as plugin_route with the plugin id", async () => {
      const { classifyHttpRoute } = await import("../server/http/route-security.ts");

      expect(classifyHttpRoute({ method: "POST", path: "/api/plugins/media-board/api/create-session" }))
        .toMatchObject({ kind: "plugin_route", pluginId: "media-board" });
      expect(classifyHttpRoute({ method: "GET", path: "/api/plugins/media-board/page" }))
        .toMatchObject({ kind: "plugin_route", pluginId: "media-board" });
    });

    it("keeps host-owned plugin management routes out of the plugin_route policy", async () => {
      const { classifyHttpRoute } = await import("../server/http/route-security.ts");

      expect(classifyHttpRoute({ method: "POST", path: "/api/plugins/dev/install" }))
        .toMatchObject({ kind: "local_only" });
      expect(classifyHttpRoute({ method: "GET", path: "/api/plugins/media-board/config" }))
        .toMatchObject({ kind: "scope", scope: "settings.read" });
      expect(classifyHttpRoute({ method: "GET", path: "/api/plugins/event-bus/capabilities" }))
        .toMatchObject({ kind: "scope", scope: "settings.read" });
      expect(classifyHttpRoute({ method: "POST", path: "/api/plugins/event-bus/capabilities" }))
        .not.toMatchObject({ kind: "plugin_route" });
      expect(classifyHttpRoute({ method: "GET", path: "/api/plugins/media-board/assets/dist/app.js" }))
        .toMatchObject({ kind: "scope", scope: "chat" });
    });

    it("authorizes matching plugin surface principals on their own plugin routes only", async () => {
      const { authorizeHttpRoute } = await import("../server/http/route-security.ts");

      expect(authorizeHttpRoute({
        method: "POST",
        path: "/api/plugins/media-board/api/create-session",
        principal: pluginSurfacePrincipal("media-board"),
      })).toMatchObject({ allowed: true });

      expect(authorizeHttpRoute({
        method: "POST",
        path: "/api/plugins/other-plugin/api/create-session",
        principal: pluginSurfacePrincipal("media-board"),
      })).toMatchObject({
        allowed: false,
        status: 403,
        error: "plugin_route_forbidden",
      });
    });

    it("keeps owner access and denies non-owner device principals on plugin routes", async () => {
      const { authorizeHttpRoute } = await import("../server/http/route-security.ts");

      expect(authorizeHttpRoute({
        method: "POST",
        path: "/api/plugins/media-board/api/create-session",
        principal: localPrincipal,
      })).toMatchObject({ allowed: true });

      expect(authorizeHttpRoute({
        method: "POST",
        path: "/api/plugins/media-board/api/create-session",
        principal: desktopOwnerPrincipal(),
      })).toMatchObject({ allowed: true });

      expect(authorizeHttpRoute({
        method: "POST",
        path: "/api/plugins/media-board/api/create-session",
        principal: mobilePrincipal(),
      })).toMatchObject({ allowed: false, status: 403, error: "plugin_route_forbidden" });

      expect(authorizeHttpRoute({
        method: "POST",
        path: "/api/plugins/media-board/api/create-session",
        principal: null,
      })).toMatchObject({ allowed: false, status: 403 });
    });

    it("does not let plugin surface principals reach host scope or studio owner routes", async () => {
      const { authorizeHttpRoute } = await import("../server/http/route-security.ts");
      const principal = pluginSurfacePrincipal("media-board");

      expect(authorizeHttpRoute({
        method: "GET",
        path: "/api/plugins/media-board/config",
        principal,
      })).toMatchObject({ allowed: false, status: 403 });
      expect(authorizeHttpRoute({
        method: "PUT",
        path: "/api/plugins/settings",
        principal,
      })).toMatchObject({ allowed: false, status: 403 });
      expect(authorizeHttpRoute({
        method: "GET",
        path: "/api/sessions",
        principal,
      })).toMatchObject({ allowed: false, status: 403 });
      expect(authorizeHttpRoute({
        method: "GET",
        path: "/api/usage/llm",
        principal,
      })).toMatchObject({ allowed: false, status: 403 });
    });
  });
});
