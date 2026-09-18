import { describe, expect, it, vi } from 'vitest';
import { resolveMcpApprovalTarget } from '../../components/input/mcp-approval-actions';
import type { SessionConfirmationBlock } from '../../stores/chat-types';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

const CONNECTORS = [
  {
    id: 'github',
    name: 'GitHub',
    permissionMode: 'allowlist' as const,
    toolPermissions: { search_issues: 'allow' as const },
    tools: [
      {
        name: 'search/issues',
        qualifiedName: 'github_search_issues',
        capability: 'github_search_issues.invoke',
      },
      {
        name: 'delete/repo',
        qualifiedName: 'github_delete_repo',
        capability: 'github_delete_repo.invoke',
        annotations: { destructiveHint: true },
      },
    ],
  },
];

function approval(payload: Record<string, unknown>): SessionConfirmationBlock {
  return {
    type: 'session_confirmation',
    confirmId: 'c1',
    kind: 'tool_action_approval',
    surface: 'input',
    status: 'pending',
    title: 'Tool action',
    payload,
  };
}

describe('resolveMcpApprovalTarget', () => {
  it('matches a directly loaded tool by its namespaced name', () => {
    const target = resolveMcpApprovalTarget(
      approval({ toolName: 'mcp_github_search_issues', params: {} }),
      CONNECTORS,
    );

    expect(target).toMatchObject({
      connectorId: 'github',
      connectorName: 'GitHub',
      toolName: 'search/issues',
      capability: 'github_search_issues.invoke',
      destructive: false,
    });
  });

  it('unwraps a deferred tool called through the bridge', () => {
    const target = resolveMcpApprovalTarget(
      approval({ toolName: 'mcp_call', params: { server: 'github', tool: 'search/issues' } }),
      CONNECTORS,
    );

    // The prompt must name the tool the user is being asked about, not the
    // bridge that happens to carry it.
    expect(target?.toolName).toBe('search/issues');
    expect(target?.capability).toBe('github_search_issues.invoke');
  });

  it('carries the destructive declaration through', () => {
    const target = resolveMcpApprovalTarget(
      approval({ toolName: 'mcp_github_delete_repo', params: {} }),
      CONNECTORS,
    );

    expect(target?.destructive).toBe(true);
  });

  it('carries the connector policy so a grant cannot erase its peers', () => {
    const target = resolveMcpApprovalTarget(
      approval({ toolName: 'mcp_github_search_issues', params: {} }),
      CONNECTORS,
    );

    expect(target?.toolPermissions).toEqual({ search_issues: 'allow' });
    expect(target?.permissionMode).toBe('allowlist');
  });

  it('returns nothing for a tool that is not an MCP tool', () => {
    expect(resolveMcpApprovalTarget(approval({ toolName: 'write_file', params: {} }), CONNECTORS)).toBeNull();
  });

  it('returns nothing for an MCP-looking name no connector claims', () => {
    // Failing to resolve must not be papered over with a guess: an unmatched
    // name means the prompt offers no memory options at all.
    expect(resolveMcpApprovalTarget(approval({ toolName: 'mcp_ghost_tool', params: {} }), CONNECTORS)).toBeNull();
  });

  it('returns nothing for a bridge call naming an unknown server', () => {
    expect(resolveMcpApprovalTarget(
      approval({ toolName: 'mcp_call', params: { server: 'gitlab', tool: 'search/issues' } }),
      CONNECTORS,
    )).toBeNull();
  });

  it('ignores confirmations that are not tool approvals', () => {
    const elicitation = { ...approval({ toolName: 'mcp_github_search_issues' }), kind: 'mcp_elicitation' };
    expect(resolveMcpApprovalTarget(elicitation, CONNECTORS)).toBeNull();
  });

  it('skips tools the server did not give an identity', () => {
    const legacy = [{ id: 'github', name: 'GitHub', tools: [{ name: 'search/issues' }] }];
    expect(resolveMcpApprovalTarget(
      approval({ toolName: 'mcp_github_search_issues', params: {} }),
      legacy,
    )).toBeNull();
  });
});
