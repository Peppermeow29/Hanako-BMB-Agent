import { describe, expect, it } from "vitest";
import {
  DEFAULT_NETWORK_PROXY_CONFIG,
  electronProxyBypassRulesForConfig,
  isNoProxyMatch,
  normalizeNetworkProxyConfig,
  proxyConfigFromEnvironment,
  systemProxyConfigToEnvironment,
  proxyConfigToEnvironment,
  resolveProxyForUrl,
} from "../shared/network-proxy.ts";

describe("network proxy config", () => {
  it("defaults to system mode with local bypasses", () => {
    expect((normalizeNetworkProxyConfig as any)()).toEqual(DEFAULT_NETWORK_PROXY_CONFIG);
  });

  it("normalizes manual proxy URLs and reuses HTTP for HTTPS when needed", () => {
    const config = normalizeNetworkProxyConfig({
      mode: "manual",
      httpProxy: " http://127.0.0.1:7890/ ",
      noProxy: "localhost 127.0.0.1, .internal.test",
    }, { strict: true });

    expect(config.httpProxy).toBe("http://127.0.0.1:7890");
    expect(resolveProxyForUrl("https://api.example.com/v1", config)).toBe("http://127.0.0.1:7890");
    expect(resolveProxyForUrl("http://service.internal.test", config)).toBe("");
    expect(resolveProxyForUrl("https://localhost:8443", config)).toBe("");
  });

  it("supports socks5 proxies from environment variables", () => {
    const envConfig = proxyConfigFromEnvironment({
      ALL_PROXY: "socks5://127.0.0.1:1080",
      NO_PROXY: "metadata.google.internal",
    });

    expect(envConfig.mode).toBe("manual");
    expect(resolveProxyForUrl("https://api.example.com", { mode: "system" }, {
      ALL_PROXY: "socks5://127.0.0.1:1080",
      NO_PROXY: "metadata.google.internal",
    })).toBe("socks5://127.0.0.1:1080");
    expect(resolveProxyForUrl("https://metadata.google.internal", { mode: "system" }, {
      ALL_PROXY: "socks5://127.0.0.1:1080",
      NO_PROXY: "metadata.google.internal",
    })).toBe("");
  });

  it("rejects invalid manual configs in strict mode", () => {
    expect(() => normalizeNetworkProxyConfig({ mode: "manual" }, { strict: true }))
      .toThrow(/requires at least one proxy URL/);
    expect(() => normalizeNetworkProxyConfig({ mode: "manual", httpProxy: "ftp://127.0.0.1:21" }, { strict: true }))
      .toThrow(/must use http, https, socks, or socks5/);
  });

  it("ignores stale manual fields when mode is not manual", () => {
    expect(normalizeNetworkProxyConfig({
      mode: "direct",
      httpProxy: "not-a-url",
    }, { strict: true })).toMatchObject({
      mode: "direct",
      httpProxy: "",
    });
  });

  it("matches no_proxy domain, wildcard, port, and IPv6 entries", () => {
    expect(isNoProxyMatch("https://api.example.com", ".example.com")).toBe(true);
    expect(isNoProxyMatch("https://cdn.example.com", "*.example.com")).toBe(true);
    expect(isNoProxyMatch("https://example.com:443", "example.com:443")).toBe(true);
    expect(isNoProxyMatch("https://example.com:8443", "example.com:443")).toBe(false);
    expect(isNoProxyMatch("http://[::1]:3000", "[::1]:3000")).toBe(true);
  });

  it("always bypasses local server addresses even when no_proxy is empty", () => {
    const manual = {
      mode: "manual",
      httpProxy: "http://127.0.0.1:7890",
      noProxy: "",
    };

    expect(resolveProxyForUrl("http://127.0.0.1:1455/api/health", manual)).toBe("");
    expect(resolveProxyForUrl("http://localhost:1455/api/health", manual)).toBe("");
    expect(resolveProxyForUrl("http://127.42.0.9:1455/api/health", manual)).toBe("");
    expect(resolveProxyForUrl("http://[::1]:1455/api/health", manual)).toBe("");
    expect(resolveProxyForUrl("http://0.0.0.0:1455/api/health", manual)).toBe("http://127.0.0.1:7890");
    expect(resolveProxyForUrl("https://hana.company.example/api/health", manual)).toBe("http://127.0.0.1:7890");
  });

  it("forces local bypass entries into Electron and env proxy rules", () => {
    const manual = {
      mode: "manual",
      httpProxy: "http://127.0.0.1:7890",
      noProxy: "",
    };

    const electronRules = electronProxyBypassRulesForConfig(manual);
    expect(electronRules).toContain("127.0.0.1");
    expect(electronRules).toContain("localhost");
    expect(electronRules).toContain("<local>");

    const env = proxyConfigToEnvironment(manual, {});
    expect(env.NO_PROXY).toContain("127.0.0.1");
    expect(env.NO_PROXY).toContain("localhost");
  });

  it("clears inherited proxy variables when system proxy resolution is direct", () => {
    const env = systemProxyConfigToEnvironment({
      httpProxy: "",
      httpsProxy: "",
      wsProxy: "",
      wssProxy: "",
      noProxy: "",
    }, {
      HTTP_PROXY: "http://stale-http.example:8080",
      http_proxy: "http://stale-http.example:8080",
      HTTPS_PROXY: "http://stale-https.example:8080",
      ALL_PROXY: "socks5://stale-all.example:1080",
      NO_PROXY: "corp.internal",
    }, { noProxy: "" });

    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toContain("127.0.0.1");
    expect(env.NO_PROXY).toContain("localhost");
  });
});
