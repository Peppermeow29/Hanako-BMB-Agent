import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { reconcileTerminalText } from "./stream-text-reconciler.ts";
import { randomUUID } from "node:crypto";
import { parseMiniCPM5XmlToolCalls } from "./minicpm5-xml-tools.ts";
import { hasMiniCPM5ToolIntent } from "../../core/provider-compat/minicpm5.ts";

const MINICPM5_LOCAL_PROVIDER = "minicpm5-local";

/** Remove protocol residue already persisted in an older MiniCPM transcript. */
export function sanitizeMiniCPM5Context(context) {
  if (!context || !Array.isArray(context.messages)) return context;
  return {
    ...context,
    messages: context.messages.map(message => (
      message?.role === "assistant" ? sanitizeMiniCPM5Message(message) : message
    )),
  };
}

/** MLX-LM returns MiniCPM5's native XML call output as assistant text. */
export function adaptMiniCPM5XmlToolCallStream(inner, model, context) {
  if (model?.provider !== MINICPM5_LOCAL_PROVIDER) return inner;
  const outer = createAssistantMessageEventStream();
  void (async () => {
    let terminal: any = null;
    let partial: any = null;
    let started = false;
    let rawText = "";
    let emittedText = "";
    let protocolStarted = false;
    let protocolStartIndex = null;
    try {
      for await (const event of inner) {
        if (event?.type === "start") {
          partial = { ...(event.partial || {}), content: [] };
          outer.push({ type: "start", partial });
          started = true;
          continue;
        }
        if (event?.type === "text_delta" && typeof event.delta === "string") {
          rawText += event.delta;
          if (!protocolStarted && successfulWriteContents(context).length > 0 && hasDisplayIntent(latestUserText(context))) {
            continue;
          }
          const safe = findSafeTextEnd(rawText, protocolStarted, protocolStartIndex);
          const safeEnd = safe.end;
          if (safe.markerStarted) {
            protocolStarted = true;
            protocolStartIndex = safeEnd;
          }
          const safeText = rawText.slice(emittedText.length, safeEnd);
          if (safeText) {
            emitTextBlock(outer, partial || (partial = { content: [] }), safeText);
            emittedText += safeText;
          }
          continue;
        }
        if (event?.type === "done" || event?.type === "error") terminal = event;
      }
      if (!terminal) throw new Error("MiniCPM5 stream ended without a terminal message.");
      if (terminal.type === "error") {
        outer.push({ ...terminal, error: sanitizeErrorMessage(terminal.error) });
        outer.end();
        return;
      }

      const message = convertMiniCPM5Message(terminal.message, context?.tools || [], context);
      if (process.env.MINICPM5_DIAGNOSTICS === "1") {
        const rawContent = Array.isArray(terminal.message?.content)
          ? terminal.message.content.filter((block) => block?.type === "text").map((block) => block.text || "").join("\n")
          : "";
        const toolNames = Array.isArray(context?.tools)
          ? context.tools.map((tool) => tool?.name || tool?.function?.name || "?").join(",")
          : "";
        const outputBlocks = Array.isArray(message?.content)
          ? message.content.map((block) => block?.type === "toolCall" ? `toolCall:${block.name}` : block?.type || "?").join(",")
          : "none";
        console.error(`[minicpm5-diagnostics] response contextTools=${Array.isArray(context?.tools) ? context.tools.length : 0}`
          + ` contextNames=${toolNames} rawChars=${rawText.length} rawXml=${/<function\b/i.test(rawText)}`
          + ` terminalStop=${terminal.message?.stopReason || "none"} outputBlocks=${outputBlocks}`
          + ` parsedTextChars=${rawContent.length}`);
      }
      partial = partial || { ...message, content: [] as any[] };
      if (!started) outer.push({ type: "start", partial });
      for (const block of message.content) {
        if (block?.type === "text") {
          const remainder = reconcileTerminalText(block.text, emittedText);
          if (!remainder) continue;
          emitTextBlock(outer, partial, remainder);
          continue;
        }
        const contentIndex = partial.content.length;
        partial.content.push(block);
        if (block.type === "thinking") {
          outer.push({ type: "thinking_start", contentIndex, partial });
          outer.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial });
          outer.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
        } else if (block.type === "toolCall") {
          outer.push({ type: "toolcall_start", contentIndex, partial });
          outer.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
        }
      }
      outer.push({ type: "done", reason: message.stopReason, message });
    } catch (error) {
      outer.push({ type: "error", reason: "error", error: errorMessage(error, model) });
    }
    outer.end();
  })();
  return outer;
}

