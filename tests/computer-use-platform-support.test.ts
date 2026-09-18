import { describe, expect, it } from "vitest";
import {
  effectiveComputerUseSettings,
  isComputerUsePlatformSupported,
  selectedComputerProviderId,
} from "../core/computer-use/platform-support.ts";

const baseSettings = {
  enabled: true,
  provider_by_platform: {
    darwin: "macos:cua",
    win32: "windows:uia",
    linux: "mock",
  },
  allow_windows_input_injection: false,
  app_approvals: [],
};

describe("Computer Use platform support", () => {
  it("does not advertise GUI execution on any platform", () => {
    expect(isComputerUsePlatformSupported("darwin")).toBe(false);
    expect(isComputerUsePlatformSupported("win32")).toBe(false);
    expect(isComputerUsePlatformSupported("linux")).toBe(false);
  });

  it("forces Linux Computer Use settings to disabled without mutating stored provider choices", () => {
    const effective = effectiveComputerUseSettings(baseSettings, { platform: "linux" });

    expect(effective.enabled).toBe(false);
    expect(effective.provider_by_platform.linux).toBe("mock");
    expect(baseSettings.enabled).toBe(true);
    expect(selectedComputerProviderId(effective, { platform: "linux" })).toBeNull();
  });
});
