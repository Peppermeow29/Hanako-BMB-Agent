/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hanaFetchMock = vi.fn();
const showToastMock = vi.fn();

function response(body: unknown): Response {
  return { json: async () => body } as Response;
}

// memory.editable_facts 已毕业转正（不再是实验，也不再出现在 registry 里）；
// memory.cache_snapshot_reflection 也已退休。当前没有存活的 owner: "memory" 实验，
// 所以 /api/experiments 对 memory 部分只会返回空数组。
const experimentsPayload = {
  experiments: [],
};

const observationPayload = {
  observation: {
    status: 'success',
    createdAt: '2026-06-03T00:00:00.000Z',
    sessionPath: '/tmp/session.jsonl',
    trigger: 'threshold',
    usage: { model: 'test-model', cachedTokens: 10, missTokens: 1, latencyMs: 30 },
    summaryPreview: '### 重要事实\n- 无',
    memoryMdPreview: '## 重要事实\n- 候选记忆',
  },
};

vi.mock('../../settings/api', () => ({
  hanaFetch: (url: string, opts?: RequestInit) => hanaFetchMock(url, opts),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => ({
    'settings.experiments.title': '实验',
    'settings.experiments.description': '前沿功能会先放在这里观察。',
    'settings.experiments.owner.memory': '记忆',
    'settings.experiments.memoryTitle': '记忆实验',
    'settings.experiments.memorySectionDescription': '记忆相关实验。',
    'settings.experiments.empty': '暂无实验',
    'settings.experiments.cacheSnapshot.title': '缓存记忆系统',
    'settings.experiments.cacheSnapshot.description': '使用缓存快照生成 rolling summary。',
    'settings.experiments.cacheSnapshot.observeOnly': '只观察，不写入记忆',
    'settings.experiments.cacheSnapshot.observationNote': '观察模式不会对正式记忆产生任何影响。它只用于观察新的记忆系统是否达到预期效果。',
    'settings.experiments.cacheSnapshot.writeWarning': '当前会写入正式记忆。',
    'settings.experiments.cacheSnapshot.previewTitle': 'Memory MD Preview',
    'settings.experiments.cacheSnapshot.summaryTitle': 'Rolling Summary Preview',
    'settings.experiments.cacheSnapshot.emptyPreview': '暂无观察结果',
    'settings.experiments.cacheSnapshot.clearObservation': '清除观察结果',
    'settings.experiments.status.alpha': 'Alpha',
    'settings.experiments.status.beta': 'Beta',
    'settings.experiments.risk.medium': '中风险',
    'settings.experiments.restart.immediate': '立即生效',
    'settings.experiments.restart.new_session': '新会话生效',
    'settings.autoSaved': '已保存',
  }[key] || key),
}));

vi.mock('../../settings/store', () => {
  const state = {
    agents: [
      { id: 'hana', name: 'Hana', yuan: 'hanako', isPrimary: false },
      { id: 'primary', name: 'Primary', yuan: 'hanako', isPrimary: true },
    ],
    getSettingsAgentId: () => 'hana',
    showToast: showToastMock,
  };
  type SettingsStoreHook = {
    (selector?: (s: typeof state) => unknown): unknown;
    getState: () => typeof state;
  };
  const hook = ((selector?: (s: typeof state) => unknown) => (
    selector ? selector(state) : state
  )) as SettingsStoreHook;
  hook.getState = () => state;
  return { useSettingsStore: hook };
});

vi.mock('../../utils/markdown', () => ({
  renderMarkdown: (md: string) => `<p>${md}</p>`,
}));

describe('ExperimentsTab', () => {
  beforeEach(() => {
    hanaFetchMock.mockReset();
    showToastMock.mockClear();
    hanaFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') {
        return response({ ok: true, value: JSON.parse(String(opts.body)).value });
      }
      if (url === '/api/experiments') return response(experimentsPayload);
      if (url === '/api/experiments/memory/cache-snapshot-reflection/observation?agentId=primary') {
        return response(observationPayload);
      }
      return response({ observation: null });
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the memory section empty state when the API omits both retired experiments', async () => {
    const { ExperimentsTab } = await import('../../settings/tabs/ExperimentsTab');
    render(<ExperimentsTab />);

    expect(await screen.findByText('暂无实验')).toBeInTheDocument();
    expect(screen.queryByText('可编辑记忆')).not.toBeInTheDocument();
    expect(screen.queryByText('缓存记忆系统')).not.toBeInTheDocument();
    expect(screen.queryByText('只观察，不写入记忆')).not.toBeInTheDocument();
    expect(hanaFetchMock).not.toHaveBeenCalledWith(
      '/api/experiments/memory/cache-snapshot-reflection/observation?agentId=primary',
      undefined,
    );
  });
});
