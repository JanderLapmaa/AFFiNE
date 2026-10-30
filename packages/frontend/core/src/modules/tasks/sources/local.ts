import { readTodoBlocks } from '@affine/reader';
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
import { type IndexedTask, parseIndexedTask } from '../projection';
import type { TasksState } from '../types';
import { splitTaskId, writeTaskValues } from './doc-write';
import type { Patch, TaskSource, TaskValues } from './types';

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

type Indexer = WorkspaceService['workspace']['engine']['indexer'];

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

/**
 * Finds todo blocks through the local block indexer. A doc we write to is
 * read live until the index shows the same rows (see `apply`).
 */
export class LocalTaskSource implements TaskSource {
  readonly kind = 'local' as const;

  constructor(
    private readonly indexer: Indexer,
    private readonly docsService: DocsService,
    private readonly now: () => number
  ) {
    const indexRows$ = this.retry$.pipe(
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
    this.rows$ = combineLatest([indexRows$, this.liveChanged$]).pipe(
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

    this.state$ = combineLatest([
      this.indexer.state$.pipe(startWith(null)),
      this.queryError$,
      indexRows$.pipe(
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
    );
  }

  private readonly retry$ = new BehaviorSubject(0);
  private readonly queryError$ = new BehaviorSubject<string | null>(null);
  /** The latest index rows, to tell when the index has caught up. */
  private indexRows: IndexedTask[] = [];

  /** Docs held open after a write, by doc id. */
  private readonly live = new Map<string, LiveDoc>();
  /** Emits when a held doc's rows change or a doc is let go. */
  private readonly liveChanged$ = new BehaviorSubject<void>(undefined);

  /** Index rows, with a held doc's rows replaced by the doc's own. */
  readonly rows$: Observable<IndexedTask[]>;
  readonly state$: Observable<TasksState>;

  /**
   * Re-runs the index query (story 11). The indexer API has no restart or
   * resync call (it retries itself every 5s), so there is nothing else to call.
   */
  retry() {
    this.retry$.next(this.retry$.value + 1);
  }

  dispose() {
    for (const docId of this.live.keys()) this.releaseDoc(docId);
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

  /**
   * Writes to the source doc. The doc stays open until the index shows what
   * the doc holds, and its rows are read from the doc meanwhile: a change
   * shows as soon as the doc has it, and a failed write shows the doc
   * unchanged.
   */
  async apply(
    id: string,
    decide: (before: TaskValues) => Patch
  ): Promise<Patch> {
    const ref = splitTaskId(id);
    const live = this.holdDoc(ref.docId);
    try {
      await live.ready;
      const previous = writeTaskValues(
        live.doc.blockSuiteDoc,
        ref,
        decide,
        this.now
      );
      // Shown now, not at the next throttled read.
      this.readLive(ref.docId, live);
      return previous;
    } finally {
      live.writes--;
      this.releaseIfCaughtUp(ref.docId);
    }
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
