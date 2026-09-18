/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorImport } from '../ConnectorImport';
import type { McpBulkResult, McpConnectorInput } from '../types';

vi.mock('../../../helpers', () => ({
  t: (key: string, params?: Record<string, string>) =>
    (params ? `${key}:${Object.values(params).join(',')}` : key),
}));

const TWO_SERVERS = JSON.stringify({
  mcpServers: {
    alpha: { url: 'https://alpha.example.com/mcp' },
    beta: { command: 'npx', args: ['-y', 'beta-mcp'] },
  },
});

function renderImport(onImport: (c: any[]) => Promise<McpBulkResult[]>) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(<ConnectorImport busy={false} onImport={onImport} onDone={onDone} onCancel={onCancel} />);
  return { onDone, onCancel };
}

function pasteAndParse(json: string) {
  fireEvent.change(screen.getByLabelText('settings.mcp.importJson'), { target: { value: json } });
  fireEvent.click(screen.getByText('settings.mcp.importParse'));
}

afterEach(cleanup);

describe('ConnectorImport', () => {
  it('shows what was found before anything is written', async () => {
    const onImport = vi.fn(async () => []);
    renderImport(onImport);

    pasteAndParse(TWO_SERVERS);

    expect(screen.getByTestId('mcp-import-preview')).toBeTruthy();
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    // Nothing has been sent yet; the preview is the whole point of the step.
    expect(onImport).not.toHaveBeenCalled();
  });

  it('submits only the entries left checked, in one request', async () => {
    const onImport = vi.fn(async (_connectors: McpConnectorInput[]) => [{ ok: true, id: 'beta' }]);
    renderImport(onImport);

    pasteAndParse(TWO_SERVERS);
    fireEvent.click(screen.getByLabelText('alpha'));
    fireEvent.click(screen.getByText('settings.mcp.importConfirm:1'));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport.mock.calls[0][0]).toHaveLength(1);
    expect(onImport.mock.calls[0][0][0]).toMatchObject({ name: 'beta', command: 'npx' });
  });

  it('reports the outcome of each submitted entry', async () => {
    const onImport = vi.fn(async () => [{ ok: true, id: 'alpha' }, { ok: false, error: 'url is required' }]);
    renderImport(onImport);

    pasteAndParse(TWO_SERVERS);
    fireEvent.click(screen.getByText('settings.mcp.importConfirm:2'));

    await waitFor(() => expect(screen.getByTestId('mcp-import-result')).toBeTruthy());
    expect(screen.getByText('settings.mcp.importItemOk')).toBeTruthy();
    expect(screen.getByText('url is required')).toBeTruthy();
  });

  it('keeps the per-item verdicts when the batch is refused as a whole', async () => {
    const failure = Object.assign(new Error('connector 2: url is required'), {
      results: [{ ok: true }, { ok: false, error: 'url is required' }],
    });
    const onImport = vi.fn(async () => { throw failure; });
    const { onDone } = renderImport(onImport);

    pasteAndParse(TWO_SERVERS);
    fireEvent.click(screen.getByText('settings.mcp.importConfirm:2'));

    await waitFor(() => expect(screen.getByTestId('mcp-import-result')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('connector 2');
    // Nothing was written, so the flow must not report success.
    expect(onDone).not.toHaveBeenCalled();
  });

  it('refuses to submit an entry it can already tell is unusable', () => {
    const onImport = vi.fn(async () => []);
    renderImport(onImport);

    pasteAndParse(JSON.stringify({ mcpServers: { bad: { url: 'example.com/mcp', transport: 'sse' } } }));

    expect(screen.getByText('settings.mcp.urlInvalid')).toBeTruthy();
    expect((screen.getByText('settings.mcp.importConfirm:1') as HTMLButtonElement).disabled).toBe(true);
  });

  it('reports a malformed document without leaving the paste step', () => {
    renderImport(vi.fn(async () => []));

    pasteAndParse('{not json');

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('mcp-import-preview')).toBeNull();
  });

  it('can go back from the preview to edit the document', () => {
    renderImport(vi.fn(async () => []));

    pasteAndParse(TWO_SERVERS);
    fireEvent.click(screen.getByText('common.back'));

    expect(screen.getByLabelText('settings.mcp.importJson')).toBeTruthy();
  });
});
