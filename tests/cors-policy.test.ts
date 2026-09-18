import { describe, expect, it } from "vitest";
import { isCorsOriginAllowed } from "../server/http/cors-policy.ts";

describe("CORS policy", () => {
  it("allows production Electron file-origin frontends to pair with a LAN server", () => {
    expect(isCorsOriginAllowed({ origin: "null" })).toBe(true);
    expect(isCorsOriginAllowed({ origin: "file://" })).toBe(true);
  });

  it("keeps the default browser allowance limited to loopback web frontends", () => {
    expect(isCorsOriginAllowed({ origin: "http://localhost:5173" })).toBe(true);
    expect(isCorsOriginAllowed({ origin: "http://127.0.0.1:14500" })).toBe(true);
    expect(isCorsOriginAllowed({ origin: "http://192.168.31.75:5173" })).toBe(false);
  });

  it("honors an explicit CORS origin as a strict override", () => {
    expect(isCorsOriginAllowed({
      origin: "https://studio.example.com",
      configuredOrigin: "https://studio.example.com",
    })).toBe(true);
    expect(isCorsOriginAllowed({
      origin: "null",
      configuredOrigin: "https://studio.example.com",
    })).toBe(false);
  });
});
