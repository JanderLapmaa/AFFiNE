import { I18n, i18nTime } from '@affine/i18n';
import { LiveData, Service } from '@toeverything/infra';
import { isEqual } from 'lodash-es';
import {
  BehaviorSubject,
  combineLatest,
  distinctUntilChanged,
  map,
  Observable,
  of,
  shareReplay,
  switchMap,
} from 'rxjs';

import type { DocsService } from '../../doc/services/docs';
import type { JournalService } from '../../journal';
import type { GlobalCache } from '../../storage';
import type { WorkspaceService } from '../../workspace';
import { localDay, msUntilNextLocalMidnight } from '../date';
import {
  buildCounts,
  buildView,
  type DocInfo,
  type IndexedTask,
} from '../projection';
import { CloudTaskSource } from '../sources/cloud';
import { splitTaskId } from '../sources/doc-write';
import { LocalTaskSource } from '../sources/local';
import type { Patch, TaskSource, TaskValues } from '../sources/types';
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
import type { TasksCloudApi } from './tasks-cloud-api';

const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;

const EMPTY_COUNTS: TasksCounts = {
  inbox: 0,
  today: 0,
  tomorrow: 0,
  next7: 0,
  all: 0,
  completed: 0,
};

interface Model {
  tasks: IndexedTask[];
  docs: ReadonlyMap<string, DocInfo>;
  /** Current titles of the docs that tasks link to. */
  refTitles: ReadonlyMap<string, string>;
  today: string;
}

/**
 * Cross-doc task list: shapes the todo rows of a task source into the Tasks
 * views, and writes due / priority / checked back through it. A local
 * workspace reads its block indexer; any other workspace reads the server's
 * task list (see `sources/`).
 */
export class TasksService extends Service {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly docsService: DocsService,
    private readonly clockStore: TasksClockStore,
    private readonly journalService: JournalService,
    cloudApi: TasksCloudApi,
    globalCache: GlobalCache
  ) {
    super();

    const workspace = this.workspaceService.workspace;
    const now = () => this.clock.now();
    const local = () =>
      new LocalTaskSource(workspace.engine.indexer, this.docsService, now);
    // A server without the task API is read through the indexer instead,
    // for as long as this service lives.
    this.source$ = new BehaviorSubject<TaskSource>(
      workspace.flavour === 'local'
        ? local()
        : new CloudTaskSource(
            cloudApi,
            globalCache,
            () => {
              const old = this.source$.value;
              if (old.kind === 'local') return;
              this.source$.next(local());
              old.dispose();
            },
            this.viewOpen$
          )
    );
    const kind$ = this.source$.pipe(
      map(source => source.kind),
      distinctUntilChanged()
    );
    const tasks$ = this.source$.pipe(
      switchMap(source => source.rows$),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    // Only docs that hold tasks matter, and a doc's updated date only when a
    // checked task there has no completedAt. Typing in a doc therefore
    // doesn't change the result (and so doesn't rebuild the views).
    const relevantDocs$ = tasks$.pipe(
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
      kind$,
    ]).pipe(
      map(
        ([
          { docIds, needUpdated },
          trashed,
          templates,
          titles,
          created,
          updated,
          kind,
        ]) => {
          const trashedSet = new Set(trashed);
          const titleOf = new Map(titles.map(d => [d.id, d.title]));
          const createdOf = new Map(created.map(d => [d.id, d.createDate]));
          const updatedOf = new Map(
            needUpdated.length ? updated.map(d => [d.id, d.updatedDate]) : []
          );
          const infos = new Map<string, DocInfo>();
          for (const id of docIds) {
            // Trashed docs are left out. So are docs without a record, except
            // for the server list: its docs may not be downloaded yet.
            if (
              trashedSet.has(id) ||
              (kind === 'local' && !this.docsService.list.doc$(id).value)
            ) {
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

    // Titles of linked docs, kept current so a rename shows in the rows.
    const refIds$: Observable<string[]> = tasks$.pipe(
      map(rows =>
        [...new Set(rows.flatMap(r => r.refs.map(ref => ref[1])))].sort()
      ),
      distinctUntilChanged(isEqual)
    );
    // A journal doc shows its date, like the doc title elsewhere.
    const refJournalDates$: Observable<(string | undefined)[]> = refIds$.pipe(
      switchMap(ids =>
        ids.length
          ? combineLatest(
              ids.map(id => this.journalService.journalDate$(id).asObservable())
            )
          : of([])
      )
    );
    const refTitles$: Observable<ReadonlyMap<string, string>> = combineLatest([
      refIds$,
      refJournalDates$,
      this.docsService.allDocTitle$(),
    ]).pipe(
      map(([ids, dates, titles]) => {
        const titleOf = new Map(titles.map(d => [d.id, d.title]));
        return new Map(
          ids.map((id, i): [string, string] => [
            id,
            (dates[i]
              ? i18nTime(dates[i], { absolute: { accuracy: 'day' } })
              : titleOf.get(id)) || I18n.t('Untitled'),
          ])
        );
      }),
      distinctUntilChanged(isEqual)
    );

    this.model$ = combineLatest([
      tasks$,
      docInfo$,
      refTitles$,
      this.today$,
    ]).pipe(
      map(([tasks, docs, refTitles, today]) => ({
        tasks,
        docs,
        refTitles,
        today,
      })),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    this.state$ = LiveData.from(
      this.source$.pipe(switchMap(source => source.state$)),
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

  private get clock(): TasksClock {
    return this.clockStore;
  }

  private readonly source$: BehaviorSubject<TaskSource>;
  /** Whether any `view$` is being watched (the badges only watch counts). */
  private readonly viewOpen$ = new BehaviorSubject(false);
  private viewObservers = 0;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private readonly views = new Map<TasksViewId, LiveData<TaskGroup[]>>();

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

  /** Loading until the first list; an error only when there is no list. */
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
        this.countViewObserver(this.model$).pipe(
          map(({ tasks, docs, refTitles, today }) =>
            buildView(viewId, tasks, docs, today, refTitles)
          ),
          distinctUntilChanged(isEqual)
        ),
        [] as TaskGroup[]
      );
      this.views.set(viewId, view);
    }
    return view;
  }

  private countViewObserver<T>(source: Observable<T>) {
    return new Observable<T>(subscriber => {
      if (++this.viewObservers === 1) this.viewOpen$.next(true);
      const subscription = source.subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        if (--this.viewObservers === 0) this.viewOpen$.next(false);
      };
    });
  }

  /** Re-runs the query (story 11) after an error. */
  retry() {
    this.source$.value.retry();
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
    this.source$.value.dispose();
    super.dispose();
  }

  /**
   * Writes `decide(the task's current values)` through the source. Writes run
   * one at a time, and each decides from the task as it is when its turn
   * comes, so a quick second tick undoes the first.
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
        // A server-listed doc may not be downloaded, so a missing record is
        // only a problem for the local source.
        if (
          record?.trash$.value ||
          (!record && this.source$.value.kind === 'local')
        ) {
          throw new Error(`Doc ${ref.docId} is trashed or missing`);
        }
        const previous = await this.source$.value.apply(id, decide);
        return async () => {
          await this.applyValues(id, () => previous);
        };
      });
    this.writeQueue = run;
    return run;
  }
}
