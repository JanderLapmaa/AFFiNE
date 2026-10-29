/** @vitest-environment happy-dom */

import { Framework } from '@toeverything/infra';
import {
  BehaviorSubject,
  map,
  type Observable,
  type Subscription,
  throwError,
} from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocsService } from '../../doc/services/docs';
import { WorkspaceService } from '../../workspace';
import { TasksService } from '../services/tasks';
import { TasksClockStore } from '../services/tasks-clock';
import type { TaskGroup, TasksViewId } from '../types';

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

type FakeNode = ReturnType<typeof node>;
interface FakeQuery {
  type: string;
  field?: string;
  match?: string;
  queries?: FakeQuery[];
  occur?: string;
}
interface FakeSearchOptions {
  pagination?: { skip?: number; limit?: number };
}

const matches = (q: FakeQuery, n: FakeNode): boolean => {
  if (q.type === 'match') {
    return q.field === 'docId' ? n.fields.docId === q.match : true;
  }
  const subs = q.queries ?? [];
  return q.occur === 'should'
    ? subs.some(sub => matches(sub, n))
    : subs.every(sub => matches(sub, n));
};

/** An indexer that, like the native one, refuses windows over 10000 hits. */
function fakeSearch(
  nodes: FakeNode[],
  query: FakeQuery,
  options: FakeSearchOptions
) {
  const { skip = 0, limit = 10 } = options.pagination ?? {};
  if (limit > 10_000 || skip + limit > 10_000) {
    throw new Error('search window exceeds 10000');
  }
  const hits = nodes.filter(n => matches(query, n));
  return {
    nodes: hits.slice(skip, skip + limit),
    pagination: {
      count: hits.length,
      limit,
      skip,
      hasMore: hits.length > skip + limit,
    },
  };
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
    waitForDocCompleted: vi.fn(async (_docId: string) => {}),
    search$: vi.fn(
      (_table: string, query: FakeQuery, opts: FakeSearchOptions) =>
        rows$.pipe(map(({ nodes }) => fakeSearch(nodes, query, opts)))
    ),
    search: vi.fn(
      async (_table: string, query: FakeQuery, opts: FakeSearchOptions) =>
        fakeSearch(rows$.value.nodes, query, opts)
    ),
    aggregate: vi.fn(async () => {
      const counts = new Map<string, number>();
      for (const n of rows$.value.nodes) {
        counts.set(n.fields.docId, (counts.get(n.fields.docId) ?? 0) + 1);
      }
      return {
        buckets: [...counts].map(([key, count]) => ({ key, count, score: 1 })),
      };
    }),
  };

  const models = new Map<
    string,
    { flavour: string; props: Record<string, unknown> }
  >();
  for (const [key, props] of Object.entries(options.blocks ?? {})) {
    models.set(key, { flavour: 'affine:list', props: { ...props } });
  }
  const opened: string[] = [];
  const released: string[] = [];
  const docs$ = new BehaviorSubject<DocSpec[]>(
    options.docs ?? [
      { id: 'doc-a', title: 'Doc A' },
      { id: 'doc-b', title: 'Doc B' },
    ]
  );
  const records = new Set(docs$.value.map(d => d.id));
  const docsService = {
    allTrashDocIds$: () =>
      docs$.pipe(map(docs => docs.filter(d => d.trash).map(d => d.id))),
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
      // Records come from their own list, so a gap in the streams below
      // doesn't remove them.
      doc$: (id: string) => ({
        get value() {
          if (!records.has(id)) return undefined;
          const doc = docs$.value.find(d => d.id === id);
          return { trash$: { value: !!doc?.trash } };
        },
      }),
    },
    open: vi.fn((docId: string) => {
      opened.push(docId);
      // `updateBlock` skips `undefined` like the real store.
      const store = {
        readonly: false,
        transact: (fn: () => void) => fn(),
        updateBlock: (
          model: { props: Record<string, unknown> },
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
  return {
    service: framework.provider().get(TasksService),
    clock,
    rows$,
    indexer,
    indexerState$,
    docs$,
    opened,
    released,
    /** the index catches up with the given tasks */
    index: (tasks: TaskSpec[]) => rows$.next({ nodes: tasks.map(node) }),
    setIndexing: (busy: boolean) =>
      indexerState$.next({
        ...indexerState$.value,
        completed: !busy,
        indexing: busy ? 1 : 0,
      }),
    deleteDocs: () => records.clear(),
    trashAll: (trash: boolean) =>
      docs$.next(docs$.value.map(d => ({ ...d, trash }))),
    props: (key: string) => models.get(key)?.props,
  };
}

type Env = ReturnType<typeof setup>;

/** Lets scheduled (microtask) work run. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
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

const viewOf = (env: Env, viewId: TasksViewId) =>
  watch(env.service.view$(viewId));

const blockIds = (groups: TaskGroup[]) =>
  groups.flatMap(g => g.rows.map(r => r.blockId));

type Expected = ReturnType<typeof shape>;

describe('view membership and grouping', () => {
  const D27 = '2026-10-27';
  const D28 = '2026-10-28';
  const D29 = '2026-10-29';

  it.each<[string, TasksViewId, TaskSpec[], Expected]>([
    [
      'only todo list blocks are listed',
      'all',
      [
        { blockId: 't1' },
        { blockId: 'bullet', listType: 'bulleted' },
        { blockId: 'numbered', listType: 'numbered' },
      ],
      [['inbox', '', ['t1']]],
    ],
    [
      'Inbox is every undated task, a priority alone keeps it there',
      'inbox',
      [
        { blockId: 'plain' },
        { blockId: 'dated', due: D29 },
        { blockId: 'prio', priority: 2 },
      ],
      [['doc', 'doc-a', ['prio', 'plain']]],
    ],
    [
      'an out-of-range priority and a malformed date are ignored',
      'inbox',
      [{ blockId: 'odd', priority: 9, due: 'tomorrow' }],
      [['doc', 'doc-a', ['odd']]],
    ],
    [
      'Today: overdue first, then today, nothing later or undated',
      'today',
      [
        { blockId: 'late', due: '2026-10-25' },
        { blockId: 'later', due: D27 },
        { blockId: 'now', due: D28 },
        { blockId: 'tomorrow', due: D29 },
        { blockId: 'nodate' },
      ],
      [
        ['overdue', '', ['late', 'later']],
        ['day', D28, ['now']],
      ],
    ],
    [
      'Tomorrow: only the next day',
      'tomorrow',
      [
        { blockId: 'now', due: D28 },
        { blockId: 'tmrw', due: D29 },
        { blockId: 'later', due: '2026-10-30' },
        { blockId: 'late', due: D27 },
      ],
      [['day', D29, ['tmrw']]],
    ],
    [
      'Next 7 Days: overdue through today+6, grouped by day',
      'next7',
      [
        { blockId: 'late', due: '2026-10-20' },
        { blockId: 'd0', due: D28 },
        { blockId: 'd3', due: '2026-10-31' },
        { blockId: 'd6', due: '2026-11-03' },
        { blockId: 'd7', due: '2026-11-04' },
      ],
      [
        ['overdue', '', ['late']],
        ['day', D28, ['d0']],
        ['day', '2026-10-31', ['d3']],
        ['day', '2026-11-03', ['d6']],
      ],
    ],
    [
      'All: Scheduled by date, then the Inbox',
      'all',
      [
        { blockId: 'inbox' },
        { blockId: 'prio', priority: 3 },
        { blockId: 'far', due: '2026-12-01' },
        { blockId: 'late', due: '2026-10-01' },
      ],
      [
        ['scheduled', '', ['late', 'far']],
        ['inbox', '', ['inbox', 'prio']],
      ],
    ],
  ])('%s', (_name, view, tasks, expected) => {
    expect(shape(viewOf(setup({ tasks }), view).value)).toEqual(expected);
  });

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
        { id: 'new', createDate: at(2026, 10, 20) },
      ],
    });
    expect(shape(viewOf(env, 'inbox').value)).toEqual([
      ['doc', 'new', ['n1', 'n2']],
      ['doc', 'mid', ['m1']],
      ['doc', 'old', ['o1']],
    ]);
  });

  it('orders rows: open first, priority high to low, position, doc id', () => {
    const due = D29;
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
    expect(blockIds(viewOf(env, 'tomorrow').value)).toEqual([
      'a-high',
      'a-low',
      'a-first',
      'b-first',
      'a-late',
      'a-nopos',
      'a-done',
    ]);
  });

  it('counts unchecked tasks per view', () => {
    const env = setup({
      tasks: [
        { blockId: 'inbox1' },
        { blockId: 'prio', priority: 2 },
        { blockId: 'late', due: '2026-10-20' },
        { blockId: 'today', due: D28 },
        { blockId: 'tmrw', due: D29 },
        { blockId: 'd5', due: '2026-11-02' },
        { blockId: 'far', due: '2027-01-01' },
        { blockId: 'done', due: D28, checked: true, completedAt: NOON },
      ],
    });
    expect(watch(env.service.counts$).value).toEqual({
      inbox: 2,
      today: 2,
      tomorrow: 1,
      next7: 4,
      all: 7,
      completed: 1,
    });
    expect(watch(env.service.inboxCount$).value).toBe(2);
  });
});

describe('midnight edges', () => {
  it.each<[string, number, TasksViewId, TaskSpec[], Expected]>([
    [
      '23:59: a task due that day is due today, not overdue',
      at(2026, 10, 28, 23, 59),
      'today',
      [
        { blockId: 'yesterday', due: '2026-10-27' },
        { blockId: 'today', due: '2026-10-28' },
      ],
      [
        ['overdue', '', ['yesterday']],
        ['day', '2026-10-28', ['today']],
      ],
    ],
    [
      '00:00: the previous day is overdue',
      at(2026, 10, 29, 0, 0),
      'today',
      [
        { blockId: 'yesterday', due: '2026-10-27' },
        { blockId: 'today', due: '2026-10-28' },
      ],
      [['overdue', '', ['yesterday', 'today']]],
    ],
    [
      '00:00: what was due tomorrow is due today',
      at(2026, 10, 29, 0, 0),
      'today',
      [{ blockId: 't', due: '2026-10-29' }],
      [['day', '2026-10-29', ['t']]],
    ],
    [
      '00:00: Tomorrow moves on a day',
      at(2026, 10, 29, 0, 0),
      'tomorrow',
      [{ blockId: 't', due: '2026-10-29' }],
      [],
    ],
  ])('%s', (_name, now, view, tasks, expected) => {
    expect(shape(viewOf(setup({ now, tasks }), view).value)).toEqual(expected);
  });

  it('rolls over at local midnight while the view is open', () => {
    vi.useFakeTimers();
    const now = at(2026, 10, 28, 23, 59);
    vi.setSystemTime(now);
    const env = setup({ now, tasks: [{ blockId: 't', due: '2026-10-28' }] });
    env.clock.now.mockImplementation(() => Date.now());
    const today = viewOf(env, 'today');
    expect(shape(today.value)).toEqual([['day', '2026-10-28', ['t']]]);

    vi.setSystemTime(at(2026, 10, 29, 0, 1));
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(shape(today.value)).toEqual([['overdue', '', ['t']]]);
  });
});

describe('completed tasks', () => {
  const done = (spec: TaskSpec): TaskSpec => ({
    checked: true,
    completedAt: NOON,
    ...spec,
  });

  it.each<[string, number | undefined, TaskSpec[], [TasksViewId, Expected][]]>([
    [
      'due today: stays crossed off below the open ones',
      undefined,
      [
        done({ blockId: 'done', due: '2026-10-28' }),
        { blockId: 'open', due: '2026-10-28' },
      ],
      [['today', [['day', '2026-10-28', ['open', 'done']]]]],
    ],
    [
      'due in the future: visible while checked',
      undefined,
      [done({ blockId: 'done', due: '2026-10-29' })],
      [['tomorrow', [['day', '2026-10-29', ['done']]]]],
    ],
    [
      'due date passed: hidden everywhere but Completed, never overdue',
      undefined,
      [
        done({
          blockId: 'done',
          due: '2026-10-27',
          completedAt: at(2026, 10, 27, 9),
        }),
      ],
      [
        ['today', []],
        ['next7', []],
        ['all', []],
        ['completed', [['completed-day', '2026-10-27', ['done']]]],
      ],
    ],
    [
      'undated: in Inbox until the end of its completion day',
      at(2026, 10, 27, 23, 59),
      [done({ blockId: 'done', completedAt: at(2026, 10, 27, 18) })],
      [['inbox', [['doc', 'doc-a', ['done']]]]],
    ],
    [
      'undated: gone from Inbox the next morning',
      at(2026, 10, 28, 0, 0),
      [done({ blockId: 'done', completedAt: at(2026, 10, 27, 18) })],
      [
        ['inbox', []],
        ['completed', [['completed-day', '2026-10-27', ['done']]]],
      ],
    ],
    [
      'a stale completedAt on an unchecked task is ignored',
      undefined,
      [{ blockId: 't', due: '2026-10-28', completedAt: at(2026, 10, 1) }],
      [['completed', []]],
    ],
  ])('%s', (_name, now, tasks, checks) => {
    const env = setup({ now, tasks });
    for (const [view, expected] of checks) {
      expect(shape(viewOf(env, view).value)).toEqual(expected);
    }
  });

  it('falls back to the doc updated date, but prefers completedAt', () => {
    const env = setup({
      tasks: [
        { docId: 'doc-a', blockId: 'fresh', checked: true },
        { docId: 'doc-b', blockId: 'stale', checked: true },
        done({ docId: 'doc-a', blockId: 'own', completedAt: at(2026, 10, 25) }),
      ],
      docs: [
        { id: 'doc-a', updatedDate: at(2026, 10, 28, 8) },
        { id: 'doc-b', updatedDate: at(2026, 10, 20, 8) },
      ],
    });
    expect(shape(viewOf(env, 'completed').value)).toEqual([
      ['completed-day', '2026-10-28', ['fresh']],
      ['completed-day', '2026-10-25', ['own']],
      ['completed-day', '2026-10-20', ['stale']],
    ]);
    expect(viewOf(env, 'inbox').value[0].rows[0].completedAt).toBe(
      at(2026, 10, 28, 8)
    );
  });
});

describe('doc filtering', () => {
  const tasks: TaskSpec[] = [
    { docId: 'live', blockId: 'live' },
    { docId: 'trashed', blockId: 'trashed' },
    { docId: 'template', blockId: 'template' },
    { docId: 'no-record', blockId: 'no-record' },
    { docId: 'trashed', blockId: 'x', checked: true, completedAt: NOON },
  ];
  const docs: DocSpec[] = [
    { id: 'live' },
    { id: 'trashed', trash: true },
    { id: 'template', isTemplate: true },
  ];

  it('leaves out trashed and template docs and docs without a record', () => {
    const env = setup({ tasks, docs });
    for (const view of ['inbox', 'all'] as const) {
      expect(blockIds(viewOf(env, view).value).sort()).toEqual(['live']);
    }
    expect(viewOf(env, 'completed').value).toEqual([]);
    expect(watch(env.service.counts$).value.inbox).toBe(1);
  });
});

describe('reading the index', () => {
  it('reads every task when they exceed one indexer window', async () => {
    const tasks: TaskSpec[] = [];
    for (let i = 0; i < 25_000; i++) {
      tasks.push({ docId: `doc-${i % 7}`, blockId: `t${i}` });
    }
    const docs = Array.from({ length: 7 }, (_, i) => ({ id: `doc-${i}` }));
    const env = setup({ tasks, docs });
    const all = viewOf(env, 'all');
    const state = watch(env.service.state$);
    await flush();
    expect(state.value).toEqual({ status: 'ready' });
    expect(new Set(blockIds(all.value)).size).toBe(25_000);
  });

  it('keeps the other docs when one doc is too big to read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tasks: TaskSpec[] = [{ docId: 'small', blockId: 's1' }];
      for (let i = 0; i < 10_500; i++) {
        tasks.push({ docId: 'huge', blockId: `h${i}` });
      }
      const env = setup({ tasks, docs: [{ id: 'small' }, { id: 'huge' }] });
      const all = viewOf(env, 'all');
      await new Promise(resolve => setTimeout(resolve, 20));
      const ids = blockIds(all.value);
      expect(ids).toContain('s1');
      expect(ids.length).toBeGreaterThan(1);
      expect(ids.length).toBeLessThan(10_501);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Inbox does not flash empty while the index or doc list churns', () => {
  const blocks = { 'doc-a:t1': { type: 'todo', checked: false } };

  /** Row counts of every emission of the Inbox view. */
  function recordInbox(env: Env) {
    const seen: number[] = [];
    subscriptions.push(
      env.service.view$('inbox').subscribe(g => seen.push(blockIds(g).length))
    );
    return seen;
  }

  it("keeps a doc's tasks while our write is re-indexed (delete, then insert)", async () => {
    const env = setup({
      tasks: [{ blockId: 't1' }, { blockId: 't2' }],
      blocks,
    });
    let indexed!: () => void;
    env.indexer.waitForDocCompleted.mockReturnValue(
      new Promise<void>(resolve => (indexed = resolve))
    );
    const seen = recordInbox(env);
    await env.service.setPriority('doc-a:t1', 2);
    env.index([]); // the doc's blocks are deleted...
    env.index([{ blockId: 't1', priority: 2 }]); // ...and inserted one by one
    env.index([{ blockId: 't1', priority: 2 }, { blockId: 't2' }]);
    indexed();
    await flush();
    expect(Math.min(...seen)).toBe(2);
  });

  it('stops holding the rows after 10 s', async () => {
    vi.useFakeTimers();
    const env = setup({
      tasks: [{ blockId: 't1' }, { blockId: 't2' }],
      blocks,
    });
    env.indexer.waitForDocCompleted.mockReturnValue(new Promise(() => {}));
    const inbox = viewOf(env, 'inbox');
    await env.service.setPriority('doc-a:t1', 2);
    env.index([{ blockId: 't1' }]);
    expect(blockIds(inbox.value)).toEqual(['t1', 't2']);
    vi.advanceTimersByTime(11_000);
    env.index([{ blockId: 't1' }]); // t2 really was deleted
    expect(blockIds(inbox.value)).toEqual(['t1']);
  });

  it('keeps tasks when the doc streams briefly report no docs', () => {
    const env = setup({ tasks: [{ blockId: 't1' }, { blockId: 't2' }] });
    const seen = recordInbox(env);
    const docs = env.docs$.value;
    env.docs$.next([]); // opening / releasing the doc for a write
    env.docs$.next(docs);
    expect(Math.min(...seen)).toBe(2);
  });
});

describe('triage', () => {
  const blocks = {
    'doc-a:t1': { type: 'todo', checked: false },
    'doc-a:t2': {
      type: 'todo',
      checked: false,
      due: '2026-10-30',
      priority: 2,
    },
  };
  const t2: TaskSpec = { blockId: 't2', due: '2026-10-30', priority: 2 };

  it('a date moves the task out of Inbox and updates counts at once', async () => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    const inbox = viewOf(env, 'inbox');
    const tomorrow = viewOf(env, 'tomorrow');
    const counts = watch(env.service.counts$);
    expect(counts.value.inbox).toBe(1);

    const pending = env.service.setDue('doc-a:t1', '2026-10-29');
    // before the write finished and before the index caught up
    expect(inbox.value).toEqual([]);
    expect(shape(tomorrow.value)).toEqual([['day', '2026-10-29', ['t1']]]);
    expect(counts.value).toMatchObject({ inbox: 0, tomorrow: 1 });
    await pending;
    expect(env.props('doc-a:t1')?.due).toBe('2026-10-29');
    expect(env.released).toEqual(['doc-a']);
  });

  it('a priority alone keeps the task in Inbox, on top', async () => {
    const env = setup({
      tasks: [{ blockId: 't1' }, { blockId: 't3' }],
      blocks: { ...blocks, 'doc-a:t3': { type: 'todo', checked: false } },
    });
    const inbox = viewOf(env, 'inbox');
    await env.service.setPriority('doc-a:t3', 3);
    expect(shape(inbox.value)).toEqual([['doc', 'doc-a', ['t3', 't1']]]);
    expect(env.props('doc-a:t3')?.priority).toBe(3);
  });

  it.each([
    ['setDue null', (s: TasksService) => s.setDue('doc-a:t2', null), 'due'],
    [
      'setPriority null',
      (s: TasksService) => s.setPriority('doc-a:t2', null),
      'priority',
    ],
    [
      'setPriority 0',
      (s: TasksService) => s.setPriority('doc-a:t2', 0),
      'priority',
    ],
  ])('%s removes the prop and shows it at once', async (_n, write, gone) => {
    const env = setup({ tasks: [t2], blocks });
    const inbox = viewOf(env, 'inbox');
    await write(env.service);
    expect(gone in (env.props('doc-a:t2') ?? {})).toBe(false);
    const kept = gone === 'due' ? 'priority' : 'due';
    expect(kept in (env.props('doc-a:t2') ?? {})).toBe(true);
    // a cleared date is back in Inbox; a cleared priority still has its date
    expect(blockIds(inbox.value)).toEqual(gone === 'due' ? ['t2'] : []);
  });

  it.each<[string, (env: Env) => Promise<unknown>]>([
    [
      'a trashed doc',
      env => {
        env.trashAll(true);
        return env.service.setDue('doc-a:t1', '2026-10-29');
      },
    ],
    [
      'toggling in a trashed doc',
      env => {
        env.trashAll(true);
        return env.service.toggle('doc-a:t1');
      },
    ],
    [
      'a doc without a record',
      env => {
        env.deleteDocs();
        return env.service.setPriority('doc-a:t1', 3);
      },
    ],
    ['a malformed date', env => env.service.setDue('doc-a:t1', 'tomorrow')],
  ])('rejects without touching the doc: %s', async (_name, run) => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    await expect(run(env)).rejects.toThrow();
    expect(env.opened).toEqual([]);
    expect(env.props('doc-a:t1')).toEqual({ type: 'todo', checked: false });
  });

  it('takes the optimistic change back when the write fails', async () => {
    const env = setup({ tasks: [{ blockId: 'missing' }], blocks });
    const inbox = viewOf(env, 'inbox');
    await expect(
      env.service.setDue('doc-a:missing', '2026-10-29')
    ).rejects.toThrow();
    expect(blockIds(inbox.value)).toEqual(['missing']);
    expect(env.released).toEqual(['doc-a']);
  });

  describe('optimistic overlay', () => {
    it('holds the change until the doc is indexed, then yields to the index', async () => {
      const env = setup({ tasks: [{ blockId: 't1' }], blocks });
      let indexed!: () => void;
      env.indexer.waitForDocCompleted.mockReturnValue(
        new Promise<void>(resolve => (indexed = resolve))
      );
      const tomorrow = viewOf(env, 'tomorrow');
      await env.service.setDue('doc-a:t1', '2026-10-29');

      env.index([{ blockId: 't1' }]); // a stale emission while indexing
      await flush();
      expect(blockIds(tomorrow.value)).toEqual(['t1']);

      indexed();
      await flush();
      expect(blockIds(tomorrow.value)).toEqual(['t1']); // waits for an emission

      // another device moves it: the optimistic value must not win
      env.index([{ blockId: 't1', due: '2026-11-01' }]);
      await flush();
      expect(tomorrow.value).toEqual([]);
      expect(blockIds(viewOf(env, 'next7').value)).toEqual(['t1']);
    });

    it('stops waiting for an indexer that never completes the doc', async () => {
      vi.useFakeTimers();
      const env = setup({ tasks: [{ blockId: 't1' }], blocks });
      env.indexer.waitForDocCompleted.mockReturnValue(new Promise(() => {}));
      const inbox = viewOf(env, 'inbox');
      await env.service.setDue('doc-a:t1', '2026-10-29');
      expect(inbox.value).toEqual([]);
      vi.advanceTimersByTime(11_000);
      await flush();
      env.index([{ blockId: 't1' }]);
      await flush();
      expect(blockIds(inbox.value)).toEqual(['t1']);
    });

    it('a failed write keeps an earlier write and still settles', async () => {
      const env = setup({ tasks: [{ blockId: 't1' }], blocks });
      const inbox = viewOf(env, 'inbox');
      await env.service.setPriority('doc-a:t1', 3);
      await flush();
      const failing = env.service.setDue('doc-a:t1', '2026-10-29');
      env.trashAll(true); // the write runs after this
      await expect(failing).rejects.toThrow();
      env.trashAll(false);
      expect(inbox.value[0].rows[0]).toMatchObject({ priority: 3, due: null });

      env.index([{ blockId: 't1' }]); // the entry settled: this drops it
      await flush();
      expect(inbox.value[0].rows[0].priority).toBe(0);
    });
  });
});

