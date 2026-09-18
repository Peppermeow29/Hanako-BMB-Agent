import { describe, expect, it, vi } from "vitest";
import policy from "../desktop/src/shared/desktop-notification-policy.cjs";

const {
  normalizeDesktopNotificationOptions,
  shouldSuppressDesktopNotification,
} = policy;

describe("desktop notification focus policy", () => {
  it("keeps legacy notifications on the always policy", () => {
    expect(normalizeDesktopNotificationOptions(null)).toEqual({
      desktopFocusPolicy: "always",
    });
    expect(normalizeDesktopNotificationOptions({ desktopFocusPolicy: "bad" })).toEqual({
      desktopFocusPolicy: "always",
    });
  });

  it("suppresses when_unfocused notifications while a Hana window is focused", () => {
    const getFocusedWindow = vi.fn(() => ({ isDestroyed: () => false }));

    expect(shouldSuppressDesktopNotification(
      { desktopFocusPolicy: "when_unfocused" },
      { getFocusedWindow },
    )).toBe(true);
  });

  it("allows when_unfocused notifications when no Hana window is focused", () => {
    expect(shouldSuppressDesktopNotification(
      { desktopFocusPolicy: "when_unfocused" },
      { getFocusedWindow: () => null },
    )).toBe(false);
  });
});
