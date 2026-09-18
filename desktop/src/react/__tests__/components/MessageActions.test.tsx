// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageActions } from '../../components/chat/MessageActions';
import { useStore } from '../../stores';

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'common.copyText': '复制文本',
      'common.screenshot': '截图',
      'common.selectMessage': '选择消息',
      'common.selectAllMessages': '全选消息',
    }[key] || key),
  }),
}));

describe('MessageActions', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      selectedIdsBySession: {},
      chatSessions: {
        '/session/a.jsonl': {
          hasMore: false,
          loadingMore: false,
          items: [
            { type: 'message', data: { id: 'm1', role: 'user', text: '问' } },
            { type: 'compaction', id: 'c1', yuan: '摘要' },
            { type: 'message', data: { id: 'm2', role: 'assistant', blocks: [{ type: 'text', html: '<p>答</p>' }] } },
          ],
        },
      },
    } as never);
  });

  it('selects all loaded messages in the current session from the hover actions', () => {
    render(
      <MessageActions
        messageId="m1"
        sessionPath="/session/a.jsonl"
        onCopy={vi.fn()}
        onScreenshot={vi.fn()}
        copied={false}
        isStreaming={false}
      />,
    );

    const selectAll = screen.getByTitle('全选消息');

    fireEvent.click(selectAll);

    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toEqual(['m1', 'm2']);
    expect(selectAll).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(selectAll);

    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toBeUndefined();
    expect(selectAll).toHaveAttribute('aria-pressed', 'false');
  });

  it('toggles a provided message selection group from the select action', () => {
    render(
      <MessageActions
        messageId="m2"
        selectionIds={['m1', 'm2']}
        sessionPath="/session/a.jsonl"
        onCopy={vi.fn()}
        onScreenshot={vi.fn()}
        copied={false}
        isStreaming={false}
      />,
    );

    const select = screen.getByTitle('选择消息');

    fireEvent.click(select);

    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toEqual(['m1', 'm2']);
    expect(select).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(select);

    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toBeUndefined();
    expect(select).toHaveAttribute('aria-pressed', 'false');
  });
});
