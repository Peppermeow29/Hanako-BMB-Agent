import { describe, expect, it } from 'vitest';
import { shouldShowThinkingControl } from '../../utils/model-thinking';

describe('model thinking controls', () => {
  it('shows thinking controls for Qwen-style controllable models even when default reasoning is off', () => {
    const models = [{
      id: 'qwen3.6-apex',
      provider: 'dashscope',
      reasoning: false,
      quirks: ['enable_thinking'],
    }];

    expect(shouldShowThinkingControl(models[0], models)).toBe(true);
  });

  it('uses the full model registry entry when the session model projection omits quirks', () => {
    const sessionModel = {
      id: 'qwen3.6-apex',
      provider: 'dashscope',
      reasoning: false,
    };
    const models = [{
      id: 'qwen3.6-apex',
      provider: 'dashscope',
      reasoning: false,
      quirks: ['enable_thinking'],
    }];

    expect(shouldShowThinkingControl(sessionModel, models)).toBe(true);
  });

  it('keeps reasoning=false as hidden for models without a controllable thinking channel', () => {
    const model = {
      id: 'plain-local',
      provider: 'ollama',
      reasoning: false,
    };

    expect(shouldShowThinkingControl(model, [model])).toBe(false);
  });
});
