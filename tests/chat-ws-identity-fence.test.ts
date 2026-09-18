import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// WS 身份解析已收口到 resolveWsSessionContext（单点）。handler 分支直接读
// msg.agentId 就是在解析器旁边另开一条身份通道——上一次这么写漏出了
// 内部断言原文直怼移动端用户的事故。此围栏锁死通道数量：一条。
describe("chat.ts ws identity fence", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "server", "routes", "chat.ts"),
    "utf8",
  );
  const FENCE_HINT = "身份解析已收口到 resolveWsSessionContext：消费 ctx 的字段，不要另开一条身份通道";

  it("handlers never read the client's agent id off the raw message", () => {
    // 覆盖点号、可选链、两种下标写法，外加解构——解构是善意贡献者最容易自然写出的
    // 绕行拼法。绕开一种就等于绕开了整道围栏。
    const rawAgentIdRead = /\bmsg\s*\??\.\s*agentId\b|\bmsg\s*(?:\?\.)?\s*\[\s*(['"])agentId\1\s*\]/;
    const destructuredRead = /\{[^}]*\bagentId\b[^}]*\}\s*=\s*msg\b/;
    const hit = source.match(rawAgentIdRead) || source.match(destructuredRead);
    expect(
      hit,
      `chat.ts 出现了直读客户端 agentId 的写法（${hit?.[0]}）。${FENCE_HINT}`,
    ).toBeNull();
  });

  it("raw internal assertion copy never reappears", () => {
    expect(
      source.includes("agentId required"),
      `chat.ts 又出现了内部断言原文 "agentId required"，这行文案曾直接漏到用户面。${FENCE_HINT}`,
    ).toBe(false);
  });
});
