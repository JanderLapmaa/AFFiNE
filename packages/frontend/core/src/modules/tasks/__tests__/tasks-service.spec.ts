/** @vitest-environment happy-dom */

import { Framework } from '@toeverything/infra';
import {
  BehaviorSubject,
  map,
  type Observable,
  Subject,
  type Subscription,
  throwError,
} from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocsService } from '../../doc/services/docs';
import { WorkspaceService } from '../../workspace';
import { TasksService } from '../services/tasks';
import { TasksClockStore } from '../services/tasks-clock';
import type { TaskGroup } from '../types';

// Local-time timestamps, so the tests don't depend on the machine's timezone.
const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

// Wednesday 28 Oct 2026, noon
const NOON = at(2026, 10, 28);

interface TaskSpec {
  docId?: string;
  blockId: string;
  checked?: boolean;
  due?: string;
  priority?: number;
  completedAt?: number;
  order?: number;
  heading?: string;
  title?: string;
  listType?: string;
}

function node(spec: TaskSpec) {
  const additional: Record<string, unknown> = {
    listType: spec.listType ?? 'todo',
    checked: spec.checked ?? false,
  };
  for (const key of ['due', 'priority', 'completedAt', 'order', 'heading']) {
    const value = spec[key as keyof TaskSpec];
    if (value !== undefined) additional[key] = value;
  }
  return {
    id: `${spec.docId ?? 'doc-a'}:${spec.blockId}`,
    fields: {
      docId: spec.docId ?? 'doc-a',
      blockId: spec.blockId,
      content: spec.title ?? spec.blockId,
      additional: JSON.stringify(additional),
    },
  };
}

interface DocSpec {
  id: string;
  title?: string;
  createDate?: number;
  updatedDate?: number;
  trash?: boolean;
  isTemplate?: boolean;
}

/** Mimics block props: `updateBlock` skips `undefined` like the real store. */
function fakeBlockModel(props: Record<string, unknown>) {
  return { flavour: 'affine:list', props };
}

function setup(
  options: {
    now?: number;
    tasks?: TaskSpec[];
    docs?: DocSpec[];
    /** blocks that exist in the source docs: `docId:blockId` -> props */
    blocks?: Record<string, Record<string, unknown>>;
    indexerState?: Record<string, unknown> | null;
  } = {}
) {
  const clock = { now: vi.fn(() => options.now ?? NOON) };
  const rows$ = new BehaviorSubject({
    nodes: (options.tasks ?? []).map(node),
  });
  const indexerState$ = new BehaviorSubject({
    indexing: 0,
    completed: true,
    paused: false,
    total: 0,
    errorMessage: null as string | null,
    ...options.indexerState,
  });
  const indexer = {
    state$: indexerState$,
    search$: vi.fn(() => rows$ as Observable<unknown>),
  };

  const models = new Map<string, ReturnType<typeof fakeBlockModel>>();
  for (const [key, props] of Object.entries(options.blocks ?? {})) {
    models.set(key, fakeBlockModel({ ...props }));
  }
  const opened: string[] = [];
  const released: string[] = [];
  const docs$ = new BehaviorSubject<DocSpec[]>(
    options.docs ?? [
      { id: 'doc-a', title: 'Doc A' },
      { id: 'doc-b', title: 'Doc B' },
    ]
  );
  const docsService = {
    allNonTrashDocIds$: () =>
      docs$.pipe(map(docs => docs.filter(d => !d.trash).map(d => d.id))),
    propertyValues$: () =>
      docs$.pipe(
        map(
          docs =>
            new Map(docs.map(d => [d.id, d.isTemplate ? 'true' : undefined]))
        )
      ),
    allDocTitle$: () =>
      docs$.pipe(
        map(docs => docs.map(d => ({ id: d.id, title: d.title ?? d.id })))
      ),
    allDocsCreatedDate$: () =>
      docs$.pipe(
        map(docs =>
          docs.map(d => ({
            id: d.id,
            createDate: d.createDate ?? at(2026, 10, 1),
          }))
        )
      ),
    allDocsUpdatedDate$: () =>
      docs$.pipe(
        map(docs =>
          docs.map(d => ({
            id: d.id,
            updatedDate: d.updatedDate ?? at(2026, 10, 1),
          }))
        )
      ),
    list: {
      doc$: (id: string) => ({
        get value() {
          const doc = docs$.value.find(d => d.id === id);
          return doc ? { trash$: { value: !!doc.trash } } : undefined;
        },
      }),
    },
    open: vi.fn((docId: string) => {
      opened.push(docId);
      const store = {
        readonly: false,
        transact: (fn: () => void) => fn(),
        updateBlock: (
          model: ReturnType<typeof fakeBlockModel>,
          props: Record<string, unknown>
        ) => {
          for (const [k, v] of Object.entries(props)) {
            if (v !== undefined) model.props[k] = v;
          }
        },
        getBlock: (blockId: string) => {
          const model = models.get(`${docId}:${blockId}`);
          return model ? { model } : undefined;
        },
      };
      return {
        doc: {
          blockSuiteDoc: store,
          addPriorityLoad: () => () => {},
          waitForSyncReady: async () => {},
        },
        release: () => released.push(docId),
      };
    }),
  };

  const framework = new Framework();
  framework.service(
    WorkspaceService,
    () => ({ workspace: { engine: { indexer } } }) as never
  );
  framework.service(DocsService, () => docsService as never);
  framework.store(TasksClockStore, () => clock as never);
  framework.service(TasksService, [
    WorkspaceService,
    DocsService,
    TasksClockStore,
  ]);
  const service = framework.provider().get(TasksService);
  return {
    service,
    clock,
    rows$,
    indexer,
    indexerState$,
    docs$,
    docsService,
    opened,
    released,
    /** the index catches up with the given tasks */
    index: (tasks: TaskSpec[]) => rows$.next({ nodes: tasks.map(node) }),
    /** the indexer reports it is idle again */
    idle: () =>
      indexerState$.next({
        ...indexerState$.value,
        completed: true,
        indexing: 0,
      }),
    /** the indexer starts working on a change */
    busy: () =>
      indexerState$.next({
        ...indexerState$.value,
        completed: false,
        indexing: 1,
      }),
    props: (key: string) => models.get(key)?.props,
  };
}

