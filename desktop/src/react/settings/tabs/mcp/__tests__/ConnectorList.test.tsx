/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorList } from '../ConnectorList';
import type { McpConnector } from '../types';

vi.mock('../../../helpers', () => {
  // Keys still render as themselves, which is what the label assertions below
  // rely on. Keys the component fills in carry a stand-in template with the
  // same placeholders as the shipped strings, substituted the way the real
  // translator does, so what the component computed can be asserted on.
  const templates: Record<string, string> = {
    'settings.mcp.toolCollisionNotice': '{a} and {b} collide',
    'settings.mcp.toolCollisionSummary': '{count} tools collide with {other}',
    'settings.mcp.toolCollisionHostNotice': '{a} collides with the built-in status tool',
  };
  return {
    t: (key: string, params?: Record<string, any>) => Object.entries(params || {}).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      templates[key] ?? key,
    ),
  };
});

function connector(overrides: Partial<McpConnector> = {}): McpConnector {
  return {
    id: 'alpha',
    name: 'Alpha',
    transport: 'remote',
    url: 'https://alpha.example.com/mcp',
    status: 'stopped',
    tools: [],
    ...overrides,
  };
}

function renderList(props: Partial<React.ComponentProps<typeof ConnectorList>> = {}) {
  const onOpen = vi.fn();
  const onAction = vi.fn();
  const onRemove = vi.fn();
  render(
    <ConnectorList
      connectors={[connector()]}
      globalEnabled
      busyKeys={new Set()}
      agentConfig={{ connectors: {} }}
      onOpen={onOpen}
      onAction={onAction}
      onRemove={onRemove}
      {...props}
    />,
  );
  return { onOpen, onAction, onRemove };
}

afterEach(cleanup);

