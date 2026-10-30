import { UserFriendlyError } from '@affine/error';
import {
  backoffRetry,
  catchErrorInto,
  effect,
  exhaustMapWithTrailing,
  fromPromise,
  LiveData,
} from '@toeverything/infra';
import { isEqual } from 'lodash-es';
import {
  BehaviorSubject,
  combineLatest,
  distinctUntilChanged,
  EMPTY,
  filter,
  fromEvent,
  ignoreElements,
  interval,
  map,
  merge,
  Observable,
  of,
  shareReplay,
  skip,
  Subject,
  switchMap,
  tap,
  timer,
} from 'rxjs';

import type { GlobalCache } from '../../storage';
import type { IndexedTask } from '../projection';
import type {
  CloudTaskUpdate,
  TasksCloudApi,
} from '../services/tasks-cloud-api';
import type { TasksState } from '../types';
import { splitTaskId } from './doc-write';
import type { Patch, TaskSource, TaskValues } from './types';

/** The list is re-fetched this often while the view is open and visible. */
export const POLL_MS = 15_000;

/** An optimistic value is dropped after this long even if the server lags. */
export const PATCH_CAP_MS = 30_000;

/** How soon to ask again while the server is still building the list. */
const NOT_READY_RETRY_MS = 2_000;
const NOT_READY_MAX_MS = 30_000;

interface CacheEntry {
  etag: string;
  tasks: IndexedTask[];
}

interface PatchEntry {
  patch: Patch;
  /** Tells this write's patch from a newer one on the same task. */
  gen: number;
  /** Epoch ms after which the patch is dropped whatever the server shows. */
  expiresAt: number;
  /**
   * Only a fetch that started after this many fetches had started (that is,
   * after the write completed) may drop the patch. Infinity while the write
   * is running.
   */
  afterSeq: number;
}

const PATCH_KEYS: (keyof TaskValues)[] = ['due', 'priority', 'checked'];

const idOf = (task: IndexedTask) => `${task.docId}:${task.blockId}`;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function readCache(cache: GlobalCache, key: string): CacheEntry | null {
  try {
    const entry = cache.get<CacheEntry>(key);
    return entry && typeof entry.etag === 'string' && Array.isArray(entry.tasks)
      ? entry
      : null;
  } catch {
    return null;
  }
}

/** A server without the task API rejects the query as invalid. */
function isUnsupported(error: UserFriendlyError) {
  return /Cannot query field|Unknown (argument|type)/i.test(error.message);
}

/**
 * The server's task list for a cloud workspace. The last list is kept in the
 * cache and shown at once; it is refreshed while the view is open and never
 * cleared while loading or on an error. Own writes show at once as patches
 * over the server rows, until a later server list shows them (or a cap
 * passes).
 */
export class CloudTaskSource implements TaskSource {
  readonly kind = 'cloud' as const;

  constructor(
    private readonly api: Pick<
      TasksCloudApi,
      'fetchTasks' | 'updateTask' | 'cacheKey'
    >,
    private readonly cache: GlobalCache,
    /** The server has no task API: the caller falls back to the indexer. */
    private readonly onUnsupported: () => void,
    /** Whether a task view is open (not just a badge): only then it polls. */
    private readonly viewOpen$: Observable<boolean> = of(true)
  ) {
    this.rows$ = new Observable<IndexedTask[]>(subscriber => {
      this.loadCache();
      const rows = combineLatest([this.serverRows$, this.overlay$]).subscribe({
        next: () => subscriber.next(this.effectiveRows()),
        error: error => subscriber.error(error),
      });
      const triggers = this.triggers$().subscribe(() => this.refreshEffect());
      return () => {
        rows.unsubscribe();
        triggers.unsubscribe();
      };
    }).pipe(shareReplay({ bufferSize: 1, refCount: true }));

    // Reading the state is enough to keep the list fresh.
    this.state$ = merge(
      this.stateSubject$,
      this.rows$.pipe(ignoreElements())
    ).pipe(distinctUntilChanged(isEqual));
  }

  private etag: string | null = null;
  private serverRows: IndexedTask[] = [];
  private readonly serverRows$ = new BehaviorSubject<IndexedTask[]>([]);
  private readonly stateSubject$ = new BehaviorSubject<TasksState>({
    status: 'loading',
  });
  /** Bumped when patches or row errors change. */
  private readonly overlay$ = new BehaviorSubject(0);

  private readonly patches = new Map<string, PatchEntry>();
  /** Row errors, with the fetch count when the write failed. */
  private readonly errors = new Map<string, { message: string; seq: number }>();
  private notReadyAttempts = 0;
  private patchGen = 0;
  private expiryTimer?: ReturnType<typeof setTimeout>;