/** Lets scheduled (asap) work run. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const subscriptions: Subscription[] = [];
function watch<T>(source: Observable<T>) {
  let value: T | undefined;
  subscriptions.push(source.subscribe(v => (value = v)));
  return {
    get value() {
      return value as T;
    },
  };
}

afterEach(() => {
  subscriptions.splice(0).forEach(s => s.unsubscribe());
  vi.useRealTimers();
});

/** [kind, date or docId, block ids] per group, for compact assertions. */
const shape = (groups: TaskGroup[]) =>
  groups.map(g => [
    g.kind,
    g.date ?? g.docId ?? '',
    g.rows.map(r => r.blockId),
  ]);

const viewOf = (
  env: ReturnType<typeof setup>,
  viewId: Parameters<TasksService['view$']>[0]
) => watch(env.service.view$(viewId));

describe('TasksService view membership', () => {
  it('only lists todo list blocks', () => {
    const env = setup({
      tasks: [
        { blockId: 't1' },
        { blockId: 'bullet', listType: 'bulleted' },
        { blockId: 'numbered', listType: 'numbered' },
      ],
    });
    expect(shape(viewOf(env, 'all').value)).toEqual([['inbox', '', ['t1']]]);
  });

  it('queries every list block, unpaginated', () => {
    const env = setup();
    viewOf(env, 'inbox');
    expect(env.indexer.search$).toHaveBeenCalledTimes(1);
    const [table, query, options] = env.indexer.search$.mock
      .calls[0] as unknown as [string, unknown, { pagination: unknown }];
    expect(table).toBe('block');
    expect(query).toEqual({
      type: 'match',
      field: 'flavour',
      match: 'affine:list',
    });
    expect(options.pagination).toMatchObject({ limit: Infinity });
  });

  it('Inbox holds undated, unprioritised tasks only', () => {
    const env = setup({
      tasks: [
        { blockId: 'plain' },
        { blockId: 'dated', due: '2026-10-30' },
        { blockId: 'prio', priority: 2 },
      ],
    });
    expect(shape(viewOf(env, 'inbox').value)).toEqual([
      ['doc', 'doc-a', ['plain']],
    ]);
  });

  it('Today shows overdue first, then today, and nothing later', () => {
    const env = setup({
      tasks: [
        { blockId: 'late', due: '2026-10-25' },
        { blockId: 'later', due: '2026-10-27' },
        { blockId: 'now', due: '2026-10-28' },
        { blockId: 'tomorrow', due: '2026-10-29' },
        { blockId: 'nodate' },
      ],
    });
    const groups = viewOf(env, 'today').value;
    expect(shape(groups)).toEqual([
      ['overdue', '', ['late', 'later']],
      ['day', '2026-10-28', ['now']],
    ]);
    expect(groups[0].rows.every(r => r.overdue)).toBe(true);
    expect(groups[1].rows[0].overdue).toBe(false);
  });

  it('Tomorrow shows only tasks due the next day', () => {
    const env = setup({
      tasks: [
        { blockId: 'now', due: '2026-10-28' },
        { blockId: 'tmrw', due: '2026-10-29' },
        { blockId: 'later', due: '2026-10-30' },
        { blockId: 'late', due: '2026-10-27' },
      ],
    });
    expect(shape(viewOf(env, 'tomorrow').value)).toEqual([
      ['day', '2026-10-29', ['tmrw']],
    ]);
  });

  it('Next 7 Days covers overdue through today+6, grouped by day', () => {
    const env = setup({
      tasks: [
        { blockId: 'late', due: '2026-10-20' },
        { blockId: 'd0', due: '2026-10-28' },
        { blockId: 'd3', due: '2026-10-31' },
        { blockId: 'd6', due: '2026-11-03' },
        { blockId: 'd7', due: '2026-11-04' },
      ],
    });
    expect(shape(viewOf(env, 'next7').value)).toEqual([
      ['overdue', '', ['late']],
      ['day', '2026-10-28', ['d0']],
      ['day', '2026-10-31', ['d3']],
      ['day', '2026-11-03', ['d6']],
    ]);
  });

  it('All splits Scheduled, No date and Inbox', () => {
    const env = setup({
      tasks: [
        { blockId: 'inbox' },
        { blockId: 'prio', priority: 3 },
        { blockId: 'far', due: '2026-12-01' },
        { blockId: 'late', due: '2026-10-01' },
      ],
    });
    expect(shape(viewOf(env, 'all').value)).toEqual([
      ['scheduled', '', ['late', 'far']],
      ['no-date', '', ['prio']],
      ['inbox', '', ['inbox']],
    ]);
  });

  it('a task with only a priority is in All and No date but not Inbox', () => {
    const env = setup({ tasks: [{ blockId: 'prio', priority: 1 }] });
    expect(viewOf(env, 'inbox').value).toEqual([]);
    expect(shape(viewOf(env, 'all').value)).toEqual([
      ['no-date', '', ['prio']],
    ]);
  });

  it('ignores an out-of-range priority and a malformed due date', () => {
    const env = setup({
      tasks: [{ blockId: 'odd', priority: 9, due: 'tomorrow' }],
    });
    expect(shape(viewOf(env, 'inbox').value)).toEqual([
      ['doc', 'doc-a', ['odd']],
    ]);
  });

  it('exposes the row fields', () => {
    const env = setup({
      tasks: [
        {
          blockId: 't1',
          title: 'Call bank',
          due: '2026-10-28',
          priority: 3,
          heading: 'Follow ups',
        },
      ],
      docs: [{ id: 'doc-a', title: 'Kickoff' }],
    });
    expect(viewOf(env, 'today').value[0].rows[0]).toEqual({
      id: 'doc-a:t1',
      docId: 'doc-a',
      blockId: 't1',
      title: 'Call bank',
      due: '2026-10-28',
      priority: 3,
      checked: false,
      completedAt: null,
      docTitle: 'Kickoff',
      heading: 'Follow ups',
      overdue: false,
      quickAdd: false,
    });
  });
});

