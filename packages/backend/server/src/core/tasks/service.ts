import { createHash } from 'node:crypto';

import { readDocTasks } from '@affine/reader/task-fields';
import { Injectable } from '@nestjs/common';
import { applyUpdate } from 'yjs';

import { BadRequest, DocNotFound, EventBus, NotFound } from '../../base';
import { Models, type WorkspaceTaskRow } from '../../models';
import { DocWriter, PgWorkspaceDocStorageAdapter } from '../doc';
import { PermissionAccess } from '../permission';
import { buildTaskDelta, type TaskChanges, validateTaskChanges } from './delta';
import { loadDoc, TASK_EXTRACTOR_VERSION, TaskExtractor } from './extractor';

export interface WorkspaceTasks {
  /**
   * Opaque. Changes when any task of the workspace changes or when the set of
   * docs the user can read changes.
   */
  etag: string;
  /** the extractor has processed every doc of the workspace */
  ready: boolean;
  /** null when the caller already has `etag` */
  tasks: WorkspaceTaskRow[] | null;
}

@Injectable()
export class TaskService {
  constructor(
    private readonly models: Models,
    private readonly extractor: TaskExtractor,
    private readonly storage: PgWorkspaceDocStorageAdapter,
    private readonly writer: DocWriter,
    private readonly ac: PermissionAccess,
    private readonly event: EventBus
  ) {}

  /**
   * The tasks of a workspace the user can read. Starts the backfill when the
   * workspace has not been extracted with the current extractor yet.
   */
  async list(
    userId: string,
    workspaceId: string,
    knownEtag?: string | null
  ): Promise<WorkspaceTasks> {
    const state = await this.models.workspaceTask.getState(workspaceId);
    this.extractor.ensureBackfill(workspaceId, state);

    const revision = state?.revision ?? 0;
    const ready = (state?.extractorVersion ?? 0) >= TASK_EXTRACTOR_VERSION;

    const rows = await this.models.workspaceTask.list(workspaceId);
    const docs = [...new Set(rows.map(row => row.docId))].map(docId => ({
      docId,
    }));
    const readable = new Set(
      (
        await this.ac.user(userId).workspace(workspaceId).docs(docs, 'Doc.Read')
      ).map(doc => doc.docId)
    );
    // the readable set is part of the etag: permission changes don't bump the
    // revision but must not be hidden by a cached list
    const hash = createHash('sha1')
      .update([...readable].sort().join('\n'))
      .digest('hex')
      .slice(0, 8);
    const etag = `${revision}:${hash}`;
    if (state && knownEtag === etag) return { etag, ready, tasks: null };

    return {
      etag,
      ready,
      tasks: rows.filter(row => readable.has(row.docId)),
    };
  }

  /**
   * Change a task (checked, due, priority) by writing the minimal Yjs delta into its doc, then
   * refresh its rows at once instead of waiting for the debounced extractor.
   * The caller has checked `Doc.Update`.
   */
  async update(
    userId: string,
    workspaceId: string,
    docId: string,
    blockId: string,
    changes: TaskChanges,
    now = Date.now()
  ): Promise<WorkspaceTaskRow> {
    validateTaskChanges(changes);
    const record = await this.storage.getDoc(workspaceId, docId);
    if (!record?.bin?.byteLength) {
      throw new DocNotFound({ spaceId: workspaceId, docId });
    }

    // only what the list shows can be ticked (not orphans or blank todos)
    if (
      !readDocTasks(loadDoc(record.bin)).some(task => task.blockId === blockId)
    ) {
      throw new NotFound();
    }
    const result = buildTaskDelta(record.bin, blockId, changes, now);
    if (result.kind === 'not-a-task') {
      throw new BadRequest('The block is not a todo list block.');
    }

    const doc = loadDoc(record.bin);
    if (result.kind === 'delta') {
      const timestamp = await this.storage.pushDocUpdates(
        workspaceId,
        docId,
        [result.update],
        userId
      );
      this.event.emit('doc.updates.pushed', {
        spaceType: 'workspace',
        spaceId: workspaceId,
        docId,
        updates: [result.update],
        timestamp,
        editor: userId,
      });
      await this.writer.updateDocProperties(
        workspaceId,
        docId,
        { updatedBy: userId },
        userId
      );
      applyUpdate(doc, result.update);
    }

    // Tracked workspaces refresh the rows now; an untracked one gets its first
    // extraction from the backfill, so no half-initialised state is created.
    if (await this.models.workspaceTask.getState(workspaceId)) {
      await this.extractor.extractDoc(workspaceId, docId);
    } else {
      this.extractor.ensureBackfill(workspaceId, null);
    }

    const task = readDocTasks(doc).find(task => task.blockId === blockId);
    if (!task) throw new NotFound();
    return { docId, ...task };
  }
}
