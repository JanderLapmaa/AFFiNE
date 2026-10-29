import { setTodoChecked } from '@blocksuite/affine/blocks/list';
import type { ListBlockModel } from '@blocksuite/affine/model';
import type { Store } from '@blocksuite/affine/store';
import { LiveData, Service } from '@toeverything/infra';
import { isEqual } from 'lodash-es';
import {
  BehaviorSubject,
  catchError,
  combineLatest,
  distinctUntilChanged,
  map,
  NEVER,
  Observable,
  of,
  scan,
  shareReplay,
  startWith,
  switchMap,
  tap,
} from 'rxjs';

import type { DocsService } from '../../doc/services/docs';
import type { WorkspaceService } from '../../workspace';
import { localDay, msUntilNextLocalMidnight } from '../date';
import {
  buildCounts,
  buildView,
  type DocInfo,
  type IndexedTask,
  parseIndexedTask,
} from '../projection';
import type {
  TaskGroup,
  TaskPriority,
  TasksClock,
  TasksCounts,
  TasksState,
  TasksUndo,
  TasksViewId,
} from '../types';
import type { TasksClockStore } from './tasks-clock';

// memory-indexer rejects a search where skip + limit exceeds this.
const INDEXER_WINDOW = 10_000;

// How long a wait for the indexer, or a hold on a doc's rows, may last.
const INDEX_WAIT_MS = 10_000;

// Batches stay under the window so docs growing meanwhile still fit.
const BATCH_SIZE = 9000;

const LIST_QUERY = {
  type: 'match' as const,
  field: 'flavour' as const,
  match: 'affine:list',
};
const LIST_FIELDS: ('docId' | 'blockId' | 'content' | 'additional')[] = [
  'docId',
  'blockId',
  'content',
  'additional',
];

type SearchNode = {
  id: string;
  score: number;
  fields: Partial<Record<(typeof LIST_FIELDS)[number], string | string[]>>;
};

const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;

const EMPTY_COUNTS: TasksCounts = {
  inbox: 0,
  today: 0,
  tomorrow: 0,
  next7: 0,
  all: 0,
  completed: 0,
};

interface TaskValues {
  due: string | null;
  priority: TaskPriority;
  checked: boolean;
  completedAt: number | null;
}

type Patch = Partial<TaskValues>;

/**
 * Optimistic values for one task. The entry keeps its patch until its writes
 * are done and the indexer has processed the doc, then goes at the next rows$
 * emission after that.
 */
interface OverlayEntry {
  docId: string;
  /** When the last write started, for the hold cap. */
  since: number;
  patch: Patch;
  /** Writes started and not yet indexed. */
  writes: number;
  /** `rowsSeq` when the last write was indexed; null while writing. */
  settledAt: number | null;
}

interface Model {
  tasks: IndexedTask[];
  docs: ReadonlyMap<string, DocInfo>;
  today: string;
}

const taskId = (task: { docId: string; blockId: string }) =>
  `${task.docId}:${task.blockId}`;

function splitTaskId(id: string) {
  const at = id.indexOf(':');
  if (at <= 0 || at === id.length - 1) {
    throw new Error(`Invalid task id: ${id}`);
  }
  return { docId: id.slice(0, at), blockId: id.slice(at + 1) };
}

function valuesOf(task: IndexedTask): TaskValues {
  return {
    due: task.due,
    priority: task.priority,
    checked: task.checked,
    completedAt: task.completedAt,
  };
}

function applyPatch(task: IndexedTask, patch: Patch): IndexedTask {
  const next = { ...task };
  if (patch.due !== undefined) next.due = patch.due;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.checked !== undefined) {
    next.checked = patch.checked;
    next.completedAt = patch.checked ? (patch.completedAt ?? null) : null;
  }
  return next;
}

function countByDoc(rows: IndexedTask[]) {
  const counts = new Map<string, number>();
  for (const row of rows)
    counts.set(row.docId, (counts.get(row.docId) ?? 0) + 1);
  return counts;
}

/**
 * A doc we just wrote to is re-indexed by deleting its blocks and inserting
 * them again, and a query in between would show its tasks as gone. Such a
 * doc (`held`) keeps its previous rows while its row count shrinks.
 */