describe('TasksService midnight edges', () => {
  const tasks: TaskSpec[] = [
    { blockId: 'yesterday', due: '2026-10-27' },
    { blockId: 'today', due: '2026-10-28' },
  ];

  it('at 23:59 a task due that day is due today, not overdue', () => {
    const env = setup({ now: at(2026, 10, 28, 23, 59), tasks });
    expect(shape(viewOf(env, 'today').value)).toEqual([
      ['overdue', '', ['yesterday']],
      ['day', '2026-10-28', ['today']],
    ]);
  });

  it('at 00:00 the previous day is overdue and the new day is today', () => {
    const env = setup({ now: at(2026, 10, 29, 0, 0), tasks });
    expect(shape(viewOf(env, 'today').value)).toEqual([
      ['overdue', '', ['yesterday', 'today']],
    ]);
    expect(shape(viewOf(env, 'tomorrow').value)).toEqual([]);
  });

  it('at 00:00 what was due tomorrow becomes due today', () => {
    const env = setup({
      now: at(2026, 10, 29, 0, 0),
      tasks: [{ blockId: 't', due: '2026-10-29' }],
    });
    expect(shape(viewOf(env, 'today').value)).toEqual([
      ['day', '2026-10-29', ['t']],
    ]);
  });

  it('rolls over at local midnight while the view is open', () => {
    vi.useFakeTimers();
    let now = at(2026, 10, 28, 23, 59);
    vi.setSystemTime(now);
    const env = setup({ now, tasks: [{ blockId: 't', due: '2026-10-28' }] });
    env.clock.now.mockImplementation(() => Date.now());
    const today = viewOf(env, 'today');
    expect(shape(today.value)).toEqual([['day', '2026-10-28', ['t']]]);

    now = at(2026, 10, 29, 0, 1);
    vi.setSystemTime(now);
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(shape(today.value)).toEqual([['overdue', '', ['t']]]);
  });
});

describe('TasksService completed tasks', () => {
  it('keeps a task due today crossed off below the open ones', () => {
    const env = setup({
      tasks: [
        {
          blockId: 'done',
          due: '2026-10-28',
          checked: true,
          completedAt: NOON,
        },
        { blockId: 'open', due: '2026-10-28' },
      ],
    });
    const groups = viewOf(env, 'today').value;
    expect(shape(groups)).toEqual([['day', '2026-10-28', ['open', 'done']]]);
    const done = groups[0].rows[1];
    expect(done.checked).toBe(true);
    expect(done.overdue).toBe(false);
    expect(done.completedAt).toBe(NOON);
  });

  it('keeps a task due in the future visible while checked', () => {
    const env = setup({
      tasks: [
        {
          blockId: 'done',
          due: '2026-10-29',
          checked: true,
          completedAt: NOON,
        },
      ],
    });
    expect(shape(viewOf(env, 'tomorrow').value)).toEqual([
      ['day', '2026-10-29', ['done']],
    ]);
  });

  it('hides a checked task once its due date has passed, never overdue', () => {
    const env = setup({
      tasks: [
        {
          blockId: 'done',
          due: '2026-10-27',
          checked: true,
          completedAt: at(2026, 10, 27, 9),
        },
      ],
    });
    expect(viewOf(env, 'today').value).toEqual([]);
    expect(viewOf(env, 'next7').value).toEqual([]);
    expect(viewOf(env, 'all').value).toEqual([]);
    expect(shape(viewOf(env, 'completed').value)).toEqual([
      ['completed-day', '2026-10-27', ['done']],
    ]);
  });

  it('keeps an undated completed task in Inbox until the end of its day', () => {
    const tasks: TaskSpec[] = [
      {
        blockId: 'done',
        checked: true,
        completedAt: at(2026, 10, 27, 18, 0),
      },
    ];
    const lateEvening = setup({ now: at(2026, 10, 27, 23, 59), tasks });
    expect(shape(viewOf(lateEvening, 'inbox').value)).toEqual([
      ['doc', 'doc-a', ['done']],
    ]);
    const nextMorning = setup({ now: at(2026, 10, 28, 0, 0), tasks });
    expect(viewOf(nextMorning, 'inbox').value).toEqual([]);
    expect(shape(viewOf(nextMorning, 'completed').value)).toEqual([
      ['completed-day', '2026-10-27', ['done']],
    ]);
  });

  it('falls back to the doc updated date when completedAt is missing', () => {
    const env = setup({
      tasks: [
        { docId: 'doc-a', blockId: 'fresh', checked: true },
        { docId: 'doc-b', blockId: 'stale', checked: true },
      ],
      docs: [
        { id: 'doc-a', updatedDate: at(2026, 10, 28, 8) },
        { id: 'doc-b', updatedDate: at(2026, 10, 20, 8) },
      ],
    });
    const inbox = viewOf(env, 'inbox').value;
    expect(inbox.flatMap(g => g.rows.map(r => r.blockId))).toEqual(['fresh']);
    expect(inbox[0].rows[0].completedAt).toBe(at(2026, 10, 28, 8));
    expect(shape(viewOf(env, 'completed').value)).toEqual([
      ['completed-day', '2026-10-28', ['fresh']],
      ['completed-day', '2026-10-20', ['stale']],
    ]);
  });

  it('prefers completedAt over the doc updated date', () => {
    const env = setup({
      tasks: [{ blockId: 't', checked: true, completedAt: at(2026, 10, 25) }],
      docs: [{ id: 'doc-a', updatedDate: at(2026, 10, 28) }],
    });
    expect(shape(viewOf(env, 'completed').value)).toEqual([
      ['completed-day', '2026-10-25', ['t']],
    ]);
  });

  it('ignores a stale completedAt on an unchecked task', () => {
    const env = setup({
      tasks: [
        { blockId: 't', due: '2026-10-28', completedAt: at(2026, 10, 1) },
      ],
    });
    expect(viewOf(env, 'completed').value).toEqual([]);
    expect(viewOf(env, 'today').value[0].rows[0].completedAt).toBeNull();
  });

  it('Completed lists newest first, grouped by completion day', () => {
    const env = setup({
      tasks: [
        { blockId: 'old', checked: true, completedAt: at(2026, 10, 20, 9) },
        { blockId: 'a', checked: true, completedAt: at(2026, 10, 28, 8) },
        { blockId: 'b', checked: true, completedAt: at(2026, 10, 28, 11) },
        { blockId: 'open' },
        {
          blockId: 'dated',
          checked: true,
          due: '2026-10-21',
          completedAt: at(2026, 10, 27, 10),
        },
      ],
    });
    const groups = viewOf(env, 'completed').value;
    expect(shape(groups)).toEqual([
      ['completed-day', '2026-10-28', ['b', 'a']],
      ['completed-day', '2026-10-27', ['dated']],
      ['completed-day', '2026-10-20', ['old']],
    ]);
    expect(groups[1].rows[0].due).toBe('2026-10-21');
  });

  it('puts a reopened task back into its normal view', () => {
    const env = setup({
      tasks: [
        { blockId: 't', due: '2026-10-28', checked: true, completedAt: NOON },
      ],
    });
    const today = viewOf(env, 'today');
    expect(today.value[0].rows[0].checked).toBe(true);
    env.rows$.next({ nodes: [node({ blockId: 't', due: '2026-10-28' })] });
    expect(today.value[0].rows[0].checked).toBe(false);
    expect(viewOf(env, 'completed').value).toEqual([]);
  });
});

