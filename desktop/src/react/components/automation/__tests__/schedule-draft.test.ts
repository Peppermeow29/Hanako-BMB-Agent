import { describe, expect, it } from 'vitest';
import {
  scheduleDraftFromStored,
  storedScheduleFromDraft,
} from '../schedule-draft';

describe('automation schedule draft conversion', () => {
  it('parses common cron schedules into user-facing modes', () => {
    expect(scheduleDraftFromStored('cron', '0 9 * * *')).toMatchObject({
      mode: 'daily',
      time: '09:00',
    });
    expect(scheduleDraftFromStored('cron', '30 18 * * 1')).toMatchObject({
      mode: 'weekly',
      weekday: '1',
      time: '18:30',
    });
    expect(scheduleDraftFromStored('cron', '15 8 3 * *')).toMatchObject({
      mode: 'monthly',
      monthDay: '3',
      time: '08:15',
    });
  });

  it('round-trips interval drafts through persisted every schedules', () => {
    const draft = scheduleDraftFromStored('every', 7_200_000);
    expect(draft).toMatchObject({
      mode: 'interval',
      intervalValue: '2',
      intervalUnit: 'hours',
    });
    expect(storedScheduleFromDraft(draft)).toEqual({
      type: 'every',
      schedule: 7_200_000,
    });
  });

  it('serializes weekly and monthly selections to existing cron storage', () => {
    expect(storedScheduleFromDraft({
      ...scheduleDraftFromStored('cron', '0 9 * * *'),
      mode: 'weekly',
      weekday: '5',
      time: '21:45',
    })).toEqual({ type: 'cron', schedule: '45 21 * * 5' });

    expect(storedScheduleFromDraft({
      ...scheduleDraftFromStored('cron', '0 9 * * *'),
      mode: 'monthly',
      monthDay: '12',
      time: '07:05',
    })).toEqual({ type: 'cron', schedule: '5 7 12 * *' });
  });
});
