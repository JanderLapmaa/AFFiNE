import { createHash } from 'node:crypto';

import {
  readDocTasks,
  TASKS_DOC_ID,
  TASKS_DOC_TITLE,
} from '@affine/reader/task-fields';
import { Injectable } from '@nestjs/common';
import { nanoid } from 'nanoid';
import { applyUpdate } from 'yjs';

import {
  BadRequest,
  DocNotFound,
  EventBus,
  Mutex,
  NotFound,
  TooManyRequest,
} from '../../base';
import { Models, type WorkspaceTaskRow } from '../../models';
import { DocWriter, PgWorkspaceDocStorageAdapter } from '../doc';
import { PermissionAccess } from '../permission';
import {
  buildAppendTodoDelta,
  buildTaskDelta,
  type NewTask,
  type TaskChanges,
  validateNewTask,
  validateTaskChanges,
} from './delta';
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
    private readonly event: EventBus,
    private readonly mutex: Mutex
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
      await this.pushUpdate(userId, workspaceId, docId, result.update);
      applyUpdate(doc, result.update);
    }
    await this.refreshRows(workspaceId, docId);

    const task = readDocTasks(doc).find(task => task.blockId === blockId);
    if (!task) throw new NotFound();
    return { docId, ...task };
  }

  /**
   * Quick add: appends an unchecked todo to the workspace's Tasks doc
   * (`TASKS_DOC_ID`), creating the doc when there is none, and returns the
   * new task. Creating and appending run under a per-workspace lock, so two
   * requests can't create the doc twice. The caller has checked `Doc.Update`
   * on the Tasks doc.
   */
  async create(
    userId: string,
    workspaceId: string,
    input: NewTask
  ): Promise<WorkspaceTaskRow> {
    const task = validateNewTask(input);
    const docId = TASKS_DOC_ID;
    await using lock = await this.mutex.acquire(`tasks-doc:${workspaceId}`);
    if (!lock) throw new TooManyRequest();

    let record = await this.storage.getDoc(workspaceId, docId);
    if (!record?.bin?.byteLength) {
      await this.ac
        .user(userId)
        .workspace(workspaceId)
        .assert('Workspace.CreateDoc');
      await this.writer.createDoc(workspaceId, TASKS_DOC_TITLE, '', userId, {
        docId,
      });
      record = await this.storage.getDoc(workspaceId, docId);
      if (!record?.bin?.byteLength) {
        throw new DocNotFound({ spaceId: workspaceId, docId });
      }
    }

    const blockId = nanoid();
    const update = buildAppendTodoDelta(record.bin, blockId, task);
    if (!update) throw new BadRequest('The Tasks doc has no note to add to.');
    await this.pushUpdate(userId, workspaceId, docId, update);
    await this.refreshRows(workspaceId, docId);

    const doc = loadDoc(record.bin);
    applyUpdate(doc, update);
    const row = readDocTasks(doc).find(row => row.blockId === blockId);
    if (!row) throw new NotFound();
    return { docId, ...row };
  }

  private async pushUpdate(
    userId: string,
    workspaceId: string,
    docId: string,
    update: Uint8Array
  ) {
    const timestamp = await this.storage.pushDocUpdates(
      workspaceId,
      docId,
      [update],
      userId
    );
    this.event.emit('doc.updates.pushed', {
      spaceType: 'workspace',
      spaceId: workspaceId,
      docId,
      updates: [update],
      timestamp,
      editor: userId,
    });
    await this.writer.updateDocProperties(
      workspaceId,
      docId,
      { updatedBy: userId },
      userId
    );
  }

  /**
   * Tracked workspaces refresh the doc's rows now; an untracked one gets its
   * first extraction from the backfill, so no half-initialised state is
   * created.
   */
  private async refreshRows(workspaceId: string, docId: string) {
    if (await this.models.workspaceTask.getState(workspaceId)) {
      await this.extractor.extractDoc(workspaceId, docId);
    } else {
      this.extractor.ensureBackfill(workspaceId, null);
    }
  }
}