describe('TasksService grouping and ordering', () => {
  it('groups Inbox by doc, newest created doc first', () => {
    const env = setup({
      tasks: [
        { docId: 'old', blockId: 'o1' },
        { docId: 'new', blockId: 'n1' },
        { docId: 'mid', blockId: 'm1' },
        { docId: 'new', blockId: 'n2' },
      ],
      docs: [
        {
          id: 'old',
          createDate: at(2026, 9, 1),
          updatedDate: at(2026, 10, 28),
        },
        { id: 'mid', createDate: at(2026, 10, 1) },
        {
          id: 'new',
          createDate: at(2026, 10, 20),
          updatedDate: at(2026, 10, 1),
        },
      ],
    });
    expect(shape(viewOf(env, 'inbox').value)).toEqual([
      ['doc', 'new', ['n1', 'n2']],
      ['doc', 'mid', ['m1']],
      ['doc', 'old', ['o1']],
    ]);
  });

  it('orders rows: open first, priority high to low, position, doc id', () => {
    const due = '2026-10-29';
    const env = setup({
      tasks: [
        { docId: 'doc-b', blockId: 'b-first', due, order: 0 },
        { docId: 'doc-a', blockId: 'a-first', due, order: 0 },
        { docId: 'doc-a', blockId: 'a-late', due, order: 9 },
        { docId: 'doc-a', blockId: 'a-low', due, order: 1, priority: 1 },
        { docId: 'doc-a', blockId: 'a-high', due, order: 5, priority: 3 },
        {
          docId: 'doc-a',
          blockId: 'a-done',
          due,
          order: 0,
          priority: 3,
          checked: true,
          completedAt: NOON,
        },
        { docId: 'doc-a', blockId: 'a-nopos', due },
      ],
    });
    expect(viewOf(env, 'tomorrow').value[0].rows.map(r => r.blockId)).toEqual([
      'a-high',
      'a-low',
      'a-first',
      'b-first',
      'a-late',
      'a-nopos',
      'a-done',
    ]);
  });

  it('exposes the source doc title and nearest heading on each row', () => {
    const env = setup({
      tasks: [{ blockId: 't', heading: 'Next steps' }],
      docs: [{ id: 'doc-a', title: 'Project Kickoff' }],
    });
    const row = viewOf(env, 'inbox').value[0].rows[0];
    expect(row.docTitle).toBe('Project Kickoff');
    expect(row.heading).toBe('Next steps');
  });
});

