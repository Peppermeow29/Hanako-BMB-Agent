import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

/**
 * The config route family used to expose agent-owned resources on paths that
 * carried no agent identity, resolving the target through the server's focus
 * pointer. Those paths are gone; the per-agent front door under
 * /api/agents/:id/... is the only way in. These tests lock the removal so the
 * implicit paths cannot quietly come back.
 */

function makeEngine() {
  const agent = {
    id: "hana",
    agentDir: "/tmp/does-not-exist/agents/hana",
    systemPrompt: "prompt body",
    enabledSkills: [],
  };
  return {
    config: {},
    configPath: "/tmp/does-not-exist/config.yaml",
    currentAgentId: "hana",
    agentsDir: "/tmp/does-not-exist/agents",
    getAgent: vi.fn((id) => (id === "hana" ? agent : null)),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  };
}

async function mountConfigRoute() {
  const { createConfigRoute } = await import("../server/routes/config.ts");
  const app = new Hono();
  app.route("/api", createConfigRoute(makeEngine()));
  return app;
}

/** A handler that answered would reply with JSON; an unregistered path falls through. */
async function expectUnregistered(res: Response) {
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type") || "").not.toContain("application/json");
}

describe("config route family: no agent-implicit paths", () => {
  it("does not serve the agent system prompt without an agent identity", async () => {
    const app = await mountConfigRoute();
    await expectUnregistered(await app.request("/api/system-prompt"));
  });

  it("does not read pinned memory without an agent identity", async () => {
    const app = await mountConfigRoute();
    await expectUnregistered(await app.request("/api/pinned"));
  });

  it("does not write pinned memory without an agent identity", async () => {
    const app = await mountConfigRoute();
    await expectUnregistered(await app.request("/api/pinned", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pins: ["something"] }),
    }));
  });
});

function makeGlobalEngine(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    // engine.config is the focused agent's config — the bare route must stop reading it
    config: { agent: { name: "Hana", yuan: "hanako" }, user: { name: "Owner" }, desk: { home_folder: "/w" }, cwd_history: ["/w"] },
    configPath: "/tmp/does-not-exist/config.yaml",
    currentAgentId: "hana",
    getLocale: () => "zh-CN",
    getUserName: () => "Owner",
    providerRegistry: {
      getAllProvidersRaw: () => ({ openai: { base_url: "https://api.openai.com", api: "openai-completions", api_key: "sk-secret", models: ["gpt-5"] } }),
      get: () => null,
      saveProvider: vi.fn(),
      removeProvider: vi.fn(),
    },
    onProviderChanged: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    emitEvent: vi.fn(),
    ...overrides,
  };
}

async function mountWith(engine: Record<string, any>) {
  const { createConfigRoute } = await import("../server/routes/config.ts");
  const app = new Hono();
  app.route("/api", createConfigRoute(engine));
  return app;
}

describe("config route family: the bare config path is global-only", () => {
  it("does not answer with any agent-owned field", async () => {
    const engine = makeGlobalEngine();
    const app = await mountWith(engine);

    const res = await app.request("/api/config");
    const data = await res.json();

    expect(res.status).toBe(200);
    for (const key of ["agent", "desk", "cwd_history", "_raw"]) {
      expect(data).not.toHaveProperty(key);
    }
    // Global material stays: schema-driven global fields and the provider catalog.
    // The user's name comes from global preferences, not the focused agent's config.
    expect(data.locale).toBe("zh-CN");
    expect(data.user).toEqual({ name: "Owner" });
    expect(data.providers.openai.models).toEqual(["gpt-5"]);
    expect(data.providers.openai.api_key).not.toBe("sk-secret");
  });

  it("still accepts a provider change", async () => {
    const engine = makeGlobalEngine();
    const app = await mountWith(engine);

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: { dashscope: { api: "openai-completions", models: ["qwen-plus"] } } }),
    });

    expect(res.status).toBe(200);
    expect(engine.providerRegistry.saveProvider).toHaveBeenCalledOnce();
  });

  it("refuses an agent-owned field instead of writing it to whichever agent is focused", async () => {
    const engine = makeGlobalEngine();
    const app = await mountWith(engine);

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd_history: ["/somewhere-else"] }),
    });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain("cwd_history");
    expect(data.error).toContain("/api/agents/");
    expect(engine.updateConfig).not.toHaveBeenCalled();
  });

  it("writes the user's name to global preferences rather than to the focused agent", async () => {
    const engine = makeGlobalEngine({ setUserName: vi.fn() });
    const app = await mountWith(engine);

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: { name: "Someone Else" } }),
    });

    expect(res.status).toBe(200);
    expect(engine.setUserName).toHaveBeenCalledWith("Someone Else");
    expect(engine.updateConfig).not.toHaveBeenCalled();
  });

  it("refuses a mixed patch whole rather than saving the global half of it", async () => {
    const engine = makeGlobalEngine({ setLocale: vi.fn() });
    const app = await mountWith(engine);

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "en", agent: { name: "Renamed" } }),
    });

    expect(res.status).toBe(400);
    expect(engine.setLocale).not.toHaveBeenCalled();
    expect(engine.updateConfig).not.toHaveBeenCalled();
  });

  it("refuses inline provider credentials, which ride on an agent-owned block", async () => {
    const engine = makeGlobalEngine();
    const app = await mountWith(engine);

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api: { provider: "openai", api_key: "sk-test" } }),
    });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain("/api/agents/");
    expect(engine.providerRegistry.saveProvider).not.toHaveBeenCalled();
  });
});
