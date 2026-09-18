/**
 * Tests for AgentToolsSection — the "Tools" section in AgentTab.
 *
 * Toggle widget only exposes { on, onChange, label } and does NOT forward
 * data-* props. Tests locate toggles via data-tool-name attribute set on the
 * row root <div> inside AgentToolsSection itself, then read on/off state via
 * the descendant `.hana-toggle` button class.
 *
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { AgentToolsSection } from "../AgentToolsSection";

// Mock helpers — three levels up from tabs/agent/__tests__/
// Full mock (no importActual) because helpers.ts reads window.platform at
// module-eval time, which would throw even in jsdom before the environment
// is fully initialised during vi.mock hoisting.
vi.mock("../../../helpers", () => ({
  autoSaveConfig: vi.fn(),
  t: (key: string) => key, // identity mock so assertions can match key paths
}));
import { autoSaveConfig } from "../../../helpers";

function getRow(container: HTMLElement, toolName: string): HTMLElement | null {
  return container.querySelector(`[data-tool-name="${toolName}"]`);
}

function isToggleOn(row: HTMLElement | null): boolean {
  const btn = row?.querySelector(".hana-toggle");
  return !!btn?.classList.contains("on");
}

function clickToggle(row: HTMLElement | null) {
  const btn = row?.querySelector(".hana-toggle") as HTMLElement | null;
  if (btn) fireEvent.click(btn);
}

describe("AgentToolsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders registered optional toggles while ignoring global tools", () => {
    const { container } = render(
      <AgentToolsSection
        availableTools={["automation", "beautify", "browser", "computer", "cron", "dm", "install_skill", "office", "update_settings", "workflow", "read"]}
        disabled={[]}
      />
    );
    expect(container.querySelectorAll("[data-tool-name]")).toHaveLength(7);
    expect(getRow(container, "automation")).toBeTruthy();
    expect(getRow(container, "beautify")).toBeTruthy();
    expect(getRow(container, "browser")).toBeTruthy();
    expect(getRow(container, "computer")).toBeNull();
    expect(getRow(container, "cron")).toBeNull();
    expect(getRow(container, "dm")).toBeNull();
    expect(getRow(container, "install_skill")).toBeTruthy();
    expect(getRow(container, "office")).toBeTruthy();
    expect(getRow(container, "update_settings")).toBeTruthy();
    expect(getRow(container, "workflow")).toBeTruthy();
    expect(getRow(container, "computer")).toBeNull();
  });

  it("renders built-in optional toggles while availableTools is not returned yet", () => {
    const { container } = render(
      <AgentToolsSection
        availableTools={undefined as unknown as string[]}
        disabled={["update_settings", "dm"]}
      />
    );
    expect(container.querySelectorAll("[data-tool-name]")).toHaveLength(8);
    expect(getRow(container, "automation")).toBeTruthy();
    expect(getRow(container, "beautify")).toBeTruthy();
    expect(getRow(container, "browser")).toBeTruthy();
    expect(getRow(container, "computer")).toBeNull();
    expect(getRow(container, "office")).toBeTruthy();
    expect(getRow(container, "session")).toBeTruthy();
    expect(getRow(container, "workflow")).toBeTruthy();
  });

  it("never renders the retired dm row", () => {
    const { container } = render(
      <AgentToolsSection
        availableTools={["beautify", "browser", "computer", "cron", "install_skill", "office", "update_settings", "read"]}
        disabled={[]}
      />
    );
    expect(container.querySelectorAll("[data-tool-name]")).toHaveLength(5);
    expect(getRow(container, "dm")).toBeNull();
    expect(getRow(container, "beautify")).toBeTruthy();
    expect(getRow(container, "browser")).toBeTruthy();
    expect(getRow(container, "computer")).toBeNull();
    expect(getRow(container, "office")).toBeTruthy();
  });

  it("toggle shows ON when tool is not in disabled list", () => {
    const { container } = render(
      <AgentToolsSection availableTools={["browser"]} disabled={[]} />
    );
    expect(isToggleOn(getRow(container, "browser"))).toBe(true);
  });

  it("toggle shows OFF when tool is in disabled list", () => {
    const { container } = render(
      <AgentToolsSection availableTools={["browser"]} disabled={["browser"]} />
    );
    expect(isToggleOn(getRow(container, "browser"))).toBe(false);
  });

  it("clicking an ON toggle adds the tool to disabled list via autoSaveConfig", () => {
    const { container } = render(
      <AgentToolsSection availableTools={["browser", "automation"]} disabled={[]} />
    );
    clickToggle(getRow(container, "browser"));
    expect(autoSaveConfig).toHaveBeenCalledWith({
      tools: { disabled: ["browser"] },
    });
  });

  it("clicking an OFF toggle removes the tool from disabled list", () => {
    const { container } = render(
      <AgentToolsSection
        availableTools={["browser", "automation"]}
        disabled={["browser", "automation"]}
      />
    );
    clickToggle(getRow(container, "browser"));
    expect(autoSaveConfig).toHaveBeenCalledWith({
      tools: { disabled: ["automation"] },
    });
  });

  it("renders the section description and tool summaries", () => {
    const { container } = render(
      <AgentToolsSection availableTools={["browser"]} disabled={[]} />
    );
    expect(container.textContent).toContain("settings.agent.tools.description");
    expect(container.textContent).toContain("settings.agent.tools.items.browser.summary");
  });

  it("two rapid clicks on different toggles both reach autoSaveConfig (P2 race regression)", () => {
    // Scenario: user disables browser, then disables automation before the first
    // PUT+GET round-trip refreshes the `disabled` prop. Without the useRef
    // fix the second click would build newDisabled from the stale prop
    // (still []), producing ["automation"] and silently losing the browser change.
    const { container } = render(
      <AgentToolsSection availableTools={["browser", "automation"]} disabled={[]} />
    );
    clickToggle(getRow(container, "browser"));
    clickToggle(getRow(container, "automation"));

    expect(autoSaveConfig).toHaveBeenNthCalledWith(1, {
      tools: { disabled: ["browser"] },
    });
    expect(autoSaveConfig).toHaveBeenNthCalledWith(2, {
      tools: { disabled: ["browser", "automation"] },
    });
  });

  it("returns null when no optional tools are available", () => {
    const { container } = render(
      <AgentToolsSection availableTools={["read", "bash"]} disabled={[]} />
    );
    // No optional tools registered → component renders nothing
    expect(container.querySelector(`.${"settings-section"}`)).toBeNull();
    expect(container.querySelectorAll("[data-tool-name]")).toHaveLength(0);
  });
});
