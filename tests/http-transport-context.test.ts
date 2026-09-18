import { describe, expect, it } from "vitest";

describe("HTTP transport context", () => {
  it("classifies loopback hosts as local in loopback mode", async () => {
    const { inferHttpConnectionKind } = await import("../server/http/transport-context.ts");

    expect(inferHttpConnectionKind({
      hostHeader: "127.0.0.1:14500",
      networkMode: "loopback",
    })).toEqual({ connectionKind: "local", reason: null });
    expect(inferHttpConnectionKind({
      hostHeader: "localhost:14500",
      networkMode: "loopback",
    })).toEqual({ connectionKind: "local", reason: null });
  });

  it("rejects public host headers in loopback mode instead of treating them as local", async () => {
    const { inferHttpConnectionKind } = await import("../server/http/transport-context.ts");

    expect(inferHttpConnectionKind({
      hostHeader: "hana.example.com",
      networkMode: "loopback",
    })).toEqual({
      connectionKind: null,
      reason: "loopback_host_mismatch",
    });
    expect(inferHttpConnectionKind({
      hostHeader: "127.0.0.1:14500",
      remoteAddress: "192.168.1.20",
      networkMode: "loopback",
    })).toEqual({
      connectionKind: null,
      reason: "loopback_remote_mismatch",
    });
  });

  it("classifies explicit LAN and custom remote modes from the server network config", async () => {
    const { inferHttpConnectionKind } = await import("../server/http/transport-context.ts");

    expect(inferHttpConnectionKind({
      hostHeader: "192.168.1.20:14500",
      networkMode: "lan",
    })).toEqual({ connectionKind: "lan", reason: null });

    expect(inferHttpConnectionKind({
      hostHeader: "hana.example.com",
      networkMode: "custom_remote",
    })).toEqual({ connectionKind: "custom_remote", reason: null });
  });

  it("does not let a non-loopback socket become local by spoofing the Host header", async () => {
    const { inferHttpConnectionKind } = await import("../server/http/transport-context.ts");

    expect(inferHttpConnectionKind({
      hostHeader: "localhost:14500",
      remoteAddress: "192.168.1.20",
      networkMode: "lan",
    })).toEqual({ connectionKind: "lan", reason: null });

    expect(inferHttpConnectionKind({
      hostHeader: "127.0.0.1:14500",
      remoteAddress: "203.0.113.10",
      networkMode: "custom_remote",
    })).toEqual({ connectionKind: "custom_remote", reason: null });
  });

  it("requires a real loopback socket before treating a LAN-mode request as local", async () => {
    const { inferHttpConnectionKind } = await import("../server/http/transport-context.ts");

    expect(inferHttpConnectionKind({
      hostHeader: "127.0.0.1:14500",
      networkMode: "lan",
    })).toEqual({ connectionKind: "lan", reason: null });

    expect(inferHttpConnectionKind({
      hostHeader: "127.0.0.1:14500",
      remoteAddress: "127.0.0.1",
      networkMode: "lan",
    })).toEqual({ connectionKind: "local", reason: null });
  });
});
