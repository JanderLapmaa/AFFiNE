import { readTodoBlocks } from '@affine/reader';
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
import type { Doc as YDoc } from 'yjs';

import type { Doc } from '../../doc/entities/doc';
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

// How long a doc we wrote to stays open when the index doesn't catch up.
const HOLD_CAP_MS = 30_000;

// Re-reads of a held doc on its own changes (typing, sync) are throttled.
const READ_THROTTLE_MS = 100;

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

interface Model {
  tasks: IndexedTask[];
  docs: ReadonlyMap<string, DocInfo>;
  today: string;
}

/**
 * A doc held open because the Tasks view wrote to it. Its rows are read from
 * the doc itself, so the view shows what the doc holds, not the index.
 */
interface LiveDoc {
  doc: Doc;
  release: () => void;
  /** Resolves once the doc is loaded from local storage and was read. */
  ready: Promise<void>;
  /** Rows read from the doc; null until it is loaded. */
  rows: IndexedTask[] | null;
  /** Writes running. */
  writes: number;
  timer?: ReturnType<typeof setTimeout>;
  detach?: () => void;
}

function splitTaskId(id: string) {
  const at = id.indexOf(':');
  if (at <= 0 || at === id.length - 1) {
    throw new Error(`Invalid task id: ${id}`);
  }
  return { docId: id.slice(0, at), blockId: id.slice(at + 1) };
}

/** A doc's todo rows, read with the indexer's extraction. */
function readLiveRows(docId: string, ydoc: YDoc): IndexedTask[] {
  return readTodoBlocks(ydoc).flatMap(block => {
    const task = parseIndexedTask({
      docId,
      blockId: block.blockId,
      content: block.content,
      additional: JSON.stringify(block.additional),
    });
    return task ? [task] : [];
  });
}

