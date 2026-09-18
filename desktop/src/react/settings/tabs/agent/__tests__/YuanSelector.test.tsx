/**
 * Tests for YuanSelector — the yuan picker in AgentTab.
 *
 * `t` is mocked, but it is fed the *real* zh locale so the copy assertions
 * cover the whole path from locale file to rendered text rather than echoing
 * a fixture back at themselves. Full mock (no importActual) because
 * settings/helpers.ts pulls in the store and window.platform at module-eval
 * time, which would throw during vi.mock hoisting even under jsdom.
 *
 * @vitest-environment jsdom
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

const zh = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "desktop/src/locales/zh.json"), "utf8"),
);

vi.mock("../../../helpers", () => ({
  t: (key: string) => (key === "yuan.types" ? zh.yuan.types : key),
}));

import { YuanSelector } from "../YuanSelector";

function renderSelector(currentYuan = "hanako") {
  const onChange = vi.fn();
  const { container } = render(<YuanSelector currentYuan={currentYuan} onChange={onChange} />);
  return { container, onChange };
}

function chipFor(container: HTMLElement, yuan: string): HTMLElement {
  const chips = Array.from(container.querySelectorAll<HTMLElement>(".yuan-chip"));
  const chip = chips.find((el) => el.querySelector(".yuan-chip-name")?.textContent === yuan);
  if (!chip) throw new Error(`no chip rendered for yuan "${yuan}"`);
  return chip;
}

describe("YuanSelector", () => {
  it.each([
    ["hanako", "MOOD"],
    ["butter", "PULSE"],
    ["ming", "沉思"],
  ])("labels the %s chip with its thinking block", (yuan, block) => {
    const { container } = renderSelector();
    expect(chipFor(container, yuan).querySelector(".yuan-chip-tag")?.textContent).toBe(block);
  });

  it("renders kong as 无 with the neutral description and no tag", () => {
    const { container } = renderSelector();
    const banner = container.querySelector(".yuan-kong-banner");

    expect(banner).not.toBeNull();
    expect(banner?.querySelector(".yuan-kong-name")?.textContent).toBe("无");
    expect(banner?.querySelector(".yuan-kong-desc")?.textContent).toBe(
      "无发散思考模块（如 MOOD），和别的 Agent 一致体验。",
    );
    // 描述行已经把这件事说全了，banner 上再挂一个 tag 只是重复
    expect(banner?.querySelector(".yuan-chip-tag")).toBeNull();
  });

  it("keeps kong out of the chip row", () => {
    const { container } = renderSelector();
    const names = Array.from(container.querySelectorAll(".yuan-chip-name")).map(
      (el) => el.textContent,
    );
    expect(names).not.toContain("kong");
    expect(names).toEqual(["butter", "hanako", "ming"]);
  });
});
