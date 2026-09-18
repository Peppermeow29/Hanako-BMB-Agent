import { describe, expect, it } from 'vitest';
import { resolveLocateStep } from '../../../components/chat/locate-step';

describe('resolveLocateStep', () => {
  it('目标元素已注册 → scroll', () => {
    expect(resolveLocateStep({ targetIndex: 5, elementPresent: true, itemPresent: true, oldestId: '3', hasMore: true, loadingMore: false, newestNumericId: 11 }))
      .toBe('scroll');
  });
  it('目标早于已加载窗口且可翻页 → load-more', () => {
    expect(resolveLocateStep({ targetIndex: 1, elementPresent: false, itemPresent: false, oldestId: '10', hasMore: true, loadingMore: false, newestNumericId: 20 }))
      .toBe('load-more');
  });
  it('翻页在途 → wait', () => {
    expect(resolveLocateStep({ targetIndex: 1, elementPresent: false, itemPresent: false, oldestId: '10', hasMore: true, loadingMore: true, newestNumericId: 20 }))
      .toBe('wait');
  });
  it('翻页耗尽仍未加载 → give-up', () => {
    expect(resolveLocateStep({ targetIndex: 1, elementPresent: false, itemPresent: false, oldestId: '10', hasMore: false, loadingMore: false, newestNumericId: 20 }))
      .toBe('give-up');
  });
  it('在窗口内但 items 中无该 id（前端不可渲染的消息）→ give-up', () => {
    expect(resolveLocateStep({ targetIndex: 12, elementPresent: false, itemPresent: false, oldestId: '10', hasMore: false, loadingMore: false, newestNumericId: 20 }))
      .toBe('give-up');
  });
  it('items 有该 id 但元素未注册（commit 间隙或不可渲染）→ wait-element（消费方有界等待）', () => {
    expect(resolveLocateStep({ targetIndex: 12, elementPresent: false, itemPresent: true, oldestId: '10', hasMore: false, loadingMore: false, newestNumericId: 20 }))
      .toBe('wait-element');
  });
  it('items 有该 id 且翻页在途 → 仍是 wait-element（loadingMore 不影响该分支）', () => {
    expect(resolveLocateStep({ targetIndex: 12, elementPresent: false, itemPresent: true, oldestId: '10', hasMore: true, loadingMore: true, newestNumericId: 20 }))
      .toBe('wait-element');
  });
  it('目标比已知 canonical 空间新（live 消息拿到文件序号）→ refresh', () => {
    expect(resolveLocateStep({ targetIndex: 12, elementPresent: false, itemPresent: false, oldestId: '10', hasMore: false, loadingMore: false, newestNumericId: 11 }))
      .toBe('refresh');
  });
  it('items 全是 live id（新建会话变体，无数字 id）→ refresh', () => {
    expect(resolveLocateStep({ targetIndex: 0, elementPresent: false, itemPresent: false, oldestId: 'stream-a1', hasMore: false, loadingMore: false, newestNumericId: null }))
      .toBe('refresh');
  });
  it('oldestId 是 live id（id 空间过期）→ refresh', () => {
    expect(resolveLocateStep({ targetIndex: 5, elementPresent: false, itemPresent: false, oldestId: 'stream-a1', hasMore: false, loadingMore: false, newestNumericId: 8 }))
      .toBe('refresh');
  });
});
