import { describe, expect, it } from 'vitest';
import type { Session } from '../../types';
import {
  autoProjectIdForCwd,
  buildSessionProjectView,
  buildSessionSections,
  type SessionProjectCatalog,
} from '../../components/session-sections';
import { UNCATEGORIZED_PROJECT_ID } from '../../../../../shared/session-projects.ts';

function makeSession(overrides: Partial<Session>): Session {
  return {
    path: '/sessions/default.jsonl',
    title: null,
    firstMessage: '',
    modified: '2026-04-29T01:00:00.000Z',
    messageCount: 1,
    agentId: 'hana',
    agentName: 'Hana',
    cwd: null,
    ...overrides,
  };
}

describe('buildSessionSections', () => {
  it('places pinned sessions first, sorts them by modified time, and excludes them from date sections', () => {
    const sections = buildSessionSections([
      makeSession({
        path: '/sessions/today.jsonl',
        firstMessage: 'today',
        modified: '2026-04-29T07:00:00.000Z',
      }),
      makeSession({
        path: '/sessions/recent-pin.jsonl',
        firstMessage: 'recent pin',
        modified: '2026-04-29T09:00:00.000Z',
        pinnedAt: '2026-04-28T07:00:00.000Z',
      }),
      makeSession({
        path: '/sessions/freshly-pinned-old-chat.jsonl',
        firstMessage: 'freshly pinned old chat',
        modified: '2026-04-28T07:00:00.000Z',
        pinnedAt: '2026-04-29T08:00:00.000Z',
      }),
    ], {
      mode: 'time',
      now: new Date('2026-04-29T12:00:00.000Z'),
    });

    expect(sections.map(section => section.kind)).toEqual(['pinned', 'date']);
    expect(sections[0]).toMatchObject({
      kind: 'pinned',
      titleKey: 'sidebar.pinned',
    });
    expect(sections[0].items.map(item => item.path)).toEqual([
      '/sessions/recent-pin.jsonl',
      '/sessions/freshly-pinned-old-chat.jsonl',
    ]);
    expect(sections[1]).toMatchObject({
      kind: 'date',
      titleKey: 'time.today',
    });
    expect(sections[1].items.map(item => item.path)).toEqual(['/sessions/today.jsonl']);
  });

  it('keeps the pinned section visible when no sessions are pinned and rolls yesterday into this week', () => {
    const sections = buildSessionSections([
      makeSession({
        path: '/sessions/yesterday.jsonl',
        modified: '2026-04-28T07:00:00.000Z',
      }),
    ], {
      mode: 'time',
      now: new Date('2026-04-29T12:00:00.000Z'),
    });

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({
      kind: 'pinned',
      titleKey: 'sidebar.pinned',
      items: [],
    });
    expect(sections[1]).toMatchObject({
      kind: 'date',
      titleKey: 'time.thisWeek',
    });
  });

  it('sorts sessions within a date group by modified descending', () => {
    const sections = buildSessionSections([
      makeSession({
        path: '/sessions/older.jsonl',
        firstMessage: 'older',
        modified: '2026-04-29T02:00:00.000Z',
      }),
      makeSession({
        path: '/sessions/newer.jsonl',
        firstMessage: 'newer',
        modified: '2026-04-29T09:00:00.000Z',
      }),
      makeSession({
        path: '/sessions/middle.jsonl',
        firstMessage: 'middle',
        modified: '2026-04-29T05:00:00.000Z',
      }),
    ], {
      mode: 'time',
      now: new Date('2026-04-29T12:00:00.000Z'),
    });

    const todaySection = sections.find(s => s.kind === 'date' && s.group === 'today');
    expect(todaySection).toBeDefined();
    expect(todaySection!.items.map(i => i.path)).toEqual([
      '/sessions/newer.jsonl',
      '/sessions/middle.jsonl',
      '/sessions/older.jsonl',
    ]);
  });

  it('uses a deterministic path tie-breaker and sinks malformed dates', () => {
    const sections = buildSessionSections([
      makeSession({
        path: '/sessions/z-same-time.jsonl',
        modified: '2026-04-29T09:00:00.000Z',
      }),
      makeSession({
        path: '/sessions/bad-date.jsonl',
        modified: 'not-a-date',
      }),
      makeSession({
        path: '/sessions/a-same-time.jsonl',
        modified: '2026-04-29T09:00:00.000Z',
      }),
    ], {
      mode: 'time',
      now: new Date('2026-04-29T12:00:00.000Z'),
    });

    const todaySection = sections.find(s => s.kind === 'date' && s.group === 'today');
    const earlierSection = sections.find(s => s.kind === 'date' && s.group === 'earlier');
    expect(todaySection!.items.map(i => i.path)).toEqual([
      '/sessions/a-same-time.jsonl',
      '/sessions/z-same-time.jsonl',
    ]);
    expect(earlierSection!.items.map(i => i.path)).toEqual(['/sessions/bad-date.jsonl']);
  });

  it('orders pinned sessions by their manual pin order, smallest first', () => {
    const sections = buildSessionSections([
      makeSession({
        path: '/sessions/second.jsonl',
        modified: '2026-04-29T09:00:00.000Z',
        pinnedAt: '2026-04-28T07:00:00.000Z',
        pinOrder: 2048,
      }),
      makeSession({
        path: '/sessions/first.jsonl',
        modified: '2026-04-28T01:00:00.000Z',
        pinnedAt: '2026-04-28T07:00:00.000Z',
        pinOrder: -1024,
      }),
      makeSession({
        path: '/sessions/third.jsonl',
        modified: '2026-04-29T10:00:00.000Z',
        pinnedAt: '2026-04-28T07:00:00.000Z',
        pinOrder: 4096,
      }),
    ], { mode: 'time', now: new Date('2026-04-29T12:00:00.000Z') });

    expect(sections[0].items.map(item => item.path)).toEqual([
      '/sessions/first.jsonl',
      '/sessions/second.jsonl',
      '/sessions/third.jsonl',
    ]);
  });

  it('keeps sessions without a manual order below the ordered ones, newest first', () => {
    const sections = buildSessionSections([
      makeSession({
        path: '/sessions/unordered-old.jsonl',
        modified: '2026-04-28T01:00:00.000Z',
        pinnedAt: '2026-04-28T07:00:00.000Z',
      }),
      makeSession({
        path: '/sessions/ordered.jsonl',
        modified: '2026-04-20T01:00:00.000Z',
        pinnedAt: '2026-04-28T07:00:00.000Z',
        pinOrder: 9999,
      }),
      makeSession({
        path: '/sessions/unordered-new.jsonl',
        modified: '2026-04-29T01:00:00.000Z',
        pinnedAt: '2026-04-28T07:00:00.000Z',
        pinOrder: null,
      }),
    ], { mode: 'time', now: new Date('2026-04-29T12:00:00.000Z') });

    expect(sections[0].items.map(item => item.path)).toEqual([
      '/sessions/ordered.jsonl',
      '/sessions/unordered-new.jsonl',
      '/sessions/unordered-old.jsonl',
    ]);
  });
});

