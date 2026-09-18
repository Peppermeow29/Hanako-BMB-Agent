import { describe, expect, it, vi } from 'vitest';
import {
  evaluateChatImageSendPreflight,
  evaluateChatAudioSendPreflight,
  getModelImageInputMode,
  getModelAudioInputMode,
  getModelVideoInputMode,
  hasChatAudioAttachments,
  hasChatImageAttachments,
  hasChatVideoAttachments,
  notifyTextModelAudioBlocked,
  notifyTextModelImageFileOnly,
  notifyTextModelVideoFileOnly,
  evaluateChatVideoSendPreflight,
} from '../../utils/chat-image-send-preflight';

describe('chat image send preflight', () => {
  it('detects only non-directory image attachments as chat images', () => {
    expect(hasChatImageAttachments([
      { path: '/tmp/a.png', name: 'a.png' },
      { path: '/tmp/folder.png', name: 'folder.png', isDirectory: true },
    ])).toBe(true);

    expect(hasChatImageAttachments([
      { path: '/tmp/a.pdf', name: 'a.pdf' },
      { path: '/tmp/folder.png', name: 'folder.png', isDirectory: true },
    ])).toBe(false);
  });

  it('treats explicit text-only models as blocked candidates', () => {
    expect(getModelImageInputMode({ input: ['text'] })).toBe('text-only');
    expect(getModelImageInputMode({ input: ['text', 'image'] })).toBe('native-image');
    expect(getModelImageInputMode({})).toBe('unknown');
    expect(getModelVideoInputMode({ input: ['text', 'image'] })).toBe('no-native-video');
    expect(getModelVideoInputMode({ input: ['text', 'video'] })).toBe('native-video');
    expect(getModelVideoInputMode({ input: ['text', 'image'], video: true })).toBe('native-video');
    expect(getModelVideoInputMode({ input: ['text', 'image'], video: true, videoTransportSupported: false })).toBe('no-native-video');
    expect(getModelVideoInputMode({ input: ['text', 'image'], video: true, videoTransport: 'openai-video-url' })).toBe('native-video');
    expect(getModelVideoInputMode({})).toBe('unknown');
    expect(getModelAudioInputMode({
      id: 'mimo-v2.5',
      provider: 'mimo',
      api: 'openai-completions',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      input: ['text'],
    })).toBe('native-audio');
    expect(getModelAudioInputMode({
      id: 'gpt-audio-mini',
      provider: 'openai',
      input: ['text'],
      audio: true,
      audioTransport: 'openai-input-audio',
      audioTransportSupported: true,
    })).toBe('native-audio');
    expect(getModelAudioInputMode({
      id: 'future-audio',
      provider: 'custom',
      input: ['text'],
      audio: true,
      audioTransport: 'unsupported',
      audioTransportSupported: false,
    })).toBe('no-native-audio');
    expect(getModelAudioInputMode({ id: 'deepseek-chat', provider: 'deepseek', input: ['text'] })).toBe('no-native-audio');
  });

  it('blocks image send for text-only models when auxiliary vision is unavailable', async () => {
    const loadVisionAuxiliaryConfig = vi.fn(async () => ({
      enabled: false,
      model: { id: 'qwen-vl', provider: 'dashscope' },
    }));

    const result = await evaluateChatImageSendPreflight({
      attachments: [{ path: '/tmp/a.png', name: 'a.png' }],
      model: { id: 'deepseek-v4-pro', provider: 'deepseek', input: ['text'] },
      loadVisionAuxiliaryConfig,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'text-model-image-without-auxiliary',
      imageInputMode: 'text-only',
    });
    expect(loadVisionAuxiliaryConfig).toHaveBeenCalledOnce();
  });

  it('allows image send for text-only models when auxiliary vision can handle it', async () => {
    const loadVisionAuxiliaryConfig = vi.fn(async () => ({
      enabled: true,
      model: { id: 'qwen-vl', provider: 'dashscope' },
    }));

    const result = await evaluateChatImageSendPreflight({
      attachments: [{ path: '/tmp/a.png', name: 'a.png' }],
      model: { id: 'deepseek-v4-pro', provider: 'deepseek', input: ['text'] },
      loadVisionAuxiliaryConfig,
    });

    expect(result).toEqual({
      ok: true,
      reason: 'auxiliary-vision',
      imageInputMode: 'text-only',
    });
  });

  it('does not fetch auxiliary vision config when the model natively supports images', async () => {
    const loadVisionAuxiliaryConfig = vi.fn(async () => ({
      enabled: false,
      model: null,
    }));

    const result = await evaluateChatImageSendPreflight({
      attachments: [{ path: '/tmp/a.png', name: 'a.png' }],
      model: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
      loadVisionAuxiliaryConfig,
    });

    expect(result).toEqual({
      ok: true,
      reason: 'native-image',
      imageInputMode: 'native-image',
    });
    expect(loadVisionAuxiliaryConfig).not.toHaveBeenCalled();
  });

  it('builds one actionable file-only notice toast for text-only image sends (#1647)', () => {
    const addToast = vi.fn();
    const openSettings = vi.fn();
    const t = (key: string) => `i18n:${key}`;

    notifyTextModelImageFileOnly({
      t,
      addToast,
      openSettings,
    });

    expect(addToast).toHaveBeenCalledWith(
      'i18n:input.textModelImageFileOnly',
      'warning',
      9000,
      {
        dedupeKey: 'text-model-image-file-only',
        action: {
          label: 'i18n:input.openModelSettings',
          onClick: expect.any(Function),
        },
      },
    );

    addToast.mock.calls[0][3].action.onClick();
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it('detects only non-directory video attachments as chat videos', () => {
    expect(hasChatVideoAttachments([
      { path: '/tmp/a.mp4', name: 'a.mp4' },
      { path: '/tmp/folder.mp4', name: 'folder.mp4', isDirectory: true },
    ])).toBe(true);

    expect(hasChatVideoAttachments([
      { path: '/tmp/a.png', name: 'a.png' },
      { path: '/tmp/folder.webm', name: 'folder.webm', isDirectory: true },
    ])).toBe(false);
  });

  it('allows video send only when the current model explicitly supports video', async () => {
    const result = await evaluateChatVideoSendPreflight({
      attachments: [{ path: '/tmp/a.mp4', name: 'a.mp4' }],
      model: { id: 'qwen3-vl-plus', provider: 'dashscope', input: ['text', 'image'], video: true },
    });

    expect(result).toEqual({
      ok: true,
      reason: 'native-video',
      videoInputMode: 'native-video',
    });
  });

  it('blocks video send when model capability is unknown or text/image-only', async () => {
    await expect(evaluateChatVideoSendPreflight({
      attachments: [{ path: '/tmp/a.mp4', name: 'a.mp4' }],
      model: { id: 'unknown-model', provider: 'custom' },
    })).resolves.toEqual({
      ok: false,
      reason: 'model-video-unsupported',
      videoInputMode: 'unknown',
    });

    await expect(evaluateChatVideoSendPreflight({
      attachments: [{ path: '/tmp/a.mp4', name: 'a.mp4' }],
      model: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
    })).resolves.toEqual({
      ok: false,
      reason: 'model-video-unsupported',
      videoInputMode: 'no-native-video',
    });
  });

  it('builds one actionable file-only notice toast for unsupported video sends', () => {
    const addToast = vi.fn();
    const openSettings = vi.fn();
    const t = (key: string) => `i18n:${key}`;

    notifyTextModelVideoFileOnly({
      t,
      addToast,
      openSettings,
    });

    expect(addToast).toHaveBeenCalledWith(
      'i18n:input.textModelVideoFileOnly',
      'warning',
      9000,
      {
        dedupeKey: 'text-model-video-file-only',
        action: {
          label: 'i18n:input.openModelSettings',
          onClick: expect.any(Function),
        },
      },
    );

    addToast.mock.calls[0][3].action.onClick();
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it('detects only non-directory audio attachments as chat audios', () => {
    expect(hasChatAudioAttachments([
      { path: '/tmp/a.wav', name: 'a.wav' },
      { path: '/tmp/folder.wav', name: 'folder.wav', isDirectory: true },
    ])).toBe(true);

    expect(hasChatAudioAttachments([
      { path: '/tmp/a.png', name: 'a.png' },
      { path: '/tmp/folder.weba', name: 'folder.weba', isDirectory: true },
    ])).toBe(false);
  });

  it('allows audio send only when the current model supports direct audio input', async () => {
    await expect(evaluateChatAudioSendPreflight({
      attachments: [{ path: '/tmp/a.wav', name: 'a.wav' }],
      model: {
        id: 'mimo-v2.5',
        provider: 'mimo',
        api: 'openai-completions',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        input: ['text'],
      },
    })).resolves.toEqual({
      ok: true,
      reason: 'native-audio',
      audioInputMode: 'native-audio',
    });

    await expect(evaluateChatAudioSendPreflight({
      attachments: [{ path: '/tmp/a.wav', name: 'a.wav' }],
      model: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
    })).resolves.toEqual({
      ok: false,
      reason: 'model-audio-unsupported',
      audioInputMode: 'no-native-audio',
    });
  });

  it('builds one actionable warning toast for unsupported audio sends', () => {
    const addToast = vi.fn();
    const openSettings = vi.fn();
    const t = (key: string) => `i18n:${key}`;

    notifyTextModelAudioBlocked({
      t,
      addToast,
      openSettings,
    });

    expect(addToast).toHaveBeenCalledWith(
      'i18n:input.textModelAudioBlocked',
      'warning',
      9000,
      {
        dedupeKey: 'text-model-audio-blocked',
        action: {
          label: 'i18n:input.openModelSettings',
          onClick: expect.any(Function),
        },
      },
    );

    addToast.mock.calls[0][3].action.onClick();
    expect(openSettings).toHaveBeenCalledOnce();
  });
});