describe('ConnectorList', () => {
  it('shows the runtime error a failed connector recorded', () => {
    renderList({
      connectors: [connector({ status: 'failed', error: 'spawn ENOENT' })],
    });

    // "failed" on its own says nothing actionable; the recorded reason is the
    // point of looking at the row.
    expect(screen.getByTestId('mcp-connector-error-alpha').textContent).toBe('spawn ENOENT');
  });

  it('tells a switched-off connector apart from one that merely is not running', () => {
    renderList({
      connectors: [
        connector({ id: 'off', name: 'Off', status: 'stopped', enabled: false }),
        connector({ id: 'idle', name: 'Idle', status: 'stopped', enabled: true }),
      ],
    });

    // Both sit at status "stopped", but one is waiting to be started and the
    // other was switched off; one label for both would hide the difference.
    expect(screen.getByText('settings.mcp.statusDisabled')).toBeTruthy();
    expect(screen.getByText('settings.mcp.statusStopped')).toBeTruthy();
  });

  it('does not render an error line for a healthy connector', () => {
    renderList({ connectors: [connector({ status: 'running' })] });

    expect(screen.queryByTestId('mcp-connector-error-alpha')).toBeNull();
  });

  it('names both sides of a dropped tool whose id is ambiguous', () => {
    renderList({
      connectors: [connector({
        status: 'running',
        collisions: [{
          canonical: 'alpha_daily_report',
          toolName: 'daily_report',
          otherConnectorId: 'alpha',
          otherToolName: 'daily_report_backup',
        }],
      })],
    });

    // Without the notice the tool is simply absent, which is indistinguishable
    // from a server that never offered it. Naming both claimants is what tells
    // the user which of the two names to change.
    const notice = screen.getByTestId('mcp-connector-collisions-alpha').textContent || '';
    expect(notice).toContain('alpha/daily_report');
    expect(notice).toContain('alpha/daily_report_backup');
  });

  it('folds a whole-connector clash into one summary instead of one line per tool', () => {
    renderList({
      connectors: [connector({
        status: 'running',
        collisions: Array.from({ length: 50 }, (_, index) => ({
          canonical: `alpha_tool_${index}`,
          toolName: `tool_${index}`,
          otherConnectorId: 'Alpha',
          otherToolName: `tool_${index}`,
        })),
      })],
    });

    // Two connector ids that normalize onto each other is one mistake with one
    // fix. Fifty red lines saying so would bury the row it is attached to.
    const rows = screen.getAllByTestId('mcp-connector-collision-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toBe('50 tools collide with Alpha');
  });

  it('keeps one line per tool when a connector clashes with itself', () => {
    renderList({
      connectors: [connector({
        status: 'running',
        collisions: [
          {
            canonical: 'alpha_daily_report',
            toolName: 'daily_report',
            otherConnectorId: 'alpha',
            otherToolName: 'daily_report_备份',
          },
          {
            canonical: 'alpha_daily_report',
            toolName: 'daily_report_备份',
            otherConnectorId: 'alpha',
            otherToolName: 'daily_report',
          },
        ],
      })],
    });

    // Each of these is a separate pair of tool names to correct, so summarizing
    // them would drop the only information that makes them actionable.
    const rows = screen.getAllByTestId('mcp-connector-collision-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('alpha/daily_report and alpha/daily_report_备份');
    expect(rows[1].textContent).toContain('alpha/daily_report_备份 and alpha/daily_report');
  });

  it('says only the connector tool went away when it clashes with the built-in tool', () => {
    renderList({
      connectors: [connector({
        status: 'running',
        collisions: [{
          canonical: 'connectors_status',
          toolName: 'status',
          otherConnectorId: 'mcp',
          otherToolName: 'connectors_status',
          host: true,
        }],
      })],
    });

    // The built-in diagnostic survives this clash, so the generic notice would
    // be telling the user something that did not happen.
    const rows = screen.getAllByTestId('mcp-connector-collision-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toBe('alpha/status collides with the built-in status tool');
  });

  it('renders no collision notice when nothing is ambiguous', () => {
    renderList({ connectors: [connector({ status: 'running' })] });

    expect(screen.queryByTestId('mcp-connector-collisions-alpha')).toBeNull();
  });

  it('opens the detail view when the row is clicked', () => {
    const { onOpen } = renderList();

    fireEvent.click(screen.getByTestId('mcp-connector-row-alpha'));

    expect(onOpen).toHaveBeenCalledWith('alpha');
  });

  it('opens the detail view from the keyboard', () => {
    const { onOpen } = renderList();

    fireEvent.keyDown(screen.getByTestId('mcp-connector-row-alpha'), { key: 'Enter' });

    expect(onOpen).toHaveBeenCalledWith('alpha');
  });

  it('hands removal to the caller rather than deciding by itself', () => {
    const { onRemove } = renderList();

    fireEvent.click(screen.getByText('common.remove'));

    // The row asks; the confirmation is a real dialog owned by the tab, not a
    // blocking window.confirm.
    expect(onRemove).toHaveBeenCalledWith('alpha');
  });

  it('keeps one connector busy from disabling another', () => {
    renderList({
      connectors: [connector(), connector({ id: 'beta', name: 'Beta' })],
      busyKeys: new Set(['start-alpha']),
    });

    const startButtons = screen.getAllByText('settings.mcp.start') as HTMLButtonElement[];
    expect(startButtons[0].disabled).toBe(true);
    expect(startButtons[1].disabled).toBe(false);
  });

  it('does not disable edit and remove through one shared key', () => {
    renderList({ busyKeys: new Set(['remove-alpha']) });

    const manage = screen.getByText('settings.mcp.manage') as HTMLButtonElement;
    const remove = screen.getByText('common.remove') as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    // Managing a connector is a read; a pending removal has no reason to block it.
    expect(manage.disabled).toBe(false);
  });

  it('counts the agents the connector is enabled for', () => {
    renderList({
      connectors: [connector({ tools: [{ name: 'search' }] })],
      agentConfig: { connectors: { alpha: { enabled: true } } },
    });

    expect(screen.getByText(/1 settings\.mcp\.enabledAgentsCount/)).toBeTruthy();
  });

  it('offers stop instead of start once the connector is live', () => {
    renderList({ connectors: [connector({ status: 'running' })] });

    expect(screen.queryByText('settings.mcp.start')).toBeNull();
    expect(screen.getByText('settings.mcp.stop')).toBeTruthy();
  });
});