// MiniCPM5 occasionally emits only the closing half of its XML protocol after
// a tool result. Keep those closing fragments out of the live text stream as
// well as the terminal message; otherwise the frontend briefly renders them
// before the cleaned message is persisted.
const XML_PROTOCOL_MARKERS = [
  "<function",
  "<think",
  "<pokong-enode",
  "]]></param>",
  "]></param>",
  "</param>",
  "</function>",
];

function findSafeTextEnd(text: string, protocolStarted: boolean, protocolStartIndex: number | null) {
  if (protocolStarted) return { end: protocolStartIndex ?? 0, markerStarted: true };
  const markerIndex = XML_PROTOCOL_MARKERS
    .map(marker => text.indexOf(marker))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0];
  if (markerIndex !== undefined) return { end: markerIndex, markerStarted: true };
  // Retain a suffix that could become an XML marker on the next chunk.
  const maxPrefix = Math.max(0, ...XML_PROTOCOL_MARKERS.flatMap(marker => (
    Array.from({ length: marker.length - 1 }, (_, index) => marker.slice(0, index + 1))
  ).filter(prefix => text.endsWith(prefix)).map(prefix => prefix.length)));
  return { end: text.length - maxPrefix, markerStarted: false };
}

function emitTextBlock(stream, partial, text) {
  if (!text) return;
  const contentIndex = partial.content.length;
  partial.content.push({ type: "text", text });
  stream.push({ type: "text_start", contentIndex, partial });
  stream.push({ type: "text_delta", contentIndex, delta: text, partial });
  stream.push({ type: "text_end", contentIndex, content: text, partial });
}


function convertMiniCPM5Message(message, tools, context) {
  if (!message || !Array.isArray(message.content)) return message;
  // A provider may already return Pi's standard tool-call blocks. They still
  // need the same current-user path guard as XML calls; otherwise a stale
  // write path can bypass this adapter simply by changing response format.
  if (message.content.some(block => block?.type === "toolCall")) {
    const content = message.content.filter(block => block?.type !== "toolCall");
    const scoped = constrainMiniCPM5ToolCalls(
      message.content.filter(block => block?.type === "toolCall"),
      context,
    );
    const displayedWriteText = extractDisplayedWriteText(context, content, scoped.calls);
    if (displayedWriteText) content.push({ type: "text", text: displayedWriteText });
    if (scoped.rejections.length > 0) {
      content.push({ type: "text", text: scoped.rejections.map(rejection => (
        `[MiniCPM5 tool call rejected: ${rejection.code}; ${rejection.message}]`
      )).join("\n") });
    }
    content.push(...scoped.calls);
    return {
      ...message,
      content,
      stopReason: scoped.calls.length > 0 ? "toolUse" : message.stopReason,
    };
  }
  const content: any[] = [];
  const calls: any[] = [];
  const rejections: any[] = [];
  for (const block of message.content) {
    if (block?.type !== "text") {
      content.push(block);
      continue;
    }
    // MLX can emit EOS immediately after the final </param> and omit only
    // </function>. Recover that bounded case regardless of stop reason; the
    // parser still validates the complete parameter markup and schema before
    // producing an executable call.
    const parsed = parseMiniCPM5XmlToolCalls(block.text, tools, { recoverTruncated: true });
    calls.push(...parsed.calls);
    rejections.push(...parsed.rejections);
    content.push(...splitThinkingAndText(sanitizeMiniCPM5Text(parsed.text)));
  }
  removeRepeatedWriteText(context, content);
  const scoped = constrainMiniCPM5ToolCalls(calls, context);
  calls.splice(0, calls.length, ...scoped.calls);
  rejections.push(...scoped.rejections);
  // Evaluate display intent before adding rejection diagnostics. The latter
  // are adapter-generated text, not the model's requested正文, and must not
  // suppress the actual write content.
  const displayedWriteText = extractDisplayedWriteText(context, content, calls);
  if (displayedWriteText) content.push({ type: "text", text: displayedWriteText });
  if (rejections.length > 0) {
    content.push({ type: "text", text: rejections.map(rejection => (
      `[MiniCPM5 tool call rejected: ${rejection.code}; ${rejection.message}]`
    )).join("\n") });
  }
  if (calls.length === 0 && rejections.length === 0) {
    const autoWrite = buildAutoWriteCall(context, content, tools);
    if (autoWrite) calls.push(autoWrite);
  }
  content.push(...calls);
  return { ...message, content, stopReason: calls.length > 0 ? "toolUse" : message.stopReason };
}

