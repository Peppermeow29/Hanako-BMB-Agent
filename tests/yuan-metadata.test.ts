// 每一家 yuan 的「思考区块」名字（MOOD / PULSE / 沉思）是提示词模板和界面共用的一个事实。
// 界面上要把这个名字标出来，就不能靠运行时去嗅探模板正文——那是把显式契约换成猜测。
// 所以名字写死在 shared/yuan-metadata.ts，由这个测试双向锁住：
//   声明了名字 → 模板里必须真的有这个二级标题
//   没声明名字 → 模板里必须一个区块标题都没有
// 任何一侧先改，这里就红，逼着改的人回头把另一侧一起改掉。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { YUAN_METADATA, getYuanThinkingBlock } from "../shared/yuan-metadata.ts";

const YUAN_DIR = path.join(__dirname, "..", "lib", "yuan");

function readTemplate(yuan: string): string {
  return fs.readFileSync(path.join(YUAN_DIR, `${yuan}.md`), "utf-8");
}

function blockHeadings(template: string): string[] {
  return Array.from(template.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)).map((m) => m[1]);
}

describe("yuan metadata", () => {
  it("declares a thinking block for every yuan template on disk", () => {
    const templates = fs
      .readdirSync(YUAN_DIR)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.replace(/\.md$/, ""))
      .sort();

    expect(templates).toEqual(Object.keys(YUAN_METADATA).sort());
  });

  it("pins the declared block names", () => {
    expect(getYuanThinkingBlock("hanako")).toBe("MOOD");
    expect(getYuanThinkingBlock("butter")).toBe("PULSE");
    expect(getYuanThinkingBlock("ming")).toBe("沉思");
    expect(getYuanThinkingBlock("kong")).toBeNull();
  });

  for (const yuan of ["hanako", "butter", "ming", "kong"]) {
    it(`keeps ${yuan}'s declaration and template in agreement`, () => {
      const declared = getYuanThinkingBlock(yuan);
      const headings = blockHeadings(readTemplate(yuan));

      if (declared === null) {
        // kong 没有思考区块：模板要么是空的，要么至少不能冒出一个区块标题
        expect(headings).toEqual([]);
      } else {
        expect(headings).toContain(declared);
        expect(readTemplate(yuan)).toContain(`## ${declared}`);
      }
    });
  }

  it("has no declared block for an unknown yuan", () => {
    expect(getYuanThinkingBlock("nobody")).toBeNull();
    expect(getYuanThinkingBlock("")).toBeNull();
    expect(getYuanThinkingBlock(undefined)).toBeNull();
  });
});
