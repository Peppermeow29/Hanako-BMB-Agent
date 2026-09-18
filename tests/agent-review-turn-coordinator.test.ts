import { describe, expect, it, vi } from 'vitest';
/* eslint-disable @typescript-eslint/no-explicit-any -- focused runtime boundary test fixtures */
import {
  AgentReviewTurnCoordinator,
  buildReviewedTurnPrompt,
  buildReviewerPrompt,
  buildSessionReferenceBlock,
} from '../lib/agent-review/turn-coordinator.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('AgentReviewTurnCoordinator', () => {
  it('holds the parent turn until the independent reviewer Session completes', async () => {
    const reviewer = deferred<{ text: string }>();
    const calls: any[] = [];
    const engine = {
      emitEvent: vi.fn(),
      getSessionManifest: vi.fn(() => ({ workspaceScope: { cwd: '/work', workspaceFolders: [], authorizedFolders: [] } })),
      createDetachedSession: vi.fn(async () => ({ sessionId: 'sess_review', sessionPath: '/review.jsonl' })),
      getSessionIdForPath: vi.fn(() => 'sess_review'),
      getSessionByPath: vi.fn(() => ({ model: { id: 'shared-model', provider: 'openai' } })),
    };
    const submitSessionMessage = vi.fn(async (_engine, input) => {
      calls.push(input);
      if (input.sessionId === 'sess_review') return reviewer.promise;
      return { text: 'parent reply' };
    });
    const statuses: any[] = [];
    const coordinator = new AgentReviewTurnCoordinator({
      engine,
      submitSessionMessage,
      emitStatus: status => statuses.push(status),
    });

    const running = coordinator.start({
      requestId: 'client-1',
      reviewedSessionId: 'sess_parent',
      reviewedSessionPath: '/parent.jsonl',
      reviewer: { agentId: 'critic', label: 'Critic' },
      text: 'Please inspect this @Critic',
      sessionRefs: [{ sessionId: 'sess_context', label: 'Context' }],
      clientMessageId: 'client-1',
      displayMessage: { text: 'Please inspect this @Critic' },
    });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(coordinator.hasPendingParent('sess_parent')).toBe(true);
    expect(calls[0].sessionId).toBe('sess_review');
    expect(calls[0].text).toContain('被审阅 Session ID：sess_parent');

    reviewer.resolve({ text: 'Independent findings' });
    await running;

    expect(calls).toHaveLength(2);
    expect(calls[1].sessionId).toBe('sess_parent');
    expect(calls[1].text).toContain('[另一位 Agent 的审阅结果]');
    expect(calls[1].text).toContain('审阅记录所在 Session ID：sess_review');
    expect(calls[1].text).toContain('Independent findings');
    expect(calls[1].displayMessage.agentReview).toMatchObject({
      reviewedSessionId: 'sess_parent',
      reviewerSessionId: 'sess_review',
      reviewerAgentId: 'critic',
    });
    expect(coordinator.hasPendingParent('sess_parent')).toBe(false);
    expect(statuses.map(status => status.status)).toContain('completed');
    expect(engine.createDetachedSession).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'critic', visibleInSessionList: true, permissionMode: 'read_only',
      model: { id: 'shared-model', provider: 'openai' },
    }));
  });

  it('fails visibly and never invokes the parent Agent when review fails', async () => {
    const statuses: any[] = [];
    const engine = {
      emitEvent: vi.fn(),
      getSessionManifest: vi.fn(() => null),
      createDetachedSession: vi.fn(async () => ({ sessionId: 'sess_review', sessionPath: '/review.jsonl' })),
      getSessionIdForPath: vi.fn(() => 'sess_review'),
      getSessionByPath: vi.fn(() => ({ model: { id: 'shared-model', provider: 'openai' } })),
    };
    const submitSessionMessage = vi.fn(async () => { throw new Error('resolver denied'); });
    const coordinator = new AgentReviewTurnCoordinator({
      engine,
      submitSessionMessage,
      emitStatus: status => statuses.push(status),
    });

    await coordinator.start({
      reviewedSessionId: 'sess_parent', reviewedSessionPath: '/parent.jsonl',
      reviewer: { agentId: 'critic' }, text: 'Review',
    });

    expect(submitSessionMessage).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toMatchObject({ status: 'failed', error: 'resolver denied' });
    expect(engine.emitEvent).toHaveBeenLastCalledWith(
      { type: 'session_status', isStreaming: false }, '/parent.jsonl',
    );
  });

  it('formats IDs as references without creating relationship fields', () => {
    expect(buildSessionReferenceBlock([{ sessionId: 'sess_a', label: 'A' }])).toContain('sess_a');
    expect(buildReviewerPrompt({ reviewedSessionId: 'sess_parent', userText: 'Check' })).toContain('自行决定');
    expect(buildReviewedTurnPrompt({
      userText: 'Check', reviewedSessionId: 'sess_parent', reviewerSessionId: 'sess_review',
      reviewerAgentId: 'critic', reviewerAgentName: 'Critic', reviewText: 'OK',
    })).not.toMatch(/parentSessionId|childSessionId|relationId/);
  });
});