function holdShrunkDocs(
  prev: IndexedTask[],
  next: IndexedTask[],
  held: ReadonlySet<string>
): IndexedTask[] {
  if (!held.size) return next;
  const after = countByDoc(next);
  const shrunk = new Set<string>();
  for (const [docId, n] of countByDoc(prev)) {
    if (held.has(docId) && n > (after.get(docId) ?? 0)) shrunk.add(docId);
  }
  if (!shrunk.size) return next;
  return [
    ...next.filter(row => !shrunk.has(row.docId)),
    ...prev.filter(row => shrunk.has(row.docId)),
  ];
}

function writeProp(
  store: Store,
  model: ListBlockModel,
  key: 'due' | 'priority',
  value: string | number | null
) {
  if (value === null) {
    store.transact(() => {
      delete model.props[key];
    });
  } else {
    store.updateBlock(model, { [key]: value } as Partial<
      ListBlockModel['props']
    >);
  }
}

/**
 * Cross-doc task list: reads todo blocks from the block indexer, shapes them
 * into the Tasks views, and writes due / priority / checked back into the
 * source doc's list block.
 */
export class TasksService extends Service {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly docsService: DocsService,
    private readonly clockStore: TasksClockStore
  ) {
    super();

    this.rows$ = this.retry$.pipe(
      switchMap(() => {
        this.queryError$.next(null);
        return this.indexer
          .search$('block', LIST_QUERY, {
            fields: LIST_FIELDS,
            pagination: { skip: 0, limit: INDEXER_WINDOW },
          })
          .pipe(
            // The native indexer rejects any window beyond 10000 hits, so a
            // bigger result is read in doc batches instead.
            switchMap(first =>
              first.pagination.hasMore ? this.readAllListBlocks$() : of(first)
            ),
            map(({ nodes }) =>
              nodes.flatMap(node => {
                const task = parseIndexedTask(node.fields);
                return task ? [task] : [];
              })
            ),
            scan(
              (prev, next) => holdShrunkDocs(prev, next, this.heldDocs()),
              [] as IndexedTask[]
            ),
            catchError((error: unknown) => {
              this.queryError$.next(
                error instanceof Error ? error.message : String(error)
              );
              return NEVER;
            })
          );
      }),
      tap(() => {
        this.rowsSeq++;
        // After this emission reached the views, not during it.
        queueMicrotask(() => this.dropSettledOverlays());
      }),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    // Only docs that hold tasks matter, and a doc's updated date only when a
    // checked task there has no completedAt. Typing in a doc therefore
    // doesn't change the result (and so doesn't rebuild the views).
    const relevantDocs$ = this.rows$.pipe(
      map(rows => ({
        docIds: [...new Set(rows.map(r => r.docId))].sort(),
        needUpdated: [
          ...new Set(
            rows
              .filter(r => r.checked && r.completedAt === null)
              .map(r => r.docId)
          ),
        ].sort(),
      })),
      distinctUntilChanged(isEqual)
    );
    const docInfo$: Observable<ReadonlyMap<string, DocInfo>> = combineLatest([
      relevantDocs$,
      this.docsService.allTrashDocIds$(),
      this.docsService.propertyValues$('isTemplate'),
      this.docsService.allDocTitle$(),
      this.docsService.allDocsCreatedDate$(),
      this.docsService.allDocsUpdatedDate$(),
    ]).pipe(
      map(
        ([
          { docIds, needUpdated },
          trashed,
          templates,
          titles,
          created,
          updated,
        ]) => {
          const trashedSet = new Set(trashed);
          const titleOf = new Map(titles.map(d => [d.id, d.title]));
          const createdOf = new Map(created.map(d => [d.id, d.createDate]));
          const updatedOf = new Map(
            needUpdated.length ? updated.map(d => [d.id, d.updatedDate]) : []
          );
          const infos = new Map<string, DocInfo>();
          for (const id of docIds) {
            // Trashed docs and docs without a record are left out.
            if (trashedSet.has(id) || !this.docsService.list.doc$(id).value) {
              continue;
            }
            infos.set(id, {
              title: titleOf.get(id) ?? '',
              template: !!templates.get(id),
              createDate: createdOf.get(id),
              updatedDate: needUpdated.includes(id)
                ? updatedOf.get(id)
                : undefined,
            });
          }
          return infos;
        }
      ),
      distinctUntilChanged(isEqual)
    );

    this.model$ = combineLatest([
      this.rows$,
      docInfo$,
      this.overlay$,
      this.today$,
    ]).pipe(
      map(([rows, docs, overlay, today]) => ({
        tasks: rows.map(row => {
          const entry = overlay.get(taskId(row));
          return entry ? applyPatch(row, entry.patch) : row;
        }),
        docs,
        today,
      })),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    this.state$ = LiveData.from(
      combineLatest([
        this.indexer.state$.pipe(startWith(null)),
        this.queryError$,
        this.rows$.pipe(
          map(() => true),
          startWith(false)
        ),
      ]).pipe(
        scan(
          (acc, [indexerState, queryError, received]) => {
            const completedOnce =
              acc.completedOnce ||
              !!(indexerState?.completed || indexerState?.paused);
            const message = queryError ?? indexerState?.errorMessage ?? null;
            const state: TasksState = message
              ? { status: 'error', message }
              : !received || !completedOnce
                ? { status: 'loading' }
                : { status: 'ready' };
            return { completedOnce, state };
          },
          { completedOnce: false, state: { status: 'loading' } as TasksState }
        ),
        map(acc => acc.state),
        distinctUntilChanged(isEqual)
      ),
      { status: 'loading' } as TasksState
    );

    this.counts$ = LiveData.from(
      this.model$.pipe(
        map(({ tasks, docs, today }) => buildCounts(tasks, docs, today)),
        distinctUntilChanged(isEqual)
      ),
      EMPTY_COUNTS
    );
    this.inboxCount$ = this.counts$.map(counts => counts.inbox);
  }

  /**
   * Reads every list block when they don't fit one indexer window. Offsets
   * can't go past the window either, so docs are grouped into batches whose
   * list blocks fit it, and each batch is one query.
   */
  private readAllListBlocks$() {
    return new Observable<{ nodes: SearchNode[] }>(subscriber => {
      let cancelled = false;
      this.readAllListBlocks(() => cancelled).then(
        result => {
          if (cancelled) return;
          subscriber.next(result);
          subscriber.complete();
        },
        error => {
          if (!cancelled) subscriber.error(error);
        }
      );
      return () => {
        cancelled = true;
      };
    });
  }

  private async readAllListBlocks(isCancelled: () => boolean) {
    const { buckets } = await this.indexer.aggregate(
      'block',
      LIST_QUERY,
      'docId',
      { pagination: { skip: 0, limit: Infinity } }
    );
    const batches: string[][] = [];
    let batch: string[] = [];
    let size = 0;
    for (const bucket of buckets) {
      if (batch.length && size + bucket.count > BATCH_SIZE) {
        batches.push(batch);
        batch = [];
        size = 0;
      }
      batch.push(bucket.key);
      size += bucket.count;
    }
    if (batch.length) batches.push(batch);

    const nodes: SearchNode[] = [];
    for (const docIds of batches) {
      if (isCancelled()) break;
      const result = await this.indexer.search(
        'block',
        {
          type: 'boolean',
          occur: 'must',
          queries: [
            LIST_QUERY,
            {
              type: 'boolean',
              occur: 'should',
              queries: docIds.map(docId => ({
                type: 'match' as const,
                field: 'docId' as const,
                match: docId,
              })),
            },
          ],
        },
        { fields: LIST_FIELDS, pagination: { skip: 0, limit: INDEXER_WINDOW } }
      );
      nodes.push(...result.nodes);
      if (result.pagination.hasMore) {
        // Kept rows are still shown; the rest can't be read in one window.
        console.warn(
          `[tasks] ${result.pagination.count} list blocks in doc(s) ${docIds.join(', ')} exceed the indexer window; showing the first ${result.nodes.length}`
        );
      }
    }
    return { nodes };
  }

  private get indexer() {
    return this.workspaceService.workspace.engine.indexer;
  }

  private get clock(): TasksClock {
    return this.clockStore;
  }

  private readonly retry$ = new BehaviorSubject(0);
  private readonly queryError$ = new BehaviorSubject<string | null>(null);
  private readonly overlay$ = new BehaviorSubject<
    ReadonlyMap<string, OverlayEntry>
  >(new Map());
  /** Counts rows$ emissions, so an overlay can wait for "the next one". */
  private rowsSeq = 0;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private readonly views = new Map<TasksViewId, LiveData<TaskGroup[]>>();

  /** Todo rows from the index (parsed, not yet filtered by doc state). */
  private readonly rows$: Observable<IndexedTask[]>;

  /** The local calendar day. Advances at midnight and on wake-up. */
  private readonly today$ = new Observable<string>(subscriber => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      clearTimeout(timer);
      const now = this.clock.now();
      subscriber.next(localDay(now));
      timer = setTimeout(tick, msUntilNextLocalMidnight(now) + 50);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    tick();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }
    return () => {
      clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }).pipe(distinctUntilChanged());

  private readonly model$: Observable<Model>;

  /** Loading until the first query result and a finished index pass. */
  readonly state$: LiveData<TasksState>;

  /** Unchecked tasks per view (`completed`: number of checked tasks). */
  readonly counts$: LiveData<TasksCounts>;

  /** Inbox size, for the sidebar entry and tab badge. */
  readonly inboxCount$: LiveData<number>;

  /** Current time from the service clock (the UI's "now"). */
  now(): number {
    return this.clock.now();
  }

  /** Ordered groups of one view. Labels are left to the UI. */
  view$(viewId: TasksViewId): LiveData<TaskGroup[]> {
    let view = this.views.get(viewId);
    if (!view) {
      view = LiveData.from(
        this.model$.pipe(
          map(({ tasks, docs, today }) =>
            buildView(viewId, tasks, docs, today)
          ),
          distinctUntilChanged(isEqual)
        ),
        [] as TaskGroup[]
      );
      this.views.set(viewId, view);
    }
    return view;
  }

  /**
   * Re-runs the index query (story 11). The indexer API has no restart or
   * resync call (it retries itself every 5s), so there is nothing else to call.
   */
  retry() {
    this.retry$.next(this.retry$.value + 1);
  }

  /**
   * Writes (`setDue`, `setPriority`, `toggle`) reject when the doc is trashed
   * or missing, or the block is gone. They resolve once the doc is written,
   * with an `undo` that writes the previous values back (and rejects likewise).
   * `due` is a local calendar day `YYYY-MM-DD`, or null to clear it.
   */
  setDue(id: string, due: string | null): Promise<TasksUndo> {
    if (due !== null && !DUE_RE.test(due)) {
      return Promise.reject(new Error(`Invalid due date: ${due}`));
    }
    return this.applyValues(id, () => ({ due }));
  }

  /** 1 low, 2 medium, 3 high; 0 or null clears the priority. */
  setPriority(id: string, priority: TaskPriority | null): Promise<TasksUndo> {
    return this.applyValues(id, () => ({ priority: priority ?? 0 }));
  }

  toggle(id: string): Promise<TasksUndo> {
    const now = this.clock.now();
    return this.applyValues(id, before => ({
      checked: !before.checked,
      completedAt: before.checked ? null : now,
    }));
  }

  /**
   * Optimistic write: shows `decide(current values)` right away, then writes
   * the same decision to the source doc (serialised). A failed write takes
   * the optimistic values back.
   */
  private applyValues(
    id: string,
    decide: (before: TaskValues) => Patch
  ): Promise<TasksUndo> {
    let ref: { docId: string; blockId: string };
    try {
      ref = splitTaskId(id);
    } catch (error) {
      return Promise.reject(error);
    }
    const row = this.rawRow(id);
    const entry = this.overlay$.value.get(id);
    const shown = row && (entry ? applyPatch(row, entry.patch) : row);
    const optimistic = shown && decide(valuesOf(shown));
    const prevPatch = optimistic
      ? this.startOverlay(id, ref.docId, optimistic)
      : {};

    const run = this.writeQueue
      .catch(() => {})
      .then(async (): Promise<TasksUndo> => {
        try {
          const { before, changes } = await this.writeBlock(
            ref,
            (store, model) => {
              const before: TaskValues = {
                due: model.props.due ?? null,
                priority: (model.props.priority ?? 0) as TaskPriority,
                checked: model.props.checked === true,
                completedAt: model.props.completedAt ?? null,
              };
              const changes = decide(before);
              if (changes.due !== undefined) {
                writeProp(store, model, 'due', changes.due);
              }
              if (changes.priority !== undefined) {
                writeProp(store, model, 'priority', changes.priority || null);
              }
              if (changes.checked !== undefined) {
                const at = changes.completedAt ?? this.clock.now();
                setTodoChecked(store, model, changes.checked, at);
              }
              return { before, changes };
            }
          );
          if (optimistic) this.settleOverlay(id, ref.docId).catch(() => {});
          // Only what this write changed is written back.
          const previous: Patch = {};
          for (const key of Object.keys(changes) as (keyof TaskValues)[]) {
            Object.assign(previous, { [key]: before[key] });
          }
          return async () => {
            await this.applyValues(id, () => previous);
          };
        } catch (error) {
          if (optimistic) this.failOverlay(id, optimistic, prevPatch);
          throw error;
        }
      });
    this.writeQueue = run;
    return run;
  }

  /** Opens the source doc, runs `fn` on the block's model, releases the doc. */
  private async writeBlock<T>(
    ref: { docId: string; blockId: string },
    fn: (store: Store, model: ListBlockModel) => T
  ): Promise<T> {
    const record = this.docsService.list.doc$(ref.docId).value;
    if (!record || record.trash$.value) {
      throw new Error(`Doc ${ref.docId} is trashed or missing`);
    }
    const { doc, release } = this.docsService.open(ref.docId);
    try {
      const stopPriorityLoad = doc.addPriorityLoad(10);
      try {
        await doc.waitForSyncReady();
      } finally {
        stopPriorityLoad();
      }
      const store = doc.blockSuiteDoc;
      if (store.readonly) {
        throw new Error(`Doc ${ref.docId} is read-only`);
      }
      const model = store.getBlock(ref.blockId)?.model as
        | ListBlockModel
        | undefined;
      if (!model || model.flavour !== 'affine:list') {
        throw new Error(`Task block not found: ${ref.docId}:${ref.blockId}`);
      }
      return fn(store, model);
    } finally {
      release();
    }
  }

  /** Docs with a recent write of ours still waiting to show in the index. */
  private heldDocs() {
    const now = Date.now();
    const docs = new Set<string>();
    for (const entry of this.overlay$.value.values()) {
      if (now - entry.since < INDEX_WAIT_MS) docs.add(entry.docId);
    }
    return docs;
  }

  /** Returns the patch the entry had before, for `failOverlay`. */
  private startOverlay(id: string, docId: string, patch: Patch) {
    const entries = new Map(this.overlay$.value);
    const existing = entries.get(id);
    entries.set(id, {
      docId,
      since: Date.now(),
      patch: { ...existing?.patch, ...patch },
      writes: (existing?.writes ?? 0) + 1,
      settledAt: null,
    });
    this.overlay$.next(entries);
    return existing?.patch ?? {};
  }

  /**
   * The write is done; the entry goes at the first rows$ emission after the
   * indexer has processed the doc, or after `INDEX_WAIT_MS` (it doesn't while
   * paused, in battery-save mode, or if the doc is never indexed).
   */
  private async settleOverlay(id: string, docId: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.indexer.waitForDocCompleted(docId),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, INDEX_WAIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.endWrite(id);
    }
  }

  /** One write of the entry is over; with none left it can be dropped. */
  private endWrite(id: string) {
    const entry = this.overlay$.value.get(id);
    if (!entry) return;
    entry.writes--;
    if (entry.writes === 0) entry.settledAt = this.rowsSeq;
  }

  private dropSettledOverlays() {
    const entries = new Map(this.overlay$.value);
    for (const [id, entry] of entries) {
      if (entry.settledAt !== null && entry.settledAt < this.rowsSeq) {
        entries.delete(id);
      }
    }
    if (entries.size !== this.overlay$.value.size) this.overlay$.next(entries);
  }

  /** Takes back this write's keys only, to what they were before it. */
  private failOverlay(id: string, patch: Patch, before: Patch) {
    const entry = this.overlay$.value.get(id);
    if (!entry) return;
    for (const key of Object.keys(patch) as (keyof TaskValues)[]) {
      if (key in before) Object.assign(entry.patch, { [key]: before[key] });
      else delete entry.patch[key];
    }
    this.endWrite(id);
    this.overlay$.next(new Map(this.overlay$.value));
  }

  private rawRow(id: string): IndexedTask | undefined {
    let found: IndexedTask | undefined;
    this.rows$
      .subscribe(rows => {
        found = rows.find(r => taskId(r) === id);
      })
      .unsubscribe();
    return found;
  }
}