/**
 * MiniCPM5 commonly stops after the prose phase of an explicit "generate,
 * then write" request. The native agent loop quite correctly treats that as a
 * completed turn, so the adapter can only recover this narrow, deterministic
 * contract at the response boundary. It never infers a target for a generic
 * write request and never runs when the model already emitted a tool call.
 */
function buildAutoWriteCall(context, content, tools) {
  const writeTool = tools.find((tool) => tool?.name === "write");
  if (!writeTool) return null;
  // This fallback is scoped to one user turn. Once that turn already has a
  // write call/result, the native agent loop must be allowed to finish rather
  // than receiving another synthetic write on every resumed response. Native
  // XML write calls are parsed before this fallback and are intentionally not
  // blocked, so a model can still write several different files explicitly.
  if (hasWriteActivitySinceLatestUser(context)) return null;
  const request = detectStagedWriteRequest(context);
  if (!request) return null;
  const text = content
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("")
    .trim();
  if (text.length < 2) return null;

  const arguments_ = { path: request.path, content: text };
  return {
    type: "toolCall",
    id: `minicpm5_auto_write_${randomUUID()}`,
    name: "write",
    arguments: arguments_,
  };
}

function hasWriteActivitySinceLatestUser(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return false;

  return messages.slice(latestUserIndex + 1).some(message => {
    if (!message || typeof message !== "object") return false;
    if (message.role === "toolResult" && message.toolName === "write") return true;
    if (message.role !== "assistant") return false;
    if (Array.isArray(message.content) && message.content.some(block => (
      block?.type === "toolCall" && block.name === "write"
    ))) return true;
    return Array.isArray(message.toolCalls) && message.toolCalls.some(call => (
      call?.name === "write" || call?.function?.name === "write"
    ));
  });
}

