// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../components/chat/AssistantMessage';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';

const addToast = vi.fn();

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../utils/screenshot', () => ({
  takeScreenshot: vi.fn(),
}));

function renderSuggestion(status = 'approved', jobDataOverrides: Record<string, unknown> = {}) {
  return render(
    <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false}
        isSelected={false}
      showAvatar={false}
      sessionPath="/sessions/main.jsonl"
      message={{
        id: 'assistant-automation-1',
        role: 'assistant',
        timestamp: Date.now(),
        blocks: [{
          type: 'suggestion_card',
          kind: 'automation_draft',
          suggestionId: 'automation_suggestion_1',
          suggestionShortCode: '3827',
          status,
          title: '奶茶提醒',
          description: '提醒我喝奶茶',
          target: { type: 'agent', id: 'hanako' },
          detail: {
            kind: 'automation_draft',
            jobData: {
              type: 'cron',
              schedule: '0 12 * * *',
              label: '奶茶提醒',
              prompt: '提醒我喝奶茶',
              actorAgentId: 'hanako',
              ...jobDataOverrides,
            },
          },
        }],
      } as any}
    />,
  );
}

describe('AssistantMessage automation suggestion card', () => {
  beforeEach(() => {
    window.t = ((key: string, params?: Record<string, string>) => {
      if (key === 'automation.promptPlaceholder') return `写下你想让 ${params?.agent || 'Agent'} 做什么`;
      return key;
    }) as typeof window.t;
    useStore.setState({
      agents: [{ id: 'hanako', name: 'Hanako', yuan: 'hanako', homeFolder: '/home/hanako' }],
      agentName: 'Hanako',
      agentYuan: 'hanako',
      currentAgentId: 'hanako',
      currentSessionId: 'session-main',
      currentSessionPath: '/sessions/main.jsonl',
      sessions: [{ sessionId: 'session-main', path: '/sessions/main.jsonl' }],
      streamingSessions: [],
      selectedMessageIdsBySession: {},
      addToast,
    } as never);
    addToast.mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(hanaFetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps a suggestion card clickable with a first-line view tail and no status badge', () => {
    renderSuggestion('approved');

    expect(screen.queryByText('common.approved')).not.toBeInTheDocument();
    expect(screen.queryByText('automation.suggested')).not.toBeInTheDocument();
    expect(screen.getByText('automation.viewSuggestion')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'automation.openDraft' }));

    expect(screen.getByRole('dialog', { name: 'automation.draftTitle' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('奶茶提醒')).toBeInTheDocument();
  });

  it('applies a suggestion through the session-bound one-shot route without calling ConfirmStore', async () => {
    renderSuggestion('pending');

    fireEvent.click(screen.getByRole('button', { name: 'automation.openDraft' }));
    fireEvent.click(screen.getByRole('button', { name: 'automation.confirmCreate' }));

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/desk/cron', expect.objectContaining({
        method: 'POST',
      }));
    });
    const deskCronCall = vi.mocked(hanaFetch).mock.calls.find(([url]) => url === '/api/desk/cron');
    const body = JSON.parse((deskCronCall?.[1] as RequestInit).body as string);
    expect(body).toEqual({
      action: 'apply_suggestion',
      suggestionId: 'automation_suggestion_1',
      sessionId: 'session-main',
      jobData: {
        type: 'cron',
        schedule: '0 12 * * *',
        label: '奶茶提醒',
        prompt: '提醒我喝奶茶',
        model: '',
        targetAgentId: 'hanako',
      },
    });
    expect(hanaFetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/confirm/'), expect.anything());
  });

  it('submits the selected Agent identity from the draft card', async () => {
    useStore.setState({
      agents: [
        { id: 'hanako', name: 'Hanako', yuan: 'hanako', homeFolder: '/home/hanako' },
        { id: 'maomao', name: '毛毛', yuan: 'maomao', homeFolder: '/home/maomao' },
      ],
      currentAgentId: 'hanako',
    } as never);

    renderSuggestion('pending');

    fireEvent.click(screen.getByRole('button', { name: 'automation.openDraft' }));
    fireEvent.click(screen.getByRole('button', { name: 'automation.field.agent' }));
    fireEvent.click(screen.getByRole('option', { name: /毛毛/ }));
    fireEvent.click(screen.getByRole('button', { name: 'automation.confirmCreate' }));

    await waitFor(() => {
      const deskCronCall = vi.mocked(hanaFetch).mock.calls.find(([url]) => url === '/api/desk/cron');
      expect(deskCronCall).toBeTruthy();
      const body = JSON.parse((deskCronCall?.[1] as RequestInit).body as string);
      expect(body.jobData.targetAgentId).toBe('maomao');
      expect(body.jobData.actorAgentId).toBeUndefined();
      expect(body.jobData.executor).toBeUndefined();
      expect(body.jobData.executionContext).toBeUndefined();
    });
  });

  it('submits every suggestion schedules as milliseconds', async () => {
    renderSuggestion('pending', {
      type: 'every',
      schedule: 7_200_000,
      label: '双小时提醒',
    });

    fireEvent.click(screen.getByRole('button', { name: 'automation.openDraft' }));
    fireEvent.click(screen.getByRole('button', { name: 'automation.confirmCreate' }));

    await waitFor(() => {
      const deskCronCall = vi.mocked(hanaFetch).mock.calls.find(([url]) => url === '/api/desk/cron');
      expect(deskCronCall).toBeTruthy();
      const body = JSON.parse((deskCronCall?.[1] as RequestInit).body as string);
      expect(body.jobData.type).toBe('every');
      expect(body.jobData.schedule).toBe(7_200_000);
    });
  });

  it('shows a structured create failure, keeps the draft open, and allows retry', async () => {
    vi.mocked(hanaFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          code: 'cron_store_corrupt',
          message: 'automation task storage is corrupt',
        },
      }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    renderSuggestion('pending');

    fireEvent.click(screen.getByRole('button', { name: 'automation.openDraft' }));
    fireEvent.click(screen.getByRole('button', { name: 'automation.confirmCreate' }));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        'automation.createFailed: automation task storage is corrupt',
        'error',
      );
    });
    expect(screen.getByRole('dialog', { name: 'automation.draftTitle' })).toBeInTheDocument();
    expect(vi.mocked(hanaFetch).mock.calls[0][1]).toEqual(expect.objectContaining({
      throwOnHttpError: false,
    }));

    fireEvent.click(screen.getByRole('button', { name: 'automation.confirmCreate' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'automation.draftTitle' })).not.toBeInTheDocument();
    });
    expect(hanaFetch).toHaveBeenCalledTimes(2);
  });
});
