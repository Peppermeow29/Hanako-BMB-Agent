/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputContextMenu } from '../../components/InputContextMenu';

function Harness({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <InputContextMenu />
    </>
  );
}

describe('InputContextMenu', () => {
  const runEditCommand = vi.fn(async () => true);

  beforeEach(() => {
    runEditCommand.mockClear();
    window.t = ((key: string) => key) as typeof window.t;
    window.platform = {
      runEditCommand,
    } as unknown as typeof window.platform;
  });

  afterEach(() => {
    cleanup();
  });

  it('input 选区使用 selectionStart/selectionEnd，而不是 window.getSelection()', () => {
    render(
      <Harness>
        <div className="input-area">
          <input data-testid="input" defaultValue="hello world" />
        </div>
      </Harness>,
    );

    const input = screen.getByTestId('input') as HTMLInputElement;
    input.focus();
    input.setSelectionRange(0, 5);

    fireEvent.contextMenu(input, { clientX: 20, clientY: 20 });

    const copyItem = screen.getByText('ctx.copy');
    expect(copyItem.className).not.toContain('disabled');

    fireEvent.click(copyItem);
    expect(runEditCommand).toHaveBeenCalledWith('copy');
  });

  it('无选区时 cut/copy 禁用，不会误触发命令', () => {
    render(
      <Harness>
        <div className="input-area">
          <textarea data-testid="textarea" defaultValue="hello world" />
        </div>
      </Harness>,
    );

    const textarea = screen.getByTestId('textarea') as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(0, 0);

    fireEvent.contextMenu(textarea, { clientX: 16, clientY: 16 });

    const cutItem = screen.getByText('ctx.cut');
    const copyItem = screen.getByText('ctx.copy');
    expect(cutItem.className).toContain('disabled');
    expect(copyItem.className).toContain('disabled');

    fireEvent.click(copyItem);
    expect(runEditCommand).not.toHaveBeenCalled();
  });

  it('CodeMirror 编辑器由 EditorContextMenu 接管，不打开 InputContextMenu', () => {
    render(
      <Harness>
        <div id="previewPanel">
          <div className="cm-editor">
            <div className="cm-content" contentEditable suppressContentEditableWarning>
              <span data-testid="cm-child">hello</span>
            </div>
          </div>
        </div>
      </Harness>,
    );

    fireEvent.contextMenu(screen.getByTestId('cm-child'), { clientX: 10, clientY: 10 });
    expect(screen.queryByText('ctx.copy')).toBeNull();
  });

  it('粘贴和全选也复用同一条编辑命令通道', () => {
    render(
      <Harness>
        <div className="input-area">
          <input data-testid="input" defaultValue="hello world" />
        </div>
      </Harness>,
    );

    const input = screen.getByTestId('input') as HTMLInputElement;
    input.focus();

    fireEvent.contextMenu(input, { clientX: 8, clientY: 8 });
    fireEvent.click(screen.getByText('ctx.paste'));
    fireEvent.contextMenu(input, { clientX: 12, clientY: 12 });
    fireEvent.click(screen.getByText('ctx.selectAll'));

    expect(runEditCommand).toHaveBeenNthCalledWith(1, 'paste');
    expect(runEditCommand).toHaveBeenNthCalledWith(2, 'selectAll');
  });

  it('聊天区只读文本右键打开复制菜单', () => {
    render(
      <Harness>
        <div className="chat-area">
          <p data-testid="message">hello world</p>
        </div>
      </Harness>,
    );

    const message = screen.getByTestId('message');
    const sel = window.getSelection();
    sel?.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(message);
    sel?.addRange(range);

    fireEvent.contextMenu(message, { clientX: 12, clientY: 12 });
    expect(screen.getByText('ctx.copy')).toBeTruthy();
  });

  it('侧边栏等非聊天/预览区域的非输入目标不激活只读复制菜单', () => {
    render(
      <Harness>
        <div id="sidebar">
          <button data-testid="folder-row">Work Folder</button>
        </div>
      </Harness>,
    );

    fireEvent.contextMenu(screen.getByTestId('folder-row'), { clientX: 20, clientY: 20 });
    expect(screen.queryByText('ctx.copy')).toBeNull();
  });

  it('侧边栏重命名等任意区域的文本输入框仍有编辑菜单', () => {
    render(
      <Harness>
        <div id="sidebar">
          <input data-testid="rename-input" defaultValue="Work Folder" />
        </div>
      </Harness>,
    );

    const input = screen.getByTestId('rename-input') as HTMLInputElement;
    input.focus();
    input.setSelectionRange(0, 4);

    fireEvent.contextMenu(input, { clientX: 18, clientY: 18 });
    expect(screen.getByText('ctx.cut')).toBeTruthy();
    expect(screen.getByText('ctx.copy')).toBeTruthy();
    expect(screen.getByText('ctx.paste')).toBeTruthy();
  });

  it('已有更具体菜单 preventDefault 后不再叠一层全局菜单', () => {
    render(
      <Harness>
        <div className="chat-area">
          <button
            data-testid="custom-menu-host"
            onContextMenu={(event) => {
              event.preventDefault();
            }}
          >
            host
          </button>
        </div>
      </Harness>,
    );

    fireEvent.contextMenu(screen.getByTestId('custom-menu-host'), { clientX: 8, clientY: 8 });
    expect(screen.queryByText('ctx.copy')).toBeNull();
  });

  it('预览面板内只读文本可以打开复制菜单', () => {
    render(
      <Harness>
        <div id="previewPanel">
          <p data-testid="preview-text">preview body</p>
        </div>
      </Harness>,
    );

    fireEvent.contextMenu(screen.getByTestId('preview-text'), { clientX: 14, clientY: 14 });
    expect(screen.getByText('ctx.copy')).toBeTruthy();
  });
});