function constrainMiniCPM5ToolCalls(calls, context) {
  // The provider layer omits the native tool catalog for ordinary turns. Keep
  // the response boundary consistent with that decision: if a small model
  // still hallucinates XML in an algorithm/math answer, discard it silently
  // instead of executing a tool or showing a protocol error to the user.
  if (!hasMiniCPM5ToolIntent(context?.messages || [], context?.tools || [])
    && shouldSilentlySuppressToolCalls(context?.messages || [])) {
    return { calls: [], rejections: [] };
  }
  const allowedPaths = currentUserWritePaths(context);
  const mentionedPaths = currentUserMentionedPaths(context);
  const forbiddenTools = currentUserForbiddenTools(context);
  const previousWrites = previousWriteSignatures(context);
  // Keep a local set as well as the historical set. MiniCPM5 can emit the
  // same XML function more than once in one response; only the first copy is
  // executable. Different content (or a different path) remains valid.
  const seenWrites = new Set(previousWrites);
  if (!allowedPaths && !mentionedPaths && forbiddenTools.size === 0 && previousWrites.size === 0) {
    return { calls, rejections: [] };
  }
  const accepted: any[] = [];
  const rejections: any[] = [];
  for (const [index, call] of calls.entries()) {
    if (forbiddenTools.has(String(call?.name || "").toLowerCase())) {
      rejections.push({
        code: "invalid_arguments",
        callIndex: index + 1,
        functionName: call?.name || null,
        message: `tool "${String(call?.name || "")}" was explicitly forbidden by the current user request.`,
      });
      continue;
    }
    const toolName = String(call?.name || "").toLowerCase();
    let normalizedCall = call;
    if (toolName === "exec_command") {
      const rejection = constrainMiniCPM5ExecCommand(call, mentionedPaths, index + 1, context?.systemPrompt);
      if (rejection) {
        rejections.push(rejection);
        continue;
      }
    }
    if (toolName === "file" && mentionedPaths) {
      const filePaths = extractFileToolPaths(call)
        .map(rawPath => normalizeWorkspaceRelativePath(rawPath, context?.systemPrompt))
        .map(comparableWorkspacePath)
        .filter(Boolean);
      const hasFileRef = hasFileReference(call);
      if (filePaths.length === 0 && !hasFileRef) {
        rejections.push({
          code: "invalid_arguments",
          callIndex: index + 1,
          functionName: call?.name || "file",
          message: "file access was not tied to a file path or session file explicitly named in the current user request.",
        });
        continue;
      }
      const unmentionedPath = filePaths.find(path => !mentionedPaths.has(path));
      if (unmentionedPath) {
        rejections.push({
          code: "invalid_arguments",
          callIndex: index + 1,
          functionName: call?.name || "file",
          message: `file path "${String(extractFileToolPaths(call).find(Boolean) || unmentionedPath)}" was not mentioned in the current user request.`,
        });
        continue;
      }
    }
    if (isPathScopedFileTool(toolName)) {
      const rawPath = extractCallPath(call);
      const normalizedPath = normalizeWorkspaceRelativePath(rawPath, context?.systemPrompt);
      const comparablePath = comparableWorkspacePath(normalizedPath);
      if (mentionedPaths && (!rawPath || !mentionedPaths.has(comparablePath))) {
        rejections.push({
          code: "invalid_arguments",
          callIndex: index + 1,
          functionName: call?.name || null,
          message: `${toolName} path "${String(rawPath || "")}" was not mentioned in the current user request.`,
        });
        continue;
      }
      if (normalizedPath !== rawPath && rawPath !== undefined) {
        normalizedCall = { ...call, arguments: { ...call.arguments, path: normalizedPath } };
      }
    }
    if (toolName !== "write") {
      accepted.push(normalizedCall);
      continue;
    }
    const rawPath = extractCallPath(normalizedCall);
    const normalizedPath = normalizeWorkspaceRelativePath(rawPath, context?.systemPrompt);
    const comparablePath = comparableWorkspacePath(normalizedPath);
    if (allowedPaths && !allowedPaths.has(comparablePath)) {
      rejections.push({
        code: "invalid_arguments",
        callIndex: index + 1,
        functionName: "write",
        message: `write path "${String(rawPath || "")}" was not mentioned in the current user request.`,
      });
      continue;
    }
    const signature = writeSignature(normalizedPath, normalizedCall.arguments?.content);
    if (seenWrites.has(signature)) {
      rejections.push({
        code: "duplicate_tool_call",
        callIndex: index + 1,
        functionName: "write",
        message: `MiniCPM5 repeated the same "write" call for "${String(rawPath || normalizedPath || "")}" after it already succeeded in this user turn.`,
      });
      continue;
    }
    seenWrites.add(signature);
    // The user-facing workspace name is descriptive, not an extra directory.
    // Normalize an explicitly mentioned CodeLife/foo path to foo before the
    // tool executor sees it, matching the automatic-write fallback.
    if (normalizedPath !== rawPath) {
      accepted.push({ ...normalizedCall, arguments: { ...normalizedCall.arguments, path: normalizedPath } });
    } else {
      accepted.push(normalizedCall);
    }
  }
  return { calls: accepted, rejections };
}