describe('undo', () => {
  const blocks = {
    'doc-a:t1': { type: 'todo', checked: false },
    'doc-a:t2': {
      type: 'todo',
      checked: false,
      due: '2026-10-30',
      priority: 2,
    },
  };
  const t2: TaskSpec = { blockId: 't2', due: '2026-10-30', priority: 2 };

  it.each<[string, string, string, 'due' | 'priority', unknown]>([
    ['an empty date', 't1', 'due:2026-10-29', 'due', undefined],
    ['the previous date', 't2', 'due:2026-11-02', 'due', '2026-10-30'],
    ['the previous priority', 't2', 'priority:3', 'priority', 2],
    ['a cleared date', 't2', 'due:null', 'due', '2026-10-30'],
  ])('restores %s', async (_name, block, change, key, expected) => {
    const env = setup({ tasks: [{ blockId: 't1' }, t2], blocks });
    const all = viewOf(env, 'all');
    const id = `doc-a:${block}`;
    const [prop, value] = change.split(':');
    const undo =
      prop === 'due'
        ? await env.service.setDue(id, value === 'null' ? null : value)
        : await env.service.setPriority(id, Number(value) as 3);
    await undo();
    expect(env.props(id)?.[key]).toBe(expected);
    expect(blockIds(all.value)).toContain(block);
  });

  it('rejects when the doc is trashed and works again once restored', async () => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    const undo = await env.service.setDue('doc-a:t1', '2026-10-29');
    env.trashAll(true);
    await expect(undo()).rejects.toThrow();
    env.trashAll(false);
    await undo();
    expect('due' in (env.props('doc-a:t1') ?? {})).toBe(false);
  });

  it('undoes a completion and an un-ticking, keeping the completion time', async () => {
    const doneAt = at(2026, 10, 28, 9);
    const env = setup({
      tasks: [
        { blockId: 't1' },
        { blockId: 't2', checked: true, completedAt: doneAt },
      ],
      blocks: {
        ...blocks,
        'doc-a:t2': { type: 'todo', checked: true, completedAt: doneAt },
      },
    });
    const inbox = viewOf(env, 'inbox');
    const counts = watch(env.service.counts$);

    const undoTick = await env.service.toggle('doc-a:t1');
    expect(counts.value.inbox).toBe(0);
    await undoTick();
    expect(env.props('doc-a:t1')?.checked).toBe(false);
    expect('completedAt' in (env.props('doc-a:t1') ?? {})).toBe(false);
    expect(inbox.value[0].rows.map(r => r.checked)).toEqual([false, true]);

    const undoUntick = await env.service.toggle('doc-a:t2');
    expect(env.props('doc-a:t2')?.checked).toBe(false);
    await undoUntick();
    expect(env.props('doc-a:t2')).toMatchObject({
      checked: true,
      completedAt: doneAt,
    });
  });
});

