/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorForm } from '../ConnectorForm';
import type { McpConnector } from '../types';
import { WindowSurfaceProvider, type WindowSurface } from '../../../../ui/window-surface';

vi.mock('../../../helpers', () => ({
  t: (key: string) => key,
}));

function remoteConnector(): McpConnector {
  return {
    id: 'remote-1',
    name: 'Remote MCP',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    status: 'stopped',
    tools: [],
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('ConnectorForm URL validation', () => {
  it('names the problem in the field instead of waiting for the server to refuse', () => {
    render(<ConnectorForm editingConnector={null} onAdd={vi.fn()} onUpdate={vi.fn()} />);

    const url = screen.getByPlaceholderText('https://mcp.example.com/mcp');
    fireEvent.change(url, { target: { value: 'mcp.example.com' } });

    expect(screen.getByText('settings.mcp.urlInvalid')).toBeTruthy();
    expect(url.getAttribute('aria-invalid')).toBe('true');
  });

  it('rejects a scheme the transport cannot use', () => {
    render(<ConnectorForm editingConnector={null} onAdd={vi.fn()} onUpdate={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('https://mcp.example.com/mcp'), {
      target: { value: 'ftp://mcp.example.com/mcp' },
    });

    expect(screen.getByText('settings.mcp.urlScheme')).toBeTruthy();
  });

  it('blocks submission while the URL is unusable', () => {
    const onAdd = vi.fn();
    render(<ConnectorForm editingConnector={null} onAdd={onAdd} onUpdate={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('https://mcp.example.com/mcp'), {
      target: { value: 'mcp.example.com' },
    });

    expect((screen.getByText('settings.mcp.addConnector') as HTMLButtonElement).disabled).toBe(true);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('accepts a well-formed URL', async () => {
    const onAdd = vi.fn(async () => {});
    render(<ConnectorForm editingConnector={null} onAdd={onAdd} onUpdate={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('https://mcp.example.com/mcp'), {
      target: { value: 'https://mcp.example.com/mcp' },
    });
    fireEvent.click(screen.getByText('settings.mcp.addConnector'));

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('settings.mcp.urlInvalid')).toBeNull();
  });
});

describe('ConnectorForm connection type switch', () => {
  it('asks before rewriting how an existing connector connects', () => {
    const overlayRoot = document.createElement('div');
    document.body.append(overlayRoot);
    const surface: WindowSurface = {
      id: 'settings-modal:mcp-form-test',
      window,
      document,
      overlayRoot,
    };
    render(
      <WindowSurfaceProvider surface={surface}>
        <ConnectorForm editingConnector={remoteConnector()} onAdd={vi.fn()} onUpdate={vi.fn()} />
      </WindowSurfaceProvider>,
    );

    fireEvent.click(screen.getByText('settings.mcp.modeRemote'));
    fireEvent.click(screen.getByText('settings.mcp.modeLocal'));

    // Switching drops the other mode's fields and tears down the live client,
    // so it is a decision, not a toggle.
    expect(within(overlayRoot).getByRole('dialog', { name: 'settings.mcp.modeSwitchTitle' })).toBeTruthy();
    expect(within(overlayRoot).getByText('settings.mcp.modeSwitchBody')).toBeTruthy();
    expect(screen.getByPlaceholderText('https://mcp.example.com/mcp')).toBeTruthy();
  });

  it('keeps the standalone settings confirmation on the document root and applies it', () => {
    render(<ConnectorForm editingConnector={remoteConnector()} onAdd={vi.fn()} onUpdate={vi.fn()} />);

    fireEvent.click(screen.getByText('settings.mcp.modeRemote'));
    fireEvent.click(screen.getByText('settings.mcp.modeLocal'));
    const dialog = screen.getByRole('dialog', { name: 'settings.mcp.modeSwitchTitle' });
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    fireEvent.click(screen.getByText('common.confirm'));

    expect(screen.getByPlaceholderText('npx')).toBeTruthy();
  });

  it('leaves the connector alone when the switch is declined', () => {
    render(<ConnectorForm editingConnector={remoteConnector()} onAdd={vi.fn()} onUpdate={vi.fn()} />);

    fireEvent.click(screen.getByText('settings.mcp.modeRemote'));
    fireEvent.click(screen.getByText('settings.mcp.modeLocal'));
    // The form has its own cancel button in edit mode; the dialog's is the one
    // rendered last, into the overlay.
    const cancels = screen.getAllByText('common.cancel');
    fireEvent.click(cancels[cancels.length - 1]);

    expect(screen.queryByPlaceholderText('npx')).toBeNull();
    expect(screen.getByPlaceholderText('https://mcp.example.com/mcp')).toBeTruthy();
  });

  it('switches a new connector without asking, since nothing is configured yet', () => {
    render(<ConnectorForm editingConnector={null} onAdd={vi.fn()} onUpdate={vi.fn()} />);

    fireEvent.click(screen.getByText('settings.mcp.modeRemote'));
    fireEvent.click(screen.getByText('settings.mcp.modeLocal'));

    expect(screen.queryByText('settings.mcp.modeSwitchBody')).toBeNull();
    expect(screen.getByPlaceholderText('npx')).toBeTruthy();
  });
});