function shouldSilentlySuppressToolCalls(messages: any[]) {
  const text = latestUserText({ messages });
  // Explicitly non-tool requests and the two task families that repeatedly
  // trigger hallucinated filesystem calls on a 2B model are safe to suppress.
  return /(?:不要|无需|不需要|禁止|不用)\s*(?:再)?\s*(?:调用|使用)?\s*(?:任何)?\s*(?:工具|tool)|(?:do\s+not|don't|without)\s+(?:call|use)?\s*(?:any\s+)?tools?|(?:数学|算法)题|\b(?:math|algorithm)\s+(?:problem|question)/iu.test(text);
}

const PATH_SCOPED_FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

const FILESYSTEM_COMMAND_RE = /(?:^|[;&|()\s])(?:ls|dir|find|fd|rg|grep|cat|head|tail|sed|awk|cut|sort|wc|tree|du|stat|file|readlink|realpath|pwd)\b/i;
const SHELL_DIRECTORY_CHANGE_RE = /(?:^|[;&|()\s])(?:cd|pushd|popd)\s+/i;

function constrainMiniCPM5ExecCommand(call, mentionedPaths, callIndex, systemPrompt) {
  // A command such as `echo` remains available for non-file tasks. Commands
  // that can inspect a filesystem are scoped exactly like read/grep/find so a
  // model cannot bypass the adapter by moving the same operation into a shell.
  if (!mentionedPaths) return null;
  const args = call?.arguments && typeof call.arguments === "object" ? call.arguments : {};
  const command = String(args.cmd ?? args.command ?? "");
  if (SHELL_DIRECTORY_CHANGE_RE.test(command)) {
    return {
      code: "invalid_arguments",
      callIndex,
      functionName: call?.name || "exec_command",
      message: "exec_command may not change directories while MiniCPM5 file scope is active; use an explicitly named file path and the tool that matches the request.",
    };
  }
  if (!FILESYSTEM_COMMAND_RE.test(command)) return null;
  const candidates = extractCommandPathCandidates(command)
    .map(rawPath => normalizeWorkspaceRelativePath(rawPath, systemPrompt))
    .map(comparableWorkspacePath)
    .filter(Boolean);
  if (candidates.length === 0 || candidates.some(candidate => !mentionedPaths.has(candidate))) {
    return {
      code: "invalid_arguments",
      callIndex,
      functionName: call?.name || "exec_command",
      message: mentionedPaths.size === 0
        ? "exec_command filesystem inspection was rejected because the current user request named no file or path."
        : "exec_command referenced a file or path that was not mentioned in the current user request.",
    };
  }
  return null;
}

function extractCommandPathCandidates(command) {
  // Keep this deliberately conservative: shell syntax and flags are not paths,
  // while absolute paths, slash-separated paths, and common file names are.
  const matches = String(command || "").match(
    /(?:\/(?:Users|Volumes|private|tmp|var|etc|opt|Applications|Library|System)[^\s"'`;&|<>()]+|(?:\.\.?[\\/])?(?:[A-Za-z0-9_.~-]+[\\/])+[A-Za-z0-9_.~-]+|(?:\.\.?[\\/])?[A-Za-z0-9_.~-]+\.(?:md|txt|json|yaml|yml|toml|csv|ts|tsx|js|jsx|mjs|cjs|py|html|css|png|jpg|jpeg|webp|pdf))+/gi,
  );
  return matches || [];
}

function extractFileToolPaths(call) {
  const args = call?.arguments && typeof call.arguments === "object" ? call.arguments : {};
  const paths = [];
  const add = value => {
    if (typeof value === "string" && value.trim()) paths.push(value);
  };
  add(args.path);
  add(args.filePath);
  add(args.file_path);
  add(args.targetPath);
  add(args.targetDir);
  for (const key of ["ref", "source", "target"]) {
    const value = args[key];
    if (!value || typeof value !== "object") continue;
    add(value.path);
    add(value.filePath);
    add(value.file_path);
    add(value.targetPath);
    add(value.targetDir);
  }
  return [...new Set(paths)];
}

function hasFileReference(call) {
  const args = call?.arguments && typeof call.arguments === "object" ? call.arguments : {};
  if (typeof args.fileId === "string" && args.fileId.trim()) return true;
  for (const key of ["ref", "source"]) {
    const value = args[key];
    if (value && typeof value === "object" && typeof value.fileId === "string" && value.fileId.trim()) return true;
  }
  return false;
}

function isPathScopedFileTool(toolName) {
  return PATH_SCOPED_FILE_TOOLS.has(toolName);
}

function extractCallPath(call) {
  const args = call?.arguments;
  if (!args || typeof args !== "object") return undefined;
  return args.path ?? args.filePath ?? args.file_path ?? args.filename;
}

function currentUserForbiddenTools(context) {
  const text = latestUserText(context);
  const forbidden = new Set<string>();
  if (!text) return forbidden;
  const patterns = [
    /(?:不要|禁止|无需|不需要)\s*(?:调用|使用)?\s*([A-Za-z_][A-Za-z0-9_.-]*(?:\s*[、,，]\s*[A-Za-z_][A-Za-z0-9_.-]*)*)/gi,
    /\b(?:do\s+not|don't|without)\s+(?:call|use)?\s*([A-Za-z_][A-Za-z0-9_.-]*(?:\s*[,，]\s*[A-Za-z_][A-Za-z0-9_.-]*)*)/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      for (const name of match[1].split(/[、,，]/).map(value => value.trim()).filter(Boolean)) {
        forbidden.add(name.toLowerCase());
      }
    }
  }
  return forbidden;
}

function previousWriteSignatures(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const signatures = new Set<string>();
  if (latestUserIndex < 0) return signatures;
  for (const message of messages.slice(latestUserIndex + 1)) {
    const calls = message?.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter(block => block?.type === "toolCall")
      : [];
    if (Array.isArray(message?.toolCalls)) calls.push(...message.toolCalls);
    for (const call of calls) {
      if (call?.name === "write" || call?.function?.name === "write") {
        const args = call.arguments || call.function?.arguments || {};
        signatures.add(writeSignature(args.path, args.content));
      }
    }
  }
  return signatures;
}

function writeSignature(path, content) {
  return `${comparableWorkspacePath(path)}\0${String(content ?? "")}`;
}

function currentUserWritePaths(context) {
  const userText = latestUserText(context);
  if (!userText || !hasWriteIntent(userText) || hasWriteNegation(userText)) return null;
  const paths = extractMarkdownPaths(userText)
    .map(rawPath => normalizeWorkspaceRelativePath(rawPath, context?.systemPrompt))
    .map(comparableWorkspacePath)
    .filter(Boolean);
  return paths.length > 0 ? new Set(paths) : null;
}

function currentUserMentionedPaths(context) {
  if (!hasCurrentUserMessage(context)) return null;
  const userText = latestUserText(context);
  const paths = extractMarkdownPaths(userText)
    .map(rawPath => normalizeWorkspaceRelativePath(rawPath, context?.systemPrompt))
    .map(comparableWorkspacePath)
    .filter(Boolean);
  // An empty set is intentional: this user turn contains a message but no
  // explicit file target, so path-bearing tool calls must all be rejected.
  return new Set(paths);
}

function hasCurrentUserMessage(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  return messages.some(message => message?.role === "user");
}

function extractDisplayedWriteText(context, content, calls) {
  if (!hasDisplayIntent(latestUserText(context))) return "";
  const requestedText = calls
    .filter(call => call?.name === "write" && typeof call.arguments?.content === "string")
    .map(call => call.arguments.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const completedText = successfulWriteContents(context).at(-1) || "";
  const writeText = requestedText || completedText;
  if (!writeText) return "";

  const priorText = contextMessagesInCurrentUserTurn(context)
    .filter(message => message?.role === "assistant" && Array.isArray(message.content))
    .flatMap(message => message.content)
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const currentText = content
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const existingText = [priorText, currentText].filter(Boolean).join("\n\n");
  if (!existingText) return writeText;
  // A post-tool continuation can contain unrelated boilerplate from a small
  // model. Keep that answer, but append the exact successful write content so
  // a user-facing "展示/展现" request is honored even when the tool card is
  // rendered separately from assistant text.
  if (existingText.includes(writeText)) return "";
  return `\n\n正文：\n${writeText}`;
}

function removeRepeatedWriteText(context, content) {
  if (!hasDisplayIntent(latestUserText(context))) return;
  const writtenTexts = successfulWriteContents(context);
  if (writtenTexts.length === 0) return;
  for (const block of content) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    block.text = writtenTexts.reduce(removeWrittenTextFromText, block.text);
  }
}

function removeWrittenTextFromText(text, writtenText) {
  const trimmedWriteText = String(writtenText || "").trim();
  if (!trimmedWriteText) return text;
  const pattern = escapeRegExp(trimmedWriteText).replace(/\n/g, "\\s+");
  return String(text || "").replace(new RegExp(`(?:正文\\s*[：:]\\s*)?${pattern}`, "g"), "");
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function successfulWriteContents(context) {
  const messages = contextMessagesInCurrentUserTurn(context);
  const callsById = new Map<string, string>();
  const completed: string[] = [];
  for (const message of messages) {
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const call of message.content) {
        if (call?.type !== "toolCall" || call.name !== "write") continue;
        const text = typeof call.arguments?.content === "string" ? call.arguments.content.trim() : "";
        if (text && call.id) callsById.set(String(call.id), text);
      }
      continue;
    }
    if (message?.role !== "toolResult" || message.toolName !== "write" || message.isError) continue;
    const text = callsById.get(String(message.toolCallId || ""));
    if (text) completed.push(text);
  }
  return [...new Set(completed)];
}

function contextMessagesInCurrentUserTurn(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    return messages.slice(index + 1);
  }
  return [];
}

