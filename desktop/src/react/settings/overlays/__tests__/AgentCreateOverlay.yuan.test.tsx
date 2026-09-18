/**
 * AgentCreateOverlay 的 yuan chip 行。
 *
 * 创建入口和设置页共用同一套 .yuan-chip class，但布局约束完全不同：设置页把
 * kong 放进一条 6:1 的横幅，创建入口把它和其它 yuan 一起塞进 100px 的方片。
 * 为横幅写的那句完整描述在方片里会换行撑高整行，所以 kong 在这里读 shortLabel。
 * 这个测试锁住「只有 kong 走 shortLabel」这条边界——其它 yuan 仍读 label，
 * 免得下次有人顺手把它推广成全局规则。
 *
 * `t` 喂的是真实 zh locale，断言因此覆盖从文案文件到渲染的整条路径。
 *
 * @vitest-environment jsdom
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const zh = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "desktop/src/locales/zh.json"), "utf8"),
);

// 默认喂真实 zh locale；个别用例换成构造的 types 来试探边界
let types: Record<string, Record<string, string>> = zh.yuan.types;

vi.mock("../../helpers", () => ({
  t: (key: string) => (key === "yuan.types" ? types : key),
}));
vi.mock("../../api", () => ({ hanaFetch: vi.fn() }));
vi.mock("../../actions", () => ({ switchToAgent: vi.fn() }));

import { AgentCreateOverlay } from "../AgentCreateOverlay";

afterEach(() => {
  cleanup();
  types = zh.yuan.types;
});

async function openOverlay() {
  const { container } = render(<AgentCreateOverlay />);
  window.dispatchEvent(new Event("hana-show-agent-create"));
  await screen.findByText("kong");
  return container;
}

function descFor(container: HTMLElement, yuan: string): string | undefined {
  const chips = Array.from(container.querySelectorAll<HTMLElement>(".yuan-chip"));
  const chip = chips.find((el) => el.querySelector(".yuan-chip-name")?.textContent === yuan);
  if (!chip) throw new Error(`no chip rendered for yuan "${yuan}"`);
  return chip.querySelector(".yuan-chip-desc")?.textContent ?? undefined;
}

describe("AgentCreateOverlay yuan chips", () => {
  it("keeps kong selectable in the creation flow", async () => {
    const container = await openOverlay();
    const names = Array.from(container.querySelectorAll(".yuan-chip-name")).map(
      (el) => el.textContent,
    );
    expect(names).toContain("kong");
  });

  it("gives kong the short description, not the settings-page one", async () => {
    const container = await openOverlay();
    expect(descFor(container, "kong")).toBe(zh.yuan.types.kong.shortLabel);
    expect(descFor(container, "kong")).not.toBe(zh.yuan.types.kong.label);
  });

  it.each(["hanako", "butter", "ming"])("leaves the %s description on label", async (yuan) => {
    const container = await openOverlay();
    expect(descFor(container, yuan)).toBe(zh.yuan.types[yuan].label);
  });

  // 上面三条只证明「现状没坏」——真实的 zh locale 里除 kong 外没人有 shortLabel，
  // 所以把这条规则推广成全局也照样绿。这条用一个带 shortLabel 的 hanako 试探边界：
  // 只有它能在「shortLabel 存在时仍必须被忽略」这件事上失败。
  it("ignores shortLabel on any yuan other than kong", async () => {
    types = {
      hanako: { label: "均衡的助手", shortLabel: "不该出现", avatar: "Hanako.png" },
      kong: { label: "长描述", shortLabel: "短描述", avatar: "Kong.png" },
    };
    const container = await openOverlay();
    expect(descFor(container, "hanako")).toBe("均衡的助手");
    expect(descFor(container, "kong")).toBe("短描述");
  });
});
