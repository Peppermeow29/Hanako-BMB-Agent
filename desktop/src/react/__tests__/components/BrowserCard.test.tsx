/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hanaFetchMock = vi.fn(async (..._args: unknown[]) => ({ json: async () => ({}) }));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (...args: unknown[]) => hanaFetchMock(...args),
  hanaUrl: (p: string) => p,
}));

import { BrowserCard } from '../../components/BrowserCard';
import { useStore } from '../../stores';
import { setBrowserStateForPath } from '../../stores/browser-slice';
import { handleServerMessage } from '../../services/ws-message-handler';

const SESSION_PATH = '/tmp/agents/hana/sessions/browser-card.jsonl';

const browserEmergencyStopMock = vi.fn();
const openBrowserViewerMock = vi.fn();

function browserStatus(running: boolean) {
  handleServerMessage({
    type: 'browser_status',
    sessionPath: SESSION_PATH,
    running,
    url: running ? 'https://example.com' : null,
  });
}

function card() {
  return document.getElementById('browserFloatingCard');
}

describe('BrowserCard collapse semantics', () => {
  beforeEach(() => {
    globalThis.t = ((key: string) => key) as typeof globalThis.t;
    hanaFetchMock.mockClear();
    browserEmergencyStopMock.mockClear();
    openBrowserViewerMock.mockClear();
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: {
        browserEmergencyStop: browserEmergencyStopMock,
        openBrowserViewer: openBrowserViewerMock,
      },
    });
    useStore.setState({
      currentSessionPath: SESSION_PATH,
      currentSessionId: null,
      sessions: [],
      sessionLocatorsById: {},
      browserBySession: {},
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('collapses the card locally without stopping or closing the session browser', () => {
    act(() => {
      setBrowserStateForPath(SESSION_PATH, { running: true, url: 'https://example.com', thumbnail: null });
    });

    render(<BrowserCard />);
    expect(card()).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('browser.collapse'));

    expect(hanaFetchMock).not.toHaveBeenCalled();
    expect(browserEmergencyStopMock).not.toHaveBeenCalled();
    expect(openBrowserViewerMock).not.toHaveBeenCalled();
    expect(card()).not.toBeInTheDocument();
    expect(useStore.getState().browserBySession[SESSION_PATH].running).toBe(true);
  });

  it('keeps the card collapsed while the browser keeps reporting status', () => {
    act(() => {
      setBrowserStateForPath(SESSION_PATH, { running: true, url: 'https://example.com', thumbnail: null });
    });
    render(<BrowserCard />);
    fireEvent.click(screen.getByTitle('browser.collapse'));
    expect(card()).not.toBeInTheDocument();

    act(() => { browserStatus(true); });

    expect(card()).not.toBeInTheDocument();
  });

  it('brings the card back when the browser restarts for that session', () => {
    act(() => {
      setBrowserStateForPath(SESSION_PATH, { running: true, url: 'https://example.com', thumbnail: null });
    });
    render(<BrowserCard />);
    fireEvent.click(screen.getByTitle('browser.collapse'));
    expect(card()).not.toBeInTheDocument();

    act(() => { browserStatus(false); });
    expect(card()).not.toBeInTheDocument();

    act(() => { browserStatus(true); });

    expect(card()).toBeInTheDocument();
  });
});
