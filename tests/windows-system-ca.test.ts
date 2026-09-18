import { describe, expect, it, vi } from "vitest";
import {
  enableWindowsSystemCaForCurrentProcess,
  mergeCertificateLists,
  withWindowsSystemCaEnv,
} from "../desktop/src/shared/windows-system-ca.cjs";
import { buildWin32ServerEnv } from "../desktop/src/shared/server-process-env.cjs";

describe("Windows system CA wiring", () => {
  it("merges current defaults with Windows system roots without duplicates", () => {
    expect(mergeCertificateLists(
      ["bundled-root", "extra-root"],
      ["system-root", "bundled-root"],
    )).toEqual(["bundled-root", "extra-root", "system-root"]);
  });

  it("enables current-process system trust while preserving default and extra roots", () => {
    const setDefaultCACertificates = vi.fn();
    const getCACertificates = vi.fn((type: string) => {
      if (type === "default") return ["bundled-root", "extra-root"];
      if (type === "system") return ["system-root", "bundled-root"];
      throw new Error(`unexpected CA source: ${type}`);
    });

    expect(enableWindowsSystemCaForCurrentProcess({
      platform: "win32",
      tls: { getCACertificates, setDefaultCACertificates },
    })).toEqual({ enabled: true, defaultCount: 2, systemCount: 2, mergedCount: 3 });
    expect(setDefaultCACertificates).toHaveBeenCalledWith([
      "bundled-root",
      "extra-root",
      "system-root",
    ]);
  });

  it("does not touch TLS defaults outside Windows", () => {
    const tls = {
      getCACertificates: vi.fn(),
      setDefaultCACertificates: vi.fn(),
    };
    expect(enableWindowsSystemCaForCurrentProcess({ platform: "darwin", tls }))
      .toEqual({ enabled: false, defaultCount: 0, systemCount: 0, mergedCount: 0 });
    expect(tls.getCACertificates).not.toHaveBeenCalled();
    expect(tls.setDefaultCACertificates).not.toHaveBeenCalled();
  });

  it("fails explicitly when the required Node TLS API is unavailable on Windows", () => {
    expect(() => enableWindowsSystemCaForCurrentProcess({ platform: "win32", tls: {} }))
      .toThrow(/tls\.getCACertificates\/setDefaultCACertificates/);
  });

  it("forces the Windows child startup switch and preserves the inherited environment", () => {
    const input = {
      NODE_USE_SYSTEM_CA: "0",
      NODE_EXTRA_CA_CERTS: "C:\\certs\\company.pem",
      NODE_OPTIONS: "--trace-warnings",
      HANA_HOME: "C:\\Users\\hana",
    };
    expect(withWindowsSystemCaEnv(input, { platform: "win32" })).toEqual({
      ...input,
      NODE_USE_SYSTEM_CA: "1",
    });
    expect(input.NODE_USE_SYSTEM_CA).toBe("0");
  });

  it("keeps system and extra CA settings through Windows server environment normalization", async () => {
    const env = withWindowsSystemCaEnv({
      Path: "C:\\Windows\\System32",
      NODE_EXTRA_CA_CERTS: "C:\\certs\\company.pem",
      NODE_OPTIONS: "--trace-warnings",
    }, { platform: "win32" });

    await expect(buildWin32ServerEnv(env, {
      readRegistryPathEntries: async () => ["C:\\Program Files\\nodejs"],
    })).resolves.toMatchObject({
      NODE_USE_SYSTEM_CA: "1",
      NODE_EXTRA_CA_CERTS: "C:\\certs\\company.pem",
      NODE_OPTIONS: "--trace-warnings",
    });
  });

  it("leaves child environment unchanged outside Windows", () => {
    const input = { NODE_USE_SYSTEM_CA: "0", NODE_EXTRA_CA_CERTS: "/tmp/company.pem" };
    expect(withWindowsSystemCaEnv(input, { platform: "linux" })).toEqual(input);
    expect(withWindowsSystemCaEnv(input, { platform: "linux" })).not.toBe(input);
  });
});
