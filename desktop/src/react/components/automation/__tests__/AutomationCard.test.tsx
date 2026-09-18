// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationCard } from '../AutomationCard';
import type { CronJob, ModelOption } from '../automation-types';
import { useStore } from '../../../stores';

vi.mock('../ScheduleEditor', () => ({
  ScheduleEditor: () => <div data-testid="schedule-editor" />,
}));

const job: CronJob = {
  id: 'job-1',
  type: 'cron',
  schedule: '0 9 * * *',
  enabled: false,
  label: 'Morning check',
  prompt: 'Check the project status',
};

const models: ModelOption[] = [
  { provider: 'openai', id: 'shared-model', name: 'Shared Model' },
  { provider: 'openrouter', id: 'shared-model', name: 'Shared Model' },
];

describe('AutomationCard model selection', () => {
  beforeEach(() => {
    window.t = ((key: string) => ({
      'automation.defaultModel': 'Default model',
      'rightWorkspace.session.model': 'Model',
      'common.confirm': 'Save',
    }[key] ?? key)) as typeof window.t;
    useStore.setState({
      agents: [{ id: 'hanako', name: 'Hanako', yuan: 'hanako', homeFolder: '/home/hanako' }],
      currentAgentId: 'hanako',
      agentName: 'Hanako',
      agentYuan: 'hanako',
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('groups equal display names by provider and saves the selected provider/id pair', () => {
    const onUpdate = vi.fn();
    render(
      <AutomationCard
        job={job}
        availableModels={models}
        open
        onToggleOpen={vi.fn()}
        onToggleEnabled={vi.fn()}
        onRemove={vi.fn()}
        onUpdate={onUpdate}
      />,
    );

    const modelField = screen.getByText('Model').closest('label');
    expect(modelField).not.toBeNull();
    fireEvent.click(within(modelField!).getByRole('button'));

    expect(screen.getByRole('option', { name: 'Default model' })).toBeInTheDocument();
    expect(screen.getByText('openai')).toBeInTheDocument();
    expect(screen.getByText('openrouter')).toBeInTheDocument();

    const equalNameOptions = screen.getAllByRole('option', { name: 'Shared Model' });
    expect(equalNameOptions).toHaveLength(2);
    const openrouterGroup = screen.getByText('openrouter').parentElement?.parentElement;
    expect(openrouterGroup).not.toBeNull();
    fireEvent.click(within(openrouterGroup!).getByRole('option', { name: 'Shared Model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onUpdate).toHaveBeenCalledWith('job-1', {
      model: { provider: 'openrouter', id: 'shared-model' },
    });
  });
});
