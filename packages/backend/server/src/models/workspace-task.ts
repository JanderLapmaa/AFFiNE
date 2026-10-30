import type { TaskRow } from '@affine/reader/task-fields';
import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Prisma, type WorkspaceTask } from '@prisma/client';

import { BaseModel } from './base';

/** A task row as the server stores and returns it. */
export interface WorkspaceTaskRow {
  docId: string;
  blockId: string;
  text: string;
  refs: [number, string][];
  heading: string | null;
  order: number;
  checked: boolean;
  /** YYYY-MM-DD */
  due: string | null;
  priority: 1 | 2 | 3 | null;
  /** epoch milliseconds */
  completedAt: number | null;
}

/** What the extractor produces; the doc is given separately. */
export type WorkspaceTaskInput = TaskRow;

export interface WorkspaceTaskState {
  extractorVersion: number;
  revision: number;
  backfilledAt: Date | null;
}

function toRow(row: WorkspaceTask): WorkspaceTaskRow {
  return {
    docId: row.docId,
    blockId: row.blockId,
    text: row.text,
    refs: Array.isArray(row.refs) ? (row.refs as [number, string][]) : [],
    heading: row.heading,
    order: row.order,
    checked: row.checked,
    due: row.due,
    priority: row.priority as 1 | 2 | 3 | null,
    completedAt: row.completedAt === null ? null : Number(row.completedAt),
  };
}

function sameRow(a: WorkspaceTaskInput, b: WorkspaceTaskInput) {
  return (
    a.text === b.text &&
    a.heading === b.heading &&
    a.order === b.order &&
    a.checked === b.checked &&
    a.due === b.due &&
    a.priority === b.priority &&
    a.completedAt === b.completedAt &&
    JSON.stringify(a.refs) === JSON.stringify(b.refs)
  );
}

/**
 * Task rows derived from the todo list blocks of workspace docs. The docs stay
 * the only source of truth; these rows are rebuilt from them.
 */
@Injectable()
export class WorkspaceTaskModel extends BaseModel {
  async getState(workspaceId: string): Promise<WorkspaceTaskState | null> {
    const state = await this.db.workspaceTaskState.findUnique({
      where: { workspaceId },
    });
    return state
      ? {
          extractorVersion: state.extractorVersion,
          revision: Number(state.revision),
          backfilledAt: state.backfilledAt,
        }
      : null;
  }

  async list(workspaceId: string): Promise<WorkspaceTaskRow[]> {
    const rows = await this.db.workspaceTask.findMany({
      where: { workspaceId },
      orderBy: [{ docId: 'asc' }, { order: 'asc' }],
    });
    return rows.map(toRow);
  }

  async get(
    workspaceId: string,
    docId: string,
    blockId: string
  ): Promise<WorkspaceTaskRow | null> {
    const row = await this.db.workspaceTask.findUnique({
      where: { workspaceId_docId_blockId: { workspaceId, docId, blockId } },
    });
    return row ? toRow(row) : null;
  }

  /**
   * Make the rows of a doc equal to `tasks`. Only the rows that differ are
   * written; the workspace revision is bumped only when something changed.
   *
   * @returns whether any row changed
   */
  @Transactional()
  async replaceDoc(
    workspaceId: string,
    docId: string,
    tasks: WorkspaceTaskInput[]
  ): Promise<boolean> {
    await this.db
      .$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workspace-tasks:${workspaceId}:${docId}`}, 0))`;

    const existing = new Map(
      (
        await this.db.workspaceTask.findMany({ where: { workspaceId, docId } })
      ).map(row => [row.blockId, toRow(row)])
    );
    const next = new Map(tasks.map(task => [task.blockId, task]));

    const removed = [...existing.keys()].filter(id => !next.has(id));
    const upserts = tasks.filter(task => {
      const old = existing.get(task.blockId);
      return !old || !sameRow(old, task);
    });
    if (!removed.length && !upserts.length) return false;

    if (removed.length) {
      await this.db.workspaceTask.deleteMany({
        where: { workspaceId, docId, blockId: { in: removed } },
      });
    }
    for (const task of upserts) {
      const data = {
        text: task.text,
        refs: task.refs as unknown as Prisma.InputJsonValue,
        heading: task.heading,
        order: task.order,
        checked: task.checked,
        due: task.due,
        priority: task.priority,
        completedAt: task.completedAt,
        updatedAt: new Date(),
      };
      await this.db.workspaceTask.upsert({
        where: {
          workspaceId_docId_blockId: {
            workspaceId,
            docId,
            blockId: task.blockId,
          },
        },
        create: { workspaceId, docId, blockId: task.blockId, ...data },
        update: data,
      });
    }
    await this.bumpRevision(workspaceId);
    return true;
  }

  /** Create the state row (version 0) if the workspace has none. */
  async ensureState(workspaceId: string) {
    await this.db.workspaceTaskState.upsert({
      where: { workspaceId },
      create: { workspaceId },
      update: {},
    });
  }

  /** Mark the workspace as extracted by `extractorVersion`. */
  async markBackfilled(workspaceId: string, extractorVersion: number) {
    await this.db.workspaceTaskState.upsert({
      where: { workspaceId },
      create: { workspaceId, extractorVersion, backfilledAt: new Date() },
      update: { extractorVersion, backfilledAt: new Date() },
    });
  }

  /** Remove rows of docs outside `docIds` (docs that no longer exist). */
  @Transactional()
  async deleteDocsExcept(workspaceId: string, docIds: string[]) {
    const { count } = await this.db.workspaceTask.deleteMany({
      where: { workspaceId, docId: { notIn: docIds } },
    });
    if (count) await this.bumpRevision(workspaceId);
    return count;
  }

  private async bumpRevision(workspaceId: string) {
    await this.db.workspaceTaskState.upsert({
      where: { workspaceId },
      create: { workspaceId, revision: 1 },
      update: { revision: { increment: 1 } },
    });
  }
}
