import { MINICPM5_CONTEXT_WINDOW, MINICPM5_PROVIDER_ID } from "../providers/minicpm5-local.ts";

const MINICPM5_PROVIDER = MINICPM5_PROVIDER_ID;
const DEFAULT_CONTEXT_BUDGET = 16_384;
const DEFAULT_OUTPUT_RESERVE = 4_096;
const DEFAULT_TOOL_RESULT_CHARS = 8_000;
const DEFAULT_MAX_TOOL_RESULTS = 6;
const LONG_CONTEXT_RE = /(?:32\s*k|长文本|全文|全书|完整上下文|上下文窗口|回顾上下文|续写小说|long\s+context|full\s+context|recall|review)/iu;
const PROFILE_FLAG = Symbol.for("hana.piSdk.minicpm5AgentProfileInstalled");

export function isMiniCPM5Model(model: any) {
  return model?.provider === MINICPM5_PROVIDER;
}

function stableJson(value: any, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "undefined" : encoded;
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, seen)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(",")}}`;
}

function messageText(message: any): string {
  if (!message || typeof message !== "object") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part: any) => {
    if (typeof part === "string") return part;
    if (part?.type === "text" || part?.type === "thinking") return String(part.text ?? part.thinking ?? "");
    return "";
  }).join("");
}

/**
 * Estimate the tokenizer cost of a model-facing message without loading the
 * Python tokenizer into the Electron process.  A plain `length / 4` heuristic
 * is unsafe for MiniCPM's Chinese workloads: most Han characters are close to
 * one token, so a 32K-character Chinese chapter would be treated as only 8K
 * tokens and could overflow the real 32K window.  Count CJK syllabic scripts
 * conservatively and retain the usual four-ASCII-characters-per-token rule
 * for the rest.  This is intentionally an upper-bound-ish projection; the
 * persisted transcript remains untouched when the estimate causes trimming.
 */
function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length || 0;
  const remainder = cjk > 0
    ? text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, "")
    : text;
  const fourChars = Math.ceil(remainder.length / 4);
  // Short whitespace-delimited pieces such as `x ` are frequently one token
  // in code/context probes. A plain character/4 estimate would count 32K of
  // them as roughly 16K and could let a real prompt exceed the model window.
  const shortAsciiWords = remainder.match(/(?:^|\s)[A-Za-z0-9_]{1,2}(?=\s|$)/g)?.length || 0;
  return cjk + Math.max(fourChars, shortAsciiWords);
}

function estimateMessageTokens(message: any): number {
  try {
    // Include a small structural allowance for role/type/id keys that are not
    // part of the visible text but are still serialized into the prompt.
    return Math.max(1, estimateTextTokens(JSON.stringify(message)) + 16);
  } catch {
    return Math.max(1, estimateTextTokens(messageText(message)) + 8);
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = Math.max(1, Math.floor(maxChars * 0.78));
  const tail = Math.max(1, maxChars - head);
  return `${value.slice(0, head)}\n...[MiniCPM5 context projection truncated ${value.length - maxChars} chars]...\n${value.slice(-tail)}`;
}

function projectContent(content: any, maxChars: number): any {
  if (typeof content === "string") return truncateText(content, maxChars);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== "object") return part;
    if (typeof part.text === "string") return { ...part, text: truncateText(part.text, maxChars) };
    if (typeof part.thinking === "string") return { ...part, thinking: truncateText(part.thinking, maxChars) };
    return part;
  });
}

function normalizeMessageForMiniCPM5(message: any, toolResultChars: number): any {
  if (!message || typeof message !== "object") return message;
  if (message.role !== "toolResult") return { ...message };
  return {
    ...message,
    content: projectContent(message.content, toolResultChars),
    ...(typeof message.details === "string" ? { details: truncateText(message.details, toolResultChars) } : {}),
  };
}

function latestUserIndex(messages: any[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function hasLongContextRequest(messages: any[]): boolean {
  const index = latestUserIndex(messages);
  return index >= 0 && LONG_CONTEXT_RE.test(messageText(messages[index]));
}

function toolCallIds(message: any): Set<string> {
  const ids = new Set<string>();
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return ids;
  for (const block of message.content) {
    if (block?.type === "toolCall" && typeof block.id === "string" && block.id) ids.add(block.id);
  }
  return ids;
}

function removeOrphanToolResults(messages: any[]): any[] {
  const seenToolCallIds = new Set<string>();
  const next: any[] = [];
  for (const message of messages) {
    if (message?.role === "assistant") {
      for (const id of toolCallIds(message)) seenToolCallIds.add(id);
      next.push(message);
      continue;
    }
    if (message?.role === "toolResult") {
      const id = message.toolCallId;
      if (typeof id === "string" && seenToolCallIds.has(id)) next.push(message);
      continue;
    }
    next.push(message);
  }
  return next;
}

/**
 * Project only the copy sent to MiniCPM5. The session JSONL and agent state
 * remain untouched, so compaction/history export still sees the full record.
 */
export function projectMiniCPM5ContextMessages(messages: any[], options: any = {}): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return Array.isArray(messages) ? messages.slice() : messages;

  const requestedContextWindow = Number.isFinite(options.contextWindow)
    ? Math.floor(options.contextWindow)
    : MINICPM5_CONTEXT_WINDOW;
  const contextWindow = Math.min(
    MINICPM5_CONTEXT_WINDOW,
    Math.max(2_048, requestedContextWindow),
  );
  const outputReserve = Number.isFinite(options.outputReserve)
    ? Math.max(512, Math.floor(options.outputReserve))
    : DEFAULT_OUTPUT_RESERVE;
  const maxInputTokens = Math.max(
    1_024,
    Math.min(
      contextWindow - Math.min(outputReserve, Math.floor(contextWindow / 2)),
      hasLongContextRequest(messages)
        ? contextWindow - Math.min(outputReserve, Math.floor(contextWindow / 2))
        : (Number.isFinite(options.defaultBudget) ? Math.floor(options.defaultBudget) : DEFAULT_CONTEXT_BUDGET),
    ),
  );
  const toolResultChars = Number.isFinite(options.toolResultChars)
    ? Math.max(512, Math.floor(options.toolResultChars))
    : DEFAULT_TOOL_RESULT_CHARS;
  const normalized = messages.map((message) => normalizeMessageForMiniCPM5(message, toolResultChars));
  const latest = latestUserIndex(normalized);
  const selected = new Set<number>();
  let used = 0;

  // System messages are rare in AgentMessage history, but retaining them is
  // safer than silently dropping a caller-provided system constraint.
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index]?.role !== "system") continue;
    const candidate = normalized[index];
    const cost = estimateMessageTokens(candidate);
    if (used + cost <= maxInputTokens || selected.size === 0) {
      selected.add(index);
      used += cost;
    }
  }

  // Walk backwards so the active turn and the latest user request survive.
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (selected.has(index)) continue;
    const candidate = normalized[index];
    const cost = estimateMessageTokens(candidate);
    if (used + cost <= maxInputTokens) {
      selected.add(index);
      used += cost;
    }
  }

  // Always retain the latest user instruction, trimming only its model-facing
  // copy when a single message is larger than the entire budget.
  if (latest >= 0 && !selected.has(latest)) {
    const candidate = normalized[latest];
    const remainingChars = Math.max(512, (maxInputTokens - Math.max(0, used)) * 4);
    const trimmed = candidate?.role === "user"
      ? { ...candidate, content: projectContent(candidate.content, remainingChars) }
      : candidate;
    selected.add(latest);
    normalized[latest] = trimmed;
  }

  const projected = [...selected].sort((left, right) => left - right).map((index) => normalized[index]);
  return removeOrphanToolResults(projected);
}

/** Keep a caller-supplied model object from bypassing the provider metadata. */
export function normalizeMiniCPM5Model(model: any): any {
  if (!isMiniCPM5Model(model)) return model;
  const requested = Number(model.contextWindow ?? model.context ?? MINICPM5_CONTEXT_WINDOW);
  const contextWindow = Number.isFinite(requested) && requested > 0
    ? Math.min(MINICPM5_CONTEXT_WINDOW, Math.floor(requested))
    : MINICPM5_CONTEXT_WINDOW;
  return { ...model, contextWindow };
}

function latestUserKey(messages: any[]): string {
  const index = latestUserIndex(messages);
  if (index < 0) return "none";
  const message = messages[index];
  return `${index}:${message?.timestamp ?? ""}:${messageText(message)}`;
}

function assistantToolCalls(message: any): any[] {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter((block) => block?.type === "toolCall");
}

function callSignature(toolCall: any, args: any): string {
  return `${String(toolCall?.name || "")}\0${stableJson(args ?? toolCall?.arguments ?? {})}`;
}

function appendGuardNotice(result: any, message: string): any {
  const content = Array.isArray(result?.content) ? result.content.slice() : [];
  content.push({ type: "text", text: `\n[MiniCPM5 loop guard] ${message}` });
  return { ...(result || {}), content, terminate: true };
}

/** State machine used by the adapter-level tool loop guard. */
export function createMiniCPM5LoopGuard(options: any = {}) {
  const maxToolResults = Number.isFinite(options.maxToolResults)
    ? Math.max(1, Math.floor(options.maxToolResults))
    : DEFAULT_MAX_TOOL_RESULTS;
  const state: any = {
    userKey: null,
    signatures: new Set<string>(),
    toolResults: 0,
    consecutiveFailures: 0,
    blocked: false,
    blockReason: "",
    countedResultKeys: new Set<string>(),
  };

  function resetIfNewUser(messages: any[]) {
    const key = latestUserKey(messages);
    if (key === state.userKey) return;
    state.userKey = key;
    state.signatures = new Set();
    state.toolResults = 0;
    state.consecutiveFailures = 0;
    state.blocked = false;
    state.blockReason = "";
    state.countedResultKeys = new Set();
  }

  function ingestHistory(messages: any[], excludedAssistant: any = null) {
    const index = latestUserIndex(messages);
    if (index < 0) return;
    const tail = messages.slice(index + 1);
    for (const message of tail) {
      if (message === excludedAssistant) continue;
      for (const call of assistantToolCalls(message)) {
        state.signatures.add(callSignature(call, call.arguments));
      }
      if (message?.role === "toolResult") {
        const resultKey = typeof message.toolCallId === "string" && message.toolCallId
          ? message.toolCallId
          : stableJson({ toolName: message.toolName, content: message.content });
        if (state.countedResultKeys.has(resultKey)) continue;
        state.countedResultKeys.add(resultKey);
        state.toolResults += 1;
        state.consecutiveFailures = message.isError === true ? state.consecutiveFailures + 1 : 0;
      }
    }
  }

  function beforeToolCall(payload: any) {
    const messages = Array.isArray(payload?.context?.messages) ? payload.context.messages : [];
    resetIfNewUser(messages);
    ingestHistory(messages, payload?.assistantMessage);
    if (state.toolResults >= maxToolResults) {
      state.blocked = true;
      state.blockReason = `tool result limit (${maxToolResults}) reached for this user turn`;
      return { block: true, reason: `[MiniCPM5 loop guard] ${state.blockReason}` };
    }
    const signature = callSignature(payload?.toolCall, payload?.args);
    if (state.signatures.has(signature)) {
      state.blocked = true;
      state.blockReason = `repeated ${payload?.toolCall?.name || "tool"} call with identical arguments`;
      return { block: true, reason: `[MiniCPM5 loop guard] ${state.blockReason}` };
    }
    state.signatures.add(signature);
    return undefined;
  }

  async function afterToolCall(payload: any, signal?: AbortSignal) {
    const messages = Array.isArray(payload?.context?.messages) ? payload.context.messages : [];
    resetIfNewUser(messages);
    ingestHistory(messages, payload?.assistantMessage);
    const result = payload?.result || {};
    const isError = payload?.isError === true || result?.isError === true;
    const resultKey = typeof payload?.toolCall?.id === "string" && payload.toolCall.id
      ? payload.toolCall.id
      : callSignature(payload?.toolCall, payload?.args);
    if (!state.countedResultKeys.has(resultKey)) {
      state.countedResultKeys.add(resultKey);
      state.toolResults += 1;
      state.consecutiveFailures = isError ? state.consecutiveFailures + 1 : 0;
    }
    const previous = typeof options.previousAfterToolCall === "function"
      ? await options.previousAfterToolCall(payload, signal)
      : undefined;
    const merged = previous ? { ...previous } : undefined;
    const shouldStop = state.toolResults >= maxToolResults || state.consecutiveFailures >= 2;
    if (!shouldStop) return merged;
    const reason = state.consecutiveFailures >= 2
      ? "two consecutive tool failures"
      : `tool result limit (${maxToolResults}) reached for this user turn`;
    state.blocked = true;
    state.blockReason = reason;
    const base = merged || {};
    return {
      ...base,
      ...appendGuardNotice(result, reason),
      isError: base.isError ?? (isError || undefined),
      terminate: true,
    };
  }

  function shouldStopAfterTurn({ context }: any = {}) {
    const messages = Array.isArray(context?.messages) ? context.messages : [];
    resetIfNewUser(messages);
    ingestHistory(messages);
    return state.blocked || state.toolResults >= maxToolResults || state.consecutiveFailures >= 2;
  }

  return {
    state,
    beforeToolCall,
    afterToolCall,
    shouldStopAfterTurn,
  };
}

export function installMiniCPM5AgentProfile(session: any, options: any = {}) {
  const agent = session?.agent;
  if (!agent || agent[PROFILE_FLAG]) return;
  const model = session.model || agent.state?.model;
  // This profile is provider-specific.  Leaving non-MiniCPM sessions entirely
  // untouched is important: wrapping their hooks and then returning early
  // would otherwise swallow existing tool/transform callbacks.
  if (!isMiniCPM5Model(model)) return;
  agent[PROFILE_FLAG] = true;

  const boundedModel = normalizeMiniCPM5Model(model);
  if (boundedModel !== model) {
    try { session.model = boundedModel; } catch { /* best effort */ }
    if (agent.state && typeof agent.state === "object") agent.state.model = boundedModel;
  }

  if (typeof options.systemPrompt === "string" && options.systemPrompt.trim()) {
    session.__hanaMiniCPM5SystemPrompt = options.systemPrompt;
    if (agent.state && typeof agent.state === "object") agent.state.systemPrompt = options.systemPrompt;
    try { session._baseSystemPrompt = options.systemPrompt; } catch { /* best effort */ }
  }

  agent.toolExecution = "sequential";
  agent.state.thinkingLevel = "off";

  const previousTransformContext = agent.transformContext;
  agent.transformContext = async (messages: any, signal?: AbortSignal) => {
    const transformed = typeof previousTransformContext === "function"
      ? await previousTransformContext(messages, signal)
      : messages;
    const currentModel = session.model || agent.state?.model;
    if (!isMiniCPM5Model(currentModel)) return transformed;
    return projectMiniCPM5ContextMessages(transformed, {
      contextWindow: Math.min(
        MINICPM5_CONTEXT_WINDOW,
        Number(currentModel.contextWindow) || MINICPM5_CONTEXT_WINDOW,
      ),
      outputReserve: currentModel.maxTokens,
    });
  };

  const guard = createMiniCPM5LoopGuard({
    previousAfterToolCall: agent.afterToolCall,
  });
  const previousBeforeToolCall = agent.beforeToolCall;
  agent.beforeToolCall = async (payload: any, signal?: AbortSignal) => {
    const prior = typeof previousBeforeToolCall === "function"
      ? await previousBeforeToolCall(payload, signal)
      : undefined;
    if (prior?.block) return prior;
    if (!isMiniCPM5Model(session.model || agent.state?.model)) return undefined;
    return guard.beforeToolCall(payload);
  };
  agent.afterToolCall = async (payload: any, signal?: AbortSignal) => {
    return guard.afterToolCall(payload, signal);
  };

  // AgentSession does not expose shouldStopAfterTurn directly, but its Agent
  // creates the loop config on every prompt. Add the guard there so a blocked
  // duplicate call ends the current user turn without another LLM request.
  if (typeof agent.createLoopConfig === "function") {
    const previousCreateLoopConfig = agent.createLoopConfig.bind(agent);
    agent.createLoopConfig = (...args: any[]) => {
      const config = previousCreateLoopConfig(...args);
      const previousStop = config.shouldStopAfterTurn;
      return {
        ...config,
        shouldStopAfterTurn: async (context: any, signal?: AbortSignal) => {
          if (typeof previousStop === "function" && await previousStop(context, signal)) return true;
          return guard.shouldStopAfterTurn(context);
        },
      };
    };
  }

  return guard;
}

export const _test = {
  latestUserIndex,
  hasLongContextRequest,
  estimateMessageTokens,
  callSignature,
};
