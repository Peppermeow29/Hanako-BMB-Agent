import { describe, expect, it } from 'vitest';
import { buildItemsFromHistory } from '../../utils/history-builder';

describe('buildItemsFromHistory origin 数据链（跨 Session 协作）', () => {
  it('带 origin 的 user 消息以 displayText 为正文，不含模型侧身份前缀', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: '0',
        role: 'user',
        content: '[来自 Agent「Hana」的消息，非用户本人]\n干净正文',
        origin: { kind: 'agent', agentId: 'hana', agentName: 'Hana' },
        displayText: '干净正文',
        timestamp: 1,
      }],
    } as any);

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.origin).toEqual({ kind: 'agent', agentId: 'hana', agentName: 'Hana' });
    expect(first.data.text).toBe('干净正文');
    expect(first.data.textHtml).toContain('干净正文');
  });

  it('无 origin 的老消息即便正文含相似前缀字样也按现状原样展示，不做任何前缀剥离', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: '0',
        role: 'user',
        content: '[来自 Agent「Hana」的消息，非用户本人]\n干净正文',
        timestamp: 1,
      }],
    } as any);

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.origin).toBeUndefined();
    expect(first.data.text).toContain('[来自 Agent「Hana」的消息，非用户本人]');
  });

  it('origin 存在但 displayText 缺失时退回 content 既有管道，不抛错', () => {
    const items = buildItemsFromHistory({
      messages: [{
        id: '0',
        role: 'user',
        content: '（插话，无需 MOOD）\n先别展开',
        origin: { kind: 'agent', agentId: 'hana', agentName: 'Hana' },
        timestamp: 1,
      }],
    } as any);

    const first = items[0];
    expect(first.type).toBe('message');
    if (first.type !== 'message') throw new Error('expected message');
    expect(first.data.origin).toEqual({ kind: 'agent', agentId: 'hana', agentName: 'Hana' });
    // 没有 displayText 时走既有 content 管道，既有的 legacy steer 前缀剥离逻辑照常生效
    expect(first.data.text).toBe('先别展开');
  });
});