  /** Fetches started so far. */
  private startedSeq = 0;
  private cacheLoaded = false;
  private disposed = false;

  private readonly refresh$ = new Subject<void>();
  /** Delay before the next not-ready retry. */
  private readonly notReady$ = new Subject<number>();
  private readonly error$ = new LiveData<unknown>(null);

  readonly rows$: Observable<IndexedTask[]>;
  readonly state$: Observable<TasksState>;

  private get hasList() {
    return this.etag !== null;
  }

  private isVisible() {
    return typeof document === 'undefined'
      ? true
      : document.visibilityState === 'visible';
  }

  // --- refreshing ---------------------------------------------------------

  /** Everything that asks for a fetch, alive while the rows are watched. */
  private triggers$() {
    const visible$ = (
      typeof document === 'undefined'
        ? of(null)
        : merge(of(null), fromEvent(document, 'visibilitychange'))
    ).pipe(
      map(() => this.isVisible()),
      distinctUntilChanged()
    );
    // Polling and the not-ready retry need the view open and visible.
    const polling$ = combineLatest([visible$, this.viewOpen$]).pipe(
      map(([visible, open]) => visible && open),
      distinctUntilChanged()
    );
    return merge(
      // The first subscriber.
      of(null),
      // Back in the foreground (not the first value: that is the line above).
      visible$.pipe(skip(1), filter(Boolean)),
      // A view opened over a badge.
      this.viewOpen$.pipe(distinctUntilChanged(), skip(1), filter(Boolean)),
      typeof window === 'undefined' ? EMPTY : fromEvent(window, 'online'),
      // After an own write.
      this.refresh$,
      this.notReady$.pipe(
        switchMap(delay =>
          polling$.pipe(switchMap(on => (on ? timer(delay) : EMPTY)))
        )
      ),
      polling$.pipe(switchMap(on => (on ? interval(POLL_MS) : EMPTY)))
    );
  }

  /** One request at a time; a request asked for meanwhile runs after it. */
  private readonly refreshEffect = effect(
    exhaustMapWithTrailing(() =>
      fromPromise(signal => {
        this.loadCache();
        const seq = ++this.startedSeq;
        return this.api
          .fetchTasks(this.etag, signal)
          .then(result => ({ result, seq }));
      }).pipe(
        backoffRetry({
          when: UserFriendlyError.isNetworkError,
          count: 3,
        }),
        tap(({ result, seq }) => this.applyResult(result, seq)),
        catchErrorInto(this.error$, error => this.handleError(error))
      )
    )
  );

  private loadCache() {
    if (this.cacheLoaded) return;
    const key = this.api.cacheKey();
    if (!key) return;
    this.cacheLoaded = true;
    const cached = readCache(this.cache, key);
    if (cached && !this.hasList) {
      this.etag = cached.etag;
      this.serverRows = cached.tasks;
      this.serverRows$.next(cached.tasks);
      this.setState({ status: 'ready' });
    }
  }

  private applyResult(
    result: Awaited<ReturnType<TasksCloudApi['fetchTasks']>>,
    seq: number
  ) {
    if (this.disposed) return;
    if (!result.ready && !this.hasList) {
      // Still being built on the server: nothing to show yet.
      this.setState({ status: 'loading' });
      this.notReadyAttempts++;
      this.notReady$.next(
        Math.min(
          NOT_READY_RETRY_MS * 2 ** (this.notReadyAttempts - 1),
          NOT_READY_MAX_MS
        )
      );
      return;
    }
    if (result.ready && result.tasks) {
      this.etag = result.etag;
      this.serverRows = result.tasks;
      const key = this.api.cacheKey();
      if (key) {
        try {
          this.cache.set<CacheEntry>(key, {
            etag: result.etag,
            tasks: result.tasks,
          });
        } catch {
          // The cache is optional.
        }
      }
      this.serverRows$.next(result.tasks);
    } else if (result.ready && !this.hasList) {
      // "Unchanged" with nothing to keep: an empty list.
      this.etag = result.etag;
    }
    this.setState({ status: 'ready' });
    if (result.ready) this.notReadyAttempts = 0;
    // An error goes once a list fetched after the failure shows its row, or
    // the task is gone.
    const present = new Set(this.serverRows.map(idOf));
    for (const [id, error] of this.errors) {
      if (!present.has(id) || error.seq < seq) this.errors.delete(id);
    }
    this.reconcile(seq);
  }

