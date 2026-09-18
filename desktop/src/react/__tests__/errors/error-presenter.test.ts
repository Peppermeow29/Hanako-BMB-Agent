import { describe, expect, it } from 'vitest';
import {
  errorWithCode,
  localizedReasonOrRaw,
  presentError,
  presentErrorWithLabel,
} from '../../errors/error-presenter';

const STRINGS: Record<string, string> = {
  'error.code.sessionForkActiveTask': '这条消息之后还有任务在跑，等它结束再从这里分支',
  'error.code.sessionBusy': '会话正忙，稍后再试',
  'error.code.unexpected': '出了点意外',
};

const translate = (key: string): string => STRINGS[key] ?? key;

describe('error-presenter', () => {
  it('speaks the localized sentence and keeps the raw English as detail', () => {
    const error = errorWithCode(
      'active task cannot be shared by a session fork: subagent-1785635522479-v82otz',
      'session_fork_active_task',
    );

    expect(presentError(error, { translate })).toEqual({
      text: '这条消息之后还有任务在跑，等它结束再从这里分支',
      detail: 'active task cannot be shared by a session fork: subagent-1785635522479-v82otz',
      code: 'session_fork_active_task',
    });
  });

  it('falls back to the generic sentence for codes that are not worth their own copy', () => {
    const error = errorWithCode('session pin order is empty', 'session_pin_order_empty');

    expect(presentError(error, { translate })).toEqual({
      text: '出了点意外',
      detail: 'session pin order is empty',
      code: 'session_pin_order_empty',
    });
  });

  it('never renders a raw i18n key when a locale file is missing the entry', () => {
    // translate() echoes the key back when the string is absent; showing that to a
    // user is worse than showing the English sentence the backend already gave us.
    const bare = (key: string): string => key;
    const error = errorWithCode('session is busy right now', 'session_busy');

    expect(presentError(error, { translate: bare })).toEqual({
      text: 'session is busy right now',
      detail: null,
      code: 'session_busy',
    });
  });

  it('handles low-level failures that carry no code at all', () => {
    const error = new Error(
      "/opt/hana/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node: "
      + "version `GLIBC_2.29' not found",
    );

    expect(presentError(error, { translate })).toEqual({
      text: '出了点意外',
      detail: expect.stringContaining('GLIBC_2.29'),
      code: null,
    });
  });

  it('accepts plain strings and empty messages without inventing detail', () => {
    expect(presentError('boom', { translate })).toEqual({
      text: '出了点意外',
      detail: 'boom',
      code: null,
    });
    expect(presentError(new Error(''), { translate })).toEqual({
      text: '出了点意外',
      detail: null,
      code: null,
    });
  });

  it('drops the detail when it would merely repeat the localized text', () => {
    const error = errorWithCode('会话正忙，稍后再试', 'session_busy');

    expect(presentError(error, { translate })).toEqual({
      text: '会话正忙，稍后再试',
      detail: null,
      code: 'session_busy',
    });
  });

  it('does not echo the code into detail when the backend message was the code itself', () => {
    const error = errorWithCode('session_busy', 'session_busy');

    expect(presentError(error, { translate })).toEqual({
      text: '会话正忙，稍后再试',
      detail: null,
      code: 'session_busy',
    });
  });

  it('errorWithCode carries the code on a real Error instance', () => {
    const error = errorWithCode('boom', 'session_busy');

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('boom');
    expect(error.code).toBe('session_busy');
    expect(errorWithCode('boom', null).code).toBeUndefined();
  });
});

describe('presentErrorWithLabel', () => {
  it('prefixes the localized action label without touching detail or code', () => {
    const error = errorWithCode('active workflow must finish before Fork', 'session_fork_active_task');

    expect(presentErrorWithLabel('新建会话失败', error, { translate })).toEqual({
      text: '新建会话失败: 这条消息之后还有任务在跑，等它结束再从这里分支',
      detail: 'active workflow must finish before Fork',
      code: 'session_fork_active_task',
    });
  });

  it('keeps a native crash readable while parking the stack in detail', () => {
    // The server process failing to load its native addon has no error code at all.
    const error = new Error(
      "/opt/hana/server/node_modules/better-sqlite3/build/Release/"
      + "better_sqlite3.node: version `GLIBC_2.29' not found",
    );

    const presented = presentErrorWithLabel('新建会话失败', error, { translate });

    expect(presented.text).toBe('新建会话失败: 出了点意外');
    expect(presented.detail).toContain('GLIBC_2.29');
    expect(presented.code).toBeNull();
  });

  it('skips the separator when there is no label', () => {
    expect(presentErrorWithLabel('', 'boom', { translate }).text).toBe('出了点意外');
  });
});

describe('localizedReasonOrRaw', () => {
  // 单行 toast 没有详情区，正文是唯一载体，所以这条档位链跟 presentError 不同：
  // 原文排在通用兜底文案前面。四档逐一钉死，任何一档被拿掉都要有用例变红。
  it('第一档：错误码翻得出人话就说人话', () => {
    const error = errorWithCode('session is busy right now', 'session_busy');
    expect(localizedReasonOrRaw(error, translate)).toBe('会话正忙，稍后再试');
  });

  it('第二档：没有码时保留后端原文，不换成通用兜底句', () => {
    const error = new Error('ENOENT: agent config is unreadable');
    expect(localizedReasonOrRaw(error, translate)).toBe('ENOENT: agent config is unreadable');
  });

  it('第二档：语言包漏配某条时也退回原文，绝不把 i18n key 当文案显示', () => {
    const bare = (key: string): string => key;
    const error = errorWithCode('session is busy right now', 'session_busy');
    expect(localizedReasonOrRaw(error, bare)).toBe('session is busy right now');
  });

  it('第三档：原文为空时退到错误码，调用方拼出来才不会是"失败: "这样的半句话', () => {
    // 服务端把消息落成了空串（顶层错误处理器包装时偶有此形），此时错误码是
    // 唯一还剩下的线索，显示它也好过让用户看见一个悬在冒号后面的空白。
    const error = errorWithCode('', 'agent_model_not_available');
    const bare = (key: string): string => key;
    expect(localizedReasonOrRaw(error, bare)).toBe('agent_model_not_available');
  });

  it('第四档：原文和错误码都没有时才落到通用兜底文案', () => {
    expect(localizedReasonOrRaw(new Error(''), translate)).toBe('出了点意外');
  });
});
