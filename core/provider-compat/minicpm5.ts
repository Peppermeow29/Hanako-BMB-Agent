/**
 * MiniCPM5's MLX HTTP server accepts the OpenAI envelope and its native
 * chat template converts `tools` into the model's trained `<tools>...</tools>`
 * XML contract. Keep that native representation whenever the current user
 * turn explicitly asks for an operation. Sending a hand-written Markdown
 * catalog here looks compact, but it is out-of-distribution for MiniCPM5 and
 * can make the catalog marker itself become a hallucinated function name.
 */

const MINICPM5_PROVIDER = "minicpm5-local";

// MiniCPM5's trained template has a separate <think> channel.  It is useful
// for multi-step math/algorithm work, but enabling it for every turn makes a
// 2B edge model spend its small output budget on deliberation and can leave
// tool calls half-written.  Keep the classifier deliberately conservative:
// only explicit reasoning signals opt in, while file/tool requests always
// take the deterministic non-thinking path.
const THINKING_INTENT_RE = /(?:数学|算术|方程|不等式|积分|微分|导数|极限|概率|统计|几何|证明|推导|推理|计算题|数学题|算法|复杂度|递归|动态规划|数据结构|证明题|math(?:ematics)?|algebra|equation|inequality|integral|derivative|calculus|geometry|probability|statistics|theorem|proof|prove|deriv(?:e|ation)|reason(?:ing)?|algorithm|dynamic\s+programming|data\s+structure|complexity)/iu;
const VISION_CONTEXT_RE = /<vision-context>[\s\S]*?<\/vision-context>/iu;
const DISABLE_THINKING_RE = /(?:不要|无需|不需要|禁止|不用|关闭|关掉|without|don't|do\s+not|no|disable|disabled|brief|quick|concise)\s*(?:进行|使用|开启|输出|展示)?\s*(?:思考|推理|thinking|reasoning)/iu;
const ANSWER_ONLY_RE = /(?:只|仅)\s*(?:给出|回答|输出)?\s*(?:答案|结果|结论|answer|result|conclusion)/iu;
const MIN_THINKING_OUTPUT_TOKENS = 2_048;

function latestUserText(messages: any[]) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    return message.content
      .filter((part) => part?.type === "text")
      .map((part) => String(part.text || ""))
      .join("\n");
  }
  return "";
}

function messageText(message: any) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text || ""))
    .join("\n");
}

function hasVisionContext(messages: any[]) {
  return Array.isArray(messages) && messages.some(message => VISION_CONTEXT_RE.test(messageText(message)));
}

function insertVisionAnswerInstructions(messages: any[]) {
  const instructions = [
    "The <vision-context> block is the authoritative OCR and visual evidence; do not call an OCR tool.",
    "For math/science problems, preserve formulas in correct LaTeX and finish the complete solution, final choice/result, and a short verification.",
    "Do not truncate the answer.",
  ].join(" ");
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    const message = messages[index];
    if (typeof message.content === "string") {
      return messages.map((entry, position) => position === index
        ? { ...entry, content: `${instructions}\n\n${message.content}` }
        : entry);
    }
    if (Array.isArray(message.content)) {
      return messages.map((entry, position) => position === index
        ? { ...entry, content: [{ type: "text", text: instructions }, ...message.content] }
        : entry);
    }
    return messages;
  }
  return messages;
}

export function matches(model: any) {
  return model?.provider === MINICPM5_PROVIDER;
}

