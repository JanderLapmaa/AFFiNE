import { TASKS_DOC_ID } from '@affine/reader/task-fields';
import {
  Args,
  Mutation,
  Parent,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';

import type { WorkspaceTaskRow } from '../../models';
import { CurrentUser } from '../auth/session';
import { PermissionAccess } from '../permission';
import { UserType } from '../user';
import { WorkspaceType } from '../workspaces';
import { TaskService } from './service';
import {
  CreateTaskInput,
  UpdateTaskInput,
  WorkspaceTaskObjectType,
  WorkspaceTasksObjectType,
} from './types';

function toObject(row: WorkspaceTaskRow): WorkspaceTaskObjectType {
  return {
    ...row,
    refs: row.refs.map(([offset, docId]) => ({ offset, docId })),
  };
}

@Resolver(() => WorkspaceType)
export class TaskResolver {
  constructor(
    private readonly service: TaskService,
    private readonly ac: PermissionAccess
  ) {}

  @ResolveField(() => WorkspaceTasksObjectType, {
    description:
      'The todo list blocks of the docs the user can read, in doc order',
  })
  async tasks(
    @CurrentUser() me: UserType,
    @Parent() workspace: WorkspaceType,
    @Args('knownEtag', {
      type: () => String,
      nullable: true,
      description: 'Skip the list when it is still at this etag',
    })
    knownEtag?: string
  ): Promise<WorkspaceTasksObjectType> {
    await this.ac.user(me.id).workspace(workspace.id).assert('Workspace.Read');
    const result = await this.service.list(me.id, workspace.id, knownEtag);
    return { ...result, tasks: result.tasks?.map(toObject) ?? null };
  }

  @Mutation(() => WorkspaceTaskObjectType, {
    description:
      'Change a todo (checked, due, priority); returns the updated task',
  })
  async updateTask(
    @CurrentUser() me: UserType,
    @Args('workspaceId') workspaceId: string,
    @Args('docId') docId: string,
    @Args('blockId') blockId: string,
    @Args('input') input: UpdateTaskInput
  ): Promise<WorkspaceTaskObjectType> {
    await this.ac
      .user(me.id)
      .workspace(workspaceId)
      .doc(docId)
      .assert('Doc.Update');
    const row = await this.service.update(
      me.id,
      workspaceId,
      docId,
      blockId,
      input
    );
    return toObject(row);
  }

  @Mutation(() => WorkspaceTaskObjectType, {
    description:
      'Add an unchecked todo to the workspace Tasks doc (created when missing); returns the new task',
  })
  async createTask(
    @CurrentUser() me: UserType,
    @Args('workspaceId') workspaceId: string,
    @Args('input') input: CreateTaskInput
  ): Promise<WorkspaceTaskObjectType> {
    await this.ac
      .user(me.id)
      .workspace(workspaceId)
      .doc(TASKS_DOC_ID)
      .assert('Doc.Update');
    const row = await this.service.create(me.id, workspaceId, input);
    return toObject(row);
  }
}