describe('TasksService doc filtering', () => {
  const tasks: TaskSpec[] = [
    { docId: 'live', blockId: 'live' },
    { docId: 'trashed', blockId: 'trashed' },
    { docId: 'template', blockId: 'template' },
    { docId: 'gone', blockId: 'gone' },
  ];
  const docs: DocSpec[] = [
    { id: 'live' },
    { id: 'trashed', trash: true },
    { id: 'template', isTemplate: true },
  ];

  it('leaves out tasks of trashed, template and unknown docs', () => {
    const env = setup({ tasks, docs });
    for (const view of ['inbox', 'all'] as const) {
      const ids = viewOf(env, view).value.flatMap(g =>
        g.rows.map(r => r.blockId)
      );
      expect(ids).toEqual(['live']);
    }
    expect(watch(env.service.counts$).value.inbox).toBe(1);
  });

  it('brings tasks back when a doc is restored from the trash', () => {
    const env = setup({ tasks, docs });
    const inbox = viewOf(env, 'inbox');
    env.docs$.next(env.docs$.value.map(d => ({ ...d, trash: false })));
    expect(inbox.value.flatMap(g => g.rows.map(r => r.blockId))).toEqual(
      expect.arrayContaining(['live', 'trashed'])
    );
  });

  it('hides completed tasks of trashed docs from Completed too', () => {
    const env = setup({
      tasks: [
        { docId: 'trashed', blockId: 'x', checked: true, completedAt: NOON },
      ],
      docs,
    });
    expect(viewOf(env, 'completed').value).toEqual([]);
  });
});

describe('TasksService counts', () => {
  it('counts unchecked tasks per view', () => {
    const env = setup({
      tasks: [
        { blockId: 'inbox1' },
        { blockId: 'inbox2' },
        { blockId: 'late', due: '2026-10-20' },
        { blockId: 'today', due: '2026-10-28' },
        { blockId: 'tmrw', due: '2026-10-29' },
        { blockId: 'd5', due: '2026-11-02' },
        { blockId: 'far', due: '2027-01-01' },
        { blockId: 'prio', priority: 2 },
        {
          blockId: 'done',
          due: '2026-10-28',
          checked: true,
          completedAt: NOON,
        },
      ],
    });
    expect(watch(env.service.counts$).value).toEqual({
      inbox: 2,
      today: 2,
      tomorrow: 1,
      next7: 4,
      all: 8,
      completed: 1,
    });
    expect(watch(env.service.inboxCount$).value).toBe(2);
  });
});

describe('TasksService triage', () => {
  const blocks = {
    'doc-a:t1': { type: 'todo', checked: false },
    'doc-a:t2': {
      type: 'todo',
      checked: false,
      due: '2026-10-30',
      priority: 2,
    },
  };

  it('setDue writes the due date to the source doc and releases it', async () => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    await env.service.setDue('doc-a:t1', '2026-10-29');
    expect(env.props('doc-a:t1')?.due).toBe('2026-10-29');
    expect(env.opened).toEqual(['doc-a']);
    expect(env.released).toEqual(['doc-a']);
  });

  it('moves a task out of Inbox and updates counts straight away', async () => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    const inbox = viewOf(env, 'inbox');
    const tomorrow = viewOf(env, 'tomorrow');
    const counts = watch(env.service.counts$);
    expect(counts.value.inbox).toBe(1);

    const pending = env.service.setDue('doc-a:t1', '2026-10-29');
    // before the write finished and before the index caught up
    expect(inbox.value).toEqual([]);
    expect(shape(tomorrow.value)).toEqual([['day', '2026-10-29', ['t1']]]);
    expect(counts.value.inbox).toBe(0);
    expect(counts.value.tomorrow).toBe(1);
    await pending;
  });

  it('a priority alone also leaves Inbox', async () => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    const inbox = viewOf(env, 'inbox');
    const all = viewOf(env, 'all');
    await env.service.setPriority('doc-a:t1', 3);
    expect(inbox.value).toEqual([]);
    expect(shape(all.value)).toEqual([['no-date', '', ['t1']]]);
    expect(env.props('doc-a:t1')?.priority).toBe(3);
  });

  it('clearing the due date removes the prop from the block', async () => {
    const env = setup({
      tasks: [{ blockId: 't2', due: '2026-10-30', priority: 2 }],
      blocks,
    });
    await env.service.setDue('doc-a:t2', null);
    expect('due' in (env.props('doc-a:t2') ?? {})).toBe(false);
    expect(env.props('doc-a:t2')?.priority).toBe(2);
  });

  it('clearing the priority removes the prop from the block', async () => {
    const env = setup({
      tasks: [{ blockId: 't2', due: '2026-10-30', priority: 2 }],
      blocks,
    });
    await env.service.setPriority('doc-a:t2', null);
    expect('priority' in (env.props('doc-a:t2') ?? {})).toBe(false);
    expect(env.props('doc-a:t2')?.due).toBe('2026-10-30');

    await env.service.setPriority('doc-a:t2', 0);
    expect('priority' in (env.props('doc-a:t2') ?? {})).toBe(false);
  });

  it('shows a cleared date in the views at once', async () => {
    const env = setup({
      tasks: [{ blockId: 't2', due: '2026-10-30' }],
      blocks,
    });
    const inbox = viewOf(env, 'inbox');
    expect(inbox.value).toEqual([]);
    await env.service.setDue('doc-a:t2', null);
    expect(shape(inbox.value)).toEqual([['doc', 'doc-a', ['t2']]]);
  });

  it('drops the overlay once the index reflects the change', async () => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    const tomorrow = viewOf(env, 'tomorrow');
    await env.service.setDue('doc-a:t1', '2026-10-29');

    // the index catches up
    env.rows$.next({
      nodes: [node({ blockId: 't1', due: '2026-10-29' })],
    });
    await flush();
    expect(shape(tomorrow.value)).toEqual([['day', '2026-10-29', ['t1']]]);

    // another device moves it: the stale optimistic value must not win
    env.rows$.next({
      nodes: [node({ blockId: 't1', due: '2026-11-01' })],
    });
    expect(tomorrow.value).toEqual([]);
    expect(shape(viewOf(env, 'next7').value)).toEqual([
      ['day', '2026-11-01', ['t1']],
    ]);
  });

  it('drops the overlay after a timeout if the index never catches up', async () => {
    vi.useFakeTimers();
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    const inbox = viewOf(env, 'inbox');
    await env.service.setDue('doc-a:t1', '2026-10-29');
    expect(inbox.value).toEqual([]);
    vi.advanceTimersByTime(61_000);
    expect(shape(inbox.value)).toEqual([['doc', 'doc-a', ['t1']]]);
  });

  it('keeps the change on screen while a slow index catches up', async () => {
    vi.useFakeTimers();
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    const inbox = viewOf(env, 'inbox');
    const tomorrow = viewOf(env, 'tomorrow');
    await env.service.setDue('doc-a:t1', '2026-10-29');

    vi.advanceTimersByTime(30_000);
    expect(inbox.value).toEqual([]);
    expect(shape(tomorrow.value)).toEqual([['day', '2026-10-29', ['t1']]]);

    env.index([{ blockId: 't1', due: '2026-10-29' }]);
    await flush();
    expect(shape(tomorrow.value)).toEqual([['day', '2026-10-29', ['t1']]]);
  });

  it('rejects, and shows nothing, for a task in a trashed doc', async () => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    const inbox = viewOf(env, 'inbox');
    env.docs$.next(env.docs$.value.map(d => ({ ...d, trash: true })));
    await expect(env.service.setDue('doc-a:t1', '2026-10-29')).rejects.toThrow(
      /trashed or missing/
    );
    await expect(env.service.toggle('doc-a:t1')).rejects.toThrow();
    expect(env.opened).toEqual([]);
    expect(env.props('doc-a:t1')).toEqual({ type: 'todo', checked: false });
    expect(inbox.value).toEqual([]);
  });

  it('rejects for a doc that no longer exists', async () => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    env.docs$.next([]);
    await expect(env.service.setPriority('doc-a:t1', 3)).rejects.toThrow();
    expect(env.opened).toEqual([]);
  });

  it('a failed write drops only its own patch keys', async () => {
    const env = setup({
      tasks: [{ blockId: 't1' }],
      blocks: { 'doc-a:t1': { type: 'todo', checked: false } },
    });
    const all = viewOf(env, 'all');
    await env.service.setPriority('doc-a:t1', 3);
    // the doc is trashed before the second write runs
    env.docs$.next(env.docs$.value.map(d => ({ ...d, trash: true })));
    await expect(
      env.service.setDue('doc-a:t1', '2026-10-29')
    ).rejects.toThrow();
    env.docs$.next(env.docs$.value.map(d => ({ ...d, trash: false })));
    expect(shape(all.value)).toEqual([['no-date', '', ['t1']]]);
  });

  it('reverts the optimistic change when the write fails', async () => {
    const env = setup({ tasks: [{ blockId: 'missing' }], blocks });
    const inbox = viewOf(env, 'inbox');
    await expect(
      env.service.setDue('doc-a:missing', '2026-10-29')
    ).rejects.toThrow();
    expect(shape(inbox.value)).toEqual([['doc', 'doc-a', ['missing']]]);
    expect(env.released).toEqual(['doc-a']);
  });

  it('rejects a malformed due date without touching the doc', async () => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    await expect(env.service.setDue('doc-a:t1', 'tomorrow')).rejects.toThrow();
    expect(env.opened).toEqual([]);
  });
});

