import { injectSessionTurnContextMessages } from "./session-turn-context.ts";

export const NOVEL_WRITING_MODES = Object.freeze(["continue", "detailed", "review", "recall"]);
const MAX_CONTEXT_TOKENS = 32_768;
const MAX_OUTPUT_TOKENS = 4_096;

const MODE_DEFAULTS = Object.freeze({
  continue: {
    activeContextTokens: 16_384,
    maxOutputTokens: 1_024,
    generation: { temperature: 0.65, topP: 0.9, topK: 40, minP: 0.05, repetitionPenalty: 1.08 },
  },
  detailed: {
    activeContextTokens: 16_384,
    maxOutputTokens: 2_048,
    generation: { temperature: 0.75, topP: 0.92, topK: 40, minP: 0.05, repetitionPenalty: 1.06 },
  },
  review: {
    activeContextTokens: 32_768,
    maxOutputTokens: 1_024,
    generation: { temperature: 0.2, topP: 0.8, topK: 20, minP: 0, repetitionPenalty: 1.03 },
  },
  recall: {
    activeContextTokens: 32_768,
    maxOutputTokens: 2_048,
    generation: { temperature: 0.3, topP: 0.85, topK: 30, minP: 0.02, repetitionPenalty: 1.04 },
  },
});

function positiveInteger(value: unknown, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function supportedMode(value: unknown): value is keyof typeof MODE_DEFAULTS {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MODE_DEFAULTS, value);
}

export type NovelWritingProfile = {
  version: 1;
  mode: keyof typeof MODE_DEFAULTS;
  activeContextTokens: number;
  maxOutputTokens: number;
  generation: {
    temperature: number;
    topP: number;
    topK: number;
    minP: number;
    repetitionPenalty: number;
  };
};

export function normalizeNovelWritingProfile(value: unknown): NovelWritingProfile | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<NovelWritingProfile>;
  if (!supportedMode(candidate.mode)) return null;
  const defaults = MODE_DEFAULTS[candidate.mode];
  const generation: Record<string, unknown> = candidate.generation && typeof candidate.generation === "object"
    ? candidate.generation as Record<string, unknown>
    : {};
  return {
    version: 1,
    mode: candidate.mode,
    activeContextTokens: positiveInteger(candidate.activeContextTokens, defaults.activeContextTokens, MAX_CONTEXT_TOKENS),
    maxOutputTokens: positiveInteger(candidate.maxOutputTokens, defaults.maxOutputTokens, MAX_OUTPUT_TOKENS),
    generation: {
      temperature: boundedNumber(generation.temperature, defaults.generation.temperature, 0, 2),
      topP: boundedNumber(generation.topP, defaults.generation.topP, 0, 1),
      topK: boundedNumber(generation.topK, defaults.generation.topK, 0, 200),
      minP: boundedNumber(generation.minP, defaults.generation.minP, 0, 1),
      repetitionPenalty: boundedNumber(generation.repetitionPenalty, defaults.generation.repetitionPenalty, 0, 2),
    },
  };
}

function parseOptionValue(raw: string) {
  const [key, ...parts] = raw.split("=");
  if (!key || parts.length === 0) return null;
  const value = parts.join("=").trim();
  return value ? { key: key.trim().toLowerCase(), value } : null;
}

function profileForMode(mode: keyof typeof MODE_DEFAULTS, overrides: Record<string, string> = {}) {
  const defaults = MODE_DEFAULTS[mode];
  return normalizeNovelWritingProfile({
    version: 1,
    mode,
    activeContextTokens: overrides.context ?? overrides.contexttokens ?? defaults.activeContextTokens,
    maxOutputTokens: overrides.output ?? overrides.maxoutput ?? defaults.maxOutputTokens,
    generation: {
      temperature: overrides.temperature ?? defaults.generation.temperature,
      topP: overrides.top_p ?? overrides.topp ?? defaults.generation.topP,
      topK: overrides.top_k ?? overrides.topk ?? defaults.generation.topK,
      minP: overrides.min_p ?? overrides.minp ?? defaults.generation.minP,
      repetitionPenalty: overrides.repetition_penalty ?? overrides.repetitionpenalty ?? defaults.generation.repetitionPenalty,
    },
  });
}

export type NovelWritingCommand =
  | { type: "set"; profile: NovelWritingProfile }
  | { type: "off" }
  | { type: "status" }
  | { type: "invalid"; message: string };

export function parseNovelWritingCommand(text: unknown): NovelWritingCommand | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/novel")) return null;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts[0] !== "/novel") return null;
  const action = (parts[1] || "status").toLowerCase();
  if (action === "status") return { type: "status" };
  if (action === "off" || action === "disable") return { type: "off" };
  const isCustom = action === "custom" || action === "set";
  const mode = isCustom ? (parts[2] || "continue").toLowerCase() : action;
  if (!supportedMode(mode)) {
    return { type: "invalid", message: "用法：/novel <continue|detailed|review|recall|off|status>，或 /novel custom [mode] output=2048 temperature=0.7" };
  }
  const optionStart = isCustom ? 3 : 2;
  const overrides: Record<string, string> = {};
  for (const part of parts.slice(optionStart)) {
    const option = parseOptionValue(part);
    if (!option) return { type: "invalid", message: `无法识别小说策略参数：${part}` };
    overrides[option.key] = option.value;
  }
  const profile = profileForMode(mode, overrides);
  if (!profile) return { type: "invalid", message: "小说策略参数必须在允许范围内。" };
  return { type: "set", profile };
}

