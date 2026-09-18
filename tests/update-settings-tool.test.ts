/**
 * update-settings-tool.js 注册表单元测试
 *
 * 覆盖：apply 签名、toggle boolean 转换、agent null guard
 */
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadLocale } from "../lib/i18n.ts";
import { resolveToolInvocationPermission } from "../lib/permission/tool-invocation-permission.ts";

// ── Mock 工厂 ──

function makeMockPrefs( initial: any = {}) {
  const store = { ...initial };
  return {
    getPreferences: () => ({ ...store }),
    getSandbox: () => store.sandbox !== false,
    setSandbox(v) { store.sandbox = typeof v === "string" ? v === "true" : !!v; },
    getSandboxNetwork: () => store.sandbox_network === true,
    setSandboxNetwork(v) { store.sandbox_network = typeof v === "string" ? v === "true" : !!v; },
    getLocale: () => store.locale || "",
    setLocale(v) { store.locale = v; },
    getTimezone: () => store.timezone || "",
    setTimezone(v) { store.timezone = v; },
    getExperimentValue: vi.fn((id) => store.experiments?.[id]),
    setExperimentValue: vi.fn((id, value) => {
      store.experiments = { ...(store.experiments || {}), [id]: value };
    }),
    getBridgeMediaPublicBaseUrl: () => store.bridge?.mediaPublicBaseUrl || "",
    setBridgeMediaPublicBaseUrl(v) {
      store.bridge = { ...(store.bridge || {}), mediaPublicBaseUrl: v };
    },
    getThinkingLevel: () => store.thinking_level || "medium",
    setThinkingLevel(v) { store.thinking_level = v; },
    getFileBackup: () => store.file_backup || { enabled: false, retention_days: 1, max_file_size_kb: 1024 },
    setFileBackup(v) { store.file_backup = { ...(store.file_backup || {}), ...v }; },
    _store: store,
  };
}

function makeMockEngine( overrides: any = {}) {
  const prefs = makeMockPrefs(overrides.prefsData || {});
  const focusAgentId = overrides.currentAgentId || "focus";
  const eventBus = overrides.eventBus || { request: vi.fn() };
  return {
    preferences: prefs,
    _prefs: prefs,
    currentAgentId: focusAgentId,
    agent: overrides.agent !== undefined ? overrides.agent : {
      id: overrides.agentId || "agent-test",
      memoryMasterEnabled: true,
      agentName: "TestAgent",
      userName: "TestUser",
      config: { models: { chat: "qwen-plus" } },
      updateConfig: vi.fn(),
    },
    availableModels: overrides.availableModels || [],
    getAgent: vi.fn((agentId) => {
      if (overrides.getAgent) return overrides.getAgent(agentId);
      if (agentId === focusAgentId) return { id: focusAgentId };
      return null;
    }),
    getHomeFolder: vi.fn(() => overrides.homeFolder || "/home/test"),
    setHomeFolder: vi.fn(),
    setSandbox: vi.fn(function (v) { prefs.setSandbox(v); }),
    setSandboxNetwork: vi.fn(function (v) { prefs.setSandboxNetwork(v); }),
    setFileBackup: vi.fn(function (v) { prefs.setFileBackup(v); }),
    setLocale: vi.fn(function (v) { prefs.setLocale(v); }),
    setTimezone: vi.fn(function (v) { prefs.setTimezone(v); }),
    getBridgeMediaPublicBaseUrl: vi.fn(() => prefs.getBridgeMediaPublicBaseUrl()),
    setBridgeMediaPublicBaseUrl: vi.fn(function (v) { prefs.setBridgeMediaPublicBaseUrl(v); }),
    getComputerUseSettings: vi.fn(() => prefs._store.computer_use || { enabled: false }),
    updateComputerUseSettings: vi.fn(async function (partial) {
      prefs._store.computer_use = { ...(prefs._store.computer_use || {}), ...(partial || {}) };
      return prefs._store.computer_use;
    }),
    setThinkingLevel: vi.fn(function (v) { prefs.setThinkingLevel(v); }),
    getDefaultThinkingLevel: vi.fn(() => overrides.defaultThinkingLevel || prefs.getThinkingLevel()),
    setDefaultThinkingLevel: vi.fn(async function (v) { prefs.setThinkingLevel(v); }),
    getSessionThinkingLevel: vi.fn((sessionPath) => overrides.sessionThinkingLevels?.[sessionPath] || overrides.sessionThinkingLevel || null),
    setSessionThinkingLevel: vi.fn(async () => ({ ok: true })),
    setDefaultModel: vi.fn(),
    getEventBus: vi.fn(() => eventBus),
    currentSessionPath: "/sessions/test",
    emitSessionEvent: vi.fn(),
  };
}

