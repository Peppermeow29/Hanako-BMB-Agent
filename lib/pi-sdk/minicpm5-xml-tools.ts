import { randomUUID } from "node:crypto";
import { validateToolArguments } from "@earendil-works/pi-ai/compat";

const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export type MiniCPM5XmlToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type MiniCPM5XmlToolRejection = {
  code: "duplicate_tool_call" | "invalid_arguments" | "malformed_xml" | "unknown_tool";
  callIndex: number;
  functionName: string | null;
  message: string;
};

export type MiniCPM5XmlToolParseResult = {
  calls: MiniCPM5XmlToolCall[];
  rejections: MiniCPM5XmlToolRejection[];
  text: string;
};

/**
 * Convert MiniCPM5's native function XML into Pi's standard tool-call shape.
 * Invalid XML and invalid parameters are rejected before any executor runs.
 */
export function parseMiniCPM5XmlToolCalls(text: string, tools: any[] = [], options: { recoverTruncated?: boolean } = {}): MiniCPM5XmlToolParseResult {
  const source = typeof text === "string" ? text : "";
  const calls: MiniCPM5XmlToolCall[] = [];
  const rejections: MiniCPM5XmlToolRejection[] = [];
  const toolByName = new Map(
    tools.filter(tool => typeof tool?.name === "string" && tool.name).map(tool => [tool.name, tool]),
  );
  const duplicateKeys = new Set<string>();
  const output: string[] = [];
  const functionPattern = /<function\s+name\s*=\s*(["'])([^"']+)\1\s*>([\s\S]*?)<\/function\s*>/gi;
  let cursor = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  let callIndex = 0;

  while ((match = functionPattern.exec(source))) {
    matched = true;
    output.push(source.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    callIndex += 1;

    const name = match[2].trim();
    const result = parseOneFunction({ name, body: match[3], toolByName, callIndex, duplicateKeys });
    if ("call" in result) calls.push(result.call);
    else rejections.push(result.rejection);
  }
  const tail = source.slice(cursor);
  // Never display an unfinished function protocol block as user-facing text,
  // including when a response had an earlier complete call. A common MLX
  // truncation is to emit every parameter and lose only the final
  // </function>; that case is safe to recover because parseParameters still
  // validates every parameter boundary and value before execution.
  if (/<function\b/i.test(tail)) {
    const recoverable = /^\s*<function\s+name\s*=\s*(["'])([^"']+)\1\s*>([\s\S]*)$/i.exec(tail);
    if (options.recoverTruncated && recoverable && !/<function\b/i.test(recoverable[3])) {
      const result = parseOneFunction({
        name: recoverable[2].trim(),
        body: recoverable[3],
        toolByName,
        callIndex: callIndex + 1,
        duplicateKeys,
      });
      if ("call" in result) calls.push(result.call);
      else rejections.push(result.rejection);
    } else {
      rejections.push({
        code: "malformed_xml",
        callIndex: callIndex + 1,
        functionName: functionNameFromFragment(tail),
        message: "MiniCPM5 returned an unterminated <function> XML block.",
      });
    }
    output.push(tail.replace(/<function\b[\s\S]*$/i, ""));
  } else {
    output.push(tail);
  }

  return { calls, rejections, text: output.join("") };
}

function parseOneFunction({ name, body, toolByName, callIndex, duplicateKeys }: {
  name: string;
  body: string;
  toolByName: Map<string, any>;
  callIndex: number;
  duplicateKeys: Set<string>;
}): { call: MiniCPM5XmlToolCall } | { rejection: MiniCPM5XmlToolRejection } {
  const reject = (code: MiniCPM5XmlToolRejection["code"], message: string) => ({
    rejection: { code, callIndex, functionName: name || null, message },
  });
  if (!FUNCTION_NAME.test(name)) return reject("malformed_xml", "MiniCPM5 returned a function name with unsupported characters.");
  const tool = toolByName.get(name);
  if (!tool) return reject("unknown_tool", `MiniCPM5 requested unavailable tool "${name}".`);

  const params = parseParameters(body);
  if ("error" in params) return reject("malformed_xml", params.error);
  const duplicateKey = `${name}\0${stableJson(params.arguments)}`;
  if (duplicateKeys.has(duplicateKey)) {
    return reject("duplicate_tool_call", `MiniCPM5 repeated the same "${name}" call in one response.`);
  }

  let arguments_: Record<string, unknown>;
  try {
    // Use Pi's own TypeBox/JSON-Schema contract, including its normal coercion.
    arguments_ = validateToolArguments(tool, {
      type: "toolCall",
      id: "minicpm5-validation",
      name,
      arguments: params.arguments,
    }) as Record<string, unknown>;
  } catch (error) {
    return reject("invalid_arguments", error instanceof Error ? error.message : String(error));
  }

  duplicateKeys.add(duplicateKey);
  return {
    call: {
      type: "toolCall",
      id: `minicpm5_${randomUUID()}`,
      name,
      arguments: arguments_,
    },
  };
}

function parseParameters(body: string): { arguments: Record<string, unknown> } | { error: string } {
  const arguments_: Record<string, unknown> = {};
  const paramPattern = /<param\s+name\s*=\s*(["'])([^"']+)\1\s*>([\s\S]*?)<\/param\s*>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = paramPattern.exec(body))) {
    if (body.slice(cursor, match.index).trim()) return { error: "MiniCPM5 function XML contains content outside <param> elements." };
    cursor = match.index + match[0].length;
    const paramName = match[2].trim();
    if (!PARAM_NAME.test(paramName)) return { error: "MiniCPM5 function XML contains an invalid parameter name." };
    if (Object.prototype.hasOwnProperty.call(arguments_, paramName)) return { error: `MiniCPM5 function XML repeats parameter "${paramName}".` };
    const parsedValue = parseParameterValue(match[3]);
    if ("error" in parsedValue) return parsedValue;
    arguments_[paramName] = parsedValue.value;
  }
  if (body.slice(cursor).trim()) return { error: "MiniCPM5 function XML contains malformed parameter markup." };
  return { arguments: arguments_ };
}

function parseParameterValue(raw: string): { value: unknown } | { error: string } {
  const trimmed = raw.trim();
  let text = trimmed;
  if (trimmed.startsWith("<![CDATA[")) {
    if (!trimmed.endsWith("]]>") || trimmed.indexOf("]]>") !== trimmed.length - 3) {
      return { error: "MiniCPM5 function XML contains an unterminated CDATA value." };
    }
    text = trimmed.slice(9, -3);
  } else {
    if (/[<]/.test(text) || /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(text)) {
      return { error: "MiniCPM5 function XML contains unescaped parameter text." };
    }
    text = decodeXmlEntities(text);
  }
  if (/^(?:\{|\[|"|-?\d|true$|false$|null$)/.test(text.trim())) {
    try { return { value: JSON.parse(text) }; } catch { /* keep an ordinary XML string */ }
  }
  return { value: text };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_all, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function functionNameFromFragment(text: string): string | null {
  const match = /<function\s+name\s*=\s*(["'])([^"']+)\1/i.exec(text);
  return match?.[2]?.trim() || null;
}
