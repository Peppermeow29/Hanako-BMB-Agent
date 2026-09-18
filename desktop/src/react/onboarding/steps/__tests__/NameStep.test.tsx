/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NameStep } from '../NameStep';
import { createOnboardingVerificationPlan } from '../../onboarding-actions';
import type { HanaFetch } from '../../onboarding-actions';

describe('NameStep', () => {
  beforeEach(() => {
    vi.stubGlobal('t', (key: string) => {
      const map: Record<string, string> = {
        'onboarding.name.title': '名字与记忆',
        'onboarding.name.subtitle': '先让我知道该怎么称呼你，也给这个 Agent 一个名字。',
        'onboarding.name.userLabel': '我该怎么称呼你？',
        'onboarding.name.placeholder': '你的名字',
        'onboarding.name.agentLabel': '这个 Agent 叫什么？',
        'onboarding.name.agentPlaceholder': '小花',
        'onboarding.name.memoryTitle': '记忆系统',
        'onboarding.name.memoryHint': '开启后，系统会在对话结束时整理聊天内容，形成记忆。因为记忆会经常更新，会导致模型缓存命中率降低，关掉记忆时通常会更省钱。',
        'onboarding.name.back': '上一步',
        'onboarding.name.next': '下一步',
      };
      return map[key] ?? key;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders user and agent placeholders with memory enabled by default', () => {
    render(<NameStep preview hanaFetch={vi.fn<HanaFetch>()} agentId="hana-primary" verificationPlan={createOnboardingVerificationPlan()} goToStep={vi.fn()} showError={vi.fn()} />);

    expect(screen.getByPlaceholderText('你的名字')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('小花')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '记忆系统' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('开启后，系统会在对话结束时整理聊天内容，形成记忆。因为记忆会经常更新，会导致模型缓存命中率降低，关掉记忆时通常会更省钱。')).toBeInTheDocument();
  });

  it('saves identity and memory settings before moving to provider setup', async () => {
    const hanaFetch = vi.fn<HanaFetch>(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response));
    const goToStep = vi.fn();

    render(<NameStep preview={false} hanaFetch={hanaFetch} agentId="hana-primary" verificationPlan={createOnboardingVerificationPlan()} goToStep={goToStep} showError={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('你的名字'), { target: { value: '测试用户' } });
    fireEvent.change(screen.getByPlaceholderText('小花'), { target: { value: 'Hana' } });
    fireEvent.click(screen.getByRole('switch', { name: '记忆系统' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    await waitFor(() => {
      expect(goToStep).toHaveBeenCalledWith(2);
    });
    const body = JSON.parse(String(hanaFetch.mock.calls[0][1]?.body));
    expect(body).toEqual({
      user: { name: '测试用户' },
      agent: { name: 'Hana' },
      memory: { enabled: false },
    });
  });
});
