import { describe, expect, it } from 'vitest';
import {
  ERROR_CODE_MESSAGE_KEYS,
  UNKNOWN_ERROR_MESSAGE_KEY,
  errorCodeFromResponseBody,
  normalizeSessionRouteError,
  userMessageKeyForCode,
} from '../../../../../shared/error-user-messages.ts';
import en from '../../../locales/en.json';
import ja from '../../../locales/ja.json';
import ko from '../../../locales/ko.json';
import zh from '../../../locales/zh.json';
import zhTW from '../../../locales/zh-TW.json';

const LOCALES: Record<string, unknown> = { en, ja, ko, zh, 'zh-TW': zhTW };

function lookup(locale: unknown, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    locale,
  );
}

describe('error-user-messages · code → i18n key', () => {
  it('maps the high-frequency session codes users actually hit', () => {
    expect(userMessageKeyForCode('session_fork_active_task')).toBe('error.code.sessionForkActiveTask');
    expect(userMessageKeyForCode('session_busy')).toBe('error.code.sessionBusy');
    expect(userMessageKeyForCode('subagent_run_busy')).toBe('error.code.subagentRunBusy');
  });

  it('maps every user-visible Memory Dream code', () => {
    expect(userMessageKeyForCode('dream_memory_busy')).toBe('error.code.dreamMemoryBusy');
    expect(userMessageKeyForCode('dream_already_running')).toBe('error.code.dreamAlreadyRunning');
    expect(userMessageKeyForCode('dream_no_memory')).toBe('error.code.dreamNoMemory');
    expect(userMessageKeyForCode('dream_revision_not_found')).toBe('error.code.dreamRevisionNotFound');
    expect(userMessageKeyForCode('dream_run_failed')).toBe('error.code.dreamRunFailed');
  });

  it('gives internal contract violations their own copy instead of the generic fallback', () => {
    // These only fire when a caller skipped part of an explicit contract. The user
    // cannot act on the English assertion, so it needs a sentence that says "this is
    // ours, not yours" and parks the original text in the details area.
    expect(userMessageKeyForCode('internal_contract')).toBe('error.code.internalContract');
    expect(ERROR_CODE_MESSAGE_KEYS.internal_contract).not.toBe(UNKNOWN_ERROR_MESSAGE_KEY);
  });

  it('returns null for unmapped codes so callers fall back explicitly', () => {
    expect(userMessageKeyForCode('some_internal_code_nobody_shows')).toBeNull();
    expect(userMessageKeyForCode('')).toBeNull();
    expect(userMessageKeyForCode(null)).toBeNull();
    expect(userMessageKeyForCode(42)).toBeNull();
  });

  it('keeps every mapped key under the error.code namespace', () => {
    for (const [code, key] of Object.entries(ERROR_CODE_MESSAGE_KEYS)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(key).toMatch(/^error\.code\.[A-Za-z]+$/);
    }
  });

  it('exposes a dedicated fallback key that is not one of the mapped codes', () => {
    expect(UNKNOWN_ERROR_MESSAGE_KEY).toBe('error.code.unexpected');
    expect(Object.values(ERROR_CODE_MESSAGE_KEYS)).not.toContain(UNKNOWN_ERROR_MESSAGE_KEY);
  });
});

describe('error-user-messages · locale coverage', () => {
  const keys = [...Object.values(ERROR_CODE_MESSAGE_KEYS), UNKNOWN_ERROR_MESSAGE_KEY];

  it.each(Object.keys(LOCALES))('%s carries copy for every mapped error code', (name) => {
    // A key with no copy makes t() echo the key back, and presentError then falls
    // back to raw English. Mapping a code without writing its copy is a silent
    // regression, so fail here instead.
    const missing = keys.filter((key) => typeof lookup(LOCALES[name], key) !== 'string');
    expect(missing).toEqual([]);
  });

  it.each(Object.keys(LOCALES))('%s leaves no error-code copy blank', (name) => {
    const blank = keys.filter((key) => String(lookup(LOCALES[name], key) ?? '').trim() === '');
    expect(blank).toEqual([]);
  });
});

describe('error-user-messages · response body normalization', () => {
  it('prefers the explicit code field', () => {
    expect(errorCodeFromResponseBody({ error: 'active task blocks fork', code: 'session_fork_active_task' }))
      .toBe('session_fork_active_task');
  });

  it('accepts routes whose error field is the code itself', () => {
    // GET /sessions/fork answers a busy session with { error: "session_busy" } and no code field.
    expect(errorCodeFromResponseBody({ error: 'session_busy' })).toBe('session_busy');
  });

  it('never mistakes a human sentence for a code', () => {
    expect(errorCodeFromResponseBody({ error: 'session not found' })).toBeNull();
    expect(errorCodeFromResponseBody({ error: 'Invalid session path' })).toBeNull();
    expect(errorCodeFromResponseBody({ error: 'GLIBC_2.29 not found' })).toBeNull();
  });

  it('tolerates missing or malformed bodies', () => {
    expect(errorCodeFromResponseBody(null)).toBeNull();
    expect(errorCodeFromResponseBody(undefined)).toBeNull();
    expect(errorCodeFromResponseBody({})).toBeNull();
    expect(errorCodeFromResponseBody('boom')).toBeNull();
    expect(errorCodeFromResponseBody({ code: '   ' })).toBeNull();
  });
});

describe('error-user-messages · normalizeSessionRouteError', () => {
  it('reads the flat shape route handlers answer with', () => {
    expect(normalizeSessionRouteError({
      error: 'session locator is not active',
      code: 'session_locator_not_active',
    })).toEqual({ message: 'session locator is not active', code: 'session_locator_not_active' });
  });

  it('reads the nested shape the top-level onError wrapper answers with', () => {
    // app.onError 把异常包成 { error: { code, message, traceId } }，跟 route handler
    // 自己应答的扁平形状不是一回事。两种都要读得出来，否则用户会看到 "[object Object]"。
    expect(normalizeSessionRouteError({
      error: { code: 'session_manifest_unavailable', message: 'session index is rebuilding', traceId: 't-1' },
    })).toEqual({ message: 'session index is rebuilding', code: 'session_manifest_unavailable' });
  });

  it('keeps the bare-code shape working', () => {
    expect(normalizeSessionRouteError({ error: 'session_busy' }))
      .toEqual({ message: 'session_busy', code: 'session_busy' });
  });

  it('returns a null code when the body carries no code', () => {
    expect(normalizeSessionRouteError({ error: 'Invalid session path' }))
      .toEqual({ message: 'Invalid session path', code: null });
  });

  it('tolerates missing or malformed bodies', () => {
    expect(normalizeSessionRouteError(null)).toEqual({ message: '', code: null });
    expect(normalizeSessionRouteError({})).toEqual({ message: '', code: null });
    expect(normalizeSessionRouteError({ error: { traceId: 't-2' } })).toEqual({ message: '', code: null });
  });
});

describe('error-user-messages · session_create_failed', () => {
  it('maps the synthetic fallback code the create route stamps on coded failures', () => {
    // sessions.ts 的 classifySessionCreationError 在 err 带 status 但没带 code 时
    // 会合成这个码，它会真的出现在响应体里，所以必须有文案，不能落到兜底。
    expect(userMessageKeyForCode('session_create_failed')).toBe('error.code.sessionCreateFailed');
  });
});
