import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createSettingsSnapshotRoute } from "../server/routes/settings-snapshot.ts";
import { MASKED_SECRET } from "../shared/secret-custody.ts";

let tmpRoot: string | null = null;

async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

async function writeJson(filePath: string, data: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

async function writeServerIdentity(root: string) {
  await writeJson(path.join(root, "server-node.json"), {
    schemaVersion: 1,
    serverId: "server_snapshot",
    label: "Snapshot Server",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
  await writeJson(path.join(root, "users.json"), {
    schemaVersion: 1,
    defaultUserId: "user_owner",
    users: [{
      userId: "user_owner",
      kind: "legacy_owner",
      displayName: "Owner",
      profileSource: "legacy_user_profile",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    }],
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
  await writeJson(path.join(root, "studios.json"), {
    schemaVersion: 1,
    defaultStudioId: "studio_home",
    studios: [{
      studioId: "studio_home",
      ownerUserId: "user_owner",
      label: "Home Studio",
      kind: "personal",
      storage: { provider: "legacy_hana_home", legacyRoot: true },
      membershipModel: "single_user_implicit",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    }],
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
}

function localOwner() {
  return {
    kind: "local_user",
    credentialKind: "loopback_token",
    connectionKind: "local",
    serverId: "server_snapshot",
    serverNodeId: "server_snapshot",
    userId: "user_owner",
    studioId: "studio_home",
    scopes: ["settings.read", "settings.write", "bridge.manage"],
  };
}

async function makeEngine() {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hana-settings-snapshot-"));
  const agentsDir = path.join(tmpRoot, "agents");
  const userDir = path.join(tmpRoot, "user");
  const agentDir = path.join(agentsDir, "agent-a");
  await writeServerIdentity(tmpRoot);
  await writeJson(path.join(tmpRoot, "server-network.json"), {
    schemaVersion: 1,
    mode: "lan",
    listenHost: "0.0.0.0",
    listenPort: 14500,
    customRemote: { enabled: false, baseUrl: null, wsUrl: null },
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  });
  await writeFile(path.join(agentDir, "config.yaml"), [
    "agent:",
    "  name: Agent A",
    "desk:",
    "  home_folder: /tmp/agent-a",
    "memory:",
    "  enabled: false",
    "experience:",
    "  enabled: false",
    "bridge:",
    "  telegram:",
    "    token: tg-secret",
    "    enabled: true",
    "",
  ].join("\n"));
  await writeFile(path.join(agentDir, "identity.md"), "identity");
  await writeFile(path.join(agentDir, "AGENTS.md"), "persona");
  await writeFile(path.join(agentDir, "AGENTS.public.md"), "public");
  await writeFile(path.join(agentDir, "pinned.md"), "keep this");
  await writeFile(path.join(userDir, "user.md"), "user profile");

  return {
    hanakoHome: tmpRoot,
    agentsDir,
    productDir: path.join(tmpRoot, "product"),
    userDir,
    currentAgentId: "agent-a",
    listAgents: () => [{ id: "agent-a", name: "Agent A" }],
    getAgent: () => ({ tools: [] }),
    providerRegistry: {
      getAllProvidersRaw: () => ({}),
      get: () => null,
    },
    pluginManager: {
      getAllTools: () => [],
      getAllowFullAccess: () => false,
      getUserPluginsDir: () => path.join(userDir, "plugins"),
      getSettingsTabs: () => [],
    },
    preferences: {
      getExperimentValue: () => undefined,
    },
    getComputerUseSettings: () => ({ enabled: false }),
    getSharedModels: () => ({ utility: { id: "utility" }, utility_large: { id: "utility-large" } }),
    getThinkingLevel: () => "medium",
    getSearchConfig: () => ({ provider: "", api_key: "", api_keys: {} }),
    getUtilityApi: () => ({ provider: "", base_url: "", api_key: "" }),
    getQuickChatPreferences: () => ({ shortcut: "CommandOrControl+Shift+K", reuseTimeoutMinutes: 12 }),
    getNotificationPreferences: () => ({
      chatCompletion: "when_session_unfocused",
      scheduledTaskCompletion: "always",
      patrolCompletion: "when_unfocused",
    }),
    getBridgePermissionMode: () => "operate",
    getBridgeReadOnly: () => false,
    getBridgeReceiptEnabled: () => false,
    getBridgeRichStreamingEnabled: () => true,
    getBridgeIndex: () => ({}),
    getSpeechRecognitionConfig: () => ({ enabled: false }),
    getKeepAwake: () => false,
    getHeartbeatMaster: () => false,
    getAutomationPermissionMode: () => "auto",
  };
}

describe("settings snapshot route", () => {
  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  it("returns one settings snapshot without losing explicit false values", async () => {
    const engine = await makeEngine();
    const app = new Hono();
    app.route("/api", createSettingsSnapshotRoute(engine));

    const res = await app.request("/api/settings/snapshot?agentId=agent-a");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.agentId).toBe("agent-a");
    expect(body.config.agent.name).toBe("Agent A");
    expect(body.config.memory.enabled).toBe(false);
    expect(body.config.keep_awake).toBe(false);
    expect(body.config.desk.heartbeat_master).toBe(false);
    expect(body.preferences.bridge).toEqual({
      permissionMode: "operate",
      readOnly: false,
      receiptEnabled: false,
      richStreamingEnabled: true,
    });
    expect(body.preferences.speechRecognition.enabled).toBe(false);
    expect(body.plugins.allowFullAccess).toBe(false);
    expect(body.plugins.devToolsEnabled).toBe(false);
    expect(body.identity).toBe("identity");
    expect(body.agents).toBe("persona");
    expect(body.publicAgents).toBe("public");
    expect(body.userProfile).toBe("user profile");
  });

  it("falls back to template content for identity/AGENTS.md when the agent has not customized them (lazy materialization)", async () => {
    const engine = await makeEngine();
    const agentDir = path.join(engine.agentsDir, "agent-a");
    // 惰性材料化：模拟一个从未定制过人格的 agent，identity.md/AGENTS.md 都
    // 没有落盘（覆盖掉 makeEngine 里默认写好的两个落盘文件）。
    await fs.rm(path.join(agentDir, "identity.md"));
    await fs.rm(path.join(agentDir, "AGENTS.md"));
    const productDir = path.join(tmpRoot!, "product");
    await writeFile(path.join(productDir, "identity-templates", "hanako.md"), "Template identity content");
    await writeFile(path.join(productDir, "agents-templates", "hanako.md"), "Template persona content");
    (engine as any).productDir = productDir;

    const app = new Hono();
    app.route("/api", createSettingsSnapshotRoute(engine));

    const res = await app.request("/api/settings/snapshot?agentId=agent-a");
    expect(res.status).toBe(200);
    const body = await res.json();

    // 快照必须反映 agent 此刻实际生效的内容（回落到模板），不能是空字符串。
    expect(body.identity).toBe("Template identity content");
    expect(body.agents).toBe("Template persona content");
    // AGENTS.public.md 不在本次惰性材料化范围内，行为不变（原样读落盘文件）。
    expect(body.publicAgents).toBe("public");
  });

  it("answers for the primary agent when the request omits an agent id", async () => {
    const engine = await makeEngine();
    // A second agent the server happens to be focused on. A bare snapshot
    // request must describe the primary agent, not whoever holds the focus.
    const otherDir = path.join(engine.agentsDir, "agent-b");
    await writeFile(path.join(otherDir, "config.yaml"), "agent:\n  name: Agent B\n");
    (engine as any).currentAgentId = "agent-b";
    (engine as any).getPrimaryAgentId = () => "agent-a";
    (engine as any).listAgents = () => [
      { id: "agent-b", name: "Agent B" },
      { id: "agent-a", name: "Agent A" },
    ];
    const app = new Hono();
    app.route("/api", createSettingsSnapshotRoute(engine));

    const res = await app.request("/api/settings/snapshot");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentId).toBe("agent-a");
    expect(body.config.agent.name).toBe("Agent A");
  });

  it("reports an error for a bare request when no primary agent is configured", async () => {
    const engine = await makeEngine();
    (engine as any).currentAgentId = "agent-a";
    (engine as any).getPrimaryAgentId = () => null;
    const app = new Hono();
    app.route("/api", createSettingsSnapshotRoute(engine));

    const res = await app.request("/api/settings/snapshot");

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("settings snapshot agent not found");
  });

  it("accepts a safe legacy uppercase and underscore agent id", async () => {
    const engine = await makeEngine();
    const legacyId = "Legacy_AGENT-1";
    await fs.rename(
      path.join(engine.agentsDir, "agent-a"),
      path.join(engine.agentsDir, legacyId),
    );
    const app = new Hono();
    app.route("/api", createSettingsSnapshotRoute(engine));

    const res = await app.request(`/api/settings/snapshot?agentId=${legacyId}`);

    expect(res.status).toBe(200);
    expect((await res.json()).agentId).toBe(legacyId);
  });

  it("includes first-frame access and bridge truth in the unified settings snapshot", async () => {
    const engine = await makeEngine();
    const bridgeManager = {
      getStatus: () => ({
        telegram: { status: "connected", error: null },
      }),
    };
    const app = new Hono();
    app.use("*", async (c, next) => {
      (c as any).set("authPrincipal", Object.freeze(localOwner()));
      await next();
    });
    app.route("/api", createSettingsSnapshotRoute(engine, {
      bridgeManagerRef: bridgeManager,
      runtimeState: { mode: "lan", listenHost: "0.0.0.0", actualPort: 14500 },
      listLanAddresses: () => ["192.168.31.75"],
    } as any));

    const res = await app.request("/api/settings/snapshot?agentId=agent-a");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.access.network).toMatchObject({
      mode: "lan",
      listenHost: "0.0.0.0",
      actualPort: 14500,
      lanMobileUrl: "http://192.168.31.75:14500/mobile/",
      restartRequired: false,
    });
    expect(body.bridgeStatus).toMatchObject({
      agentId: "agent-a",
      telegram: {
        enabled: false,
        configured: true,
        supported: false,
        status: "disconnected",
        agentId: "agent-a",
      },
      permissionMode: "operate",
      readOnly: false,
      receiptEnabled: false,
      richStreamingEnabled: true,
    });
    expect(JSON.stringify(body)).not.toContain("tg-secret");
  });

  it("redacts DingTalk credential aliases from the real settings snapshot response", async () => {
    const engine = await makeEngine();
    await writeFile(path.join(engine.agentsDir, "agent-a", "config.yaml"), [
      "agent:",
      "  name: Agent A",
      "bridge:",
      "  dingtalk:",
      "    appSecret: test-only-app-secret",
      "    clientSecret: test-only-client-secret",
      "    corpSecret: test-only-corp-secret",
      "    webhookSecret: test-only-webhook-secret",
      "    webhookToken: test-only-webhook-token",
      "    robotToken: test-only-robot-token",
      "    oauthClientSecret: test-only-oauth-client-secret",
      "    suiteSecret: test-only-suite-secret",
      "    clientSecretLabel: visible label",
      "",
    ].join("\n"));
    const app = new Hono();
    app.route("/api", createSettingsSnapshotRoute(engine));

    const res = await app.request("/api/settings/snapshot?agentId=agent-a");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.config.bridge.dingtalk).toEqual({
      appSecret: MASKED_SECRET,
      clientSecret: MASKED_SECRET,
      corpSecret: MASKED_SECRET,
      webhookSecret: MASKED_SECRET,
      webhookToken: MASKED_SECRET,
      robotToken: MASKED_SECRET,
      oauthClientSecret: MASKED_SECRET,
      suiteSecret: MASKED_SECRET,
      clientSecretLabel: "visible label",
    });
    const serializedConfig = JSON.stringify(body.config);
    for (const secretMarker of [
      "test-only-app-secret",
      "test-only-client-secret",
      "test-only-corp-secret",
      "test-only-webhook-secret",
      "test-only-webhook-token",
      "test-only-robot-token",
      "test-only-oauth-client-secret",
      "test-only-suite-secret",
    ]) {
      expect(serializedConfig).not.toContain(secretMarker);
    }
  });

  it("includes first-frame Computer Use truth in the unified settings snapshot", async () => {
    const engine: any = await makeEngine();
    engine.getComputerUseSettings = vi.fn(() => ({
      enabled: true,
      provider_by_platform: { darwin: "macos:cua", win32: "windows:uia", linux: "mock" },
      allow_windows_input_injection: false,
      app_approvals: [{
        providerId: "macos:cua",
        appId: "com.apple.calculator",
        appName: "Calculator",
      }],
    }));
    engine.getComputerHost = vi.fn(() => ({
      getStatus: vi.fn(async () => ({
        enabled: true,
        selectedProviderId: "macos:cua",
        providers: [{
          providerId: "macos:cua",
          status: {
            available: true,
            permissions: [{ name: "Accessibility", granted: true }],
          },
        }],
        activeLease: null,
      })),
    }));

    const app = new Hono();
    app.route("/api", createSettingsSnapshotRoute(engine, { platform: "darwin" }));

    const res = await app.request("/api/settings/snapshot?agentId=agent-a");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(engine.getComputerHost).not.toHaveBeenCalled();
    expect(body.preferences.computerUse).toMatchObject({
      selectedProviderId: null,
      settings: { enabled: false, app_approvals: [{ appId: "com.apple.calculator" }] },
      status: { enabled: false, supported: false, providers: [], activeLease: null },
    });
  });
});
