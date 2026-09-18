// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorBus } from '../../../../../shared/error-bus.ts';
import { AppError } from '../../../../../shared/errors.ts';
import { initErrorBusBridge } from '../../errors/error-bus-bridge';
import { useStore } from '../../stores';
import { installWindowTestT } from '../helpers/i18n-test-strings';

describe('error-bus-bridge', () => {
  const addToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    errorBus._listeners = [];
    errorBus._recentFingerprints = new Map();
    useStore.setState({ addToast } as never);
    initErrorBusBridge();
  });

  it('shows the localized copy instead of the English message the error carries', () => {
    installWindowTestT({ 'error.llmTimeout': '模型响应超时' });

    errorBus.report(new AppError('LLM_TIMEOUT', { message: 'Request timed out after 60s' }));

    expect(addToast).toHaveBeenCalledWith(
      '模型响应超时',
      'error',
      5000,
      expect.objectContaining({ errorCode: 'LLM_TIMEOUT' }),
    );
  });

  it('falls back to the raw message when the locale file has no entry for the key', () => {
    installWindowTestT({});

    errorBus.report(new AppError('LLM_TIMEOUT', { message: 'Request timed out after 60s' }));

    expect(addToast).toHaveBeenCalledWith(
      'Request timed out after 60s',
      'error',
      5000,
      expect.objectContaining({ errorCode: 'LLM_TIMEOUT' }),
    );
  });

  it('falls back to the code when neither a translation nor a message exists', () => {
    installWindowTestT({});

    errorBus.report(new AppError('LLM_TIMEOUT', { message: '' }));

    expect(addToast).toHaveBeenCalledWith(
      'LLM_TIMEOUT',
      'error',
      5000,
      expect.objectContaining({ errorCode: 'LLM_TIMEOUT' }),
    );
  });
});
