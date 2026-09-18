import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchWebMock = vi.fn();

vi.mock("../lib/browser/browser-manager.js", () => ({
  BrowserManager: {
    instance: () => ({
      searchWeb: searchWebMock,
    }),
  },
}));

import {
  createWebSearchTool,
  resetWebSearchRateLimiterForTests,
  searchProviderRequiresApiKey,
  verifySearchKey,
} from "../lib/tools/web-search.ts";

describe("web_search browser providers", () => {
  beforeEach(() => {
    searchWebMock.mockReset();
    resetWebSearchRateLimiterForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not require API keys for browser-backed providers", async () => {
    expect(searchProviderRequiresApiKey("auto")).toBe(false);
    expect(searchProviderRequiresApiKey("anysearch")).toBe(true);
    expect(searchProviderRequiresApiKey("anysearch_free")).toBe(false);
    expect(searchProviderRequiresApiKey("bing_browser")).toBe(false);
    expect(searchProviderRequiresApiKey("google_browser")).toBe(false);
    expect(searchProviderRequiresApiKey("duckduckgo_browser")).toBe(false);
    await expect(verifySearchKey("auto", "")).resolves.toBe(true);
    await expect(verifySearchKey("anysearch_free", "")).resolves.toBe(true);
    await expect(verifySearchKey("bing_browser", "")).resolves.toBe(true);
  });

  it("returns Tavily-like structured details from a browser provider", async () => {
    searchWebMock.mockResolvedValue({
      query: "hana search",
      provider: "bing_browser",
      source_type: "browser",
      results: [
        {
          title: "Result",
          url: "https://example.com",
          content: "Snippet",
          rank: 1,
          score: null,
          metadata: { display_url: "example.com", engine: "bing" },
        },
      ],
      diagnostics: {
        final_url: "https://www.bing.com/search?q=hana+search",
        blocked: false,
        captcha: false,
        elapsed_ms: 1234,
      },
    });

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "bing_browser", api_key: "" }),
    });
    const result = await tool.execute("call-1", { query: "hana search", maxResults: 3 });

    expect(searchWebMock).toHaveBeenCalledWith({
      provider: "bing_browser",
      query: "hana search",
      maxResults: 3,
      locale: "zh",
    });
    expect(result.details).toMatchObject({
      query: "hana search",
      provider: "bing_browser",
      source_type: "browser",
      results: [
        {
          title: "Result",
          url: "https://example.com",
          content: "Snippet",
          rank: 1,
          metadata: { engine: "bing" },
        },
      ],
      diagnostics: {
        blocked: false,
        captcha: false,
      },
    });
    expect(result.content[0].type).toBe("text");
  });

  it("routes provider execution through the injected rate limiter", async () => {
    searchWebMock.mockResolvedValue({
      query: "hana limited",
      provider: "bing_browser",
      source_type: "browser",
      results: [
        {
          title: "Limited Result",
          url: "https://example.com/limited",
          content: "Limited snippet",
          rank: 1,
          score: null,
          metadata: { engine: "bing" },
        },
      ],
      diagnostics: { blocked: false, captcha: false },
    });
    const rateLimiter = {
      run: vi.fn(async (_provider, _sourceType, operation) => operation()),
    };

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "bing_browser", api_key: "" }),
      rateLimiter,
    });
    const result = await tool.execute("call-limited", { query: "hana limited", maxResults: 1 });

    expect(result.details.results).toHaveLength(1);
    expect(rateLimiter.run).toHaveBeenCalledWith(
      "bing_browser",
      "browser",
      expect.any(Function),
    );
  });

  it("surfaces API 429 responses as rate limit errors with Retry-After", async () => {
    let capturedError = null;
    const rateLimiter = {
      run: vi.fn(async (_provider, _sourceType, operation) => {
        try {
          return await operation();
        } catch (err) {
          capturedError = err;
          throw err;
        }
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "too many requests" }),
      {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "3" },
      },
    )));

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "brave", api_key: "test-key" }),
      rateLimiter,
    });
    await tool.execute("call-429", { query: "hana limited", maxResults: 1 });

    expect(rateLimiter.run).toHaveBeenCalledWith("brave", "api", expect.any(Function));
    expect(capturedError).toMatchObject({
      name: "SearchRateLimitError",
      status: 429,
      retryAfterMs: 3_000,
    });
  });

  it("fetches a broader AnySearch candidate set by default while formatting ten results", async () => {
    const anySearchResults = Array.from({ length: 20 }, (_, index) => ({
      title: `AnySearch Result ${index + 1}`,
      url: `https://example.com/anysearch-${index + 1}`,
      description: `AnySearch description ${index + 1}`,
      content: `AnySearch content ${index + 1}`,
      score: 100 - index,
      quality_score: 90 - index,
    }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        code: 0,
        message: "success",
        data: {
          results: anySearchResults,
          metadata: {
            total_results: 20,
            search_time_ms: 123,
            request_id: "req-anysearch-broad",
            cached: false,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "auto", api_keys: {} }),
    });
    const result = await tool.execute("call-anysearch-broad-default", {
      query: "hana broad default",
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      query: "hana broad default",
      max_results: 20,
    });
    expect(result.details.results).toHaveLength(20);
    expect(result.content[0].text).toContain("10. **AnySearch Result 10**");
    expect(result.content[0].text).not.toContain("11. **AnySearch Result 11**");
  });

  it("calls paid AnySearch with a bearer token and keeps free diagnostics separate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        code: 0,
        message: "success",
        data: {
          results: [
            {
              title: "Paid AnySearch Result",
              url: "https://example.com/paid-anysearch",
              snippet: "Paid AnySearch snippet",
              content: "Paid AnySearch content",
            },
          ],
          metadata: {
            total_results: 1,
            search_time_ms: 88,
            request_id: "req-anysearch-paid",
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "anysearch", api_key: "anysearch-secret" }),
    });
    const result = await tool.execute("call-anysearch-paid", {
      query: "hana paid anysearch",
      maxResults: 3,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.anysearch.com/v1/search");
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      "Content-Type": "application/json",
      "Authorization": "Bearer anysearch-secret",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      query: "hana paid anysearch",
      max_results: 3,
    });
    expect(result.details).toMatchObject({
      provider: "anysearch",
      source_type: "api",
      diagnostics: {
        anonymous: false,
        request_id: "req-anysearch-paid",
      },
      results: [
        {
          title: "Paid AnySearch Result",
          url: "https://example.com/paid-anysearch",
          content: "Paid AnySearch content",
        },
      ],
    });
  });

  it("clamps Tavily requests to its official result ceiling", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        results: [
          { title: "Tavily Result", url: "https://example.com/tavily", content: "Tavily snippet" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "tavily", api_key: "tvly-key" }),
    });
    await tool.execute("call-tavily-clamp", {
      query: "hana tavily clamp",
      maxResults: 50,
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      query: "hana tavily clamp",
      max_results: 20,
      search_depth: "basic",
    });
  });

  it("defaults to auto search and uses AnySearch free before browser providers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        code: 0,
        message: "success",
        data: {
          results: [
            {
              title: "AnySearch Result",
              url: "https://example.com/anysearch",
              description: "AnySearch description",
              content: "AnySearch content",
              score: 68.5,
              quality_score: 68.5,
            },
          ],
          metadata: {
            total_results: 1,
            search_time_ms: 123,
            request_id: "req-anysearch",
            cached: false,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    searchWebMock.mockResolvedValue({
      query: "hana default",
      provider: "bing_browser",
      source_type: "browser",
      results: [
        {
          title: "Default Result",
          url: "https://example.com/default",
          content: "Default snippet",
          rank: 1,
          score: null,
          metadata: { engine: "bing" },
        },
      ],
      diagnostics: {
        final_url: "https://www.bing.com/search?q=hana+default",
        blocked: false,
        captcha: false,
      },
    });

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "", api_key: "" }),
    });
    const result = await tool.execute("call-2", { query: "hana default", maxResults: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(searchWebMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      query: "hana default",
      provider: "anysearch_free",
      source_type: "api",
      diagnostics: {
        strategy: "auto",
        request_id: "req-anysearch",
        attempts: [
          {
            provider: "anysearch_free",
            status: "ok",
          },
        ],
      },
      results: [
        {
          title: "AnySearch Result",
          url: "https://example.com/anysearch",
          content: "AnySearch content",
          score: 68.5,
          metadata: { quality_score: 68.5 },
        },
      ],
    });
  });

  it("auto search tries paid AnySearch before other configured API providers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        code: 0,
        message: "success",
        data: {
          results: [
            {
              title: "Paid AnySearch Result",
              url: "https://example.com/paid-anysearch",
              content: "Paid AnySearch content",
            },
          ],
          metadata: {
            total_results: 1,
            search_time_ms: 75,
            request_id: "req-anysearch-auto-paid",
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const rateLimiter = {
      run: vi.fn(async (_provider, _sourceType, operation) => operation()),
    };

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({
        provider: "auto",
        api_keys: { tavily: "tvly-key", anysearch: "anysearch-secret" },
      }),
      rateLimiter,
    });
    const result = await tool.execute("call-auto-anysearch-paid", {
      query: "hana auto anysearch paid",
      maxResults: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.anysearch.com/v1/search");
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      "Authorization": "Bearer anysearch-secret",
    });
    expect(rateLimiter.run).toHaveBeenCalledWith("anysearch", "api", expect.any(Function));
    expect(searchWebMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      provider: "anysearch",
      source_type: "api",
      diagnostics: {
        strategy: "auto",
        attempts: [
          {
            provider: "anysearch",
            status: "ok",
          },
        ],
      },
    });
  });

  it("auto search falls back from paid AnySearch auth failure to the next configured API provider", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ code: 40101, message: "invalid api key" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          results: [
            { title: "Tavily Result", url: "https://example.com/tavily", content: "Tavily snippet" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);
    const rateLimiter = {
      run: vi.fn(async (_provider, _sourceType, operation) => operation()),
    };

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({
        provider: "auto",
        api_keys: { anysearch: "bad-anysearch-key", tavily: "tvly-key" },
      }),
      rateLimiter,
    });
    const result = await tool.execute("call-auto-anysearch-auth-fallback", {
      query: "hana anysearch auth fallback",
      maxResults: 1,
    });

    expect(rateLimiter.run).toHaveBeenNthCalledWith(1, "anysearch", "api", expect.any(Function));
    expect(rateLimiter.run).toHaveBeenNthCalledWith(2, "tavily", "api", expect.any(Function));
    expect(result.details).toMatchObject({
      provider: "tavily",
      diagnostics: {
        strategy: "auto",
        attempts: [
          {
            provider: "anysearch",
            status: "error",
            error_type: "auth",
          },
          {
            provider: "tavily",
            status: "ok",
          },
        ],
      },
    });
  });

  it("auto search falls back from exhausted AnySearch free quota to browser providers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 402, message: "free quota exhausted" }),
      {
        status: 402,
        headers: { "Content-Type": "application/json" },
      },
    ));
    vi.stubGlobal("fetch", fetchMock);
    searchWebMock.mockResolvedValue({
      query: "hana quota fallback",
      provider: "bing_browser",
      source_type: "browser",
      results: [
        {
          title: "Browser Result",
          url: "https://example.com/browser",
          content: "Browser snippet",
          rank: 1,
          score: null,
          metadata: { engine: "bing" },
        },
      ],
      diagnostics: { blocked: false, captcha: false },
    });

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "auto", api_keys: {} }),
    });
    const result = await tool.execute("call-anysearch-fallback", {
      query: "hana quota fallback",
      maxResults: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(searchWebMock).toHaveBeenCalledWith({
      provider: "bing_browser",
      query: "hana quota fallback",
      maxResults: 1,
      locale: "zh",
    });
    expect(result.details).toMatchObject({
      provider: "bing_browser",
      source_type: "browser",
      diagnostics: {
        strategy: "auto",
        attempts: [
          {
            provider: "anysearch_free",
            status: "error",
            error_type: "rate_limited",
          },
          {
            provider: "bing_browser",
            status: "ok",
          },
        ],
      },
    });
  });

  it("auto search tries configured API providers before browser providers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        results: [
          { title: "Tavily Result", url: "https://example.com/tavily", content: "Tavily snippet" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const rateLimiter = {
      run: vi.fn(async (_provider, _sourceType, operation) => operation()),
    };

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({
        provider: "auto",
        api_keys: { tavily: "tvly-key", brave: "brave-key" },
      }),
      rateLimiter,
    });
    const result = await tool.execute("call-auto-api", { query: "hana api", maxResults: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rateLimiter.run).toHaveBeenCalledWith("tavily", "api", expect.any(Function));
    expect(searchWebMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      provider: "tavily",
      source_type: "api",
      results: [
        {
          title: "Tavily Result",
          url: "https://example.com/tavily",
          content: "Tavily snippet",
        },
      ],
      diagnostics: {
        strategy: "auto",
        attempts: [
          {
            provider: "tavily",
            status: "ok",
          },
        ],
      },
    });
  });

  it("auto search falls back from an exhausted API provider to the next configured API provider", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: "quota exceeded" }),
        {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "2" },
        },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          web: {
            results: [
              { title: "Brave Result", url: "https://example.com/brave", description: "Brave snippet" },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);
    const rateLimiter = {
      run: vi.fn(async (_provider, _sourceType, operation) => operation()),
    };

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({
        provider: "auto",
        api_keys: { tavily: "tvly-key", brave: "brave-key" },
      }),
      rateLimiter,
    });
    const result = await tool.execute("call-auto-fallback", { query: "hana fallback", maxResults: 1 });

    expect(rateLimiter.run).toHaveBeenNthCalledWith(1, "tavily", "api", expect.any(Function));
    expect(rateLimiter.run).toHaveBeenNthCalledWith(2, "brave", "api", expect.any(Function));
    expect(result.details).toMatchObject({
      provider: "brave",
      source_type: "api",
      diagnostics: {
        strategy: "auto",
        attempts: [
          {
            provider: "tavily",
            status: "error",
            error_type: "rate_limited",
          },
          {
            provider: "brave",
            status: "ok",
          },
        ],
      },
    });
  });

  it("auto search falls back from low-quality Bing Chinese results to Google", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 0, message: "success", data: { results: [] } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    searchWebMock.mockImplementation(async ({ provider, query }) => {
      if (provider === "bing_browser") {
        return {
          query,
          provider,
          source_type: "browser",
          results: [
            {
              title: "大（汉语文字）_百度百科",
              url: "https://baike.baidu.com/item/%E5%A4%A7",
              content: "大，汉语常用字。",
              rank: 1,
            },
            {
              title: "大的解释|大的意思|汉典“大”字的基本解释",
              url: "https://www.zdic.net/hans/%E5%A4%A7",
              content: "汉典提供大字解释。",
              rank: 2,
            },
          ],
          diagnostics: { blocked: false, captcha: false },
        };
      }
      return {
        query,
        provider,
        source_type: "browser",
        results: [
          {
            title: "腾讯混元官方定价",
            url: "https://cloud.tencent.com/product/hunyuan/pricing",
            content: "腾讯混元大模型官方价格说明。",
            rank: 1,
          },
        ],
        diagnostics: { blocked: false, captcha: false },
      };
    });

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "auto", api_keys: {} }),
    });
    const result = await tool.execute("call-auto-low-quality", {
      query: "大模型 官方定价 百炼 腾讯混元 2026",
      maxResults: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(searchWebMock).toHaveBeenNthCalledWith(1, {
      provider: "bing_browser",
      query: "大模型 官方定价 百炼 腾讯混元 2026",
      maxResults: 2,
      locale: "zh",
    });
    expect(searchWebMock).toHaveBeenNthCalledWith(2, {
      provider: "google_browser",
      query: "大模型 官方定价 百炼 腾讯混元 2026",
      maxResults: 2,
      locale: "zh",
    });
    expect(result.details).toMatchObject({
      provider: "google_browser",
      diagnostics: {
        strategy: "auto",
        attempts: [
          {
            provider: "anysearch_free",
            status: "empty",
          },
          {
            provider: "bing_browser",
            status: "low_quality",
          },
          {
            provider: "google_browser",
            status: "ok",
          },
        ],
      },
    });
  });

  it("surfaces browser extraction failures instead of reporting them as empty results", async () => {
    searchWebMock.mockResolvedValue({
      query: "中文 搜索",
      provider: "bing_browser",
      source_type: "browser",
      results: [],
      diagnostics: {
        status: "extraction_failed",
        blocked: false,
        captcha: false,
        reason: "Search results could not be extracted from bing page.",
      },
    });

    const tool = createWebSearchTool({
      searchConfigResolver: () => ({ provider: "bing_browser", api_key: "" }),
    });
    const result = await tool.execute("call-extraction-failed", { query: "中文 搜索", maxResults: 3 });

    expect(result.content[0].text).toContain("could not be extracted");
    expect(result.content[0].text).not.toContain("不太理想");
  });
});