describe('TasksService undo', () => {
  const blocks = {
    'doc-a:t1': { type: 'todo', checked: false },
    'doc-a:t2': {
      type: 'todo',
      checked: false,
      due: '2026-10-30',
      priority: 2,
    },
  };

  it('restores an empty date and puts the task back in Inbox', async () => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    const inbox = viewOf(env, 'inbox');
    const token = await env.service.setDue('doc-a:t1', '2026-10-29');
    expect(inbox.value).toEqual([]);

    await expect(env.service.undo(token)).resolves.toBe(true);
    expect('due' in (env.props('doc-a:t1') ?? {})).toBe(false);
    expect(shape(inbox.value)).toEqual([['doc', 'doc-a', ['t1']]]);
  });

  it('restores the previous date and priority', async () => {
    const env = setup({
      tasks: [{ blockId: 't2', due: '2026-10-30', priority: 2 }],
      blocks,
    });
    await env.service.undo(await env.service.setDue('doc-a:t2', '2026-11-02'));
    expect(env.props('doc-a:t2')?.due).toBe('2026-10-30');

    await env.service.undo(await env.service.setPriority('doc-a:t2', 3));
    expect(env.props('doc-a:t2')?.priority).toBe(2);
  });

  it('restores a cleared date', async () => {
    const env = setup({
      tasks: [{ blockId: 't2', due: '2026-10-30' }],
      blocks,
    });
    await env.service.undo(await env.service.setDue('doc-a:t2', null));
    expect(env.props('doc-a:t2')?.due).toBe('2026-10-30');
  });

  it('undoes only the latest change, and only once', async () => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    const first = await env.service.setDue('doc-a:t1', '2026-10-29');
    const second = await env.service.setPriority('doc-a:t1', 3);

    // a stale toast can't revert anything
    await expect(env.service.undo(first)).resolves.toBe(false);
    expect(env.props('doc-a:t1')).toMatchObject({
      due: '2026-10-29',
      priority: 3,
    });

    await expect(env.service.undo(second)).resolves.toBe(true);
    expect(env.props('doc-a:t1')?.due).toBe('2026-10-29');
    expect('priority' in (env.props('doc-a:t1') ?? {})).toBe(false);
    await expect(env.service.undo(second)).resolves.toBe(false);
  });

  it('ignores a token from another task', async () => {
    const env = setup({
      tasks: [{ blockId: 't1' }, { blockId: 't2', due: '2026-10-30' }],
      blocks,
    });
    const first = await env.service.setDue('doc-a:t1', '2026-10-29');
    await env.service.setDue('doc-a:t2', '2026-11-05');
    await expect(env.service.undo(first)).resolves.toBe(false);
    expect(env.props('doc-a:t2')?.due).toBe('2026-11-05');
  });

  it('restores the earlier values even over an edit made in between', async () => {
    const env = setup({
      tasks: [{ blockId: 't2', due: '2026-10-30' }],
      blocks,
    });
    const token = await env.service.setDue('doc-a:t2', '2026-11-02');
    // edited in the doc meanwhile
    const props = env.props('doc-a:t2');
    if (props) props.due = '2026-12-24';
    await env.service.undo(token);
    expect(env.props('doc-a:t2')?.due).toBe('2026-10-30');
  });

  it('keeps the token valid when the undo write fails', async () => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    const token = await env.service.setDue('doc-a:t1', '2026-10-29');
    env.docs$.next(env.docs$.value.map(d => ({ ...d, trash: true })));
    await expect(env.service.undo(token)).rejects.toThrow();
    env.docs$.next(env.docs$.value.map(d => ({ ...d, trash: false })));
    await expect(env.service.undo(token)).resolves.toBe(true);
  });

  it('undoes a completion', async () => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    const inbox = viewOf(env, 'inbox');
    const counts = watch(env.service.counts$);
    const token = await env.service.toggle('doc-a:t1');
    expect(counts.value.inbox).toBe(0);
    await env.service.undo(token);
    expect(env.props('doc-a:t1')?.checked).toBe(false);
    expect('completedAt' in (env.props('doc-a:t1') ?? {})).toBe(false);
    expect(inbox.value[0].rows[0].checked).toBe(false);
    expect(counts.value.inbox).toBe(1);
  });

  it('does not flash the ticked state when undo beats a slow index', async () => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    const inbox = viewOf(env, 'inbox');
    const seen: boolean[] = [];
    subscriptions.push(
      env.service
        .view$('inbox')
        .subscribe(groups =>
          seen.push(...groups.flatMap(g => g.rows.map(r => r.checked)))
        )
    );

    const token = await env.service.toggle('doc-a:t1');
    await env.service.undo(token);
    await flush();
    seen.length = 0;

    // an idle tick with the stale (unticked) row must not end the overlay
    env.idle();
    await flush();
    // the index then delivers the delayed tick
    env.index([{ blockId: 't1', checked: true, completedAt: NOON }]);
    await flush();
    expect(seen).not.toContain(true);
    expect(inbox.value[0].rows[0].checked).toBe(false);

    // the index catches up with the undo; after an idle tick the overlay is
    // gone, so a change from another device shows
    env.busy();
    env.index([{ blockId: 't1' }]);
    env.idle();
    await flush();
    env.index([{ blockId: 't1', checked: true, completedAt: NOON }]);
    await flush();
    expect(inbox.value[0].rows[0].checked).toBe(true);
  });

  it('undoes un-ticking, restoring the original completion time', async () => {
    const done = at(2026, 10, 27, 15);
    const env = setup({
      tasks: [{ blockId: 't1', checked: true, completedAt: done }],
      blocks: {
        'doc-a:t1': { type: 'todo', checked: true, completedAt: done },
      },
    });
    const token = await env.service.toggle('doc-a:t1');
    expect(env.props('doc-a:t1')?.checked).toBe(false);
    await env.service.undo(token);
    expect(env.props('doc-a:t1')).toMatchObject({
      checked: true,
      completedAt: done,
    });
  });
});

