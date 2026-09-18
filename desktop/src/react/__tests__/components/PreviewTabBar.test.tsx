/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TabBar } from '../../components/preview/TabBar';
import { useStore, type StoreState } from '../../stores';

describe('Preview TabBar', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    useStore.setState({
      previewItems: [{
        id: 'note',
        type: 'markdown',
        title: 'note.md',
        content: '# Note',
        filePath: '/tmp/note.md',
      }],
      openTabs: ['note'],
      activeTabId: 'note',
    } as Partial<StoreState>);
  });

  afterEach(() => {
    cleanup();
    useStore.setState({
      previewItems: [],
      openTabs: [],
      activeTabId: null,
    } as Partial<StoreState>);
  });

  it('does not expose the removed open-in-new-window action from tab right click', () => {
    render(<TabBar />);

    fireEvent.contextMenu(screen.getByText('note.md'), { clientX: 24, clientY: 24 });

    expect(screen.queryByText('preview.openInNewWindow')).not.toBeInTheDocument();
    expect(screen.queryByText('preview.openInNewWindowUnsupported')).not.toBeInTheDocument();
  });

  it('scrolls the tab strip horizontally from wheel input', () => {
    useStore.setState({
      previewItems: [
        { id: 'one', type: 'markdown', title: 'one.md', content: '' },
        { id: 'two', type: 'markdown', title: 'two.md', content: '' },
        { id: 'three', type: 'markdown', title: 'three.md', content: '' },
      ],
      openTabs: ['one', 'two', 'three'],
      activeTabId: 'one',
    } as Partial<StoreState>);
    render(<TabBar />);

    const tabList = screen.getByTestId('preview-tab-list');
    Object.defineProperty(tabList, 'clientWidth', { configurable: true, value: 160 });
    Object.defineProperty(tabList, 'scrollWidth', { configurable: true, value: 520 });

    fireEvent.wheel(tabList, { deltaY: 90 });

    expect(tabList.scrollLeft).toBe(90);
  });

  it('closes a tab when it is double-clicked', () => {
    useStore.setState({
      previewOpen: true,
    } as Partial<StoreState>);
    render(<TabBar />);

    fireEvent.doubleClick(screen.getByText('note.md'));

    expect(useStore.getState().openTabs).toEqual([]);
    expect(useStore.getState().activeTabId).toBeNull();
    expect(useStore.getState().previewOpen).toBe(false);
  });
});