describe('toggle', () => {
  it('ticks and unticks the block, crossing the row off at once', async () => {
    const due = '2026-10-28';
    const env = setup({
      tasks: [
        { blockId: 't1', due },
        { blockId: 't2', due, checked: true, completedAt: NOON },
      ],
      blocks: {
        'doc-a:t1': { type: 'todo', checked: false, due },
        'doc-a:t2': { type: 'todo', checked: true, completedAt: NOON },
      },
    });
    const completed = viewOf(env, 'completed');
    const counts = watch(env.service.counts$);
    expect(counts.value).toMatchObject({ today: 1, completed: 1 });

    const pending = env.service.toggle('doc-a:t1');
    expect(counts.value).toMatchObject({ today: 0, completed: 2 });
    expect(blockIds(completed.value).sort()).toEqual(['t1', 't2']);
    await pending;
    expect(env.props('doc-a:t1')).toMatchObject({
      checked: true,
      completedAt: NOON,
    });
    expect(env.released).toEqual(['doc-a']);

    await env.service.toggle('doc-a:t2');
    expect(env.props('doc-a:t2')?.checked).toBe(false);
    expect('completedAt' in (env.props('doc-a:t2') ?? {})).toBe(false);
  });
});

describe('state', () => {
  it('is loading until the first result and a finished index pass', () => {
    const env = setup({ indexerState: { completed: false, indexing: 3 } });
    const state = watch(env.service.state$);
    expect(state.value).toEqual({ status: 'loading' });
    env.indexerState$.next({ ...env.indexerState$.value, completed: true });
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
    expect(blockIds(inbox.value)).toEqual(['t1']);
  });
});
