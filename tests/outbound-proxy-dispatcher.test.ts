/**
 * tests/outbound-proxy-dispatcher.test.ts
 *
 * #1612：fetchDispatcherForUrl 是 npm undici fetch 的 per-URL 代理 dispatcher
 * 唯一来源，与 WS 的 webSocketOptionsForUrl 共享同一份代理配置（apply 注入的
 * currentConfig）。Node 内建 fetch 不读取 npm undici 的 global dispatcher，
 * 所以依赖代理的出站 fetch 必须显式从这里拿 dispatcher。
 */

import { afterEach, describe, expect, it } from "vitest";
import { createOutboundProxyRuntime, fetchDispatcherForUrl } from "../lib/net/outbound-proxy.ts";

describe("fetchDispatcherForUrl", () => {
  const runtime = createOutboundProxyRuntime({ log: () => {}, warn: () => {}, env: {} });

  afterEach(() => {
    runtime.reset();
  });

  it("resolves a cached undici dispatcher for proxied targets", () => {
    runtime.apply({ mode: "manual", httpsProxy: "http://127.0.0.1:7890" });

    const first = fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {});
    expect(first.proxyUrl).toBe("http://127.0.0.1:7890");
    expect(first.dispatcher).toBeTruthy();

    // 同一代理地址复用同一 dispatcher（连接池不重复建）
    const second = fetchDispatcherForUrl("https://bots.qq.com/app/getAppAccessToken", {});
    expect(second.dispatcher).toBe(first.dispatcher);
  });

  it("returns no dispatcher in direct mode", () => {
    runtime.apply({ mode: "direct" });
    expect(fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {})).toEqual({
      dispatcher: null,
      proxyUrl: "",
    });
  });

  it("honors noProxy bypass from the shared proxy config", () => {
    runtime.apply({
      mode: "manual",
      httpsProxy: "http://127.0.0.1:7890",
      noProxy: "api.sgroup.qq.com",
    });
    expect(fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {}).dispatcher).toBeNull();
    expect(fetchDispatcherForUrl("https://bots.qq.com/app/getAppAccessToken", {}).dispatcher).toBeTruthy();
  });

  it("rebuilds the dispatcher cache when a new proxy config is applied", () => {
    runtime.apply({ mode: "manual", httpsProxy: "http://127.0.0.1:7890" });
    const before = fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {});

    runtime.apply({ mode: "manual", httpsProxy: "http://127.0.0.1:9999" });
    const after = fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {});

    expect(after.proxyUrl).toBe("http://127.0.0.1:9999");
    expect(after.dispatcher).not.toBe(before.dispatcher);
  });

  it("supports socks5 proxy urls like the WS path does", () => {
    runtime.apply({ mode: "manual", httpsProxy: "socks5://127.0.0.1:1080" });
    const resolved = fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {});
    expect(resolved.proxyUrl).toBe("socks5://127.0.0.1:1080");
    expect(resolved.dispatcher).toBeTruthy();
  });
});
