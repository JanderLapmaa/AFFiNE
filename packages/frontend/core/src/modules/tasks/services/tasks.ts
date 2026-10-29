import { setTodoChecked } from '@blocksuite/affine/blocks/list';
import type { ListBlockModel } from '@blocksuite/affine/model';
import type { Store } from '@blocksuite/affine/store';
import { LiveData, Service } from '@toeverything/infra';
import { isEqual } from 'lodash-es';
import {
  asapScheduler,
  BehaviorSubject,
  catchError,
  combineLatest,
  distinctUntilChanged,
  map,
  NEVER,
  Observable,
  observeOn,
  scan,
  shareReplay,
  startWith,
  Subject,
  Subscription,
  switchMap,
  using,
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
  TasksUndoToken,
  TasksViewId,
} from '../types';
import type { TasksClockStore } from './tasks-clock';

// Safety net: an optimistic value never outlives this, whatever the index does.
const OVERLAY_SAFETY_TIMEOUT_MS = 60_000;

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

type OverlayPatch = Partial<TaskValues>;

/** Optimistic values for one task, shown until the index catches up. */
interface OverlayEntry {
  patch: OverlayPatch;
  /** Indexed values when the first write started; undefined if unknown. */
  baseline: TaskValues | undefined;
  /** Writes started but not finished. */
  pending: number;
  /** The indexer went busy after the last write finished... */
  busySeen: boolean;
  /** ...and then reported idle again. */
  idleSeen: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface UndoEntry {
  token: TasksUndoToken;
  kind: 'due' | 'priority' | 'toggle';
  before: TaskValues;
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

function applyPatch(task: IndexedTask, patch: OverlayPatch): IndexedTask {
  const next = { ...task };
  if (patch.due !== undefined) next.due = patch.due;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.checked !== undefined) {
    next.checked = patch.checked;
    next.completedAt = patch.checked ? (patch.completedAt ?? null) : null;
  }
  return next;
}

/**
 * The index shows the entry's values once every patched key moved from the
 * baseline to the patch. Keys whose patch equals the baseline can't be told
 * apart from a stale row, so they also wait for the indexer to run and go
 * idle again after the write.
 */
function isReflected(row: IndexedTask, entry: OverlayEntry) {
  if (entry.pending > 0) return false;
  const { patch, baseline } = entry;
  for (const key of Object.keys(patch) as (keyof TaskValues)[]) {
    if (row[key] !== patch[key]) return false;
    if (baseline && baseline[key] === patch[key] && !entry.idleSeen) {
      return false;
    }
  }
  return true;
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
          .search$(
            'block',
            { type: 'match', field: 'flavour', match: 'affine:list' },
            {
              fields: ['docId', 'blockId', 'content', 'additional'],
              pagination: { skip: 0, limit: Infinity },
            }
          )
          .pipe(
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
      this.docsService.allNonTrashDocIds$(),
      this.docsService.propertyValues$('isTemplate'),
      this.docsService.allDocTitle$(),
      this.docsService.allDocsCreatedDate$(),
      this.docsService.allDocsUpdatedDate$(),
    ]).pipe(
      map(
        ([
          { docIds, needUpdated },
          alive,
          templates,
          titles,
          created,
          updated,
        ]) => {
          const aliveSet = new Set(alive);
          const titleOf = new Map(titles.map(d => [d.id, d.title]));
          const createdOf = new Map(created.map(d => [d.id, d.createDate]));
          const updatedOf = new Map(
            needUpdated.length ? updated.map(d => [d.id, d.updatedDate]) : []
          );
          const infos = new Map<string, DocInfo>();
          for (const id of docIds) {
            if (!aliveSet.has(id)) continue;
            infos.set(id, {
              title: titleOf.get(id) ?? '',
              template: !!templates.get(id),
              quickAdd: false,
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

    const overlaid$: Observable<Model> = combineLatest([
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
      }))
    );
    // Pruning runs beside the views (not inside them) and off the emission
    // stack, so it can't re-enter the view pipeline.
    this.model$ = using(
      () => this.startPruning(),
      () => overlaid$
    ).pipe(shareReplay({ bufferSize: 1, refCount: true }));

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
  private readonly pruneKick$ = new Subject<void>();
  private undoEntry: UndoEntry | null = null;
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
   * or missing, or the block is gone. They resolve with a token for `undo`.
   * `due` is a local calendar day `YYYY-MM-DD`, or null to clear it.
   */
  setDue(id: string, due: string | null): Promise<TasksUndoToken> {
    if (due !== null && !DUE_RE.test(due)) {
      return Promise.reject(new Error(`Invalid due date: ${due}`));
    }
    return this.change(id, 'due', { due }, (store, model) =>
      writeDue(store, model, due)
    );
  }

  /** 1 low, 2 medium, 3 high; 0 or null clears the priority. */
  setPriority(
    id: string,
    priority: TaskPriority | null
  ): Promise<TasksUndoToken> {
    const value: TaskPriority = priority ?? 0;
    return this.change(id, 'priority', { priority: value }, (store, model) =>
      writePriority(store, model, value)
    );
  }

  toggle(id: string): Promise<TasksUndoToken> {
    const row = this.readRow(id);
    const now = this.clock.now();
    const next = row ? !row.checked : undefined;
    return this.change(
      id,
      'toggle',
      next === undefined
        ? null
        : { checked: next, completedAt: next ? now : null },
      (store, model) => {
        setTodoChecked(store, model, next ?? !model.props.checked, now);
      }
    );
  }

  /**
   * Reverts the change `token` came from, but only while it is still the
   * latest one; otherwise it does nothing and returns false. It restores the
   * values from before that change, even over an edit made since. Like the
   * setters it rejects when the doc is trashed or missing, and then the
   * token stays valid.
   */
  async undo(token: TasksUndoToken): Promise<boolean> {
    await this.writeQueue.catch(() => {});
    const entry = this.undoEntry;
    if (!entry || entry.token !== token) return false;
    const { before } = entry;
    const restoredAt = before.completedAt ?? this.clock.now();
    if (entry.kind === 'due') {
      await this.change(
        token.taskId,
        'due',
        { due: before.due },
        (store, model) => writeDue(store, model, before.due),
        false
      );
    } else if (entry.kind === 'priority') {
      await this.change(
        token.taskId,
        'priority',
        { priority: before.priority },
        (store, model) => writePriority(store, model, before.priority),
        false
      );
    } else {
      await this.change(
        token.taskId,
        'toggle',
        {
          checked: before.checked,
          completedAt: before.checked ? restoredAt : null,
        },
        (store, model) => {
          setTodoChecked(store, model, before.checked, restoredAt);
        },
        false
      );
    }
    if (this.undoEntry === entry) this.undoEntry = null;
    return true;
  }

  override dispose() {
    for (const entry of this.overlay$.value.values()) {
      clearTimeout(entry.timer);
    }
    super.dispose();
  }

  /** Current indexed row, if the index can answer synchronously. */
  private readRow(id: string): IndexedTask | undefined {
    const raw = this.rawRow(id);
    if (!raw) return undefined;
    const entry = this.overlay$.value.get(id);
    return entry ? applyPatch(raw, entry.patch) : raw;
  }

  private startPruning() {
    const subscription = new Subscription();
    subscription.add(
      combineLatest([this.rows$, this.pruneKick$.pipe(startWith(undefined))])
        .pipe(observeOn(asapScheduler))
        .subscribe(([rows]) => this.prune(rows))
    );
    subscription.add(
      this.indexer.state$.subscribe(state => {
        const idle = state.completed && state.indexing === 0;
        for (const entry of this.overlay$.value.values()) {
          if (entry.pending > 0) continue;
          if (!idle) entry.busySeen = true;
          else if (entry.busySeen) entry.idleSeen = true;
        }
        if (idle) this.pruneKick$.next();
      })
    );
    return subscription;
  }

  private prune(rows: IndexedTask[]) {
    const byId = new Map(rows.map(r => [taskId(r), r]));
    for (const [id, entry] of this.overlay$.value) {
      const row = byId.get(id);
      if (row && isReflected(row, entry)) this.removeOverlay(id);
    }
  }

  /**
   * Optimistic write: show `patch` right away, then write to the source doc
   * (serialised). On failure only this call's patch keys are dropped.
   */
  private change(
    id: string,
    kind: UndoEntry['kind'],
    patch: OverlayPatch | null,
    write: (store: Store, model: ListBlockModel) => void,
    recordUndo = true
  ): Promise<TasksUndoToken> {
    let ref: { docId: string; blockId: string };
    try {
      ref = splitTaskId(id);
    } catch (error) {
      return Promise.reject(error);
    }
    if (patch) this.startOverlay(id, patch);

    const run = this.writeQueue
      .catch(() => {})
      .then(async (): Promise<TasksUndoToken> => {
        try {
          const before = await this.writeBlock(ref, (store, model) => {
            const values: TaskValues = {
              due: model.props.due ?? null,
              priority: (model.props.priority ?? 0) as TaskPriority,
              checked: model.props.checked === true,
              completedAt: model.props.completedAt ?? null,
            };
            write(store, model);
            return values;
          });
          if (patch) this.finishOverlay(id);
          const token: TasksUndoToken = { taskId: id };
          if (recordUndo) this.undoEntry = { token, kind, before };
          return token;
        } catch (error) {
          if (patch) this.failOverlay(id, patch);
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

  private startOverlay(id: string, patch: OverlayPatch) {
    const entries = new Map(this.overlay$.value);
    const existing = entries.get(id);
    if (existing) clearTimeout(existing.timer);
    const raw = existing ? undefined : this.rawRow(id);
    entries.set(id, {
      patch: { ...existing?.patch, ...patch },
      baseline: existing ? existing.baseline : raw && valuesOf(raw),
      pending: (existing?.pending ?? 0) + 1,
      busySeen: false,
      idleSeen: false,
      timer: setTimeout(
        () => this.removeOverlay(id),
        OVERLAY_SAFETY_TIMEOUT_MS
      ),
    });
    this.overlay$.next(entries);
  }

  private finishOverlay(id: string) {
    const entry = this.overlay$.value.get(id);
    if (!entry) return;
    entry.pending--;
    entry.busySeen = false;
    entry.idleSeen = false;
    this.pruneKick$.next();
  }

  private failOverlay(id: string, patch: OverlayPatch) {
    const entry = this.overlay$.value.get(id);
    if (!entry) return;
    entry.pending--;
    const rest = { ...entry.patch };
    for (const key of Object.keys(patch) as (keyof TaskValues)[]) {
      delete rest[key];
    }
    if (Object.keys(rest).length === 0) {
      this.removeOverlay(id);
      return;
    }
    const entries = new Map(this.overlay$.value);
    entries.set(id, { ...entry, patch: rest });
    this.overlay$.next(entries);
  }

  private removeOverlay(id: string) {
    const existing = this.overlay$.value.get(id);
    if (!existing) return;
    clearTimeout(existing.timer);
    const entries = new Map(this.overlay$.value);
    entries.delete(id);
    this.overlay$.next(entries);
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

function writeDue(store: Store, model: ListBlockModel, due: string | null) {
  if (due === null) {
    store.transact(() => {
      delete model.props.due;
    });
  } else {
    store.updateBlock(model, { due });
  }
}

function writePriority(
  store: Store,
  model: ListBlockModel,
  priority: TaskPriority
) {
  if (priority === 0) {
    store.transact(() => {
      delete model.props.priority;
    });
  } else {
    store.updateBlock(model, { priority });
  }
}
