import { describe, expect, it } from "vitest";

import {
  buildDeferredResultInterludeBlock,
  extractDeferredResultDetailMarkdown,
} from "../server/deferred-result-interlude.ts";

describe("deferred result interlude", () => {
  it("uses subagent metadata for readable source labels", () => {
    const block = buildDeferredResultInterludeBlock({
      taskId: "subagent-1",
      status: "success",
      result: "整理完成",
      meta: {
        type: "subagent",
        executorAgentNameSnapshot: "明",
        label: "大纲评估",
        summary: "请阅读整份长任务说明并输出完整评估",
      },
    }, { receiverName: "小花" });

    expect(block).toMatchObject({
      type: "interlude",
      taskId: "subagent-1",
      sourceKind: "subagent",
      sourceLabel: "明 · 大纲评估",
      text: "小花 收到了来自 明 · 大纲评估 的回复",
      detailMarkdown: "整理完成",
    });
  });

  it("does not leak subagent task summaries into the interlude source label", () => {
    const block = buildDeferredResultInterludeBlock({
      taskId: "subagent-2",
      status: "success",
      result: "回来了",
      meta: {
        type: "subagent",
        executorAgentNameSnapshot: "Hanako",
        label: "凌晨诗行",
        summary: "写一首关于凌晨五点三十九分的三行短诗。要求：不要使用常见意象。",
      },
    }, { receiverName: "Hanako" });

    expect(block).toMatchObject({
      sourceKind: "subagent",
      sourceLabel: "Hanako · 凌晨诗行",
      text: "Hanako 收到了来自 Hanako · 凌晨诗行 的回复",
    });
    expect(block.sourceLabel).not.toContain("写一首");
    expect(block.text).not.toContain("五点三十九分");
  });

  it("peels human-readable fields out of structured tool results", () => {
    const detail = extractDeferredResultDetailMarkdown({
      status: "success",
      result: {
        ok: true,
        sessionFiles: [
          { label: "report.md", kind: "markdown" },
        ],
        raw: { nested: "kept out while better fields exist" },
      },
    } as any);

    expect(detail).toContain("生成文件");
    expect(detail).toContain("report.md");
    expect(detail).toContain("ok: true");
    expect(detail).not.toContain("kept out");
  });

  it("summarizes file-only tool results without dumping raw JSON", () => {
    const detail = extractDeferredResultDetailMarkdown({
      status: "success",
      result: {
        sessionFiles: [
          { label: "generated.png", kind: "image" },
        ],
      },
    } as any);

    expect(detail).toBe("生成文件：\n- generated.png (image)");
    expect(detail).not.toContain("sessionFiles");
  });
});
