import { readDocTasks } from '@affine/reader/task-fields';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { applyUpdate, Doc } from 'yjs';

import { Locker, OnEvent } from '../../base';
import { Models } from '../../models';
import { PgWorkspaceDocStorageAdapter } from '../doc';

/**
 * Bump when the extraction rules change; workspaces with a lower stored
 * version are re-extracted by a backfill.
 */
export const TASK_EXTRACTOR_VERSION = 1;

export const TASK_EXTRACT_DEBOUNCE_MS = 2000;

/** Docs that hold no blocks (the root doc, doc properties, user data). */
export function isTaskSourceDoc(workspaceId: string, docId: string) {
  return (
    docId !== workspaceId &&
    !docId.startsWith('db$') &&
    !docId.startsWith('userdata$')
  );
}

/**
 * Keeps the task rows of a workspace in step with its docs.
 *
 * Trash is not known here: a trashed doc keeps its rows and the client drops
 * them using the workspace root doc meta, which it already has.
 */
/** Decode a stored doc binary. */
export function loadDoc(bin: Uint8Array) {
  const doc = new Doc();
  applyUpdate(doc, bin);
  return doc;
}

/**
 * Keeps the task rows of a workspace in step with its docs.
 *
 * Trash is not known here: a trashed doc keeps its rows and the client drops
 * them using the workspace root doc meta, which it already has.
 *
 * Instance-local state: the debounce timers, the per-doc extraction queue and
 * the running-backfill set live in this process. The backfill lock is
 * cluster-wide but expires after 60 s without renewal, so a backfill longer
 * than that may be repeated by another instance; it is idempotent.
 */
@Injectable()
export class TaskExtractor implements OnModuleDestroy {
  private readonly logger = new Logger(TaskExtractor.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly backfills = new Map<string, Promise<void>>();

  constructor(
    private readonly models: Models,
    private readonly storage: PgWorkspaceDocStorageAdapter,
    private readonly locker: Locker
  ) {}

  onModuleDestroy() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  @OnEvent('doc.updates.pushed')
  @OnEvent('doc.updates.received')
  onDocUpdates({
    spaceType,
    spaceId,
    docId,
  }: Events['doc.updates.pushed'] | Events['doc.updates.received']) {
    if (spaceType !== 'workspace' || !isTaskSourceDoc(spaceId, docId)) return;
    this.schedule(spaceId, docId);
  }

  /** Extract a doc after the debounce; pushes within the window share one run. */
  schedule(workspaceId: string, docId: string) {
    const key = `${workspaceId}:${docId}`;
    const pending = this.timers.get(key);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.extractIfTracked(workspaceId, docId).catch(e =>
        this.logger.error(`Failed to extract tasks of ${key}`, e)
      );
    }, TASK_EXTRACT_DEBOUNCE_MS);
    this.timers.set(key, timer);
  }

  /** Run every pending debounced extraction now. */
  async flush() {
    const keys = [...this.timers.keys()];
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const key of keys) {
      const index = key.indexOf(':');
      try {
        await this.extractIfTracked(key.slice(0, index), key.slice(index + 1));
      } catch (e) {
        this.logger.error(`Failed to extract tasks of ${key}`, e);
      }
    }
  }

  /**
   * Workspaces nobody has asked for tasks yet have no state row; their docs are
   * left alone until the first query backfills them.
   */
  async extractIfTracked(workspaceId: string, docId: string) {
    if (!(await this.models.workspaceTask.getState(workspaceId))) return false;
    return await this.extractDoc(workspaceId, docId);
  }

  /**
   * Replace the rows of a doc with what its current content holds. A doc that
   * no longer exists has no rows. Runs of the same doc are queued, so the last
   * one to start also writes last and an older read can't overwrite newer rows.
   *
   * @returns whether any row changed
   */
  extractDoc(workspaceId: string, docId: string): Promise<boolean> {
    const key = `${workspaceId}:${docId}`;
    const prev = this.queues.get(key) ?? Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(() => this.extractDocNow(workspaceId, docId));
    this.queues.set(key, run);
    const cleanup = () => {
      if (this.queues.get(key) === run) this.queues.delete(key);
    };
    run.then(cleanup, cleanup);
    return run;
  }

  private async extractDocNow(workspaceId: string, docId: string) {
    const record = await this.storage.getDoc(workspaceId, docId);
    const tasks = record?.bin?.byteLength
      ? readDocTasks(loadDoc(record.bin))
      : [];
    try {
      return await this.models.workspaceTask.replaceDoc(
        workspaceId,
        docId,
        tasks
      );
    } catch (e) {
      // the workspace was deleted meanwhile (foreign key on the rows)
      if ((e as { code?: string })?.code === 'P2003') return false;
      throw e;
    }
  }

  /**
   * Make sure every doc of the workspace is extracted with the current
   * extractor version. Returns at once; the work runs in the background and
   * is idempotent. One run per workspace at a time in this process.
   */
  ensureBackfill(
    workspaceId: string,
    state: { extractorVersion: number } | null
  ) {
    if ((state?.extractorVersion ?? 0) >= TASK_EXTRACTOR_VERSION) return;
    if (this.backfills.has(workspaceId)) return;
    const run = this.backfill(workspaceId)
      .catch(e =>
        this.logger.error(`Failed to backfill tasks of ${workspaceId}`, e)
      )
      .finally(() => this.backfills.delete(workspaceId));
    this.backfills.set(workspaceId, run);
  }

  /** Resolves when the backfill running in this process (if any) is done. */
  async backfillSettled(workspaceId: string) {
    await this.backfills.get(workspaceId);
  }

  private async listSourceDocIds(workspaceId: string) {
    const timestamps = await this.storage.getSpaceDocTimestamps(workspaceId);
    return Object.keys(timestamps).filter(docId =>
      isTaskSourceDoc(workspaceId, docId)
    );
  }

  async backfill(workspaceId: string) {
    // One attempt: another instance holding the lock is working on it.
    let lock;
    try {
      lock = await this.locker.lock(
        `tasks-backfill-${process.pid}`,
        `tasks:backfill:${workspaceId}`
      );
    } catch {
      return;
    }
    try {
      // From here on pushes are extracted too, so no doc is missed between
      // being read here and the version being stored.
      await this.models.workspaceTask.ensureState(workspaceId);

      const docIds = await this.listSourceDocIds(workspaceId);
      let failed = 0;
      for (const docId of docIds) {
        try {
          await this.extractDoc(workspaceId, docId);
        } catch (e) {
          failed++;
          this.logger.error(
            `Failed to extract tasks of ${workspaceId}:${docId}`,
            e
          );
        }
      }
      // docs created while the loop ran have rows already: keep them
      const current = await this.listSourceDocIds(workspaceId);
      await this.models.workspaceTask.deleteDocsExcept(workspaceId, [
        ...new Set([...docIds, ...current]),
      ]);
      await this.models.workspaceTask.markBackfilled(
        workspaceId,
        TASK_EXTRACTOR_VERSION
      );
      this.logger.log(
        `Backfilled tasks of workspace ${workspaceId} (${docIds.length} docs, ${failed} failed)`
      );
    } finally {
      await lock.release();
    }
  }
}
