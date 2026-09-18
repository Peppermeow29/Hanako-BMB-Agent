// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentReviewCard } from '../../components/chat/AgentReviewCard';
import { AgentReviewRequestCard } from '../../components/chat/AgentReviewRequestCard';
import { useStore } from '../../stores';
import { loadSessions, switchSession } from '../../stores/session-actions';

vi.mock('../../stores/session-actions', () => ({
  loadSessions: vi.fn(),
  switchSession: vi.fn(),
}));

const REVIEWED_SESSION_ID = 'sess_reviewed_secret_id';
const REVIEWER_SESSION_ID = 'sess_reviewer_secret_id';

describe('Agent review cards', () => {
  beforeEach(() => {
    window.t = ((key: string, params?: Record<string, string>) => {
      const messages: Record<string, string> = {
        'agentReview.openSession': '打开审阅对话',
        'agentReview.openReviewedSession': '打开来源对话',
        'agentReview.requestReceived': '已收到来自另一个对话的审阅请求',
        'agentReview.running': '正在审阅当前对话',
        'agentReview.completed': '另一位助手的审阅结果',
        'agentReview.failed': '审阅失败',
        'agentReview.cancelled': '审阅已取消',
        'agentReview.reviewedSessionFallback': '来源对话',
        'agentReview.reviewSessionFallback': `${params?.name ?? ''} 的审阅对话`,
        'sessionCollab.fromAgent': `来自 ${params?.name ?? ''} 的消息`,
      };
      return messages[key] ?? key;
    }) as typeof window.t;
    useStore.setState({
      locale: 'zh',
      agents: [
        { id: 'maomao', name: '毛毛', yuan: 'maomao', isPrimary: false, homeFolder: '/agents/maomao' },
      ],
      sessions: [
        {
          path: '/sessions/reviewed.jsonl',
          sessionId: REVIEWED_SESSION_ID,
          title: '夏日写作讨论',
          firstMessage: '原始问题',
          modified: '',
          messageCount: 3,
          agentId: 'hanako',
          agentName: '小黎',
          cwd: null,
        },
        {
          path: '/sessions/reviewer.jsonl',
          sessionId: REVIEWER_SESSION_ID,
          title: '毛毛的审阅',
          firstMessage: '请审阅',
          modified: '',
          messageCount: 2,
          agentId: 'maomao',
          agentName: '毛毛',
          cwd: null,
        },
      ],
    } as never);
    vi.mocked(loadSessions).mockReset();
    vi.mocked(switchSession).mockReset();
    vi.mocked(switchSession).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the source conversation title without exposing its Session ID and opens it from the whole card', async () => {
    render(<AgentReviewRequestCard request={{
      reviewedSessionId: REVIEWED_SESSION_ID,
      reviewerAgentId: 'maomao',
      reviewerAgentName: '毛毛',
    }} />);

    expect(screen.getByText('夏日写作讨论')).toBeInTheDocument();
    expect(screen.queryByText(REVIEWED_SESSION_ID)).not.toBeInTheDocument();
    const card = screen.getByRole('link', { name: '打开来源对话' });
    fireEvent.click(card);

    await waitFor(() => {
      expect(switchSession).toHaveBeenCalledWith('/sessions/reviewed.jsonl');
    });
  });

  it('renders a centered third-party Agent message with the review conversation title and keyboard navigation', async () => {
    render(<AgentReviewCard review={{
      status: 'completed',
      reviewedSessionId: REVIEWED_SESSION_ID,
      reviewerSessionId: REVIEWER_SESSION_ID,
      reviewerAgentId: 'maomao',
      reviewerAgentName: '毛毛',
      text: '<pulse>Vibe: 已完成审阅</pulse>\n\n## 审阅结论\n\n- 第一条意见\n- 第二条意见',
    }} />);

    expect(screen.getByText('来自 毛毛 的消息')).toBeInTheDocument();
    expect(screen.getByText('毛毛的审阅')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: '审阅结论' })).toBeInTheDocument();
    expect(screen.getByText('第一条意见')).toBeInTheDocument();
    expect(screen.getByText('第二条意见')).toBeInTheDocument();
    expect(screen.queryByText('<pulse>')).not.toBeInTheDocument();
    expect(screen.queryByText(REVIEWER_SESSION_ID)).not.toBeInTheDocument();
    const card = screen.getByRole('link', { name: '打开审阅对话' });
    fireEvent.keyDown(card, { key: 'Enter' });

    await waitFor(() => {
      expect(switchSession).toHaveBeenCalledWith('/sessions/reviewer.jsonl');
    });
  });
});
