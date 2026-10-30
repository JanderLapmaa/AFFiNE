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
import { WorkspaceTaskObjectType, WorkspaceTasksObjectType } from './types';

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
    description: 'Tick or untick a todo; returns the updated task',
  })
  async setTaskChecked(
    @CurrentUser() me: UserType,
    @Args('workspaceId') workspaceId: string,
    @Args('docId') docId: string,
    @Args('blockId') blockId: string,
    @Args('checked') checked: boolean
  ): Promise<WorkspaceTaskObjectType> {
    await this.ac
      .user(me.id)
      .workspace(workspaceId)
      .doc(docId)
      .assert('Doc.Update');
    const row = await this.service.setChecked(
      me.id,
      workspaceId,
      docId,
      blockId,
      checked
    );
    return toObject(row);
  }
}
