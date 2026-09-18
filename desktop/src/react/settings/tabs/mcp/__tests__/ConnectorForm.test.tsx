/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConnectorForm } from '../ConnectorForm';
import type { McpConnector } from '../types';

vi.mock('../../../helpers', () => ({
  t: (key: string) => key,
}));

describe('ConnectorForm', () => {
  it('server-renders the edited connector\'s own values without waiting for effects', () => {
    const connector: McpConnector = {
      id: 'connector-1',
      name: 'Remote MCP',
      transport: 'remote',
      url: 'https://mcp.example.com/mcp',
      timeout: 45,
      status: 'stopped',
      tools: [],
    };

    const html = renderToString(
      <ConnectorForm
        editingConnector={connector}
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    // The initial form state is seeded from the connector on the very first
    // render, not filled in later by an effect, so the fields are already
    // populated in server-rendered markup.
    expect(html).toContain('https://mcp.example.com/mcp');
    expect(html).toContain('value="45"');
  });
});

describe('ConnectorForm edit fidelity', () => {
  function stdioConnector(): McpConnector {
    return {
      id: 'local-1',
      name: 'Local MCP',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'local-mcp'],
      status: 'stopped',
      tools: [],
    };
  }

  it('keeps a local connector on its own transport when the form opens', () => {
    // The form used to rewrite a stdio connector's transport to "remote" while
    // reading it in, so the form disagreed with the connector from the moment
    // it opened.
    const html = renderToString(
      <ConnectorForm editingConnector={stdioConnector()} onAdd={vi.fn()} onUpdate={vi.fn()} />,
    );

    expect(html).toContain('npx');
    expect(html).not.toContain('settings.mcp.remoteUrl');
  });

  it('preserves a remote connector\'s chosen transport', () => {
    const connector: McpConnector = {
      id: 'sse-1',
      name: 'SSE MCP',
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      status: 'stopped',
      tools: [],
    };

    const html = renderToString(
      <ConnectorForm editingConnector={connector} onAdd={vi.fn()} onUpdate={vi.fn()} />,
    );

    expect(html).toContain('settings.mcp.transportSse');
  });
});
