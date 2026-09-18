// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { SessionConfirmationPrompt } from '../../components/input/SessionConfirmationPrompt';
import { useStore } from '../../stores';
import type { SessionConfirmationBlock } from '../../stores/chat-types';

const STATE = {
  enabled: true,
  connectors: [{
    id: 'github',
    name: 'GitHub',
    permissionMode: 'review-all',
    toolPermissions: {},
    tools: [
      { name: 'search/issues', qualifiedName: 'github_search_issues', capability: 'github_search_issues.invoke' },
      {
        name: 'delete/repo',
        qualifiedName: 'github_delete_repo',
        capability: 'github_delete_repo.invoke',
        annotations: { destructiveHint: true },
      },
    ],
  }],
};

const hanaFetchMock = vi.fn<(path: string, opts?: RequestInit) => Promise<Response>>(
  async (path: string) => (path === '/api/mcp/state'
    ? new Response(JSON.stringify(STATE), { status: 200 })
    : new Response('{}', { status: 200 })),
);

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (path: string, opts?: RequestInit) => hanaFetchMock(path, opts),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

function approvalBlock(payload: Record<string, unknown>): SessionConfirmationBlock {
  return {
    type: 'session_confirmation',
    confirmId: 'confirm-mcp-1',
    kind: 'tool_action_approval',
    surface: 'input',
    status: 'pending',
    title: '允许 Hana 执行这次操作',
    subject: { label: 'mcp_github_search_issues', detail: '' },
    severity: 'elevated',
    actions: { confirmLabel: '同意', rejectLabel: '拒绝' },
    payload,
  };
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: '更多确认选项' }));
}

function bodyFor(path: string) {
  const call = hanaFetchMock.mock.calls.find(entry => entry[0] === path);
  return call?.[1]?.body ? JSON.parse(String(call[1].body)) : null;
}

describe('MCP tool approval prompt', () => {
  beforeEach(() => {
    hanaFetchMock.mockClear();
    useStore.setState({ currentSessionId: 'sess_1' } as any);
  });

  afterEach(cleanup);

  it('offers the two remembering options alongside the whole-conversation one', async () => {
    render(React.createElement(SessionConfirmationPrompt, {
      block: approvalBlock({ toolName: 'mcp_github_search_issues', params: {} }),
    }));

    await waitFor(() => expect(screen.getByText(/GitHub · search\/issues/)).toBeTruthy());
    openMenu();

    expect(screen.getByTestId('mcp-approve-session')).toBeTruthy();
    expect(screen.getByTestId('mcp-approve-always')).toBeTruthy();
    // The existing whole-conversation switch is a different, broader decision
    // and stays available beside them.
    expect(screen.getByRole('menuitem', { name: '本对话不再询问' })).toBeTruthy();
  });

  it('grants for the session and then approves', async () => {
    render(React.createElement(SessionConfirmationPrompt, {
      block: approvalBlock({ toolName: 'mcp_github_search_issues', params: {} }),
    }));

    await waitFor(() => expect(screen.getByText(/GitHub · search\/issues/)).toBeTruthy());
    openMenu();
    fireEvent.click(screen.getByTestId('mcp-approve-session'));

    await waitFor(() => expect(bodyFor('/api/confirm/confirm-mcp-1')).toBeTruthy());
    expect(bodyFor('/api/mcp/session-permissions')).toEqual({
      sessionId: 'sess_1',
      capability: 'github_search_issues.invoke',
    });
    expect(bodyFor('/api/confirm/confirm-mcp-1')).toEqual({ action: 'confirmed' });
  });

  it('records a permanent grant against the connector without erasing its peers', async () => {
    hanaFetchMock.mockImplementation(async (path: string) => (path === '/api/mcp/state'
      ? new Response(JSON.stringify({
        ...STATE,
        connectors: [{ ...STATE.connectors[0], toolPermissions: { other_tool: 'allow' } }],
      }), { status: 200 })
      : new Response('{}', { status: 200 })));

    render(React.createElement(SessionConfirmationPrompt, {
      block: approvalBlock({ toolName: 'mcp_github_search_issues', params: {} }),
    }));

    await waitFor(() => expect(screen.getByText(/GitHub · search\/issues/)).toBeTruthy());
    openMenu();
    fireEvent.click(screen.getByTestId('mcp-approve-always'));

    await waitFor(() => expect(bodyFor('/api/mcp/connectors/github')).toBeTruthy());
    expect(bodyFor('/api/mcp/connectors/github')).toEqual({
      permissionMode: 'allowlist',
      toolPermissions: { other_tool: 'allow', 'search/issues': 'allow' },
    });
  });

  it('offers no permanent grant for a tool the server declares destructive', async () => {
    render(React.createElement(SessionConfirmationPrompt, {
      block: approvalBlock({ toolName: 'mcp_github_delete_repo', params: {} }),
    }));

    await waitFor(() => expect(screen.getByText(/GitHub · delete\/repo/)).toBeTruthy());
    openMenu();

    // The engine vetoes a grant on a declared-destructive tool, so the UI must
    // not offer one it cannot honour.
    expect(screen.queryByTestId('mcp-approve-always')).toBeNull();
    expect(screen.getByTestId('mcp-approve-session')).toBeTruthy();
  });

  it('marks a destructive tool as danger regardless of the generic severity', async () => {
    const { container } = render(React.createElement(SessionConfirmationPrompt, {
      block: approvalBlock({ toolName: 'mcp_github_delete_repo', params: {} }),
    }));

    await waitFor(() => expect(screen.getByText(/GitHub · delete\/repo/)).toBeTruthy());
    expect(container.querySelector('[data-severity="danger"]')).toBeTruthy();
  });

  it('names the real tool when the call came through the bridge', async () => {
    render(React.createElement(SessionConfirmationPrompt, {
      block: {
        ...approvalBlock({ toolName: 'mcp_call', params: { server: 'github', tool: 'search/issues' } }),
        subject: { label: 'mcp_call', detail: '' },
      },
    }));

    // "mcp_call" tells the user nothing about what is being asked.
    await waitFor(() => expect(screen.getByText(/GitHub · search\/issues/)).toBeTruthy());
    expect(screen.queryByText('mcp_call')).toBeNull();
  });

  it('leaves a non-MCP tool approval exactly as it was', async () => {
    render(React.createElement(SessionConfirmationPrompt, {
      block: { ...approvalBlock({ toolName: 'write', params: { path: 'note.md' } }), subject: { label: 'write' } },
    }));

    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalledWith('/api/mcp/state', undefined));
    openMenu();

    expect(screen.queryByTestId('mcp-approve-session')).toBeNull();
    expect(screen.queryByTestId('mcp-approve-always')).toBeNull();
    expect(screen.getByRole('menuitem', { name: '本对话不再询问' })).toBeTruthy();
  });

  it('does not offer a session grant when there is no session to hold it', async () => {
    useStore.setState({ currentSessionId: null } as any);
    render(React.createElement(SessionConfirmationPrompt, {
      block: approvalBlock({ toolName: 'mcp_github_search_issues', params: {} }),
    }));

    await waitFor(() => expect(screen.getByText(/GitHub · search\/issues/)).toBeTruthy());
    openMenu();

    expect(screen.queryByTestId('mcp-approve-session')).toBeNull();
  });
});
