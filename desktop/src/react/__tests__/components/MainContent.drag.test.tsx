// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { MainContent } from '../../MainContent';
import { SkillsPanel } from '../../components/SkillsPanel';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../components/BrowserCard', () => ({ BrowserCard: () => null }));

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

function fileDataTransfer(files: File[] = []) {
  return {
    files,
    types: ['Files'],
    getData: vi.fn(() => ''),
  };
}

describe('MainContent app file drag attachments', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    vi.mocked(hanaFetch).mockReset();
    window.platform = {
      getFilePath: vi.fn((file: File) => `/tmp/${file.name}`),
    } as unknown as typeof window.platform;
    useStore.setState({
      currentSessionPath: '/sessions/main.jsonl',
      currentTab: 'chat',
      welcomeVisible: false,
      activePanel: null,
      currentAgentId: 'agent-a',
      agentName: 'Hana',
      agentYuan: 'hanako',
      agents: [{ id: 'agent-a', name: 'Hana', yuan: 'hanako', isPrimary: true }],
      attachedFiles: [],
      attachedFilesBySession: {},
    } as never);
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { platform?: unknown }).platform;
  });

  it('ends the global drag lifecycle when SkillsPanel exclusively consumes the nested drop', async () => {
    vi.mocked(hanaFetch).mockImplementation(async (url: string) => {
      if (url.includes('/api/skills/install')) {
        return jsonResponse({ ok: true, skill: { name: 'nested-skill' } });
      }
      if (url.includes('/api/skills/bundles')) return jsonResponse({ bundles: [] });
      if (url.includes('/api/skills?')) return jsonResponse({ skills: [] });
      return jsonResponse({});
    });
    useStore.setState({ activePanel: 'skills' } as never);

    const { container } = render(
      <MainContent>
        <SkillsPanel />
      </MainContent>,
    );
    const root = container.querySelector('.main-content');
    const overlay = container.querySelector('.drop-overlay');
    expect(root).toBeTruthy();
    expect(overlay).toBeTruthy();
    await screen.findByTestId('skills-panel-drop-surface');

    const file = new File(['skill'], 'nested.skill');
    const dataTransfer = fileDataTransfer([file]);
    fireEvent.dragEnter(root!, { dataTransfer });
    expect(overlay).toHaveClass('visible');

    fireEvent.drop(screen.getByTestId('skills-panel-drop-surface'), { dataTransfer });

    await waitFor(() => expect(vi.mocked(hanaFetch).mock.calls.filter(([url]) =>
      String(url).includes('/api/skills/install')
    )).toHaveLength(1));
    expect(overlay).not.toHaveClass('visible');
    expect(useStore.getState().attachedFiles).toEqual([]);
    expect(vi.mocked(hanaFetch).mock.calls.some(([url]) => url === '/api/upload')).toBe(false);
  });

  it('keeps an ordinary root drop on the chat attachment path exactly once', async () => {
    vi.mocked(hanaFetch).mockImplementation(async (url: string) => {
      if (url === '/api/upload') {
        return jsonResponse({
          uploads: [{ src: '/tmp/report.txt', dest: '/uploads/report.txt', name: 'report.txt' }],
        });
      }
      return jsonResponse({});
    });
    const { container } = render(<MainContent><div>chat</div></MainContent>);
    const root = container.querySelector('.main-content');
    const overlay = container.querySelector('.drop-overlay');
    const file = new File(['report'], 'report.txt');
    const dataTransfer = fileDataTransfer([file]);

    fireEvent.dragEnter(root!, { dataTransfer });
    fireEvent.drop(root!, { dataTransfer });

    await waitFor(() => expect(useStore.getState().attachedFiles).toEqual([{
      path: '/uploads/report.txt',
      name: 'report.txt',
      isDirectory: false,
      waveform: undefined,
    }]));
    expect(vi.mocked(hanaFetch).mock.calls.filter(([url]) => url === '/api/upload')).toHaveLength(1);
    expect(overlay).not.toHaveClass('visible');
  });

  it('clamps unmatched dragleave events and resets on dragend cancellation', () => {
    const { container } = render(<MainContent><div>chat</div></MainContent>);
    const root = container.querySelector('.main-content');
    const overlay = container.querySelector('.drop-overlay');
    const dataTransfer = fileDataTransfer();

    fireEvent.dragLeave(root!, { dataTransfer });
    fireEvent.dragLeave(root!, { dataTransfer });
    fireEvent.dragEnter(root!, { dataTransfer });
    expect(overlay).toHaveClass('visible');

    fireEvent.drop(window, { dataTransfer });
    expect(overlay).not.toHaveClass('visible');

    fireEvent.dragEnter(root!, { dataTransfer });
    expect(overlay).toHaveClass('visible');
    fireEvent.dragEnd(window, { dataTransfer });
    expect(overlay).not.toHaveClass('visible');

    fireEvent.dragEnter(root!, { dataTransfer });
    expect(overlay).toHaveClass('visible');
    fireEvent.blur(window);
    expect(overlay).not.toHaveClass('visible');
  });

  it('attaches dragged session files without re-uploading them', async () => {
    const { attachAppFileDragPayloadToInput } = await import('../../MainContent');

    await attachAppFileDragPayloadToInput({
      dragId: 'hana-drag-test',
      source: 'session-file',
      files: [{
        id: 'sf_report',
        fileId: 'sf_report',
        name: 'report.pdf',
        path: '/tmp/session-files/report.pdf',
        isDirectory: false,
      }],
    });

    expect(useStore.getState().attachedFiles).toEqual([{
      fileId: 'sf_report',
      path: '/tmp/session-files/report.pdf',
      name: 'report.pdf',
      isDirectory: false,
    }]);
    expect(useStore.getState().attachedFilesBySession['/sessions/main.jsonl']).toEqual(useStore.getState().attachedFiles);
  });

  it('attaches workspace files dragged from a native-root mount directly by absolute path', async () => {
    vi.mocked(hanaFetch).mockClear();
    useStore.setState({
      currentTab: 'chat',
      deskBasePath: 'studio:mount_docs',
      deskWorkspaceMountId: 'mount_docs',
      deskWorkspaceNativeRoot: '/Users/me/docs',
      deskFiles: [{ name: 'report.md', isDir: false }],
    } as never);
    const { attachAppFileDragPayloadToInput } = await import('../../MainContent');

    await attachAppFileDragPayloadToInput({
      dragId: 'hana-drag-mount-workspace',
      source: 'workspace',
      files: [{
        id: 'workspace:report.md',
        name: 'report.md',
        path: '/Users/me/docs/report.md',
        sourceSubdir: '',
        isDirectory: false,
      }],
    });

    expect(useStore.getState().attachedFiles).toEqual([{
      path: '/Users/me/docs/report.md',
      name: 'report.md',
      isDirectory: false,
    }]);
    expect(hanaFetch).not.toHaveBeenCalled();
  });

});
