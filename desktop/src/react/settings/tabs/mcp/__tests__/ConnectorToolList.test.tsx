/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorToolList } from '../detail/ConnectorToolList';
import type { McpConnector } from '../types';

vi.mock('../../../helpers', () => ({
  t: (key: string) => key,
}));

function connector(overrides: Partial<McpConnector> = {}): McpConnector {
  return {
    id: 'alpha',
    name: 'Alpha',
    transport: 'remote',
    url: 'https://alpha.example.com/mcp',
    status: 'running',
    permissionMode: 'allowlist',
    tools: [
      { name: 'search_issues', description: 'Search the issue tracker' },
      { name: 'create_issue', description: 'Open a new issue' },
      { name: 'delete_repo', description: 'Delete a repository', annotations: { destructiveHint: true } },
      { name: 'read_file', description: 'Read a file', annotations: { readOnlyHint: true } },
    ],
    ...overrides,
  };
}

function renderTools(props: Partial<React.ComponentProps<typeof ConnectorToolList>> = {}) {
  const onToolsEnabledChange = vi.fn();
  const onToolPermissionChange = vi.fn();
  const onToolPinnedChange = vi.fn();
  render(
    <ConnectorToolList
      connector={connector()}
      enabledTools={{}}
      agentConnectorEnabled
      disabled={false}
      busy={false}
      onToolsEnabledChange={onToolsEnabledChange}
      onToolPermissionChange={onToolPermissionChange}
      onToolPinnedChange={onToolPinnedChange}
      {...props}
    />,
  );
  return { onToolsEnabledChange, onToolPermissionChange, onToolPinnedChange };
}

afterEach(cleanup);

describe('ConnectorToolList', () => {
  it('filters the list by name and description', () => {
    renderTools();

    fireEvent.change(screen.getByLabelText('settings.mcp.toolSearch'), { target: { value: 'issue' } });

    expect(screen.queryByText('search_issues')).toBeTruthy();
    expect(screen.queryByText('create_issue')).toBeTruthy();
    expect(screen.queryByText('delete_repo')).toBeNull();
  });

  it('selects every tool in one request rather than one per tool', () => {
    const { onToolsEnabledChange } = renderTools();

    fireEvent.click(screen.getByText('settings.mcp.selectAll'));

    expect(onToolsEnabledChange).toHaveBeenCalledTimes(1);
    expect(onToolsEnabledChange).toHaveBeenCalledWith({
      search_issues: true,
      create_issue: true,
      delete_repo: true,
      read_file: true,
    });
  });

  it('only touches tools the search is currently showing', () => {
    const { onToolsEnabledChange } = renderTools();

    fireEvent.change(screen.getByLabelText('settings.mcp.toolSearch'), { target: { value: 'issue' } });
    fireEvent.click(screen.getByText('settings.mcp.selectAll'));

    // A bulk action must not reach tools that scrolled out of the filter.
    expect(onToolsEnabledChange).toHaveBeenCalledWith({ search_issues: true, create_issue: true });
  });

  it('inverts only what actually changes', () => {
    const { onToolsEnabledChange } = renderTools({
      enabledTools: { search_issues: true },
    });

    fireEvent.click(screen.getByText('settings.mcp.selectInvert'));

    expect(onToolsEnabledChange).toHaveBeenCalledWith({
      search_issues: false,
      create_issue: true,
      delete_repo: true,
      read_file: true,
    });
  });

  it('sends nothing when a bulk action would change nothing', () => {
    const { onToolsEnabledChange } = renderTools({
      enabledTools: {
        search_issues: true, create_issue: true, delete_repo: true, read_file: true,
      },
    });

    fireEvent.click(screen.getByText('settings.mcp.selectAll'));

    expect(onToolsEnabledChange).not.toHaveBeenCalled();
  });

  it('badges what the server declares about each tool', () => {
    renderTools();

    expect(screen.getByText('settings.mcp.badgeDestructive')).toBeTruthy();
    expect(screen.getByText('settings.mcp.badgeReadOnly')).toBeTruthy();
  });

  it('offers no silent-approval switch for a destructive tool', () => {
    renderTools();

    const allowSwitches = screen.getAllByLabelText(/settings\.mcp\.permissionAllow$/) as HTMLButtonElement[];
    const destructive = allowSwitches.find(node => node.getAttribute('aria-label')?.startsWith('delete_repo'));
    const ordinary = allowSwitches.find(node => node.getAttribute('aria-label')?.startsWith('search_issues'));

    // The engine refuses to honour a grant on a declared-destructive tool, so
    // the control that would offer one is disabled rather than lying.
    expect(destructive?.disabled).toBe(true);
    expect(ordinary?.disabled).toBe(false);
  });

  it('disables silent approval entirely while the connector reviews everything', () => {
    renderTools({ connector: connector({ permissionMode: 'review-all' }) });

    const allowSwitches = screen.getAllByLabelText(/settings\.mcp\.permissionAllow$/) as HTMLButtonElement[];
    expect(allowSwitches.every(node => node.disabled)).toBe(true);
  });

  it('cannot select tools while the connector is off for this agent', () => {
    renderTools({ agentConnectorEnabled: false });

    expect((screen.getByText('settings.mcp.selectAll') as HTMLButtonElement).disabled).toBe(true);
  });

  it('reports an empty search rather than showing an empty list', () => {
    renderTools();

    fireEvent.change(screen.getByLabelText('settings.mcp.toolSearch'), { target: { value: 'zzz' } });

    expect(screen.getByText('settings.mcp.noToolMatches')).toBeTruthy();
  });

  it('collapses the whole list', () => {
    renderTools();

    fireEvent.click(screen.getByText(/settings\.mcp\.toolsTitle/));

    expect(screen.queryByText('search_issues')).toBeNull();
  });
});