  private handleError(error: unknown) {
    if (this.disposed) return;
    const friendly = UserFriendlyError.fromAny(error);
    if (isUnsupported(friendly)) {
      this.onUnsupported();
      return;
    }
    // The list on screen stays. It is reported when there is none, or when
    // the account can no longer see the workspace.
    const denied =
      friendly.isStatus(401) ||
      friendly.isStatus(403) ||
      friendly.isStatus(404);
    if (!this.hasList || denied) {
      this.setState({ status: 'error', message: friendly.message });
    }
  }

  private setState(state: TasksState) {
    this.stateSubject$.next(state);
  }

  retry() {
    this.errors.clear();
    this.bump();
    if (!this.hasList) this.setState({ status: 'loading' });
    this.refresh$.next();
  }

  // --- optimistic patches -------------------------------------------------

  private effectiveRows(): IndexedTask[] {
    if (!this.patches.size && !this.errors.size) return this.serverRows;
    return this.serverRows.map(row => {
      const id = idOf(row);
      const patch = this.patches.get(id)?.patch;
      const error = this.errors.get(id)?.message;
      if (!patch && !error) return row;
      return { ...row, ...patch, ...(error ? { error } : {}) };
    });
  }

  private bump() {
    this.overlay$.next(this.overlay$.value + 1);
  }

  private setPatch(id: string, patch: Patch, gen: number) {
    const old = this.patches.get(id);
    this.patches.set(id, {
      patch: { ...old?.patch, ...patch },
      gen,
      expiresAt: Date.now() + PATCH_CAP_MS,
      afterSeq: Number.POSITIVE_INFINITY,
    });
    this.scheduleExpiry();
    this.bump();
  }

  /** One timer, for the patch that expires first. */
  private scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (this.disposed || !this.patches.size) return;
    const next = Math.min(...[...this.patches.values()].map(e => e.expiresAt));
    this.expiryTimer = setTimeout(
      () => {
        const now = Date.now();
        for (const [id, entry] of this.patches) {
          if (entry.expiresAt <= now) this.patches.delete(id);
        }
        this.scheduleExpiry();
        this.bump();
      },
      Math.max(0, next - Date.now())
    );
  }

  /**
   * Drops the patches that the list of fetch `seq` shows (or whose task is
   * gone), when that fetch started after the patch's write completed: an
   * older fetch may show the values from before the write.
   */
  private reconcile(seq: number) {
    const byId = new Map(this.serverRows.map(row => [idOf(row), row]));
    for (const [id, entry] of this.patches) {
      if (entry.afterSeq >= seq) continue;
      const row = byId.get(id);
      const shown =
        !row ||
        PATCH_KEYS.every(
          key => entry.patch[key] === undefined || row[key] === entry.patch[key]
        );
      if (shown) this.patches.delete(id);
    }
    this.scheduleExpiry();
    this.bump();
  }

  // --- writes -------------------------------------------------------------

  async apply(
    id: string,
    decide: (before: TaskValues) => Patch
  ): Promise<Patch> {
    const ref = splitTaskId(id);
    const row = this.effectiveRows().find(r => idOf(r) === id);
    if (!row) throw new Error(`Task not found: ${id}`);
    const changes = decide(row);
    const previous: Patch = {};
    for (const key of Object.keys(changes) as (keyof TaskValues)[]) {
      Object.assign(previous, { [key]: row[key] });
    }
    const input: CloudTaskUpdate = {};
    if (changes.checked !== undefined) input.checked = changes.checked;
    if (changes.due !== undefined) input.due = changes.due;
    if (changes.priority !== undefined) {
      input.priority = changes.priority || null;
    }

    const prior = this.patches.get(id);
    const gen = ++this.patchGen;
    this.setPatch(id, changes, gen);
    try {
      await this.api.updateTask(ref.docId, ref.blockId, input);
    } catch (error) {
      // Back to the values before, unless a newer write has taken over, with
      // the failure shown on the row.
      if (this.patches.get(id)?.gen === gen) {
        if (prior) this.patches.set(id, prior);
        else this.patches.delete(id);
        this.scheduleExpiry();
      }
      this.errors.set(id, { message: messageOf(error), seq: this.startedSeq });
      if (isUnsupported(UserFriendlyError.fromAny(error))) this.onUnsupported();
      this.bump();
      throw error;
    }
    if (this.errors.delete(id)) this.bump();
    const entry = this.patches.get(id);
    if (entry?.gen === gen) entry.afterSeq = this.startedSeq;
    this.refresh$.next();
    return previous;
  }

  dispose() {
    this.disposed = true;
    this.refreshEffect.unsubscribe();
    clearTimeout(this.expiryTimer);
    this.patches.clear();
  }
}
