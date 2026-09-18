import { describe, expect, it } from 'vitest';
import {
  pickQuickChatRuntimeAgent,
  resolveQuickChatPermissionMode,
  shouldAdoptRuntimeAgentForQuickChat,
} from '../quick-chat-runtime';

describe('quick chat runtime state', () => {
  it('prefers the current persisted agent from a fresh agent list', () => {
    const agent = pickQuickChatRuntimeAgent([
      { id: 'hana', name: 'Hana', isPrimary: true },
      { id: 'ming', name: 'Ming', isCurrent: true },
    ]);

    expect(agent?.id).toBe('ming');
  });

  it('keeps an existing detached session bound to its original agent', () => {
    expect(shouldAdoptRuntimeAgentForQuickChat('/sessions/quick.jsonl')).toBe(false);
  });

  it('adopts the runtime agent before a detached session exists', () => {
    expect(shouldAdoptRuntimeAgentForQuickChat(null)).toBe(true);
  });

  it('reads permission defaults from the preferences route while keeping old response shapes compatible', () => {
    expect(resolveQuickChatPermissionMode({ permissionMode: 'read_only' })).toBe('read_only');
    expect(resolveQuickChatPermissionMode({ defaultMode: 'operate' })).toBe('operate');
    expect(resolveQuickChatPermissionMode({ mode: 'auto' })).toBe('auto');
    expect(resolveQuickChatPermissionMode({})).toBe('ask');
  });
});