export function describeNovelWritingProfile(profile: NovelWritingProfile | null) {
  if (!profile) return "小说策略：关闭（使用模型与供应商设置中的默认参数）。";
  const g = profile.generation;
  return `小说策略：${profile.mode}；活跃上下文目标 ${profile.activeContextTokens / 1024}K；输出上限 ${profile.maxOutputTokens}；temperature ${g.temperature}，top_p ${g.topP}，top_k ${g.topK}，min_p ${g.minP}，repetition_penalty ${g.repetitionPenalty}。`;
}

export function buildNovelWritingInstruction(profile: NovelWritingProfile | null) {
  if (!profile) return null;
  const modeInstructions = {
    continue: "直接续写当前正文。保持既有人称、时态、叙述视角、人物关系和伏笔连续；不要复述设定，不要解释写作过程。",
    detailed: "直接续写当前正文，优先补足场景、动作、感官细节和人物微妙反应；保持既有人称、时态、叙述视角与伏笔连续。",
    review: "进入小说审稿模式。先核对前文中的人物、时间线、世界规则与未解决伏笔，再给出简洁、可执行的问题和修改建议；除非用户明确要求，不续写正文。",
    recall: "进入全书回顾模式。优先根据当前会话和已有压缩摘要恢复人物、关系、时间线、世界规则、未解决情节和伏笔；明确区分已知事实与缺失信息，不能臆造缺失章节。",
  };
  return [
    "[Hana novel writing profile]",
    modeInstructions[profile.mode],
    `本轮活跃上下文目标为 ${profile.activeContextTokens} tokens；这是端侧性能策略，不代表可凭空恢复未在当前会话或摘要中的正文。`,
    "长篇作品应把已压缩的历史视作结构化记忆：优先保持角色、关系、时间线、世界规则、未解决情节、伏笔和风格约束的一致性。",
    "[/Hana novel writing profile]",
  ].join("\n");
}

function estimateMessageTokens(message: any) {
  if (!message || typeof message !== "object") return 0;
  const content = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part) => (
        typeof part === "string" ? part : (part?.text || part?.content || "")
      )).join("\n")
      : "";
  // Chinese prose commonly uses one or two characters per tokenizer unit while
  // English averages about four. Using two is conservative for a mixed novel.
  return Math.max(1, Math.ceil(content.length / 2));
}

/**
 * Keeps the persisted transcript intact while bounding only the model-visible
 * copy for this request. Pi's later compatibility pass removes any orphaned
 * tool results when an old tool-call pair falls outside the selected window.
 */
export function limitNovelWritingContextMessages(messages: any, profile: NovelWritingProfile | null) {
  if (!profile || !Array.isArray(messages)) return messages;
  const systemMessages = messages.filter((message) => message?.role === "system");
  const nonSystemMessages = messages.filter((message) => message?.role !== "system");
  const systemTokens = systemMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const available = Math.max(512, profile.activeContextTokens - systemTokens);
  const selected: any[] = [];
  let tokens = 0;
  for (let index = nonSystemMessages.length - 1; index >= 0; index -= 1) {
    const message = nonSystemMessages[index];
    const estimated = estimateMessageTokens(message);
    if (selected.length > 0 && tokens + estimated > available) break;
    selected.unshift(message);
    tokens += estimated;
  }
  return [...systemMessages, ...selected];
}

export function applyNovelWritingProviderPayload(payload: any, model: any, profile: NovelWritingProfile | null) {
  if (!payload || typeof payload !== "object" || model?.provider !== "minicpm5-local" || !profile) return payload;
  const maxTokens = Math.min(profile.maxOutputTokens, positiveInteger(model?.maxTokens, MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS));
  return {
    ...payload,
    max_tokens: maxTokens,
    temperature: profile.generation.temperature,
    top_p: profile.generation.topP,
    top_k: profile.generation.topK,
    min_p: profile.generation.minP,
    repetition_penalty: profile.generation.repetitionPenalty,
  };
}

export function createNovelWritingExtension({
  path = "hana-novel-writing-profile",
  sessionPathRef,
  getProfile,
  setProfile,
}: {
  path?: string;
  sessionPathRef?: { current?: string | null };
  getProfile?: (sessionPath: string | null) => NovelWritingProfile | null;
  setProfile?: (profile: NovelWritingProfile | null) => Promise<void> | void;
} = {}) {
  return {
    path,
    tools: new Map(),
    handlers: new Map([
      ["input", [async (event: any, ctx: any) => {
        if (event?.source === "extension") return { action: "continue" };
        const command = parseNovelWritingCommand(event?.text);
        if (!command) return { action: "continue" };
        const sessionPath = sessionPathRef?.current || null;
        if (command.type === "status") {
          ctx?.ui?.notify?.(describeNovelWritingProfile(getProfile?.(sessionPath) || null), "info");
          return { action: "handled" };
        }
        if (command.type === "invalid") {
          ctx?.ui?.notify?.(command.message, "warning");
          return { action: "handled" };
        }
        const profile = command.type === "off" ? null : command.profile;
        await setProfile?.(profile);
        ctx?.ui?.notify?.(describeNovelWritingProfile(profile), "info");
        return { action: "handled" };
      }]],
      ["context", [async (event: any) => {
        const profile = getProfile?.(sessionPathRef?.current || null) || null;
        const instruction = buildNovelWritingInstruction(profile);
        if (!instruction) return undefined;
        const withInstruction = injectSessionTurnContextMessages(event?.messages, {
          beforeUser: instruction,
          metadata: { feature: "novel_writing_profile", mode: profile?.mode },
        });
        return {
          messages: limitNovelWritingContextMessages(withInstruction, profile),
        };
      }]],
    ]),
    flags: new Map(),
    shortcuts: new Map(),
    commands: new Map(),
    messageRenderers: new Map(),
  };
}