export function apply(payload: any, model: any, options: any = {}) {
  if (!matches(model) || !payload || typeof payload !== "object") return payload;

  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  let next = payload;

  // MiniCPM5 is run with native MLX chat-template thinking disabled. Older
  // session metadata can still make Pi attach reasoning controls, so remove
  // every reasoning carrier at the wire boundary as well.
  if (["reasoning_effort", "reasoning", "thinking", "enable_thinking"].some((key) => (
    Object.prototype.hasOwnProperty.call(next, key)
  ))) {
    const {
      reasoning_effort: _reasoningEffort,
      reasoning: _reasoning,
      thinking: _thinking,
      enable_thinking: _enableThinking,
      ...withoutReasoning
    } = next;
    next = withoutReasoning;
  }

  // Tool definitions are expensive context for a 2B model and make ordinary
  // math/algorithm answers much more likely to emit a spurious XML call. Keep
  // them only for an explicit operation request. The native MLX chat template
  // still owns the exact formatting when they are kept.
  if (tools.length > 0 && Array.isArray(payload.messages) && !hasMiniCPM5ToolIntent(payload.messages, tools)) {
    const { tools: _tools, ...withoutTools } = next;
    next = withoutTools;
  }

  if (hasVisionContext(next.messages)) {
    next = {
      ...next,
      messages: insertVisionAnswerInstructions(next.messages),
    };
  }

  // MLX-LM does not implement OpenAI's tool-selection negotiation. The
  // model's native XML contract is sufficient; retaining `tool_choice` or
  // `parallel_tool_calls` only adds unsupported protocol noise.
  if (Object.prototype.hasOwnProperty.call(next, "tool_choice")
    || Object.prototype.hasOwnProperty.call(next, "parallel_tool_calls")) {
    const {
      tool_choice: _toolChoice,
      parallel_tool_calls: _parallelToolCalls,
      ...withoutNegotiation
    } = next;
    next = withoutNegotiation;
  }

  // The checkpoint's template defaults to an open <think> channel.  Send an
  // explicit per-request override so a model switch, an old session, or a
  // manually started server cannot silently change the policy.  A caller's
  // explicit boolean remains authoritative; otherwise only reasoning-shaped
  // turns opt in and tool turns stay deterministic.
  const existingTemplateKwargs = next.chat_template_kwargs
    && typeof next.chat_template_kwargs === "object"
    ? next.chat_template_kwargs
    : {};
  const explicitThinking = typeof existingTemplateKwargs.enable_thinking === "boolean"
    ? existingTemplateKwargs.enable_thinking
    : null;
  const thinkingEnabled = explicitThinking === null
    ? hasMiniCPM5ThinkingIntent(next.messages, tools)
    : explicitThinking;
  next = {
    ...next,
    chat_template_kwargs: {
      ...existingTemplateKwargs,
      enable_thinking: thinkingEnabled,
    },
  };

  if (thinkingEnabled && !hasExplicitUserOutputCap(options)) {
    const modelLimit = positiveInteger(model?.maxTokens ?? model?.maxOutput);
    const outputFloor = Math.min(modelLimit || MIN_THINKING_OUTPUT_TOKENS, MIN_THINKING_OUTPUT_TOKENS);
    const fields = ["max_tokens", "max_completion_tokens", "max_output_tokens"];
    const currentField = fields.find((field) => Object.prototype.hasOwnProperty.call(next, field));
    const field = currentField || "max_tokens";
    const current = currentField ? positiveInteger(next[currentField]) : null;
    const desired = Math.min(modelLimit || outputFloor, Math.max(outputFloor, current || 0));
    if (current === null || desired > current) {
      next = { ...next, [field]: desired };
    }
  }
  return next;
}

/** Whether the current turn actually needs the native tool catalog. */
export function hasMiniCPM5ToolIntent(messages: any[], tools: any[] = []) {
  if (!Array.isArray(messages)) return false;
  const text = latestUserText(messages).trim();
  // No user message occurs in a few provider-level maintenance calls. Keep
  // the old permissive behavior there so a real tool continuation is not
  // accidentally disabled by an incomplete context snapshot.
  if (!text) return true;
  const toolNames = tools
    .map((entry) => entry?.function?.name || entry?.name)
    .filter((name) => typeof name === "string" && name.trim())
    .map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  // A request can positively name one tool while forbidding every *other*
  // tool (for example: "只调用一次 write，不要调用其他工具").  Check the
  // named-tool intent before the broad negation below; otherwise the latter
  // removes the complete catalog and the model can only echo the requested
  // file content as ordinary text.
  const namedTool = toolNames
    ? new RegExp(`(?:^|[^A-Za-z0-9_.-])(?:${toolNames})(?:$|[^A-Za-z0-9_.-])`, "iu")
    : null;
  const negativeToolName = toolNames
    ? new RegExp(
      `(?:不要|无需|不需要|禁止|不用|without|do\\s+not|don't)[^\\n。！？.!?]{0,36}(?:调用|使用|call|use)?[^\\n。！？.!?]{0,12}(?:${toolNames})(?:$|[^A-Za-z0-9_.-])`,
      "iu",
    )
    : null;
  if (namedTool?.test(text) && !negativeToolName?.test(text)) {
    return true;
  }
  if (/(?:不要|无需|不需要|禁止|不用|without|do\s+not|don't)\s*(?:再)?\s*(?:调用|使用)?\s*(?:任何|其他|any|other)?\s*(?:工具|tool)/iu.test(text)) {
    return false;
  }
  return /(?:调用|使用)\s*(?:工具|function|函数)|(?:读取|查看|打开|写入|写到|保存|存入|修改|编辑|创建|删除)\s*(?:文件|文档|目录|代码)?|(?:运行|执行)\s*(?:命令|脚本|程序)|(?:列出|搜索|查找)\s*(?:文件|目录)|待办|todo|\b(?:read|write|edit|exec_command|grep|find|ls|stage_files)\b|\.(?:md|txt|json|yaml|yml|ts|tsx|js|py|csv)\b/iu.test(text);
}

/** Whether the current user turn warrants MiniCPM5's native think channel. */
export function hasMiniCPM5ThinkingIntent(messages: any[], tools: any[] = []) {
  const text = latestUserText(messages).trim();
  if (!text || DISABLE_THINKING_RE.test(text) || ANSWER_ONLY_RE.test(text)) return false;
  if (hasMiniCPM5ToolIntent(messages, tools)) return false;
  return THINKING_INTENT_RE.test(text);
}

function positiveInteger(value: any) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function hasExplicitUserOutputCap(options: any = {}) {
  const source = String(options.outputBudgetSource || options.maxTokensSource || "").toLowerCase();
  return source === "user" || positiveInteger(options.userMaxTokens) !== null;
}

export const _test = {
  latestUserText,
  hasMiniCPM5ToolIntent,
  hasMiniCPM5ThinkingIntent,
  hasExplicitUserOutputCap,
};
