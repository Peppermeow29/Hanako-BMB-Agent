/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const switchSessionMock = vi.fn();
const locateSearchHitMock = vi.fn();

vi.mock('../../stores/session-actions', () => ({
  switchSession: (...args: unknown[]) => switchSessionMock(...args),
}));

vi.mock('../../stores/chat-find-actions', () => ({
  locateSearchHit: (...args: unknown[]) => locateSearchHitMock(...args),
}));

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { SessionSearchItem } from '../../components/SessionList';

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    path: '/tmp/agents/hana/sessions/result.jsonl',
    title: 'Result title',
    firstMessage: 'hello',
    modified: '2026-05-22T08:00:00.000Z',
    messageCount: 2,
    agentId: 'hana',
    agentName: 'Hana',
    cwd: '/tmp/project',
    matchKind: 'content' as const,
    snippet: 'a snippet',
    ...overrides,
  };
}

describe('SessionSearchItem click routing', () => {
  beforeEach(() => {
    switchSessionMock.mockReset();
    locateSearchHitMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('routes content match hits through locateSearchHit with the query, not switchSession', () => {
    const result = makeResult({ matchKind: 'content' });
    render(
      <SessionSearchItem result={result as never} isActive={false} agents={[]} query="排查" />,
    );

    fireEvent.click(screen.getByText('Result title').closest('button')!);

    expect(locateSearchHitMock).toHaveBeenCalledWith(result.path, '排查');
    expect(switchSessionMock).not.toHaveBeenCalled();
  });

  it('routes title match hits through switchSession, not locateSearchHit', () => {
    const result = makeResult({ matchKind: 'title' });
    render(
      <SessionSearchItem result={result as never} isActive={false} agents={[]} query="排查" />,
    );

    fireEvent.click(screen.getByText('Result title').closest('button')!);

    expect(switchSessionMock).toHaveBeenCalledWith(result.path);
    expect(locateSearchHitMock).not.toHaveBeenCalled();
  });

  it('falls back to switchSession for a content match when the query is blank', () => {
    const result = makeResult({ matchKind: 'content' });
    render(
      <SessionSearchItem result={result as never} isActive={false} agents={[]} query="   " />,
    );

    fireEvent.click(screen.getByText('Result title').closest('button')!);

    expect(switchSessionMock).toHaveBeenCalledWith(result.path);
    expect(locateSearchHitMock).not.toHaveBeenCalled();
  });
});
