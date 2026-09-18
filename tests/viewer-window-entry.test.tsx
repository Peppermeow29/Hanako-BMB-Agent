/**
 * @vitest-environment jsdom
 *
 * viewer-window-entry.test.tsx
 *
 * 回归保护：viewer 窗口渲染入口必须只依赖显式拉取（`viewerRequestLoad`），
 * 不能依赖任何"主进程推送 + useEffect 注册监听"的时序假设。
 *
 * 根因回顾：旧实现里 `onViewerLoad` 注册发生在 React useEffect（晚于
 * commit+paint），而主进程在 did-finish-load 时一次性推送 `viewer-load`。
 * 若推送先于监听注册完成，payload 永久丢失，窗口卡死在 "Loading…"。
 * 这里验证：即便 window.platform 上完全没有任何推送式 API（只有
 * viewerRequestLoad），ViewerApp 也必须能正常拉取并渲染完成。
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewerApp } from '../desktop/src/viewer-window-entry';

vi.mock('../desktop/src/react/components/PreviewEditor', () => ({
  PreviewEditor: (props: { content: string; filePath: string }) => (
    <div data-testid="mock-preview-editor">{props.filePath}:{props.content}</div>
  ),
}));

vi.mock('../desktop/src/viewer-resource-events', () => ({
  retainViewerLocalFileResourceWatch: () => ({
    ready: Promise.resolve(),
    release: () => {},
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as any).platform;
});

const PAYLOAD = {
  filePath: '/Users/alice/notes/chapter.md',
  title: 'chapter',
  type: 'markdown',
  language: null,
  windowId: 42,
};

describe('ViewerApp (pull-only contract, no push API present)', () => {
  it('renders content after pulling via viewerRequestLoad, with no onViewerLoad on window.platform at all', async () => {
    (window as any).platform = {
      // 刻意不提供任何 onViewerLoad / 推送式 API —— 只有拉取
      viewerRequestLoad: vi.fn().mockResolvedValue(PAYLOAD),
      readFile: vi.fn().mockResolvedValue('# Hello'),
    };

    render(<ViewerApp />);

    // 初始应显示 Loading（拉取尚未 resolve）
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('mock-preview-editor')).toBeInTheDocument();
    });

    expect(screen.getByTestId('mock-preview-editor')).toHaveTextContent('/Users/alice/notes/chapter.md:# Hello');
    expect(document.title).toBe('chapter');
  });

  it('shows an explicit error instead of infinite Loading when the pull resolves to null (unknown window)', async () => {
    (window as any).platform = {
      viewerRequestLoad: vi.fn().mockResolvedValue(null),
      readFile: vi.fn(),
    };

    render(<ViewerApp />);

    await waitFor(() => {
      expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    });

    expect(screen.getByText(/Failed to load viewer content/i)).toBeInTheDocument();
  });

  it('shows an explicit error when viewerRequestLoad itself rejects', async () => {
    (window as any).platform = {
      viewerRequestLoad: vi.fn().mockRejectedValue(new Error('ipc invoke failed')),
      readFile: vi.fn(),
    };

    render(<ViewerApp />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load viewer content/i)).toBeInTheDocument();
    });
  });

  it('shows an explicit error when window.platform has no viewerRequestLoad at all (e.g. stale preload)', async () => {
    (window as any).platform = {
      readFile: vi.fn(),
    };

    render(<ViewerApp />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load viewer content/i)).toBeInTheDocument();
    });
  });
});
