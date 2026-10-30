/** @vitest-environment happy-dom */

import { UserFriendlyError } from '@affine/error';
import { Framework, MemoryMemento } from '@toeverything/infra';
import {
  BehaviorSubject,
  map,
  type Observable,
  of,
  type Subscription,
  throwError,
} from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Array as YArray, Doc as YDoc, Map as YMap, Text as YText } from 'yjs';

import { DocsService } from '../../doc/services/docs';
import { JournalService } from '../../journal';
import { GlobalCache } from '../../storage';
import { WorkspaceService } from '../../workspace';
import type { IndexedTask } from '../projection';
import { TasksService } from '../services/tasks';
import { TasksClockStore } from '../services/tasks-clock';
import { TasksCloudApi } from '../services/tasks-cloud-api';
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
  refs?: [number, string][];
}

function node(spec: TaskSpec) {
  const additional: Record<string, unknown> = {
    listType: spec.listType ?? 'todo',
    checked: spec.checked ?? false,
  };
  for (const key of [
    'due',
    'priority',
    'completedAt',
    'order',
    'heading',
    'refs',
  ]) {
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
    /** journal dates by doc id */
    journals?: Record<string, string>;
    /** workspace flavour; anything but local reads the server list */
    flavour?: string;
    cloudApi?: unknown;
    cache?: MemoryMemento;
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

  // The source docs, as real Yjs docs the service reads live.
  const ydocs = new Map<string, YDoc>();
  const blockMap = (key: string) => {
    const [docId, blockId] = key.split(':');
    return ydocs.get(docId)?.getMap<YMap<unknown>>('blocks').get(blockId);
  };
  for (const [key, props] of Object.entries(options.blocks ?? {})) {
    const [docId, blockId] = key.split(':');
    let ydoc = ydocs.get(docId);
    if (!ydoc) {
      ydoc = new YDoc({ guid: docId });
      ydocs.set(docId, ydoc);
      const page = new YMap<unknown>();
      page.set('sys:id', 'page');
      page.set('sys:flavour', 'affine:page');
      page.set('sys:children', YArray.from<string>([]));
      ydoc.getMap('blocks').set('page', page);
    }
    const block = new YMap<unknown>();
    block.set('sys:id', blockId);
    block.set('sys:flavour', 'affine:list');
    block.set('prop:text', new YText(blockId));
    for (const [k, v] of Object.entries(props)) block.set(`prop:${k}`, v);
    const blocks = ydoc.getMap<YMap<unknown>>('blocks');
    blocks.set(blockId, block);
    const children = blocks.get('page')?.get('sys:children') as YArray<string>;
    children.push([blockId]);
  }
  /** A block's props as the model sees them (backed by the Yjs map). */
  const propsOf = (block: YMap<unknown>) =>
    new Proxy({} as Record<string, unknown>, {
      get: (_, k) => block.get(`prop:${String(k)}`),
      set: (_, k, v) => (block.set(`prop:${String(k)}`, v), true),
      deleteProperty: (_, k) => (block.delete(`prop:${String(k)}`), true),
    });
  const opened: string[] = [];
  const released: string[] = [];
  /** A write fails while this is set. */
  let failWrites = false;
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
      const ydoc = ydocs.get(docId) ?? new YDoc({ guid: docId });
      // `updateBlock` skips `undefined` like the real store.
      const store = {
        readonly: false,
        transact: (fn: () => void) => ydoc.transact(fn),
        updateBlock: (
          model: { props: Record<string, unknown> },
          props: Record<string, unknown>
        ) => {
          if (failWrites) throw new Error('write failed');
          ydoc.transact(() => {
            for (const [k, v] of Object.entries(props)) {
              if (v !== undefined) model.props[k] = v;
            }
          });
        },
        getBlock: (blockId: string) => {
          const block = blockMap(`${docId}:${blockId}`);
          return block
            ? { model: { flavour: 'affine:list', props: propsOf(block) } }
            : undefined;
        },
      };
      return {
        doc: {
          yDoc: ydoc,
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
    () =>
      ({
        workspace: {
          id: 'ws-1',
          flavour: options.flavour ?? 'local',
          engine: { indexer },
        },
      }) as never
  );
  framework.service(DocsService, () => docsService as never);
  framework.service(
    JournalService,
    () =>
      ({
        journalDate$: (id: string) => ({
          asObservable: () => of(options.journals?.[id]),
        }),
      }) as never
  );
  framework.store(TasksClockStore, () => clock as never);
  framework.store(TasksCloudApi, () => (options.cloudApi ?? {}) as never);
  const cache = options.cache ?? new MemoryMemento();
  framework.impl(GlobalCache, cache);
  framework.service(TasksService, [
    WorkspaceService,
    DocsService,
    TasksClockStore,
    JournalService,
    TasksCloudApi,
    GlobalCache,
  ]);
  return {
    service: framework.provider().get(TasksService),
    clock,
    cache,
    rows$,
    indexer,
    indexerState$,
    docs$,
    opened,
    released,
    open: docsService.open,
    /** the index catches up with the given tasks */
    index: (tasks: TaskSpec[]) => rows$.next({ nodes: tasks.map(node) }),
    deleteDocs: () => records.clear(),
    trashAll: (trash: boolean) =>
      docs$.next(docs$.value.map(d => ({ ...d, trash }))),
    failWrites: (fail: boolean) => (failWrites = fail),
    /** a block's props in the source doc */
    props: (key: string) => {
      const block = blockMap(key);
      if (!block) return undefined;
      const props: Record<string, unknown> = {};
      for (const [k, v] of block.entries()) {
        if (k.startsWith('prop:') && k !== 'prop:text') props[k.slice(5)] = v;
      }
      return props;
    },
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

describe('empty todos and doc references', () => {
  it('leaves out empty and whitespace-only todos, and the counts follow', () => {
    const env = setup({
      tasks: [
        { blockId: 'real', title: 'real' },
        { blockId: 'empty', title: '' },
        { blockId: 'blank', title: '  	' },
        { blockId: 'dated-empty', title: '', due: '2026-10-28' },
        { blockId: 'ref-only', title: ' ', refs: [[0, 'doc-b']] },
      ],
    });
    expect(blockIds(viewOf(env, 'all').value)).toEqual(['real', 'ref-only']);
    expect(watch(env.service.counts$).value.inbox).toBe(2);
  });

  it('shows a linked journal doc as its date', () => {
    const env = setup({
      docs: [{ id: 'doc-a' }, { id: 'doc-j', title: '' }],
      journals: { 'doc-j': '2026-10-27' },
      tasks: [{ blockId: 'j', title: ' ', refs: [[0, 'doc-j']] }],
    });
    const [row] = viewOf(env, 'inbox').value.flatMap(g => g.rows);
    expect(row.title).toMatch(/2026|27/);
    expect(row.title).not.toBe('Untitled');
  });

  it('shows the linked doc title at each placeholder, and follows renames', () => {
    const env = setup({
      docs: [
        { id: 'doc-a', title: 'Doc A' },
        { id: 'doc-b', title: 'Beta' },
        { id: 'doc-c', title: '' },
      ],
      tasks: [
        // "see ${ref} and 😀 ${ref} end": the emoji is two UTF-16 units
        {
          blockId: 'linked',
          title: 'see   and 😀   end',
          refs: [
            [4, 'doc-b'],
            [13, 'doc-c'],
          ],
        },
        { blockId: 'gone', title: ' ', refs: [[0, 'doc-missing']] },
      ],
    });
    const view = viewOf(env, 'inbox');
    const titles = () =>
      Object.fromEntries(
        view.value.flatMap(g => g.rows).map(r => [r.blockId, r.title])
      );
    expect(titles()).toEqual({
      linked: 'see Beta and 😀 Untitled end',
      gone: 'Untitled',
    });
    env.docs$.next([
      { id: 'doc-a', title: 'Doc A' },
      { id: 'doc-b', title: 'Renamed' },
      { id: 'doc-c', title: 'C' },
    ]);
    expect(titles().linked).toBe('see Renamed and 😀 C end');
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

describe('values right after a write come from the doc', () => {
  const blocks = {
    'doc-a:t1': { type: 'todo', checked: false },
    'doc-a:t2': { type: 'todo', checked: false },
  };
  const tasks: TaskSpec[] = [{ blockId: 't1' }, { blockId: 't2' }];
  /** The index once it shows the doc (`order` is the position in the doc). */
  const caughtUp = (t1: Partial<TaskSpec>): TaskSpec[] => [
    { blockId: 't1', order: 1, ...t1 },
    { blockId: 't2', order: 2 },
  ];
  const rowOf = (groups: TaskGroup[], blockId: string) =>
    groups.flatMap(g => g.rows).find(r => r.blockId === blockId);

  it('a tick shows at once and stays through a slow, half-rebuilt index', async () => {
    vi.useFakeTimers();
    const env = setup({ tasks, blocks });
    const all = viewOf(env, 'all');
    await env.service.toggle('doc-a:t1');
    expect(rowOf(all.value, 't1')?.checked).toBe(true);

    env.index([{ blockId: 't1' }]); // re-indexing: half the doc, old values
    await vi.advanceTimersByTimeAsync(3000);
    expect(blockIds(all.value).sort()).toEqual(['t1', 't2']);
    expect(rowOf(all.value, 't1')?.checked).toBe(true);
    expect(env.released).toEqual([]);

    env.index(caughtUp({ checked: true, completedAt: NOON }));
    await flush();
    expect(rowOf(all.value, 't1')?.checked).toBe(true);
    expect(env.released).toEqual(['doc-a']);
  });

  it('a quick second tick decides from the doc, not the index', async () => {
    const env = setup({ tasks, blocks });
    const all = viewOf(env, 'all');
    await env.service.toggle('doc-a:t1');
    env.index(tasks); // a stale read: still unchecked
    await env.service.toggle('doc-a:t1');
    expect(env.props('doc-a:t1')?.checked).toBe(false);
    expect(rowOf(all.value, 't1')?.checked).toBe(false);
  });

  it('lets the doc go after 30 s when the index does not catch up', async () => {
    vi.useFakeTimers();
    const env = setup({ tasks, blocks });
    const inbox = viewOf(env, 'inbox');
    await env.service.setPriority('doc-a:t1', 3);
    env.index(caughtUp({})); // without the priority
    await flush();
    expect(rowOf(inbox.value, 't1')?.priority).toBe(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(env.released).toEqual(['doc-a']);
    expect(rowOf(inbox.value, 't1')?.priority).toBe(0);
  });

  it("a failed write shows the doc's real value", async () => {
    const env = setup({
      tasks, // stale: the index says t1 is open
      blocks: {
        ...blocks,
        'doc-a:t1': { type: 'todo', checked: true, completedAt: NOON },
      },
    });
    const all = viewOf(env, 'all');
    env.failWrites(true);
    await expect(env.service.toggle('doc-a:t1')).rejects.toThrow();
    expect(rowOf(all.value, 't1')?.checked).toBe(true);
  });
});

describe('Inbox does not flash empty while the doc list churns', () => {
  /** Row counts of every emission of the Inbox view. */
  function recordInbox(env: Env) {
    const seen: number[] = [];
    subscriptions.push(
      env.service.view$('inbox').subscribe(g => seen.push(blockIds(g).length))
    );
    return seen;
  }

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

    await env.service.setDue('doc-a:t1', '2026-10-29');
    // before the index caught up
    expect(inbox.value).toEqual([]);
    expect(shape(tomorrow.value)).toEqual([['day', '2026-10-29', ['t1']]]);
    expect(counts.value).toMatchObject({ inbox: 0, tomorrow: 1 });
    expect(env.props('doc-a:t1')?.due).toBe('2026-10-29');
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
    // the doc holds only t2, like the index
    const env = setup({
      tasks: [t2],
      blocks: { 'doc-a:t2': blocks['doc-a:t2'] },
    });
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

  it('rejects, not throws, when the doc cannot be opened', async () => {
    const env = setup({ tasks: [{ blockId: 't1' }], blocks });
    env.open.mockImplementationOnce(() => {
      throw new Error('Doc record not found');
    });
    await expect(env.service.toggle('doc-a:t1')).rejects.toThrow();
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

    await env.service.toggle('doc-a:t1');
    expect(counts.value).toMatchObject({ today: 0, completed: 2 });
    expect(blockIds(completed.value).sort()).toEqual(['t1', 't2']);
    expect(env.props('doc-a:t1')).toMatchObject({
      checked: true,
      completedAt: NOON,
    });

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

describe('cloud workspace (server task list)', () => {
  type CloudRow = IndexedTask;
  type RowSpec = Partial<CloudRow> & { blockId: string };

  const KEY = 'tasks-cloud:srv:user:ws-1';

  const cloudRow = (spec: RowSpec): CloudRow => ({
    docId: 'doc-a',
    title: spec.blockId,
    checked: false,
    due: null,
    priority: 0,
    completedAt: null,
    heading: null,
    order: 0,
    refs: [],
    ...spec,
  });

  /** A stub of the server task list API, with a controllable server. */
  function cloudSetup(
    options: {
      server?: RowSpec[];
      cached?: { etag: string; tasks: CloudRow[] };
      /** where the cache lives; null: no account */
      cacheKey?: string | null;
      docs?: DocSpec[];
      /** rows of the local indexer (the fallback) */
      indexed?: TaskSpec[];
    } = {}
  ) {
    let version = 1;
    let rows = (options.server ?? []).map(cloudRow);
    const state = {
      /** fetches wait for this to resolve while set */
      gate: null as Promise<void> | null,
      failFetch: null as Error | null,
      failUpdate: false,
      ready: true,
    };
    const cacheKey = options.cacheKey === undefined ? KEY : options.cacheKey;
    const fetchTasks = vi.fn(async (known: string | null) => {
      // What the server has when the request is made.
      const etag = `e${version}`;
      const snapshot = rows;
      await state.gate;
      if (state.failFetch) throw state.failFetch;
      return {
        etag,
        ready: state.ready,
        tasks: known === etag ? null : snapshot,
      };
    });
    const updateTask = vi.fn(
      async (_docId: string, _blockId: string, _input: unknown) => {
        if (state.failUpdate) throw new Error('boom');
      }
    );
    const cache = new MemoryMemento();
    if (options.cached && cacheKey) cache.set(cacheKey, options.cached);
    const env = setup({
      flavour: 'cloud',
      cloudApi: { fetchTasks, updateTask, cacheKey: () => cacheKey },
      cache,
      docs: options.docs,
      tasks: options.indexed,
    });
    return {
      ...env,
      fetchTasks,
      updateTask,
      state,
      /** the server list changes */
      serve: (next: RowSpec[]) => {
        rows = next.map(cloudRow);
        version++;
      },
      gate: () => {
        let open!: () => void;
        state.gate = new Promise<void>(resolve => (open = resolve));
        return () => {
          state.gate = null;
          open();
        };
      },
    };
  }

  // The effect hands results on through the async scheduler, one timer tick
  // per hop, and a zero-delay timer made during a tick runs 1 ms later.
  const settle = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(1);
  };

  const setVisible = (visible: boolean) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (visible ? 'visible' : 'hidden'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  type CloudEnv = ReturnType<typeof cloudSetup>;
  const rowOf = (env: CloudEnv, blockId: string) =>
    viewOf(env, 'all')
      .value.flatMap(g => g.rows)
      .find(r => r.blockId === blockId);

  afterEach(() => {
    setVisible(true);
  });

  it('shows the cached list before the first fetch answers', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({
      cached: { etag: 'e0', tasks: [cloudRow({ blockId: 'cached' })] },
      server: [{ blockId: 'fresh' }],
    });
    const open = env.gate();
    const view = viewOf(env, 'all');
    const state = watch(env.service.state$);
    await settle();
    expect(blockIds(view.value)).toEqual(['cached']);
    expect(state.value).toEqual({ status: 'ready' });
    open();
    await settle();
    expect(blockIds(view.value)).toEqual(['fresh']);
    expect(env.cache.get(KEY)).toMatchObject({ etag: 'e1' });
  });

  it('does not touch the cache without a signed-in account', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({
      cacheKey: null,
      server: [{ blockId: 't1' }],
    });
    env.cache.set(KEY, {
      etag: 'e0',
      tasks: [cloudRow({ blockId: 'other-account' })],
    });
    const open = env.gate();
    const view = viewOf(env, 'all');
    await settle();
    expect(view.value).toEqual([]);
    open();
    await settle();
    expect(blockIds(view.value)).toEqual(['t1']);
    expect(env.cache.get(KEY)).toMatchObject({ etag: 'e0' });
  });

  it('is loading without a cache, and does not read the local indexer', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({ server: [{ blockId: 't1' }] });
    const open = env.gate();
    const view = viewOf(env, 'all');
    const state = watch(env.service.state$);
    await settle();
    expect(state.value).toEqual({ status: 'loading' });
    expect(view.value).toEqual([]);
    open();
    await settle();
    expect(state.value).toEqual({ status: 'ready' });
    expect(blockIds(view.value)).toEqual(['t1']);
    expect(env.indexer.search$).not.toHaveBeenCalled();
  });

  it('keeps the list while reloading and when a refresh fails', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({ server: [{ blockId: 't1' }] });
    const view = viewOf(env, 'all');
    const state = watch(env.service.state$);
    await settle();
    expect(blockIds(view.value)).toEqual(['t1']);

    const open = env.gate();
    await settle(15_000);
    expect(blockIds(view.value)).toEqual(['t1']);
    env.state.failFetch = new Error('offline');
    open();
    await settle(15_000);
    expect(blockIds(view.value)).toEqual(['t1']);
    expect(state.value).toEqual({ status: 'ready' });
  });

  it('reports an error only when there is no list, and retry recovers', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({ server: [{ blockId: 't1' }] });
    env.state.failFetch = new Error('offline');
    const view = viewOf(env, 'all');
    const state = watch(env.service.state$);
    await settle();
    expect(state.value).toEqual({ status: 'error', message: 'offline' });
    env.state.failFetch = null;
    env.service.retry();
    await settle();
    expect(state.value).toEqual({ status: 'ready' });
    expect(blockIds(view.value)).toEqual(['t1']);
  });

  it('shows an access error but keeps the cached list', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({
      cached: { etag: 'e0', tasks: [cloudRow({ blockId: 'cached' })] },
    });
    env.state.failFetch = new UserFriendlyError({
      status: 403,
      code: 'Forbidden',
      type: 'no_permission',
      name: 'SPACE_ACCESS_DENIED',
      message: 'No access',
    });
    const view = viewOf(env, 'all');
    const state = watch(env.service.state$);
    await settle();
    expect(state.value).toEqual({ status: 'error', message: 'No access' });
    expect(blockIds(view.value)).toEqual(['cached']);
  });

  it('polls only while a view is open, not for the badge alone', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({ server: [{ blockId: 't1' }] });
    const counts = env.service.counts$.subscribe();
    await settle();
    expect(env.fetchTasks).toHaveBeenCalledTimes(1);
    await settle(60_000);
    expect(env.fetchTasks).toHaveBeenCalledTimes(1);

    // Opening the view refreshes, then polls.
    const view = env.service.view$('all').subscribe();
    await settle();
    expect(env.fetchTasks).toHaveBeenCalledTimes(2);
    await settle(15_000);
    expect(env.fetchTasks).toHaveBeenCalledTimes(3);

    // Closing it stops the polling again.
    view.unsubscribe();
    await settle(60_000);
    expect(env.fetchTasks).toHaveBeenCalledTimes(3);
    counts.unsubscribe();
  });

  it('retries a list that is not ready with a growing delay, only while visible', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({ server: [{ blockId: 't1' }] });
    env.state.ready = false;
    const view = viewOf(env, 'all');
    await settle();
    expect(env.fetchTasks).toHaveBeenCalledTimes(1);
    await settle(2_000);
    expect(env.fetchTasks).toHaveBeenCalledTimes(2);
    // 4 s next.
    await settle(3_000);
    expect(env.fetchTasks).toHaveBeenCalledTimes(2);
    await settle(1_100);
    expect(env.fetchTasks).toHaveBeenCalledTimes(3);

    setVisible(false);
    await settle(20_000);
    expect(env.fetchTasks).toHaveBeenCalledTimes(3);
    env.state.ready = true;
    setVisible(true);
    await settle();
    expect(blockIds(view.value)).toEqual(['t1']);
  });

  it('after the fallback, tasks of docs without a record are dropped', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({
      docs: [{ id: 'doc-a', title: 'Doc A' }],
      server: [{ blockId: 'far', docId: 'doc-far' }],
      indexed: [{ blockId: 'near' }, { blockId: 'orphan', docId: 'doc-far' }],
    });
    const view = viewOf(env, 'all');
    await settle();
    expect(blockIds(view.value)).toEqual(['far']);
    env.state.failFetch = new Error('Cannot query field "tasks"');
    env.service.retry();
    await settle();
    expect(blockIds(view.value)).toEqual(['near']);
  });

  it('falls back to the indexer when a write hits a server without updateTask', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({
      server: [{ blockId: 't1' }],
      indexed: [{ blockId: 'indexed' }],
    });
    const view = viewOf(env, 'all');
    await settle();
    env.updateTask.mockRejectedValueOnce(
      new Error('Cannot query field "updateTask" on type "Mutation".')
    );
    await expect(env.service.toggle('doc-a:t1')).rejects.toThrow();
    await settle();
    expect(blockIds(view.value)).toEqual(['indexed']);
  });

  it('falls back to the indexer when the server has no task API', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({
      cached: { etag: 'e0', tasks: [cloudRow({ blockId: 'cached' })] },
      indexed: [{ blockId: 'indexed' }],
    });
    env.state.failFetch = new Error(
      'Cannot query field "tasks" on type "WorkspaceType".'
    );
    const view = viewOf(env, 'all');
    const state = watch(env.service.state$);
    await settle();
    expect(blockIds(view.value)).toEqual(['indexed']);
    expect(state.value).toEqual({ status: 'ready' });
    // The server is not asked again.
    env.fetchTasks.mockClear();
    await settle(60_000);
    expect(env.fetchTasks).not.toHaveBeenCalled();
    // Writes go to the doc, as for a local workspace.
    expect(env.updateTask).not.toHaveBeenCalled();
  });

  it('sends the known etag and keeps the rows when nothing changed', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({ server: [{ blockId: 't1' }] });
    const view = viewOf(env, 'all');
    await settle();
    expect(env.fetchTasks).toHaveBeenLastCalledWith(null, expect.anything());
    await settle(15_000);
    expect(env.fetchTasks).toHaveBeenLastCalledWith('e1', expect.anything());
    expect(blockIds(view.value)).toEqual(['t1']);
    env.serve([{ blockId: 't1' }, { blockId: 't2', order: 1 }]);
    await settle(15_000);
    expect(blockIds(view.value)).toEqual(['t1', 't2']);
  });

  it('does not overlap requests', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({ server: [{ blockId: 't1' }] });
    const open = env.gate();
    viewOf(env, 'all');
    await settle();
    expect(env.fetchTasks).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(env.fetchTasks).toHaveBeenCalledTimes(1);
    open();
    await settle();
    // The requests asked for meanwhile run once, after the first.
    expect(env.fetchTasks).toHaveBeenCalledTimes(2);
  });

  it('polls every 15 s only while the document is visible', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({ server: [{ blockId: 't1' }] });
    viewOf(env, 'all');
    await settle();
    expect(env.fetchTasks).toHaveBeenCalledTimes(1);
    await settle(15_000);
    expect(env.fetchTasks).toHaveBeenCalledTimes(2);

    setVisible(false);
    await settle(120_000);
    expect(env.fetchTasks).toHaveBeenCalledTimes(2);

    setVisible(true);
    await settle();
    expect(env.fetchTasks).toHaveBeenCalledTimes(3);
    await settle(15_000);
    expect(env.fetchTasks).toHaveBeenCalledTimes(4);
  });

  it('does not fetch until the view is open, and stops when it closes', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({ server: [{ blockId: 't1' }] });
    await settle(60_000);
    expect(env.fetchTasks).not.toHaveBeenCalled();
    const sub = env.service.view$('all').subscribe();
    await settle();
    expect(env.fetchTasks).toHaveBeenCalledTimes(1);
    sub.unsubscribe();
    await settle(60_000);
    expect(env.fetchTasks).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the network comes back', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({ server: [{ blockId: 't1' }] });
    viewOf(env, 'all');
    await settle();
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(env.fetchTasks).toHaveBeenCalledTimes(2);
  });

  it('hides tasks of trashed docs', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({
      server: [{ blockId: 't1' }, { blockId: 't2', docId: 'doc-b' }],
    });
    const view = viewOf(env, 'all');
    await settle();
    expect(blockIds(view.value).sort()).toEqual(['t1', 't2']);
    env.docs$.next([
      { id: 'doc-a', title: 'Doc A', trash: true },
      { id: 'doc-b', title: 'Doc B' },
    ]);
    expect(blockIds(view.value)).toEqual(['t2']);
  });

  it('shows tasks of docs that have no local record yet, and can tick them', async () => {
    vi.useFakeTimers();
    const env = cloudSetup({
      docs: [{ id: 'doc-a', title: 'Doc A' }],
      server: [{ blockId: 'far', docId: 'doc-far', title: 'From the server' }],
    });
    const view = viewOf(env, 'all');
    await settle();
    expect(view.value.flatMap(g => g.rows)).toMatchObject([
      { blockId: 'far', title: 'From the server', docTitle: '' },
    ]);
    await env.service.toggle('doc-far:far');
    expect(env.updateTask).toHaveBeenCalledWith('doc-far', 'far', {
      checked: true,
    });
  });

  describe('writes', () => {
    const open = async () => {
      vi.useFakeTimers();
      const env = cloudSetup({ server: [{ blockId: 't1' }] });
      viewOf(env, 'all');
      await settle();
      return env;
    };

    it('shows a tick at once, through stale lists, until the server shows it', async () => {
      const env = await open();
      await env.service.toggle('doc-a:t1');
      expect(env.updateTask).toHaveBeenCalledWith('doc-a', 't1', {
        checked: true,
      });
      expect(env.opened).toEqual([]);
      expect(rowOf(env, 't1')).toMatchObject({ checked: true });

      // The server answers with a list that doesn't have the tick yet.
      env.serve([{ blockId: 't1' }, { blockId: 't2', order: 1 }]);
      await settle(15_000);
      expect(rowOf(env, 't2')).toBeDefined();
      expect(rowOf(env, 't1')).toMatchObject({ checked: true });

      // The server shows it, with its own completion time.
      env.serve([
        { blockId: 't1', checked: true, completedAt: at(2026, 10, 28, 12, 1) },
        { blockId: 't2', order: 1 },
      ]);
      await settle(15_000);
      expect(rowOf(env, 't1')).toMatchObject({
        checked: true,
        completedAt: at(2026, 10, 28, 12, 1),
      });

      // The patch is gone: a later server change wins.
      env.serve([{ blockId: 't1' }, { blockId: 't2', order: 1 }]);
      await settle(15_000);
      expect(rowOf(env, 't1')).toMatchObject({ checked: false });
    });

    it('drops the tick after 30 s if the server never shows it', async () => {
      const env = await open();
      await env.service.toggle('doc-a:t1');
      await settle(29_000);
      expect(rowOf(env, 't1')).toMatchObject({ checked: true });
      await settle(2_000);
      expect(rowOf(env, 't1')).toMatchObject({ checked: false });
    });

    it('refreshes right after the write', async () => {
      const env = await open();
      env.fetchTasks.mockClear();
      await env.service.toggle('doc-a:t1');
      await settle();
      expect(env.fetchTasks).toHaveBeenCalledTimes(1);
    });

    it('undo goes through the server too', async () => {
      const env = await open();
      const undo = await env.service.toggle('doc-a:t1');
      await undo();
      expect(env.updateTask).toHaveBeenLastCalledWith('doc-a', 't1', {
        checked: false,
      });
      expect(rowOf(env, 't1')).toMatchObject({ checked: false });
    });

    it('a fetch that started before the write completed cannot drop its patch', async () => {
      const env = await open();
      // A request is on its way, and will answer with the list as it was.
      const release = env.gate();
      await settle(15_000);
      expect(env.fetchTasks).toHaveBeenCalledTimes(2);

      const undo = await env.service.toggle('doc-a:t1');
      env.serve([{ blockId: 't1', checked: true, completedAt: 1 }]);
      await undo();
      expect(rowOf(env, 't1')).toMatchObject({ checked: false });

      // The old answer matches the unticked patch, but is not a witness.
      release();
      await settle();
      // The next list shows the tick, which the server hasn't yet undone.
      expect(rowOf(env, 't1')).toMatchObject({ checked: false });

      env.serve([{ blockId: 't1' }]);
      await settle(15_000);
      expect(rowOf(env, 't1')).toMatchObject({ checked: false });
    });

    it('due date and priority go through the server and show at once', async () => {
      vi.useFakeTimers();
      const env = cloudSetup({ server: [{ blockId: 't1' }] });
      const view = viewOf(env, 'tomorrow');
      await settle();
      await env.service.setDue('doc-a:t1', '2026-10-29');
      expect(env.updateTask).toHaveBeenLastCalledWith('doc-a', 't1', {
        due: '2026-10-29',
      });
      expect(env.opened).toEqual([]);
      expect(blockIds(view.value)).toEqual(['t1']);

      await env.service.setPriority('doc-a:t1', 3);
      expect(env.updateTask).toHaveBeenLastCalledWith('doc-a', 't1', {
        priority: 3,
      });
      await env.service.setPriority('doc-a:t1', null);
      expect(env.updateTask).toHaveBeenLastCalledWith('doc-a', 't1', {
        priority: null,
      });

      // The server catches up; then it is the source of truth again.
      env.serve([{ blockId: 't1', due: '2026-10-29' }]);
      await settle(15_000);
      expect(blockIds(view.value)).toEqual(['t1']);
      env.serve([{ blockId: 't1', due: '2026-10-30' }]);
      await settle(15_000);
      expect(blockIds(view.value)).toEqual([]);
    });

    it('a failed write keeps the old values and marks the row until a write works', async () => {
      const env = await open();
      env.state.failUpdate = true;
      await expect(env.service.toggle('doc-a:t1')).rejects.toThrow('boom');
      expect(rowOf(env, 't1')).toMatchObject({
        checked: false,
        error: 'boom',
      });

      // It stays until a list fetched after the failure shows the row.
      await settle(1_000);
      expect(rowOf(env, 't1')).toMatchObject({ error: 'boom' });
      await settle(15_000);
      expect(rowOf(env, 't1')?.error).toBeUndefined();

      env.state.failUpdate = true;
      await expect(env.service.toggle('doc-a:t1')).rejects.toThrow();
      expect(rowOf(env, 't1')).toMatchObject({ error: 'boom' });

      env.state.failUpdate = false;
      await env.service.toggle('doc-a:t1');
      expect(rowOf(env, 't1')).toMatchObject({ checked: true });
      expect(rowOf(env, 't1')?.error).toBeUndefined();
    });

    it('retry clears row errors', async () => {
      const env = await open();
      env.state.failUpdate = true;
      await expect(env.service.setPriority('doc-a:t1', 2)).rejects.toThrow();
      expect(rowOf(env, 't1')).toMatchObject({ priority: 0, error: 'boom' });
      env.service.retry();
      await settle();
      expect(rowOf(env, 't1')?.error).toBeUndefined();
    });
  });
});
