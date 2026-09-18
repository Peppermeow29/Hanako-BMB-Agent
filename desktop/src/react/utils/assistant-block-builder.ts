import type { ContentBlock, ToolCall } from '../stores/chat-types';
import { renderMarkdown } from './markdown';
import { parseCardFromContent, parseMoodFromContent } from './message-parser';

interface AssistantBlockInput {
  content: string;
  thinking?: string | null;
  toolCalls?: Array<{
    id?: string;
    toolCallId?: string;
    name: string;
    args?: Record<string, unknown>;
    status?: 'succeeded' | 'failed' | 'unknown';
    success?: boolean;
    error?: string;
  }> | null;
  extraBlocks?: ContentBlock[] | null;
  includeTextSource?: boolean;
}

function extractInlineThinking(value: string): { text: string; thinking: string } {
  if (!value || !/<think\b/i.test(value)) return { text: value, thinking: '' };
  const thinkingParts: string[] = [];
  const visibleParts: string[] = [];
  const pattern = /<think\s*>\s*([\s\S]*?)\s*<\/think\s*>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    visibleParts.push(value.slice(cursor, match.index));
    if (match[1]) thinkingParts.push(match[1]);
    cursor = match.index + match[0].length;
  }
  const remainder = value.slice(cursor);
  const unclosed = /<think\s*>\s*([\s\S]*)$/i.exec(remainder);
  if (unclosed) {
    visibleParts.push(remainder.slice(0, unclosed.index));
    if (unclosed[1]) thinkingParts.push(unclosed[1].trim());
  } else {
    visibleParts.push(remainder);
  }
  return { text: visibleParts.join(''), thinking: thinkingParts.join('\n') };
}

function sanitizeAssistantProtocolText(value: string): string {
  if (!value || !/(?:<function\b|<pokong-enode\b|<\/param>|<\/function>|\]{1,2}>\s*<\/param>)/i.test(value)) {
    return value;
  }
  return value
    .replace(/<pokong-enode\b[\s\S]*?<\/pokong-enode>/gi, '')
    .replace(/<function\b[\s\S]*?<\/function\s*>/gi, '')
    .replace(/<function\b[\s\S]*$/gi, '')
    .replace(/\s*(?:\]{1,2}>\s*)?<\/param>\s*<\/function>\s*$/i, '')
    .trim();
}

export function buildAssistantBlocksFromContent({
  content,
  thinking = null,
  toolCalls = null,
  extraBlocks = null,
  includeTextSource = false,
}: AssistantBlockInput): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  const inline = extractInlineThinking(content || '');
  const visibleContent = sanitizeAssistantProtocolText(inline.text);
  const combinedThinking = [thinking || '', inline.thinking].filter(Boolean).join('\n');

  if (thinking !== null && thinking !== undefined || inline.thinking) {
    blocks.push({ type: 'thinking', content: combinedThinking, sealed: true });
  }

  const { mood, yuan, text: afterMood } = parseMoodFromContent(visibleContent);
  if (mood && yuan) {
    blocks.push({ type: 'mood', yuan, text: mood });
  }

  if (toolCalls?.length) {
    blocks.push({
      type: 'tool_group',
      tools: toolCalls.map<ToolCall>((tc) => ({
        id: tc.id || tc.toolCallId || undefined,
        name: tc.name,
        args: tc.args,
        done: true,
        success: tc.status === 'succeeded' || (tc.status === undefined && tc.success !== false),
        status: tc.status || (tc.success === false ? 'failed' : 'succeeded'),
        ...(tc.error ? { error: tc.error } : {}),
      })),
      collapsed: toolCalls.length > 1,
    });
  }

  const { cards, text: mainText } = parseCardFromContent(afterMood);
  if (mainText) {
    blocks.push({
      type: 'text',
      html: renderMarkdown(mainText),
      ...(includeTextSource ? { source: mainText } : {}),
    });
  }

  for (const card of cards) {
    blocks.push({ type: 'plugin_card', card });
  }

  if (extraBlocks?.length) {
    blocks.push(...extraBlocks);
  }

  return blocks;
}
