import { describe, expect, it } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { sanitizeWindowState } = require("../desktop/src/shared/window-state.cjs");

const mainDisplay = {
  workArea: { x: 0, y: 0, width: 1440, height: 900 },
};

describe("desktop window state restore", () => {
  it("preserves a valid saved window state", () => {
    expect(sanitizeWindowState({
      x: 120,
      y: 80,
      width: 960,
      height: 700,
      isMaximized: true,
    }, [mainDisplay], { defaultWidth: 960, defaultHeight: 820 })).toEqual({
      x: 120,
      y: 80,
      width: 960,
      height: 700,
      isMaximized: true,
    });
  });

  it("keeps a window that is intentionally near the visible edge", () => {
    expect(sanitizeWindowState({
      x: -20,
      y: 40,
      width: 960,
      height: 700,
      isMaximized: false,
    }, [mainDisplay], { defaultWidth: 960, defaultHeight: 820 })).toEqual({
      x: -20,
      y: 40,
      width: 960,
      height: 700,
      isMaximized: false,
    });
  });

  it("preserves a valid saved window state on a larger secondary display", () => {
    const secondaryDisplay = {
      workArea: { x: 1440, y: 0, width: 1920, height: 1080 },
    };

    expect(sanitizeWindowState({
      x: 1500,
      y: 80,
      width: 1600,
      height: 900,
      isMaximized: false,
    }, [mainDisplay, secondaryDisplay], { defaultWidth: 960, defaultHeight: 820 })).toEqual({
      x: 1500,
      y: 80,
      width: 1600,
      height: 900,
      isMaximized: false,
    });
  });

  it("recenters an offscreen saved state onto the primary display", () => {
    expect(sanitizeWindowState({
      x: -2400,
      y: 120,
      width: 960,
      height: 820,
      isMaximized: false,
    }, [mainDisplay], { defaultWidth: 960, defaultHeight: 820 })).toEqual({
      x: 240,
      y: 40,
      width: 960,
      height: 820,
      isMaximized: false,
    });
  });
});
