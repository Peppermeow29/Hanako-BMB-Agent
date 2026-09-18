import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The agent avatar endpoint no longer picks an agent for the caller. Whoever
 * builds the URL knows which agent is on screen, so it has to say so — and when
 * it genuinely does not know yet, it must show no avatar rather than let the
 * server guess one.
 */
vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
  hanaUrl: (path: string) => `http://127.0.0.1:1234${path}`,
}));

vi.mock('../../stores/preview-actions', () => ({ closePreview: vi.fn() }));

import { useStore } from '../../stores';
import { loadAvatars } from '../../stores/agent-actions';

describe('loadAvatars agent ownership', () => {
  beforeEach(() => {
    useStore.setState({ agentAvatarUrl: null, userAvatarUrl: null, currentAgentId: null } as never);
  });

  it('names the agent in the avatar URL', () => {
    loadAvatars({ agent: true, user: true }, 'other');
    const state = useStore.getState();
    expect(state.agentAvatarUrl).toMatch(/\/api\/avatar\/agent\?/);
    expect(state.agentAvatarUrl).toContain('agentId=other');
    // The user avatar is agent-independent and must stay unqualified.
    expect(state.userAvatarUrl).toMatch(/\/api\/avatar\/user\?/);
    expect(state.userAvatarUrl).not.toContain('agentId=');
  });

  it('falls back to the agent the client already selected', () => {
    useStore.setState({ currentAgentId: 'hana' } as never);
    loadAvatars({ agent: true, user: true });
    expect(useStore.getState().agentAvatarUrl).toContain('agentId=hana');
  });

  it('shows no agent avatar rather than an unqualified request', () => {
    loadAvatars({ agent: true, user: true });
    expect(useStore.getState().agentAvatarUrl).toBeNull();
    expect(useStore.getState().userAvatarUrl).not.toBeNull();
  });
});