function hasDisplayIntent(text) {
  return /(?:展示|展现|显示|给我看|show|display|present)/i.test(String(text || ""));
}

function detectStagedWriteRequest(context) {
  const userText = latestUserText(context);
  if (!userText || !hasStagedWriteIntent(userText) || hasWriteNegation(userText)) return null;
  const rawPath = extractMarkdownPath(userText);
  if (!rawPath) return null;
  return { path: normalizeWorkspaceRelativePath(rawPath, context?.systemPrompt) };
}

function latestUserText(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    return message.content
      .filter((block) => block?.type === "text")
      .map((block) => block.text || "")
      .join("\n");
  }
  return "";
}

function hasStagedWriteIntent(text) {
  const firstContent = /(?:先[^。！？\n]{0,100}(?:写出|生成|输出|写一段|写正文)|first[^.?!\n]{0,120}(?:write|generate|output)|(?:正文|内容|文本)完成后|after[^.?!\n]{0,100}(?:content|text|prose)|(?:写出|生成|输出|写一段|写正文)[^。！？\n]{0,80}(?:展示|展现|显示|给我看|show|display|present))/i;
  const continuation = /(?:然后|再|之后|随后|then|after)/i;
  return hasWriteIntent(text) && firstContent.test(text) && continuation.test(text);
}

