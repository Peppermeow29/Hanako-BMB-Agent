import { describe, expect, it, vi } from "vitest";
import { ConfigCoordinator } from "../core/config-coordinator.ts";
import {
  BROWSER_SEARCH_PROVIDER_IDS,
  SEARCH_FREE_API_PROVIDER_IDS,
  SEARCH_API_PROVIDER_IDS,
  SEARCH_CAPABILITY_KIND,
  SEARCH_CAPABILITY_PROVIDERS,
} from "../shared/search-providers.ts";

function makeCoordinator(initialPrefs = {}) {
  let prefs = { ...initialPrefs };
  const savePreferences = vi.fn((next) => {
    prefs = { ...next };
  });
  const coord = new ConfigCoordinator({
    hanakoHome: "/tmp/test",
    agentsDir: "/tmp/test/agents",
    getAgent: () => null,
    getAgentById: () => null,
    getActiveAgentId: () => null,
    getAgents: () => new Map(),
    getModels: () => ({ availableModels: [] }),
    getPrefs: () => ({
      getPreferences: () => prefs,
      savePreferences,
    }),
    getSkills: () => null,
    getSession: () => null,
    getSessionCoordinator: () => null,
    getHub: () => null,
    emitEvent: vi.fn(),
    emitDevLog: vi.fn(),
    getCurrentModel: () => null,
  });
  return {
    coord,
    savePreferences,
    get prefs() {
      return prefs;
    },
  };
}

describe("search config preferences", () => {
  it("describes built-in search providers as a provider catalog capability", () => {
    expect(SEARCH_CAPABILITY_KIND).toBe("web.search");
    expect(SEARCH_CAPABILITY_PROVIDERS).toEqual([
      ...SEARCH_API_PROVIDER_IDS.map((id) => ({ id, source: "api", requiresApiKey: true })),
      ...SEARCH_FREE_API_PROVIDER_IDS.map((id) => ({ id, source: "api", requiresApiKey: false })),
      ...BROWSER_SEARCH_PROVIDER_IDS.map((id) => ({ id, source: "browser", requiresApiKey: false })),
    ]);
  });

  it("defaults to auto search when no provider is configured", () => {
    const { coord } = makeCoordinator();

    expect(coord.getSearchConfig()).toEqual({
      provider: "auto",
      api_key: null,
      api_keys: {},
    });
  });

  it("exposes legacy single API keys through the provider-key map", () => {
    const { coord } = makeCoordinator({
      search_provider: "brave",
      search_api_key: "brave-secret",
    });

    expect(coord.getSearchConfig()).toEqual({
      provider: "brave",
      api_key: "brave-secret",
      api_keys: { brave: "brave-secret" },
    });
  });

  it("stores multiple search API keys without losing unrelated providers", () => {
    const state = makeCoordinator({
      search_provider: "tavily",
      search_api_key: "old-tvly",
      search_api_keys: { anysearch: "old-anysearch", brave: "old-brave" },
    });

    state.coord.setSearchConfig({
      provider: "auto",
      api_keys: { tavily: "new-tvly" },
    });

    expect(state.prefs).toMatchObject({
      search_provider: "auto",
      search_api_keys: {
        anysearch: "old-anysearch",
        tavily: "new-tvly",
        brave: "old-brave",
      },
    });
    expect(state.prefs).not.toHaveProperty("search_api_key");
  });

  it("keeps legacy api_key only for an explicitly selected API provider", () => {
    const state = makeCoordinator({
      search_provider: "auto",
      search_api_keys: { anysearch: "anysearch-secret", tavily: "tvly-secret", brave: "brave-secret" },
    });

    state.coord.setSearchConfig({ provider: "anysearch" });

    expect(state.prefs).toMatchObject({
      search_provider: "anysearch",
      search_api_key: "anysearch-secret",
      search_api_keys: {
        anysearch: "anysearch-secret",
        tavily: "tvly-secret",
        brave: "brave-secret",
      },
    });
  });

  it("keeps AnySearch free as a selectable keyless provider", () => {
    const state = makeCoordinator({
      search_provider: "anysearch",
      search_api_key: "anysearch-secret",
      search_api_keys: { anysearch: "anysearch-secret" },
    });

    state.coord.setSearchConfig({ provider: "anysearch_free" });

    expect(state.coord.getSearchConfig()).toEqual({
      provider: "anysearch_free",
      api_key: null,
      api_keys: { anysearch: "anysearch-secret" },
    });
    expect(state.prefs).toMatchObject({
      search_provider: "anysearch_free",
      search_api_keys: { anysearch: "anysearch-secret" },
    });
    expect(state.prefs).not.toHaveProperty("search_api_key");
  });
});