function makeMockConfirmStore(action = "confirmed", value = undefined) {
  return {
    create: vi.fn(() => ({
      confirmId: "test-confirm-id",
      promise: Promise.resolve({ action, value }),
    })),
  };
}

describe("update-settings-tool", () => {
  let createUpdateSettingsTool;

  beforeEach(async () => {
    loadLocale("en");
    const mod = await import("../lib/tools/update-settings-tool.ts");
    createUpdateSettingsTool = mod.createUpdateSettingsTool;
  });

  function buildTool( engineOpts: any = {}, confirmAction = "confirmed") {
    const engine = makeMockEngine(engineOpts);
    const confirmStore = makeMockConfirmStore(confirmAction);
    const tool = createUpdateSettingsTool({
      getEngine: () => engine,
      getAgent: () => engine.agent,
      getConfirmStore: () => confirmStore,
      getSessionPath: () => "/sessions/test",
      emitEvent: vi.fn(),
    });
    return { tool, engine, confirmStore };
  }

  function makeMemoryAgent(agentId = "agent-test") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-update-settings-memory-"));
    const agentDir = path.join(root, agentId);
    const memoryDir = path.join(agentDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    const agent = {
      id: agentId,
      agentDir,
      memoryMdPath: path.join(memoryDir, "memory.md"),
      memoryMasterEnabled: true,
      agentName: "TestAgent",
      userName: "TestUser",
      config: { models: { chat: "qwen-plus" } },
      summaryManager: { getAllSummaries: vi.fn(() => []) },
      updateConfig: vi.fn(),
    };
    return { root, agentDir, memoryDir, agent };
  }

  it("classifies search as read and apply as a reviewed setting target", () => {
    const { tool } = buildTool();

    expect(resolveToolInvocationPermission(tool, { action: "search", query: "theme" })).toMatchObject({
      ok: true,
      descriptor: {
        action: "search",
        kind: "read",
        capability: "update_settings.search",
      },
    });
    expect(resolveToolInvocationPermission(tool, { action: "apply", key: "theme", value: "dark" })).toMatchObject({
      ok: true,
      descriptor: {
        action: "apply",
        kind: "review",
        capability: "update_settings.apply",
        target: { type: "setting", id: "theme" },
      },
    });

    for (const key of ["sandbox", "mcp.global.enabled", "thinking_level", "timezone", "file_backup", "locale"]) {
      expect(resolveToolInvocationPermission(tool, { action: "apply", key, value: "true" }), key)
        .toMatchObject({
          ok: true,
          descriptor: { action: "apply", kind: "review", target: { id: key } },
        });
    }
    expect(resolveToolInvocationPermission(tool, { action: "apply", key: "unknown.setting", value: "x" }))
      .toMatchObject({ ok: false, error: { reason: "resolver_rejected" } });
  });

  it("apply locale executes directly and returns a settings_update payload without confirmation", async () => {
    const emitEvent = vi.fn();
    const { tool, engine, confirmStore } = buildTool({ prefsData: { locale: "zh-CN" } });
    tool.execute = createUpdateSettingsTool({
      getEngine: () => engine,
      getAgent: () => engine.agent,
      getConfirmStore: () => confirmStore,
      getSessionPath: () => "/sessions/test",
      emitEvent,
    }).execute;

    const result = await tool.execute("c-direct", { action: "apply", key: "locale", value: "en" });

    expect(confirmStore.create).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "settings_confirmation" }), expect.anything());
    expect(engine.setLocale).toHaveBeenCalledWith("en");
    expect(result.details.settingsUpdate).toMatchObject({
      status: "applied",
      action: "core.apply",
      key: "locale",
      changes: [
        expect.objectContaining({
          key: "locale",
          before: "zh-CN",
          after: "en",
        }),
      ],
    });
    expect(result.content[0].text).toContain("Locale");
  });

  describe("sandbox security boundary", () => {
    it("does not expose sandbox controls through settings search", async () => {
      const { tool } = buildTool({ prefsData: { sandbox: true, sandbox_network: false } });

      const securityResult = await tool.execute("c-sandbox-search-security", { action: "search", query: "security" });
      const networkResult = await tool.execute("c-sandbox-search-network", { action: "search", query: "sandbox" });

      expect(securityResult.content[0].text).not.toContain("sandbox");
      expect(networkResult.content[0].text).not.toContain("sandbox_network");
    });

    it("rejects legacy direct sandbox=false apply without mutating preferences", async () => {
      const { tool, engine } = buildTool({ prefsData: { sandbox: true } });
      const result = await tool.execute("c1", { action: "apply", key: "sandbox", value: "false" });

      expect(engine.setSandbox).not.toHaveBeenCalled();
      expect(engine._prefs._store.sandbox).toBe(true);
      expect(result.details.settingsUpdate).toMatchObject({
        status: "blocked",
        key: "sandbox",
      });
      expect(result.content[0].text).toContain("Settings");
    });

    it("rejects legacy direct sandbox=true apply without mutating preferences", async () => {
      const { tool, engine } = buildTool({ prefsData: { sandbox: false } });
      const result = await tool.execute("c2", { action: "apply", key: "sandbox", value: "true" });

      expect(engine.setSandbox).not.toHaveBeenCalled();
      expect(engine._prefs._store.sandbox).toBe(false);
      expect(result.details.settingsUpdate).toMatchObject({
        status: "blocked",
        key: "sandbox",
      });
    });

    it("rejects legacy direct sandbox_network apply without mutating preferences", async () => {
      const { tool, engine } = buildTool({ prefsData: { sandbox: true, sandbox_network: false } });
      const result = await tool.execute("c-network", { action: "apply", key: "sandbox_network", value: "true" });

      expect(engine.setSandboxNetwork).not.toHaveBeenCalled();
      expect(engine._prefs._store.sandbox_network).toBe(false);
      expect(engine._prefs._store.sandbox).toBe(true);
      expect(result.details.settingsUpdate).toMatchObject({
        status: "blocked",
        key: "sandbox_network",
      });
    });
  });

  describe("file_backup toggle", () => {
    it("enables file backup", async () => {
      const { tool, engine } = buildTool({ prefsData: {} });
      await tool.execute("c3", { action: "apply", key: "file_backup", value: "true" });

      expect(engine.setFileBackup).toHaveBeenCalled();
      expect(engine.setFileBackup.mock.calls[0][0]).toEqual({ enabled: true });
    });
  });

  describe("locale — 非 toggle 类型不受 parse 影响", () => {
    it("apply locale=en 传入字符串", async () => {
      const { tool, engine } = buildTool({ prefsData: { locale: "zh-CN" } });
      await tool.execute("c3", { action: "apply", key: "locale", value: "en" });

      expect(engine.setLocale).toHaveBeenCalledWith("en");
    });
  });

  describe("bridge media public URL", () => {
    it("searches the Bridge media public URL setting", async () => {
      const { tool } = buildTool();
      const result = await tool.execute("c-bridge-url-search", { action: "search", query: "public url" });
      const text = result.content[0].text;

      expect(text).toContain("bridge_media_public_base_url");
      expect(text).toContain("Bridge File Public URL");
    });

    it("applies the Bridge media public URL as a global preference", async () => {
      const { tool, engine } = buildTool();
      await tool.execute("c-bridge-url-apply", {
        action: "apply",
        key: "bridge_media_public_base_url",
        value: "https://hana.example.com",
      });

      expect(engine.setBridgeMediaPublicBaseUrl).toHaveBeenCalledWith("https://hana.example.com");
      expect(engine._prefs._store.bridge.mediaPublicBaseUrl).toBe("https://hana.example.com");
    });

    it("allows clearing the Bridge media public URL with an empty value", async () => {
      const { tool, engine } = buildTool({
        prefsData: { bridge: { mediaPublicBaseUrl: "https://hana.example.com" } },
      });
      await tool.execute("c-bridge-url-clear", {
        action: "apply",
        key: "bridge_media_public_base_url",
        value: "",
      });

      expect(engine.setBridgeMediaPublicBaseUrl).toHaveBeenCalledWith("");
      expect(engine._prefs._store.bridge.mediaPublicBaseUrl).toBe("");
    });
  });

  describe("computer use global gate", () => {
    it("searches the Computer Use global switch", async () => {
      const { tool } = buildTool();
      const result = await tool.execute("c-computer-search", { action: "search", query: "computer use" });
      const text = result.content[0].text;

      expect(text).toContain("computer_use.enabled");
      expect(text).toContain("Computer Use");
    });

    it("applies the Computer Use global switch", async () => {
      const { tool, engine } = buildTool({
        prefsData: { computer_use: { enabled: false } },
      });

      await tool.execute("c-computer-apply", {
        action: "apply",
        key: "computer_use.enabled",
        value: "true",
      });

      expect(engine.updateComputerUseSettings).toHaveBeenCalledWith({ enabled: true });
      expect(engine._prefs._store.computer_use.enabled).toBe(true);
    });
  });

  describe("thinking_level session boundary", () => {
    it("does not expose or accept legacy auto as a new setting value", async () => {
      const { tool, engine } = buildTool({ defaultThinkingLevel: "high" });

      const search = await tool.execute("c-thinking-search", { action: "search", query: "thinking" });
      expect(search.content[0].text).not.toMatch(/\bauto\b/i);

      const apply = await tool.execute("c-thinking-auto", { action: "apply", key: "thinking_level", value: "auto" });
      expect(apply.content[0].text).toContain("off");
      expect(engine.setDefaultThinkingLevel).not.toHaveBeenCalled();
    });

    it("reads the current session thinking level before the model default", async () => {
      const { tool } = buildTool({
        defaultThinkingLevel: "high",
        sessionThinkingLevels: { "/sessions/test": "off" },
      });

      const result = await tool.execute("c-thinking-get", { action: "search", query: "thinking" });

      expect(result.content[0].text).toContain("thinking_level");
      expect(result.content[0].text).toContain("off");
    });

    it("applies thinking_level to the active session when one exists (#1653)", async () => {
      const { tool, engine } = buildTool({
        defaultThinkingLevel: "high",
        sessionThinkingLevels: { "/sessions/test": "high" },
      });

      await tool.execute("c-thinking-apply", { action: "apply", key: "thinking_level", value: "off" });

      expect(engine.setSessionThinkingLevel).toHaveBeenCalledWith("/sessions/test", "off");
      expect(engine.setDefaultThinkingLevel).not.toHaveBeenCalled();
    });

    it("falls back to the model default when there is no active session", async () => {
      const { tool, engine } = buildTool({ defaultThinkingLevel: "medium" });
      engine.currentSessionPath = null;

      await tool.execute("c-thinking-default", { action: "apply", key: "thinking_level", value: "low" });

      expect(engine.setSessionThinkingLevel).not.toHaveBeenCalled();
      expect(engine.setDefaultThinkingLevel).toHaveBeenCalledWith("low");
    });
  });

  describe("models.chat — 复合键写路径", () => {
    it("apply models.chat 使用 provider/id 调 engine.setDefaultModel", async () => {
      const { tool, engine } = buildTool({
        agentId: "owner",
        getAgent: (agentId) => (agentId === "owner" ? { id: "owner" } : null),
        availableModels: [
          { id: "gpt-4o", provider: "openai", name: "GPT-4o" },
        ],
      });

      await tool.execute("c-model", { action: "apply", key: "models.chat", value: "openai/gpt-4o" });

      expect(engine.setDefaultModel).toHaveBeenCalledWith("gpt-4o", "openai", { agentId: "owner" });
      expect(engine.agent.updateConfig).not.toHaveBeenCalled();
    });

    it("models.chat 仍写回工具所属 agent，而不是当前 focus agent", async () => {
      const ownerAgent = {
        id: "owner",
        memoryMasterEnabled: true,
        agentName: "Owner",
        userName: "User",
        config: { models: { chat: "openai/gpt-4o" } },
        updateConfig: vi.fn(),
      };
      const engine = makeMockEngine({
        agent: ownerAgent,
        currentAgentId: "focus",
        getAgent: (agentId) => (agentId === "owner" ? ownerAgent : { id: agentId }),
        availableModels: [{ id: "gpt-4o", provider: "openai", name: "GPT-4o" }],
      });
      const tool = createUpdateSettingsTool({
        getEngine: () => engine,
        getAgent: () => ownerAgent,
        getConfirmStore: () => makeMockConfirmStore(),
        getSessionPath: () => "/sessions/test",
        emitEvent: vi.fn(),
      });

      engine.currentAgentId = "other";
      await tool.execute("c-model-switch", { action: "apply", key: "models.chat", value: "openai/gpt-4o" });

      expect(engine.setDefaultModel).toHaveBeenCalledWith("gpt-4o", "openai", { agentId: "owner" });
    });
  });

  describe("agent-scoped routing", () => {
    it("home_folder apply 使用工具所属 agent，而不是当前 focus agent", async () => {
      const ownerAgent = {
        id: "owner",
        memoryMasterEnabled: true,
        agentName: "Owner",
        userName: "User",
        config: { models: { chat: "openai/gpt-4o" } },
        updateConfig: vi.fn(),
      };
      const engine = makeMockEngine({
        agent: ownerAgent,
        currentAgentId: "focus",
        getAgent: (agentId) => (agentId === "owner" ? ownerAgent : { id: agentId }),
      });
      const tool = createUpdateSettingsTool({
        getEngine: () => engine,
        getAgent: () => ownerAgent,
        getConfirmStore: () => makeMockConfirmStore(),
        getSessionPath: () => "/sessions/test",
        emitEvent: vi.fn(),
      });

      engine.currentAgentId = "other";
      await tool.execute("c-home-folder", { action: "apply", key: "home_folder", value: "/tmp/owner-home" });

      expect(engine.setHomeFolder).toHaveBeenCalledWith("owner", "/tmp/owner-home");
    });

    it("home_folder 在 agent=null 时返回错误", async () => {
      const { tool } = buildTool({ agent: null });
      const result = await tool.execute("c-home-null", { action: "apply", key: "home_folder", value: "/tmp/x" });
      const text = result.content[0].text;
      expect(text).not.toContain("已将");
    });
  });

  describe("agent-scoped null guard", () => {
    it("get memory.enabled 在 agent=null 时不返回 true", async () => {
      const { tool } = buildTool({ agent: null });
      const result = await tool.execute("c4", { action: "search", query: "memory" });
      const text = result.content[0].text;
      expect(text).not.toContain("→ true");
      expect(text).toContain("N/A");
    });

    it("apply memory.enabled 在 agent=null 时返回错误", async () => {
      const { tool } = buildTool({ agent: null });
      const result = await tool.execute("c5", { action: "apply", key: "memory.enabled", value: "true" });
      const text = result.content[0].text;
      expect(text).not.toContain("已将");
    });

    it("get agent.name 在 agent=null 时返回 N/A", async () => {
      const { tool } = buildTool({ agent: null });
      const result = await tool.execute("c6", { action: "search", query: "agent.name" });
      const text = result.content[0].text;
      expect(text).toContain("N/A");
    });
  });

  describe("memory.facts (facts.md is the sole canonical path, no experiment gate)", () => {
    it("writes facts straight to facts.md and rebuilds memory.md with no opt-in required", async () => {
      const { root, memoryDir, agent } = makeMemoryAgent("owner");
      try {
        fs.writeFileSync(path.join(memoryDir, "facts.md"), "Old facts.\n", "utf-8");
        fs.writeFileSync(path.join(memoryDir, "today.md"), "Today stays read-only.\n", "utf-8");
        fs.writeFileSync(path.join(memoryDir, "week.md"), "Week stays read-only.\n", "utf-8");
        fs.writeFileSync(path.join(memoryDir, "longterm.md"), "Long-term stays read-only.\n", "utf-8");
        // 没有任何 experiments 配置：转正后 memory.facts 不受实验开关限制。
        const { tool } = buildTool({
          agent,
          currentAgentId: "owner",
          getAgent: (agentId) => (agentId === "owner" ? agent : null),
        });

        const result = await tool.execute("c-memory-facts", {
          action: "apply",
          key: "memory.facts",
          value: "User likes clean boundaries.",
        });

        expect(result.details.settingsUpdate).toMatchObject({
          status: "applied",
          key: "memory.facts",
        });
        expect(fs.readFileSync(path.join(memoryDir, "facts.md"), "utf-8")).toBe("User likes clean boundaries.\n");
        const compiled = fs.readFileSync(path.join(memoryDir, "memory.md"), "utf-8");
        expect(compiled).toContain("## Key facts");
        expect(compiled).toContain("User likes clean boundaries.");
        expect(compiled).toContain("Today stays read-only.");
        expect(compiled).toContain("Week stays read-only.");
        expect(compiled).toContain("Long-term stays read-only.");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("reads current facts.md content back through the get action", async () => {
      const { root, memoryDir, agent } = makeMemoryAgent("owner");
      try {
        fs.writeFileSync(path.join(memoryDir, "facts.md"), "User likes clean boundaries.\n", "utf-8");
        const { tool } = buildTool({
          agent,
          currentAgentId: "owner",
          getAgent: (agentId) => (agentId === "owner" ? agent : null),
        });

        const result = await tool.execute("c-memory-facts-get", {
          action: "search",
          query: "memory.facts",
        });

        expect(result.content[0].text).toContain("User likes clean boundaries.");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("theme options 包含 new-warm-paper（此前遗漏，本次补齐）", () => {
    it("search 'theme' 结果中 options 包含 new-warm-paper", async () => {
      const { tool } = buildTool();
      const result = await tool.execute("c9", { action: "search", query: "theme" });
      const text = result.content[0].text;
      expect(text).toContain("new-warm-paper");
      expect(text).not.toContain("claude-design");
    });

    it("search 'theme' 结果中 options 包含全部 12 个选项（11 主题 + auto）", async () => {
      const { tool } = buildTool();
      const result = await tool.execute("c10", { action: "search", query: "theme" });
      const text = result.content[0].text;
      // 验证原有主题 + 珊瑚 + 高对比暗色 + auto 均存在
      for (const id of ["warm-paper", "midnight", "high-contrast", "grass-aroma", "contemplation", "absolutely", "delve", "deep-think", "new-warm-paper", "coral", "midnight-contrast", "auto"]) {
        expect(text).toContain(id);
      }
    });
  });

  describe("MCP settings actions", () => {
    it("routes MCP connector add through the backend event bus with the tool owner agent", async () => {
      const request = vi.fn(async () => ({
        settingsUpdate: {
          status: "applied",
          action: "mcp.connector.add",
          key: "mcp.connector.github",
          title: "MCP connector added",
          summary: "Added GitHub.",
          changes: [{ key: "mcp.connector.github", label: "GitHub", before: "", after: "added" }],
        },
      }));
      const { tool, confirmStore } = buildTool({
        agentId: "owner",
        eventBus: { request },
      });

      const result = await tool.execute("c-mcp-add", {
        action: "apply",
        key: "mcp.connector.add",
        value: JSON.stringify({
          name: "GitHub",
          transport: "remote",
          url: "https://mcp.github.com/mcp",
          authType: "bearer",
          authorizationToken: "secret-token",
        }),
      });

      expect(confirmStore.create).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledWith("mcp:settings-action", {
        action: "mcp.connector.add",
        agentId: "owner",
        payload: {
          name: "GitHub",
          transport: "remote",
          url: "https://mcp.github.com/mcp",
          authType: "bearer",
          authorizationToken: "secret-token",
        },
      });
      expect(result.details.settingsUpdate).toMatchObject({
        action: "mcp.connector.add",
        status: "applied",
      });
    });
  });
});