const byBlockId = (rows: IndexedTask[]) =>
  rows.toSorted((a, b) => (a.blockId < b.blockId ? -1 : 1));

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
 * Cross-doc task list: finds todo blocks through the block indexer, shapes
 * them into the Tasks views, and writes due / priority / checked back into the
 * source doc's list block. A doc we write to is read live until the index
 * shows the same rows (see `applyValues`).
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
            catchError((error: unknown) => {
              this.queryError$.next(
                error instanceof Error ? error.message : String(error)
              );
              return NEVER;
            })
          );
      }),
      tap(rows => {
        this.indexRows = rows;
        // After this emission reached the views, not during it.
        queueMicrotask(() => {
          for (const docId of this.live.keys()) this.releaseIfCaughtUp(docId);
        });
      }),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    // A doc held open shows its own rows in place of the indexed ones.
    this.tasks$ = combineLatest([this.rows$, this.liveChanged$]).pipe(
      map(([rows]) => {
        const live = [...this.live].filter(([, doc]) => doc.rows);
        if (!live.length) return rows;
        const held = new Set(live.map(([docId]) => docId));
        return [
          ...rows.filter(r => !held.has(r.docId)),
          ...live.flatMap(([, doc]) => doc.rows ?? []),
        ];
      }),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    // Only docs that hold tasks matter, and a doc's updated date only when a
    // checked task there has no completedAt. Typing in a doc therefore
    // doesn't change the result (and so doesn't rebuild the views).
    const relevantDocs$ = this.tasks$.pipe(
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

    this.model$ = combineLatest([this.tasks$, docInfo$, this.today$]).pipe(
      map(([tasks, docs, today]) => ({ tasks, docs, today })),
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
  private writeQueue: Promise<unknown> = Promise.resolve();
  private readonly views = new Map<TasksViewId, LiveData<TaskGroup[]>>();

  /** Todo rows from the index (parsed, not yet filtered by doc state). */
  private readonly rows$: Observable<IndexedTask[]>;
  /** The latest index rows, to tell when the index has caught up. */
  private indexRows: IndexedTask[] = [];

  /** Docs held open after a write, by doc id. */
  private readonly live = new Map<string, LiveDoc>();
  /** Emits when a held doc's rows change or a doc is let go. */
  private readonly liveChanged$ = new BehaviorSubject<void>(undefined);

  /** Index rows, with a held doc's rows replaced by the doc's own. */
  private readonly tasks$: Observable<IndexedTask[]>;

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

  override dispose() {
    for (const docId of this.live.keys()) this.releaseDoc(docId);
    super.dispose();
  }

  /**
   * Writes `decide(the block's current values)` to the source doc. Writes run
   * one at a time, and each decides from the doc as it is when its turn
   * comes, so a quick second tick undoes the first. The doc stays open until
   * the index shows what the doc holds, and its rows are read from the doc
   * meanwhile: a change shows as soon as the doc has it, and a failed write
   * shows the doc unchanged.
   */
  private applyValues(
    id: string,
    decide: (before: TaskValues) => Patch
  ): Promise<TasksUndo> {
    const run = this.writeQueue
      .catch(() => {})
      .then(async (): Promise<TasksUndo> => {
        const ref = splitTaskId(id);
        const record = this.docsService.list.doc$(ref.docId).value;
        if (!record || record.trash$.value) {
          throw new Error(`Doc ${ref.docId} is trashed or missing`);
        }
        const live = this.holdDoc(ref.docId);
        try {
          await live.ready;
          const store = live.doc.blockSuiteDoc;
          if (store.readonly) {
            throw new Error(`Doc ${ref.docId} is read-only`);
          }
          const model = store.getBlock(ref.blockId)?.model as
            | ListBlockModel
            | undefined;
          if (!model || model.flavour !== 'affine:list') {
            throw new Error(
              `Task block not found: ${ref.docId}:${ref.blockId}`
            );
          }
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
          // Shown now, not at the next throttled read.
          this.readLive(ref.docId, live);
          // Only what this write changed is written back.
          const previous: Patch = {};
          for (const key of Object.keys(changes) as (keyof TaskValues)[]) {
            Object.assign(previous, { [key]: before[key] });
          }
          return async () => {
            await this.applyValues(id, () => previous);
          };
        } finally {
          live.writes--;
          this.releaseIfCaughtUp(ref.docId);
        }
      });
    this.writeQueue = run;
    return run;
  }

  /** Opens the doc (or keeps it open) for one more write. */
  private holdDoc(docId: string): LiveDoc {
    let live = this.live.get(docId);
    if (!live) {
      const { doc, release } = this.docsService.open(docId);
      live = { doc, release, ready: Promise.resolve(), rows: null, writes: 0 };
      this.live.set(docId, live);
      live.ready = this.loadLiveDoc(docId, live);
    }
    live.writes++;
    clearTimeout(live.timer);
    live.timer = undefined;
    return live;
  }

  /**
   * Waits for the local load only (`waitForSyncReady` is the doc frontend's
   * load from local storage, not a server sync), then reads the doc's rows
   * now and, throttled, on every change.
   */
  private async loadLiveDoc(docId: string, live: LiveDoc) {
    const stopPriorityLoad = live.doc.addPriorityLoad(10);
    try {
      await live.doc.waitForSyncReady();
    } finally {
      stopPriorityLoad();
    }
    // Not when it was let go meanwhile.
    if (this.live.get(docId) !== live) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false;
    const onUpdate = () => {
      if (timer) {
        dirty = true;
        return;
      }
      this.readLive(docId, live);
      timer = setTimeout(() => {
        timer = undefined;
        if (dirty) {
          dirty = false;
          onUpdate();
        }
      }, READ_THROTTLE_MS);
    };
    const yDoc = live.doc.yDoc;
    yDoc.on('update', onUpdate);
    live.detach = () => {
      clearTimeout(timer);
      yDoc.off('update', onUpdate);
    };
    this.readLive(docId, live);
  }

  private readLive(docId: string, live: LiveDoc) {
    const rows = readLiveRows(docId, live.doc.yDoc);
    if (isEqual(rows, live.rows)) return;
    live.rows = rows;
    this.liveChanged$.next();
  }

  /**
   * Lets the doc go once its writes are done and the index shows the same
   * rows (`IndexedTask` holds just the fields the views use), so letting go
   * changes nothing on screen. An index that never catches up (paused,
   * battery save, never indexed) is given up on after `HOLD_CAP_MS`.
   */
  private releaseIfCaughtUp(docId: string) {
    const live = this.live.get(docId);
    if (!live || live.writes > 0) return;
    const indexed = this.indexRows.filter(r => r.docId === docId);
    if (!live.rows || isEqual(byBlockId(indexed), byBlockId(live.rows))) {
      this.releaseDoc(docId);
    } else {
      live.timer ??= setTimeout(() => {
        console.warn(
          `[tasks] index still differs from doc ${docId} after ${HOLD_CAP_MS / 1000} s; showing the index`
        );
        this.releaseDoc(docId);
      }, HOLD_CAP_MS);
    }
  }

  private releaseDoc(docId: string) {
    const live = this.live.get(docId);
    if (!live) return;
    this.live.delete(docId);
    clearTimeout(live.timer);
    live.detach?.();
    live.release();
    if (live.rows) this.liveChanged$.next();
  }
}
