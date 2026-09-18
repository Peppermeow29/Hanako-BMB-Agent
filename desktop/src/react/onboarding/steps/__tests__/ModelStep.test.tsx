/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mocks = vi.hoisted(() => ({
  loadModels: vi.fn(),
  saveModel: vi.fn(),
}));

vi.mock('../../onboarding-actions', () => ({
  describeOnboardingError: (_error: unknown, fallback: string) => fallback,
  loadModels: (...args: unknown[]) => mocks.loadModels(...args),
  saveModel: (...args: unknown[]) => mocks.saveModel(...args),
}));

import { ModelStep } from '../ModelStep';

describe('ModelStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('t', (key: string) => key);
    mocks.loadModels.mockResolvedValue({
      models: [
        { id: 'deepseek-v4-flash' },
        { id: 'deepseek-v4-pro' },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps discovered models out of the added-model list until the user adds one', async () => {
    render(
      <ModelStep
        preview={false}
        hanaFetch={vi.fn()}
        agentId="hana-primary"
        verificationPlan={{ agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] }}
        providerName="deepseek"
        providerUrl="https://api.deepseek.com"
        providerApi="openai-completions"
        apiKey="sk-test"
        goToStep={vi.fn()}
        showError={vi.fn()}
      />,
    );

    await waitFor(() => expect(mocks.loadModels).toHaveBeenCalled());

    expect(screen.getByText('onboarding.model.noAddedModels')).toBeInTheDocument();
    expect(screen.queryByText('deepseek-v4-flash')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.addModel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'deepseek-v4-flash' }));

    expect(screen.queryByText('onboarding.model.noAddedModels')).not.toBeInTheDocument();
    expect(screen.getByText('deepseek-v4-flash')).toBeInTheDocument();
    expect(screen.getByText('onboarding.model.mainModel')).toBeInTheDocument();
  });

  it('prefills the edit panel with known-model metadata for added models', async () => {
    render(
      <ModelStep
        preview={false}
        hanaFetch={vi.fn()}
        agentId="hana-primary"
        verificationPlan={{ agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] }}
        providerName="deepseek"
        providerUrl="https://api.deepseek.com"
        providerApi="openai-completions"
        apiKey="sk-test"
        goToStep={vi.fn()}
        showError={vi.fn()}
      />,
    );

    await waitFor(() => expect(mocks.loadModels).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.addModel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'deepseek-v4-flash' }));
    fireEvent.click(screen.getByTitle('onboarding.model.editModel'));

    expect(screen.getByLabelText('onboarding.model.displayName')).toHaveValue('DeepSeek V4 Flash');
    expect(screen.getByLabelText('onboarding.model.contextLength')).toHaveValue('1000000');
    expect(screen.getByLabelText('onboarding.model.maxOutput')).toHaveValue('384000');
    expect(screen.getByLabelText('onboarding.model.imageInput')).not.toBeChecked();
    expect(screen.getByLabelText('onboarding.model.audioInput')).not.toBeChecked();
    expect(screen.getByLabelText('onboarding.model.reasoning')).toBeChecked();
  });

  it('allows adding a model manually when discovery returns no models', async () => {
    mocks.loadModels.mockResolvedValueOnce({
      models: [],
      error: 'No models found for provider "custom-provider"',
    });

    render(
      <ModelStep
        preview={false}
        hanaFetch={vi.fn()}
        agentId="hana-primary"
        verificationPlan={{ agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] }}
        providerName="custom-provider"
        providerUrl="https://api.example.com/v1"
        providerApi="openai-completions"
        apiKey="sk-test"
        goToStep={vi.fn()}
        showError={vi.fn()}
      />,
    );

    await waitFor(() => expect(mocks.loadModels).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.addModel' }));
    fireEvent.change(
      await screen.findByPlaceholderText('onboarding.model.manualModelPlaceholder'),
      { target: { value: 'custom-chat-model' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.addManualModel' }));

    expect(screen.getByText('custom-chat-model')).toBeInTheDocument();
    expect(screen.getByText('onboarding.model.mainModel')).toBeInTheDocument();
  });

  it('saves fetched model metadata when adding discovered custom provider models', async () => {
    const goToStep = vi.fn();
    mocks.loadModels.mockResolvedValueOnce({
      models: [
        {
          id: 'custom-vllm-chat',
          name: 'Custom vLLM Chat',
          context: 32768,
          maxOutput: 4096,
          image: true,
          video: true,
          audio: true,
          reasoning: true,
        },
      ],
    });

    render(
      <ModelStep
        preview={false}
        hanaFetch={vi.fn()}
        agentId="hana-primary"
        verificationPlan={{ agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] }}
        providerName="custom-vllm"
        providerUrl="http://127.0.0.1:8000/v1"
        providerApi="openai-completions"
        apiKey="sk-test"
        goToStep={goToStep}
        showError={vi.fn()}
      />,
    );

    await waitFor(() => expect(mocks.loadModels).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.addModel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'custom-vllm-chat' }));

    const utilityTriggers = document.querySelectorAll('.ob-select-widget button[aria-haspopup="listbox"]');
    fireEvent.click(utilityTriggers[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'Custom vLLM Chat' }));
    fireEvent.click(utilityTriggers[1]);
    fireEvent.click(await screen.findByRole('option', { name: 'Custom vLLM Chat' }));

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.next' }));

    await waitFor(() => {
      expect(mocks.saveModel).toHaveBeenCalledWith(expect.objectContaining({
        providerName: 'custom-vllm',
        selectedModel: 'custom-vllm-chat',
        selectedUtility: 'custom-vllm-chat',
        selectedUtilityLarge: 'custom-vllm-chat',
        addedModels: [
          {
            id: 'custom-vllm-chat',
            name: 'Custom vLLM Chat',
            context: 32768,
            maxOutput: 4096,
            image: true,
            video: true,
            audio: true,
            reasoning: true,
          },
        ],
      }));
    });
    expect(goToStep).toHaveBeenCalledWith(4);
  });
});
