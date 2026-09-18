// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../components/chat/AssistantMessage';
import { UserMessage } from '../../components/chat/UserMessage';
import { useStore } from '../../stores';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../utils/screenshot', () => ({
  takeScreenshot: vi.fn(),
}));

describe('expired session file presentation', () => {
  beforeEach(() => {
    const tMap: Record<string, string> = {
      'chat.fileExpired': '文件已过期',
      'desk.openWithDefault': '用默认应用打开',
      'chat.fileActions.more': '更多文件操作',
      'chat.fileActions.revealInFinder': '打开文件夹',
      'chat.fileActions.copyPath': '复制文件路径',
      'chat.fileActions.downloadToDevice': '下载到本机',
    };
    window.t = ((key: string) => tMap[key] || key) as typeof window.t;
    window.platform = {
      getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
      openFile: vi.fn(),
      showInFinder: vi.fn(),
    } as unknown as typeof window.platform;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    useStore.setState({
      activeServerConnection: null,
      sessionRegistryFilesByPath: {},
      chatSessions: {},
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders an expired assistant file block as a disabled file card', () => {
    render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'a1',
          role: 'assistant',
          blocks: [
            {
              type: 'file',
              fileId: 'sf_old',
              filePath: '/cache/old.pdf',
              label: 'old.pdf',
              ext: 'pdf',
              status: 'expired',
              missingAt: 1234,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText('old.pdf')).toBeInTheDocument();
    expect(screen.getByText('文件已过期')).toBeInTheDocument();
    expect(screen.queryByTitle('desk.openWithDefault')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('old.pdf'));
    expect(window.platform?.openFile).not.toHaveBeenCalled();
  });

  it('does not load image previews for expired user attachments', () => {
    render(
      <UserMessage
        viewerIdentity={{ name: '我', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'u1',
          role: 'user',
          textHtml: '',
          attachments: [
            {
              fileId: 'sf_img',
              path: '/cache/old.png',
              name: 'old.png',
              isDir: false,
              mimeType: 'image/png',
              status: 'expired',
              missingAt: 1234,
            },
          ],
        }}
      />,
    );

    expect(screen.queryByRole('img', { name: 'old.png' })).not.toBeInTheDocument();
    expect(screen.getByText('old.png · 文件已过期')).toBeInTheDocument();
    expect(window.platform?.getFileUrl).not.toHaveBeenCalled();
  });

  it('renders attachment-only user messages without an empty text bubble', () => {
    const { container } = render(
      <UserMessage
        viewerIdentity={{ name: '我', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'u-attachment-only',
          role: 'user',
          text: '',
          attachments: [
            {
              fileId: 'sf_img',
              path: '/cache/photo.png',
              name: 'photo.png',
              isDir: false,
              mimeType: 'image/png',
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole('img', { name: 'photo.png' })).toBeInTheDocument();
    const userTextBubble = Array.from(container.querySelectorAll('div')).find((node) => {
      const className = String(node.getAttribute('class') || '');
      return className.includes('messageUser') && !className.includes('messageGroupUser');
    });
    expect(userTextBubble).toBeUndefined();
  });

  it('renders playable audio user attachments with a waveform chip', () => {
    const audioInstances: Array<{ play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }> = [];
    const AudioMock = vi.fn().mockImplementation(function MockAudio(this: {
      play: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
      onerror: (() => void) | null;
    }) {
      this.play = vi.fn(() => Promise.resolve());
      this.pause = vi.fn();
      this.onended = null;
      this.onerror = null;
      audioInstances.push(this);
    });
    vi.stubGlobal('Audio', AudioMock);

    render(
      <UserMessage
        viewerIdentity={{ name: '我', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'u-audio',
          role: 'user',
          text: '',
          attachments: [
            {
              fileId: 'sf_audio',
              path: '/cache/voice.wav',
              name: 'voice.wav',
              isDir: false,
              mimeType: 'audio/wav',
            },
          ],
        }}
      />,
    );

    expect(screen.getByText('voice.wav')).toBeInTheDocument();
    expect(screen.getByTestId('audio-attachment-wave')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Play voice.wav'));
    expect(AudioMock).toHaveBeenCalledWith('file:///cache/voice.wav');
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1);
  });

  it('renders generic audio attachments with persisted waveform peaks and supports seeking on the wave', () => {
    const audioInstances: Array<{
      currentTime: number;
      duration: number;
      play: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    }> = [];
    const AudioMock = vi.fn().mockImplementation(function MockAudio(this: {
      currentTime: number;
      duration: number;
      play: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    }) {
      this.currentTime = 0;
      this.duration = 4;
      this.play = vi.fn(() => Promise.resolve());
      this.pause = vi.fn();
      this.addEventListener = vi.fn();
      this.removeEventListener = vi.fn();
      audioInstances.push(this);
    });
    vi.stubGlobal('Audio', AudioMock);

    render(
      <UserMessage
        viewerIdentity={{ name: '我', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'u-audio-waveform',
          role: 'user',
          text: '',
          attachments: [
            {
              fileId: 'sf_audio',
              path: '/cache/song.wav',
              name: 'song.wav',
              isDir: false,
              mimeType: 'audio/wav',
              waveform: {
                version: 1,
                peaks: [0.1, 0.5, 0.9],
                durationMs: 4000,
                source: 'computed',
              },
            } as any,
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByLabelText('Play song.wav'));
    const wave = screen.getByTestId('audio-attachment-wave');
    expect(wave.querySelectorAll('[data-audio-wave-bar]')).toHaveLength(24);

    wave.getBoundingClientRect = vi.fn(() => ({
      x: 10,
      y: 0,
      left: 10,
      top: 0,
      right: 110,
      bottom: 20,
      width: 100,
      height: 20,
      toJSON: () => ({}),
    }));
    fireEvent.click(wave, { clientX: 60 });

    expect(audioInstances[0].currentTime).toBeCloseTo(2);
  });

  it('renders voice-input audio messages inside the voice card even before transcription is ready', () => {
    const { container } = render(
      <UserMessage
        viewerIdentity={{ name: '我', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'u-voice-input-pending',
          role: 'user',
          text: '',
          attachments: [
            {
              fileId: 'sf_audio',
              path: '/cache/voice.wav',
              name: '录音 1.wav',
              isDir: false,
              mimeType: 'audio/wav',
              presentation: 'voice-input',
              listed: false,
            },
          ],
        }}
      />,
    );

    expect(screen.queryByText('录音 1.wav')).not.toBeInTheDocument();
    const wave = screen.getByTestId('audio-attachment-wave');
    const voiceCard = wave.closest('[class*="voiceInputCard"]');
    expect(voiceCard).toBeTruthy();
    expect(voiceCard).toContainElement(wave);
    const userTextBubble = Array.from(container.querySelectorAll('div')).find((node) => {
      const className = String(node.getAttribute('class') || '');
      return className.includes('messageUser') && !className.includes('messageGroupUser');
    });
    expect(userTextBubble).toBeUndefined();
  });

  it('renders voice-input audio messages as waveform-only chips without visible filenames', () => {
    render(
      <UserMessage
        viewerIdentity={{ name: '我', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'u-voice-input',
          role: 'user',
          text: '',
          attachments: [
            {
              fileId: 'sf_audio',
              path: '/cache/voice.wav',
              name: '录音 1.wav',
              isDir: false,
              mimeType: 'audio/wav',
              presentation: 'voice-input',
              listed: false,
            },
          ],
        }}
      />,
    );

    expect(screen.queryByText('录音 1.wav')).not.toBeInTheDocument();
    expect(screen.getByTestId('audio-attachment-wave')).toBeInTheDocument();
    expect(screen.getByLabelText('Play 录音 1.wav')).toBeInTheDocument();
  });

  it('renders voice-input transcript above the playable audio strip without an empty text bubble', () => {
    const { container } = render(
      <UserMessage
        viewerIdentity={{ name: '我', avatarUrl: null }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'u-voice-transcript',
          role: 'user',
          text: '',
          attachments: [
            {
              fileId: 'sf_audio',
              path: '/cache/voice.wav',
              name: '录音 1.wav',
              isDir: false,
              mimeType: 'audio/wav',
              presentation: 'voice-input',
              listed: false,
              transcription: {
                status: 'ready',
                text: '今晚我们先把语音输入跑通。',
              },
            } as any,
          ],
        }}
      />,
    );

    const transcript = screen.getByText('今晚我们先把语音输入跑通。');
    const wave = screen.getByTestId('audio-attachment-wave');
    const voiceCard = transcript.closest('[class*="voiceInputCard"]');
    expect(transcript).toBeInTheDocument();
    expect(wave).toBeInTheDocument();
    expect(voiceCard).toBeTruthy();
    expect(voiceCard).toContainElement(wave);
    const userTextBubble = Array.from(container.querySelectorAll('div')).find((node) => {
      const className = String(node.getAttribute('class') || '');
      return className.includes('messageUser') && !className.includes('messageGroupUser');
    });
    expect(userTextBubble).toBeUndefined();
  });

  it('renders assistant file actions as a split button with reveal and copy menu actions', async () => {
    render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'a2',
          role: 'assistant',
          blocks: [
            {
              type: 'file',
              fileId: 'sf_demo',
              filePath: '/cache/demo.pdf',
              label: 'demo.pdf',
              ext: 'pdf',
              status: 'available',
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '用默认应用打开 demo.pdf' }));
    expect(window.platform?.openFile).toHaveBeenCalledWith('/cache/demo.pdf');

    fireEvent.click(screen.getByRole('button', { name: '更多文件操作 demo.pdf' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '打开文件夹' }));
    expect(window.platform?.showInFinder).toHaveBeenCalledWith('/cache/demo.pdf');

    fireEvent.click(screen.getByRole('button', { name: '更多文件操作 demo.pdf' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '复制文件路径' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/cache/demo.pdf');
  });

  it('renders assistant image previews through resource content URL when desktop file URL is unavailable', () => {
    delete (window as any).platform;
    useStore.setState({
      activeServerConnection: {
        kind: 'custom_remote',
        serverId: 'server_remote',
        userId: 'user_remote',
        studioId: 'studio_remote',
        label: 'Remote Hana',
        baseUrl: 'https://hana.example',
        wsUrl: 'wss://hana.example',
        token: 'remote token',
        authState: 'paired',
        trustState: 'tunnel',
        credentialKind: 'device_credential',
        platformAccountId: null,
        officialServiceKind: null,
        capabilities: ['resources'],
      },
      sessionRegistryFilesByPath: {
        '/sessions/main.jsonl': [{
          fileId: 'sf_img',
          filePath: '/remote/cache/img.png',
          label: 'img.png',
          ext: 'png',
          resource: {
            schemaVersion: 1,
            resourceId: 'res_sf_img',
            name: 'studios/studio_remote/resources/res_sf_img',
            studioId: 'studio_remote',
            type: 'file',
            source: 'session_file',
            fileId: 'sf_img',
            lifecycle: { status: 'available', missingAt: null },
            storage: { provider: 'session_file', localOnly: true },
            links: {
              self: '/api/resources/res_sf_img',
              content: '/api/resources/res_sf_img/content',
            },
          },
        }],
      },
    } as any);

    render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'a-img',
          role: 'assistant',
          blocks: [
            {
              type: 'file',
              fileId: 'sf_img',
              filePath: '/remote/cache/img.png',
              label: 'img.png',
              ext: 'png',
              status: 'available',
            },
          ],
        }}
      />,
    );

    const preview = screen.getByRole('img', { name: 'img.png' });
    expect(preview).toHaveAttribute(
      'src',
      'https://hana.example/api/resources/res_sf_img/content',
    );
  });

  it('renders a phone-download action for staged file cards backed by a resource URL', () => {
    delete (window as any).platform;
    useStore.setState({
      activeServerConnection: {
        kind: 'lan',
        serverId: 'server_lan',
        userId: 'user_lan',
        studioId: 'studio_lan',
        label: 'LAN Hana',
        baseUrl: 'http://hana.local:14500',
        wsUrl: 'ws://hana.local:14500',
        token: null,
        authState: 'paired',
        trustState: 'lan',
        credentialKind: 'device_credential',
        platformAccountId: null,
        officialServiceKind: null,
        capabilities: ['resources', 'files'],
      },
      sessionRegistryFilesByPath: {
        '/sessions/main.jsonl': [{
          fileId: 'sf_demo',
          filePath: '/remote/cache/demo.pdf',
          label: 'demo.pdf',
          ext: 'pdf',
          status: 'available',
          resource: {
            schemaVersion: 1,
            resourceId: 'res_sf_demo',
            name: 'studios/studio_lan/resources/res_sf_demo',
            studioId: 'studio_lan',
            type: 'file',
            source: 'session_file',
            fileId: 'sf_demo',
            lifecycle: { status: 'available', missingAt: null },
            storage: { provider: 'session_file', localOnly: true },
            links: {
              self: '/api/resources/res_sf_demo',
              content: '/api/resources/res_sf_demo/content',
            },
          },
        }],
      },
    } as any);

    render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'a-download',
          role: 'assistant',
          blocks: [
            {
              type: 'file',
              fileId: 'sf_demo',
              filePath: '/remote/cache/demo.pdf',
              label: 'demo.pdf',
              ext: 'pdf',
              status: 'available',
            },
          ],
        }}
      />,
    );

    const download = screen.getByRole('link', { name: '下载到本机 demo.pdf' });
    expect(download).toHaveAttribute('href', 'http://hana.local:14500/api/resources/res_sf_demo/content');
    expect(download).toHaveAttribute('download', 'demo.pdf');
  });
});