describe('TasksService toggle', () => {
  it('ticks the source block and stamps the completion time', async () => {
    const env = setup({
      tasks: [{ blockId: 't1' }],
      blocks: { 'doc-a:t1': { type: 'todo', checked: false } },
    });
    watch(env.service.counts$);
    await env.service.toggle('doc-a:t1');
    expect(env.props('doc-a:t1')).toMatchObject({
      checked: true,
      completedAt: NOON,
    });
    expect(env.released).toEqual(['doc-a']);
  });

  it('unticking removes completedAt from the block', async () => {
    const env = setup({
      tasks: [{ blockId: 't1', checked: true, completedAt: NOON }],
      blocks: {
        'doc-a:t1': { type: 'todo', checked: true, completedAt: NOON },
      },
    });
    watch(env.service.counts$);
    await env.service.toggle('doc-a:t1');
    expect(env.props('doc-a:t1')?.checked).toBe(false);
    expect('completedAt' in (env.props('doc-a:t1') ?? {})).toBe(false);
  });

  it('crosses the row off in place and drops the counts at once', async () => {
    const env = setup({
      tasks: [
        { blockId: 't1', due: '2026-10-28' },
        { blockId: 't2', due: '2026-10-28' },
      ],
      blocks: {
        'doc-a:t1': { type: 'todo', checked: false, due: '2026-10-28' },
      },
    });
    const today = viewOf(env, 'today');
    const completed = viewOf(env, 'completed');
    const counts = watch(env.service.counts$);
    expect(counts.value.today).toBe(2);

    const pending = env.service.toggle('doc-a:t1');
    expect(counts.value.today).toBe(1);
    expect(counts.value.completed).toBe(1);
    expect(shape(today.value)).toEqual([['day', '2026-10-28', ['t2', 't1']]]);
    expect(today.value[0].rows[1]).toMatchObject({
      checked: true,
      completedAt: NOON,
    });
    expect(shape(completed.value)).toEqual([
      ['completed-day', '2026-10-28', ['t1']],
    ]);
    await pending;
  });

  it('reopens a completed task in its normal view', async () => {
    const env = setup({
      tasks: [
        { blockId: 't1', due: '2026-10-28', checked: true, completedAt: NOON },
      ],
      blocks: {
        'doc-a:t1': {
          type: 'todo',
          checked: true,
          due: '2026-10-28',
          completedAt: NOON,
        },
      },
    });
    const today = viewOf(env, 'today');
    const counts = watch(env.service.counts$);
    expect(counts.value.today).toBe(0);
    await env.service.toggle('doc-a:t1');
    expect(counts.value.today).toBe(1);
    expect(today.value[0].rows[0].checked).toBe(false);
  });

  it('ticks a task whose row is not in the index yet', async () => {
    const env = setup({
      blocks: { 'doc-a:fresh': { type: 'todo', checked: false } },
    });
    await env.service.toggle('doc-a:fresh');
    expect(env.props('doc-a:fresh')?.checked).toBe(true);
  });
});

