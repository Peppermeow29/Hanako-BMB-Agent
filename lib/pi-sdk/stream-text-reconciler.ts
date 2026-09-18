type SemanticChar = {
  value: string;
  start: number;
  end: number;
};

/**
 * Reconcile a terminal text block against text already emitted by a live
 * stream. Providers can trim, collapse whitespace, or normalize punctuation.
 * Compare semantic characters while retaining original-text coordinates so the
 * remainder is both non-duplicating and faithful to the terminal response.
 */
export function reconcileTerminalText(text: string, streamed: string): string {
  if (!text || !streamed) return text;

  const terminal = semanticChars(text);
  const live = semanticChars(streamed);
  if (terminal.length === 0 || live.length === 0) return text;

  if (sameSemanticChars(terminal, live)) return "";

  if (startsWithSemanticChars(terminal, live)) {
    const boundary = terminal[live.length - 1].end;
    return text.slice(boundary);
  }
  if (startsWithSemanticChars(live, terminal)) return "";

  const suffixLength = commonSemanticSuffixLength(terminal, live);
  if (suffixLength >= Math.min(3, terminal.length)) {
    const suffixStart = terminal[terminal.length - suffixLength].start;
    return text.slice(0, suffixStart);
  }

  const overlapLength = semanticSuffixPrefixLength(live, terminal);
  const minimum = Math.max(6, Math.floor(Math.min(terminal.length, live.length) * 0.2));
  if (overlapLength >= minimum && overlapLength > suffixLength) {
    return text.slice(terminal[overlapLength - 1].end).replace(/^[\s\p{P}]+/u, "");
  }
  return text;
}

function commonSemanticPrefixLength(left: SemanticChar[], right: SemanticChar[]): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length].value === right[length].value) length += 1;
  return length;
}

function semanticChars(value: string): SemanticChar[] {
  const chars: SemanticChar[] = [];
  const pattern = /[^\s\p{P}]/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    chars.push({ value: match[0], start: match.index, end: match.index + match[0].length });
  }
  return chars;
}

function sameSemanticChars(left: SemanticChar[], right: SemanticChar[]): boolean {
  return left.length === right.length && startsWithSemanticChars(left, right);
}

function startsWithSemanticChars(left: SemanticChar[], prefix: SemanticChar[]): boolean {
  if (prefix.length > left.length) return false;
  return prefix.every((character, index) => character.value === left[index].value);
}

function commonSemanticSuffixLength(left: SemanticChar[], right: SemanticChar[]): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (
    length < limit
    && left[left.length - length - 1].value === right[right.length - length - 1].value
  ) length += 1;
  return length;
}

function semanticSuffixPrefixLength(left: SemanticChar[], right: SemanticChar[]): number {
  const limit = Math.min(left.length, right.length) - 1;
  for (let length = limit; length > 0; length -= 1) {
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      if (left[left.length - length + index].value !== right[index].value) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}