describe('buildSessionProjectView', () => {
  it('orders the pinned strip by manual pin order too', () => {
    const view = buildSessionProjectView([
      {
        path: '/sessions/b.jsonl',
        title: null,
        firstMessage: '',
        modified: '2026-04-29T09:00:00.000Z',
        messageCount: 1,
        agentId: 'hana',
        agentName: 'Hana',
        cwd: null,
        pinnedAt: '2026-04-28T07:00:00.000Z',
        pinOrder: 2048,
      },
      {
        path: '/sessions/a.jsonl',
        title: null,
        firstMessage: '',
        modified: '2026-04-28T01:00:00.000Z',
        messageCount: 1,
        agentId: 'hana',
        agentName: 'Hana',
        cwd: null,
        pinnedAt: '2026-04-28T07:00:00.000Z',
        pinOrder: 1024,
      },
    ]);

    expect(view.pinned.map(session => session.path)).toEqual([
      '/sessions/a.jsonl',
      '/sessions/b.jsonl',
    ]);
  });

  it('excludes pinned sessions and groups unassigned sessions by derived cwd project', () => {
    const cwd = '/Users/test/Desktop/project-hana';
    const sections = buildSessionProjectView([
      makeSession({
        path: '/sessions/pinned.jsonl',
        firstMessage: 'pinned',
        cwd,
        pinnedAt: '2026-05-28T08:00:00.000Z',
      }),
      makeSession({
        path: '/sessions/a.jsonl',
        firstMessage: 'a',
        cwd,
        modified: '2026-05-28T07:00:00.000Z',
      }),
      makeSession({
        path: '/sessions/b.jsonl',
        firstMessage: 'b',
        cwd,
        modified: '2026-05-28T09:00:00.000Z',
      }),
    ], { projects: [] });

    expect(sections.pinned.map(item => item.path)).toEqual(['/sessions/pinned.jsonl']);
    expect(sections.rootProjects).toHaveLength(1);
    expect(sections.rootProjects[0]).toMatchObject({
      id: autoProjectIdForCwd(cwd),
      name: 'project-hana',
      source: 'cwd',
      folderId: null,
    });
    expect(sections.rootProjects[0].items.map(item => item.path)).toEqual([
      '/sessions/b.jsonl',
      '/sessions/a.jsonl',
    ]);
  });

  it('sorts pinned project-view sessions by modified time instead of pin time', () => {
    const cwd = '/Users/test/Desktop/project-hana';
    const view = buildSessionProjectView([
      makeSession({
        path: '/sessions/recent-pin.jsonl',
        firstMessage: 'recent pin',
        cwd,
        modified: '2026-05-28T09:00:00.000Z',
        pinnedAt: '2026-05-27T08:00:00.000Z',
      }),
      makeSession({
        path: '/sessions/freshly-pinned-old-chat.jsonl',
        firstMessage: 'freshly pinned old chat',
        cwd,
        modified: '2026-05-28T07:00:00.000Z',
        pinnedAt: '2026-05-28T10:00:00.000Z',
      }),
    ], { projects: [] });

    expect(view.pinned.map(item => item.path)).toEqual([
      '/sessions/recent-pin.jsonl',
      '/sessions/freshly-pinned-old-chat.jsonl',
    ]);
  });

  it('keeps catalog folders and places assigned projects under their folder', () => {
    const catalog = {
      folders: [
        { id: 'folder-work', name: '作品集', order: 0 },
      ],
      projects: [
        { id: 'project-resume', name: '简历和作品集', folderId: 'folder-work', order: 0 },
        { id: 'project-root', name: '手帐本', folderId: null, order: 1 },
      ],
    } as unknown as SessionProjectCatalog;

    const sections = buildSessionProjectView([
      makeSession({
        path: '/sessions/resume.jsonl',
        title: '作品集整理',
        cwd: '/Users/test/Desktop/project-hana',
        projectId: 'project-resume',
      }),
      makeSession({
        path: '/sessions/root.jsonl',
        title: '手帐本',
        cwd: '/Users/test/Desktop/notes',
        projectId: 'project-root',
      }),
    ], catalog);

    expect(sections.rootProjects).toEqual([
      expect.objectContaining({
        id: 'project-root',
        folderId: null,
        items: [expect.objectContaining({ path: '/sessions/root.jsonl' })],
      }),
    ]);
    expect(sections.folders).toEqual([
      expect.objectContaining({
        id: 'folder-work',
        name: '作品集',
        projects: [
          expect.objectContaining({
            id: 'project-resume',
            folderId: 'folder-work',
            items: [expect.objectContaining({ path: '/sessions/resume.jsonl' })],
          }),
        ],
      }),
    ]);
  });

  it('falls back to cwd project when a session references a missing custom project', () => {
    const sections = buildSessionProjectView([
      makeSession({
        path: '/sessions/orphan.jsonl',
        cwd: '/Users/test/Desktop/orphan-cwd',
        projectId: 'missing-project',
      }),
    ], { projects: [] });

    expect(sections.rootProjects).toHaveLength(1);
    expect(sections.rootProjects[0]).toMatchObject({
      id: autoProjectIdForCwd('/Users/test/Desktop/orphan-cwd'),
      name: 'orphan-cwd',
    });
  });

  it('keeps explicitly uncategorized sessions out of cwd-derived projects', () => {
    const sections = buildSessionProjectView([
      makeSession({
        path: '/sessions/uncategorized.jsonl',
        cwd: '/Users/test/Desktop/project-hana',
        projectId: UNCATEGORIZED_PROJECT_ID,
      }),
    ], { projects: [] });

    expect(sections.rootProjects).toHaveLength(1);
    expect(sections.rootProjects[0]).toMatchObject({
      id: UNCATEGORIZED_PROJECT_ID,
      name: '未归类',
      source: 'cwd',
    });
  });

  it('surfaces empty catalog folders so users can drag projects into them', () => {
    const sections = buildSessionProjectView([], {
      folders: [{ id: 'folder-empty', name: '稍后整理', order: 0 }],
      projects: [],
    } as unknown as SessionProjectCatalog);

    expect(sections.rootProjects).toEqual([]);
    expect(sections.folders).toEqual([
      expect.objectContaining({
        id: 'folder-empty',
        name: '稍后整理',
        projects: [],
      }),
    ]);
  });

  it('does not demote catalog-assigned sessions to a cwd project while the catalog is still loading', () => {
    // Regression: when the project catalog has not finished loading, a session that
    // belongs to a real (custom) project must NOT be silently re-bucketed into a
    // cwd-derived project. Doing so makes custom projects vanish and dumps their
    // sessions into the auto "Hana"-style group until the user toggles sort order.
    const view = buildSessionProjectView([
      makeSession({
        path: '/sessions/lili.jsonl',
        cwd: '/Users/test/Hana',
        projectId: 'project-e61c751e',
      }),
    ], { projects: [] }, { catalogLoaded: false });

    const groupedPaths = [
      ...view.rootProjects.flatMap(project => project.items),
      ...view.folders.flatMap(folder => folder.projects.flatMap(project => project.items)),
    ].map(session => session.path);

    expect(view.pending).toBe(true);
    expect(groupedPaths).not.toContain('/sessions/lili.jsonl');
  });

  it('still groups cwd-only sessions while the catalog is loading', () => {
    // Holding back catalog-assigned sessions must not punish sessions that derive
    // their group purely from cwd: those do not depend on the catalog at all.
    const view = buildSessionProjectView([
      makeSession({
        path: '/sessions/plain.jsonl',
        cwd: '/Users/test/Hana',
      }),
    ], { projects: [] }, { catalogLoaded: false });

    const cwdGroup = view.rootProjects.find(project => project.source === 'cwd');
    expect(cwdGroup?.items.map(session => session.path)).toEqual(['/sessions/plain.jsonl']);
    expect(view.pending).toBe(true);
  });
});