function hasWriteIntent(text) {
  return /(?:写入|写到|保存到|存入|写文件|保存文件|\bwrite(?:\s+to)?\b|\bsave(?:\s+to)?\b)/i.test(String(text || ""));
}

function hasWriteNegation(text) {
  return /(?:不要|无需|不需要|禁止|do\s+not|don't|without)[^。！？\n]{0,24}(?:write|save|写入|写到|保存)/i.test(text);
}

function extractMarkdownPath(text) {
  return extractMarkdownPaths(text)
    .sort((left, right) => {
      const leftPriority = /(?:^|[\\/])CodeLife[\\/]/i.test(left) || /^\//.test(left) ? 0 : 1;
      const rightPriority = /(?:^|[\\/])CodeLife[\\/]/i.test(right) || /^\//.test(right) ? 0 : 1;
      return leftPriority - rightPriority;
    })[0] || null;
}

function extractMarkdownPaths(text) {
  const candidates = String(text || "").match(/(?:\/?(?:Users|Volumes|private|tmp)[^\s"'`<>，。；;]*|(?:[A-Za-z0-9_.~-]+[\\/])+[A-Za-z0-9_.~-]+|[A-Za-z0-9_.~-]+)\.(?:md|markdown|txt|text|json|ya?ml|toml|csv|tsv|html?|css|scss|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|svg|xml)\b/gi) || [];
  if (candidates.length === 0) return [];
  return [...new Set(candidates.map((value) => value.replace(/[),.:：，。；;]+$/, "")))];
}

function normalizeWorkspaceRelativePath(rawPath, systemPrompt) {
  const value = String(rawPath || "").trim().replaceAll("\\", "/");
  if (!value || value.startsWith("/") || value.startsWith("~/") || /^[A-Za-z]:\//.test(value)) {
    return value;
  }
  const cwd = /(?:主工作台|Current working directory)[:：]\s*([^\n]+)/i.exec(String(systemPrompt || ""))?.[1]?.trim();
  const workspaceName = cwd?.split("/").filter(Boolean).at(-1) || "CodeLife";
  if (workspaceName && value.toLowerCase().startsWith(`${workspaceName.toLowerCase()}/`)) {
    return value.slice(workspaceName.length + 1);
  }
  return value;
}

function comparableWorkspacePath(rawPath) {
  return String(rawPath || "").trim().replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function splitThinkingAndText(value: string) {
  if (!value) return [];
  const blocks: any[] = [];
  const pattern = /<think>\s*([\s\S]*?)\s*<\/think>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    appendText(blocks, value.slice(cursor, match.index));
    if (match[1]) blocks.push({ type: "thinking", thinking: match[1] });
    cursor = match.index + match[0].length;
  }
  const remainder = value.slice(cursor);
  // A length-limited local response can contain an opening think tag without
  // its closing tag. Treat the remainder as thinking instead of exposing the
  // private channel in the visible answer.
  const unclosed = /<think>\s*([\s\S]*)$/i.exec(remainder);
  if (unclosed) {
    appendText(blocks, remainder.slice(0, unclosed.index));
    if (unclosed[1]) blocks.push({ type: "thinking", thinking: unclosed[1].trim() });
  } else {
    appendText(blocks, remainder);
  }
  return blocks;
}

function appendText(blocks, value: string) {
  if (!value) return;
  const last = blocks.at(-1);
  if (last?.type === "text") last.text += value;
  else blocks.push({ type: "text", text: value });
}

/**
 * MiniCPM sometimes continues its XML protocol after a tool result and emits
 * protocol residue as ordinary assistant text. Keep that residue out of the
 * transcript while preserving normal prose and validated tool calls.
 */
function sanitizeMiniCPM5Text(value: string) {
  return value
    // This is not a supported MiniCPM protocol tag. It has appeared as a
    // hallucinated wrapper around tool instructions in local generations.
    .replace(/<pokong-enode\b[\s\S]*?<\/pokong-enode>/gi, "")
    // A model may emit only the tail of a function after its tool result.
    .replace(/\s*(?:\]{1,2}>\s*)?<\/param>\s*<\/function>\s*$/i, "")
    .trim();
}

function sanitizeMiniCPM5Message(message) {
  if (!message || !Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map(block => (
      block?.type === "text" ? { ...block, text: sanitizeMiniCPM5Text(block.text) } : block
    )),
  };
}

function sanitizeErrorMessage(message) {
  if (!message?.content || !Array.isArray(message.content)) return message;
  // Error/aborted events must never turn an in-flight XML fragment into a
  // synthetic "unknown tool" rejection. Keep the terminal message usable for
  // the caller while dropping protocol markup and preserving ordinary text.
  const content = message.content.flatMap(block => {
    if (block?.type !== "text") return [block];
    const text = sanitizeMiniCPM5Text(block.text)
      .replace(/<function\b[\s\S]*?<\/function\s*>/gi, "")
      .replace(/<function\b[\s\S]*$/gi, "")
      .trim();
    return text ? [{ ...block, text }] : [];
  });
  return { ...message, content };
}

function errorMessage(error, model) {
  return {
    role: "assistant" as const,
    content: [],
    api: model?.api || "openai-completions",
    provider: model?.provider || MINICPM5_LOCAL_PROVIDER,
    model: model?.id || "MiniCPM5-2B",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error" as const,
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}
