// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileBadgeView } from '../../components/input/FileBadgeView';

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ as = 'div', className, children }: {
    as?: React.ElementType<{ className?: string; children?: React.ReactNode }>;
    className?: string;
    children?: React.ReactNode;
  }) => React.createElement(as, { className }, children),
}));

function renderBadge(attrs: Record<string, unknown>) {
  return render(React.createElement(FileBadgeView, {
    node: { attrs },
  } as never));
}

describe('FileBadgeView', () => {
  afterEach(() => {
    cleanup();
    delete (window as unknown as { platform?: unknown }).platform;
  });

  it('renders image references with a tiny thumbnail from platform.getFileUrl', () => {
    window.platform = {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
    } as unknown as typeof window.platform;

    const { container } = renderBadge({
      path: '/tmp/photo.png',
      name: 'photo.png',
      mimeType: 'image/png',
    });

    expect(screen.getByText('@')).toBeInTheDocument();
    expect(screen.getByText('photo.png')).toBeInTheDocument();
    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    expect(image).toHaveAttribute('src', 'file:///tmp/photo.png');
    const children = Array.from(container.firstElementChild?.children || []);
    expect(children[0]).toHaveTextContent('@');
    expect(children[1]).toBe(image);
    expect(window.platform.getFileUrl).toHaveBeenCalledWith('/tmp/photo.png');
  });

  it('renders non-image references as lightweight at-name text', () => {
    window.platform = {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
    } as unknown as typeof window.platform;

    const { container } = renderBadge({
      path: '/tmp/notes.txt',
      name: 'notes.txt',
      mimeType: 'text/plain',
    });

    expect(screen.getByText('@')).toBeInTheDocument();
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(window.platform.getFileUrl).not.toHaveBeenCalled();
  });

  it('renders audio references with a static waveform marker', () => {
    window.platform = {
      getFileUrl: vi.fn((path: string) => `file://${path}`),
    } as unknown as typeof window.platform;

    const { container } = renderBadge({
      path: '/tmp/recording.wav',
      name: 'recording.wav',
      mimeType: 'audio/wav',
    });

    expect(screen.getByText('@')).toBeInTheDocument();
    expect(screen.getByText('recording.wav')).toBeInTheDocument();
    expect(screen.getByTestId('file-badge-audio-wave')).toBeInTheDocument();
    const children = Array.from(container.firstElementChild?.children || []);
    expect(children[0]).toHaveTextContent('@');
    expect(children[1]).toBe(screen.getByTestId('file-badge-audio-wave'));
    expect(container.querySelector('img')).toBeNull();
    expect(window.platform.getFileUrl).not.toHaveBeenCalled();
  });
});
