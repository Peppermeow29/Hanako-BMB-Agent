import { describe, it, expect } from 'vitest';
import { buildThemeName, extractScreenshotPayload } from '../desktop/src/react/utils/screenshot-extract';

describe('buildThemeName', () => {
  it('light + mobile → solarized-light', () => {
    expect(buildThemeName('light', 'mobile')).toBe('solarized-light');
  });
  it('light + desktop → solarized-light-desktop', () => {
    expect(buildThemeName('light', 'desktop')).toBe('solarized-light-desktop');
  });
  it('dark + mobile → solarized-dark', () => {
    expect(buildThemeName('dark', 'mobile')).toBe('solarized-dark');
  });
  it('dark + desktop → solarized-dark-desktop', () => {
    expect(buildThemeName('dark', 'desktop')).toBe('solarized-dark-desktop');
  });
  it('sakura + mobile → sakura-light', () => {
    expect(buildThemeName('sakura', 'mobile')).toBe('sakura-light');
  });
  it('sakura + desktop → sakura-light-desktop', () => {
    expect(buildThemeName('sakura', 'desktop')).toBe('sakura-light-desktop');
  });
});

describe('extractScreenshotPayload', () => {
  it('single role (assistant text) → article mode, blocks are html type', () => {
    const messages = [
      { id: '1', role: 'assistant' as const, blocks: [{ type: 'text' as const, html: '<h1>Hello</h1>' }] },
    ];
    const result = extractScreenshotPayload(messages, 'solarized-light');
    expect(result.mode).toBe('article');
    expect(result.messages).toHaveLength(1);
    expect(result.messages![0].blocks[0]).toEqual({ type: 'html', content: '<h1>Hello</h1>' });
  });

  it('single role (user text) → article mode, blocks are markdown type', () => {
    const messages = [
      { id: '1', role: 'user' as const, text: '# Hello' },
    ];
    const result = extractScreenshotPayload(messages, 'solarized-light');
    expect(result.mode).toBe('article');
    expect(result.messages![0].blocks[0]).toEqual({ type: 'markdown', content: '# Hello' });
  });

  it('mixed roles → conversation mode', () => {
    const messages = [
      { id: '1', role: 'user' as const, text: '你好' },
      { id: '2', role: 'assistant' as const, blocks: [{ type: 'text' as const, html: '<p>你好！</p>' }] },
    ];
    const result = extractScreenshotPayload(messages, 'solarized-dark');
    expect(result.mode).toBe('conversation');
    expect(result.messages).toHaveLength(2);
    expect(result.messages![0].blocks[0].type).toBe('markdown');
    expect(result.messages![1].blocks[0].type).toBe('html');
  });

  it('filters out thinking/mood/tool blocks', () => {
    const messages = [
      {
        id: '1', role: 'assistant' as const, blocks: [
          { type: 'thinking' as const, content: '...', sealed: true },
          { type: 'mood' as const, yuan: 'hanako', text: 'happy' },
          { type: 'tool_group' as const, tools: [] as any[], collapsed: true },
          { type: 'text' as const, html: '<p>visible</p>' },
        ],
      },
    ];
    const result = extractScreenshotPayload(messages, 'solarized-light');
    expect(result.messages![0].blocks).toHaveLength(1);
    expect(result.messages![0].blocks[0]).toEqual({ type: 'html', content: '<p>visible</p>' });
  });

  it('keeps image file_output', () => {
    const messages = [
      {
        id: '1', role: 'assistant' as const, blocks: [
          { type: 'text' as const, html: '<p>text</p>' },
          { type: 'file' as const, filePath: '/tmp/img.png', label: 'img', ext: 'png' },
        ],
      },
    ];
    const result = extractScreenshotPayload(messages, 'solarized-light');
    expect(result.messages![0].blocks).toHaveLength(2);
    expect(result.messages![0].blocks[1]).toEqual({ type: 'image', content: '/tmp/img.png' });
  });

  it('keeps assistant screenshot image blocks as data URLs', () => {
    const messages = [
      {
        id: '1', role: 'assistant' as const, blocks: [
          { type: 'screenshot' as const, base64: 'ABC123', mimeType: 'image/png' },
        ],
      },
    ];
    const result = extractScreenshotPayload(messages, 'solarized-light');
    expect(result.messages![0].blocks).toEqual([
      { type: 'image', content: 'data:image/png;base64,ABC123' },
    ]);
  });

  it('keeps user image attachments even when they are auxiliary vision images', () => {
    const messages = [
      {
        id: '1',
        role: 'user' as const,
        text: '看这张图',
        attachments: [
          { path: '/tmp/aux.png', name: 'aux.png', isDir: false, visionAuxiliary: true },
          { path: '/tmp/native.png', name: 'native.png', isDir: false, visionAuxiliary: false },
          { path: '/tmp/readme.md', name: 'readme.md', isDir: false },
        ],
      },
    ];
    const result = extractScreenshotPayload(messages, 'solarized-light');
    expect(result.messages![0].blocks).toEqual([
      { type: 'markdown', content: '看这张图' },
      { type: 'image', content: '/tmp/aux.png' },
      { type: 'image', content: '/tmp/native.png' },
      { type: 'attachment', kind: 'markdown', name: 'readme.md' },
    ]);
  });

  it('keeps user inline base64 image attachments as data URLs', () => {
    const messages = [
      {
        id: '1',
        role: 'user' as const,
        attachments: [
          { path: '/tmp/inline.png', name: 'inline.png', isDir: false, base64Data: 'INLINE', mimeType: 'image/webp' },
        ],
      },
    ];
    const result = extractScreenshotPayload(messages, 'solarized-light');
    expect(result.messages![0].blocks).toEqual([
      { type: 'image', content: 'data:image/webp;base64,INLINE' },
    ]);
  });

  it('keeps non-image user attachments as semantic attachment blocks', () => {
    const messages = [
      {
        id: '1',
        role: 'user' as const,
        text: '请看这些附件',
        attachments: [
          { path: '/tmp/pic.png', name: 'pic.png', isDir: false, mimeType: 'image/png' },
          {
            path: '/tmp/voice.wav',
            name: 'voice.wav',
            isDir: false,
            mimeType: 'audio/wav',
            presentation: 'voice-input',
            listed: false,
          },
          { path: '/tmp/note.md', name: 'note.md', isDir: false, mimeType: 'text/markdown' },
          { path: '/tmp/spec.pdf', name: 'spec.pdf', isDir: false, mimeType: 'application/pdf', status: 'expired' },
          { path: '/tmp/folder', name: 'folder', isDir: true },
        ],
      },
    ];

    const result = extractScreenshotPayload(messages, 'solarized-light');

    expect(result.messages![0].blocks).toEqual([
      { type: 'markdown', content: '请看这些附件' },
      { type: 'image', content: '/tmp/pic.png' },
      { type: 'attachment', kind: 'audio', name: 'voice.wav', presentation: 'voice-input' },
      { type: 'attachment', kind: 'markdown', name: 'note.md' },
      { type: 'attachment', kind: 'pdf', name: 'spec.pdf', status: 'expired' },
      { type: 'attachment', kind: 'directory', name: 'folder' },
    ]);
  });

  it('drops non-image file_output', () => {
    const messages = [
      {
        id: '1', role: 'assistant' as const, blocks: [
          { type: 'text' as const, html: '<p>code</p>' },
          { type: 'file' as const, filePath: '/tmp/file.py', label: 'file', ext: 'py' },
        ],
      },
    ];
    const result = extractScreenshotPayload(messages, 'solarized-light');
    expect(result.messages![0].blocks).toHaveLength(1);
    expect(result.messages![0].blocks[0].type).toBe('html');
  });

  it('empty messages → article with empty messages array', () => {
    const result = extractScreenshotPayload([], 'solarized-light');
    expect(result.mode).toBe('article');
    expect(result.messages).toHaveLength(0);
  });

  it('user message without text → empty blocks', () => {
    const messages = [{ id: '1', role: 'user' as const }];
    const result = extractScreenshotPayload(messages as any, 'solarized-light');
    expect(result.messages![0].blocks).toHaveLength(0);
  });

  it('conversation: consecutive same-role messages mark showHeader only on the first', () => {
    const messages = [
      { id: '1', role: 'user' as const, text: 'hi' },
      { id: '2', role: 'assistant' as const, blocks: [{ type: 'text' as const, html: '<p>a</p>' }] },
      { id: '3', role: 'assistant' as const, blocks: [{ type: 'text' as const, html: '<p>b</p>' }] },
      { id: '4', role: 'assistant' as const, blocks: [{ type: 'text' as const, html: '<p>c</p>' }] },
      { id: '5', role: 'user' as const, text: 'bye' },
    ];
    const result = extractScreenshotPayload(messages, 'solarized-dark');
    expect(result.messages!.map(m => m.showHeader)).toEqual([true, true, false, false, true]);
  });

  it('first message always shows header even when same role follows', () => {
    const messages = [
      { id: '1', role: 'assistant' as const, blocks: [{ type: 'text' as const, html: '<p>a</p>' }] },
      { id: '2', role: 'assistant' as const, blocks: [{ type: 'text' as const, html: '<p>b</p>' }] },
    ];
    const result = extractScreenshotPayload(messages, 'solarized-light');
    expect(result.messages!.map(m => m.showHeader)).toEqual([true, false]);
  });
});
