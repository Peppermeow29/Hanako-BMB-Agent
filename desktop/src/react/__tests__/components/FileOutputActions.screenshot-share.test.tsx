// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileOutputActions } from '../../components/chat/FileOutputActions';
import { takeMarkdownFileScreenshot } from '../../utils/screenshot';

vi.mock('../../utils/screenshot', () => ({
  takeMarkdownFileScreenshot: vi.fn(async () => undefined),
}));

describe('FileOutputActions screenshot share', () => {
  beforeEach(() => {
    window.t = ((key: string) => ({
      'desk.openWithDefault': '用默认应用打开',
      'chat.fileActions.more': '更多文件操作',
      'chat.fileActions.revealInFinder': '打开文件夹',
      'chat.fileActions.copyPath': '复制文件路径',
      'chat.fileActions.downloadToDevice': '下载到本机',
      'common.screenshotShare': '截图分享',
    }[key] || key)) as typeof window.t;
    window.platform = {
      openFile: vi.fn(),
      showInFinder: vi.fn(),
    } as unknown as typeof window.platform;
    vi.mocked(takeMarkdownFileScreenshot).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('adds screenshot share to Markdown file menus and invokes the article screenshot pipeline', () => {
    render(<FileOutputActions filePath="/tmp/session-files/a1b2c3" displayName="report.md" />);

    fireEvent.click(screen.getByRole('button', { name: '更多文件操作 report.md' }));
    fireEvent.click(screen.getByText('截图分享'));

    expect(takeMarkdownFileScreenshot).toHaveBeenCalledWith('/tmp/session-files/a1b2c3', {
      fileName: 'report.md',
    });
  });

  it('does not add screenshot share for non-Markdown files', () => {
    render(<FileOutputActions filePath="/tmp/archive.zip" displayName="archive.zip" />);

    fireEvent.click(screen.getByRole('button', { name: '更多文件操作 archive.zip' }));

    expect(screen.queryByText('截图分享')).not.toBeInTheDocument();
  });
});
