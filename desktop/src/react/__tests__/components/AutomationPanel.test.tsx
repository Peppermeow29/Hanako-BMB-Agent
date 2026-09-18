// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationPanel } from '../../components/AutomationPanel';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

const addToast = vi.fn();

describe('AutomationPanel', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    addToast.mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(hanaFetch).mockImplementation(async (url) => {
      if (url === '/api/models') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    });
    useStore.setState({
      activePanel: 'automation',
      agents: [{ id: 'hanako', name: 'Hanako', yuan: 'hanako', homeFolder: '/home/hanako', isPrimary: true }],
      currentAgentId: 'hanako',
      currentSessionId: 'session-main',
      currentSessionPath: '/sessions/main.jsonl',
      sessions: [{ sessionId: 'session-main', path: '/sessions/main.jsonl', cwd: '/workspace' }],
      deskBasePath: '/workspace',
      deskWorkspaceMountId: null,
      homeFolder: '/home/hanako',
      workspaceFolders: ['/workspace'],
      sessionAuthorizedFoldersByPath: { '/sessions/main.jsonl': [] },
      addToast,
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the structured POST error and keeps the panel usable', async () => {
    render(<AutomationPanel />);
    await waitFor(() => expect(hanaFetch).toHaveBeenCalledWith('/api/desk/cron', {
      throwOnHttpError: false,
    }));
    vi.mocked(hanaFetch).mockImplementation(async (url, options) => {
      if (url === '/api/desk/cron' && options?.method === 'POST') {
        return new Response(JSON.stringify({
          error: {
            code: 'cron_store_corrupt',
            message: 'automation task storage is corrupt',
          },
        }), { status: 500 });
      }
      if (url === '/api/models') {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    });

    const addButton = screen.getByRole('button', { name: 'automation.add' });
    fireEvent.click(addButton);

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        'automation.createFailed: automation task storage is corrupt',
        'error',
      );
    });
    const postCall = vi.mocked(hanaFetch).mock.calls.find(([, options]) => options?.method === 'POST');
    expect(postCall?.[1]).toEqual(expect.objectContaining({ throwOnHttpError: false }));
    expect(addButton).toBeEnabled();
  });

  it('shows a structured GET error without presenting an empty task list or clearing the badge', async () => {
    useStore.setState({ automationCount: 7 } as never);
    vi.mocked(hanaFetch).mockImplementation(async (url) => {
      if (url === '/api/desk/cron') {
        return new Response(JSON.stringify({
          error: {
            code: 'cron_store_corrupt',
            message: 'automation task storage is corrupt',
          },
        }), { status: 500 });
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    });

    render(<AutomationPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('automation task storage is corrupt');
    expect(screen.queryByText('automation.emptyForAgent')).not.toBeInTheDocument();
    expect(screen.queryByText('automation.empty')).not.toBeInTheDocument();
    expect(useStore.getState().automationCount).toBe(7);
    expect(hanaFetch).toHaveBeenCalledWith('/api/desk/cron', { throwOnHttpError: false });
  });
});
