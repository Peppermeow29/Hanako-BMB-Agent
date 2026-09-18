import { describe, expect, it } from "vitest";
import { Type } from "../lib/pi-sdk/index.ts";
import { parseMiniCPM5XmlToolCalls } from "../lib/pi-sdk/minicpm5-xml-tools.ts";

const tools = [
  {
    name: "read",
    parameters: Type.Object({ path: Type.String(), line: Type.Optional(Type.Number()) }),
  },
  {
    name: "write",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
  },
];

describe("MiniCPM5 XML tool adapter", () => {
  it("converts valid XML and CDATA to validated standard calls", () => {
    const result = parseMiniCPM5XmlToolCalls(
      '先读取。<function name="read"><param name="path"><![CDATA[src/main.ts]]></param><param name="line">12</param></function>',
      tools,
    );

    expect(result.text).toBe("先读取。");
    expect(result.rejections).toEqual([]);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ name: "read", arguments: { path: "src/main.ts", line: 12 } });
  });

  it("rejects unknown tools, malformed XML, duplicate calls, and invalid parameters", () => {
    const unknown = parseMiniCPM5XmlToolCalls('<function name="shell"><param name="cmd">pwd</param></function>', tools);
    const malformed = parseMiniCPM5XmlToolCalls('<function name="read"><param name="path">a.ts</param>', tools);
    const duplicate = parseMiniCPM5XmlToolCalls(
      '<function name="read"><param name="path">a.ts</param></function><function name="read"><param name="path">a.ts</param></function>',
      tools,
    );
    const invalid = parseMiniCPM5XmlToolCalls('<function name="write"><param name="path">a.ts</param></function>', tools);

    expect(unknown.calls).toEqual([]);
    expect(unknown.rejections[0].code).toBe("unknown_tool");
    expect(malformed.calls).toEqual([]);
    expect(malformed.rejections[0].code).toBe("malformed_xml");
    expect(duplicate.calls).toHaveLength(1);
    expect(duplicate.rejections[0].code).toBe("duplicate_tool_call");
    expect(invalid.calls).toEqual([]);
    expect(invalid.rejections[0].code).toBe("invalid_arguments");
  });

  it("does not pass raw protocol fragments through as assistant text", () => {
    const result = parseMiniCPM5XmlToolCalls('<function name="read"><param name="path">a.ts</param></function>', tools);
    expect(result.text).toBe("");
    expect(result.calls[0].name).toBe("read");
  });
});
