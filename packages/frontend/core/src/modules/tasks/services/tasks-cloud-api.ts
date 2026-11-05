import {
  type CreateTaskMutation,
  createTaskMutation,
  updateTaskMutation,
  workspaceTasksQuery,
} from '@affine/graphql';
import { Store } from '@toeverything/infra';

import type { WorkspaceServerService } from '../../cloud/services/workspace-server';
import type { WorkspaceService } from '../../workspace';
import { type IndexedTask, normalizeTaskFields } from '../projection';

export interface CloudTaskList {
  etag: string;
  /** False while the server is still extracting the workspace's tasks. */
  ready: boolean;
  /** Null when the list is unchanged since `knownEtag`. */
  tasks: IndexedTask[] | null;
}

/** What a write changes; omitted keys stay, null clears due / priority. */
export interface CloudTaskUpdate {
  checked?: boolean;
  due?: string | null;
  priority?: number | null;
}

/** A todo to add to the workspace's Tasks doc. */
export interface CloudNewTask {
  text: string;
  due: string | null;
  priority: number | null;
}

/** A task as the server sends it. */
type ServerTask = CreateTaskMutation['createTask'];

function toIndexedTask(task: ServerTask): IndexedTask {
  return {
    docId: task.docId,
    blockId: task.blockId,
    title: task.text,
    ...normalizeTaskFields({
      ...task,
      refs: task.refs.map(ref => [ref.offset, ref.docId]),
    }),
  };
}

/** The server task list, over plain GraphQL. Stub this in tests. */
export class TasksCloudApi extends Store {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService
  ) {
    super();
  }

  private get gql() {
    const gql = this.workspaceServerService.server?.gql;
    if (!gql) throw new Error('This workspace has no server');
    return gql;
  }

  /**
   * Where the list is cached: per server, account and workspace. Null when no
   * account is signed in (nothing is read from or written to the cache).
   */
  cacheKey(): string | null {
    const server = this.workspaceServerService.server;
    const userId = server?.account$.value?.id;
    return server && userId
      ? `tasks-cloud:${server.id}:${userId}:${this.workspaceService.workspace.id}`
      : null;
  }

  async fetchTasks(
    knownEtag: string | null,
    signal?: AbortSignal
  ): Promise<CloudTaskList> {
    const data = await this.gql({
      query: workspaceTasksQuery,
      variables: {
        workspaceId: this.workspaceService.workspace.id,
        knownEtag,
      },
      context: { signal },
    });
    const { etag, ready, tasks } = data.workspace.tasks;
    return {
      etag,
      ready,
      tasks: tasks ? tasks.map(toIndexedTask) : null,
    };
  }

  async updateTask(
    docId: string,
    blockId: string,
    input: CloudTaskUpdate,
    signal?: AbortSignal
  ) {
    await this.gql({
      query: updateTaskMutation,
      variables: {
        workspaceId: this.workspaceService.workspace.id,
        docId,
        blockId,
        input,
      },
      context: { signal },
    });
  }

  /** Appends a todo to the Tasks doc on the server; resolves with its row. */
  async createTask(
    input: CloudNewTask,
    signal?: AbortSignal
  ): Promise<IndexedTask> {
    const data = await this.gql({
      query: createTaskMutation,
      variables: { workspaceId: this.workspaceService.workspace.id, input },
      context: { signal },
    });
    return toIndexedTask(data.createTask);
  }
}
