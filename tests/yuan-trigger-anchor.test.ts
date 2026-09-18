// 三家 yuan 的内省区块共用同一条触发语义：锚在「收到新消息」这个事件上，
// 一条消息到下一条消息之间只写一次，工具轮次的「回望」可以留白。
// 这个测试锁住那条语义，防止某一家漂回「每次回复都必须写」的旧状态机说法。
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const YUAN_DIR = path.join(__dirname, "..", "lib", "yuan");

const ZH_CASES = [
  { yuan: "hanako", anchor: "每条新消息后的第一段输出以 MOOD 区块开头", tag: "<mood>" },
  { yuan: "butter", anchor: "每条新消息后的第一段输出以 PULSE 区块开头", tag: "<pulse>" },
  { yuan: "ming", anchor: "每条新消息后的第一段输出以沉思区块开头", tag: "<reflect>" },
];

const EN_CASES = [
  { yuan: "hanako", anchor: "after each new message, your first output opens with the MOOD block", tag: "<mood>" },
  { yuan: "butter", anchor: "after each new message, your first output opens with the PULSE block", tag: "<pulse>" },
  { yuan: "ming", anchor: "after each new message, your first output opens with the Reflect block", tag: "<reflect>" },
];

function readTemplate(...segments: string[]) {
  return fs.readFileSync(path.join(YUAN_DIR, ...segments), "utf-8");
}

describe("yuan reflection trigger rules (zh)", () => {
  for (const { yuan, anchor, tag } of ZH_CASES) {
    it(`anchors ${yuan} on the incoming message rather than on every response`, () => {
      const template = readTemplate(`${yuan}.md`);

      // 事件锚定：第一段输出写一次，到下一条消息之前不再重写
      expect(template).toContain(anchor);
      expect(template).toContain("下一条消息之前，不再重写");
      // 回望可以留白，且不占用区块标签
      expect(template).toContain("没有新念头就不写，不要为了格式而写");
      expect(template).toContain(`回望不用 ${tag} 标签，单独一行`);
      // 旧的「每次回复都必须写」状态机说法不得复现
      expect(template).not.toContain("强制触发规则");
      expect(template).not.toContain("后续所有输出均不再写");
    });
  }
});

describe("yuan reflection trigger rules (en)", () => {
  for (const { yuan, anchor, tag } of EN_CASES) {
    it(`anchors ${yuan} on the incoming message rather than on every response`, () => {
      const template = readTemplate("en", `${yuan}.md`);

      expect(template).toContain(anchor);
      expect(template).toContain("Do not write it again until {{userName}}'s next message.");
      expect(template).toContain("if nothing new emerged, omit it");
      expect(template).toContain(`Afterglow takes no ${tag} tag; it is a single line.`);
      expect(template).not.toContain("before every response");
      expect(template).not.toContain("no exceptions");
    });
  }
});