describe('TasksService state', () => {
  it('is loading until the first result and a finished index pass', () => {
    const env = setup({ indexerState: { completed: false, indexing: 3 } });
    const state = watch(env.service.state$);
    expect(state.value).toEqual({ status: 'loading' });
    env.indexerState$.next({ ...env.indexerState$.value, completed: true });
    expect(state.value).toEqual({ status: 'ready' });
  });

  it('stays loading while no query result has arrived', () => {
    const env = setup();
    const result = new Subject<never>();
    env.indexer.search$.mockReturnValue(result as never);
    env.service.retry();
    const state = watch(env.service.state$);
    expect(state.value).toEqual({ status: 'loading' });
  });

  it('stays ready when the indexer picks up a single edit afterwards', () => {
    const env = setup();
    const state = watch(env.service.state$);
    expect(state.value).toEqual({ status: 'ready' });
    env.indexerState$.next({
      ...env.indexerState$.value,
      completed: false,
      indexing: 1,
    });
    expect(state.value).toEqual({ status: 'ready' });
  });

  it('reports an indexer error and recovers', () => {
    const env = setup();
    const state = watch(env.service.state$);
    env.indexerState$.next({
      ...env.indexerState$.value,
      errorMessage: 'disk full',
    });
    expect(state.value).toEqual({ status: 'error', message: 'disk full' });
    env.indexerState$.next({ ...env.indexerState$.value, errorMessage: null });
    expect(state.value).toEqual({ status: 'ready' });
  });

  it('reports a failed query and retries it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = setup();
    env.indexer.search$.mockReturnValueOnce(
      throwError(() => new Error('query failed')) as never
    );
    env.service.retry();
    const state = watch(env.service.state$);
    const inbox = viewOf(env, 'inbox');
    expect(state.value).toEqual({ status: 'error', message: 'query failed' });

    env.rows$.next({ nodes: [node({ blockId: 't1' })] });
    env.service.retry();
    expect(state.value).toEqual({ status: 'ready' });
    expect(shape(inbox.value)).toEqual([['doc', 'doc-a', ['t1']]]);
  });
});

describe('TasksService inbox badge', () => {
  it('inboxCount$ follows triage and the index', async () => {
    const env = setup({
      tasks: [
        { blockId: 't1' },
        { blockId: 't2' },
        { blockId: 't3', due: '2026-10-30' },
      ],
      blocks: {
        'doc-a:t1': { type: 'todo', checked: false },
        'doc-a:t2': { type: 'todo', checked: false },
      },
    });
    const badge = watch(env.service.inboxCount$);
    expect(badge.value).toBe(2);
    await env.service.setPriority('doc-a:t1', 2);
    expect(badge.value).toBe(1);
    env.index([{ blockId: 't1', priority: 2 }]);
    await flush();
    expect(badge.value).toBe(0);
  });
});

describe('TasksService typing in a doc', () => {
  it('does not change the views when only updated dates move', () => {
    const env = setup({
      tasks: [{ blockId: 't1' }, { blockId: 't2', due: '2026-10-28' }],
    });
    const emissions: unknown[] = [];
    for (const id of ['inbox', 'today', 'all'] as const) {
      subscriptions.push(
        env.service.view$(id).subscribe(groups => emissions.push(groups))
      );
    }
    subscriptions.push(
      env.service.counts$.subscribe(counts => emissions.push(counts))
    );
    const before = emissions.length;
    for (let i = 1; i <= 3; i++) {
      env.docs$.next(
        env.docs$.value.map(d => ({ ...d, updatedDate: NOON + i * 1000 }))
      );
    }
    expect(emissions.length).toBe(before);
  });

  it('still follows the updated date for a checked task without completedAt', () => {
    const env = setup({
      tasks: [{ blockId: 't1', checked: true }],
      docs: [{ id: 'doc-a', updatedDate: at(2026, 10, 28, 8) }],
    });
    const inbox = viewOf(env, 'inbox');
    expect(inbox.value[0].rows[0].completedAt).toBe(at(2026, 10, 28, 8));
    env.docs$.next([{ id: 'doc-a', updatedDate: at(2026, 10, 28, 9) }]);
    expect(inbox.value[0].rows[0].completedAt).toBe(at(2026, 10, 28, 9));
  });
});

describe('TasksService wake-up', () => {
  it('re-reads the day when the page becomes visible again', () => {
    let now = at(2026, 10, 28, 23, 0);
    const env = setup({ tasks: [{ blockId: 't', due: '2026-10-28' }] });
    env.clock.now.mockImplementation(() => now);
    const today = viewOf(env, 'today');
    expect(shape(today.value)).toEqual([['day', '2026-10-28', ['t']]]);

    now = at(2026, 10, 29, 7, 0); // the machine slept through midnight
    document.dispatchEvent(new Event('visibilitychange'));
    expect(shape(today.value)).toEqual([['overdue', '', ['t']]]);
  });
});
