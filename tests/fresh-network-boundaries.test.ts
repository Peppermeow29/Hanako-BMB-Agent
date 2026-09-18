import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf-8");
}

function between(text: string, start: string, end: string) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe("fresh credential network boundaries", () => {
  it("uses the fresh utility resolver in both server text-generation bus handlers", () => {
    const text = source("server/index.ts");
    const utilityHandler = between(
      text,
      'hub.eventBus.handle("utility:call-text"',
      'hub.eventBus.handle("model:sample-text"',
    );
    const sampleHandler = between(
      text,
      'hub.eventBus.handle("model:sample-text"',
      'hub.eventBus.handle("usage:list"',
    );

    for (const handler of [utilityHandler, sampleHandler]) {
      expect(handler).toContain("await engine.resolveUtilityConfigFresh");
      expect(handler).not.toMatch(/engine\.resolveUtilityConfig\s*\(/);
      expect(handler).toContain("await callText");
      expect(handler).toContain("...callTextConfigFromUtilityConfig(utility)");
      expect(handler).not.toContain("apiKey: utility.api_key");
      expect(handler).not.toContain("baseUrl: utility.base_url");
    }
  });

});
